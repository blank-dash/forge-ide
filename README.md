<div align="center">

<img src="build/icon-256.png" width="112" alt="Forge">

# Forge

**An agentic IDE where you bring the model.**

Two modes in one window: a full-screen conversation, or an editor with the agent
working beside you.

</div>

---

## Install

Grab your platform's build from
[Releases](https://github.com/blank-dash/forge-ide/releases):

| Platform | File |
| --- | --- |
| **Windows — any machine** | **`Forge-<version>-setup.exe`** — one installer for Intel/AMD and ARM, picks the right build itself |
| Windows, smaller download | `Forge-<version>-x64-setup.exe` or `-arm64-setup.exe` |
| Windows, no install | `Forge-<version>-x64-portable.exe` — runs from anywhere, including a USB stick |
| macOS (Apple silicon) | `Forge-<version>-arm64.dmg` |
| macOS (Intel) | `Forge-<version>-x64.dmg` |
| Linux, any distro | `Forge-<version>-x86_64.AppImage` (or `-arm64`) — `chmod +x` and run |
| Debian / Ubuntu | `Forge-<version>-amd64.deb` or `-arm64.deb` |
| Fedora / RHEL | `Forge-<version>-x86_64.rpm` |

**The builds are not code-signed**, so the OS will warn you the first time:

- **Windows** — SmartScreen shows "Windows protected your PC". Click **More
  info → Run anyway**.
- **macOS** — Gatekeeper says the app "cannot be opened". Right-click the app
  → **Open**, then **Open** again. Or run
  `xattr -dr com.apple.quarantine /Applications/Forge.app`.

Signing needs a paid certificate tied to a real identity; the release workflow
is ready for one but none is configured.

Forge checks for updates on its own and tells you when one is ready — it never
downloads or restarts without you asking.

### From source

```bash
npm install
npm run dev
```

Then open **Settings → Providers**, paste an API key, and pick a model.

## Bring your own model

Every provider is editable and you can add as many as you like. Pick the API
format your endpoint speaks:

| Format | Endpoint used | Works with |
| --- | --- | --- |
| `openai` | `{base}/chat/completions` | OpenAI, OpenRouter, Groq, DeepSeek, Together, Fireworks, xAI, Mistral, **Ollama**, **LM Studio**, vLLM, llama.cpp, LiteLLM — anything OpenAI-compatible |
| `anthropic` | `{base}/v1/messages` | Anthropic, and gateways that proxy it |
| `google` | `{base}/models/{model}:streamGenerateContent` | Gemini API |

**Add custom provider** → set the format and base URL → paste the key →
**Fetch list** to pull the server's own model catalogue, or type model ids by
hand. Local servers need no real key.

### Per-model customisation

A model is not just an id. Each one carries its own:

- context window and max output tokens
- capability flags — tools, vision, thinking
- input/output price per million tokens, driving the cost readout
- **temperature** and **thinking budget** overrides
- **context fill threshold** — how full the window gets before old turns are trimmed
- **extra request body (JSON)** — merged in last, so it overrides anything Forge
  sets. The escape hatch for `top_p`, `top_k`, `reasoning_effort`,
  `repeat_penalty`, `safety_settings`, or any parameter your endpoint supports
  that Forge has never heard of.

API keys live in the app's user-data directory, encrypted with the OS keychain
(DPAPI on Windows, Keychain on macOS, libsecret on Linux). The status bar shows
🔒 when encryption is active. Keys go nowhere except that provider's base URL.

## Chat and Edit

The switch sits in the title bar, or `Ctrl+1` / `Ctrl+2`.

**Chat** — the whole window is the conversation, with history down the left,
grouped by day and searchable. Read-only: mutating tools are not even offered to
the model, so it cannot change anything whatever it decides to do.

**Edit** — file tree, editor and agent panel side by side, with a terminal below.
How much the agent asks is a separate setting:

| Edits | Behaviour |
| --- | --- |
| `review` (default) | Changes apply immediately and collect in the review screen. Cursor-style. |
| `ask` | A dialog with the diff before every single edit. Claude Code-style. |
| `auto` | Applied silently. |

Shell commands have their own `ask` / `auto` switch, because "let it edit
freely" and "let it run anything" are different levels of trust.

### Review screen

`Ctrl+Shift+R`, the `N to review` pill, or `/changes`.

One card per file with its diff, **Keep** or **Revert** per file, plus keep-all
and revert-all. Revert restores the content from *before the agent's first*
change to that file, so a run of edits to one file still reverts cleanly in one
step.

### Permission rules

Approving with **Always allow** saves a rule such as `Bash(git status *)` or
`Edit(src/app.ts)`. Deny rules are checked first and beat everything else,
including auto mode. Rejecting lets you type a reason, which is fed back to the
model as the tool result — the usual way to steer it without restarting a turn.

## Pasting and dropping

Paste or drag anything into the composer:

- **Screenshots and images** — pasted straight from the clipboard, downscaled to
  1568px on the long edge (larger is downsampled server-side anyway) and sent as
  real image blocks. Thumbnails appear in the composer and in the transcript.
- **Files** — attached by *path*, not by content, so the agent reads exactly as
  much as it needs with its normal tools. A pasted file counts as you naming
  that path, so it needs no separate approval even outside the workspace.
- **Long text** — a paste over ~24 lines collapses into a chip instead of
  flooding the composer. It is still sent in full, fenced so it cannot be
  mistaken for instructions.

If the current model is not marked vision-capable, images are held back with a
visible warning rather than silently dropped by the API.

## Context meter

Next to the model picker: how full the window is, as a bar and a number.

Before the first reply it shows Forge's own estimate, prefixed with `~`.
Afterwards it shows the provider's reported input count, which is the real
figure. It turns amber past 70% and red past 90% — the point where trimming
starts throwing away old turns. Clicking it opens the model settings, where the
context window is editable per model, which matters for custom endpoints Forge
cannot know the limits of.

## Files anywhere on your machine

**A path you typed yourself needs no approval.** Write `fix C:\proj\main.py` and
the agent opens it immediately: naming the file *is* the authorisation, and a
dialog for the file you just asked about is friction with no safety value. The
path has to actually exist, so prose that looks path-shaped is ignored.

Any *other* outside location — one the agent went looking for on its own —
opens an approval dialog. **Always allow** remembers that folder under
Settings → Permissions.

## Terminal

A real pty, so the shell prints its own prompt, colours work, and `vim`, `top`,
`ssh` and password prompts behave. Multiple tabs; PowerShell 7 is preferred over
Windows PowerShell when installed, and `$SHELL` elsewhere.

The pty binary is prebuilt and needs no compiler. If it ever fails to load,
sessions fall back to pipes automatically — degraded, clearly labelled in the
terminal, and the app keeps working.

## Git

The **Git** tab: branch, ahead/behind, staged and unstaged files, diff on click,
stage/unstage/commit. The status bar shows the branch and dirty count.

The agent sees repository state too — branch, uncommitted files and the last
five commits go into its system prompt, so "commit this" needs no reconnaissance.

## MCP servers

Settings → MCP servers. Both transports:

- **stdio** — command, arguments and environment (`npx -y @modelcontextprotocol/server-filesystem .`)
- **http** — URL and headers, including streamable-HTTP servers that answer over SSE

Discovered tools are namespaced `mcp__<server>__<tool>` and sit alongside the
built-ins. Each prompts before it runs; tick one in settings to auto-approve it.
A server that fails to start is reported inline and never takes the app down.

An MCP server is a real process with your permissions. Only connect ones you
trust, and treat what they return as data, not instructions.

## Tools the agent has

`read_file` · `write_file` · `edit_file` · `delete_file` · `list_dir` · `glob` ·
`grep` · `run_command` — plus everything your MCP servers contribute.

A handful of system-destroying command shapes (`rm -rf /`, `mkfs`, fork bombs)
are blocked outright regardless of settings.

## Slash commands

`/model` `/chat` `/agent` `/review` `/ask` `/auto` `/changes` `/git` `/history`
`/settings` `/providers` `/mcp` `/permissions` `/clear` `/cost` `/init`

`@` autocompletes workspace files.

## History

Conversations are saved per workspace in the app's user-data directory — never
inside your repository. Reopen them from the chat sidebar or the History tab.

## Project instructions

A `FORGE.md`, `AGENTS.md`, `CLAUDE.md` or `.cursorrules` at the workspace root is
read into the system prompt automatically. `/init` asks the agent to write one.

## Keyboard

| | |
| --- | --- |
| `Ctrl` `1` / `Ctrl` `2` | Chat / Edit mode |
| `Ctrl` `O` | Open folder |
| `Ctrl` `N` | New conversation |
| `Ctrl` `,` | Settings |
| `Ctrl` `` ` `` | Terminal |
| `Ctrl` `B` | Toggle sidebar |
| `Ctrl` `Shift` `G` | Source control |
| `Ctrl` `Shift` `R` | Review screen |
| `Ctrl` `S` | Save file |
| `Enter` / `Shift`+`Enter` | Send / newline |
| `Esc` | Interrupt the running turn |
| `Ctrl`+`Enter` / `Esc` | Allow / reject in the permission dialog |

## Stability

The things that break long agent sessions, and what Forge does about them:

- **Context overflow** — the conversation is measured against the model's window
  before every request. Old tool results are compacted first; only then are whole
  turns dropped, and dropping always stops on a clean user turn so the
  assistant/tool-result pairing every provider validates stays intact.
- **Transient provider failures** — 429/5xx and socket resets retry up to three
  times with backoff, but only while nothing has been streamed, so text is never
  duplicated on screen.
- **Crashes** — `uncaughtException` and `unhandledRejection` are reported into the
  UI instead of killing the app; a renderer crash reloads the window; each pane
  has its own error boundary.
- **Single instance** — a second launch focuses the existing window rather than
  fighting over the settings file and MCP child processes.
- **Window state** — size, position and maximised state are restored, and a
  position on a monitor you unplugged is discarded rather than opening off-screen.
- **Editor and tree stay live** — files the agent creates or rewrites refresh in
  the tree and in open tabs, but never over your own unsaved edits.

## Layout

```
src/
  main/                 Electron main process
    providers/          one adapter per wire protocol (anthropic, openai, google)
    agent/
      session.ts        the agent loop: stream → tool calls → results → repeat
      context.ts        context-window budgeting and trimming
      changes.ts        pending-change tracking for the review screen
      permissions.ts    rule matching and mode enforcement
      paths.ts          absolute paths the user named, which need no approval
      prompt.ts         system prompt assembly
      tools/            filesystem, search, shell
    mcp/                MCP client (stdio + http) and server lifecycle
    git.ts              git CLI wrapper
    terminal.ts         pty sessions, with a pipe fallback
    sessions.ts         conversation history, per workspace
    updater.ts          GitHub release checks
    menu.ts             application menu and accelerators
    window-state.ts     window geometry persistence
  preload/              typed IPC bridge (contextIsolation on, no node in renderer)
  renderer/             React UI — chat view, editor, review, git, settings
  shared/               types shared across processes
build/icon.svg          the app mark; `npm run icons` rasterises it
scripts/smoke.ts        dependency-free tests for the tricky pure logic
```

Adding a provider that speaks a fourth protocol means one file in
`src/main/providers/` implementing `stream()` and `listModels()`, plus an entry
in the adapter map — nothing else in the app knows the difference.

## Build and release

```bash
npm run typecheck
npm run smoke       # 32 tests over diff, permissions, context, changes, paths, SSE
npm run icons       # regenerate PNGs from build/icon.svg
npm run build       # bundle to out/
npm run dist        # build installers into release/ without publishing
```

Tagging a version publishes installers for Windows, macOS and Linux to a GitHub
release, which is also the feed the in-app updater reads:

```bash
npm version patch && git push --follow-tags
```

## Known limits

- **Builds are unsigned.** Windows SmartScreen and macOS Gatekeeper will warn on
  first run until certificates are added to the release workflow.
- **Thinking blocks are not replayed.** Anthropic requires the original signature
  to send one back in a later turn and we do not persist it, so thinking is shown
  but dropped from history.
- **Token counts are estimated** for context budgeting (characters ÷ 3.4). The
  status bar shows the provider's own numbers, not the estimate.
- No inline Cursor-Tab-style completions, no hunk-level accept inside a file, no
  MCP resources or prompts (tools only).

## License

MIT
