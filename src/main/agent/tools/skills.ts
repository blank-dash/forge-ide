import type { Skill } from '@shared/types'
import { objectSchema, string, ToolError, type ToolDef } from './types'

interface UseSkillInput {
  name: string
}

/**
 * Loads one skill's full instructions on demand.
 *
 * The catalogue in the system prompt carries only names and one-line
 * descriptions, so a library of fifty costs a few hundred tokens instead of
 * tens of thousands. The body arrives only for the skill actually being used.
 */
export function makeUseSkillTool(
  lookup: (name: string) => Skill | undefined,
  available: () => Skill[]
): ToolDef<UseSkillInput> {
  return {
    name: 'use_skill',
    description:
      'Load the full instructions for one of the skills listed under "Skills" in the system ' +
      'prompt. Call this before starting a task a skill covers, then follow what it says. ' +
      'The catalogue only shows summaries — this is how you get the actual guidance.',
    parameters: objectSchema(
      { name: string('The skill id exactly as it appears in the catalogue.') },
      ['name']
    ),
    readOnly: true,
    title: (input) => `Skill(${input.name})`,

    async run(input) {
      const requested = (input.name ?? '').trim()
      const found = lookup(requested)

      if (!found) {
        const near = available()
          .map((entry) => entry.id)
          .filter((id) => id.includes(requested) || requested.includes(id))
          .slice(0, 5)

        throw new ToolError(
          `No skill called "${requested}".` +
            (near.length > 0 ? ` Did you mean: ${near.join(', ')}?` : '') +
            ' The catalogue is in the system prompt under "Skills".'
        )
      }

      return {
        content: `Skill: ${found.id}\n${found.description}\n\n${found.body}`,
        display: {
          kind: 'text',
          summary: found.description,
          body: found.body
        }
      }
    }
  }
}
