import { describe, expect, it } from 'vite-plus/test';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import {
  buildMgmtEndpointEnvUrl,
  ConnectionRegistry,
  handleConnectionsRequest,
  parseConnectionsPath,
  readRequestBody,
  type ConnectionRegistryEntry,
} from '../../../src/local/websocket-mgmt-api.js';
import type { WebSocket } from 'ws';

/**
 * Minimal in-memory WebSocket fake — the management-API code calls
 * .send / .close / reads .readyState / .OPEN, nothing else.
 */
class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readyState = 1;
  sent: Array<Buffer | string> = [];
  closed: { code?: number; reason?: string } | null = null;
  send(payload: Buffer | string): void {
    this.sent.push(payload);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = this.CLOSING;
  }
}

function newRequest(method: string, url: string, body?: string): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.method = method;
  req.url = url;
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(body, 'utf-8'));
      req.emit('end');
    });
  } else {
    process.nextTick(() => req.emit('end'));
  }
  return req;
}

function newResponse(): {
  res: ServerResponse;
  status: () => number;
  body: () => string;
  headers: () => Record<string, string | number | string[]>;
} {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  const res = new ServerResponse(req);
  const chunks: Buffer[] = [];
  // Catch write/end output for inspection.
  const origWrite = res.write.bind(res);
  res.write = ((chunk: Buffer | string) => {
    if (Buffer.isBuffer(chunk)) chunks.push(chunk);
    else chunks.push(Buffer.from(chunk));
    return origWrite(chunk);
  }) as typeof res.write;
  const origEnd = res.end.bind(res);
  res.end = ((chunk?: Buffer | string) => {
    if (chunk) {
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
      else chunks.push(Buffer.from(chunk));
    }
    return origEnd();
  }) as typeof res.end;
  return {
    res,
    status: () => res.statusCode,
    body: () => Buffer.concat(chunks).toString('utf-8'),
    headers: () =>
      res.getHeaders() as unknown as Record<string, string | number | string[]>,
  };
}

describe('parseConnectionsPath', () => {
  it('matches /@connections/<id>', () => {
    expect(parseConnectionsPath('/@connections/abc-123')).toEqual({ connectionId: 'abc-123' });
  });
  it('matches /@connections/<id>/ (trailing slash)', () => {
    expect(parseConnectionsPath('/@connections/abc-123/')).toEqual({ connectionId: 'abc-123' });
  });
  it('strips ?query', () => {
    expect(parseConnectionsPath('/@connections/abc?Action=PostToConnection')).toEqual({
      connectionId: 'abc',
    });
  });
  it('decodes URL-encoded connection ids', () => {
    expect(parseConnectionsPath('/@connections/conn%2Bid')).toEqual({ connectionId: 'conn+id' });
  });
  it('returns null for non-matching URLs', () => {
    expect(parseConnectionsPath('/users/abc')).toBeNull();
    expect(parseConnectionsPath('/@connections')).toBeNull();
    expect(parseConnectionsPath('/@connections/')).toBeNull();
  });
  it('returns null for malformed percent-escapes', () => {
    expect(parseConnectionsPath('/@connections/abc%2x')).toBeNull();
  });

  // B1 (#526): AWS-docs-canonical handler shape calls
  // `POST /<stage>/@connections/<id>`, where <stage> matches the
  // deployed apigatewaymanagementapi endpoint URL. The pre-fix regex
  // rejected this shape and SDK calls built from `domainName + stage`
  // hit a 404 against the local mgmt API. Verify the new accepted
  // shapes work end-to-end.
  it('matches /<stage>/@connections/<id> (AWS-docs-canonical with stage prefix)', () => {
    expect(parseConnectionsPath('/prod/@connections/abc-123')).toEqual({
      connectionId: 'abc-123',
    });
    expect(parseConnectionsPath('/dev/@connections/abc-123')).toEqual({
      connectionId: 'abc-123',
    });
    expect(parseConnectionsPath('/local/@connections/abc-123')).toEqual({
      connectionId: 'abc-123',
    });
  });
  it('matches /<stage>/@connections/<id>/ (stage prefix + trailing slash)', () => {
    expect(parseConnectionsPath('/prod/@connections/abc-123/')).toEqual({
      connectionId: 'abc-123',
    });
  });
  it('matches /<stage>/@connections/<id>?query (stage prefix + query string)', () => {
    expect(
      parseConnectionsPath('/prod/@connections/abc?Action=PostToConnection')
    ).toEqual({
      connectionId: 'abc',
    });
  });
  it('decodes URL-encoded connection ids when stage prefix is present', () => {
    expect(parseConnectionsPath('/prod/@connections/conn%2Bid')).toEqual({
      connectionId: 'conn+id',
    });
  });
  it('still rejects two-segment paths without @connections', () => {
    expect(parseConnectionsPath('/prod/users/abc')).toBeNull();
    expect(parseConnectionsPath('/prod/@conn/abc')).toBeNull();
  });
  it('rejects multi-segment stage prefixes (only ONE segment before @connections)', () => {
    // Two segments before @connections — would match if regex allowed
    // greedy prefixes, but we only accept ONE optional segment.
    expect(parseConnectionsPath('/v1/prod/@connections/abc')).toBeNull();
  });

  // Issue #537 item 9: B1 regex edge cases. These all flow through
  // `^/(?:[^/]+/)?@connections/([^/]+)/?$` — pin the behavior so a
  // regex rewrite in the future surfaces the change in CI.
  it('rejects double-slash before @connections (empty stage segment)', () => {
    // `//@connections/abc` reads as stage='' under a permissive prefix.
    // Our regex requires `[^/]+/` (>=1 char) so this correctly fails.
    expect(parseConnectionsPath('//@connections/abc')).toBeNull();
  });
  it('rejects a trailing path segment after the connection id', () => {
    // `/@connections/abc/extra` — the trailing `/extra` is unknown to
    // the AWS API plane and must not be silently truncated.
    expect(parseConnectionsPath('/@connections/abc/extra')).toBeNull();
    expect(parseConnectionsPath('/prod/@connections/abc/extra')).toBeNull();
  });
  it('matches a single trailing slash with no stage prefix', () => {
    // Already covered above; pinned here as a sibling assertion to the
    // stage-prefix + trailing-slash test for the no-stage form.
    expect(parseConnectionsPath('/@connections/abc/')).toEqual({ connectionId: 'abc' });
  });
});

