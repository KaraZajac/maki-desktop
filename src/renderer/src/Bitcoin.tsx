import { useState } from 'react'
import type { Link } from '@shared/link'
import {
  BtcAccount,
  Network,
  type ApprovalValue,
  type BtcAccountValue,
  type NetworkValue
} from '@shared/protocol'
import { readPsbt, toBase64 } from '@shared/psbt'

const button =
  'inline-flex items-center gap-2 rounded-lg border border-surface1 bg-surface0/40 px-3 py-1.5 font-mono text-[0.72rem] font-bold tracking-wide text-subtext1 transition-colors hover:border-surface2 hover:text-fg disabled:pointer-events-none disabled:opacity-40'
const heading =
  'mb-2 mt-7 font-mono text-[0.68rem] font-bold uppercase tracking-[0.14em] text-yellow'

function savedNetwork(): NetworkValue {
  try {
    return localStorage.getItem('maki.network') === '1' ? Network.TESTNET : Network.BITCOIN
  } catch {
    return Network.BITCOIN
  }
}

function savedAccount(): BtcAccountValue {
  try {
    return localStorage.getItem('maki.btcAccount') === '1' ? BtcAccount.TAPROOT : BtcAccount.SEGWIT
  } catch {
    return BtcAccount.SEGWIT
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
  const [kind, setKind] = useState<BtcAccountValue>(savedAccount)
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

  const chooseKind = (k: BtcAccountValue): void => {
    setKind(k)
    setAccount(null)
    setShown(null)
    setProblem(null)
    try {
      localStorage.setItem('maki.btcAccount', String(k))
    } catch {
      // remembered for this session only
    }
  }

  const taproot = kind === BtcAccount.TAPROOT
  const keyName = taproot
    ? network === Network.TESTNET
      ? 'tpub'
      : 'xpub'
    : network === Network.TESTNET
      ? 'vpub'
      : 'zpub'

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
    <section className="card p-6">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2.5 font-mono text-[0.68rem] font-bold uppercase tracking-[0.18em] text-peach">
          <span className="h-0.5 w-5 rounded bg-peach" />
          Bitcoin
        </h2>
        <div className="flex overflow-hidden rounded-lg border border-surface1 text-xs">
          {[
            [Network.BITCOIN, 'Bitcoin'],
            [Network.TESTNET, 'Testnet']
          ].map(([n, label]) => (
            <button
              key={label}
              onClick={() => choose(n as NetworkValue)}
              className={`px-2.5 py-1 ${network === n ? 'bg-peach font-bold text-crust' : 'text-subtext0 hover:text-fg'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-2 text-sm text-subtext0">
        Wallet software such as Sparrow or Bitcoin Core keeps track of your coins and builds
        transactions. maki shows you each one and signs it.
      </p>
      <div className="mt-2 flex items-center gap-2 text-xs text-overlay1">
        Account
        <div className="flex overflow-hidden rounded-lg border border-surface1">
          {[
            [BtcAccount.SEGWIT, 'Native SegWit'],
            [BtcAccount.TAPROOT, 'Taproot']
          ].map(([k, label]) => (
            <button
              key={label}
              onClick={() => chooseKind(k as BtcAccountValue)}
              className={`px-2.5 py-1 ${kind === k ? 'bg-peach font-bold text-crust' : 'text-subtext0 hover:text-fg'}`}
            >
              {label}
            </button>
          ))}
        </div>
        {taproot ? 'BIP86, bc1p… addresses' : 'BIP84, bc1q… addresses'}
      </div>

      <h3 className={heading}>Connect wallet software</h3>
      {account ? (
        <>
          <p className="mb-2 text-xs text-overlay1">
            Add this to your wallet software as a watch-only wallet. It can see your coins and build
            transactions, but only maki can sign them.
          </p>
          <code className="block select-all break-all rounded-lg bg-crust p-2 font-mono text-xs text-subtext1">
            {account.descriptor}
          </code>
          <div className="mt-2 flex flex-wrap gap-2">
            <button className={button} onClick={() => void copy('descriptor', account.descriptor)}>
              {copied === 'descriptor' ? 'Copied' : 'Copy descriptor'}
            </button>
            <button className={button} onClick={() => void copy('zpub', account.zpub)}>
              {copied === 'zpub' ? 'Copied' : `Copy ${keyName}`}
            </button>
          </div>
        </>
      ) : (
        <button
          className={button}
          disabled={!idle}
          onClick={() =>
            void run('account', async () => {
              const a = await link.btcAccount(network, kind)
              if (a) setAccount(a)
              else setProblem('maki didn’t share the account.')
            })
          }
        >
          {busy === 'account' ? 'Approve on maki…' : 'Get the account from maki'}
        </button>
      )}

      <h3 className={heading}>Check an address</h3>
      <p className="mb-2 text-xs text-overlay1">
        Before you give out an address, check that maki shows the same one as your wallet software.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={change ? 'change' : 'receive'}
          onChange={(e) => setChange(e.target.value === 'change')}
          className="rounded-lg border border-surface1 bg-mantle px-2 py-1.5 text-sm"
        >
          <option value="receive">Receive</option>
          <option value="change">Change</option>
        </select>
        <label className="flex items-center gap-1 text-sm text-subtext0">
          #
          <input
            type="number"
            min={0}
            max={2147483647}
            value={index}
            onChange={(e) =>
              setIndex(Math.max(0, Math.min(2147483647, Math.floor(Number(e.target.value) || 0))))
            }
            className="w-20 rounded-lg border border-surface1 bg-mantle px-2 py-1.5 text-sm"
          />
        </label>
        <button
          className={button}
          disabled={!idle}
          onClick={() =>
            void run('address', async () => {
              const which = `${taproot ? 'Taproot ' : ''}${change ? (taproot ? 'change' : 'Change') : taproot ? 'receive' : 'Receive'} address #${index}`
              setShown(null)
              const r = await link.btcAddress(network, change, index, kind)
              setShown({ ...r, which })
            })
          }
        >
          {busy === 'address' ? 'Compare on maki…' : 'Show on maki'}
        </button>
      </div>
      {shown && (
        <div className="mt-2 text-sm">
          <code className="block break-all font-mono text-xs text-subtext1">{shown.address}</code>
          <p
            className={
              shown.approval === 'approved'
                ? 'text-green'
                : shown.approval === 'denied'
                  ? 'text-red'
                  : 'text-yellow'
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
        className="mt-2 w-full resize-none rounded-lg border border-surface0 bg-crust p-2 font-mono text-xs text-subtext1 placeholder:text-overlay0"
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
          <p className="mb-2 text-sm text-green">
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
      {problem && <p className="mt-2 text-sm text-yellow">{problem}</p>}
    </section>
  )
}
