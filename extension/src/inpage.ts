import { base58 } from '@scure/base'

/**
 * In the page itself (the MAIN world): maki's Ethereum provider (EIP-1193), announced the way
 * EIP-6963 says, and as `window.ethereum` when no other wallet has taken it; `window.nostr`
 * (NIP-07), likewise; and a Solana wallet, registered the Wallet Standard's way. Every request goes
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

// ---- Nostr (NIP-07): window.nostr, answered by maki's Nostr app ----
;(() => {
  const NOSTR = 'maki-nostr'
  let nextId = 1
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as {
      channel?: unknown
      to?: unknown
      id?: unknown
      result?: unknown
      error?: { message?: unknown }
    }
    if (e.source !== window || d?.channel !== NOSTR || d.to !== 'page' || typeof d.id !== 'number')
      return
    const w = waiting.get(d.id)
    if (!w) return
    waiting.delete(d.id)
    if (d.error) w.reject(new Error(String(d.error.message ?? 'maki: error')))
    else w.resolve(d.result)
  })
  const ask = (method: string, params: unknown[]): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve, reject })
      window.postMessage({ channel: NOSTR, to: 'maki', id, method, params }, '*')
    })
  const nostr = Object.freeze({
    isMaki: true,
    /** the key's public half, hex: maki asks its owner the first time a site wants it */
    getPublicKey: (): Promise<unknown> => ask('getPublicKey', []),
    /** the event with its id, pubkey and sig: maki shows it, and signs once its owner says so */
    signEvent: (event: unknown): Promise<unknown> => ask('signEvent', [event]),
    /** no relays of its own: the site's are the site's business */
    getRelays: (): Promise<unknown> => ask('getRelays', [])
  })
  // only if nothing else claims it: a signer the owner uses already keeps its place
  if (!('nostr' in window)) {
    Object.defineProperty(window, 'nostr', { value: nostr, configurable: true, writable: true })
  }
})()

