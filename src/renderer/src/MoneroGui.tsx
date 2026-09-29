import { useMemo, useRef, useState } from 'react'
import type { Link } from '@shared/link'
import { keyImageFile, type MoneroSigner, OtherKdfRounds, signFile } from '@shared/monero/cold'
import { type Watched, viewWallet } from '@shared/monero/kept'
import { fileKeyRounds } from '@shared/monero/wallet2'
import { formatXmr, type Network } from '@shared/monero/xmr'
import type { MoneroNetworkValue } from '@shared/wallet-apps'
import { Grouped } from './BitcoinWallet'
import { Button, Field, Glyph } from './ui'

const heading =
  'mt-6 mb-2 font-mono text-[0.62rem] font-bold uppercase tracking-[0.14em] text-overlay1'

/** The KDF rounds the GUI's wallet on `network` was made with, as its owner said (1 by default). */
function keptRounds(network: Network): number {
  try {
    const n = Number(localStorage.getItem(`maki.xmr.kdfRounds.${network}`))
    return Number.isSafeInteger(n) && n >= 1 ? n : 1
  } catch {
    return 1
  }
}

/** Where a file goes by default: beside the one it came from, as the Monero GUI names them. */
function beside(path: string, name: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return slash < 0 ? name : `${path.slice(0, slash + 1)}${name}`
}

/**
 * maki with the Monero GUI (or monero-wallet-cli, or anything built on wallet2): the GUI keeps a
 * view-only wallet, made from the address and view key maki shares, which finds the wallet's
 * payments and builds its transactions; maki signs them. Its Advanced options pass files back and
 * forth: its outputs, for which maki makes key images (so it sees what's spent), and each
 * transaction, which maki goes through with its owner and signs.
 */
