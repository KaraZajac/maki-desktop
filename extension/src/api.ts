/**
 * The WebExtensions API. Firefox's `browser` returns promises everywhere; Chrome's `chrome` does
 * too under Manifest V3. Otherwise the same shape, so one build serves both.
 */
export const ext: typeof chrome = (globalThis as { browser?: typeof chrome }).browser ?? chrome
