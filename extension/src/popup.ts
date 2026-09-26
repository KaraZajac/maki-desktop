import { ext } from './api'

const line = document.getElementById('status')!
void (ext.runtime.sendMessage({ type: 'status' }) as Promise<{ ok: boolean; linked?: boolean; timeState?: number | null; error?: string }>).then(
  (r) => {
    if (!r.ok) line.textContent = `maki desktop isn’t reachable: ${r.error ?? 'no answer'}`
    else if (!r.linked) line.textContent = 'maki desktop is running, but maki isn’t plugged in.'
    else line.textContent = `maki is linked${r.timeState === 2 ? ' and its clock is verified' : ''}. Click into a login or code field to use it.`
  }
)
