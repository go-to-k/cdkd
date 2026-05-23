/**
 * Convert a ws-emitted message buffer into the AWS-canonical event
 * body + `isBase64Encoded` discriminator. Text frames (opcode 0x1) pass
 * through as UTF-8 with `isBase64Encoded: false`; binary frames
 * (opcode 0x2) are base64-encoded with `isBase64Encoded: true`. Matches
 * AWS-deployed WebSocket API event shape exactly — handlers decode via
 * `Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8')`.
 *
 * Closes the data-integrity bug where every byte > 0x7F on a binary
 * frame was silently corrupted by handlers that trusted the previously
 * hardcoded `isBase64Encoded: false` flag and UTF-8-decoded the
 * base64-encoded body.
 *
 * Lives in its own module so the B4 regression test can install a
 * `vi.fn()` spy that intercepts EVERY call — same-module references in
 * `websocket-server.ts` would bypass the export-binding spy. See
 * Issue #537 item 6.
 */
export function bufferToBody(
  raw: Buffer | ArrayBuffer | Buffer[],
  isBinary: boolean
): { body: string; isBase64Encoded: boolean } {
  const buf: Buffer = Array.isArray(raw)
    ? Buffer.concat(raw)
    : Buffer.isBuffer(raw)
      ? raw
      : Buffer.from(raw);
  if (isBinary) {
    return { body: buf.toString('base64'), isBase64Encoded: true };
  }
  return { body: buf.toString('utf-8'), isBase64Encoded: false };
}
