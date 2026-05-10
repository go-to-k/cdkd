import { createServer, type Server } from 'node:http';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { invokeRie, waitForRieReady } from '../../../src/local-invoke/rie-client.js';

let server: Server;
let port: number;
let nextResponse: (req: { body: string }) => { status: number; body: string };

beforeAll(async () => {
  // Stand up a tiny HTTP server that mimics the RIE Invoke endpoint so
  // these tests don't need Docker. Each test installs its own response
  // builder via `nextResponse`.
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const handler = nextResponse ?? ((): { status: number; body: string } => ({ status: 200, body: '{}' }));
      const out = handler({ body });
      res.statusCode = out.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server has no address');
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve()))
  );
});

describe('waitForRieReady', () => {
  it('returns once the port accepts connections', async () => {
    await expect(waitForRieReady('127.0.0.1', port, 2000)).resolves.toBeUndefined();
  });

  it('throws after the deadline when the port is closed', async () => {
    // Port 1 is reserved (tcpmux) and almost always refused. Use a
    // never-listening high port instead so the test is deterministic.
    await expect(waitForRieReady('127.0.0.1', 1, 200)).rejects.toThrow(/did not become ready/);
  });

  it('does not return until the HTTP listener is up (not just the TCP forwarder)', async () => {
    // Models the Docker-port-forwarder race: a TCP server that accepts
    // connections but immediately resets them, never speaking HTTP. The
    // pre-fix tcp-only readiness check would treat this as ready and
    // the next invokeRie call would land with "fetch failed" / ECONNRESET.
    // Post-fix the HTTP probe exercises the same verb as the real invoke,
    // so we never see a green readiness signal here and the deadline
    // expires.
    const tcpServer: TcpServer = createTcpServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve));
    const address = tcpServer.address();
    if (!address || typeof address === 'string') throw new Error('tcp server has no address');
    try {
      await expect(waitForRieReady('127.0.0.1', address.port, 300)).rejects.toThrow(
        /did not become ready/
      );
    } finally {
      await new Promise<void>((resolve, reject) =>
        tcpServer.close((err) => (err ? reject(err) : resolve()))
      );
    }
  });
});

describe('invokeRie', () => {
  it('parses a JSON response body', async () => {
    nextResponse = () => ({ status: 200, body: JSON.stringify({ statusCode: 200, ok: true }) });
    const result = await invokeRie('127.0.0.1', port, { foo: 'bar' }, 5000);
    expect(result.payload).toEqual({ statusCode: 200, ok: true });
  });

  it('falls back to the raw body for non-JSON responses', async () => {
    nextResponse = () => ({ status: 200, body: 'plain-text' });
    const result = await invokeRie('127.0.0.1', port, {}, 5000);
    expect(result.payload).toBe('plain-text');
    expect(result.raw).toBe('plain-text');
  });

  it('forwards the event JSON in the request body', async () => {
    let received = '';
    nextResponse = (req) => {
      received = req.body;
      return { status: 200, body: '{}' };
    };
    await invokeRie('127.0.0.1', port, { hello: 'world' }, 5000);
    expect(received).toBe(JSON.stringify({ hello: 'world' }));
  });

  it('throws a friendly error when the server is unreachable', async () => {
    await expect(invokeRie('127.0.0.1', 1, {}, 200)).rejects.toThrow();
  });
});