export function MoneroGui({
  link,
  network,
  wire,
  watched
}: {
  link: Link
  network: Network
  wire: MoneroNetworkValue
  watched: Watched
}): React.JSX.Element {
  const linked = link.state.linked
  const [open, setOpen] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [busy, setBusy] = useState<'images' | 'sign' | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [rounds, setRounds] = useState(() => keptRounds(network))
  const [roundsText, setRoundsText] = useState(() => String(keptRounds(network)))
  const [askRounds, setAskRounds] = useState(false)
  const [making, setMaking] = useState<number | null>(null)
  const wallet = useMemo(() => viewWallet(watched, network), [watched, network])
  // the key wallet2 encrypts its files with (CryptoNight of the view key, once for each of the
  // wallet's KDF rounds): made once, a round at a time, the page kept going between them
  const key = useRef<{ view: string; rounds: number; key: Uint8Array } | null>(null)
  const fileKeyFor = async (): Promise<Uint8Array> => {
    if (key.current?.view !== watched.view || key.current.rounds !== rounds) {
      let made: Uint8Array = new Uint8Array()
      let n = 0
      for (made of fileKeyRounds(wallet!.view, rounds)) {
        if (rounds > 1) {
          setMaking(++n)
          await new Promise((r) => setTimeout(r, 0))
        }
      }
      setMaking(null)
      key.current = { view: watched.view, rounds, key: made }
    }
    return key.current.key
  }
  const roundsSaid = (text: string): void => {
    setRoundsText(text)
    const n = Number(text)
    if (!Number.isSafeInteger(n) || n < 1) return
    setRounds(n)
    try {
      localStorage.setItem(`maki.xmr.kdfRounds.${network}`, String(n))
    } catch {
      // kept for this run alone
    }
  }

  const maki: MoneroSigner = {
    keyImages: (asks) => link.moneroKeyImages(asks),
    sign: (request) => link.moneroSign(wire, request)
  }

  const copy = async (what: string, text: string): Promise<void> => {
    await window.maki.copy(text)
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }

  const run = async (what: 'images' | 'sign', f: () => Promise<string | null>): Promise<void> => {
    setBusy(what)
    setProblem(null)
    setDone(null)
    try {
      setDone(await f())
    } catch (e) {
      if (e instanceof OtherKdfRounds) {
        setAskRounds(true)
        setProblem(
          `That file is this wallet’s, but doesn’t decrypt with ${rounds} KDF round${rounds === 1 ? '' : 's'}. If the Monero GUI’s Number of KDF rounds isn’t ${rounds} (its first page’s Advanced options have it), give it below and try again.`
        )
      } else setProblem((e as Error).message)
    } finally {
      setMaking(null)
      setBusy(null)
    }
  }

  const keyImages = (): Promise<void> =>
    run('images', async () => {
      const file = await window.maki.monero.open('Open the outputs the Monero GUI exported')
      if (!file) return null
      const made = await keyImageFile(file.data, wallet!, await fileKeyFor(), maki)
      const path = await window.maki.monero.saveFile(
        'Save the key images for the Monero GUI',
        beside(file.path, 'key_images'),
        made.file
      )
      if (!path) return null
      link.note(`key images for ${made.outputs} Monero outputs saved to ${path}`)
      return `Key images for ${made.outputs} outputs saved. In the Monero GUI: Key images, Import, and choose ${path}.`
    })

  const sign = (): Promise<void> =>
    run('sign', async () => {
      const file = await window.maki.monero.open(
        'Open the unsigned transaction the Monero GUI made'
      )
      if (!file) return null
      const signed = await signFile(file.data, wallet!, await fileKeyFor(), maki)
      const path = await window.maki.monero.saveFile(
        'Save the signed transaction for the Monero GUI',
        `${file.path}_signed`,
        signed.signed,
        signed.keyImages
      )
      if (!path) return null
      link.note(`signed Monero transaction saved to ${path}`)
      const what =
        signed.transactions === 1 ? 'The transaction is' : `${signed.transactions} transactions are`
      return `${what} signed (fee ${formatXmr(signed.fee)} XMR). In the Monero GUI: Offline transaction signing, Submit, and choose ${path}.`
    })

  if (!wallet)
    return <p className="mt-3 text-sm text-yellow">The view key kept here isn’t this address’s.</p>

  return (
    <div className="mt-7 border-t border-surface0 pt-4">
      <button
        className="flex w-full items-center gap-2 text-left font-mono text-[0.72rem] font-bold text-subtext0 transition-colors hover:text-fg"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Glyph name={open ? 'up' : 'down'} className="h-3.5 w-3.5" />
        With the Monero GUI
      </button>
      {open && (
        <div className="mt-1 max-w-3xl">
          <p className="mt-2 text-sm leading-relaxed text-subtext0">
            The Monero GUI can keep this wallet too, as a view-only wallet that finds its payments
            and builds its transactions, with maki signing them. Turn on its Advanced mode, then
            make a new wallet from keys: this address, this view key, and no spend key. A restore
            height from before the wallet’s first payment saves it scanning the whole chain.
          </p>

          <h3 className={heading}>Address</h3>
          <div className="flex flex-wrap items-center gap-3">
            <code className="min-w-0 flex-1 break-all font-mono text-xs">
              <Grouped text={watched.address} />
            </code>
            <Button small glyph="copy" onClick={() => void copy('address', watched.address)}>
              {copied === 'address' ? 'Copied' : 'Copy'}
            </Button>
          </div>

          <h3 className={heading}>View key</h3>
          <div className="flex flex-wrap items-center gap-3">
            <code className="min-w-0 flex-1 break-all font-mono text-xs text-subtext1">
              {showKey ? watched.view : '•'.repeat(64)}
            </code>
            <Button small kind="ghost" glyph="eye" onClick={() => setShowKey(!showKey)}>
              {showKey ? 'Hide' : 'Show'}
            </Button>
            <Button small glyph="copy" onClick={() => void copy('view', watched.view)}>
              {copied === 'view' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <p className="mt-1.5 text-xs text-overlay1">
            It shows what comes in and what’s spent, never enough to spend. Anyone with it sees this
            wallet’s payments.
          </p>
          {(askRounds || rounds !== 1) && (
            <Field
              className="mt-4 max-w-xs"
              label="KDF rounds"
              inputMode="numeric"
              value={roundsText}
              onChange={(e) => roundsSaid(e.target.value)}
              hint="The Monero GUI’s Number of KDF rounds: 1 unless you changed it. Each takes maki desktop a moment, once."
            />
          )}

          <h3 className={heading}>Key images</h3>
          <p className="mb-2 text-sm leading-relaxed text-subtext0">
            So the GUI sees what’s spent: in its Transfer page’s Advanced options, export the
            outputs to a file, bring it here, and import the key images maki makes for them. The GUI
            imports key images only through a node it trusts: your own, or one marked trusted.
          </p>
          <Button
            small
            glyph="key"
            disabled={!linked || busy !== null}
            onClick={() => void keyImages()}
          >
            {busy === 'images'
              ? making !== null
                ? `KDF round ${making} of ${rounds}…`
                : 'maki is making them…'
              : 'Key images for an outputs file…'}
          </Button>

          <h3 className={heading}>Send</h3>
          <p className="mb-2 text-sm leading-relaxed text-subtext0">
            Make the transaction in the GUI (Offline transaction signing, Create), bring the file
            here, go through it on maki, then submit what maki signed from the GUI. The key images
            that go with it are saved beside it, where Submit looks for them: through a node the GUI
            doesn’t trust, Submit sends the transaction, then says it couldn’t, having failed to
            import them.
          </p>
          <Button
            small
            glyph="send"
            disabled={!linked || busy !== null}
            onClick={() => void sign()}
          >
            {busy === 'sign'
              ? making !== null
                ? `KDF round ${making} of ${rounds}…`
                : 'Go through it on maki…'
              : 'Sign a transaction file…'}
          </Button>

          {done && <p className="mt-3 text-sm text-green">{done}</p>}
          {problem && <p className="mt-3 text-sm text-yellow">{problem}</p>}
        </div>
      )}
    </div>
  )
}
