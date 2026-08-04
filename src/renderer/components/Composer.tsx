import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EFFORT_LEVELS } from '@shared/types'
import type { EditApproval, ReasoningEffort, Settings } from '@shared/types'
import { useStore } from '../store'
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

  const submit = useCallback(async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    useStore.getState().pushUser(trimmed)
    setValue('')
    try {
      await window.forge.agent.send(trimmed)
    } catch (error) {
      useStore.getState().pushError((error as Error).message)
    }
  }, [])

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
    await submit(value)
  }, [slashMatches, menuIndex, running, submit, value])

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

      <div className="composer-box">
        <span className="caret">&gt;</span>
        <textarea
          ref={textarea}
          rows={1}
          value={value}
          placeholder={
            running
              ? 'Working… Esc to interrupt'
              : settings.mode === 'chat'
                ? 'Ask about the code — / for commands, @ for files'
                : 'Describe the change — / for commands, @ for files'
          }
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
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

        {supportsThinking(settings) && (
          <button
            className={`pill ${settings.effort === 'off' ? '' : 'accent'}`}
            onClick={() => void saveSettings({ effort: nextEffort(settings.effort) })}
            title="How hard the model thinks before answering. Click to cycle."
          >
            effort: {settings.effort}
          </button>
        )}

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
  return { modelId, model: provider?.models.find((entry) => entry.id === modelId) }
}

function describeModel(settings: Settings): string {
  const { model, modelId } = activeModel(settings)
  return model?.label || modelId || 'no model'
}

/** The effort control only makes sense for models that actually reason. */
function supportsThinking(settings: Settings): boolean {
  return activeModel(settings).model?.supportsThinking === true
}

function nextEffort(current: ReasoningEffort): ReasoningEffort {
  return EFFORT_LEVELS[(EFFORT_LEVELS.indexOf(current) + 1) % EFFORT_LEVELS.length]
}
