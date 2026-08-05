import type { Browser } from '../../browser'
import { normaliseUrl } from '../../browser'
import { objectSchema, string, ToolError, truncate, type ToolDef } from './types'

/**
 * Tools that drive the built-in browser.
 *
 * They need the live view, not just the workspace, so they are built with it
 * rather than declared statically like the filesystem tools.
 */

interface OpenInput {
  url: string
}

export function makeBrowserTools(browser: Browser, reveal: () => void): ToolDef<never>[] {
  const openPage: ToolDef<OpenInput> = {
    name: 'open_page',
    description:
      'Open a URL in the built-in browser and return the page as text. Use this to show the ' +
      'user a running dev server, check what a page actually renders, or read documentation. ' +
      'The browser pane comes to the front so they can see it.',
    parameters: objectSchema(
      {
        url: string('Address to open. A bare hostname gets https:// added.')
      },
      ['url']
    ),
    // A page is read, not written. The permission request below is what covers
    // the part that is not read-only: it reaches the network.
    readOnly: true,
    title: (input) => `Open(${input.url})`,

    async run(input, ctx) {
      const url = normaliseUrl(input.url ?? '')

      // 'external' is the existing kind for "outside the workspace", which a
      // web address certainly is. It also means an unattended task at anything
      // below full access cannot quietly start fetching URLs.
      const approved = await ctx.requestPermission({
        toolName: 'open_page',
        kind: 'external',
        title: `Open ${url}`,
        detail: `The built-in browser will load:\n${url}`,
        suggestedRule: `Open(${safeHost(url)}/*)`
      })
      if (!approved) throw new ToolError('User declined to open that page.')

      reveal()
      await browser.navigate(url)

      const page = await browser.readText()
      if (!page.text) {
        throw new ToolError(
          `Opened ${page.url} but it rendered no text — it may still be loading, or it may be a ` +
            'page that needs interaction.'
        )
      }

      return {
        content: `# ${page.title || page.url}\n${page.url}\n\n${truncate(page.text)}`,
        display: { kind: 'text', summary: `Opened ${page.title || page.url}`, body: page.url }
      }
    }
  }

  const readPage: ToolDef<Record<string, never>> = {
    name: 'read_page',
    description:
      'Read the page currently open in the built-in browser as text, without navigating. Use ' +
      'this after the user has browsed somewhere themselves, or to re-read a page that changed.',
    parameters: objectSchema({}, []),
    readOnly: true,
    title: () => 'ReadPage()',

    async run() {
      const page = await browser.readText()
      if (!page.url) throw new ToolError('Nothing is open in the built-in browser yet.')

      return {
        content: `# ${page.title || page.url}\n${page.url}\n\n${truncate(page.text)}`,
        display: { kind: 'text', summary: `Read ${page.title || page.url}`, body: page.url }
      }
    }
  }

  return [openPage, readPage] as unknown as ToolDef<never>[]
}

/** Host only, so an "always allow" rule does not pin one exact query string. */
function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
