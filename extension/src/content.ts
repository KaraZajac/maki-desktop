import { ext } from './api'
import { fill, fillCode, findLoginFields, isOtpField, isVisible, loginToSave } from './forms'

/**
 * On the page. Focus a login or code field and this asks maki, through the background script and
 * maki desktop; approve on maki and it fills. Submit a login maki didn't fill and maki offers to
 * keep it. The decision is always made on maki's screen: the notices here only say what's going on.
 */

type Reply = { ok: boolean; error?: string; approval?: string; username?: string; password?: string; code?: string }

function ask(message: object): Promise<Reply> {
  return (ext.runtime.sendMessage(message) as Promise<Reply>).catch((e: Error) => ({ ok: false, error: e.message }))
}

// ---- a notice, in a closed shadow root so the page's styles and scripts stay out of it ----
let notice: { host: HTMLElement; text: HTMLElement; button: HTMLButtonElement } | null = null
let hideTimer: ReturnType<typeof setTimeout> | undefined
function say(message: string, action?: { label: string; run: () => void }, ms = 4000): void {
  if (!notice) {
    const host = document.createElement('maki-notice')
    const shadow = host.attachShadow({ mode: 'closed' })
    shadow.innerHTML = `<style>
      .n{position:fixed;top:16px;right:16px;z-index:2147483647;display:flex;gap:10px;align-items:center;
         font:13px/1.3 system-ui,sans-serif;color:#e4e4e7;background:#18181b;border:1px solid #3f3f46;
         border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,.35)}
      .d{flex:none;width:10px;height:10px;border-radius:50%;background:#ff7a59}
      button{font:inherit;color:#18181b;background:#f4f4f5;border:0;border-radius:6px;padding:4px 10px;cursor:pointer}
    </style><div class="n" role="status"><span class="d"></span><span class="t"></span><button hidden></button></div>`
    notice = { host, text: shadow.querySelector('.t')!, button: shadow.querySelector('button')! }
  }
  notice.text.textContent = message
  notice.button.hidden = !action
  notice.button.textContent = action?.label ?? ''
  notice.button.onclick = action ? () => (hide(), action.run()) : null
  if (!notice.host.isConnected) document.documentElement.append(notice.host)
  clearTimeout(hideTimer)
  if (ms > 0) hideTimer = setTimeout(hide, ms)
}
function hide(): void {
  clearTimeout(hideTimer)
  notice?.host.remove()
}

/** Say "approve on maki" only if maki is actually asking: no flash when there's nothing saved. */
async function waitingOnMaki(message: string, request: Promise<Reply>): Promise<Reply> {
  const timer = setTimeout(() => say(message, undefined, 0), 250)
  const r = await request
  clearTimeout(timer)
  return r
}

function trouble(r: Reply): string | null {
  if (!r.ok) return `maki: ${r.error ?? 'unavailable'}`
  switch (r.approval) {
    case 'denied':
      return 'Refused on maki'
    case 'timed out':
      return 'Nobody approved on maki in time'
    case 'unavailable':
      return 'maki can’t reach its vault right now'
    case 'clock not verified':
      return 'maki’s clock isn’t verified yet, so it can’t make a code'
    case 'locked':
      return 'maki is locked: enter your PIN on maki'
    default:
      return null
  }
}

let busy = false
const asked = new WeakSet<HTMLInputElement>()
/** what maki filled, so submitting it doesn't offer it back */
const filled = new WeakMap<HTMLInputElement, string>()

async function offerLogin(
  login: { username: HTMLInputElement | null; password: HTMLInputElement },
  evenWithPasskey = false
): Promise<void> {
  busy = true
  try {
    const request = evenWithPasskey ? { type: 'getLogin', evenWithPasskey: true } : { type: 'getLogin' }
    const r = await waitingOnMaki('Approve on maki to fill this login', ask(request))
    if (r.ok && r.approval === 'approved') {
      if (login.username && r.username) fill(login.username, r.username)
      fill(login.password, r.password ?? '')
      filled.set(login.password, r.password ?? '')
      say('Filled by maki')
    } else if (r.ok && r.approval === 'no match') {
      hide()
    } else if (r.ok && r.approval === 'passkey') {
      // the site's own passkey sign-in is the way in; the password only if the owner wants it
      say(
        'maki has a passkey for this site: sign in with it',
        { label: 'Use password', run: () => void offerLogin(login, true) },
        10000
      )
    } else {
      const again = () => void offerLogin(login, evenWithPasskey)
      say(trouble(r) ?? 'maki gave no login', { label: 'Ask again', run: again })
    }
  } finally {
    busy = false
  }
}

async function offerCode(input: HTMLInputElement): Promise<void> {
  busy = true
  try {
    const r = await waitingOnMaki('Approve on maki for a code', ask({ type: 'getTotp' }))
    if (r.ok && r.approval === 'approved' && r.code) {
      fillCode(input, r.code)
      say('Code filled by maki')
    } else if (r.ok && r.approval === 'no match') {
      hide()
    } else {
      say(trouble(r) ?? 'maki gave no code', { label: 'Ask again', run: () => void offerCode(input) })
    }
  } finally {
    busy = false
  }
}

/**
 * Whether the field is there to see where it is: big enough, in the window, and not made
 * transparent. A page's script could otherwise put a login form nobody sees on it, focus it, and
 * read what maki fills.
 */
