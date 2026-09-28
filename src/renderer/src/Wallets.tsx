import type { Link } from '@shared/link'
import { Bitcoin } from './Bitcoin'
import { Ethereum } from './Ethereum'
import { PageHeader } from './ui'

/** maki's wallets: Bitcoin for wallet software, Ethereum for sites through the extension. */
export function Wallets({ link }: { link: Link }): React.JSX.Element {
  return (
    <div className="rise space-y-6">
      <PageHeader
        label="wallets"
        title="Wallets"
        lede="Keys on maki, from its recovery phrase, behind its PIN. Wallet software and sites build transactions; maki shows you each one, the payments, change and fees spelled out, and signs only when you say so."
      />
      <Bitcoin link={link} />
      <Ethereum link={link} />
    </div>
  )
}
