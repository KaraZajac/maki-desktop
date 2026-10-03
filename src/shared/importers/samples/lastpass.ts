/**
 * A LastPass export (`lastpass_export.csv`, from the browser extension's Export), written for these
 * tests from LastPass's documented format with made-up logins: a login with a code, one whose
 * password starts with "-" (which LastPass writes with a space before it), a secure note, a card
 * kept as a note, a password with "&amp;" in it, and a row its newer exporter wrote without quoting.
 */
export const LASTPASS_CSV = [
  'url,username,password,totp,extra,name,grouping,fav',
  'https://github.com/login,kara,correct horse battery staple,JBSWY3DPEHPK3PXP,,GitHub,Work\\Code,1',
  'https://example.com,kara@example.com, -dash-first,,,Example,,0',
  'http://sn,,,,"my notes',
  'second line",Notes,,0',
  'http://sn,,,,"NoteType:Credit Card',
  'Language:en-US',
  'Name on Card:Kara Zajac',
  'Type:Visa',
  'Number:4111111111111111',
  'Security Code:123',
  'Start Date:,',
  'Expiration Date:January,2030',
  'Notes:",Visa,,0',
  'https://shop.example.net,kz,salt&amp;pepper,,,Shop,,0',
  'https://broken.example.com,kara,pass,with,comma,,Broken,,0'
].join('\n')
