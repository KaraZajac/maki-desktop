/**
 * Exports of the other managers maki desktop reads, written for these tests from each one's
 * documented format with made-up logins: Dashlane's zip of CSVs (and its encrypted DASH file),
 * Chrome's and Edge's CSV, Firefox's, Apple Passwords', NordPass's, Enpass's JSON, Keeper's JSON
 * (a passkey in it) and header-less CSV, the Credential Exchange Format (its 1.0 and its 2024
 * draft), and CSVs of no known manager.
 */
import { jwk, makeZip, pkcs8, testScalar } from '../samples'
import { toBase64Url } from '../text'

/** Dashlane's web export: a zip of its CSV files. */
export function dashlaneZip(): Promise<Uint8Array> {
  return makeZip([
    {
      name: 'credentials.csv',
      data: [
        'username,username2,username3,title,password,note,url,category,otpUrl',
        'kara@example.com,kara,,Example,ex-pass-1,"line 1\r\nline 2",https://www.example.com,"Work, Infra",otpauth://totp/?secret=jbswy3dpehpk3pxp&algorithm=SHA1&digits=6&period=30&lock=false',
        'kz@mail.example,,,Mail,mail-pass-2,,https://mail.example,,'
      ].join('\r\n')
    },
    { name: 'securenotes.csv', data: 'title,note,category\r\nWi-Fi,maki-net,\r\n' },
    {
      name: 'payments.csv',
      data: 'type,account_name,account_holder,cc_number,code,expiration_month,expiration_year,routing_number,account_number,country,issuing_bank,note,name\r\npayment_card,Kara Zajac,,4111111111111111,123,01,2030,,,US,,,Visa\r\n'
    },
    {
      name: 'ids.csv',
      data: 'type,number,name,issue_date,expiration_date,place_of_issue,state\r\n'
    },
    {
      name: 'personalInfo.csv',
      data: 'type,title,first_name,middle_name,last_name,login,date_of_birth,place_of_birth,email,email_type,item_name,phone_number,address,country,state,city,zip,address_recipient,address_building,address_apartment,address_floor,address_door_code,job_title,url\r\nname,Ms,Kara,,Zajac,,,,,,Me,,,,,,,,,,,,,\r\n'
    }
  ])
}

/** Dashlane's encrypted export. */
export const DASHLANE_DASH =
  '-------------------- Dashlane Secured Export ----------------------\nId BEGIN\nabc\nId END\nData BEGIN\nQUJD\nData END\n'

/** Chrome's export (`Chrome Passwords.csv`): a site's, an Android app's. */
export const CHROME_CSV = [
  'name,url,username,password,note',
  'github.com,https://github.com/session,kara,"p,ss""word",',
  'app.example.com,android://AbCdEf0123456789AbCdEf0123456789AbCdEf012345==@com.example.app/,kara,s3cret,',
  'accounts.google.com,https://accounts.google.com/signin/v2,kara@gmail.com,g00gle!,"a note,\nwith a line"'
].join('\n')

/** Edge's export (`Microsoft Edge Passwords.csv`), before notes. */
export const EDGE_CSV =
  'name,url,username,password\r\nlogin.live.com,https://login.live.com/,kara@outlook.com,live-pass\r\n'

/** Firefox's export (`logins.csv`): a form login, an HTTP one, and its own account's. */
export const FIREFOX_CSV = [
  '"url","username","password","httpRealm","formActionOrigin","guid","timeCreated","timeLastUsed","timePasswordChanged"',
  '"https://addons.mozilla.org","kara","fox-pass",,"https://addons.mozilla.org","{3f1c2a9e-5b7d-4c1e-9a2b-6d8e0f1a2b3c}","1700000000000","1759300000000","1700000000000"',
  '"https://nas.example.org:5001","admin","hunter2","NAS Login",,"{0d9e8f7a-6b5c-4d3e-8f1a-0b9c8d7e6f5a}","1690000000000","1690000000000","1690000000000"',
  '"chrome://FirefoxAccounts","kara@example.com","{""blob"":1}","Firefox Accounts credentials",,"{11111111-2222-3333-4444-555555555555}","1690000000000","1690000000000","1690000000000"'
].join('\r\n')

