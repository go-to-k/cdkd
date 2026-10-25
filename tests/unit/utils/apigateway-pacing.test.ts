/**
 * Client-side pacing for the API Gateway control plane
 * (`src/utils/apigateway-pacing.ts`): the slot arithmetic, and a REAL
 * `APIGatewayClient` against a stub HTTP handler to pin that the middleware
 * sits inside the SDK's retry loop on the SDK version this repo pins.
 */
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { APIGatewayClient, CreateResourceCommand, GetRestApiCommand } from '@aws-sdk/client-api-gateway';
import {
  API_GATEWAY_MAX_ATTEMPTS,
  ApiGatewayPacer,
  apiGatewayPacerFor,
  resetApiGatewayPacersForTests,
  withApiGatewayPacing,
} from '../../../src/utils/apigateway-pacing.js';
import { AwsClients } from '../../../src/utils/aws-clients.js';
import { ApiGatewayProvider } from '../../../src/provisioning/providers/apigateway-provider.js';

afterEach(() => {
  resetApiGatewayPacersForTests();
});

describe('ApiGatewayPacer', () => {
  const burst = (pacer: ApiGatewayPacer, operation: string, count: number, now = 0) =>
    Array.from({ length: count }, () => pacer.reserve(operation, now));

  it('does not delay a small API: 30 calls of any kind go out at once', () => {
    const pacer = new ApiGatewayPacer();
    expect(burst(pacer, 'GetResource', 30).every((wait) => wait === 0)).toBe(true);
  });

  it('settles at 8 per second once the shared burst of 30 is spent', () => {
    const pacer = new ApiGatewayPacer();
    const waits = burst(pacer, 'GetResource', 33);
    expect(waits.slice(0, 30).every((wait) => wait === 0)).toBe(true);
    expect(waits.slice(30)).toEqual([125, 250, 375]);
  });

  it('refills the shared bucket while idle, up to its capacity', () => {
    const pacer = new ApiGatewayPacer();
    burst(pacer, 'GetResource', 30);
    expect(pacer.reserve('GetResource', 10_000)).toBe(0);
    // Idle for good: back to the full 30, not more.
    const waits = burst(pacer, 'GetResource', 32, 100_000);
    expect(waits.slice(0, 30).every((wait) => wait === 0)).toBe(true);
    expect(waits[30]).toBeGreaterThan(0);
  });

  it('lets a few CreateResource calls through, then spaces them at 4 per second', () => {
    const pacer = new ApiGatewayPacer();
    expect(burst(pacer, 'CreateResource', 8)).toEqual([0, 0, 0, 0, 0, 250, 500, 750]);
  });

  it.each(['CreateResource', 'DeleteResource'])('spaces %s at 4 per second after its burst', (operation) => {
    const pacer = new ApiGatewayPacer();
    expect(burst(pacer, operation, 7)).toEqual([0, 0, 0, 0, 0, 250, 500]);
  });

  it('keeps CreateResource and DeleteResource in buckets of their own', () => {
    const pacer = new ApiGatewayPacer();
    burst(pacer, 'CreateResource', 5);
    expect(pacer.reserve('DeleteResource', 0)).toBe(0);
  });

  it('does not pace an operation with no limit of its own beyond the shared one', () => {
    const pacer = new ApiGatewayPacer();
    burst(pacer, 'CreateResource', 5);
    expect(pacer.reserve('PutMethod', 0)).toBe(0);
  });

  it('never sends more than 10 calls in any second, CreateResource and others mixed', () => {
    const pacer = new ApiGatewayPacer();
    // 10 CreateResource and 10 GetResource at the same moment, past the burst.
    burst(pacer, 'GetResource', 30);
    const sends = [
      ...burst(pacer, 'CreateResource', 10),
      ...burst(pacer, 'GetResource', 10),
    ].sort((a, b) => a - b);
    for (let i = 0; i < sends.length; i++) {
      const inSecond = sends.filter((at) => at >= sends[i]! && at < sends[i]! + 1_000).length;
      expect(inSecond).toBeLessThanOrEqual(10);
    }
  });

  it('does not let a later call overtake one that waits for its own bucket', () => {
    const pacer = new ApiGatewayPacer();
    burst(pacer, 'GetResource', 30);
    const creates = burst(pacer, 'CreateResource', 6);
    const next = pacer.reserve('GetResource', 0);
    // The delayed CreateResource takes its shared token at ITS send time, so a
    // call of any other kind queues behind it instead of going out beside it.
    expect(next).toBeGreaterThanOrEqual(Math.max(...creates));
  });

  it('shares one pacer per Region and keeps Regions apart', () => {
    expect(apiGatewayPacerFor('eu-west-1')).toBe(apiGatewayPacerFor('eu-west-1'));
    expect(apiGatewayPacerFor('eu-west-1')).not.toBe(apiGatewayPacerFor('us-east-1'));
  });

  it('does not make one Region wait for another', () => {
    const [west, east] = [apiGatewayPacerFor('eu-west-1'), apiGatewayPacerFor('us-east-1')];
    burst(west, 'CreateResource', 6);
    expect(east.reserve('CreateResource', 0)).toBe(0);
  });
});

