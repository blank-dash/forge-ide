# Architecture

Forge dash is split into three trust zones.

- **Main process (`src/main`)** owns files, terminals, Git, provider requests, MCP processes and persistence.
- **Preload (`src/preload`)** exposes the typed `window.forge` IPC surface. It is the only renderer-to-host bridge.
- **Renderer (`src/renderer`)** is React and Zustand. It displays state and requests host operations; it never imports Node or Electron APIs.
- **Shared (`src/shared`)** contains serializable types and pure helpers used on both sides.

## Agent event flow

1. A composer submits through `window.forge.agent.send`.
2. IPC creates or resumes a main-process agent session.
3. The provider streams content and tool requests.
4. Tools run in main after the permission policy approves them.
5. Main emits typed `AgentEvent` values through preload.
6. The renderer reduces those events into the active or background session view.

Tools stay in main so web UI code cannot directly access the machine. IPC arguments and disk data are trust boundaries and must be validated there.
