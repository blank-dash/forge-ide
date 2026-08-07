import { useState } from 'react'
import { LANGUAGES, useT } from '../i18n'
import { useStore } from '../store'
import Menu, { type MenuItem } from './Menu'

/**
 * The account corner. There is no account to sign into yet, so this shows the
 * name you set locally rather than inventing a logged-in state.
 */
export default function ProfileMenu() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const settings = useStore((state) => state.settings)
  const saveSettings = useStore((state) => state.saveSettings)
  const patchUi = useStore((state) => state.patchUi)
  const bootstrap = useStore((state) => state.bootstrap)

  // A linked GitHub account is a name the user has already given us, so it
  // stands in until they set one explicitly.
  const github = settings.github
  const chosen = settings.displayName.trim() || github.name.trim() || github.login
  const name = chosen || t('Set your name')
  const initial = (chosen || 'F').charAt(0).toUpperCase()
  const avatar = github.avatarUrl

  const items: MenuItem[] = [
    {
      icon: '👤',
      label: t('Account'),
      onSelect: () => patchUi({ settingsOpen: true, settingsSection: 'account' })
    },
    {
      icon: '⚙',
      label: t('Settings'),
      shortcut: 'Ctrl+,',
      onSelect: () => patchUi({ settingsOpen: true })
    },
    {
      icon: '🌐',
      label: t('Language'),
      children: LANGUAGES.map((option) => ({
        label: `${settings.language === option.id ? '✓ ' : ''}${option.label}`,
        onSelect: () => void saveSettings({ language: option.id })
      }))
    },
    {
      icon: '🎨',
      label: t('Appearance'),
      onSelect: () => patchUi({ settingsOpen: true, settingsSection: 'appearance' })
    },
    { kind: 'separator' },
    {
      icon: '🧩',
      label: t('Skills'),
      onSelect: () => patchUi({ settingsOpen: true, settingsSection: 'skills' })
    },
    {
      icon: '🔌',
      label: t('MCP servers'),
      onSelect: () => patchUi({ settingsOpen: true, settingsSection: 'mcp' })
    },
    { kind: 'separator' },
    {
      icon: '↻',
      label: t('Check for updates'),
      onSelect: async () => {
        patchUi({ settingsOpen: true, settingsSection: 'about' })
        await window.forge.updates
          .check()
          .catch((error) =>
            useStore.getState().pushError(`Update check failed: ${(error as Error).message}`)
          )
      }
    },
    {
      icon: '?',
      label: t('Get help'),
      onSelect: () =>
        void window.forge.openExternal('https://github.com/blank-dash/forge-ide#readme')
    },
    { kind: 'header', label: `Forge dash ${bootstrap?.appVersion ?? ''}` }
  ]

  return (
    <div className="status-profile-wrap">
      <button className="status-profile" onClick={() => setOpen((value) => !value)}>
        {avatar ? (
          <img className="status-avatar" src={avatar} alt="" />
        ) : (
          <span className="status-avatar">{initial}</span>
        )}
        <span>{name}</span>
      </button>

      {open && (
        <Menu
          align="top-left"
          onClose={() => {
            setOpen(false)
            setEditing(false)
          }}
          items={items}
          header={
            <div className="menu-account">
              {avatar ? (
                <img className="menu-avatar" src={avatar} alt="" />
              ) : (
                <span className="menu-avatar">{initial}</span>
              )}
              {editing ? (
                <input
                  className="input"
                  autoFocus
                  defaultValue={settings.displayName}
                  placeholder={t('Your name')}
                  style={{ padding: '4px 7px', fontSize: 12 }}
                  onBlur={(event) => {
                    void saveSettings({ displayName: event.target.value })
                    setEditing(false)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') setEditing(false)
                  }}
                />
              ) : (
                <button className="menu-name" onClick={() => setEditing(true)}>
                  {name}
                </button>
              )}
            </div>
          }
        />
      )}
    </div>
  )
}
