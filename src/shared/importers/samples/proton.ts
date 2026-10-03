/**
 * A Proton Pass export, as Settings › Export writes one: the zip (`Proton Pass/data.json`, stored),
 * the CSV, and the PGP-encrypted kind; written for these tests from Proton Pass's documented format
 * (its export types and its Rust core's passkey serialization) with made-up logins. Its passkey is
 * MessagePack as Proton's core writes one: `{c, v}` around the passkey, its key a COSE key.
 */
import { p256 } from '@noble/curves/nist.js'
import { base64, makeZip, msgpack, testScalar } from '../samples'

/** The passkey's key and IDs, for checking what's read. */
export const PROTON_PASSKEY = {
  scalar: testScalar(21),
  credentialId: Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i),
  userHandle: new TextEncoder().encode('dXNlci0xMjM0NQ')
}

/** The passkey's `content`, as Proton's core serializes it. */
function content(): string {
  const { scalar, credentialId, userHandle } = PROTON_PASSKEY
  const pub = p256.getPublicKey(scalar, false)
  // the curve label's value, an i128 in 16 bytes, little-endian
  const one = new Uint8Array(16)
  one[0] = 1
  const inner = msgpack({
    key: {
      kty: { t: 'assign', c: 'EC2' },
      kid: [],
      alg: { t: 'assign', c: 'ES256' },
      kops: [],
      biv: [],
      par: [
        [
          { t: 'int', c: -1 },
          { t: 'int', c: { inner: one } }
        ],
        [
          { t: 'int', c: -2 },
          { t: 'bytes', c: pub.subarray(1, 33) }
        ],
        [
          { t: 'int', c: -3 },
          { t: 'bytes', c: pub.subarray(33) }
        ],
        [
          { t: 'int', c: -4 },
          { t: 'bytes', c: scalar }
        ]
      ]
    },
    cid: credentialId,
    rid: 'proton.me',
    uhd: userHandle,
    cnt: null
  })
  return base64(msgpack({ c: inner, v: 1 }))
}

/** data.json, as Proton Pass writes it. */
export function protonData(): string {
  const item = (
    id: number,
    type: string,
    name: string,
    contentOf: Record<string, unknown>,
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> => ({
    itemId: `itemId${id}==`,
    shareId: 'shareA==',
    data: {
      metadata: { name, note: '', itemUuid: `uuid${id}` },
      extraFields: [],
      type,
      content: contentOf
    },
    state: 1,
    aliasEmail: null,
    contentFormatVersion: 6,
    createTime: 1757000000 + id,
    modifyTime: 1757000100 + id,
    pinned: false,
    ...extra
  })
  return JSON.stringify({
    version: '1.31.4',
    userId: 'userA==',
    encrypted: false,
    vaults: {
      'shareA==': {
        name: 'Personal',
        description: 'Personal vault',
        display: { icon: 'icon-vault', color: 'color-blue' },
        items: [
          item(1, 'login', 'Proton', {
            itemEmail: 'kara@proton.me',
            itemUsername: '',
            password: 'lumo-lumo-lumo-9',
            urls: ['https://account.proton.me/'],
            totpUri:
              'otpauth://totp/Proton:kara%40proton.me?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=SHA1&digits=6&period=30',
            passkeys: [
              {
                keyId: 'oKGio6SlpqeoqaqrrK2urw',
                content: content(),
                domain: 'proton.me',
                rpId: 'proton.me',
                rpName: 'Proton',
                userName: 'kara@proton.me',
                userDisplayName: 'Kara',
                userId: base64(PROTON_PASSKEY.userHandle),
                createTime: 1757000001,
                note: '',
                credentialId: base64(PROTON_PASSKEY.credentialId),
                userHandle: base64(PROTON_PASSKEY.userHandle)
              }
            ]
          }),
          item(2, 'login', 'Forum', {
            itemEmail: 'kara@example.org',
            itemUsername: 'kara_z',
            password: 'f0rum-pass',
            urls: [],
            autofillUrls: [
              { url: 'https://forum.example.org/login', mode: 0 },
              { url: 'https://old-forum.example.org', mode: 2 }
            ],
            totpUri: '',
            passkeys: []
          }),
          item(3, 'alias', 'newsletter alias', {}, { aliasEmail: 'news.abc@passmail.net' }),
          item(4, 'note', 'Recovery codes', {}),
          item(
            5,
            'login',
            'Old bank',
            {
              itemEmail: '',
              itemUsername: 'kz',
              password: 'gone',
              urls: ['https://bank.example.com'],
              totpUri: '',
              passkeys: []
            },
            { state: 2 }
          ),
          item(6, 'creditCard', 'Debit card', {
            cardholderName: 'Kara Zajac',
            cardType: 0,
            number: '4000056655665556',
            verificationNumber: '123',
            expirationDate: '2030-01',
            pin: ''
          })
        ]
      }
    }
  })
}

/** The zip Proton Pass exports: data.json stored, in a folder. */
export function protonZip(): Promise<Uint8Array> {
  return makeZip([
    { name: 'Proton Pass/', data: '', stored: true },
    { name: 'Proton Pass/data.json', data: protonData(), stored: true }
  ])
}

/** The same with PGP encryption: data.pgp, armoured, in its place. */
export function protonPgpZip(): Promise<Uint8Array> {
  return makeZip([
    {
      name: 'Proton Pass/data.pgp',
      data: '-----BEGIN PGP MESSAGE-----\n\nwy4ECQMIexample+notreal\n=abcd\n-----END PGP MESSAGE-----\n',
      stored: true
    }
  ])
}

/** Proton Pass's CSV, its 2024 to 2026 header. */
export const PROTON_CSV = [
  'type,name,url,email,username,password,note,totp,createTime,modifyTime,vault',
  'login,Proton,https://account.proton.me/,kara@proton.me,,lumo-lumo-lumo-9,,otpauth://totp/Proton:kara?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ,1757000001,1757000101,Personal',
  'login,Forum,"https://forum.example.org/login, https://forum.example.org/",kara@example.org,kara_z,f0rum-pass,,,1757000002,1757000102,Personal',
  'alias,newsletter alias,,news.abc@passmail.net,,,,,1757000003,1757000103,Personal',
  'creditCard,Debit card,,,,,"{""number"":""4000056655665556""}",,1757000006,1757000106,Personal'
].join('\r\n')
