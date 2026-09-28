import { describe, expect, it } from 'vitest'
import { polite } from './polite'

/** A clock that only moves when someone sleeps. */
function clock(): { now: () => number; sleep: (ms: number) => Promise<void>; slept: number[] } {
  let t = 0
  const slept: number[] = []
  return {
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms)
      t += ms
    },
    slept
  }
}

describe('asking a public server politely', () => {
  it('asks a few at a time', async () => {
    let now = 0
    let most = 0
    const slow = async (): Promise<Response> => {
      most = Math.max(most, ++now)
      await new Promise((r) => setTimeout(r, 5))
      now--
      return new Response('ok')
    }
    const get = polite(slow, { atOnce: 2 })
    const answers = await Promise.all(
      [1, 2, 3, 4, 5, 6].map((i) => get(`/${i}`).then((r) => r.text()))
    )
    expect(answers).toEqual(Array(6).fill('ok'))
    expect(most).toBe(2)
  })

  it('asks no more than so many a second', async () => {
    const c = clock()
    const started: number[] = []
    const get = polite(
      async () => {
        started.push(c.now())
        return new Response('ok')
      },
      { atOnce: 1, perSecond: 4, ...c }
    )
    for (let i = 0; i < 5; i++) await get('/x')
    expect(started).toEqual([0, 250, 500, 750, 1000])
  })

  it('waits when told to slow down, longer each time, then asks again', async () => {
    const c = clock()
    let asked = 0
    const busy = async (): Promise<Response> =>
      ++asked < 4 ? new Response('slow down', { status: 429 }) : new Response('here')
    const get = polite(busy, { wait: 100, ...c })
    expect(await (await get('/x')).text()).toBe('here')
    expect(c.slept).toEqual([100, 200, 400])
  })

  it('waits as long as the server says, and gives up in the end', async () => {
    const c = clock()
    const never = async (): Promise<Response> =>
      new Response('busy', { status: 503, headers: { 'retry-after': '3' } })
    const get = polite(never, { tries: 3, ...c })
    expect((await get('/x')).status).toBe(503)
    expect(c.slept).toEqual([3000, 3000])
  })

  it('tries again when there is no answer, then says why', async () => {
    const c = clock()
    let asked = 0
    const silent = async (): Promise<Response> => {
      if (++asked < 3) throw new Error('no answer')
      return new Response('late')
    }
    expect(await (await polite(silent, { wait: 50, ...c })('/x')).text()).toBe('late')
    const gone = polite(async () => Promise.reject(new Error('gone')), { tries: 2, ...c })
    await expect(gone('/x')).rejects.toThrow('gone')
  })
})
