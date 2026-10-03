import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // the fake-maki test builds and starts a Rust binary the first time
    testTimeout: 120_000,
    // the end-to-end tests each run the real app and a fake maki: four at a time, or a dozen of
    // them starve each other and the slowest (Confirm's real round trip) times out
    ...(process.env.MAKI_E2E === '1'
      ? { poolOptions: { forks: { maxForks: 4, minForks: 1 } } }
      : {})
  }
})