function onScreen(el: HTMLElement): boolean {
  const r = el.getBoundingClientRect()
  if (r.width < 4 || r.height < 4) return false
  if (r.bottom <= 0 || r.right <= 0 || r.top >= window.innerHeight || r.left >= window.innerWidth) return false
  let opacity = 1
  for (let n: Element | null = el; n; n = n.parentElement) opacity *= Number(getComputedStyle(n).opacity || 1)
  return opacity >= 0.1
}

/** Whether the owner did something just now (a click, a tap, a key): a page focusing a field by itself isn't them. */
function byOwner(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
  return activation ? activation.isActive : true
}

function focused(el: EventTarget | null): void {
  if (!(el instanceof HTMLInputElement) || busy || asked.has(el) || !isVisible(el) || !onScreen(el)) return
  const login = findLoginFields(document).find((f) => f.password === el || f.username === el)
  const code = !login && isOtpField(el)
  if (!login && !code) return
  // focused by the page itself (autofocus, a script): maki asks once the owner says so, here
  if (!byOwner()) {
    say(login ? 'maki can fill this login' : 'maki can fill this code', {
      label: 'Fill from maki',
      run: () => focused(el)
    })
    return
  }
  if (login) {
    asked.add(login.password)
    if (login.username) asked.add(login.username)
    void offerLogin(login)
  } else {
    asked.add(el)
    void offerCode(el)
  }
}

document.addEventListener('focusin', (e) => focused(e.target), true)
focused(document.activeElement) // a field the page focused before this script ran

// a login typed by hand: maki offers to keep it, once per page
let offered = false
document.addEventListener(
  'submit',
  (e) => {
    if (offered || !(e.target instanceof HTMLFormElement)) return
    const login = loginToSave(e.target)
    if (!login || filled.get(login.password) === login.password.value) return
    offered = true
    const request = ask({ type: 'saveLogin', username: login.username, password: login.password.value })
    void waitingOnMaki('Keep this login? Decide on maki', request).then((r) =>
      r.ok && r.approval === 'approved' ? say('Kept on maki') : say(trouble(r) ?? 'Not kept')
    )
  },
  true
)

// ---- Nostr: the page's window.nostr (inpage.ts) asks through here, and hears back ----
window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data as { channel?: unknown; to?: unknown; id?: unknown; method?: unknown; params?: unknown }
  if (e.source !== window || d?.channel !== 'maki-nostr' || d.to !== 'maki') return
  if (typeof d.id !== 'number' || typeof d.method !== 'string' || !Array.isArray(d.params)) return
  const id = d.id
  void (ext.runtime.sendMessage({ type: 'nostr', method: d.method, params: d.params }) as Promise<EthReply>)
    .catch((err: Error) => ({ ok: false, error: err.message }) as EthReply)
    .then((r) => {
      const answer = r.ok ? (r.error ? { error: r.error } : { result: r.result ?? null }) : { error: { message: `maki: ${String(r.error ?? 'unavailable')}` } }
      window.postMessage({ channel: 'maki-nostr', to: 'page', id, ...answer }, '*')
    })
})

// ---- Solana: the page's wallet (inpage.ts) asks through here, and hears back ----
window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data as { channel?: unknown; to?: unknown; id?: unknown; method?: unknown; params?: unknown }
  if (e.source !== window || d?.channel !== 'maki-sol' || d.to !== 'maki') return
  if (typeof d.id !== 'number' || typeof d.method !== 'string' || !Array.isArray(d.params)) return
  const id = d.id
  void (ext.runtime.sendMessage({ type: 'sol', method: d.method, params: d.params }) as Promise<EthReply>)
    .catch((err: Error) => ({ ok: false, error: err.message }) as EthReply)
    .then((r) => {
      const answer = r.ok
        ? r.error
          ? { error: r.error }
          : { result: r.result ?? null }
        : { error: { code: 4900, message: `maki: ${String(r.error ?? 'unavailable')}` } }
      window.postMessage({ channel: 'maki-sol', to: 'page', id, ...answer }, '*')
    })
})

// ---- Ethereum: the page's provider (inpage.ts) asks through here, and hears back ----
type EthReply = { ok: boolean; error?: unknown; result?: unknown }
window.addEventListener('message', (e: MessageEvent) => {
  const d = e.data as { channel?: unknown; to?: unknown; id?: unknown; method?: unknown; params?: unknown }
  if (e.source !== window || d?.channel !== 'maki-eth' || d.to !== 'maki') return
  if (typeof d.id !== 'number' || typeof d.method !== 'string' || !Array.isArray(d.params)) return
  const id = d.id
  void (ext.runtime.sendMessage({ type: 'eth', method: d.method, params: d.params }) as Promise<EthReply>)
    .catch((err: Error) => ({ ok: false, error: err.message }) as EthReply)
    .then((r) => {
      // a provider error from maki desktop is { code, message }; anything else, maki is out of reach
      const answer = r.ok
        ? r.error
          ? { error: r.error }
          : { result: r.result ?? null }
        : { error: { code: 4900, message: `maki: ${String(r.error ?? 'unavailable')}` } }
      window.postMessage({ channel: 'maki-eth', to: 'page', id, ...answer }, '*')
    })
})
