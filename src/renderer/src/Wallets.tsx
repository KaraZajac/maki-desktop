import type { Link } from '@shared/link'
import { Bitcoin } from './Bitcoin'
import { Ethereum } from './Ethereum'
import { PageHeader } from './ui'

/** maki's wallets: Bitcoin and Ethereum, here and for wallet software and sites. */
export function Wallets({ link }: { link: Link }): React.JSX.Element {
  return (
    <div className="rise space-y-6">
      <PageHeader
        label="wallets"
        title="Wallets"
        lede="Keys on maki, from its recovery phrase, behind its PIN. Here you see what they hold and make payments; wallet software and sites can too. maki shows you each one, the payments, change and fees spelled out, and signs only when you say so."
      />
      <Bitcoin link={link} />
      <Ethereum link={link} />
    </div>
  )
}
