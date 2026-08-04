import { useStore } from '../store'
import { useT } from '../i18n'

export default function TitleBar() {
  const t = useT()
  const bootstrap = useStore((state) => state.bootstrap)
  const mode = useStore((state) => state.settings.mode)
  const saveSettings = useStore((state) => state.saveSettings)
  const patchUi = useStore((state) => state.patchUi)
  const terminalOpen = useStore((state) => state.ui.terminalOpen)
  const changeCount = useStore((state) => state.changes.length)

  const pickFolder = async (): Promise<void> => {
    const result = await window.forge.workspace.pick()
    if (!result) return
    // The whole view is workspace-scoped, so a reload is the cleanest reset.
    window.location.reload()
  }

  return (
    <div className="titlebar">
      <div className="brand">
        <BrandMark />
        Forge
      </div>

      <button className="workspace-btn" onClick={pickFolder} title="Open a different folder">
        <span>{bootstrap?.workspaceName ?? '—'}</span>
        <span className="path">{bootstrap?.cwd ?? ''}</span>
      </button>

      <div className="mode-switch titlebar-modes" role="tablist" aria-label="Mode">
        <button
          role="tab"
          aria-selected={mode === 'chat'}
          className={mode === 'chat' ? 'active' : ''}
          onClick={() => void saveSettings({ mode: 'chat' })}
          title="Give the whole window to the conversation, with history down the side. Same tools as Edit."
        >
          {t('Chat')}
        </button>
        <button
          role="tab"
          aria-selected={mode === 'agent'}
          className={mode === 'agent' ? 'active' : ''}
          onClick={() => void saveSettings({ mode: 'agent' })}
          title="Editor, file tree and agent side by side, with a terminal below."
        >
          {t('Edit')}
        </button>
      </div>

      <div className="titlebar-spacer" />

      {mode === 'agent' && changeCount > 0 && (
        <button className="pill warn" onClick={() => patchUi({ mainView: 'review' })}>
          {changeCount} {t('to review')}
        </button>
      )}

      {mode === 'agent' && (
        <button
          className={`pill ${terminalOpen ? 'accent' : ''}`}
          onClick={() => patchUi({ terminalOpen: !terminalOpen })}
          title="Toggle terminal (Ctrl+`)"
        >
          {t('Terminal')}
        </button>
      )}

      <button
        className="pill"
        onClick={() => patchUi({ settingsOpen: true })}
        title="Settings (Ctrl+,)"
      >
        {t('Settings')}
      </button>
    </div>
  )
}

/** The app mark, matching build/icon.svg. */
function BrandMark() {
  return (
    <svg className="brand-mark" viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" rx="100" fill="#061A23" />
      <g stroke="url(#brandGradient)" fill="url(#brandGradient)">
        <path
          d="M142 148 L270 256 L142 364"
          strokeWidth="48"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
        <rect x="284" y="346" width="110" height="42" rx="21" stroke="none" />
      </g>
      <defs>
        <linearGradient
          id="brandGradient"
          x1="150"
          y1="140"
          x2="380"
          y2="390"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFFFFF" />
          <stop offset="1" stopColor="#D0D0D0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
