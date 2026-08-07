import { describe, expect, it } from 'vitest'
import { mapLimit } from './pool'

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('mapLimit', () => {
  it('limits concurrency while preserving result order', async () => {
    let active = 0
    let peak = 0
    const result = await mapLimit([30, 5, 15, 1], 2, async (delay, index) => {
      active++
      peak = Math.max(peak, active)
      await wait(delay)
      active--
      return index
    })
    expect(peak).toBe(2)
    expect(result).toEqual([0, 1, 2, 3])
  })

  it('rejects when a worker fails', async () => {
    await expect(
      mapLimit([1, 2], 2, async (item) => {
        if (item === 2) throw new Error('boom')
        return item
      })
    ).rejects.toThrow('boom')
  })
})
