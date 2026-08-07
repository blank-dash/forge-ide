import { execFile } from 'node:child_process'
import type { GitCommit, GitFile, GitFileState, GitStatus } from '@shared/types'

const MAX_BUFFER = 12 * 1024 * 1024
const TIMEOUT_MS = 20_000

/** ASCII unit separator — safe inside commit subjects, unlike any printable char. */
const SEP = String.fromCharCode(31)

export class GitError extends Error {}

/**
 * Thin wrapper over the `git` CLI. No native dependency, no libgit2 — the CLI
 * is already on the machine of anyone who has a repository to work in, and its
 * porcelain output is a stable contract.
 */
export class Git {
  constructor(private readonly cwd: () => string) {}

  async isAvailable(): Promise<boolean> {
    try {
      await this.run(['--version'])
      return true
    } catch {
      return false
    }
  }

  async status(): Promise<GitStatus> {
    const empty: GitStatus = {
      isRepo: false,
      branch: '',
      upstream: null,
      ahead: 0,
      behind: 0,
      files: []
    }

    let raw: string
    try {
      raw = await this.run(['status', '--porcelain=v1', '--branch', '--untracked-files=all', '-z'])
    } catch (error) {
      const message = (error as Error).message
      // "not a git repository" is the normal case for a plain folder.
      if (/not a git repository/i.test(message)) return empty
      return { ...empty, error: message }
    }

    // -z separates entries with NUL; the branch header is the first entry.
    const entries = raw.split('\0').filter((entry) => entry.length > 0)
    const files: GitFile[] = []
    let branch = ''
    let upstream: string | null = null
    let ahead = 0
    let behind = 0

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]

      if (entry.startsWith('## ')) {
        const header = entry.slice(3)
        const [names, tracking] = splitOnce(header, ' [')
        const [local, remote] = splitOnce(names, '...')
        branch = local.replace(/^No commits yet on /, '').trim()
        upstream = remote || null
        ahead = Number(/ahead (\d+)/.exec(tracking ?? '')?.[1] ?? 0)
        behind = Number(/behind (\d+)/.exec(tracking ?? '')?.[1] ?? 0)
        continue
      }

      const index = entry[0]
      const worktree = entry[1]
      let file = entry.slice(3)

      // Renames put the source path in the following NUL-separated field.
      if (index === 'R' || worktree === 'R') {
        const source = entries[++i] ?? ''
        file = `${source} → ${file}`
      }

      files.push({
        path: file,
        state: classify(index, worktree),
        staged: index !== ' ' && index !== '?',
        partiallyStaged: index !== ' ' && index !== '?' && worktree !== ' ' && worktree !== '?'
      })
    }

    return { isRepo: true, branch, upstream, ahead, behind, files }
  }

  async diff(file: string, staged: boolean): Promise<string> {
    const args = ['diff', '--no-color', '--no-ext-diff']
    if (staged) args.push('--cached')
    args.push('--', file)

    const output = await this.run(args)
    if (output.trim()) return output

    // An untracked file has nothing to diff against, so compare it against
    // nothing. --no-index exits 1 whenever the files differ, which is always
    // the case here, so the non-zero exit is expected rather than an error.
    const status = await this.run(['status', '--porcelain=v1', '--', file]).catch(() => '')
    if (status.startsWith('??')) {
      return this.run(['diff', '--no-color', '--no-index', '--', '/dev/null', file], {
        tolerateFailure: true
      })
    }

    return output
  }

  async stage(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    await this.run(['add', '--', ...paths])
  }

  async unstage(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    await this.run(['restore', '--staged', '--', ...paths])
  }

  async discard(paths: string[]): Promise<void> {
    if (paths.length === 0) return
    // Tracked files are restored; untracked ones have to be removed explicitly.
    await this.run(['restore', '--worktree', '--', ...paths]).catch((error) =>
      console.warn('[git] restore failed', paths, error)
    )
    await this.run(['clean', '-fd', '--', ...paths]).catch((error) =>
      console.warn('[git] clean failed', paths, error)
    )
  }

  async commit(message: string, stageAll: boolean): Promise<string> {
    if (!message.trim()) throw new GitError('A commit message is required.')
    if (stageAll) await this.run(['add', '-A'])

    const staged = await this.run(['diff', '--cached', '--name-only'])
    if (!staged.trim()) throw new GitError('Nothing is staged — stage some files first.')

    await this.run(['commit', '-m', message])
    return this.run(['log', '-1', '--pretty=%h %s'])
  }

  async log(limit = 20): Promise<GitCommit[]> {
    const output = await this.run([
      'log',
      `-${limit}`,
      `--pretty=format:%H${SEP}%h${SEP}%s${SEP}%an${SEP}%cr`
    ]).catch(() => '')

    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, subject, author, relativeDate] = line.split(SEP)
        return { hash, shortHash, subject, author, relativeDate }
      })
  }

  async branches(): Promise<string[]> {
    const output = await this.run(['branch', '--format=%(refname:short)']).catch(() => '')
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  }

  async checkout(branch: string): Promise<void> {
    await this.run(['checkout', branch])
  }

  /** Short summary injected into the system prompt so the agent knows the state. */
  async promptContext(): Promise<string> {
    const status = await this.status()
    if (!status.isRepo) return ''

    const parts = [`Branch: ${status.branch}`]
    if (status.upstream) {
      parts.push(`tracking ${status.upstream} (ahead ${status.ahead}, behind ${status.behind})`)
    }

    const dirty = status.files.slice(0, 25).map((file) => `  ${file.state.padEnd(9)} ${file.path}`)
    const extra =
      status.files.length > dirty.length ? `\n  … ${status.files.length - dirty.length} more` : ''

    const commits = await this.log(5)
    const recent = commits.map((commit) => `  ${commit.shortHash} ${commit.subject}`).join('\n')

    return [
      parts.join(', '),
      status.files.length > 0
        ? `Uncommitted changes:\n${dirty.join('\n')}${extra}`
        : 'Working tree clean',
      commits.length > 0 ? `Recent commits:\n${recent}` : ''
    ]
      .filter(Boolean)
      .join('\n')
  }

  /**
   * `tolerateFailure` is for the handful of git commands whose non-zero exit is
   * a normal answer rather than a problem (`diff --no-index` exits 1 when the
   * files differ).
   */
  private run(args: string[], options: { tolerateFailure?: boolean } = {}): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        { cwd: this.cwd(), maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS, windowsHide: true },
        (error, stdout, stderr) => {
          if (error && !(options.tolerateFailure && stdout)) {
            const detail = (stderr || stdout || error.message).trim()
            reject(new GitError(detail || `git ${args[0]} failed`))
            return
          }
          resolve(stdout)
        }
      )
    })
  }
}

function classify(index: string, worktree: string): GitFileState {
  if (index === '?' || worktree === '?') return 'untracked'
  if (index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A')) return 'conflict'
  if (index === 'R' || worktree === 'R') return 'renamed'
  if (index === 'A') return 'added'
  if (index === 'D' || worktree === 'D') return 'deleted'
  return 'modified'
}

function splitOnce(value: string, separator: string): [string, string | null] {
  const index = value.indexOf(separator)
  if (index === -1) return [value, null]
  return [value.slice(0, index), value.slice(index + separator.length).replace(/\]$/, '')]
}
