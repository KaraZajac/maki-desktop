// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest'
import { fill, fillCode, findLoginFields, isOtpField, loginToSave } from './forms'

const $ = <T extends Element = HTMLInputElement>(sel: string): T => document.querySelector<T>(sel)!

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('login fields', () => {
  it('pairs a password with the username field before it', () => {
    document.body.innerHTML = `<form>
      <input type="search" name="q">
      <input type="email" id="user">
      <input type="password" id="pw">
    </form>`
    expect(findLoginFields(document)).toEqual([{ username: $('#user'), password: $('#pw') }])
  })

  it('handles a password-only step, and skips hidden and new-password fields', () => {
    document.body.innerHTML = `
      <div style="display:none"><input type="password" id="decoy"></div>
      <form><input type="password" autocomplete="new-password"></form>
      <form><input type="password" id="pw"></form>`
    expect(findLoginFields(document)).toEqual([{ username: null, password: $('#pw') }])
  })

  it('does not mistake a code field for the username', () => {
    document.body.innerHTML = `<form>
      <input type="text" id="user" autocomplete="username">
      <input type="text" name="otp_code" autocomplete="one-time-code">
      <input type="password" id="pw">
    </form>`
    expect(findLoginFields(document)[0].username).toBe($('#user'))
  })
})

describe('code fields', () => {
  it.each([
    ['<input autocomplete="one-time-code">', true],
    ['<input type="tel" name="totpPin">', true], // camelCase
    ['<input type="text" name="app_otp">', true], // snake_case
    ['<input type="text" aria-label="Verification code" maxlength="6">', true],
    ['<input type="text" name="securityCode" autocomplete="cc-csc">', false], // a card's CVC
    ['<input type="tel" name="phone">', false],
    ['<input type="text" name="otp_note" maxlength="200">', false],
    ['<input type="password" name="otp">', false]
  ])('%s → %s', (html, want) => {
    document.body.innerHTML = html
    expect(isOtpField($('input'))).toBe(want)
  })

  it('spreads a code across one-digit boxes', () => {
    document.body.innerHTML = `<form>${'<input maxlength="1" inputmode="numeric">'.repeat(6)}</form>`
    const boxes = Array.from(document.querySelectorAll('input'))
    fillCode(boxes[0], '123456')
    expect(boxes.map((b) => b.value).join('')).toBe('123456')
  })
})

describe('filling', () => {
  it('sets the value past a framework’s own setter and says so with input and change events', () => {
    document.body.innerHTML = '<input id="f">'
    const input = $('#f')
    // React keeps its own setter on the element, to track what it set; a fill must not go through it
    let trackerSaw: string | null = null
    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!
    Object.defineProperty(input, 'value', {
      configurable: true,
      get: () => proto.get!.call(input),
      set: (v: string) => {
        trackerSaw = v
        proto.set!.call(input, v)
      }
    })
    const events: string[] = []
    input.addEventListener('input', () => events.push('input'))
    input.addEventListener('change', () => events.push('change'))
    fill(input, 'kara')
    expect(input.value).toBe('kara')
    expect(trackerSaw).toBeNull()
    expect(events).toEqual(['input', 'change'])
  })
})

describe('offering a login to keep', () => {
  it('takes the username and, on a sign-up or change form, the new password', () => {
    document.body.innerHTML = `<form>
      <input type="email" id="u" value="kara@example.com">
      <input type="password" autocomplete="current-password" value="old">
      <input type="password" autocomplete="new-password" id="new" value="new">
    </form>`
    expect(loginToSave($<HTMLFormElement>('form'))).toEqual({ username: 'kara@example.com', password: $('#new') })
  })

  it('takes the new password on a change form that doesn’t say which is new', () => {
    // current, new, and the new one again: the one typed twice
    document.body.innerHTML = `<form><input id="u" value="kara@example.com">
      <input type="password" id="cur" value="old one"><input type="password" id="new" value="new one">
      <input type="password" id="again" value="new one"></form>`
    expect(loginToSave($<HTMLFormElement>('form'))).toEqual({ username: 'kara@example.com', password: $('#new') })
    // current and new: the last
    document.body.innerHTML = `<form><input id="u" value="kara@example.com">
      <input type="password" id="cur" value="old one"><input type="password" id="new" value="new one"></form>`
    expect(loginToSave($<HTMLFormElement>('form'))).toEqual({ username: 'kara@example.com', password: $('#new') })
  })

  it('offers nothing without a username', () => {
    document.body.innerHTML = '<form><input type="password" value="pw"></form>'
    expect(loginToSave($<HTMLFormElement>('form'))).toBeNull()
  })
})
