import { useCallback, useEffect, useMemo, useRef } from 'react'
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react'
import { useStore } from '../store'

export default function EditorPane(): JSX.Element {
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null)
  const tabs = useStore((state) => state.tabs)
  const activeTab = useStore((state) => state.activeTab)
  const settings = useStore((state) => state.settings)
  const fsRevision = useStore((state) => state.fsRevision)
  const saveRequest = useStore((state) => state.saveRequest)
  const setActiveTab = useStore((state) => state.setActiveTab)
  const closeTab = useStore((state) => state.closeTab)
  const updateTab = useStore((state) => state.updateTab)
  const markTabSaved = useStore((state) => state.markTabSaved)

  const current = useMemo(
    () => tabs.find((tab) => tab.path === activeTab) ?? null,
    [tabs, activeTab]
  )

  const save = useCallback(async () => {
    const state = useStore.getState()
    const tab = state.tabs.find((entry) => entry.path === state.activeTab)
    if (!tab || tab.content === tab.savedContent) return
    await window.forge.workspace.write(tab.path, tab.content)
    markTabSaved(tab.path)
  }, [markTabSaved])

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [save])

  // The File → Save menu accelerator swallows the keystroke before the page
  // sees it, so the menu drives a counter the editor watches instead.
  useEffect(() => {
    if (saveRequest > 0) void save()
  }, [saveRequest, save])

  // When the agent rewrites a file that is open, pull the new content in —
  // but never over unsaved edits of the user's own.
  useEffect(() => {
    if (fsRevision === 0) return
    let cancelled = false

    void (async () => {
      for (const tab of useStore.getState().tabs) {
        if (tab.content !== tab.savedContent) continue
        const fresh = await window.forge.workspace.read(tab.path).catch(() => null)
        if (cancelled || fresh === null || fresh === tab.content) continue
        useStore.getState().reloadTab(tab.path, fresh)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [fsRevision])

  const beforeMount = useCallback((monaco: Monaco) => {
    monaco.editor.defineTheme('forge-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '5d5a55', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'a98fd0' },
        { token: 'string', foreground: '7fb069' },
        { token: 'number', foreground: 'd4a24e' },
        { token: 'type', foreground: '6a9fdc' }
      ],
      colors: {
        'editor.background': '#100f0e',
        'editor.foreground': '#ededeb',
        'editorLineNumber.foreground': '#3d3c37',
        'editorLineNumber.activeForeground': '#85817a',
        'editor.selectionBackground': '#2c2c28',
        'editor.lineHighlightBackground': '#1a1a18',
        'editorCursor.foreground': '#d97757',
        'editorIndentGuide.background1': '#232320',
        'editorWidget.background': '#1a1a18',
        'editorWidget.border': '#2e2e2a'
      }
    })

    monaco.editor.defineTheme('forge-light', {
      base: 'vs',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#ffffff',
        'editor.lineHighlightBackground': '#f5f4f0'
      }
    })
  }, [])

  /*
   * Two things the editor gains over a plain text box.
   *
   * Ctrl+L quotes the selection into the composer, so a question about this
   * code does not start with a copy and paste. Ctrl+K asks for the change
   * directly, and the agent edits the file through its ordinary tools — the
   * same permission rules apply as anywhere else, which is why it is a message
   * rather than a private path that writes behind them.
   */
  const onMount = useCallback<OnMount>((editor, monaco) => {
    editorRef.current = editor

    const selectionContext = (): string | null => {
      const selection = editor.getSelection()
      const model = editor.getModel()
      if (!selection || !model || selection.isEmpty()) return null

      const path = useStore.getState().activeTab
      const text = model.getValueInRange(selection)
      const fence = String.fromCharCode(96, 96, 96)
      return (
        `${path}:${selection.startLineNumber}-${selection.endLineNumber}` +
        `${String.fromCharCode(10)}${fence}${String.fromCharCode(10)}${text}` +
        `${String.fromCharCode(10)}${fence}`
      )
    }

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyL, () => {
      const context = selectionContext()
      if (!context) return
      useStore.getState().appendToComposer(context)
    })

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => {
      const context = selectionContext()
      const path = useStore.getState().activeTab
      useStore
        .getState()
        .appendToComposer(
          context
            ? `Change this, and only this:${String.fromCharCode(10)}${String.fromCharCode(10)}${context}${String.fromCharCode(10)}${String.fromCharCode(10)}`
            : `In ${path}: `
        )
    })
  }, [])

  // The outline picker and search results ask the editor to scroll somewhere.
  const revealRequest = useStore((state) => state.revealRequest)
  useEffect(() => {
    if (!revealRequest || !editorRef.current) return
    const editor = editorRef.current
    editor.revealLineInCenter(revealRequest.line)
    editor.setPosition({ lineNumber: revealRequest.line, column: 1 })
    editor.focus()
  }, [revealRequest])

  if (!current) {
    return (
      <div className="pane editor-pane">
        <div className="welcome">
          <h2>No file open</h2>
          <p>Pick a file from the explorer, or just ask on the right.</p>
          <p>
            <kbd>Ctrl</kbd>+<kbd>,</kbd> settings · <kbd>Ctrl</kbd>+<kbd>`</kbd> terminal ·{' '}
            <kbd>Ctrl</kbd>+<kbd>B</kbd> sidebar
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="pane editor-pane">
      <div className="tabs">
        {tabs.map((tab) => (
          <div
            key={tab.path}
            className={`tab ${tab.path === activeTab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.path)}
            role="tab"
          >
            {tab.content !== tab.savedContent && <span className="dot" />}
            <span>{tab.path.split('/').pop()}</span>
            <button
              className="close"
              onClick={(event) => {
                event.stopPropagation()
                closeTab(tab.path)
              }}
              title="Close"
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="editor-host">
        <Editor
          path={current.path}
          value={current.content}
          language={languageFor(current.path)}
          theme={settings.theme === 'light' ? 'forge-light' : 'forge-dark'}
          beforeMount={beforeMount}
          onMount={onMount}
          onChange={(value) => updateTab(current.path, value ?? '')}
          options={{
            fontSize: settings.editorFontSize,
            fontFamily: settings.fontFamily,
            fontLigatures: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderWhitespace: 'selection',
            smoothScrolling: true,
            cursorBlinking: 'smooth',
            padding: { top: 10, bottom: 40 },
            lineNumbersMinChars: 4,
            tabSize: 2,
            automaticLayout: true,
            bracketPairColorization: { enabled: true }
          }}
        />
      </div>
    </div>
  )
}

const LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  sh: 'shell',
  ps1: 'powershell',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  sql: 'sql',
  xml: 'xml'
}

function languageFor(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return LANGUAGES[ext] ?? 'plaintext'
}