/** Apple Passwords' export (`Passwords.csv`). */
export const APPLE_CSV = [
  'Title,URL,Username,Password,Notes,OTPAuth',
  'apple.com (kara@icloud.com),https://apple.com/,kara@icloud.com,appl3-pass,,',
  'example.com (alice@example.com),https://example.com/,alice@example.com,s3cret,"Codes in the safe,\nsecond line",otpauth://totp/example.com:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=example.com&algorithm=SHA1&digits=6&period=30',
  'news.example.org (bob),https://news.example.org/,bob,"pa""ss",,otpauth://totp?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&algorithm=SHA256&digits=8&period=30'
].join('\n')

/** NordPass's export. */
export const NORDPASS_CSV = [
  'name,url,additional_urls,username,password,note,cardholdername,cardnumber,cvc,pin,expirydate,zipcode,folder,full_name,phone_number,email,address1,address2,city,country,state,type,custom_fields',
  'Example,https://example.org,"[""https://login.example.org""]",kara,nord-pass-1,,,,,,,,Work,,,,,,,,,password,"[{""type"":""hidden"",""label"":""PIN"",""value"":""4321""}]"',
  'Work,,,,,,,,,,,,,,,,,,,,,folder,',
  'Visa,,,,,,Kara Zajac,4111111111111111,123,9876,01/30,90210,,,,,,,,,,credit_card,',
  'Notes,,,,,secret note,,,,,,,,,,,,,,,,note,'
].join('\n')

/** Enpass's JSON export. */
export function enpassJson(): string {
  const field = (
    type: string,
    label: string,
    value: string,
    extra = {}
  ): Record<string, unknown> => ({
    deleted: 0,
    label,
    order: 1,
    sensitive: type === 'password' ? 1 : 0,
    type,
    uid: 10,
    updated_at: 1759300000,
    value,
    value_updated_at: 1759300000,
    ...extra
  })
  const item = (
    n: number,
    category: string,
    template: string,
    title: string,
    fields: unknown[],
    extra = {}
  ): Record<string, unknown> => ({
    archived: 0,
    auto_submit: 1,
    category,
    category_name: category,
    createdAt: 1759300000,
    favorite: 0,
    field_updated_at: 1759300000,
    fields,
    folders: [],
    icon: { fav: '', image: { file: '' }, type: 1, uuid: '' },
    note: '',
    subtitle: '',
    template_type: template,
    title,
    trashed: 0,
    updated_at: 1759300000,
    uuid: `uuid-${n}`,
    ...extra
  })
  return JSON.stringify({
    folders: [{ icon: '1008', parent_uuid: '', title: 'Work', updated_at: 1759300000, uuid: 'f1' }],
    items: [
      item(1, 'login', 'login.default', 'Example', [
        field('username', 'Username', ''),
        field('email', 'E-mail', 'kara@example.com'),
        field('password', 'Password', 'enpass-pass'),
        field('url', 'Website', 'https://example.com/login'),
        field('totp', 'One-time code', 'jbsw y3dp ehpk 3pxp'),
        field('.Android#', 'App', 'com.example.app'),
        field('password', 'Old password', 'stale', { deleted: 1 })
      ]),
      item(2, 'creditcard', 'creditcard.default', 'Visa', [
        field('ccNumber', 'Number', '4111111111111111')
      ]),
      item(3, 'computer', 'computer.wifi', 'Home Wi-Fi', [
        field('password', 'Password', 'wifi-pass')
      ]),
      item(
        4,
        'login',
        'login.default',
        'Trashed',
        [field('password', 'Password', 'x'), field('url', 'Website', 'https://t.example.com')],
        {
          trashed: 1
        }
      )
    ]
  })
}

/** Keeper's passkey, for checking what's read. */
export const KEEPER_PASSKEY = {
  scalar: testScalar(55),
  credentialId: Uint8Array.from({ length: 32 }, (_, i) => 255 - i),
  userHandle: new TextEncoder().encode('keeper-user')
}

/** Keeper's JSON export: a login with a code and a passkey, a card, a general record. */
export function keeperJson(): string {
  const { scalar, credentialId, userHandle } = KEEPER_PASSKEY
  return JSON.stringify({
    shared_folders: [
      {
        path: 'Shared\\Family',
        manage_users: false,
        manage_records: true,
        can_edit: true,
        can_share: false
      }
    ],
    records: [
      {
        uid: 1,
        title: 'webauthn.io',
        $type: 'login',
        login: 'kara',
        password: 'keeper-pass',
        login_url: 'https://webauthn.io',
        notes: '',
        custom_fields: {
          '$oneTimeCode::1':
            'otpauth://totp/webauthn:kara?secret=JBSWY3DPEHPK3PXP&issuer=webauthn&algorithm=SHA1&digits=6&period=30',
          '$passkey::1': {
            privateKey: { ...jwk(scalar), ext: true, key_ops: ['sign'] },
            relyingParty: 'webauthn.io',
            username: 'kara',
            userId: toBase64Url(userHandle),
            credentialId: toBase64Url(credentialId),
            signCount: 3,
            createdDate: 1701896375235
          }
        },
        folders: [{ folder: 'Web' }]
      },
      {
        uid: 2,
        title: 'Visa',
        $type: 'bankCard',
        custom_fields: { '$paymentCard::1': { cardNumber: '4111111111111111' } }
      },
      {
        uid: 3,
        title: 'Old router',
        login: 'admin',
        password: 'admin-pass',
        login_url: '192.168.0.1',
        notes: ''
      }
    ]
  })
}

