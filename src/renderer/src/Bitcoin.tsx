import { useEffect, useMemo, useState } from 'react'
import type { Link } from '@shared/link'
import {
  BtcAccount,
  Network,
  type ApprovalValue,
  type BtcAccountValue,
  type NetworkValue
} from '@shared/protocol'
import { parseDescriptor, walletKey, type BtcAccountInfo } from '@shared/btc-wallet'
import { readPsbt, toBase64 } from '@shared/psbt'
import { BitcoinWallet, Grouped, said } from './BitcoinWallet'
import { Button, Card, Glyph, Label, Segmented } from './ui'

function saved<T>(key: string, one: T, other: T): T {
  try {
    return localStorage.getItem(key) === '1' ? other : one
  } catch {
    return one
  }
}

function remember(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // remembered for this session only
  }
}

/** A signed PSBT goes beside the one it came from, by default. */
function signedPath(from: string | null): string {
  return from ? `${from.replace(/\.[^./\\]*$/, '')}-signed.psbt` : 'signed.psbt'
}

const accountOf = (d: string): BtcAccountInfo | null => {
  try {
    return parseDescriptor(d)
  } catch {
    return null
  }
}

/**
 * maki's Bitcoin accounts: a wallet here (balance, receive, send, activity) once maki has shared
 * the account's public key, and for wallet software (Sparrow, Bitcoin Core) the account to watch,
 * addresses to check on maki's screen, and PSBTs for maki to sign.
 */
export function Bitcoin({ link }: { link: Link }): React.JSX.Element {
  const linked = link.state.linked
  const [network, setNetwork] = useState<NetworkValue>(() =>
    saved('maki.network', Network.BITCOIN, Network.TESTNET)
  )
  const [kind, setKind] = useState<BtcAccountValue>(() =>
    saved('maki.btcAccount', BtcAccount.SEGWIT, BtcAccount.TAPROOT)
  )
  const [descriptors, setDescriptors] = useState<string[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    void window.maki.bitcoin.load().then(setDescriptors)
  }, [])

  const net = network === Network.TESTNET ? 'test' : 'bitcoin'
  const k = kind === BtcAccount.TAPROOT ? 'taproot' : 'segwit'
  const info = useMemo(
    () => descriptors?.map(accountOf).find((a) => a?.network === net && a.kind === k) ?? null,
    [descriptors, net, k]
  )

  const keep = async (list: string[]): Promise<void> => {
    await window.maki.bitcoin.save(list)
    setDescriptors(list)
  }

  const add = async (): Promise<void> => {
    setAdding(true)
    setProblem(null)
    try {
      const a = await link.btcAccount(network, kind)
      if (!a) {
        setProblem('maki didn’t share the account.')
        return
      }
      const got = parseDescriptor(a.descriptor)
      if (got.network !== net || got.kind !== k)
        throw new Error('maki shared a different account from the one asked for')
      await keep([
        ...(descriptors ?? []).filter(
          (d) =>
            d !== got.descriptor && !(accountOf(d)?.network === net && accountOf(d)?.kind === k)
        ),
        got.descriptor
      ])
    } catch (e) {
      setProblem((e as Error).message)
    } finally {
      setAdding(false)
    }
  }

  const forget = async (): Promise<void> => {
    if (!info) return
    await keep((descriptors ?? []).filter((d) => d !== info.descriptor))
    link.note(
      `${k === 'taproot' ? 'taproot' : 'native SegWit'} Bitcoin account removed from maki desktop (maki still has it)`
    )
  }

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Label>Bitcoin</Label>
        <div className="flex flex-wrap gap-2">
          <Segmented
            label="Account"
            value={kind}
            options={[
              [BtcAccount.SEGWIT, 'Native SegWit'],
              [BtcAccount.TAPROOT, 'Taproot']
            ]}
            onChange={(v) => {
              setKind(v)
              setProblem(null)
              remember('maki.btcAccount', v)
            }}
          />
          <Segmented
            label="Network"
            value={network}
            options={[
              [Network.BITCOIN, 'Bitcoin'],
              [Network.TESTNET, 'Testnet']
            ]}
            onChange={(v) => {
              setNetwork(v)
              setProblem(null)
              remember('maki.network', v)
            }}
          />
        </div>
      </div>

      {descriptors === null ? null : info ? (
        <BitcoinWallet
          key={info.descriptor}
          link={link}
          info={info}
          network={network}
          kind={kind}
        />
      ) : (
        <div className="mt-6 flex flex-wrap items-center gap-6 rounded-xl border border-dashed border-surface1 p-6">
          <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-peach/10 text-peach">
            <Glyph name="bitcoin" className="h-7 w-7" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="font-mono text-[0.95rem] font-bold text-fg">Your bitcoin, here</h3>
            <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-subtext0">
              maki shares the {k === 'taproot' ? 'taproot' : 'native SegWit'} account’s public key
              once you approve it on maki. maki desktop can then show the balance, give you
              addresses and make payments, which maki shows you and signs. It can never spend on its
              own.
            </p>
          </div>
          <Button
            kind="primary"
            glyph="chip"
            disabled={!linked || adding}
            onClick={() => void add()}
          >
            {adding ? 'Approve on maki…' : linked ? 'Add from maki' : 'Plug maki in'}
          </Button>
        </div>
      )}
      {problem && <p className="mt-3 text-sm text-yellow">{problem}</p>}

      <WalletSoftware
        link={link}
        network={network}
        kind={kind}
        info={info}
        forget={() => void forget()}
      />
    </Card>
  )
}

