import { useState } from 'react'
import type { Link } from '@shared/link'
import { Network, type ApprovalValue, type NetworkValue } from '@shared/protocol'
import { readPsbt, toBase64 } from '@shared/psbt'

const button =
  'rounded-lg border border-zinc-700 px-3 py-1.5 text-sm hover:border-zinc-500 disabled:opacity-40'
const heading = 'mb-1 mt-4 text-sm font-medium text-zinc-300'

function savedNetwork(): NetworkValue {
  try {
    return localStorage.getItem('maki.network') === '1' ? Network.TESTNET : Network.BITCOIN
  } catch {
    return Network.BITCOIN
  }
}

/** A signed PSBT goes beside the one it came from, by default. */
function signedPath(from: string | null): string {
  return from ? `${from.replace(/\.[^./\\]*$/, '')}-signed.psbt` : 'signed.psbt'
}

function why(approval: ApprovalValue, reason: string): string {
  switch (approval) {
    case 'refused':
      return `maki won't sign it: ${reason}.`
    case 'denied':
      return 'You rejected it on maki.'
    case 'timed out':
      return 'maki stopped waiting for an answer.'
    case 'locked':
      return 'maki is locked: enter its PIN first.'
    case 'no phrase':
      return 'maki has no recovery phrase yet.'
    default:
      return `maki couldn't: ${approval}.`
  }
}

/**
 * maki's Bitcoin wallet from this side: hand wallet software the account, check an address on
 * maki's screen, and have maki sign a transaction. Coins, balances and building transactions
 * are the wallet software's; maki shows what it's asked to sign and signs it.
 */