// ---- Solana: a wallet as the Wallet Standard has them, answered by maki's Solana app ----
;(() => {
  const SOL = 'maki-sol'
  const CHAINS = ['solana:mainnet', 'solana:devnet'] as const
  const FEATURES = [
    'solana:signTransaction',
    'solana:signAndSendTransaction',
    'solana:signMessage'
  ] as const
  const icon = ('data:image/svg+xml;base64,' +
    btoa(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#18181b"/>' +
        '<circle cx="16" cy="16" r="8" fill="#ff7a59"/></svg>'
    )) as `data:image/svg+xml;base64,${string}`
  let nextId = 1
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  window.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as {
      channel?: unknown
      to?: unknown
      id?: unknown
      result?: unknown
      error?: { code?: unknown; message?: unknown }
    }
    if (e.source !== window || d?.channel !== SOL || d.to !== 'page' || typeof d.id !== 'number')
      return
    const w = waiting.get(d.id)
    if (!w) return
    waiting.delete(d.id)
    if (d.error)
      w.reject(
        Object.assign(new Error(String(d.error.message ?? 'maki: error')), {
          code: Number(d.error.code ?? -32603)
        })
      )
    else w.resolve(d.result)
  })
  const ask = (method: string, param: Record<string, unknown>): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve, reject })
      window.postMessage({ channel: SOL, to: 'maki', id, method, params: [param] }, '*')
    })
  const b64 = (b: Uint8Array): string => {
    let s = ''
    for (const x of b) s += String.fromCharCode(x)
    return btoa(s)
  }
  const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

  type Account = {
    address: string
    publicKey: Uint8Array
    chains: readonly string[]
    features: readonly string[]
    label: string
    icon: typeof icon
  }
  const accounts = new Map<string, Account>()
  const accountOf = (address: string): Account => {
    let a = accounts.get(address)
    if (!a) {
      a = Object.freeze({
        address,
        publicKey: base58.decode(address),
        chains: CHAINS,
        features: FEATURES,
        label: 'maki',
        icon
      })
      accounts.set(address, a)
    }
    return a
  }
  let connected: Account[] = []
  const changes = new Set<(p: { accounts: readonly Account[] }) => void>()
  const changed = (): void =>
    changes.forEach((l) => {
      try {
        l({ accounts: connected })
      } catch {
        // a site's listener failing is the site's business
      }
    })
  const mine = (account: unknown): void => {
    if (!connected.some((a) => a.address === (account as { address?: unknown } | null)?.address)) {
      throw Object.assign(new Error('that isn’t the account connected to this site'), {
        code: 4100
      })
    }
  }
  type Input = {
    account?: unknown
    transaction?: Uint8Array
    message?: Uint8Array
    chain?: string
    options?: unknown
  }

  const wallet = {
    version: '1.0.0' as const,
    name: 'maki',
    icon,
    chains: CHAINS,
    get accounts(): readonly Account[] {
      return connected
    },
    features: {
      'standard:connect': {
        version: '1.0.0',
        async connect(input?: { silent?: boolean }): Promise<{ accounts: readonly Account[] }> {
          const r = (await ask('connect', { silent: input?.silent === true })) as {
            accounts: string[]
          }
          connected = r.accounts.map(accountOf)
          changed()
          return { accounts: connected }
        }
      },
      'standard:disconnect': {
        version: '1.0.0',
        async disconnect(): Promise<void> {
          await ask('disconnect', {})
          connected = []
          changed()
        }
      },
      'standard:events': {
        version: '1.0.0',
        on(event: string, listener: (p: { accounts: readonly Account[] }) => void): () => void {
          if (event !== 'change') return () => {}
          changes.add(listener)
          return () => changes.delete(listener)
        }
      },
      'solana:signTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0] as const,
        // each on maki in turn: the owner goes through them one by one
        async signTransaction(...inputs: Input[]): Promise<{ signedTransaction: Uint8Array }[]> {
          const out = []
          for (const i of inputs) {
            mine(i.account)
            const r = (await ask('signTransaction', {
              transaction: b64(i.transaction!),
              chain: i.chain
            })) as { signedTransaction: string }
            out.push({ signedTransaction: unb64(r.signedTransaction) })
          }
          return out
        }
      },
      'solana:signAndSendTransaction': {
        version: '1.0.0',
        supportedTransactionVersions: ['legacy', 0] as const,
        async signAndSendTransaction(...inputs: Input[]): Promise<{ signature: Uint8Array }[]> {
          const out = []
          for (const i of inputs) {
            mine(i.account)
            const r = (await ask('signAndSendTransaction', {
              transaction: b64(i.transaction!),
              chain: i.chain,
              options: i.options ?? {}
            })) as {
              signature: string
            }
            out.push({ signature: base58.decode(r.signature) })
          }
          return out
        }
      },
      'solana:signMessage': {
        version: '1.0.0',
        async signMessage(
          ...inputs: Input[]
        ): Promise<
          { signedMessage: Uint8Array; signature: Uint8Array; signatureType: 'ed25519' }[]
        > {
          const out = []
          for (const i of inputs) {
            mine(i.account)
            const r = (await ask('signMessage', { message: b64(i.message!) })) as {
              signature: string
            }
            out.push({
              signedMessage: i.message!,
              signature: unb64(r.signature),
              signatureType: 'ed25519' as const
            })
          }
          return out
        }
      }
    }
  }

  // the Wallet Standard's registration: now, for apps already listening, and when an app says
  // it's ready
  const register = (api: { register: (w: typeof wallet) => unknown }): void =>
    void api.register(wallet)
  try {
    window.dispatchEvent(new CustomEvent('wallet-standard:register-wallet', { detail: register }))
  } catch {
    // an app that isn't listening yet asks later
  }
  window.addEventListener('wallet-standard:app-ready', (e: Event) =>
    register((e as CustomEvent).detail)
  )
})()

// a module, for the type checker; the bundle is a plain script either way
export {}
