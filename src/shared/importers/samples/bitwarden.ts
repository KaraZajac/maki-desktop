/**
 * A Bitwarden export, as its "Export vault" writes one (`.json`, and `.csv`), written for these
 * tests from Bitwarden's documented format (bitwarden.com/help/condition-bitwarden-import/) with
 * made-up logins: a login with a code and a passkey, one with a Steam code, one for an app and a
 * site, a card, a secure note, an identity.
 */
import { argon2id } from '@noble/hashes/argon2.js'
import { expand } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { pkcs8, testScalar } from '../samples'
import { toBase64Url } from '../text'

/** The passkey's key and IDs, for checking what's read. */
export const BITWARDEN_PASSKEY = {
  scalar: testScalar(7),
  credentialGuid: 'e8d88789-e916-e196-3cbd-81dafae71bbc',
  credentialBytes: Uint8Array.from([
    0xe8, 0xd8, 0x87, 0x89, 0xe9, 0x16, 0xe1, 0x96, 0x3c, 0xbd, 0x81, 0xda, 0xfa, 0xe7, 0x1b, 0xbc
  ]),
  userHandle: Uint8Array.from([0x6b, 0x61, 0x72, 0x61, 0x2d, 0x7a, 0x61, 0x6a, 0x61, 0x63])
}

/** The items, as Bitwarden's JSON has them. */
function items(): unknown[] {
  return [
    {
      passwordHistory: null,
      revisionDate: '2026-08-14T19:02:11.123Z',
      creationDate: '2025-03-02T10:11:12.000Z',
      deletedDate: null,
      id: '0f6b2a43-8a8e-4a5b-9f6e-b1a700a1c001',
      organizationId: null,
      folderId: null,
      type: 1,
      reprompt: 0,
      name: 'GitHub',
      notes: null,
      favorite: true,
      login: {
        fido2Credentials: [
          {
            credentialId: BITWARDEN_PASSKEY.credentialGuid,
            keyType: 'public-key',
            keyAlgorithm: 'ECDSA',
            keyCurve: 'P-256',
            keyValue: toBase64Url(pkcs8(BITWARDEN_PASSKEY.scalar)),
            rpId: 'github.com',
            userHandle: toBase64Url(BITWARDEN_PASSKEY.userHandle),
            userName: 'kara',
            counter: '0',
            rpName: 'GitHub',
            userDisplayName: 'Kara Zajac',
            discoverable: 'true',
            creationDate: '2026-01-20T08:30:00.000Z'
          }
        ],
        uris: [
          { match: null, uri: 'https://github.com/login' },
          { match: null, uri: 'https://gist.github.com/' }
        ],
        username: 'kara',
        password: 'correct horse battery staple',
        totp: 'otpauth://totp/GitHub:kara?secret=JBSWY3DPEHPK3PXP&issuer=GitHub'
      },
      collectionIds: null
    },
    {
      passwordHistory: null,
      revisionDate: '2026-07-01T12:00:00.000Z',
      creationDate: '2024-11-30T09:00:00.000Z',
      deletedDate: null,
      id: '0f6b2a43-8a8e-4a5b-9f6e-b1a700a1c002',
      organizationId: null,
      folderId: null,
      type: 1,
      reprompt: 0,
      name: 'Steam',
      notes: null,
      favorite: false,
      login: {
        fido2Credentials: [],
        uris: [{ match: null, uri: 'https://store.steampowered.com/login/' }],
        username: 'kara_plays',
        password: 'w1nter-is-c0ming',
        totp: 'steam://VGHTMJRUGQYDCMBS'
      },
      collectionIds: null
    },
    {
      passwordHistory: null,
      revisionDate: '2026-02-10T14:00:00.000Z',
      creationDate: '2023-05-05T05:05:05.000Z',
      deletedDate: null,
      id: '0f6b2a43-8a8e-4a5b-9f6e-b1a700a1c003',
      organizationId: null,
      folderId: null,
      type: 1,
      reprompt: 0,
      name: 'Mastodon',
      notes: 'the fediverse one',
      favorite: false,
      login: {
        uris: [
          { match: null, uri: 'androidapp://org.joinmastodon.android' },
          { match: 0, uri: 'https://mastodon.social' }
        ],
        username: 'kara@mastodon.social',
        password: 'tooting-along-42',
        totp: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
      },
      collectionIds: null
    },
    {
      passwordHistory: null,
      revisionDate: '2026-02-10T14:00:00.000Z',
      creationDate: '2023-05-05T05:05:05.000Z',
      deletedDate: null,
      id: '0f6b2a43-8a8e-4a5b-9f6e-b1a700a1c004',
      organizationId: null,
      folderId: null,
      type: 3,
      reprompt: 0,
      name: 'Visa',
      notes: null,
      favorite: false,
      card: {
        cardholderName: 'Kara Zajac',
        brand: 'Visa',
        number: '4111111111111111',
        expMonth: '1',
        expYear: '2030',
        code: '123'
      },
      collectionIds: null
    },
    {
      passwordHistory: null,
      revisionDate: '2026-02-10T14:00:00.000Z',
      creationDate: '2023-05-05T05:05:05.000Z',
      deletedDate: null,
      id: '0f6b2a43-8a8e-4a5b-9f6e-b1a700a1c005',
      organizationId: null,
      folderId: null,
      type: 2,
      reprompt: 0,
      name: 'Wi-Fi at home',
      notes: 'maki-net / correct horse',
      favorite: false,
      secureNote: { type: 0 },
      collectionIds: null
    },
    {
      passwordHistory: null,
      revisionDate: '2026-02-10T14:00:00.000Z',
      creationDate: '2023-05-05T05:05:05.000Z',
      deletedDate: null,
      id: '0f6b2a43-8a8e-4a5b-9f6e-b1a700a1c006',
      organizationId: null,
      folderId: null,
      type: 4,
      reprompt: 0,
      name: 'Me',
      notes: null,
      favorite: false,
      identity: { title: 'Ms', firstName: 'Kara', lastName: 'Zajac' },
      collectionIds: null
    }
  ]
}

