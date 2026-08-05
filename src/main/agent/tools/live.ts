import type { LiveSession } from '../../live/session'
import type { MouseButton } from '../../live/input'
import { objectSchema, number, string, ToolError, type ToolDef } from './types'

/**
 * Tools for live mode.
 *
 * Only handed to the model while a session is running. That is the point: a
 * tool the model cannot see is a tool it cannot be talked into using, so an
 * inactive live mode is not a permission question at all — the capability
 * simply is not there.
 */

export function makeLiveTools(live: LiveSession): ToolDef<never>[] {
  const seeScreen: ToolDef<Record<string, never>> = {
    name: 'see_screen',
    description:
      'Take a screenshot of the screen or window the user is sharing and look at it. Do this ' +
      'before every action and again after, so you are acting on what is there now rather than ' +
      'what was there a moment ago. All coordinates you give are in the pixels of the image ' +
      'this returns.',
    parameters: objectSchema({}, []),
    readOnly: true,
    title: () => 'SeeScreen()',

    async run() {
      const frame = await live.look()
      return {
        content:
          `Screenshot of "${live.current().sourceName}", ${frame.width}x${frame.height}. ` +
          'Give coordinates in this image; they are mapped back to the real screen for you.',
        display: {
          kind: 'image',
          summary: `Looked at ${live.current().sourceName} · ${frame.width}x${frame.height}`,
          image: { mediaType: 'image/png', data: frame.data }
        },
        images: [{ type: 'image', mediaType: 'image/png', data: frame.data }]
      }
    }
  }

  interface ClickInput {
    x: number
    y: number
    button?: MouseButton
    double?: boolean
  }

  const clickScreen: ToolDef<ClickInput> = {
    name: 'click_screen',
    description:
      'Click at a point on the screenshot you last took. Take a fresh screenshot afterwards to ' +
      'see what happened.',
    parameters: objectSchema(
      {
        x: number('Horizontal pixel in the last screenshot.'),
        y: number('Vertical pixel in the last screenshot.'),
        button: string('left, right or middle. Defaults to left.'),
        double: string('Set to "true" for a double click.')
      },
      ['x', 'y']
    ),
    readOnly: false,
    title: (input) => `Click(${input.x},${input.y})`,

    async run(input) {
      const button = (input.button ?? 'left') as MouseButton
      if (!['left', 'right', 'middle'].includes(button)) {
        throw new ToolError(`Unknown mouse button "${input.button}".`)
      }
      const detail = await live.click(input.x, input.y, button, String(input.double) === 'true')
      return { content: detail, display: { kind: 'text', summary: detail } }
    }
  }

  interface DragInput {
    from_x: number
    from_y: number
    to_x: number
    to_y: number
  }

  const dragScreen: ToolDef<DragInput> = {
    name: 'drag_screen',
    description: 'Press the left button at one point, move to another, and release.',
    parameters: objectSchema(
      {
        from_x: number('Starting horizontal pixel.'),
        from_y: number('Starting vertical pixel.'),
        to_x: number('Ending horizontal pixel.'),
        to_y: number('Ending vertical pixel.')
      },
      ['from_x', 'from_y', 'to_x', 'to_y']
    ),
    readOnly: false,
    title: (input) => `Drag(${input.from_x},${input.from_y}→${input.to_x},${input.to_y})`,

    async run(input) {
      const detail = await live.drag(input.from_x, input.from_y, input.to_x, input.to_y)
      return { content: detail, display: { kind: 'text', summary: detail } }
    }
  }

  interface TypeInput {
    text: string
  }

  const typeScreen: ToolDef<TypeInput> = {
    name: 'type_text',
    description:
      'Type text wherever the keyboard focus currently is. Click the field you mean first — ' +
      'this types into whatever has focus, which may not be what you expect.',
    parameters: objectSchema({ text: string('Text to type.') }, ['text']),
    readOnly: false,
    title: (input) => `Type(${(input.text ?? '').slice(0, 24)})`,

    async run(input) {
      const detail = await live.typeText(input.text ?? '')
      return { content: detail, display: { kind: 'text', summary: detail } }
    }
  }

  interface KeyInput {
    key: string
    modifiers?: string
  }

  const pressKey: ToolDef<KeyInput> = {
    name: 'press_key',
    description:
      'Press a single key, optionally with modifiers. Keys: enter, tab, escape, backspace, ' +
      'delete, space, home, end, pageup, pagedown, up, down, left, right, f1-f12, or one ' +
      'character. Modifiers are comma separated: ctrl, alt, shift, win.',
    parameters: objectSchema(
      {
        key: string('Key name, or a single character.'),
        modifiers: string('Comma-separated modifiers, e.g. "ctrl,shift".')
      },
      ['key']
    ),
    readOnly: false,
    title: (input) => `Key(${[input.modifiers, input.key].filter(Boolean).join('+')})`,

    async run(input) {
      const modifiers = (input.modifiers ?? '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean)

      const detail = await live.pressKey(input.key ?? '', modifiers)
      return { content: detail, display: { kind: 'text', summary: detail } }
    }
  }

  interface ScrollInput {
    x: number
    y: number
    notches: number
  }

  const scrollScreen: ToolDef<ScrollInput> = {
    name: 'scroll_screen',
    description: 'Scroll the wheel over a point. Positive scrolls up, negative scrolls down.',
    parameters: objectSchema(
      {
        x: number('Horizontal pixel in the last screenshot.'),
        y: number('Vertical pixel in the last screenshot.'),
        notches: number('Wheel notches. 3 is about one comfortable scroll.')
      },
      ['x', 'y', 'notches']
    ),
    readOnly: false,
    title: (input) => `Scroll(${input.notches})`,

    async run(input) {
      const detail = await live.scroll(input.x, input.y, input.notches ?? 0)
      return { content: detail, display: { kind: 'text', summary: detail } }
    }
  }

  const tools: ToolDef<never>[] = [seeScreen as unknown as ToolDef<never>]

  // The acting tools only exist when the user granted control. Offering them in
  // a watch-only session would mean the model spends turns being refused.
  if (live.canControl) {
    tools.push(
      clickScreen as unknown as ToolDef<never>,
      dragScreen as unknown as ToolDef<never>,
      typeScreen as unknown as ToolDef<never>,
      pressKey as unknown as ToolDef<never>,
      scrollScreen as unknown as ToolDef<never>
    )
  }

  return tools
}
