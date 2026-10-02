/**
 * The servers maki desktop's account wallets ask (Tron's, XRP's, Stellar's and the others'): for
 * each coin, on its own network and its test network, the addresses tried in turn, and the requests
 * its wallet makes, which are the only ones the main process passes on. Each server sees the
 * account's address and this computer's IP address; none sees a key.
 *
 * No Node or DOM imports: the main process checks requests against it; the wallets name it.
 */

/** maki's account wallets, by the coin's name. */
export type CoinId =
  | 'tron'
  | 'xrp'
  | 'stellar'
  | 'kaspa'
  | 'near'
  | 'sui'
  | 'aptos'
  | 'cardano'
  | 'ton'
  | 'zcash'
  // the Cosmos chains maki's Cosmos app serves
  | 'cosmos'
  | 'osmosis'
  | 'celestia'
  | 'noble'
  | 'dydx'
  | 'neutron'
  | 'akash'
  | 'axelar'
  | 'babylon'
  | 'juno'

export interface CoinServers {
  /** base addresses, tried in turn: the coin's own network's, then its test network's */
  main: string[]
  test: string[]
  /** what a GET may ask, after the base */
  get: RegExp
  /** what a POST may send to, after the base */
  post: RegExp
  /** the most requests a second (the servers' own limits, with room) */
  perSecond: number
  /** the type of the bytes it takes in a POST's body, for a coin that sends some (they cross as hex) */
  binary?: string
  /** another service the wallet asks, for paths that start with `prefix` (which it doesn't see) */
  also?: { prefix: string; main: string[]; test: string[]; perSecond: number }
  /**
   * the paths where a 5xx answer is the server's word, not its absence (toncenter turns a message
   * down with a 500 and why): passed on to the wallet, not taken as the server being down
   */
  says5xx?: RegExp
}

/** What each Cosmos chain's wallet asks of its REST API (cosmos.directory's, the same for every chain). */
const ADDRESS = '[a-z]{3,12}1[02-9ac-hj-np-z]{38,58}'
const cosmosRest = (main: string, test: string[] = []): CoinServers => ({
  main: [main],
  test,
  get: new RegExp(
    `^/(cosmos/bank/v1beta1/balances/${ADDRESS}|cosmos/auth/v1beta1/accounts/${ADDRESS}|feemarket/v1/gas_price/[a-z]{3,10}|osmosis/txfees/v1beta1/cur_eip_base_fee|cosmos/tx/v1beta1/txs\\?query=(message\\.sender|transfer\\.recipient)%3D%27${ADDRESS}%27&order_by=ORDER_BY_DESC&pagination\\.limit=10)$`
  ),
  post: /^\/cosmos\/tx\/v1beta1\/(txs|simulate)$/,
  perSecond: 3
})

