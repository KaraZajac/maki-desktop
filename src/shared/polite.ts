/**
 * Asking a public server politely: a few requests at a time, no more than so many a second, and
 * when it says to slow down (429, or 503 while it's busy), or doesn't answer, waiting before
 * asking again: as long as it says (Retry-After), or a wait that doubles each time. Everyone
 * waits then, not just the one it turned away: servers that limit requests count them all.
 */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>

export interface Manners {
  /** requests out at once */
  atOnce?: number
  /** requests started a second, at most */
  perSecond?: number
  /** tries in all, before giving up */
  tries?: number
  /** the first wait after being turned away, in ms; it doubles */
  wait?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

export function polite(
  fetcher: Fetch,
  {
    atOnce = 2,
    perSecond = Infinity,
    tries = 5,
    wait = 1000,
    sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    now = Date.now
  }: Manners = {}
): Fetch {
  let running = 0
  const waiting: (() => void)[] = []
  const turn = (): Promise<void> =>
    new Promise((go) => {
      if (running < atOnce) {
        running++
        go()
      } else {
        waiting.push(() => {
          running++
          go()
        })
      }
    })
  const done = (): void => {
    running--
    waiting.shift()?.()
  }
  // when the next request may start
  let next = 0
  const gap = 1000 / perSecond
  const pace = async (): Promise<void> => {
    const t = now()
    const at = Math.max(t, next)
    next = at + gap
    if (at > t) await sleep(at - t)
  }
  const holdEveryone = (ms: number): void => {
    next = Math.max(next, now() + ms)
  }

  return async (url, init) => {
    await turn()
    try {
      for (let i = 0; ; i++) {
        await pace()
        let res: Response
        try {
          res = await fetcher(url, init)
        } catch (e) {
          if (i + 1 >= tries) throw e
          holdEveryone(wait * 2 ** i)
          continue
        }
        if ((res.status !== 429 && res.status !== 503) || i + 1 >= tries) return res
        const after = Number(res.headers.get('retry-after'))
        holdEveryone(after > 0 ? Math.min(after, 120) * 1000 : wait * 2 ** i)
      }
    } finally {
      done()
    }
  }
}
