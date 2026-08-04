import { useEffect, useMemo, useState } from 'react'
import type { Skill } from '@shared/types'

type Props = {
  disabled: string[]
  onChange(next: string[]): void
}

export default function SkillSettings({ disabled, onChange }: Props) {
  const [skills, setSkills] = useState<Skill[]>([])
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.forge.skills.list().then(setSkills).catch(() => setSkills([]))
  }, [])

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const matching = needle
      ? skills.filter(
          (entry) =>
            entry.id.includes(needle) ||
            entry.description.toLowerCase().includes(needle) ||
            entry.category.toLowerCase().includes(needle)
        )
      : skills

    const byCategory = new Map<string, Skill[]>()
    for (const entry of matching) {
      byCategory.set(entry.category, [...(byCategory.get(entry.category) ?? []), entry])
    }
    return [...byCategory.entries()]
  }, [skills, query])

  const off = new Set(disabled)
  const enabledCount = skills.length - skills.filter((entry) => off.has(entry.id)).length

  return (
    <>
      <h3>Skills</h3>
      <p>
        Reusable instruction packs. The agent sees only the names and one-line summaries — it
        loads a full skill with the <code>use_skill</code> tool when it needs one, so a large
        library costs almost no context.
      </p>

      <div className="row" style={{ marginBottom: 12 }}>
        <input
          className="input"
          placeholder={`Search ${skills.length} skills`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          className="btn narrow"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              setSkills(await window.forge.skills.reload())
            } finally {
              setBusy(false)
            }
          }}
        >
          Reload
        </button>
      </div>

      <div className="hint" style={{ marginBottom: 14 }}>
        {enabledCount} of {skills.length} enabled.
      </div>

      {groups.map(([category, list]) => (
        <div key={category}>
          <h4>{category}</h4>
          {list.map((entry) => {
            const isOff = off.has(entry.id)
            return (
              <div className="skill-row" key={entry.id}>
                <label className="switch" style={{ flex: 'none' }}>
                  <input
                    type="checkbox"
                    checked={!isOff}
                    onChange={(event) =>
                      onChange(
                        event.target.checked
                          ? disabled.filter((id) => id !== entry.id)
                          : [...disabled, entry.id]
                      )
                    }
                  />
                </label>

                <button
                  className="skill-open"
                  onClick={() => setOpen(open === entry.id ? null : entry.id)}
                >
                  <span className="skill-name">{entry.id}</span>
                  <span className="skill-desc">{entry.description}</span>
                </button>

                {entry.source !== 'builtin' && <span className="badge">{entry.source}</span>}
              </div>
            )
          })}

          {list.map((entry) =>
            open === entry.id ? (
              <pre className="skill-body" key={`${entry.id}-body`}>
                {entry.body}
              </pre>
            ) : null
          )}
        </div>
      ))}

      <h4>Add your own</h4>
      <p className="hint">
        The {skills.filter((entry) => entry.source === 'builtin').length} skills above are built
        into the app, not files — that is why the folders below start empty. Anything you put in
        them appears here alongside the bundled ones, and a file with the same name replaces a
        built-in.
      </p>
      <p className="hint">
        A skill is a markdown file with <code>name</code>, <code>description</code> and{' '}
        <code>category</code> in its front matter, then the instructions. Project skills live in
        the workspace and travel with the repository; global ones follow you between projects.
      </p>
      <div className="row">
        <button className="btn" onClick={() => void window.forge.skills.openFolder('global')}>
          Open global folder
        </button>
        <button className="btn" onClick={() => void window.forge.skills.openFolder('project')}>
          Open project folder
        </button>
        <span style={{ flex: 2 }} />
      </div>
    </>
  )
}