/** For wallet software: the account to watch, an address to check, a PSBT to sign. */
function WalletSoftware({
  link,
  network,
  kind,
  info,
  forget
}: {
  link: Link
  network: NetworkValue
  kind: BtcAccountValue
  info: BtcAccountInfo | null
  forget: () => void
}): React.JSX.Element {
  const linked = link.state.linked
  const taproot = kind === BtcAccount.TAPROOT
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'address' | 'sign' | null>(null)
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

  const run = async (what: 'address' | 'sign', f: () => Promise<void>): Promise<void> => {
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
      else setProblem(said(r.approval, r.reason))
    })

  const idle = linked && busy === null
  const heading =
    'mt-6 mb-2 font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1'
  const key = info ? walletKey(info) : null
  const keyName = key?.slice(0, 4) ?? (taproot ? 'xpub' : 'zpub')

  return (
    <div className="mt-7 border-t border-surface0 pt-4">
      <button
        className="flex w-full items-center gap-2 text-left font-mono text-[0.72rem] font-bold text-subtext0 transition-colors hover:text-fg"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Glyph
          name="chevron"
          className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        Wallet software
        <span className="font-sans font-normal text-overlay1">
          Sparrow, Bitcoin Core: watch the account, check addresses, sign PSBTs
        </span>
      </button>
      {open && (
        <div className="rise">
          <h3 className={heading}>The account, to watch</h3>
          {info && key ? (
            <>
              <p className="mb-2 text-xs text-overlay1">
                Add this to your wallet software as a watch-only wallet. It can see your coins and
                build transactions, but only maki can sign them.
              </p>
              <code className="block select-all break-all rounded-lg bg-crust p-2.5 font-mono text-xs text-subtext1">
                {info.descriptor}
              </code>
              <div className="mt-2 flex flex-wrap gap-2">
                <Button small glyph="copy" onClick={() => void copy('descriptor', info.descriptor)}>
                  {copied === 'descriptor' ? 'Copied' : 'Copy descriptor'}
                </Button>
                <Button small glyph="copy" onClick={() => void copy('key', key)}>
                  {copied === 'key' ? 'Copied' : `Copy ${keyName}`}
                </Button>
                <Button small kind="danger" glyph="trash" onClick={forget}>
                  Remove from maki desktop
                </Button>
              </div>
            </>
          ) : (
            <p className="text-xs text-overlay1">
              Add the account from maki above, and its descriptor shows here.
            </p>
          )}

          <h3 className={heading}>Check an address</h3>
          <p className="mb-2 text-xs text-overlay1">
            Before you give out an address from your wallet software, check that maki shows the same
            one.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="Chain"
              value={change ? 1 : 0}
              options={[
                [0, 'Receive'],
                [1, 'Change']
              ]}
              onChange={(v) => setChange(v === 1)}
            />
            <label className="flex items-center gap-1.5 font-mono text-xs text-overlay1">
              #
              <input
                type="number"
                min={0}
                max={2147483647}
                value={index}
                onChange={(e) =>
                  setIndex(
                    Math.max(0, Math.min(2147483647, Math.floor(Number(e.target.value) || 0)))
                  )
                }
                className="w-20 rounded-lg border border-surface1 bg-crust/60 px-2 py-1 font-mono text-sm text-fg outline-none focus:border-peach/70"
              />
            </label>
            <Button
              small
              kind="ghost"
              glyph="chip"
              disabled={!idle}
              onClick={() =>
                void run('address', async () => {
                  const which = `${taproot ? 'Taproot ' : ''}${change ? 'change' : 'receive'} address #${index}`
                  setShown(null)
                  const r = await link.btcAddress(network, change, index, kind)
                  setShown({ ...r, which: which[0].toUpperCase() + which.slice(1) })
                })
              }
            >
              {busy === 'address' ? 'Compare on maki…' : 'Show on maki'}
            </Button>
          </div>
          {shown && (
            <div className="mt-2 text-sm">
              <code className="block break-all font-mono text-xs">
                <Grouped text={shown.address} />
              </code>
              <p
                className={`mt-1 ${
                  shown.approval === 'approved'
                    ? 'text-green'
                    : shown.approval === 'denied'
                      ? 'text-red'
                      : 'text-yellow'
                }`}
              >
                {shown.approval === 'approved'
                  ? `${shown.which}: you said it matches.`
                  : shown.approval === 'denied'
                    ? `${shown.which}: you said it doesn't match. Don't use the address this computer shows.`
                    : said(shown.approval)}
              </p>
            </div>
          )}

          <h3 className={heading}>Sign a transaction</h3>
          <div className="flex flex-wrap gap-2">
            <Button
              small
              glyph="file"
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
            </Button>
          </div>
          <textarea
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder="…or paste a PSBT (base64 or hex)"
            rows={2}
            className="mt-2 w-full resize-none rounded-lg border border-surface1 bg-crust/60 p-2.5 font-mono text-xs text-subtext1 outline-none placeholder:text-overlay0 focus:border-peach/70"
          />
          {pasted.trim() !== '' && (
            <Button
              small
              kind="ghost"
              glyph="chip"
              disabled={!idle}
              onClick={() => void sign(readPsbt(pasted), null)}
            >
              Sign the pasted PSBT
            </Button>
          )}
          {signed && (
            <div className="mt-3">
              <p className="mb-2 text-sm text-green">
                Signed. Load it back into your wallet software to broadcast it.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  small
                  glyph="download"
                  onClick={async () => {
                    const path = await window.maki.wallet.save(
                      signedPath(signed.from),
                      signed.bytes
                    )
                    if (path) link.note(`signed transaction saved to ${path}`)
                  }}
                >
                  Save signed PSBT…
                </Button>
                <Button
                  small
                  glyph="copy"
                  onClick={() => void copy('signed', toBase64(signed.bytes))}
                >
                  {copied === 'signed' ? 'Copied' : 'Copy as base64'}
                </Button>
              </div>
            </div>
          )}
          {problem && <p className="mt-2 text-sm text-yellow">{problem}</p>}
        </div>
      )}
    </div>
  )
}
