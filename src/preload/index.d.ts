import type { MakiApi } from './index'

declare global {
  interface Window {
    maki: MakiApi
  }
}