/** Bitwarden's `.json` export of the items, and its `.csv` export of the same. */
export function bitwardenSample(): { json: string; csv: string } {
  const json = JSON.stringify({ encrypted: false, folders: [], items: items() }, null, 2)
  const csv = [
    'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
    ',1,login,GitHub,,,0,"https://github.com/login,https://gist.github.com/",kara,correct horse battery staple,otpauth://totp/GitHub:kara?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
    ',,login,Steam,,,0,https://store.steampowered.com/login/,kara_plays,w1nter-is-c0ming,steam://VGHTMJRUGQYDCMBS',
    ',,note,Wi-Fi at home,maki-net / correct horse,,0,,,,'
  ].join('\n')
  return { json, csv }
}

/**
 * A password-protected export of `json`, as Bitwarden makes one: a key from the password (PBKDF2
 * or Argon2id, with the salt's text as the salt), stretched into an encryption key and a MAC key,
 * and the JSON encrypted (AES-256-CBC, HMAC-SHA256: "2.iv|data|mac").
 */
export async function bitwardenEncrypted(
  json: string,
  password: string,
  kdf:
    | { type: 0; iterations: number }
    | { type: 1; iterations: number; memory: number; parallelism: number }
): Promise<string> {
  const salt = 'c2FsdHNhbHRzYWx0c2FsdA=='
  const te = new TextEncoder()
  const master =
    kdf.type === 0
      ? pbkdf2(sha256, te.encode(password), te.encode(salt), { c: kdf.iterations, dkLen: 32 })
      : argon2id(te.encode(password), sha256(te.encode(salt)), {
          t: kdf.iterations,
          m: kdf.memory * 1024,
          p: kdf.parallelism,
          dkLen: 32
        })
  const encKey = expand(sha256, master, te.encode('enc'), 32)
  const macKey = expand(sha256, master, te.encode('mac'), 32)
  const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b))
  const encrypt = async (text: string): Promise<string> => {
    const iv = crypto.getRandomValues(new Uint8Array(16))
    const key = await crypto.subtle.importKey(
      'raw',
      encKey as Uint8Array<ArrayBuffer>,
      'AES-CBC',
      false,
      ['encrypt']
    )
    const data = new Uint8Array(
      await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, te.encode(text))
    )
    const mac = hmac(sha256, macKey, new Uint8Array([...iv, ...data]))
    return `2.${b64(iv)}|${b64(data)}|${b64(mac)}`
  }
  return JSON.stringify({
    encrypted: true,
    passwordProtected: true,
    salt,
    kdfType: kdf.type,
    kdfIterations: kdf.iterations,
    kdfMemory: kdf.type === 1 ? kdf.memory : null,
    kdfParallelism: kdf.type === 1 ? kdf.parallelism : null,
    encKeyValidation_DO_NOT_EDIT: await encrypt('b0b6c2e5-3a07-4a8e-9f5e-2b1d4c3a5f60'),
    data: await encrypt(json)
  })
}
