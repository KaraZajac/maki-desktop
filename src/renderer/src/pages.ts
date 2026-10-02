import { CONTACTS_APP } from '@shared/contacts'
import { FLASHCARDS_APP } from '@shared/flashcards'
import { MACROPAD_APP } from '@shared/macropad'
import { NOTES_APP } from '@shared/notes'
import { PASSWORDS_APP } from '@shared/passwords'
import { SHOWQR_APP } from '@shared/showqr'

/** maki desktop's pages. */
export type Page =
  | 'overview'
  | 'apps'
  | 'backups'
  | 'wallets'
  | 'macropad'
  | 'flashcards'
  | 'notes'
  | 'contacts'
  | 'passwordmaker'
  | 'showqr'
  | 'browsers'
  | 'keys'
  | 'sudo'
  | 'nostr'
  | 'about'

export interface PageInfo {
  id: Page
  title: string
  glyph: string
  /** the app it's the page of: it's in the sidebar once maki has the app (or had it, last linked) */
  app?: string
}

/**
 * The sidebar's sections: maki itself; money; what maki holds, an app's page for each app of maki's
 * that has a side here; and what this computer reaches maki for. About is below them all.
 */
export const SECTIONS: { title: string | null; pages: PageInfo[] }[] = [
  {
    title: null,
    pages: [
      { id: 'overview', title: 'Overview', glyph: 'overview' },
      { id: 'apps', title: 'Apps', glyph: 'apps' },
      { id: 'backups', title: 'Backups', glyph: 'shield' }
    ]
  },
  {
    title: 'money',
    pages: [{ id: 'wallets', title: 'Wallets', glyph: 'wallet' }]
  },
  {
    title: 'on maki',
    pages: [
      { id: 'macropad', title: 'Macro Pad', glyph: 'keyboard', app: MACROPAD_APP },
      { id: 'flashcards', title: 'Flashcards', glyph: 'cards', app: FLASHCARDS_APP },
      { id: 'notes', title: 'Notes', glyph: 'note', app: NOTES_APP },
      { id: 'contacts', title: 'Contacts', glyph: 'person', app: CONTACTS_APP },
      { id: 'passwordmaker', title: 'Password Maker', glyph: 'asterisk', app: PASSWORDS_APP },
      { id: 'showqr', title: 'Show QR', glyph: 'qr', app: SHOWQR_APP }
    ]
  },
  {
    title: 'computer',
    pages: [
      { id: 'browsers', title: 'Browsers', glyph: 'globe' },
      { id: 'keys', title: 'SSH, Git & keys', glyph: 'key' },
      { id: 'sudo', title: 'sudo & Confirm', glyph: 'badge' },
      { id: 'nostr', title: 'Nostr', glyph: 'bolt' }
    ]
  }
]

export const ABOUT: PageInfo = { id: 'about', title: 'About', glyph: 'info' }

export const PAGES: PageInfo[] = [...SECTIONS.flatMap((s) => s.pages), ABOUT]

/** Whether `page` is in the sidebar, given the apps maki has (or had, last linked). */
export function shown(page: PageInfo, apps: string[]): boolean {
  return !page.app || apps.includes(page.app)
}
