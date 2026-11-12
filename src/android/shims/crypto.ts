/** `node:crypto`, the part the shared code uses. The WebView has it built in. */
export function randomUUID(): string {
  return globalThis.crypto.randomUUID()
}

export default { randomUUID }
