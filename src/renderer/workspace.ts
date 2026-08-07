import type { Bootstrap } from '../preload'
import { useStore } from './store'

export function hasUnsavedTabs(): boolean {
  return useStore.getState().tabs.some((tab) => tab.content !== tab.savedContent)
}

export async function chooseWorkspace(): Promise<boolean> {
  if (
    hasUnsavedTabs() &&
    !window.confirm('Discard unsaved editor changes and open another folder?')
  ) {
    return false
  }
  const picked = await window.forge.workspace.pick()
  if (!picked) return false
  await resetWorkspace()
  return true
}

export async function resetWorkspace(): Promise<void> {
  const bootstrap = await window.forge.bootstrap()
  useStore.getState().resetWorkspace(bootstrap)
}

export function bootstrapForWorkspace(
  current: Bootstrap,
  picked: { cwd: string; name: string }
): Bootstrap {
  return { ...current, cwd: picked.cwd, workspaceName: picked.name }
}
