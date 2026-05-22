import { describe, expect, it } from 'vite-plus/test';
import {
  buildConnectEvent,
  buildDisconnectEvent,
  buildMessageEvent,
  type WebSocketHandshakeSnapshot,
} from '../../../src/local/websocket-event.js';

const baseSnapshot: WebSocketHandshakeSnapshot = {
  headers: {
    'Sec-WebSocket-Protocol': ['chat.v1'],
    'X-Forwarded-For': ['10.0.0.1', '10.0.0.2'],
  },
  rawQueryString: 'auth=token&id=42',
  queryStringParameters: { auth: 'token', id: '42' },
  multiValueQueryStringParameters: { auth: ['token'], id: ['42'] },
  sourceIp: '127.0.0.1',
  userAgent: 'wscat/1.0',
};

describe('buildConnectEvent', () => {
  it('produces a CONNECT event with lowercased headers and stable request context', () => {
    const event = buildConnectEvent({
      connectionId: 'conn-1',
      connectedAt: 1_700_000_000_000,
      stage: 'prod',
      snapshot: baseSnapshot,
    });

    expect(event.body).toBe('');
    expect(event.isBase64Encoded).toBe(false);
    expect(event.headers?.['sec-websocket-protocol']).toBe('chat.v1');
    expect(event.headers?.['x-forwarded-for']).toBe('10.0.0.1,10.0.0.2');
    expect(event.multiValueHeaders?.['x-forwarded-for']).toEqual(['10.0.0.1', '10.0.0.2']);
    expect(event.queryStringParameters).toEqual({ auth: 'token', id: '42' });

    expect(event.requestContext.eventType).toBe('CONNECT');
    expect(event.requestContext.routeKey).toBe('$connect');
    expect(event.requestContext.connectionId).toBe('conn-1');
    expect(event.requestContext.connectedAt).toBe(1_700_000_000_000);
    expect(event.requestContext.stage).toBe('prod');
    expect(event.requestContext.apiId).toBe('local');
    expect(event.requestContext.domainName).toBe('localhost');
    expect(event.requestContext.authorizer).toBeNull();
    expect(event.requestContext.identity.sourceIp).toBe('127.0.0.1');
    expect(event.requestContext.identity.userAgent).toBe('wscat/1.0');
    expect(event.requestContext.messageDirection).toBe('IN');
    expect(typeof event.requestContext.requestId).toBe('string');
    expect(event.requestContext.requestId.length).toBeGreaterThan(0);
    expect(event.requestContext.requestId).not.toBe(event.requestContext.extendedRequestId);
  });

  it('falls back to 127.0.0.1 + empty UA when snapshot omits them', () => {
    const event = buildConnectEvent({
      connectionId: 'conn-2',
      connectedAt: 0,
      stage: 'local',
      snapshot: { headers: {}, rawQueryString: '' },
    });
    expect(event.headers).toBeUndefined();
    expect(event.multiValueHeaders).toBeUndefined();
    expect(event.queryStringParameters).toBeNull();
    expect(event.multiValueQueryStringParameters).toBeNull();
    expect(event.requestContext.identity.sourceIp).toBe('127.0.0.1');
    expect(event.requestContext.identity.userAgent).toBe('');
  });

  it('formats requestTime in AWS dd/MMM/yyyy:HH:mm:ss +0000 shape', () => {
    const event = buildConnectEvent({
      connectionId: 'c',
      connectedAt: 0,
      stage: 'local',
      snapshot: baseSnapshot,
    });
    expect(event.requestContext.requestTime).toMatch(
      /^\d{2}\/[A-Z][a-z]{2}\/\d{4}:\d{2}:\d{2}:\d{2} \+0000$/
    );
  });
});

describe('buildMessageEvent', () => {
  it('produces a MESSAGE event with the resolved routeKey and messageId', () => {
    const event = buildMessageEvent({
      connectionId: 'c',
      connectedAt: 1,
      stage: 'prod',
      snapshot: baseSnapshot,
      routeKey: 'sendMessage',
      body: '{"hello":"world"}',
    });
    expect(event.requestContext.eventType).toBe('MESSAGE');
    expect(event.requestContext.routeKey).toBe('sendMessage');
    expect(event.body).toBe('{"hello":"world"}');
    expect(typeof event.requestContext['messageId']).toBe('string');
  });

  it('passes through binary body strings (caller already encoded)', () => {
    const event = buildMessageEvent({
      connectionId: 'c',
      connectedAt: 1,
      stage: 'prod',
      snapshot: baseSnapshot,
      routeKey: '$default',
      body: 'aGVsbG8=',
    });
    expect(event.body).toBe('aGVsbG8=');
    expect(event.requestContext.routeKey).toBe('$default');
  });
});

describe('buildDisconnectEvent', () => {
  it('produces a DISCONNECT event with status code + reason from close frame', () => {
    const event = buildDisconnectEvent({
      connectionId: 'c',
      connectedAt: 100,
      stage: 'prod',
      snapshot: baseSnapshot,
      disconnectStatusCode: 1001,
      disconnectReason: 'going-away',
    });
    expect(event.requestContext.eventType).toBe('DISCONNECT');
    expect(event.requestContext.routeKey).toBe('$disconnect');
    expect(event.requestContext['disconnectStatusCode']).toBe(1001);
    expect(event.requestContext['disconnectReason']).toBe('going-away');
    expect(event.body).toBe('');
  });

  it('omits status code / reason when not provided', () => {
    const event = buildDisconnectEvent({
      connectionId: 'c',
      connectedAt: 100,
      stage: 'prod',
      snapshot: baseSnapshot,
    });
    expect(event.requestContext['disconnectStatusCode']).toBeUndefined();
    expect(event.requestContext['disconnectReason']).toBeUndefined();
  });
});
