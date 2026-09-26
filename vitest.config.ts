import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // the fake-maki test builds and starts a Rust binary the first time
    testTimeout: 120_000
  }
})
