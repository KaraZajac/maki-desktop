/**
 * PSBTs as wallet software hands them over: a binary file (Sparrow's "Save Transaction"),
 * base64 text (Bitcoin Core, the clipboard) or hex. maki takes the bytes.
 */

const MAGIC = [0x70, 0x73, 0x62, 0x74, 0xff] // "psbt" 0xff

export function isPsbt(bytes: Uint8Array): boolean {
  return bytes.length > MAGIC.length && MAGIC.every((b, i) => bytes[i] === b)
}

function fromBase64(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4 !== 0) return null
  const raw = atob(text)
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

function fromHex(text: string): Uint8Array | null {
  if (!/^([0-9a-fA-F]{2})+$/.test(text)) return null
  return Uint8Array.from(text.match(/../g)!, (h) => parseInt(h, 16))
}

/** The PSBT in a file or pasted text, or null if it isn't one. */
export function readPsbt(data: Uint8Array | string): Uint8Array | null {
  if (typeof data !== 'string') {
    if (isPsbt(data)) return data
    data = new TextDecoder().decode(data)
  }
  const text = data.replace(/\s+/g, '')
  for (const decode of [fromBase64, fromHex]) {
    const bytes = decode(text)
    if (bytes && isPsbt(bytes)) return bytes
  }
  return null
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
