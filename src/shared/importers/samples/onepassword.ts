/**
 * A 1Password export, as File › Export writes one: 1PUX (a zip: `export.attributes`,
 * `export.data`, `files/`) and the CSV; written for these tests from 1Password's documented
 * format (support.1password.com/1pux-format/) with made-up items: a login with two addresses and a
 * code, a password item, an archived login, a card, a secure note, and a document's file.
 */
import { makeZip } from '../samples'

/** export.data, as 1Password writes it. */
export function onePasswordData(): string {
  const login = (
    uuid: string,
    title: string,
    url: string[],
    username: string,
    password: string,
    extra: Record<string, unknown> = {},
    sections: unknown[] = []
  ): Record<string, unknown> => ({
    uuid,
    favIndex: 0,
    createdAt: 1700000000,
    updatedAt: 1750000000,
    state: 'active',
    categoryUuid: '001',
    details: {
      loginFields: [
        { value: username, id: '', name: 'username', fieldType: 'T', designation: 'username' },
        { value: password, id: '', name: 'password', fieldType: 'P', designation: 'password' }
      ],
      notesPlain: '',
      sections,
      passwordHistory: []
    },
    overview: {
      subtitle: username,
      urls: url.map((u) => ({ label: 'website', url: u, mode: 'default' })),
      title,
      url: url[0] ?? '',
      ps: 80,
      pbe: 70.1,
      pgrng: true,
      tags: []
    },
    ...extra
  })
  return JSON.stringify({
    accounts: [
      {
        attrs: {
          accountName: 'Kara',
          name: 'Kara',
          avatar: '',
          email: 'kara@example.com',
          uuid: 'ACCOUNTUUIDEXAMPLE0000000',
          domain: 'https://my.1password.com/'
        },
        vaults: [
          {
            attrs: { uuid: 'vaultuuid1', desc: '', avatar: '', name: 'Personal', type: 'P' },
            items: [
              login(
                'item1',
                'GitLab',
                ['https://gitlab.com/users/sign_in', 'https://about.gitlab.com'],
                'kara',
                'tanuki-tanuki',
                {},
                [
                  {
                    title: '',
                    name: 'Section_otp',
                    fields: [
                      {
                        title: 'one-time password',
                        id: 'TOTP_abc123',
                        value: {
                          totp: 'otpauth://totp/GitLab:kara?secret=JBSWY3DPEHPK3PXP&issuer=GitLab'
                        },
                        guarded: false,
                        multiline: false,
                        dontGenerate: false,
                        inputTraits: {
                          keyboard: 'default',
                          correction: 'default',
                          capitalization: 'default'
                        }
                      }
                    ]
                  }
                ]
              ),
              {
                uuid: 'item2',
                favIndex: 0,
                createdAt: 1700000000,
                updatedAt: 1750000000,
                state: 'active',
                categoryUuid: '005',
                details: { loginFields: [], password: 'router-admin-pass', sections: [] },
                overview: { title: 'Router', url: 'http://192.168.1.1', urls: [], tags: [] }
              },
              login('item3', 'Old forum', ['https://forum.example.org'], 'kz', 'old-pass', {
                state: 'archived'
              }),
              {
                uuid: 'item4',
                favIndex: 0,
                createdAt: 1700000000,
                updatedAt: 1750000000,
                state: 'active',
                categoryUuid: '002',
                details: {
                  sections: [
                    {
                      title: '',
                      name: '',
                      fields: [
                        {
                          title: 'number',
                          id: 'ccnum',
                          value: { creditCardNumber: '4111111111111111' }
                        }
                      ]
                    }
                  ]
                },
                overview: { title: 'Visa', tags: [] }
              },
              {
                uuid: 'item5',
                favIndex: 0,
                createdAt: 1700000000,
                updatedAt: 1750000000,
                state: 'active',
                categoryUuid: '003',
                details: { notesPlain: 'the safe’s combination', sections: [] },
                overview: { title: 'Safe', tags: [] }
              }
            ]
          }
        ]
      }
    ]
  })
}

/** The 1PUX zip. */
export function onePux(): Promise<Uint8Array> {
  return makeZip([
    {
      name: 'export.attributes',
      data: JSON.stringify({
        version: 3,
        description: '1Password Unencrypted Export',
        createdAt: 1759400000
      })
    },
    { name: 'export.data', data: onePasswordData() },
    { name: 'files/h3p7ceubefsnohc5axfuramzm4__scan.pdf', data: '%PDF-1.4 not really' }
  ])
}

/** 1Password 8's CSV. */
export const ONEPASSWORD_CSV = [
  'Title,Url,Username,Password,OTPAuth,Favorite,Archived,Tags,Notes',
  'GitLab,https://gitlab.com/users/sign_in,kara,tanuki-tanuki,otpauth://totp/?secret=JBSWY3DPEHPK3PXP&period=30&algorithm=SHA1&digits=6,true,false,work;code,',
  'Router,http://192.168.1.1,,router-admin-pass,,false,false,,',
  'Old forum,https://forum.example.org,kz,old-pass,,false,true,,"line 1',
  'line 2"'
].join('\n')
