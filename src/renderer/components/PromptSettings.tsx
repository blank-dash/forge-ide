import type { SavedPrompt, Settings } from '@shared/types'
import { useT } from '../i18n'

type Props = {
  draft: Settings
  patch: (partial: Partial<Settings>) => void
}

/**
 * Prompts worth keeping.
 *
 * They appear in the composer under their name, typed after a slash, and put
 * their text in the box rather than sending it — the usual shape is a saved
 * prompt plus a sentence of specifics, and sending immediately would lose the
 * second half.
 */
export default function PromptSettings({ draft, patch }: Props) {
  const t = useT()

  const update = (id: string, partial: Partial<SavedPrompt>): void =>
    patch({
      prompts: draft.prompts.map((entry) => (entry.id === id ? { ...entry, ...partial } : entry))
    })

  const add = (): void =>
    patch({
      prompts: [
        ...draft.prompts,
        {
          id: `p${Date.now().toString(36)}`,
          name: 'new-prompt',
          description: '',
          body: ''
        }
      ]
    })

  return (
    <>
      <h3>{t('Prompt library')}</h3>
      <p>
        {t(
          'Prompts you type often, kept where you can reach them. Each one appears in the composer as a slash command and fills the box, so you can add the specifics before sending.'
        )}
      </p>

      {draft.prompts.map((prompt) => (
        <div className="prompt-card" key={prompt.id}>
          <div className="row">
            <div className="field narrow">
              <label>{t('Typed as')}</label>
              <input
                className="input mono"
                value={prompt.name}
                onChange={(event) =>
                  // Spaces would end the slash command halfway through its own
                  // name, so they never make it into one.
                  update(prompt.id, {
                    name: event.target.value
                      .trim()
                      .replace(/[^\w-]/g, '-')
                      .toLowerCase()
                  })
                }
              />
            </div>
            <div className="field">
              <label>{t('What it is for')}</label>
              <input
                className="input"
                value={prompt.description}
                placeholder={t('Shown beside the name')}
                onChange={(event) => update(prompt.id, { description: event.target.value })}
              />
            </div>
            <button
              className="btn btn-danger narrow"
              onClick={() =>
                patch({ prompts: draft.prompts.filter((entry) => entry.id !== prompt.id) })
              }
            >
              {t('Remove')}
            </button>
          </div>

          <div className="field">
            <textarea
              className="textarea"
              rows={4}
              value={prompt.body}
              placeholder={t('The prompt itself')}
              onChange={(event) => update(prompt.id, { body: event.target.value })}
            />
          </div>

          <div className="hint">
            {t('Type')} <code>/{prompt.name || '…'}</code> {t('in the composer.')}
          </div>
        </div>
      ))}

      <button className="btn" style={{ marginTop: 12 }} onClick={add}>
        {t('Add a prompt')}
      </button>
    </>
  )
}
