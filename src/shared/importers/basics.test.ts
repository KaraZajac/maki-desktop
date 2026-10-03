import { p256 } from '@noble/curves/nist.js'
import { describe, expect, it } from 'vitest'
import { readCsv, rowReader } from './csv'
import { fromCose, fromJwk, fromPem, fromPkcs8, privateScalar } from './keys'
import { memoryFile } from './model'
import { fromBase32, readCode } from './otp'
import { concat, ed25519Pkcs8, jwk, makeZip, pem, pkcs8, testScalar } from './samples'
import { hostOf, rpIdOf, siteOf } from './site'
import { decodeText, fromBase64Any, label, toBase64Url } from './text'
import { readXml } from './xml'
import { Zip } from './zip'

describe('CSV', () => {
  it('reads quotes, doubled quotes, line breaks in fields, and CRLF', () => {
    const csv = readCsv(
      'name,url,note\r\n"a, b","https://x.com","line one\r\nline ""two"""\r\nc,d,e\r\n'
    )
    expect(csv.rows).toEqual([
      ['name', 'url', 'note'],
      ['a, b', 'https://x.com', 'line one\r\nline "two"'],
      ['c', 'd', 'e']
    ])
    expect(csv.lines).toEqual([1, 2, 4])
  })
  it('finds semicolons and tabs, skips empty lines, and keeps a stray quote', () => {
    expect(readCsv('a;b;c\n1;2;3').separator).toBe(';')
    expect(readCsv('a\tb\n1\t2').rows).toEqual([
      ['a', 'b'],
      ['1', '2']
    ])
    const csv = readCsv('﻿a,b\n\n1,pa"ss\n')
    expect(csv.rows).toEqual([
      ['a', 'b'],
      ['1', 'pa"ss']
    ])
    expect(csv.lines).toEqual([1, 3])
  })
  it('finds columns by name, whatever their case and spacing', () => {
    const get = rowReader(['Login URI', 'login_username'])
    expect(get(['x', 'y'], 'login_uri')).toBe('x')
    expect(get(['x', 'y'], 'Login Username')).toBe('y')
    expect(get(['x'], 'login_username')).toBe('')
  })
})

describe('text', () => {
  it('decodes UTF-8, UTF-16 by its mark, and Windows-1252 when it isn’t UTF-8', () => {
    expect(decodeText(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61))).toEqual({
      text: 'a',
      encoding: 'UTF-8'
    })
    expect(decodeText(Uint8Array.of(0xff, 0xfe, 0x61, 0))).toEqual({
      text: 'a',
      encoding: 'UTF-16'
    })
    expect(decodeText(Uint8Array.of(0x63, 0x61, 0x66, 0xe9))).toEqual({
      text: 'café',
      encoding: 'Windows-1252'
    })
  })
  it('reads base64 and base64url alike', () => {
    expect(fromBase64Any('-_8')).toEqual(Uint8Array.of(0xfb, 0xff))
    expect(fromBase64Any('+/8=')).toEqual(Uint8Array.of(0xfb, 0xff))
    expect(fromBase64Any('a')).toBeNull()
    expect(toBase64Url(Uint8Array.of(0xfb, 0xff))).toBe('-_8')
  })
  it('makes labels: line breaks a space, cut on a character’s edge', () => {
    expect(label(' GitHub\n(work) ')).toBe('GitHub (work)')
    expect(new TextEncoder().encode(label('é'.repeat(200))).length).toBe(254)
  })
})

describe('XML', () => {
  it('reads elements, attributes, entities and CDATA', () => {
    const x = readXml(
      '<?xml version="1.0"?>\n<!-- a comment --><A b="1 &amp; 2"><C>x &lt; y &#x263A;</C><D><![CDATA[<raw>]]></D><E/></A>'
    )
    expect(x.name).toBe('A')
    expect(x.attrs).toEqual({ b: '1 & 2' })
    expect(x.children.map((c) => [c.name, c.text])).toEqual([
      ['C', 'x < y ☺'],
      ['D', '<raw>'],
      ['E', '']
    ])
  })
  it('refuses what isn’t well-formed', () => {
    expect(() => readXml('<A><B></A>')).toThrow('</A> closes <B>')
    expect(() => readXml('<A>')).toThrow('never closed')
  })
})