describe('withApiGatewayPacing against a real SDK client', () => {
  type Stub = { status: number; body: string; headers?: Record<string, string> };
  const throttle: Stub = {
    status: 429,
    body: '{"message":"Too Many Requests"}',
    headers: { 'x-amzn-errortype': 'TooManyRequestsException' },
  };
  const makeClient = (responses: Stub[]) => {
    const sentAt: number[] = [];
    const client = new APIGatewayClient({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
      maxAttempts: API_GATEWAY_MAX_ATTEMPTS,
      requestHandler: {
        handle: async () => {
          sentAt.push(Date.now());
          const next = responses.shift() ?? { status: 200, body: '{"id":"x","path":"/"}' };
          return {
            response: {
              statusCode: next.status,
              headers: { 'content-type': 'application/json', ...next.headers },
              body: Readable.from([Buffer.from(next.body)]),
            },
          };
        },
      } as never,
    });
    return { client, sentAt };
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends CreateResource calls past the burst 250 ms apart', async () => {
    const { client, sentAt } = makeClient([]);
    withApiGatewayPacing(client);
    const sends = Array.from({ length: 8 }, () =>
      client.send(new CreateResourceCommand({ restApiId: 'a', parentId: 'p', pathPart: 'x' }))
    );

    const settled = Promise.all(sends);
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(250);
    await settled;

    const gaps = sentAt.slice(5).map((at, i) => at - sentAt[4 + i]!);
    expect(sentAt).toHaveLength(8);
    // The burst of 5 goes out together, the rest at the steady rate.
    expect(sentAt[4]! - sentAt[0]!).toBe(0);
    expect(gaps.every((gap) => gap >= 250)).toBe(true);
  });

  it('paces the retried attempt of a throttled call like a first one', async () => {
    const { client, sentAt } = makeClient([throttle]);
    withApiGatewayPacing(client);
    const reserve = vi.spyOn(apiGatewayPacerFor('eu-west-1'), 'reserve');

    const send = client.send(new GetRestApiCommand({ restApiId: 'a' }));
    for (let i = 0; i < 120; i++) await vi.advanceTimersByTimeAsync(250);
    await send;

    expect(sentAt).toHaveLength(2);
    expect(reserve.mock.calls.map(([operation]) => operation)).toEqual([
      'GetRestApi',
      'GetRestApi',
    ]);
  });

  it('leaves a client without a middleware stack as it is', () => {
    const double = { config: { region: async () => 'eu-west-1' } };
    expect(withApiGatewayPacing(double as never)).toBe(double);
  });
});

describe('the API Gateway clients carry the pacing', () => {
  const PACING = 'cdkdApiGatewayPacing';

  it('puts the shared client through pacing, with more SDK attempts than the default 3', async () => {
    const client = new AwsClients({ region: 'eu-west-1' }).apiGateway;
    expect(client.middlewareStack.identify().some((entry) => entry.includes(PACING))).toBe(true);
    expect(await client.config.maxAttempts()).toBe(API_GATEWAY_MAX_ATTEMPTS);
  });

  it('puts the provider create client through pacing too, with the same attempts', async () => {
    vi.stubEnv('AWS_REGION', 'eu-west-1');
    try {
      const provider = new ApiGatewayProvider() as unknown as {
        getCreateClient(): Promise<APIGatewayClient>;
      };
      const client = await provider.getCreateClient();
      expect(client.middlewareStack.identify().some((entry) => entry.includes(PACING))).toBe(true);
      expect(await client.config.maxAttempts()).toBe(API_GATEWAY_MAX_ATTEMPTS);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
