/**
 * Notes through maki's Notes app on the fake maki (maki's own app host): kept once maki says
 * yes, listed by title, and refused when maki says no.
 */
import type { ChildProcess } from 'node:child_process'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MakiClient } from './client'
import { NOTES_APP, noteMessage, noteSays, noteTitles } from './notes'
import {
  APP_FIXTURES,
  APP_FIXTURES_THERE,
  FAKE_BUILT,
  startFake,
  TcpTransport
} from './test-support'

describe('notes as the app takes them', () => {
  it('a title, its length first, then the text', () => {
    expect(Array.from(noteMessage('PIN', '1234')!)).toEqual([65, 3, 80, 73, 78, 49, 50, 51, 52])
    // what the app wouldn't take isn't sent
    expect(noteMessage('', 'x')).toBeNull()
    expect(noteMessage('a\ttab', 'x')).toBeNull()
    expect(noteMessage('x'.repeat(41), 'x')).toBeNull()
    expect(noteMessage('ok', 'x'.repeat(8001))).toBeNull()
  })
})

describe.skipIf(!FAKE_BUILT || !APP_FIXTURES_THERE)('notes with the fake maki', () => {
  const fakes: ChildProcess[] = []
  afterAll(() => fakes.forEach((p) => p.kill()))
  const client = async (args: string[] = []): Promise<MakiClient> => {
    const fake = await startFake(['--app', join(APP_FIXTURES, 'notes.maki'), ...args])
    fakes.push(fake.proc)
    return new MakiClient(await TcpTransport.open(fake.port))
  }
  let yes: MakiClient
  beforeAll(async () => {
    yes = await client()
  })

  it('keeps a note once maki says yes, and lists it by title alone', async () => {
    const kept = await yes.appMessage(NOTES_APP, noteMessage('Bank PIN', '1234')!)
    expect(kept.status).toBe('approved')
    expect(noteSays(kept.answer)).toBeNull()
    const list = await yes.appMessage(NOTES_APP, Uint8Array.of('L'.charCodeAt(0)))
    expect(noteTitles(list.answer)).toEqual(['Bank PIN'])
  })

  it('says why when maki says no', async () => {
    const no = await client(['--deny'])
    const r = await no.appMessage(NOTES_APP, noteMessage('Safe', '12-34-56')!)
    expect(noteSays(r.answer)).toBe('you said no on maki')
    expect(noteTitles((await no.appMessage(NOTES_APP, Uint8Array.of(76))).answer)).toEqual([])
  })
})
