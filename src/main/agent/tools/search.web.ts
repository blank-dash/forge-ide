import type { Browser } from '../../browser'
import { objectSchema, number, string, ToolError, truncate, type ToolDef } from './types'

/**
 * Looking things up on the web.
 *
 * Deliberately separate from the browser pane, and deliberately invisible.
 * Asking the agent a question that needs a search should not throw a browser
 * across the screen — it should say it is looking, and come back with an answer.
 * The pane is for when you asked to *see* something.
 *
 * Both tools read through a view that is never attached to the window, so they
 * also cannot navigate away from whatever page you have open yourself.
 */

interface SearchInput {
  query: string
  limit?: number
}

interface FetchInput {
  url: string
}

const DEFAULT_RESULTS = 8
const MAX_RESULTS = 15

export function makeWebTools(scout: Browser): ToolDef<never>[] {
  const searchWeb: ToolDef<SearchInput> = {
    name: 'search_web',
    description:
      'Search the web and get back a list of results with titles, links and snippets. Happens ' +
      'in the background — nothing is shown to the user. Follow up with read_url on whichever ' +
      'result looks right; the snippets alone are rarely enough to answer with.',
    parameters: objectSchema(
      {
        query: string('What to search for, phrased as you would type it.'),
        limit: number(`How many results to return. Default ${DEFAULT_RESULTS}.`)
      },
      ['query']
    ),
    readOnly: true,
    title: (input) => `Search(${input.query})`,

    async run(input, ctx) {
      const query = (input.query ?? '').trim()
      if (!query) throw new ToolError('Nothing to search for.')

      const approved = await ctx.requestPermission({
        toolName: 'search_web',
        kind: 'external',
        title: 'Search the web',
        detail: query,
        // One rule covers searching in general: the query is different every
        // time, so a per-query rule would ask again on every question.
        suggestedRule: 'Search(*)'
      })
      if (!approved) throw new ToolError('User declined the web search.')

      // The HTML endpoint renders without JavaScript and without the consent
      // interstitial the main site shows, so one load is enough.
      await scout.navigate(`https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`)
      const results = await scout.extractResults()

      if (results.length === 0) {
        throw new ToolError(
          `No results came back for "${query}". Try different words, or read_url a page directly.`
        )
      }

      const wanted = Math.min(MAX_RESULTS, Math.max(1, input.limit ?? DEFAULT_RESULTS))
      const shown = results.slice(0, wanted)

      return {
        content: shown
          .map((entry, index) => `${index + 1}. ${entry.title}\n   ${entry.url}\n   ${entry.snippet}`)
          .join('\n\n'),
        display: {
          kind: 'list',
          summary: `Searched the web · ${shown.length} results`,
          body: shown.map((entry) => `${entry.title}\n${entry.url}`).join('\n\n')
        }
      }
    }
  }

  const readUrl: ToolDef<FetchInput> = {
    name: 'read_url',
    description:
      'Fetch a page and return it as text, in the background. Use this after search_web, or ' +
      'for any address you already know. Use open_page instead when the user should actually ' +
      'see the page.',
    parameters: objectSchema({ url: string('Address to read.') }, ['url']),
    readOnly: true,
    title: (input) => `Read(${input.url})`,

    async run(input, ctx) {
      const url = (input.url ?? '').trim()
      if (!url) throw new ToolError('No address given.')

      const approved = await ctx.requestPermission({
        toolName: 'read_url',
        kind: 'external',
        title: `Read ${url}`,
        detail: `Fetched in the background, without showing it:\n${url}`,
        suggestedRule: `Read(${hostOf(url)}/*)`
      })
      if (!approved) throw new ToolError('User declined to read that page.')

      await scout.navigate(url)
      const page = await scout.readText()

      if (!page.text) {
        throw new ToolError(
          `${page.url} rendered no readable text. It may need signing in, or be a file rather ` +
            'than a page.'
        )
      }

      return {
        content: `# ${page.title || page.url}\n${page.url}\n\n${truncate(page.text)}`,
        display: {
          kind: 'text',
          summary: `Read ${page.title || page.url}`,
          body: page.url
        }
      }
    }
  }

  return [searchWeb, readUrl] as unknown as ToolDef<never>[]
}

function hostOf(url: string): string {
  try {
    return new URL(url.includes('://') ? url : `https://${url}`).host
  } catch {
    return url
  }
}
