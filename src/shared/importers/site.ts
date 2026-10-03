/**
 * Sites as maki keeps and matches them (libs/maki-proto/src/site.rs in the firmware): a host,
 * lowercase ASCII letters, digits, dots and hyphens, an international name in its xn-- form, or an
 * IPv4 address; "www." dropped, as maki drops it when it compares. A login for `github.com` serves
 * `gist.github.com` too. A host without a dot covers nothing on maki, so a login for one isn't
 * worth sending.
 */

/** The most a host may be, in bytes. */
export const MAX_HOST = 253

/** Whether `host` is one maki shows and takes (site.rs's `valid`). */
export function validHost(host: string): boolean {
  return (
    host.length > 0 &&
    host.length <= MAX_HOST &&
    /^[a-z0-9.-]+$/.test(host) &&
    !host.startsWith('.') &&
    !host.endsWith('.') &&
    !host.includes('..')
  )
}

/** Web addresses' schemes; anything else is an app's or another protocol's. */
const WEB = /^https?:$/

/**
 * The host of one address, as the browser takes it (lowercased; an international name as punycode,
 * through the platform's own URL parser), or why it isn't one maki can keep a login for. `null` for
 * an address that isn't a website's (an app's, `ftp://`), which isn't wrong, just not a site.
 */
export function hostOf(address: string): { host: string } | { why: string } | null {
  const text = address.trim()
  if (text === '') return { why: 'no site' }
  // "androidapp://com.github.android" has a scheme; "github.com:8443/login" has a port
  const scheme = /^([a-z][a-z0-9+.-]*:)(.*)$/is.exec(text)
  const hasScheme = scheme !== null && !/^\d+(?:[/?#]|$)/.test(scheme[2])
  if (hasScheme && !WEB.test(scheme[1].toLowerCase())) return null
  // an email address where the address should be: its domain isn't the site
  if (!hasScheme && /^[^/?#]*@/.test(text)) return { why: `“${short(text)}” isn’t a web address` }
  let url: URL
  try {
    url = new URL(hasScheme ? text : `https://${text}`)
  } catch {
    return { why: `“${short(text)}” isn’t a web address` }
  }
  let host = url.hostname
  if (host.startsWith('['))
    return { why: `${host} is an IPv6 address, and maki takes a domain name or an IPv4 address` }
  host = host.replace(/\.$/, '')
  if (host.startsWith('www.') && host.slice(4).includes('.')) host = host.slice(4)
  if (!validHost(host)) return { why: `“${short(text)}” isn’t a web address maki can show` }
  if (!host.includes('.'))
    return hasScheme || text.includes('/') || host === 'localhost'
      ? {
          why: `${host} has no dot in it, and maki offers logins only for a domain name or an IPv4 address`
        }
      : { why: `“${short(text)}” isn’t a web address` }
  return { host }
}

/** A long address cut for a sentence. */
function short(s: string): string {
  return [...s].length > 60 ? `${[...s].slice(0, 57).join('')}…` : s
}

/**
 * A login's site from the addresses an export has for it: the first website's host, and the
 * others it was for (other hosts, apps), which maki's login won't cover; or why there's no site.
 */
export function siteOf(addresses: string[]): { site: string; others: string[] } | { why: string } {
  let site: string | null = null
  let why: string | null = null
  const apps: string[] = []
  const others: string[] = []
  for (const address of addresses) {
    if (address.trim() === '') continue
    const got = hostOf(address)
    if (got === null) {
      ;(site === null ? apps : others).push(short(address.trim()))
    } else if ('why' in got) {
      if (site === null) why ??= got.why
      else others.push(short(address.trim()))
    } else if (site === null) {
      site = got.host
    } else if (got.host !== site && !others.includes(got.host)) {
      others.push(got.host)
    }
  }
  if (site !== null) return { site, others: [...apps, ...others] }
  if (why !== null) return { why }
  if (apps.length > 0) return { why: `no website, only ${apps.join(', ')}` }
  return { why: 'no site' }
}

/**
 * A passkey's relying party ID as maki keeps it: lowercased, an international name as punycode,
 * and nothing else changed (a passkey for www.example.com is that site's, not example.com's); or
 * null if it isn't a host.
 */
export function rpIdOf(rpId: string): string | null {
  const text = rpId.trim()
  if (text === '') return null
  let host: string
  try {
    host = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`).hostname
  } catch {
    return null
  }
  return validHost(host) ? host : null
}