describe('sites', () => {
  it('takes the host, as maki compares it', () => {
    expect(hostOf('https://www.GitHub.com/login?x=1')).toEqual({ host: 'github.com' })
    expect(hostOf('github.com:8443/login')).toEqual({ host: 'github.com' })
    expect(hostOf('http://192.168.1.1/admin')).toEqual({ host: '192.168.1.1' })
    expect(hostOf('https://bücher.de/')).toEqual({ host: 'xn--bcher-kva.de' })
    expect(hostOf('https://www.com')).toEqual({ host: 'www.com' })
    expect(hostOf('androidapp://com.github.android')).toBeNull()
    expect(hostOf('GitHub')).toEqual({ why: '“GitHub” isn’t a web address' })
    expect(hostOf('http://localhost:3000')).toEqual({
      why: 'localhost has no dot in it, and maki offers logins only for a domain name or an IPv4 address'
    })
    expect(hostOf('https://[::1]/')).toMatchObject({ why: expect.stringContaining('IPv6') })
    expect(hostOf('kara@gmail.com')).toEqual({ why: '“kara@gmail.com” isn’t a web address' })
    expect(hostOf('https://my_router.lan')).toMatchObject({
      why: expect.stringContaining('isn’t a web address')
    })
  })
  it('takes the first website of several, and says what else it was for', () => {
    expect(
      siteOf([
        'androidapp://com.github.android',
        'https://github.com',
        'https://gist.github.com',
        'https://github.com/x'
      ])
    ).toEqual({
      site: 'github.com',
      others: ['androidapp://com.github.android', 'gist.github.com']
    })
    expect(siteOf([])).toEqual({ why: 'no site' })
    expect(siteOf(['', ' '])).toEqual({ why: 'no site' })
    expect(siteOf(['iosapp://com.example'])).toEqual({
      why: 'no website, only iosapp://com.example'
    })
  })
  it('keeps a passkey’s relying party as it is, www and all', () => {
    expect(rpIdOf('www.example.com')).toBe('www.example.com')
    expect(rpIdOf('Example.COM')).toBe('example.com')
    expect(rpIdOf('münchen.de')).toBe('xn--mnchen-3ya.de')
    expect(rpIdOf('not a host')).toBeNull()
  })
})

describe('codes', () => {
  const fallback = { issuer: 'Fallback', account: 'someone' }
  it('reads otpauth URIs, with their parameters and label', () => {
    const r = readCode(
      'otpauth://totp/ACME%20Co:john@example.com?secret=HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ&issuer=ACME%20Co&algorithm=SHA256&digits=8&period=60',
      fallback
    )
    expect(r).toEqual({
      code: {
        issuer: 'ACME Co',
        account: 'john@example.com',
        secret: fromBase32('HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ'),
        algorithm: 2,
        digits: 8,
        period: 60
      }
    })
  })
  it('reads bare base32 secrets, spaced and lowercase, with the entry’s names', () => {
    const r = readCode('jbsw y3dp ehpk 3pxp', fallback)
    expect(r).toEqual({
      code: {
        issuer: 'Fallback',
        account: 'someone',
        secret: fromBase32('JBSWY3DPEHPK3PXP'),
        algorithm: 1,
        digits: 6,
        period: 30
      }
    })
    expect(fromBase32('JBSWY3DPEHPK3PXP')).toEqual(
      Uint8Array.of(0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef)
    )
  })
  it('says why a code isn’t one maki makes', () => {
    expect(readCode('steam://ABCDEFGHIJKLMNOP', fallback)).toEqual({
      why: 'a Steam Guard code, which isn’t RFC 6238’s'
    })
    expect(
      readCode('otpauth://totp/Steam:me?secret=JBSWY3DPEHPK3PXP&encoder=steam', fallback)
    ).toEqual({
      why: 'a Steam Guard code, which isn’t RFC 6238’s'
    })
    expect(readCode('otpauth://hotp/x?secret=JBSWY3DPEHPK3PXP&counter=1', fallback)).toEqual({
      why: 'a counter-based code (HOTP), where maki’s are time-based (TOTP)'
    })
    expect(readCode('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&algorithm=MD5', fallback)).toEqual({
      why: 'a code made with MD5, where maki’s use SHA-1, SHA-256 or SHA-512'
    })
    expect(readCode('otpauth://totp/x?secret=JBSWY3DPEHPK3PXP&digits=5', fallback)).toEqual({
      why: 'a code of 5 digits, where maki’s have 6 to 8'
    })
    expect(readCode('otpauth://totp/x?secret=JBSWY3DP', fallback)).toEqual({
      why: 'a code whose secret is 5 bytes, shorter than the 10 maki takes'
    })
    expect(readCode('not base32!', fallback)).toEqual({ why: 'a code whose secret isn’t base32' })
  })
})

