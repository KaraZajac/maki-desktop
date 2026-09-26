/**
 * The site maki is asked about: the hostname of the frame that asked, as the browser reports it.
 * https pages only (and localhost, for development). The browser has already lowercased the
 * hostname and turned an international name into punycode, the form maki shows and matches on.
 */
export function siteOf(url: string | undefined): string | null {
  if (!url) return null
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1'
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null
  return u.hostname
}
