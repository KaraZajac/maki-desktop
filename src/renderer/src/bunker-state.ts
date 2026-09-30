import { useEffect, useRef, useState } from 'react'
import type { Link } from '@shared/link'
import { Bunker, newState, readState, type BunkerClient } from '@shared/nip46'
import type { RelayState } from '@shared/relay'

/** What the Connections page shows of maki desktop's NIP-46 bunker, and does with it. */
export interface BunkerView {
  /** null until what's kept is read */
  on: boolean | null
  uri: string
  relays: { url: string; state: RelayState }[]
  configured: string[]
  clients: BunkerClient[]
  turn: (on: boolean) => Promise<void>
  connect: (nostrconnect: string) => Promise<BunkerClient>
  revoke: (pubkey: string) => void
  newLink: () => void
  setRelays: (urls: string[]) => void
}

/**
 * The bunker, for as long as the window's open (it's hidden, not closed, in the tray): it answers
 * apps whatever page is showing, while it's on.
 */
export function useBunker(link: Link): BunkerView {
  const [bunker, setBunker] = useState<Bunker | null>(null)
  const [on, setOn] = useState<boolean | null>(null)
  const onRef = useRef(false)
  const [, tick] = useState(0)

  useEffect(() => {
    let live = true
    void window.maki.nostr.load().then((kept) => {
      if (!live) return
      const k = kept as { on?: unknown; state?: unknown } | null
      const state = readState(k?.state) ?? newState()
      onRef.current = k?.on === true
      const save = (s: typeof state): void =>
        void window.maki.nostr.save({ on: onRef.current, state: s })
      // a new bunker's key is kept before its link is given to anyone
      if (!readState(k?.state)) save(state)
      setBunker(new Bunker(state, link.nostr, save, undefined, (line) => link.note(line)))
      setOn(onRef.current)
    })
    return () => {
      live = false
    }
  }, [link])

  useEffect(() => {
    if (!bunker) return
    const off = bunker.onChange(() => tick((n) => n + 1))
    if (on) bunker.start()
    return () => {
      off()
      bunker.stop()
    }
  }, [bunker, on])

  return {
    on,
    uri: bunker?.uri() ?? '',
    relays: bunker?.relays ?? [],
    configured: bunker?.snapshot().relays ?? [],
    clients: bunker?.clients ?? [],
    turn: async (next) => {
      onRef.current = next
      if (bunker) await window.maki.nostr.save({ on: next, state: bunker.snapshot() })
      setOn(next)
    },
    connect: (uri) =>
      bunker ? bunker.connect(uri) : Promise.reject(new Error('the bunker isn’t ready')),
    revoke: (pubkey) => bunker?.revoke(pubkey),
    newLink: () => bunker?.newLink(),
    setRelays: (urls) => bunker?.setRelays(urls)
  }
}