describe('passkeys’ keys', () => {
  const d = testScalar(1)
  it('come out of PKCS#8, PEM (PKCS#8 and SEC 1), JWK and COSE alike', () => {
    expect(fromPkcs8(pkcs8(d))).toEqual({ scalar: d })
    expect(fromPem(pem(pkcs8(d)))).toEqual({ scalar: d })
    // SEC 1: the inner ECPrivateKey, with its curve named
    const pub = p256.getPublicKey(d, false)
    const sec1 = concat([
      Uint8Array.of(0x30, 0x77, 0x02, 0x01, 0x01, 0x04, 0x20),
      d,
      Uint8Array.of(
        0xa0,
        0x0a,
        0x06,
        0x08,
        0x2a,
        0x86,
        0x48,
        0xce,
        0x3d,
        0x03,
        0x01,
        0x07,
        0xa1,
        0x44,
        0x03,
        0x42,
        0x00
      ),
      pub
    ])
    expect(fromPem(pem(sec1, 'EC PRIVATE KEY'))).toEqual({ scalar: d })
    expect(fromJwk(jwk(d))).toEqual({ scalar: d })
    const cose = concat([
      Uint8Array.of(0xa6, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20),
      pub.subarray(1, 33),
      Uint8Array.of(0x22, 0x58, 0x20),
      pub.subarray(33),
      Uint8Array.of(0x23, 0x58, 0x20),
      d
    ])
    expect(fromCose(cose)).toEqual({ scalar: d })
    expect(privateScalar({ pkcs8: pkcs8(d) })).toEqual({ scalar: d })
  })
  it('read WebCrypto’s own PKCS#8', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign'
    ])) as unknown as { privateKey: Parameters<typeof crypto.subtle.exportKey>[1] }
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))
    const got = fromPkcs8(der)
    expect('scalar' in got && got.scalar.length).toBe(32)
    // and what's made here, WebCrypto takes
    await crypto.subtle.importKey(
      'pkcs8',
      pkcs8(d) as Uint8Array<ArrayBuffer>,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    )
  })
  it('names a key of another kind, and catches a damaged one', () => {
    expect(fromPkcs8(ed25519Pkcs8(new Uint8Array(32).fill(3)))).toEqual({
      why: 'an EdDSA (Ed25519) passkey, and maki’s passkeys are ES256 (P-256) alone'
    })
    expect(fromJwk({ kty: 'RSA', n: 'x', e: 'AQAB', d: 'y' })).toEqual({
      why: 'an RS256 (RSA) passkey, and maki’s passkeys are ES256 (P-256) alone'
    })
    const damaged = pkcs8(d)
    damaged[damaged.length - 1] ^= 1 // its public key, a bit off
    expect(fromPkcs8(damaged)).toEqual({
      why: 'a passkey whose private key doesn’t match its public key (a damaged file)'
    })
    expect(fromPkcs8(Uint8Array.of(1, 2, 3))).toEqual({ why: 'a passkey whose key can’t be read' })
    const outOfRange = pkcs8(d)
    outOfRange.fill(0xff, 36, 68) // the scalar, past the curve's order
    expect(fromPkcs8(outOfRange)).toEqual({ why: 'a passkey whose key isn’t a valid P-256 key' })
  })
})

describe('zips', () => {
  it('lists and takes out stored and deflated files, checking each', async () => {
    const big = 'x'.repeat(100_000)
    const bytes = await makeZip([
      { name: 'Proton Pass/data.json', data: '{"a":1}' },
      { name: 'files/big.txt', data: big },
      { name: 'stored.csv', data: 'a,b', stored: true }
    ])
    const zip = await Zip.open(memoryFile('export.zip', bytes))
    expect(zip.entries.map((e) => e.name)).toEqual([
      'Proton Pass/data.json',
      'files/big.txt',
      'stored.csv'
    ])
    expect(new TextDecoder().decode(await zip.read(zip.find('data.json')!))).toBe('{"a":1}')
    expect((await zip.read(zip.entries[1])).length).toBe(100_000)
    expect(new TextDecoder().decode(await zip.read(zip.find('stored.csv')!))).toBe('a,b')
    // a bit flipped in the deflated data: refused, not read wrong
    const broken = bytes.slice()
    broken[53] ^= 0xff // inside the first file’s deflated bytes
    const z2 = await Zip.open(memoryFile('broken.zip', broken))
    await expect(z2.read(z2.entries[0])).rejects.toThrow(/damaged/)
  })
})
