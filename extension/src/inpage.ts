/**
 * In the page itself (the MAIN world): maki's Ethereum provider (EIP-1193), announced the way
 * EIP-6963 says, and as `window.ethereum` when no other wallet has taken it. Every request goes
 * to maki's content script, then the background, which adds the page's site as the browser
 * reports it, then maki desktop; whatever needs the account asks the owner on maki's screen.
 */

type Listener = (...args: unknown[]) => void

const CHANNEL = 'maki-eth'
const ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#18181b"/>' +
      '<circle cx="16" cy="16" r="8" fill="#ff7a59"/></svg>'
  )

;(() => {
  let nextId = 1
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  const listeners = new Map<string, Set<Listener>>()

  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as {
      channel?: unknown
      to?: unknown
      id?: unknown
      result?: unknown
      error?: { code?: unknown; message?: unknown }
    }
    if (
      e.source !== window ||
      d?.channel !== CHANNEL ||
      d.to !== 'page' ||
      typeof d.id !== 'number'
    )
      return
    const w = waiting.get(d.id)
    if (!w) return
    waiting.delete(d.id)
    if (d.error) {
      w.reject(
        Object.assign(new Error(String(d.error.message ?? 'maki: error')), {
          code: Number(d.error.code ?? -32603)
        })
      )
    } else {
      w.resolve(d.result)
    }
  })

  const emit = (event: string, ...args: unknown[]): void =>
    listeners.get(event)?.forEach((l) => {
      try {
        l(...args)
      } catch {
        // a site's listener failing is the site's business
      }
    })

  const ask = (method: string, params: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve, reject })
      window.postMessage({ channel: CHANNEL, to: 'maki', id, method, params }, '*')
    })

  const provider = {
    isMaki: true,
    async request(args: { method?: unknown; params?: unknown }): Promise<unknown> {
      if (!args || typeof args.method !== 'string') {
        throw Object.assign(new Error('request takes { method, params }'), { code: -32600 })
      }
      const params = Array.isArray(args.params)
        ? args.params
        : args.params === undefined
          ? []
          : [args.params]
      const result = await ask(args.method, params)
      // the changes a site listens for
      if (args.method === 'eth_requestAccounts') emit('accountsChanged', result)
      if (
        args.method === 'wallet_switchEthereumChain' ||
        args.method === 'wallet_addEthereumChain'
      ) {
        emit('chainChanged', await ask('eth_chainId', []))
      }
      return result
    },
    on(event: string, listener: Listener) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(listener)
      return provider
    },
    removeListener(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener)
      return provider
    },
    /** for sites from before EIP-1193 */
    enable(): Promise<unknown> {
      return provider.request({ method: 'eth_requestAccounts' })
    }
  }

  const info = Object.freeze({
    uuid: crypto.randomUUID(),
    name: 'maki',
    icon: ICON,
    rdns: 'com.leviathan.maki'
  })
  const announce = (): void => {
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) })
    )
  }
  window.addEventListener('eip6963:requestProvider', announce)
  announce()
  // the old way, only if nothing else claims it: another wallet the owner uses keeps its place
  if (!('ethereum' in window)) {
    Object.defineProperty(window, 'ethereum', {
      value: provider,
      configurable: true,
      writable: true
    })
  }
})()

// a module, for the type checker; the bundle is a plain script either way
export {}
