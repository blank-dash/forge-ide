import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EditApproval, Settings } from '@shared/types'
import {
  composeMessage,
  isImage,
  isLargePaste,
  releaseAttachment,
  toFileAttachment,
  toImageAttachment,
  toTextAttachment,
  tooLarge,
  type Attachment
} from '../attachments'
import { useStore } from '../store'
import AttachmentStrip from './AttachmentStrip'
import ContextMeter from './ContextMeter'
import EffortPicker from './EffortPicker'
import ModelPicker from './ModelPicker'

interface SlashCommand {
  name: string
  description: string
  run(): void | Promise<void>
}

export default function Composer() {
  const [value, setValue] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [menuIndex, setMenuIndex] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const textarea = useRef<HTMLTextAreaElement>(null)

  const running = useStore((state) => state.running)
  const settings = useStore((state) => state.settings)
  const saveSettings = useStore((state) => state.saveSettings)
  const clearChat = useStore((state) => state.clearChat)
  const patchUi = useStore((state) => state.patchUi)
  const totals = useStore((state) => state.totals)
  const changeCount = useStore((state) => state.changes.length)

  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)

  const reasoning = supportsThinking(settings)
  const visionOk = supportsVision(settings)

  const addAttachments = useCallback(async (incoming: Attachment[]) => {
    if (incoming.length === 0) return
    setAttachments((current) => [...current, ...incoming])
  }, [])

  /** Shared by paste and drop: images are embedded, anything else is a path. */
  const ingestFiles = useCallback(
    async (files: File[]): Promise<Attachment[]> => {
      const built = await Promise.all(
        files.map(async (file) => {
          const path = window.forge.pathForFile(file)
          // An image with no path is a clipboard bitmap — a screenshot. One
          // with a path could go either way, and seeing it beats reading it.
          if (isImage(file)) return toImageAttachment(file)
          if (path) return toFileAttachment(file, path)
          return null
        })
      )

      const usable = built.filter((entry): entry is Attachment => entry !== null)
      if (usable.length < files.length) {
        useStore
          .getState()
          .pushError('Some items could not be attached — they had no file on disk.')
      }
      return usable
    },
    []
  )

  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const data = event.clipboardData
      const files = Array.from(data.files ?? [])

      if (files.length > 0) {
        event.preventDefault()
        void ingestFiles(files).then(addAttachments)
        return
      }

      const text = data.getData('text/plain')
      if (text && isLargePaste(text)) {
        // Keep the composer readable; the whole thing still goes to the model.
        event.preventDefault()
        void addAttachments([toTextAttachment(text)])
      }
    },
    [addAttachments, ingestFiles]
  )

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault()
      setDragging(false)
      const files = Array.from(event.dataTransfer.files ?? [])
      if (files.length > 0) void ingestFiles(files).then(addAttachments)
    },
    [addAttachments, ingestFiles]
  )

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const target = current.find((entry) => entry.id === id)
      if (target) releaseAttachment(target)
      return current.filter((entry) => entry.id !== id)
    })
  }, [])

  const attachmentsRef = useRef<Attachment[]>([])
  attachmentsRef.current = attachments

  // Object URLs outlive the component unless they are revoked explicitly.
  useEffect(
    () => () => {
      for (const entry of attachmentsRef.current) releaseAttachment(entry)
    },
    []
  )

  const submit = useCallback(
    async (text: string, pending: Attachment[] = []) => {
      const usable = pending.filter((entry) => !tooLarge(entry))
      const dropped = pending.length - usable.length

      const payload = composeMessage(text, visionOk ? usable : usable.filter((e) => e.kind !== 'image'))
      if (!payload.text.trim() && payload.images.length === 0) return

      useStore.getState().pushUser(payload.text, usable)
      setValue('')
      setAttachments([])
      for (const entry of pending) releaseAttachment(entry)

      if (dropped > 0) {
        useStore
          .getState()
          .pushError(`${dropped} image${dropped === 1 ? ' was' : 's were'} over 4 MB and not sent.`)
      }

      try {
        await window.forge.agent.send(payload.text, payload.images)
      } catch (error) {
        useStore.getState().pushError((error as Error).message)
      }
    },
    [visionOk]
  )

  const commands = useMemo<SlashCommand[]>(
    () => [
      { name: '/model', description: 'Switch the active model', run: () => setPickerOpen(true) },
      {
        name: '/chat',
        description: 'Read-only mode — investigate and explain, no edits',
        run: () => void saveSettings({ mode: 'chat' })
      },
      {
        name: '/agent',
        description: 'Let the agent edit files and run commands',
        run: () => void saveSettings({ mode: 'agent' })
      },
      {
        name: '/review',
        description: 'Edits apply and collect in the review screen',
        run: () => void saveSettings({ mode: 'agent', editApproval: 'review' })
      },
      {
        name: '/ask',
        description: 'Approve each edit in a dialog',
        run: () => void saveSettings({ mode: 'agent', editApproval: 'ask' })
      },
      {
        name: '/auto',
        description: 'Apply edits silently (careful)',
        run: () => void saveSettings({ mode: 'agent', editApproval: 'auto' })
      },
      {
        name: '/changes',
        description: 'Open the review screen',
        run: () => patchUi({ mainView: 'review' })
      },
      {
        name: '/git',
        description: 'Open source control',
        run: () => patchUi({ sidePanel: 'git' })
      },
      {
        name: '/history',
        description: 'Browse saved conversations',
        run: () => patchUi({ sidePanel: 'sessions' })
      },
      { name: '/settings', description: 'Open settings', run: () => patchUi({ settingsOpen: true }) },
      {
        name: '/providers',
        description: 'Add or edit an API provider',
        run: () => patchUi({ settingsOpen: true, settingsSection: 'providers' })
      },
      {
        name: '/mcp',
        description: 'Manage MCP servers',
        run: () => patchUi({ settingsOpen: true, settingsSection: 'mcp' })
      },
      {
        name: '/permissions',
        description: 'Review saved allow/deny rules and approved folders',
        run: () => patchUi({ settingsOpen: true, settingsSection: 'permissions' })
      },
      {
        name: '/clear',
        description: 'Clear the conversation and start fresh',
        run: async () => {
          await window.forge.agent.reset()
          clearChat()
        }
      },
      {
        name: '/cost',
        description: 'Token usage for this session',
        run: () =>
          useStore.getState().applyEvent({
            type: 'notice',
            message:
              `Input ${totals.input.toLocaleString()} · output ${totals.output.toLocaleString()} · ` +
              `cached ${totals.cacheRead.toLocaleString()} · estimated $${totals.costUsd.toFixed(4)}`
          })
      },
      {
        name: '/init',
        description: 'Ask the agent to write a FORGE.md for this project',
        run: () =>
          void submit(
            'Explore this repository and write a FORGE.md at the root: what the project is, how ' +
              'to build/run/test it, the directory layout, and the conventions a new contributor ' +
              'must follow. Keep it under 80 lines and be specific to what you actually find.'
          )
      }
    ],
    [clearChat, patchUi, saveSettings, submit, totals]
  )

  /* ---------------- slash and @ menus ---------------- */

  const slashQuery = value.startsWith('/') && !value.includes(' ') ? value.toLowerCase() : null
  const mention = useMemo(() => {
    const match = /(^|\s)@([^\s@]*)$/.exec(value)
    return match ? { query: match[2].toLowerCase(), start: value.length - match[2].length - 1 } : null
  }, [value])

  const slashMatches = useMemo(
    () => (slashQuery === null ? [] : commands.filter((c) => c.name.startsWith(slashQuery))),
    [commands, slashQuery]
  )

  const fileMatches = useMemo(() => {
    if (!mention) return []
    return files
      .filter((file) => file.toLowerCase().includes(mention.query))
      .slice(0, 12)
  }, [files, mention])

  // The file list backs @-mentions; fetched lazily on the first @.
  useEffect(() => {
    if (!mention || files.length > 0) return
    void window.forge.workspace
      .list('.')
      .then(async (entries) => {
        const nested = await Promise.all(
          entries
            .filter((entry) => entry.isDirectory)
            .slice(0, 12)
            .map((entry) => window.forge.workspace.list(entry.path).catch(() => []))
        )
        setFiles(
          [...entries, ...nested.flat()]
            .filter((entry) => !entry.isDirectory)
            .map((entry) => entry.path)
        )
      })
      .catch(() => setFiles([]))
  }, [mention, files.length])

  const menuOpen = slashMatches.length > 0 || fileMatches.length > 0
  const menuLength = slashMatches.length > 0 ? slashMatches.length : fileMatches.length

  useEffect(() => setMenuIndex(0), [slashQuery, mention?.query])

  const acceptMention = (file: string): void => {
    if (!mention) return
    setValue(`${value.slice(0, mention.start)}@${file} `)
    textarea.current?.focus()
  }

  const onSubmit = useCallback(async () => {
    if (slashMatches.length > 0) {
      const command = slashMatches[menuIndex] ?? slashMatches[0]
      setValue('')
      await command.run()
      return
    }
    if (running) return
    await submit(value, attachments)
  }, [slashMatches, menuIndex, running, submit, value, attachments])

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (menuOpen) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setMenuIndex((index) => (index + 1) % menuLength)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setMenuIndex((index) => (index - 1 + menuLength) % menuLength)
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && fileMatches.length > 0)) {
        event.preventDefault()
        if (fileMatches.length > 0) acceptMention(fileMatches[menuIndex] ?? fileMatches[0])
        else setValue(slashMatches[menuIndex]?.name ?? value)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setValue(value.replace(/@[^\s@]*$/, ''))
        return
      }
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void onSubmit()
      return
    }

    if (event.key === 'Escape' && running) {
      event.preventDefault()
      void window.forge.agent.abort()
    }
  }

  useEffect(() => {
    const element = textarea.current
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, 220)}px`
  }, [value])

  return (
    <div className="composer">
      {menuOpen && (
        <div className="slash-menu">
          {slashMatches.map((command, index) => (
            <button
              key={command.name}
              className={`slash-item ${index === menuIndex ? 'active' : ''}`}
              onMouseEnter={() => setMenuIndex(index)}
              onClick={() => {
                setValue('')
                void command.run()
              }}
            >
              <span className="cmd">{command.name}</span>
              <span className="desc">{command.description}</span>
            </button>
          ))}
          {fileMatches.map((file, index) => (
            <button
              key={file}
              className={`slash-item ${index === menuIndex ? 'active' : ''}`}
              onMouseEnter={() => setMenuIndex(index)}
              onClick={() => acceptMention(file)}
            >
              <span className="cmd">@</span>
              <span className="desc">{file}</span>
            </button>
          ))}
        </div>
      )}

      <AttachmentStrip
        attachments={attachments}
        visionSupported={visionOk}
        onRemove={removeAttachment}
      />

      <div
        className={`composer-box ${dragging ? 'dragging' : ''}`}
        onDrop={onDrop}
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={(event) => {
          // Ignore the events fired while moving between child elements.
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false)
        }}
      >
        <span className="caret">&gt;</span>
        <textarea
          ref={textarea}
          rows={1}
          value={value}
          placeholder={
            dragging
              ? 'Drop files here'
              : running
                ? 'Working… Esc to interrupt'
                : settings.mode === 'chat'
                  ? 'Ask about the code — / commands, @ files, paste images'
                  : 'Describe the change — / commands, @ files, paste images'
          }
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          spellCheck={false}
        />
      </div>

      <div className="composer-row">
        <div style={{ position: 'relative' }}>
          <button className="pill accent" onClick={() => setPickerOpen((open) => !open)}>
            {describeModel(settings)} ▴
          </button>
          {pickerOpen && <ModelPicker onClose={() => setPickerOpen(false)} />}
        </div>

        <div style={{ position: 'relative' }}>
          <button
            className={`pill ${settings.effort !== 'off' && reasoning ? 'accent' : ''}`}
            onClick={() => {
              if (reasoning) setEffortOpen((open) => !open)
              else patchUi({ settingsOpen: true, settingsSection: 'providers' })
            }}
            style={reasoning ? undefined : { opacity: 0.55 }}
            title={
              reasoning
                ? 'How hard the model thinks before answering.'
                : `${describeModel(settings)} is not marked as a reasoning model, so effort does nothing. Tick "thinking" for it in Settings → Providers.`
            }
          >
            effort: {settings.effort} {reasoning ? '▴' : ''}
          </button>
          {effortOpen && (
            <EffortPicker
              model={activeModel(settings).model}
              kind={activeModel(settings).provider?.kind}
              onClose={() => setEffortOpen(false)}
            />
          )}
        </div>

        {settings.mode === 'agent' && (
          <>
            <select
              className="mini-select"
              value={settings.editApproval}
              onChange={(event) =>
                void saveSettings({ editApproval: event.target.value as EditApproval })
              }
              title="How edits are approved"
            >
              <option value="review">review changes</option>
              <option value="ask">ask each edit</option>
              <option value="auto">apply silently</option>
            </select>

            <button
              className={`pill ${settings.commandApproval === 'auto' ? 'danger' : ''}`}
              onClick={() =>
                void saveSettings({
                  commandApproval: settings.commandApproval === 'auto' ? 'ask' : 'auto'
                })
              }
              title="Whether shell commands need approval"
            >
              {settings.commandApproval === 'auto' ? 'commands: auto' : 'commands: ask'}
            </button>
          </>
        )}

        {changeCount > 0 && settings.mode === 'agent' && (
          <button className="pill warn" onClick={() => patchUi({ mainView: 'review' })}>
            {changeCount} to review
          </button>
        )}

        <ContextMeter />

        {totals.costUsd > 0 && <span>${totals.costUsd.toFixed(4)}</span>}

        {running && (
          <button className="stop-btn" onClick={() => void window.forge.agent.abort()}>
            ■ stop
          </button>
        )}
      </div>
    </div>
  )
}

function activeModel(settings: Settings) {
  const sep = settings.activeModel.indexOf(':')
  const providerId = settings.activeModel.slice(0, sep)
  const modelId = settings.activeModel.slice(sep + 1)
  const provider = settings.providers.find((entry) => entry.id === providerId)
  return { modelId, provider, model: provider?.models.find((entry) => entry.id === modelId) }
}

function describeModel(settings: Settings): string {
  const { model, modelId } = activeModel(settings)
  return model?.label || modelId || 'no model'
}

/** The effort control only makes sense for models that actually reason. */
function supportsThinking(settings: Settings): boolean {
  return activeModel(settings).model?.supportsThinking === true
}

function supportsVision(settings: Settings): boolean {
  return activeModel(settings).model?.supportsVision === true
}

