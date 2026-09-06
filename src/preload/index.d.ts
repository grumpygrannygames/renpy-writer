import type { RenpyWriterApi } from '@shared/api'

declare global {
  interface Window {
    api: RenpyWriterApi
  }
}

export {}
