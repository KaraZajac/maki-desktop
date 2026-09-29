/**
 * For scripts/sudo-e2e.sh, bundled with esbuild:
 *
 *     node sudo-e2e.cjs scripts DIR          the setup's scripts, as maki desktop runs them as root
 *     node sudo-e2e.cjs bridge PORT KEYFILE  maki desktop's socket, linked to the fake maki at PORT;
 *                                            the Sudo app's key, base64, into KEYFILE
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { forWindow, serveBridge } from '../src/main/bridge'
import { INSTALL, SUDO_APP, UNINSTALL, keyOf } from '../src/main/sudo'
import { Link } from '../src/shared/link'
import { TcpTransport } from '../src/shared/test-support'

async function main(): Promise<void> {
  const [what, a, b] = process.argv.slice(2)
  if (what === 'scripts') {
    writeFileSync(join(a, 'install.sh'), INSTALL)
    writeFileSync(join(a, 'uninstall.sh'), UNINSTALL)
    return
  }
  const link = new Link(async () => {
    throw new Error('offline')
  })
  link.autoSync = false
  if (!(await link.attach(await TcpTransport.open(Number(a)), 'fake maki')))
    throw new Error('no link')
  await serveBridge(async (r) => link.fromBrowser(await forWindow(r)))
  const key = keyOf((await link.appMessage(SUDO_APP, Uint8Array.of('P'.charCodeAt(0)))).answer)
  if (!key) throw new Error('the Sudo app gave no key')
  writeFileSync(b, key)
}

main().catch((e: Error) => {
  console.error(e.message)
  process.exit(1)
})
