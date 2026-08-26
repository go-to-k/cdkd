import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  invokeRieStreaming,
  parseStreamingPrelude,
  STREAM_BODY_MAX_BYTES,
  type StreamingInvokeResult,
} from '../../../src/local/rie-client.js';

/**
 * Streaming Lambda response wire format (verified empirically against
 * `public.ecr.aws/lambda/nodejs:20` RIE on 2026-05-22 for issue #467):
 *
 *   <JSON prelude bytes> <8 NULL bytes> <raw body chunks...>
 *
 * These tests exercise both `parseStreamingPrelude` (pure-functional)
 * and `invokeRieStreaming` (end-to-end via a tiny streaming HTTP server
 * — no Docker needed).
 */

const SEPARATOR = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]);

describe('parseStreamingPrelude', () => {
  it('parses statusCode + headers + cookies', () => {
    const prelude = parseStreamingPrelude(
      JSON.stringify({
        statusCode: 200,
        headers: { 'Content-Type': 'text/plain' },
        cookies: ['session=abc'],
      })
    );
    expect(prelude.statusCode).toBe(200);
    expect(prelude.headers).toEqual({ 'Content-Type': 'text/plain' });
    expect(prelude.cookies).toEqual(['session=abc']);
  });

  it('coerces numeric-string statusCode to number', () => {
    const prelude = parseStreamingPrelude(JSON.stringify({ statusCode: '201', headers: {} }));
    expect(prelude.statusCode).toBe(201);
  });

  it('defaults headers to an empty object when missing', () => {
    const prelude = parseStreamingPrelude(JSON.stringify({ statusCode: 200 }));
    expect(prelude.headers).toEqual({});
  });

  it('coerces numeric header values to strings', () => {
    const prelude = parseStreamingPrelude(
      JSON.stringify({ statusCode: 200, headers: { 'Content-Length': 42 } })
    );
    expect(prelude.headers['Content-Length']).toBe('42');
  });

  it('drops null/undefined header values', () => {
    // JSON has no `undefined`, but null is round-trippable and represents
    // "header absent" semantically; we drop it rather than emit a literal
    // "null" header value.
    const prelude = parseStreamingPrelude(
      JSON.stringify({ statusCode: 200, headers: { Drop: null, Keep: 'yes' } })
    );
    expect(prelude.headers).toEqual({ Keep: 'yes' });
  });

  it('preserves cookies in original order', () => {
    const prelude = parseStreamingPrelude(
      JSON.stringify({ statusCode: 200, cookies: ['a=1', 'b=2', 'c=3'] })
    );
    expect(prelude.cookies).toEqual(['a=1', 'b=2', 'c=3']);
  });

  it('omits cookies when not an array', () => {
    const prelude = parseStreamingPrelude(JSON.stringify({ statusCode: 200, cookies: 'oops' }));
    expect(prelude.cookies).toBeUndefined();
  });

  it('rejects non-JSON', () => {
    expect(() => parseStreamingPrelude('not json{')).toThrow();
  });

  it('rejects empty input', () => {
    expect(() => parseStreamingPrelude('')).toThrow(/empty/);
  });

  it('rejects non-object roots', () => {
    expect(() => parseStreamingPrelude('"just a string"')).toThrow(/not a JSON object/);
    expect(() => parseStreamingPrelude('42')).toThrow(/not a JSON object/);
  });

  it('rejects non-numeric statusCode', () => {
    expect(() => parseStreamingPrelude(JSON.stringify({ statusCode: 'not-a-number' }))).toThrow(
      /statusCode/
    );
  });
});

// ---- invokeRieStreaming end-to-end (no Docker) ----

let server: Server;
let port: number;
type StreamHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
let nextStreamResponse: StreamHandler | undefined;

