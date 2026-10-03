/**
 * Enough XML for KeePass's export: elements, attributes, text, CDATA and character references,
 * read into a tree. Comments, processing instructions and a DOCTYPE are passed over; entities other
 * than XML's own five are left as they're written (nothing is fetched or expanded). No DOM: this
 * runs in tests as in the window.
 */

/** An element, with the text directly in it (its children's not included). */
export interface XmlElement {
  name: string
  attrs: Record<string, string>
  children: XmlElement[]
  text: string
}

/** XML that isn't well-formed enough to read. */
export class XmlError extends Error {}

/** How deep elements may nest: KeePass's groups nest, but not this deep. */
export const MAX_DEPTH = 256

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }
/** A start tag's name, and an attribute, matched where the reader is (sticky). */
const TAG = /<([^\s/>]+)/y
const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/y

/** `text` with its character references and XML's five entities replaced. */
function unescape(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[ref] ?? whole
  })
}

/** Reads `text` as XML: its root element. */
export function readXml(text: string): XmlElement {
  const stack: XmlElement[] = []
  let root: XmlElement | null = null
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    const chunk = text.slice(i, lt < 0 ? text.length : lt)
    if (chunk !== '' && stack.length > 0) stack[stack.length - 1].text += unescape(chunk)
    if (lt < 0) break
    i = lt
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4)
      if (end < 0) throw new XmlError('a comment is never closed')
      i = end + 3
    } else if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9)
      if (end < 0) throw new XmlError('a CDATA section is never closed')
      if (stack.length > 0) stack[stack.length - 1].text += text.slice(i + 9, end)
      i = end + 3
    } else if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2)
      if (end < 0) throw new XmlError('a processing instruction is never closed')
      i = end + 2
    } else if (text.startsWith('<!', i)) {
      // a DOCTYPE, its internal subset (in brackets) passed over whole
      let depth = 0
      let j = i + 2
      for (; j < text.length; j++) {
        if (text[j] === '[') depth++
        else if (text[j] === ']') depth--
        else if (text[j] === '>' && depth <= 0) break
      }
      i = j + 1
    } else if (text[i + 1] === '/') {
      const end = text.indexOf('>', i)
      if (end < 0) throw new XmlError('a closing tag is never finished')
      const name = text.slice(i + 2, end).trim()
      const open = stack.pop()
      if (!open || open.name !== name)
        throw new XmlError(`</${name}> closes ${open ? `<${open.name}>` : 'nothing'}`)
      i = end + 1
    } else {
      TAG.lastIndex = i
      const tag = TAG.exec(text)
      if (!tag) throw new XmlError('a tag with no name')
      const element: XmlElement = { name: tag[1], attrs: {}, children: [], text: '' }
      let j = i + tag[0].length
      // attributes, up to the end of the tag
      for (;;) {
        while (/\s/.test(text[j] ?? '')) j++
        if (j >= text.length) throw new XmlError(`<${element.name}> is never finished`)
        if (text[j] === '>' || text.startsWith('/>', j)) break
        ATTR.lastIndex = j
        const attr = ATTR.exec(text)
        if (!attr) throw new XmlError(`<${element.name}> has an attribute that isn’t quoted`)
        element.attrs[attr[1]] = unescape(attr[3] ?? attr[4] ?? '')
        j += attr[0].length
      }
      const selfClosing = text[j] === '/'
      i = j + (selfClosing ? 2 : 1)
      if (stack.length > 0) stack[stack.length - 1].children.push(element)
      else if (root === null) root = element
      else throw new XmlError('there’s more than one root element')
      if (!selfClosing) {
        if (stack.length >= MAX_DEPTH) throw new XmlError('its elements nest too deep')
        stack.push(element)
      }
    }
  }
  if (stack.length > 0) throw new XmlError(`<${stack[stack.length - 1].name}> is never closed`)
  if (root === null) throw new XmlError('it has no elements')
  return root
}

/** The first child of `element` called `name`. */
export function child(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((c) => c.name === name)
}

/** The children of `element` called `name`. */
export function children(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((c) => c.name === name)
}
