/**
 * KeePassXC's CSV export, and a KeePass XML export as KeePass 2 (File › Export › KeePass XML) and
 * keepassxc-cli write one; written for these tests from their documented formats with made-up
 * entries: codes in each of the ways KeePass keeps one, KeePassXC passkeys (ES256, and an EdDSA one
 * maki can't take), an entry in the recycle bin, an entry with history.
 */
import { pem, pkcs8, ed25519Pkcs8, testScalar } from '../samples'
import { toBase64Url } from '../text'

export const KEEPASSXC_CSV = [
  '"Group","Title","Username","Password","URL","Notes","TOTP","Icon","Last Modified","Created"',
  '"Root/Email","Fastmail","kara@fastmail.com","mail-pass-1","https://app.fastmail.com","","otpauth://totp/Fastmail:kara%40fastmail.com?secret=JBSWY3DPEHPK3PXP&period=30&digits=6&issuer=Fastmail","0","2026-05-01T10:20:30Z","2023-01-02T03:04:05Z"',
  '"Root/Games","Steam","kara_plays","steam-pass","https://store.steampowered.com","","otpauth://totp/Steam:kara_plays?secret=JBSWY3DPEHPK3PXP&period=30&digits=5&issuer=Steam&encoder=steam","0","2026-05-01T10:20:30Z","2023-01-02T03:04:05Z"',
  '"Root/Recycle Bin","Old","old","old-pass","https://old.example.com","","","0","2026-05-01T10:20:30Z","2023-01-02T03:04:05Z"'
].join('\n')

/** The passkeys' keys and IDs, for checking what's read. */
export const KEEPASS_PASSKEY = {
  scalar: testScalar(33),
  credentialId: Uint8Array.from({ length: 32 }, (_, i) => i * 7),
  userHandle: new TextEncoder().encode('webauthn-user-77')
}

const s = (key: string, value: string, attr = ''): string =>
  `<String><Key>${key}</Key><Value${attr}>${value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</Value></String>`
const p = (key: string, value: string): string => s(key, value, ' ProtectInMemory="True"')

export function keepassXml(): string {
  const { scalar, credentialId, userHandle } = KEEPASS_PASSKEY
  return `<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<KeePassFile>
  <Meta>
    <Generator>KeePassXC</Generator>
    <DatabaseName>Kara</DatabaseName>
    <RecycleBinEnabled>True</RecycleBinEnabled>
    <RecycleBinUUID>QmluQmluQmluQmluQmluQg==</RecycleBinUUID>
  </Meta>
  <Root>
    <Group>
      <UUID>Um9vdFJvb3RSb290Um9vdA==</UUID>
      <Name>Root</Name>
      <Entry>
        <UUID>RW50cnkxRW50cnkxRW50cg==</UUID>
        ${s('Title', 'Codeberg')}
        ${s('UserName', 'kara')}
        ${p('Password', 'forge & <fire>')}
        ${s('URL', 'https://codeberg.org/user/login')}
        ${s('KP2A_URL_1', 'https://git.example.org')}
        ${s('Notes', 'two\nlines')}
        ${p('otp', 'otpauth://totp/Codeberg:kara?secret=JBSWY3DPEHPK3PXP&period=30&digits=6&issuer=Codeberg')}
        <History>
          <Entry>
            <UUID>RW50cnkxRW50cnkxRW50cg==</UUID>
            ${s('Title', 'Codeberg')}
            ${s('UserName', 'kara')}
            ${p('Password', 'an older password')}
            ${s('URL', 'https://codeberg.org')}
          </Entry>
        </History>
      </Entry>
      <Entry>
        <UUID>RW50cnkyRW50cnkyRW50cg==</UUID>
        ${s('Title', 'webauthn.io (Passkey)')}
        ${s('UserName', 'kara')}
        ${p('Password', '')}
        ${s('URL', 'https://webauthn.io')}
        ${p('KPEX_PASSKEY_CREDENTIAL_ID', toBase64Url(credentialId))}
        ${p('KPEX_PASSKEY_PRIVATE_KEY_PEM', pem(pkcs8(scalar)))}
        ${s('KPEX_PASSKEY_RELYING_PARTY', 'webauthn.io')}
        ${p('KPEX_PASSKEY_USER_HANDLE', toBase64Url(userHandle))}
        ${s('KPEX_PASSKEY_USERNAME', 'kara')}
        ${s('KPEX_PASSKEY_FLAG_BE', '1')}
        ${s('KPEX_PASSKEY_FLAG_BS', '1')}
      </Entry>
      <Entry>
        <UUID>RW50cnkzRW50cnkzRW50cg==</UUID>
        ${s('Title', 'Ed site (Passkey)')}
        ${s('UserName', 'kara')}
        ${s('URL', 'https://ed.example.com')}
        ${p('KPEX_PASSKEY_CREDENTIAL_ID', toBase64Url(new Uint8Array(32).fill(9)))}
        ${p('KPEX_PASSKEY_PRIVATE_KEY_PEM', pem(ed25519Pkcs8(new Uint8Array(32).fill(4))))}
        ${s('KPEX_PASSKEY_RELYING_PARTY', 'ed.example.com')}
        ${p('KPEX_PASSKEY_USER_HANDLE', toBase64Url(Uint8Array.of(1, 2, 3, 4)))}
        ${s('KPEX_PASSKEY_USERNAME', 'kara')}
      </Entry>
      <Group>
        <UUID>V29ya1dvcmtXb3JrV29yaw==</UUID>
        <Name>Work</Name>
        <Entry>
          <UUID>RW50cnk0RW50cnk0RW50cg==</UUID>
          ${s('Title', 'VPN')}
          ${s('UserName', 'kzajac')}
          ${p('Password', 'tunnel-vision')}
          ${s('URL', 'vpn.example.com')}
          ${s('TOTP Seed', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')}
          ${s('TOTP Settings', '30;8')}
        </Entry>
        <Entry>
          <UUID>RW50cnk1RW50cnk1RW50cg==</UUID>
          ${s('Title', 'Payroll')}
          ${s('UserName', 'kzajac')}
          ${p('Password', 'pay-me')}
          ${s('URL', 'https://payroll.example.com')}
          ${s('TimeOtp-Secret-Base32', 'KRSXG5CTMVRXEZLU')}
          ${s('TimeOtp-Algorithm', 'HMAC-SHA-256')}
          ${s('TimeOtp-Period', '60')}
        </Entry>
      </Group>
      <Group>
        <UUID>QmluQmluQmluQmluQmluQg==</UUID>
        <Name>Recycle Bin</Name>
        <Entry>
          <UUID>RW50cnk2RW50cnk2RW50cg==</UUID>
          ${s('Title', 'Deleted')}
          ${s('UserName', 'gone')}
          ${p('Password', 'gone-pass')}
          ${s('URL', 'https://gone.example.com')}
        </Entry>
      </Group>
    </Group>
    <DeletedObjects/>
  </Root>
</KeePassFile>
`
}