beforeAll(async () => {
  server = createServer((req, res) => {
    const handler = nextStreamResponse;
    if (!handler) {
      res.statusCode = 200;
      res.end('{}');
      return;
    }
    Promise.resolve()
      .then(() => handler(req, res))
      .catch(() => {
        if (!res.headersSent) res.statusCode = 500;
        if (!res.writableEnded) res.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

/** Collect a StreamingInvokeResult's body Readable into one Buffer. */
async function collectBody(result: StreamingInvokeResult): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of result.body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

describe('invokeRieStreaming', () => {
  it('parses the JSON prelude and returns a Readable carrying the body', async () => {
    nextStreamResponse = (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      const prelude = JSON.stringify({
        statusCode: 200,
        headers: { 'Content-Type': 'text/plain' },
      });
      res.write(Buffer.concat([Buffer.from(prelude), SEPARATOR]));
      res.write(Buffer.from('hello'));
      res.write(Buffer.from(' world'));
      res.end();
    };
    const result = await invokeRieStreaming('127.0.0.1', port, {}, 5000);
    expect(result.prelude.statusCode).toBe(200);
    expect(result.prelude.headers).toEqual({ 'Content-Type': 'text/plain' });
    const body = await collectBody(result);
    expect(body.toString('utf8')).toBe('hello world');
  });

  it('honors the streaming response-mode header (sent on the request)', async () => {
    let headerSeen: string | undefined;
    nextStreamResponse = (req, res) => {
      headerSeen = req.headers['lambda-runtime-function-response-mode'] as string | undefined;
      res.writeHead(200);
      const prelude = JSON.stringify({ statusCode: 200, headers: {} });
      res.end(Buffer.concat([Buffer.from(prelude), SEPARATOR, Buffer.from('x')]));
    };
    await invokeRieStreaming('127.0.0.1', port, {}, 5000);
    expect(headerSeen).toBe('streaming');
  });

  it('streams chunks incrementally — body Readable emits as RIE writes', async () => {
    // The handler writes the prelude, then writes 5 chunks each ~200ms
    // apart. We measure the wall time between chunk arrivals on the
    // consumer side — they must NOT all arrive after the response ends.
    nextStreamResponse = async (_req, res) => {
      res.writeHead(200);
      const prelude = JSON.stringify({ statusCode: 200, headers: {} });
      res.write(Buffer.concat([Buffer.from(prelude), SEPARATOR]));
      for (let i = 0; i < 3; i++) {
        res.write(Buffer.from(`c${i}|`));
        await new Promise<void>((r) => setTimeout(r, 50));
      }
      res.end();
    };
    const start = Date.now();
    const result = await invokeRieStreaming('127.0.0.1', port, {}, 5000);
    const chunkArrivalTimes: number[] = [];
    for await (const chunk of result.body) {
      void chunk;
      chunkArrivalTimes.push(Date.now() - start);
    }
    // At least 2 chunks (Node may coalesce a couple), and the LAST chunk
    // arrives well after the first — proves streaming is real (not a
    // buffered "wait for end, then emit").
    expect(chunkArrivalTimes.length).toBeGreaterThanOrEqual(2);
    const lastArrival = chunkArrivalTimes[chunkArrivalTimes.length - 1] ?? 0;
    const firstArrival = chunkArrivalTimes[0] ?? 0;
    expect(lastArrival - firstArrival).toBeGreaterThan(80);
  });

  it('handles a prelude that spans multiple chunks before the separator', async () => {
    // The reader buffers across chunks until the 8-NULL separator
    // appears — simulate a slow prelude split mid-JSON.
    nextStreamResponse = async (_req, res) => {
      res.writeHead(200);
      const prelude = JSON.stringify({
        statusCode: 202,
        headers: { 'X-Test': 'split' },
      });
      // Send first half, wait, then the rest + separator + body.
      const half = Math.floor(prelude.length / 2);
      res.write(Buffer.from(prelude.slice(0, half)));
      await new Promise<void>((r) => setTimeout(r, 20));
      res.write(Buffer.from(prelude.slice(half)));
      res.write(SEPARATOR);
      res.write(Buffer.from('payload'));
      res.end();
    };
    const result = await invokeRieStreaming('127.0.0.1', port, {}, 5000);
    expect(result.prelude.statusCode).toBe(202);
    expect(result.prelude.headers).toEqual({ 'X-Test': 'split' });
    const body = await collectBody(result);
    expect(body.toString('utf8')).toBe('payload');
  });

  it('returns body bytes that share the same chunk as the separator', async () => {
    // Critical edge case: the separator and the leading body bytes
    // arrive in the SAME network chunk. The reader must surface those
    // tail bytes on the body Readable, not drop them.
    nextStreamResponse = (_req, res) => {
      res.writeHead(200);
      const prelude = JSON.stringify({ statusCode: 200, headers: {} });
      res.end(Buffer.concat([Buffer.from(prelude), SEPARATOR, Buffer.from('immediate')]));
    };
    const result = await invokeRieStreaming('127.0.0.1', port, {}, 5000);
    const body = await collectBody(result);
    expect(body.toString('utf8')).toBe('immediate');
  });

  it('returns an empty body when the handler produces no body bytes', async () => {
    nextStreamResponse = (_req, res) => {
      res.writeHead(200);
      const prelude = JSON.stringify({ statusCode: 204, headers: {} });
      res.end(Buffer.concat([Buffer.from(prelude), SEPARATOR]));
    };
    const result = await invokeRieStreaming('127.0.0.1', port, {}, 5000);
    expect(result.prelude.statusCode).toBe(204);
    const body = await collectBody(result);
    expect(body.length).toBe(0);
  });

  it('rejects when the response ends with zero bytes (handler crashed pre-write)', async () => {
    // Genuinely empty response — RIE emitted nothing, handler threw before
    // any output. Issue #664: rejected with a clear pointer to container logs
    // (where the real error trace lives).
    nextStreamResponse = (_req, res) => {
      res.writeHead(200);
      res.end();
    };
    await expect(invokeRieStreaming('127.0.0.1', port, {}, 5000)).rejects.toThrow(/zero bytes/);
  });

  it('synthesizes a default prelude when the handler emits bytes without a separator (setContentType pattern)', async () => {
    // Issue #664: a handler wrapped by `awslambda.streamifyResponse(...)` that
    // uses `responseStream.setContentType(...)` + `responseStream.write(...)`
    // WITHOUT explicitly calling `awslambda.HttpResponseStream.from(...)` —
    // the documented AWS Lambda streaming shortcut — produces NO 8-NULL
    // prelude separator on the RIE wire. Production AWS Lambda accepts this;
    // pre-#664 cdkd rejected the invocation. Post-fix: cdkd synthesizes a
    // default 200 / application/octet-stream prelude and surfaces every
    // received byte as the body so the dev's handler runs locally as it does
    // in production.
    nextStreamResponse = (_req, res) => {
      res.writeHead(200);
      // SSE-style body the handler wrote — NO prelude, NO separator,
      // just raw bytes.
      res.end(Buffer.from('data: {"hello":"world"}\n\n'));
    };
    const result = await invokeRieStreaming('127.0.0.1', port, {}, 5000);
    expect(result.prelude.statusCode).toBe(200);
    expect(result.prelude.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
    const body = await collectBody(result);
    expect(body.toString('utf8')).toBe('data: {"hello":"world"}\n\n');
  });

  it('synthesizes default prelude even when buffered bytes look like a partial JSON attempt', async () => {
    // Companion to the setContentType test: even when the buffered bytes
    // happen to LOOK like a partial JSON prelude attempt, surface them as
    // body rather than reject. The Lambda error envelope shape
    // (`{"errorType":...}`) lives in this space — the dev gets it back in
    // the response body verbatim, which is the right diagnostic outcome.
    nextStreamResponse = (_req, res) => {
      res.writeHead(200);
      res.end(Buffer.from('{"errorType":"InternalError","errorMessage":"boom"}'));
    };
    const result = await invokeRieStreaming('127.0.0.1', port, {}, 5000);
    expect(result.prelude.statusCode).toBe(200);
    expect(result.prelude.headers).toEqual({ 'Content-Type': 'application/octet-stream' });
    const body = await collectBody(result);
    expect(body.toString('utf8')).toBe('{"errorType":"InternalError","errorMessage":"boom"}');
  });

  it('rejects when the prelude is not valid JSON', async () => {
    nextStreamResponse = (_req, res) => {
      res.writeHead(200);
      res.end(Buffer.concat([Buffer.from('not-json{'), SEPARATOR, Buffer.from('body')]));
    };
    await expect(invokeRieStreaming('127.0.0.1', port, {}, 5000)).rejects.toThrow(/not valid JSON/);
  });

  // ---- issue #2203: the rejection must not echo the bytes it parsed ----
  //
  // The split above scans the WHOLE response for an 8-NUL run, and the #664
  // block in `rie-client.ts` records that the commonest handler shape in the
  // wild (`streamifyResponse` + `setContentType`/`write`, never calling
  // `HttpResponseStream.from`) emits NO framing -- so what gets scanned is
  // raw function OUTPUT. Any 8-NUL run inside binary output therefore matches
  // spuriously and hands `preludeBytes` a slice of application data, which
  // V8 then quotes back in `SyntaxError.message`.
  //
  // Both cases assert POSITIVES alongside the negative: "the needle is
  // absent" alone is satisfied by any unrelated rejection.

  async function streamingRejectionMessage(payload: Buffer): Promise<string> {
    nextStreamResponse = (_req, res) => {
      res.writeHead(200);
      res.end(payload);
    };
    try {
      await invokeRieStreaming('127.0.0.1', port, {}, 5000);
    } catch (err) {
      return (err as Error).message;
    }
    expect.fail('invokeRieStreaming should have rejected on an unparseable prelude');
  }

  it('withholds the ~10-character prefix V8 quotes from a spurious NUL match in binary output', async () => {
    // A tar stream is the sharpest instance: its 512-byte member header
    // NUL-pads everything after the 100-byte name field, so the FIRST 8-NUL
    // run sits immediately after the file name. `preludeBytes` becomes that
    // name, and on the pinned Node 24.15 the parser answers
    // `Unexpected token 'c', "customer-d"... is not valid JSON`.
    const name = 'customer-database-dump.sql';
    const tarHeader = Buffer.alloc(512);
    tarHeader.write(name, 0, 'utf8');
    const message = await streamingRejectionMessage(
      Buffer.concat([tarHeader, Buffer.from('...archive payload...')])
    );

    // The needle is the PREFIX, not the whole name: `not.toContain(name)`
    // would pass WITHOUT the fix, since V8 never emits past its window.
    expect(message).not.toContain('customer-d');
    // Also fence the parser's PHRASING: stripping only the quoted segment
    // still leaks the first byte and the offset.
    expect(message).not.toContain('Unexpected token');
    // Deliberately NOT `not.toContain(name)`: vacuous at this length, since
    // V8 never emits past its prefix window. The full-quote shape is covered
    // by the short-prelude case below, where that assertion discriminates.

    expect(message).toContain('prelude is not valid JSON');
    expect(message).toContain('SyntaxError');
    // Anchored on both sides: a bare `26 bytes before` is a substring of
    // `126 bytes before`, so an inflated count would pass unnoticed.
    expect(message).toContain(`; ${name.length} bytes before the 8-NUL separator`);
    // Anchored to the REMEDIATION sentence, not the bare symbol: the
    // diagnosis sentence above it also names `HttpResponseStream.from`, so a
    // bare `toContain('HttpResponseStream.from')` stayed green with the hint
    // deleted -- confirmed by mutation probe R5.
    expect(message).toContain('calling HttpResponseStream.from(...) frames the response explicitly');
  });

  it('counts BYTES, not UTF-16 code units, in the reported prelude size', async () => {
    // The other fixtures are pure ASCII, where the two counts coincide -- so
    // a mutation to `preludeBytes.toString('utf8').length` survives them.
    // Four 3-byte characters are 12 bytes and 4 code units.
    const multibyte = '\u3042\u3044\u3046\u3048';
    const preludeBuf = Buffer.from(multibyte, 'utf8');
    expect(preludeBuf.length).toBe(12);
    expect(multibyte.length).toBe(4);

    const message = await streamingRejectionMessage(
      Buffer.concat([preludeBuf, SEPARATOR, Buffer.from('body')])
    );
    expect(message).toContain('; 12 bytes before the 8-NUL separator');
    expect(message).not.toContain('; 4 bytes before the 8-NUL separator');
    expect(message).not.toContain(multibyte);
    expect(message).not.toContain('Unexpected token');
  });

  // --- the three input-INDEPENDENT throws must stay legible -------------
  //
  // `parseStreamingPrelude` throws four ways and only the `JSON.parse` one
  // carries the parsed bytes. Suppressing the other three buys no privacy
  // and ships a FALSE diagnosis -- a correctly-framed handler being told its
  // valid JSON is "not valid JSON", with advice to call a function it
  // already called. These fence the `err instanceof SyntaxError` gate, and
  // they have to run through `invokeRieStreaming`: the suppression lives at
  // the CALLER, so the direct `parseStreamingPrelude` cases above cannot
  // see it.

  it('keeps the non-object-prelude diagnosis verbatim (valid JSON, wrong shape)', async () => {
    const message = await streamingRejectionMessage(
      Buffer.concat([Buffer.from('"a string"'), SEPARATOR, Buffer.from('body')])
    );

    expect(message).toContain('RIE streaming response prelude is invalid:');
    expect(message).toContain('prelude is not a JSON object');
    // The false diagnosis this gate exists to prevent.
    expect(message).not.toContain('is not valid JSON');
    expect(message).not.toContain('HttpResponseStream.from');
  });

  it('keeps the statusCode diagnosis verbatim (valid JSON object, bad statusCode)', async () => {
    const message = await streamingRejectionMessage(
      Buffer.concat([Buffer.from('{"foo":1}'), SEPARATOR, Buffer.from('body')])
    );

    expect(message).toContain('RIE streaming response prelude is invalid:');
    expect(message).toContain('statusCode must be a number');
    expect(message).toContain('got undefined');
    expect(message).not.toContain('is not valid JSON');
    expect(message).not.toContain('HttpResponseStream.from');
  });

  it('keeps the empty-prelude diagnosis verbatim', async () => {
    // Whitespace-only bytes before the separator: non-empty, so the
    // synthesized-prelude path is not taken, but `trim()` empties it.
    const message = await streamingRejectionMessage(
      Buffer.concat([Buffer.from('   '), SEPARATOR, Buffer.from('body')])
    );

    expect(message).toContain('RIE streaming response prelude is invalid:');
    expect(message).toContain('empty prelude');
    expect(message).not.toContain('is not valid JSON');
    expect(message).not.toContain('HttpResponseStream.from');
  });

  it('withholds a SHORT prelude, which V8 quotes in FULL rather than truncating', async () => {
    // Second leak shape: V8 appends `...` only past its prefix window, so
    // `JSON.parse('not-json{')` quotes the whole string. A guard written only
    // against the truncated shape would miss this one.
    const bogus = 'not-json{';
    const message = await streamingRejectionMessage(
      Buffer.concat([Buffer.from(bogus), SEPARATOR, Buffer.from('body')])
    );

    expect(message).not.toContain(bogus);
    expect(message).not.toContain('Unexpected token');

    expect(message).toContain('prelude is not valid JSON');
    expect(message).toContain('SyntaxError');
    expect(message).toContain(`; ${bogus.length} bytes before the 8-NUL separator`);
  });

  it('forwards the event JSON in the request body', async () => {
    let received = '';
    nextStreamResponse = async (req, res) => {
      for await (const chunk of req) received += (chunk as Buffer).toString();
      res.writeHead(200);
      res.end(Buffer.concat([Buffer.from('{"statusCode":200}'), SEPARATOR]));
    };
    await invokeRieStreaming('127.0.0.1', port, { foo: 'bar' }, 5000);
    expect(received).toBe(JSON.stringify({ foo: 'bar' }));
  });

  it('rejects when the prelude exceeds the 1 MiB safety cap', async () => {
    // The cap is the "handler didn't call HttpResponseStream.from" trap:
    // without the separator, the reader would buffer the entire response
    // body looking for it. 1 MiB is far past any reasonable prelude.
    // Stream `BIG_LEN` bytes of garbage, NO separator. The helper must
    // bail before OOM.
    const BIG_LEN = 1.2 * 1024 * 1024;
    nextStreamResponse = async (_req, res) => {
      res.writeHead(200);
      // Write in chunks so the helper has multiple read() calls to land
      // on before hitting the cap.
      const chunk = Buffer.alloc(64 * 1024, 0x41); // 'A' * 64KB, no NULs
      const chunks = Math.ceil(BIG_LEN / chunk.length);
      for (let i = 0; i < chunks; i++) {
        if (!res.write(chunk)) {
          await new Promise<void>((r) => res.once('drain', () => r()));
        }
      }
      res.end();
    };
    await expect(invokeRieStreaming('127.0.0.1', port, {}, 10000)).rejects.toThrow(
      /did not emit the prelude\/body separator/
    );
  });

  it('destroys the body Readable with a clear error when STREAM_BODY_MAX_BYTES is exceeded (issue #503 item 2)', async () => {
    // Sanity-check the exported cap so a future code change that lowers
    // the default surfaces here.
    expect(STREAM_BODY_MAX_BYTES).toBe(100 * 1024 * 1024);

    // Send prelude + body bytes that overshoot the cap. The Readable
    // must destroy itself with the cap-exceeded error rather than
    // pushing the entire body. 100 MiB writes in under a second on
    // loopback so this stays a fast unit test.
    const cap = STREAM_BODY_MAX_BYTES;
    const overshoot = 64 * 1024; // 64 KiB past the cap
    nextStreamResponse = async (_req, res) => {
      res.writeHead(200);
      const prelude = JSON.stringify({ statusCode: 200, headers: {} });
      res.write(Buffer.concat([Buffer.from(prelude), SEPARATOR]));
      // 4 MiB chunks keep the writev queue manageable while writing
      // ~25 of them to clear the cap.
      const chunkBytes = 4 * 1024 * 1024;
      const totalBytes = cap + overshoot;
      const chunk = Buffer.alloc(chunkBytes, 0x41);
      let sent = 0;
      while (sent < totalBytes) {
        if (!res.write(chunk)) {
          await new Promise<void>((r) => res.once('drain', () => r()));
        }
        sent += chunkBytes;
      }
      res.end();
    };
    const result = await invokeRieStreaming('127.0.0.1', port, {}, 30000);
    // Consume the body and assert it errors out at the cap.
    const consume = async (): Promise<void> => {
      for await (const _ of result.body) {
        // drain
      }
    };
    await expect(consume()).rejects.toThrow(/streaming body exceeded/i);
  }, 60000);
});
