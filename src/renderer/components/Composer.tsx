import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Settings } from '@shared/types'
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
import { useT } from '../i18n'
import { useStore } from '../store'
import AttachmentStrip from './AttachmentStrip'
import ContextMeter from './ContextMeter'
import { startNewConversation } from './ConversationList'
import EffortPicker from './EffortPicker'
import Menu from './Menu'
import MicButton from './MicButton'
import ModelPicker from './ModelPicker'
import Select from './Select'

interface SlashCommand {
  name: string
  description: string
  run(): void | Promise<void>
}

export default function Composer() {
  const t = useT()
  const [value, setValue] = useState('')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [menuIndex, setMenuIndex] = useState(0)
  const [files, setFiles] = useState<string[]>([])
  const textarea = useRef<HTMLTextAreaElement>(null)

  const running = useStore((state) => state.running)
  const settings = useStore((state) => state.settings)
  const sessionModel = useStore((state) => state.sessionModel)
  const saveSettings = useStore((state) => state.saveSettings)
  const patchUi = useStore((state) => state.patchUi)
  const totals = useStore((state) => state.totals)
  const changeCount = useStore((state) => state.changes.length)
  const live = useStore((state) => state.live)
  const composerInsert = useStore((state) => state.composerInsert)

  // Text arriving from the editor's Ctrl+L and Ctrl+K. Appended rather than
  // replacing, so a half-typed question survives.
  useEffect(() => {
    if (!composerInsert) return
    setValue((current) =>
      current.trim() ? `${current.trimEnd()}

${composerInsert.text}` : composerInsert.text
    )
    textarea.current?.focus()
  }, [composerInsert])

  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragging, setDragging] = useState(false)
  const [effortOpen, setEffortOpen] = useState(false)
  const [attachOpen, setAttachOpen] = useState(false)

  /**
   * The native picker returns paths, not File objects, so these attach by path
   * the way a dropped non-image file does — the agent reads them with its own
   * tools rather than us inlining the bytes.
   */
  const attachFromDisk = useCallback(async (kind: 'files' | 'folder') => {
    const paths = await window.forge.workspace.pickPaths(kind).catch(() => [] as string[])
    if (paths.length === 0) return

    setAttachments((current) => [
      ...current,
      ...paths.map((path) => ({
        kind: 'file' as const,
        id: `pick-${path}`,
        name: path.split(/[\\/]/).pop() ?? path,
        path,
        bytes: 0
      }))
    ])
  }, [])

  const reasoning = supportsThinking(settings, sessionModel)
  const visionOk = supportsVision(settings, sessionModel)

  const addAttachments = useCallback(async (incoming: Attachment[]) => {
    if (incoming.length === 0) return
    setAttachments((current) => [...current, ...incoming])
  }, [])

  /** Shared by paste and drop: images are embedded, anything else is a path. */
  const ingestFiles = useCallback(async (files: File[]): Promise<Attachment[]> => {
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
      useStore.getState().pushError('Some items could not be attached — they had no file on disk.')
    }
    return usable
  }, [])

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

      const payload = composeMessage(
        text,
        visionOk ? usable : usable.filter((e) => e.kind !== 'image')
      )
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
        await window.forge.agent.send(
          payload.text,
          payload.images,
          useStore.getState().sessionId ?? undefined
        )
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
        description: 'Full-window conversation view',
        run: () => void saveSettings({ mode: 'chat' })
      },
      {
        name: '/edit',
        description: 'Editor and agent side by side',
        run: () => void saveSettings({ mode: 'agent' })
      },
      {
        name: '/readonly',
        description: 'Let the agent look but not touch',
        run: () => void saveSettings({ readOnly: true, bypassPermissions: false })
      },
      {
        name: '/unlock',
        description: 'Allow the agent to edit and run commands again',
        run: () => void saveSettings({ readOnly: false })
      },
      {
        name: '/bypass',
        description: 'Approve everything without asking — careful',
        run: () => void saveSettings({ bypassPermissions: true, readOnly: false })
      },
      {
        name: '/ask-again',
        description: 'Stop bypassing and go back to prompting',
        run: () => void saveSettings({ bypassPermissions: false })
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
      {
        name: '/settings',
        description: 'Open settings',
        run: () => patchUi({ settingsOpen: true })
      },
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
        run: () => void startNewConversation()
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
    [patchUi, saveSettings, submit, totals]
  )

  /* ---------------- slash and @ menus ---------------- */

  const slashQuery = value.startsWith('/') && !value.includes(' ') ? value.toLowerCase() : null
  const mention = useMemo(() => {
    const match = /(^|\s)@([^\s@]*)$/.exec(value)
    return match
      ? { query: match[2].toLowerCase(), start: value.length - match[2].length - 1 }
      : null
  }, [value])

  /**
   * Saved prompts appear beside the built-in commands.
   *
   * They put their text in the box rather than sending it, so the usual case —
   * a saved prompt plus a sentence of specifics — takes one keystroke instead
   * of a copy and paste.
   */
  const promptCommands = useMemo<SlashCommand[]>(
    () =>
      settings.prompts.map((prompt) => ({
        name: `/${prompt.name}`,
        description: prompt.description || 'Saved prompt',
        run: () => {
          setValue(prompt.body)
          textarea.current?.focus()
        }
      })),
    [settings.prompts]
  )

  const slashMatches = useMemo(
    () =>
      slashQuery === null
        ? []
        : [...commands, ...promptCommands].filter((c) => c.name.startsWith(slashQuery)),
    [commands, promptCommands, slashQuery]
  )

  const fileMatches = useMemo(() => {
    if (!mention) return []
    return files.filter((file) => file.toLowerCase().includes(mention.query)).slice(0, 12)
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
    // Sending while the agent works is allowed — it queues.
    await submit(value, attachments)
  }, [slashMatches, menuIndex, submit, value, attachments])

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
      void window.forge.agent.abort(useStore.getState().sessionId ?? undefined)
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
              ? t('Drop files here')
              : running
                ? t('Add to what it is doing — sent at the next step. Esc to interrupt.')
                : t('Ask, or describe a change — / commands, @ files, paste images')
          }
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          spellCheck={false}
        />
      </div>

      <div className="composer-row">
        <button
          className={`pill ${live?.active ? 'live-on' : ''}`}
          title={
            live?.active
              ? t('Live mode is running — click to open it')
              : t('Share your screen with the agent')
          }
          onClick={() => {
            patchUi({ chatPane: 'live' })
            const owner = useStore.getState().sessionId
            if (owner) {
              setTimeout(() => window.dispatchEvent(new CustomEvent('forge:live-start', { detail: owner })), 0)
            }
          }}
        >
          {live?.active && <span className="live-dot" />}
          {t('Live')}
        </button>

        <MicButton
          onText={(text) =>
            // Appended rather than replacing: dictation is usually the tail of
            // something already half-typed.
            setValue((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text))
          }
        />

        <div style={{ position: 'relative' }}>
          <button
            className="attach-btn"
            onClick={() => setAttachOpen((open) => !open)}
            title={t('Attach files, folders and more')}
          >
            +
          </button>
          {attachOpen && (
            <Menu
              align="top-left"
              onClose={() => setAttachOpen(false)}
              items={[
                {
                  icon: '📎',
                  label: t('Add files or photos'),
                  shortcut: 'Ctrl+U',
                  onSelect: () => void attachFromDisk('files')
                },
                {
                  icon: '🗀',
                  label: t('Add folder'),
                  onSelect: () => void attachFromDisk('folder')
                },
                { kind: 'separator' },
                {
                  icon: '/',
                  label: t('Slash commands'),
                  onSelect: () => {
                    setValue('/')
                    textarea.current?.focus()
                  }
                },
                {
                  icon: '🔌',
                  label: t('MCP servers'),
                  onSelect: () => patchUi({ settingsOpen: true, settingsSection: 'mcp' })
                },
                {
                  icon: '🧩',
                  label: t('Skills'),
                  onSelect: () => patchUi({ settingsOpen: true, settingsSection: 'skills' })
                }
              ]}
            />
          )}
        </div>

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
                : `${describeModel(settings, sessionModel)} is not marked as a reasoning model, so effort does nothing. Tick "thinking" for it in Settings → Providers.`
            }
          >
            effort: {settings.effort} {reasoning ? '▴' : ''}
          </button>
          {effortOpen && (
            <EffortPicker
              model={activeModel(settings, sessionModel).model}
              kind={activeModel(settings, sessionModel).provider?.kind}
              onClose={() => setEffortOpen(false)}
            />
          )}
        </div>

        <button
          className={`pill ${settings.readOnly ? 'warn' : ''}`}
          onClick={() => void saveSettings({ readOnly: !settings.readOnly })}
          title={
            settings.readOnly
              ? 'Read-only: mutating tools are not offered to the model at all. Click to allow changes.'
              : 'The agent can edit files and run commands. Click for read-only.'
          }
        >
          {settings.readOnly ? t('read-only') : t('can edit')}
        </button>

        {!settings.readOnly && settings.bypassPermissions && (
          <button
            className="pill danger"
            onClick={() => void saveSettings({ bypassPermissions: false })}
            title="Everything runs without asking. Click to start asking again."
          >
            {t('bypassing permissions')}
          </button>
        )}

        {!settings.readOnly && !settings.bypassPermissions && (
          <>
            <Select
              size="mini"
              title={t('How edits are approved')}
              value={settings.editApproval}
              onChange={(editApproval) => void saveSettings({ editApproval })}
              options={[
                {
                  value: 'review',
                  label: t('review changes'),
                  hint: t('Apply, then keep or revert per file')
                },
                {
                  value: 'ask',
                  label: t('ask each edit'),
                  hint: t('A dialog with the diff every time')
                },
                {
                  value: 'auto',
                  label: t('apply silently'),
                  hint: t('No prompt, no review screen')
                }
              ]}
            />

            <Select
              size="mini"
              title={t('Whether shell commands need approval')}
              value={settings.commandApproval}
              onChange={(commandApproval) => void saveSettings({ commandApproval })}
              options={[
                { value: 'ask', label: t('commands: ask') },
                {
                  value: 'auto',
                  label: t('commands: auto'),
                  hint: t('Runs anything without asking')
                }
              ]}
            />
          </>
        )}

        {/* Working style lives here rather than buried in settings — it is a
            per-task choice, not a preference you set once. */}
        <Select
          size="mini"
          title={t('Working style')}
          value={settings.stance}
          onChange={(stance) => void saveSettings({ stance })}
          options={[
            { value: 'default', label: t('style: default'), hint: t('Get the job done') },
            {
              value: 'plan',
              label: t('style: plan'),
              hint: t('Investigate and propose, change nothing')
            },
            {
              value: 'careful',
              label: t('style: careful'),
              hint: t('Small steps, verify each one')
            },
            { value: 'fast', label: t('style: fast'), hint: t('Fewest steps to a working result') },
            {
              value: 'explain',
              label: t('style: explain'),
              hint: t('Narrate the reasoning as it goes')
            },
            {
              value: 'review',
              label: t('style: review'),
              hint: t('Report findings, change nothing')
            }
          ]}
        />

        {changeCount > 0 && (
          <button
            className="pill warn"
            onClick={() =>
              settings.mode === 'agent'
                ? patchUi({ mainView: 'review' })
                : void saveSettings({ mode: 'agent' }).then(() => patchUi({ mainView: 'review' }))
            }
            title="Open the review screen"
          >
            {changeCount} {t('to review')}
          </button>
        )}

        <ContextMeter />

        {totals.costUsd > 0 && <span>${totals.costUsd.toFixed(4)}</span>}

        {running && (
          <button
            className="stop-btn"
            onClick={() =>
              void window.forge.agent.abort(useStore.getState().sessionId ?? undefined)
            }
          >
            {t('■ stop')}
          </button>
        )}
      </div>
    </div>
  )
}

function activeModel(settings: Settings, selected?: string | null) {
  const ref = selected || settings.activeModel
  const sep = ref.indexOf(':')
  const providerId = ref.slice(0, sep)
  const modelId = ref.slice(sep + 1)
  const provider = settings.providers.find((entry) => entry.id === providerId)
  return { modelId, provider, model: provider?.models.find((entry) => entry.id === modelId) }
}

function describeModel(settings: Settings, selected?: string | null): string {
  const { model, modelId } = activeModel(settings, selected)
  return model?.label || modelId || 'no model'
}

/** The effort control only makes sense for models that actually reason. */
function supportsThinking(settings: Settings, selected?: string | null): boolean {
  return activeModel(settings, selected).model?.supportsThinking === true
}

function supportsVision(settings: Settings, selected?: string | null): boolean {
  return activeModel(settings, selected).model?.supportsVision === true
}