/** Keeper's CSV: no header; custom fields in pairs after the seventh column. */
export const KEEPER_CSV = [
  '"Web","GitHub","kara","gh-keeper","https://github.com/login","Main account","","TFC:Keeper","otpauth://totp/GitHub:kara?secret=JBSWY3DPEHPK3PXP&issuer=GitHub","Recovery email","kara@example.com"',
  '"","Bank","kz","bank-keeper","https://bank.example.com","","",""'
].join('\n')

/** The Credential Exchange Format's passkey, for checking what's read. */
export const CXF_PASSKEY = {
  scalar: testScalar(77),
  credentialId: Uint8Array.from({ length: 20 }, (_, i) => i + 1),
  userHandle: new TextEncoder().encode('cxf-user-handle')
}

/** A CXF 1.0 export: its header, an account, a login with a code and a passkey, a card, a note. */
export function cxfJson(): string {
  const { scalar, credentialId, userHandle } = CXF_PASSKEY
  return JSON.stringify({
    version: { major: 1, minor: 0 },
    exporterRpId: 'exporter.example.com',
    exporterDisplayName: 'Example Exporter',
    timestamp: 1759400000,
    accounts: [
      {
        id: 'QWNjb3VudElk',
        username: '',
        email: 'kara@example.com',
        collections: [],
        items: [
          {
            id: 'SXRlbTE',
            creationAt: 1759300000,
            modifiedAt: 1759300000,
            title: 'Example',
            scope: { urls: ['https://example.com'], androidApps: [] },
            credentials: [
              {
                type: 'basic-auth',
                username: { fieldType: 'string', value: 'kara' },
                password: { fieldType: 'concealed-string', value: 'cxf-pass' }
              },
              {
                type: 'totp',
                secret: 'JBSWY3DPEHPK3PXP',
                period: 30,
                digits: 6,
                algorithm: 'sha256',
                issuer: 'Example'
              },
              {
                type: 'passkey',
                credentialId: toBase64Url(credentialId),
                rpId: 'example.com',
                username: 'kara',
                userDisplayName: 'Kara',
                userHandle: toBase64Url(userHandle),
                key: toBase64Url(pkcs8(scalar))
              }
            ]
          },
          {
            id: 'SXRlbTI',
            title: 'Visa',
            credentials: [
              {
                type: 'credit-card',
                number: { fieldType: 'concealed-string', value: '4111111111111111' }
              }
            ]
          },
          {
            id: 'SXRlbTM',
            title: 'Note',
            credentials: [{ type: 'note', content: { fieldType: 'string', value: 'hello' } }]
          }
        ]
      }
    ]
  })
}

/** The 2024 working draft's shape: a bare account, `urls` in basic-auth, `userName`. */
export function cxfDraftAccount(): string {
  return JSON.stringify({
    id: 'YWNjb3VudA',
    userName: 'kara',
    email: 'kara@example.com',
    collections: [],
    items: [
      {
        id: 'aXRlbQ',
        creationAt: 1727000000,
        modifiedAt: 1727000000,
        type: 'login',
        title: 'Draft login',
        credentials: [
          {
            type: 'basic-auth',
            urls: ['https://draft.example.com'],
            username: 'kara',
            password: 'draft-pass'
          }
        ]
      }
    ]
  })
}

/** A CSV of no manager's, its columns named the usual way. */
export const GENERIC_CSV =
  'Service,Website,Login,Password,2FA\nHome NAS,https://nas.example.org,admin,nas-pass,\nForge,forge.example.com,kara,forge-pass,JBSWY3DPEHPK3PXP\n'

/** A CSV with no header at all. */
export const HEADERLESS_CSV = 'https://a.example.com,ann,pass-a\nhttps://b.example.com,bob,pass-b\n'
