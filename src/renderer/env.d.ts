/// <reference types="vite/client" />
import type { ForgeApi } from '../preload'

declare global {
  interface Window {
    forge: ForgeApi
  }
}

export {}