export function Bitcoin({ link }: { link: Link }): React.JSX.Element {
  const linked = link.state.linked
  const [network, setNetwork] = useState<NetworkValue>(savedNetwork)
  const [busy, setBusy] = useState<'account' | 'address' | 'sign' | null>(null)
  const [account, setAccount] = useState<{ zpub: string; descriptor: string } | null>(null)
  const [change, setChange] = useState(false)
  const [index, setIndex] = useState(0)
  const [shown, setShown] = useState<{
    approval: ApprovalValue
    address: string
    which: string
  } | null>(null)
  const [pasted, setPasted] = useState('')
  const [signed, setSigned] = useState<{ bytes: Uint8Array; from: string | null } | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  const run = async (
    what: 'account' | 'address' | 'sign',
    f: () => Promise<void>
  ): Promise<void> => {
    setBusy(what)
    setProblem(null)
    try {
      await f()
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const choose = (n: NetworkValue): void => {
    setNetwork(n)
    setAccount(null)
    setShown(null)
    setSigned(null)
    setProblem(null)
    try {
      localStorage.setItem('maki.network', String(n))
    } catch {
      // remembered for this session only
    }
  }

  const copy = async (label: string, text: string): Promise<void> => {
    await window.maki.copy(text)
    setCopied(label)
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 2000)
  }

  const sign = (psbt: Uint8Array | null, from: string | null): Promise<void> =>
    run('sign', async () => {
      setSigned(null)
      if (!psbt) {
        setProblem(
          "That isn't a PSBT. In your wallet software, save the transaction as a PSBT file, or copy it as base64."
        )
        return
      }
      const r = await link.btcSign(network, psbt)
      if (r.signed) setSigned({ bytes: r.signed, from })
      else setProblem(why(r.approval, r.reason))
    })

  const idle = linked && busy === null

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Bitcoin</h2>
        <div className="flex overflow-hidden rounded-lg border border-zinc-700 text-xs">
          {[
            [Network.BITCOIN, 'Bitcoin'],
            [Network.TESTNET, 'Testnet']
          ].map(([n, label]) => (
            <button
              key={label}
              onClick={() => choose(n as NetworkValue)}
              className={`px-2.5 py-1 ${network === n ? 'bg-zinc-200 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-sm text-zinc-400">
        Wallet software such as Sparrow or Bitcoin Core keeps track of your coins and builds
        transactions. maki shows you each one and signs it.
      </p>

      <h3 className={heading}>Connect wallet software</h3>
      {account ? (
        <>
          <p className="mb-2 text-xs text-zinc-500">
            Add this to your wallet software as a watch-only wallet. It can see your coins and build
            transactions, but only maki can sign them.
          </p>
          <code className="block select-all break-all rounded-lg bg-zinc-950 p-2 font-mono text-xs text-zinc-300">
            {account.descriptor}
          </code>
          <div className="mt-2 flex flex-wrap gap-2">
            <button className={button} onClick={() => void copy('descriptor', account.descriptor)}>
              {copied === 'descriptor' ? 'Copied' : 'Copy descriptor'}
            </button>
            <button className={button} onClick={() => void copy('zpub', account.zpub)}>
              {copied === 'zpub'
                ? 'Copied'
                : `Copy ${network === Network.TESTNET ? 'vpub' : 'zpub'}`}
            </button>
          </div>
        </>
      ) : (
        <button
          className={button}
          disabled={!idle}
          onClick={() =>
            void run('account', async () => {
              const a = await link.btcAccount(network)
              if (a) setAccount(a)
              else setProblem('maki didn’t share the account.')
            })
          }
        >
          {busy === 'account' ? 'Approve on maki…' : 'Get the account from maki'}
        </button>
      )}

      <h3 className={heading}>Check an address</h3>
      <p className="mb-2 text-xs text-zinc-500">
        Before you give out an address, check that maki shows the same one as your wallet software.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={change ? 'change' : 'receive'}
          onChange={(e) => setChange(e.target.value === 'change')}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
        >
          <option value="receive">Receive</option>
          <option value="change">Change</option>
        </select>
        <label className="flex items-center gap-1 text-sm text-zinc-400">
          #
          <input
            type="number"
            min={0}
            max={2147483647}
            value={index}
            onChange={(e) =>
              setIndex(Math.max(0, Math.min(2147483647, Math.floor(Number(e.target.value) || 0))))
            }
            className="w-20 rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
          />
        </label>
        <button
          className={button}
          disabled={!idle}
          onClick={() =>
            void run('address', async () => {
              const which = `${change ? 'Change' : 'Receive'} address #${index}`
              setShown(null)
              const r = await link.btcAddress(network, change, index)
              setShown({ ...r, which })
            })
          }
        >
          {busy === 'address' ? 'Compare on maki…' : 'Show on maki'}
        </button>
      </div>
      {shown && (
        <div className="mt-2 text-sm">
          <code className="block break-all font-mono text-xs text-zinc-300">{shown.address}</code>
          <p
            className={
              shown.approval === 'approved'
                ? 'text-emerald-400'
                : shown.approval === 'denied'
                  ? 'text-red-400'
                  : 'text-amber-400'
            }
          >
            {shown.approval === 'approved'
              ? `${shown.which}: you said it matches.`
              : shown.approval === 'denied'
                ? `${shown.which}: you said it doesn't match. Don't use the address this computer shows.`
                : why(shown.approval, '')}
          </p>
        </div>
      )}

      <h3 className={heading}>Sign a transaction</h3>
      <div className="flex flex-wrap gap-2">
        <button
          className={button}
          disabled={!idle}
          onClick={async () => {
            try {
              const file = await window.maki.wallet.open()
              if (file) await sign(readPsbt(file.data), file.path)
            } catch (e) {
              setProblem((e as Error).message)
            }
          }}
        >
          {busy === 'sign' ? 'Go through it on maki…' : 'Open a PSBT file…'}
        </button>
      </div>
      <textarea
        value={pasted}
        onChange={(e) => setPasted(e.target.value)}
        placeholder="…or paste a PSBT (base64 or hex)"
        rows={2}
        className="mt-2 w-full resize-none rounded-lg border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-300 placeholder:text-zinc-600"
      />
      {pasted.trim() !== '' && (
        <button
          className={button}
          disabled={!idle}
          onClick={() => void sign(readPsbt(pasted), null)}
        >
          Sign the pasted PSBT
        </button>
      )}
      {signed && (
        <div className="mt-2">
          <p className="mb-2 text-sm text-emerald-400">
            Signed. Load it back into your wallet software to broadcast it.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              className={button}
              onClick={async () => {
                const path = await window.maki.wallet.save(signedPath(signed.from), signed.bytes)
                if (path) link.note(`signed transaction saved to ${path}`)
              }}
            >
              Save signed PSBT…
            </button>
            <button className={button} onClick={() => void copy('signed', toBase64(signed.bytes))}>
              {copied === 'signed' ? 'Copied' : 'Copy as base64'}
            </button>
          </div>
        </div>
      )}
      {problem && <p className="mt-2 text-sm text-amber-400">{problem}</p>}
    </section>
  )
}
