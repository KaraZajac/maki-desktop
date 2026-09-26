/**
 * Finding login and one-time-code fields, and filling them so page frameworks notice. Plain DOM:
 * no extension APIs here, so it tests without a browser.
 */

export function isVisible(el: HTMLElement): boolean {
  if (el.hidden || el.getAttribute('aria-hidden') === 'true') return false
  if (el instanceof HTMLInputElement && (el.type === 'hidden' || el.disabled)) return false
  for (let n: HTMLElement | null = el; n; n = n.parentElement) {
    const style = n.ownerDocument.defaultView?.getComputedStyle(n)
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false
  }
  return true
}

const TEXTLIKE = new Set(['text', 'email', 'tel', ''])

/** How a field describes itself, split into lowercase words: "app_otp" and "totpPin" both say otp. */
function words(input: HTMLInputElement): string {
  return [input.name, input.id, input.placeholder, input.getAttribute('aria-label') ?? '']
    .join(' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
}

const OTP_WORDS = /\b(otp|totp|2fa|mfa|one time|verification code|auth code|authentication code|two factor|2 step|two step)\b/

/** A field that wants a one-time code. Card security codes and phone numbers don't count. */
export function isOtpField(input: HTMLInputElement): boolean {
  if (input.autocomplete === 'one-time-code') return true
  if (input.autocomplete.startsWith('cc-')) return false
  if (!['text', 'tel', 'number', ''].includes(input.type)) return false
  if (input.maxLength > 10) return false
  return OTP_WORDS.test(words(input))
}

function usernameLike(input: HTMLInputElement): boolean {
  if (/username|email/.test(input.autocomplete)) return true
  return TEXTLIKE.has(input.type) && !isOtpField(input) && !input.autocomplete.startsWith('cc-')
}

export interface LoginFields {
  username: HTMLInputElement | null
  password: HTMLInputElement
}

/** Password fields you log in with (not ones for a new password), each with its username field. */
export function findLoginFields(root: ParentNode): LoginFields[] {
  const inputs = Array.from(root.querySelectorAll('input')).filter(isVisible)
  const out: LoginFields[] = []
  for (const password of inputs) {
    if (password.type !== 'password' || password.autocomplete === 'new-password') continue
    const scope = password.form ? Array.from(password.form.querySelectorAll('input')).filter(isVisible) : inputs
    const username = scope.slice(0, scope.indexOf(password)).reverse().find(usernameLike) ?? null
    out.push({ username, password })
  }
  return out
}

/** The login a submitted form carries, to offer to maki: a new password over the current one. */
export function loginToSave(form: HTMLFormElement): { username: string; password: HTMLInputElement } | null {
  const inputs = Array.from(form.querySelectorAll('input')).filter(isVisible)
  const passwords = inputs.filter((i) => i.type === 'password' && i.value)
  if (passwords.length === 0) return null
  const password = passwords.find((p) => p.autocomplete === 'new-password') ?? passwords[0]
  const username = inputs.slice(0, inputs.indexOf(passwords[0])).reverse().find(usernameLike)
  return username?.value ? { username: username.value, password } : null
}

/** Set a value the way typing would. The prototype's setter gets past React's value tracking. */
export function fill(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter) setter.call(input, value)
  else input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** A code goes in one field, or one digit per box when the page splits it into boxes. */
export function fillCode(input: HTMLInputElement, code: string): void {
  if (input.maxLength === 1) {
    const scope = input.form ?? input.parentElement?.parentElement ?? input.ownerDocument
    const boxes = Array.from(scope.querySelectorAll('input')).filter((i) => i.maxLength === 1 && isVisible(i))
    if (boxes.length === code.length) {
      boxes.forEach((box, i) => fill(box, code[i]))
      return
    }
  }
  fill(input, code)
}