// Issue #537 item 7: assert the Lambda-container env-var URL includes
// `/<stage>`. The pre-fix CLI dropped the stage segment and any
// SDK-built `POST /<stage>/@connections/<id>` hit a 404 against the
// local parser. Producer (this helper) + consumer
// (parseConnectionsPath) live in lockstep — a regression here would
// re-introduce the 404.
describe('buildMgmtEndpointEnvUrl', () => {
  it('produces http://<host>:<port>/<stage> with the stage suffix', () => {
    expect(buildMgmtEndpointEnvUrl('host.docker.internal', 4001, 'prod')).toBe(
      'http://host.docker.internal:4001/prod'
    );
  });
  it('does NOT drop the stage suffix (B1 #526 regression guard)', () => {
    const url = buildMgmtEndpointEnvUrl('host.docker.internal', 4001, 'prod');
    expect(url.endsWith('/prod')).toBe(true);
  });
  it('output is parseable end-to-end by parseConnectionsPath', () => {
    // Simulate the round-trip: SDK builds the per-connection URL from
    // the env-var endpoint + the AWS-deployed shape; the local server
    // must accept it. Pins the producer/consumer contract on one test.
    const env = buildMgmtEndpointEnvUrl('host.docker.internal', 4001, 'prod');
    const stagePath = new URL(env).pathname; // '/prod'
    const sdkPath = `${stagePath}/@connections/conn-1`; // '/prod/@connections/conn-1'
    expect(parseConnectionsPath(sdkPath)).toEqual({ connectionId: 'conn-1' });
  });
});

describe('ConnectionRegistry', () => {
  it('registers + retrieves + unregisters connections', () => {
    const reg = new ConnectionRegistry();
    const socket = new FakeWebSocket() as unknown as WebSocket;
    const entry: ConnectionRegistryEntry = {
      connectionId: 'c1',
      socket,
      connectedAt: 100,
      apiLogicalId: 'WsApi',
      stage: 'prod',
    };
    reg.register(entry);
    expect(reg.get('c1')).toBe(entry);
    expect(reg.size()).toBe(1);
    const removed = reg.unregister('c1');
    expect(removed).toBe(entry);
    expect(reg.size()).toBe(0);
    expect(reg.get('c1')).toBeUndefined();
  });

  it('unregister returns undefined for an unknown id', () => {
    const reg = new ConnectionRegistry();
    expect(reg.unregister('nope')).toBeUndefined();
  });

  it('list returns a snapshot', () => {
    const reg = new ConnectionRegistry();
    const s1 = new FakeWebSocket() as unknown as WebSocket;
    const s2 = new FakeWebSocket() as unknown as WebSocket;
    reg.register({ connectionId: 'a', socket: s1, connectedAt: 1, apiLogicalId: 'X', stage: 's' });
    reg.register({ connectionId: 'b', socket: s2, connectedAt: 2, apiLogicalId: 'X', stage: 's' });
    expect(reg.list()).toHaveLength(2);
  });
});

