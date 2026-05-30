import { bufferToBody as bufferToBodyImpl } from 'cdk-local/internal';

/**
 * Thin spy-friendly wrapper over cdk-local's `bufferToBody` (which owns
 * the implementation — see the Phase 3 shim-swap note in
 * `.claude/rules/code-layout.md`). A bare `export { bufferToBody } from
 * 'cdk-local'` re-export would be a non-configurable getter that
 * `vi.spyOn(websocketBody, 'bufferToBody')` cannot redefine, so this
 * module keeps a local (spy-able) export binding: `websocket-server.ts`
 * imports it as a namespace and the B4 regression test
 * (`websocket-server.test.ts`, Issue #537 item 6) installs a spy that
 * must intercept EVERY call to assert the post-deny close-handshake
 * window does no `bufferToBody` allocation work.
 */
export function bufferToBody(
  raw: Buffer | ArrayBuffer | Buffer[],
  isBinary: boolean
): { body: string; isBase64Encoded: boolean } {
  return bufferToBodyImpl(raw, isBinary);
}
