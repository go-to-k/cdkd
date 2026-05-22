import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  invokeRieStreaming,
  parseStreamingPrelude,
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

  it('rejects when the response ends before the separator arrives', async () => {
    nextStreamResponse = (_req, res) => {
      res.writeHead(200);
      // Send only part of the prelude — no separator, no body.
      res.end(Buffer.from('{"statusCode":200,"headers":{}'));
    };
    await expect(invokeRieStreaming('127.0.0.1', port, {}, 5000)).rejects.toThrow(
      /ended before the prelude/
    );
  });

  it('rejects when the prelude is not valid JSON', async () => {
    nextStreamResponse = (_req, res) => {
      res.writeHead(200);
      res.end(Buffer.concat([Buffer.from('not-json{'), SEPARATOR, Buffer.from('body')]));
    };
    await expect(invokeRieStreaming('127.0.0.1', port, {}, 5000)).rejects.toThrow(/not valid JSON/);
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
});