/** Each coin's servers; a coin's entry comes with its wallet. */
export const COIN_SERVERS: Partial<Record<CoinId, CoinServers>> = {
  // the Cosmos chains maki's Cosmos app serves, each through cosmos.directory's REST proxy
  cosmos: cosmosRest('https://rest.cosmos.directory/cosmoshub', [
    'https://rest.testcosmos.directory/cosmosicsprovidertestnet'
  ]),
  osmosis: cosmosRest('https://rest.cosmos.directory/osmosis', [
    'https://lcd.osmotest5.osmosis.zone'
  ]),
  celestia: cosmosRest('https://rest.cosmos.directory/celestia', [
    'https://rest.testcosmos.directory/celestiatestnet4'
  ]),
  noble: cosmosRest('https://rest.cosmos.directory/noble'),
  dydx: cosmosRest('https://rest.cosmos.directory/dydx'),
  neutron: cosmosRest('https://rest.cosmos.directory/neutron'),
  akash: cosmosRest('https://rest.cosmos.directory/akash'),
  axelar: cosmosRest('https://rest.cosmos.directory/axelar'),
  babylon: cosmosRest('https://rest.cosmos.directory/babylon'),
  juno: cosmosRest('https://rest.cosmos.directory/juno'),
  // rippled's JSON-RPC, all at the root: the community's cluster first, then Ripple's own
  xrp: {
    main: ['https://xrplcluster.com', 'https://s1.ripple.com:51234', 'https://s2.ripple.com:51234'],
    test: ['https://s.altnet.rippletest.net:51234'],
    get: /$^/,
    post: /^\/$/,
    perSecond: 4
  },
  // Horizon, the Stellar Development Foundation's: accounts, their payments, fees and the base
  // reserve; a transaction submitted as Horizon's `tx` parameter
  stellar: {
    main: ['https://horizon.stellar.org'],
    test: ['https://horizon-testnet.stellar.org'],
    get: /^\/(accounts\/G[A-Z2-7]{55}(\/payments\?order=desc&limit=20)?|fee_stats|ledgers\?order=desc&limit=1)$/,
    post: /^\/transactions\?tx=[A-Za-z0-9%]+$/,
    perSecond: 4
  },
  // TronGrid, keyless: accounts (TRX and TRC-20 balances) and their history; the latest block's
  // header to make a transaction from, a token transfer's energy, the chain's prices, broadcasting
  tron: {
    main: ['https://api.trongrid.io'],
    test: ['https://nile.trongrid.io'],
    get: /^\/v1\/accounts\/T[1-9A-HJ-NP-Za-km-z]{33}(\/transactions(\/trc20)?\?limit=20)?$/,
    post: /^\/wallet\/(getnowblock|broadcasthex|triggerconstantcontract|getchainparameters)$/,
    perSecond: 3
  },
  // api.kaspa.org, the Kaspa community's REST API (Testnet 10's own): which of the account's
  // addresses have been used, their coins and history, fees and the DAG's score, and sending
  kaspa: {
    main: ['https://api.kaspa.org'],
    test: ['https://api-tn10.kaspa.org'],
    get: /^\/(addresses\/kaspa(test)?:[02-9ac-hj-np-z]{61,63}\/full-transactions\?limit=20&resolve_previous_outpoints=light|info\/fee-estimate|info\/blockdag)$/,
    post: /^\/(addresses\/(active|utxos)|transactions)$/,
    perSecond: 4
  },
  // Aptos Labs' API (keyless, its per-IP limits low): the account, its balances by coin type or
  // asset, what it sent, gas prices, simulating and sending a transaction (as BCS); and history
  // from its indexer (GraphQL)
  aptos: {
    main: ['https://api.mainnet.aptoslabs.com'],
    test: ['https://api.testnet.aptoslabs.com'],
    get: /^\/v1\/(accounts\/0x[0-9a-f]{64}(\/balance\/0x[0-9a-f]{1,64}(::[A-Za-z0-9_]{1,128}::[A-Za-z0-9_]{1,128})?|\/transactions\?limit=20)?|estimate_gas_price)$/,
    post: /^\/v1\/(transactions(\/simulate\?estimate_max_gas_amount=true&estimate_gas_unit_price=true)?|graphql)$/,
    perSecond: 2,
    binary: 'application/x.aptos.signed_transaction+bcs'
  },
  // FastNEAR's RPC (keyless; NEAR's own rpc.*.near.org is deprecated): accounts, keys' nonces,
  // tokens' balances, the latest block, gas prices, sending; history from NearBlocks
  near: {
    main: ['https://rpc.mainnet.fastnear.com'],
    test: ['https://rpc.testnet.fastnear.com'],
    get: /^\/nearblocks\/v1\/account\/[a-z0-9._-]{2,64}\/(txns-only|ft-txns)\?per_page=20$/,
    post: /^\/$/,
    perSecond: 4,
    also: {
      prefix: '/nearblocks',
      main: ['https://api.nearblocks.io'],
      test: ['https://api-testnet.nearblocks.io'],
      perSecond: 1
    }
  },
  // Koios (keyless: 100 requests in 10 seconds, small JSON bodies): the account by its stake
  // address (its coins, rewards, history), the tip and the epoch's fee parameters; sending (CBOR)
  cardano: {
    main: ['https://api.koios.rest/api/v1'],
    test: ['https://preprod.koios.rest/api/v1'],
    get: /^\/(tip|epoch_params\?_epoch_no=\d{1,6})$/,
    post: /^\/(account_info|account_utxos|account_txs\?order=block_height\.desc&limit=16|tx_info|submittx)$/,
    perSecond: 5,
    binary: 'application/cbor'
  },
  // Sui's GraphQL API (Mysten Labs'; the public fullnodes' JSON-RPC is gone): balances, coins,
  // history, the epoch and its gas price, simulating and executing
  sui: {
    main: ['https://graphql.mainnet.sui.io'],
    test: ['https://graphql.testnet.sui.io'],
    get: /$^/,
    post: /^\/graphql$/,
    perSecond: 3
  },
  // toncenter's v3 API, TON's own (a request a second without a key): a wallet's balance, seqno
  // and contract, its jetton wallets, its history as actions; a fee estimate, sending, and the
  // transaction a message started. It answers a message (or an estimate) it turns down with a 500
  // and its reason.
  ton: {
    main: ['https://toncenter.com/api/v3'],
    test: ['https://testnet.toncenter.com/api/v3'],
    get: /^\/(walletInformation\?address=[A-Za-z0-9_-]{48}&use_v2=false|jetton\/wallets\?owner_address=[A-Za-z0-9_-]{48}&limit=50&offset=0|actions\?account=[A-Za-z0-9_-]{48}&limit=20&offset=0&sort=desc|transactionsByMessage\?msg_hash=[0-9a-f]{64}&direction=in&limit=1)$/,
    post: /^\/(estimateFee|message)$/,
    perSecond: 1,
    says5xx: /^\/(message|estimateFee)$/
  },
  // zecblock's API (keyless): the chain's tip and the upgrade in force, each address's balance and
  // transactions, a transaction's outputs (each saying whether it's spent), whether a payment sent
  // waits in the mempool, and sending
  zcash: {
    main: ['https://api.zecblock.com'],
    test: ['https://api.testnet.zecblock.com'],
    get: /^\/v1\/(network\/blockchain-info|addresses\/t[1-9A-HJ-NP-Za-km-z]{34}\?page=1&limit=100|transactions\/[0-9a-f]{64}|mempool\/[0-9a-f]{64})$/,
    post: /^\/v1\/transactions\/broadcast$/,
    perSecond: 2
  }
}

/** What the main process answers a wallet's request with: the server's status and its body. */
export type CoinResponse = { status: number; text: string } | { error: string }

/**
 * A wallet's way to its coin's servers (the main process's `coin:fetch`): a body is JSON, or with
 * `binary` the hex of bytes of the coin's own `binary` type.
 */
export type CoinFetch = (
  network: 0 | 1,
  method: 'GET' | 'POST',
  path: string,
  body?: string,
  binary?: boolean
) => Promise<{ status: number; text: string }>

/** Whether a request is one the coin's wallet makes. */
export function allowed(servers: CoinServers, method: string, path: string): boolean {
  return (method === 'GET' ? servers.get : method === 'POST' ? servers.post : /$^/).test(path)
}

/** What maki desktop keeps of an account maki shared: which, and its key and address. */
export interface SharedAccount {
  network: 0 | 1
  index: number
  address: string
  /** hex */
  publicKey: string
}
