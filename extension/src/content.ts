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
    default:
      return null
  }
}

let busy = false
const asked = new WeakSet<HTMLInputElement>()
/** what maki filled, so submitting it doesn't offer it back */
const filled = new WeakMap<HTMLInputElement, string>()

async function offerLogin(login: { username: HTMLInputElement | null; password: HTMLInputElement }): Promise<void> {
  busy = true
  try {
    const r = await waitingOnMaki('Approve on maki to fill this login', ask({ type: 'getLogin' }))
    if (r.ok && r.approval === 'approved') {
      if (login.username && r.username) fill(login.username, r.username)
      fill(login.password, r.password ?? '')
      filled.set(login.password, r.password ?? '')
      say('Filled by maki')
    } else if (r.ok && r.approval === 'no match') {
      hide()
    } else {
      say(trouble(r) ?? 'maki gave no login', { label: 'Ask again', run: () => void offerLogin(login) })
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

function focused(el: EventTarget | null): void {
  if (!(el instanceof HTMLInputElement) || busy || asked.has(el) || !isVisible(el)) return
  const login = findLoginFields(document).find((f) => f.password === el || f.username === el)
  if (login) {
    asked.add(login.password)
    if (login.username) asked.add(login.username)
    void offerLogin(login)
  } else if (isOtpField(el)) {
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
