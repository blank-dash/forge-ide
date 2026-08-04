import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import type { Skill } from '@shared/types'
import { BUILTIN_SKILLS } from '@shared/skills'

/**
 * Skills are reusable instruction packs.
 *
 * Only the name and one-line description of each go into the system prompt —
 * fifty full bodies would cost more context than the conversation. The model
 * pulls the body it needs with the `use_skill` tool, which is the whole point:
 * a large library stays affordable because most of it is never loaded.
 */
export class SkillLibrary {
  private custom: Skill[] = []

  /** `<userData>/skills` — skills the user keeps across every project. */
  private get globalDir(): string {
    return path.join(app.getPath('userData'), 'skills')
  }

  /** `<workspace>/.forge/skills` — skills that belong to one project. */
  private projectDir(cwd: string): string {
    return path.join(cwd, '.forge', 'skills')
  }

  async load(cwd: string): Promise<void> {
    const [globals, project] = await Promise.all([
      readDir(this.globalDir, 'global'),
      readDir(this.projectDir(cwd), 'project')
    ])
    // A project skill with the same id as a global one wins: it is more specific.
    const byId = new Map<string, Skill>()
    for (const skill of [...globals, ...project]) byId.set(skill.id, skill)
    this.custom = [...byId.values()]
  }

  all(disabled: string[]): Skill[] {
    const off = new Set(disabled)
    return [...BUILTIN_SKILLS, ...this.custom].filter((skill) => !off.has(skill.id))
  }

  find(id: string, disabled: string[]): Skill | undefined {
    return this.all(disabled).find((skill) => skill.id === id)
  }

  /** The catalogue line the model sees: enough to choose, not enough to cost. */
  catalogue(disabled: string[]): string {
    const skills = this.all(disabled)
    if (skills.length === 0) return ''

    const byCategory = new Map<string, Skill[]>()
    for (const skill of skills) {
      const list = byCategory.get(skill.category) ?? []
      list.push(skill)
      byCategory.set(skill.category, list)
    }

    return [...byCategory.entries()]
      .map(
        ([category, list]) =>
          `${category}\n${list.map((skill) => `  ${skill.id} — ${skill.description}`).join('\n')}`
      )
      .join('\n')
  }

  async createDir(cwd: string, scope: 'global' | 'project'): Promise<string> {
    const dir = scope === 'global' ? this.globalDir : this.projectDir(cwd)
    await fs.mkdir(dir, { recursive: true })
    return dir
  }
}

/**
 * Reads `*.md` files whose front matter carries a description. The format is
 * deliberately the same shape people already write for other agent tools, so
 * an existing library can be dropped in unchanged.
 */
async function readDir(dir: string, source: Skill['source']): Promise<Skill[]> {
  const names = await fs.readdir(dir).catch(() => [] as string[])

  const skills = await Promise.all(
    names
      .filter((name) => name.endsWith('.md'))
      .map(async (name) => {
        const raw = await fs.readFile(path.join(dir, name), 'utf8').catch(() => null)
        if (!raw) return null
        return parseSkill(raw, path.basename(name, '.md'), source)
      })
  )

  return skills.filter((skill): skill is Skill => skill !== null)
}

export function parseSkill(raw: string, fallbackId: string, source: Skill['source']): Skill | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw.trim())
  const front = match ? match[1] : ''
  const body = (match ? match[2] : raw).trim()
  if (!body) return null

  const field = (key: string): string =>
    new RegExp(`^${key}\\s*:\\s*(.+)$`, 'im').exec(front)?.[1]?.trim().replace(/^["']|["']$/g, '') ??
    ''

  return {
    id: field('name') || fallbackId,
    description: field('description') || firstLine(body),
    category: field('category') || 'Custom',
    body,
    source
  }
}

function firstLine(body: string): string {
  const line = body.split('\n').find((entry) => entry.trim() && !entry.startsWith('#'))
  return (line ?? '').slice(0, 140)
}
