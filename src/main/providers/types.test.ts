import { describe, expect, it, vi } from 'vitest'
import { applyExtraBody, retryAfterMs, retryDelay } from './types'

describe('provider request helpers', () => {
  it('does not allow extraBody to replace protocol fields', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const body = applyExtraBody(
      { model: 'safe', stream: true, messages: [] },
      { model: 'bad', stream: false, top_p: 0.5 }
    )
    expect(body).toMatchObject({ model: 'safe', stream: true, top_p: 0.5 })
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('parses retry-after seconds and dates', () => {
    expect(retryAfterMs(new Headers({ 'retry-after': '2' }), 0)).toBe(2000)
    expect(retryAfterMs(new Headers({ 'retry-after': new Date(3000).toUTCString() }), 0)).toBe(3000)
  })

  it('adds bounded jitter to exponential retry delays', () => {
    expect(retryDelay(new Error('network'), 2, () => 0)).toBe(1280)
    expect(retryDelay(new Error('network'), 2, () => 1)).toBe(1920)
  })
})
