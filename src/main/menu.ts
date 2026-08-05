import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

const REPO_URL = 'https://github.com/blank-dash/forge-ide'

/**
 * A real application menu. The window chrome is custom and the bar is hidden,
 * but the accelerators registered here still work, and macOS requires a menu
 * for even basic clipboard shortcuts to function.
 */
export function buildMenu(getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, payload?: unknown): void =>
    getWindow()?.webContents.send(channel, payload)

  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { label: 'Settings…', accelerator: 'Cmd+,', click: () => send('menu:settings') },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : []),

    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send('menu:open-folder')
        },
        {
          label: 'New Conversation',
          accelerator: 'CmdOrCtrl+N',
          click: () => send('menu:new-session')
        },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu:save') },
        { type: 'separator' },
        ...(isMac
          ? ([{ role: 'close' }] as MenuItemConstructorOptions[])
          : ([
              {
                label: 'Settings…',
                accelerator: 'Ctrl+,',
                click: () => send('menu:settings')
              },
              { type: 'separator' },
              { role: 'quit' }
            ] as MenuItemConstructorOptions[]))
      ]
    },

    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },

    {
      label: 'View',
      submenu: [
        /*
         * Listed without accelerators on purpose.
         *
         * A menu accelerator fires even while a text box has focus, which for
         * Ctrl+P and Ctrl+Shift+F is wrong — those belong to whatever is being
         * typed into. The renderer binds them on the document instead, where an
         * input can opt out; this entry exists so the shortcut is discoverable.
         */
        { label: 'Go to File…  (Ctrl+P)', click: () => send('menu:picker', 'files') },
        { label: 'Command Palette…  (Ctrl+Shift+P)', click: () => send('menu:picker', 'commands') },
        { label: 'Go to Symbol…  (Ctrl+Shift+O)', click: () => send('menu:picker', 'symbols') },
        { label: 'Search Across Files  (Ctrl+Shift+F)', click: () => send('menu:search') },
        { type: 'separator' },
        { label: 'Chat mode', accelerator: 'CmdOrCtrl+1', click: () => send('menu:mode', 'chat') },
        { label: 'Edit mode', accelerator: 'CmdOrCtrl+2', click: () => send('menu:mode', 'agent') },
        { type: 'separator' },
        {
          label: 'Toggle Sidebar',
          accelerator: 'CmdOrCtrl+B',
          click: () => send('menu:toggle-sidebar')
        },
        {
          label: 'Toggle Terminal',
          accelerator: 'CmdOrCtrl+`',
          click: () => send('menu:toggle-terminal')
        },
        {
          label: 'Review Changes',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => send('menu:review')
        },
        {
          label: 'Source Control',
          accelerator: 'CmdOrCtrl+Shift+G',
          click: () => send('menu:git')
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'reload' },
        { role: 'toggleDevTools' }
      ]
    },

    {
      label: 'Help',
      submenu: [
        {
          label: 'Check for Updates…',
          click: () => send('menu:check-updates')
        },
        { type: 'separator' },
        { label: 'Source Code', click: () => void shell.openExternal(REPO_URL) },
        {
          label: 'Report an Issue',
          click: () => void shell.openExternal(`${REPO_URL}/issues/new`)
        },
        { type: 'separator' },
        { label: `Version ${app.getVersion()}`, enabled: false }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
