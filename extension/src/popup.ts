import { ext } from './api'

const line = document.getElementById('status')!
const state = document.getElementById('state')!
const word = document.getElementById('word')!
const show = (cls: string, said: string, text: string): void => {
  state.className = `state ${cls}`
  word.textContent = said
  line.textContent = text
}
void (
  ext.runtime.sendMessage({ type: 'status' }) as Promise<{
    ok: boolean
    linked?: boolean
    timeState?: number | null
    error?: string
  }>
).then((r) => {
  if (!r.ok)
    show('off', 'no maki desktop', `maki desktop isn’t reachable: ${r.error ?? 'no answer'}`)
  else if (!r.linked) show('', 'not linked', 'maki desktop is running, but maki isn’t plugged in.')
  else
    show(
      'linked',
      r.timeState === 2 ? 'linked · time verified' : 'linked',
      'Click into a login or code field to use it: maki shows you the site, and asks.'
    )
})