describe('readRequestBody', () => {
  it('collects body chunks into a buffer', async () => {
    const req = newRequest('POST', '/x', 'hello');
    const buf = await readRequestBody(req);
    expect(buf.toString('utf-8')).toBe('hello');
  });
  it('returns empty buffer for no body', async () => {
    const req = newRequest('GET', '/x');
    const buf = await readRequestBody(req);
    expect(buf.length).toBe(0);
  });
});

describe('handleConnectionsRequest', () => {
  it('returns 410 GoneException for an unknown connection on POST', async () => {
    const reg = new ConnectionRegistry();
    const req = newRequest('POST', '/@connections/missing', 'hi');
    const { res, status, body } = newResponse();
    await handleConnectionsRequest({ req, res, registry: reg });
    expect(status()).toBe(410);
    expect(JSON.parse(body())).toEqual({ message: 'GoneException' });
  });

  it('delivers POST body to the connection socket on success', async () => {
    const reg = new ConnectionRegistry();
    const socket = new FakeWebSocket();
    reg.register({
      connectionId: 'c1',
      socket: socket as unknown as WebSocket,
      connectedAt: 0,
      apiLogicalId: 'X',
      stage: 's',
    });
    const req = newRequest('POST', '/@connections/c1', 'payload-bytes');
    const { res, status } = newResponse();
    await handleConnectionsRequest({ req, res, registry: reg });
    expect(status()).toBe(200);
    expect(socket.sent).toHaveLength(1);
    expect((socket.sent[0] as Buffer).toString('utf-8')).toBe('payload-bytes');
  });

  it('returns 410 when the socket is not in OPEN state', async () => {
    const reg = new ConnectionRegistry();
    const socket = new FakeWebSocket();
    socket.readyState = 2;
    reg.register({
      connectionId: 'c1',
      socket: socket as unknown as WebSocket,
      connectedAt: 0,
      apiLogicalId: 'X',
      stage: 's',
    });
    const req = newRequest('POST', '/@connections/c1', 'bytes');
    const { res, status, body } = newResponse();
    await handleConnectionsRequest({ req, res, registry: reg });
    expect(status()).toBe(410);
    expect(JSON.parse(body()).message).toBe('GoneException');
  });

  it('DELETE closes the socket with code 1000 and returns 204', async () => {
    const reg = new ConnectionRegistry();
    const socket = new FakeWebSocket();
    reg.register({
      connectionId: 'c1',
      socket: socket as unknown as WebSocket,
      connectedAt: 0,
      apiLogicalId: 'X',
      stage: 's',
    });
    const req = newRequest('DELETE', '/@connections/c1');
    const { res, status } = newResponse();
    await handleConnectionsRequest({ req, res, registry: reg });
    expect(status()).toBe(204);
    expect(socket.closed?.code).toBe(1000);
  });

  it('GET returns 200 + synthetic metadata for a live connection', async () => {
    const reg = new ConnectionRegistry();
    const socket = new FakeWebSocket();
    reg.register({
      connectionId: 'c1',
      socket: socket as unknown as WebSocket,
      connectedAt: 1_700_000_000_000,
      apiLogicalId: 'X',
      stage: 's',
    });
    const req = newRequest('GET', '/@connections/c1');
    const { res, status, body } = newResponse();
    await handleConnectionsRequest({ req, res, registry: reg });
    expect(status()).toBe(200);
    const parsed = JSON.parse(body());
    expect(typeof parsed.ConnectedAt).toBe('string');
    expect(parsed.Identity).toEqual({ SourceIp: '127.0.0.1' });
    expect(typeof parsed.LastActiveAt).toBe('string');
  });

  it('returns 405 with Allow header on unsupported methods', async () => {
    const reg = new ConnectionRegistry();
    const socket = new FakeWebSocket();
    reg.register({
      connectionId: 'c1',
      socket: socket as unknown as WebSocket,
      connectedAt: 0,
      apiLogicalId: 'X',
      stage: 's',
    });
    const req = newRequest('PATCH', '/@connections/c1');
    const { res, status, headers } = newResponse();
    await handleConnectionsRequest({ req, res, registry: reg });
    expect(status()).toBe(405);
    expect(headers()['allow']).toBe('POST, GET, DELETE');
  });

  it('returns 404 when the URL is not under /@connections/', async () => {
    const reg = new ConnectionRegistry();
    const req = newRequest('POST', '/other/path');
    const { res, status } = newResponse();
    await handleConnectionsRequest({ req, res, registry: reg });
    expect(status()).toBe(404);
  });
});
