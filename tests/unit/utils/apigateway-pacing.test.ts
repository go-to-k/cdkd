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
  type Call = { operation: string; at: number };
  const calls = (operation: string, count: number, at = 0): Call[] =>
    Array.from({ length: count }, () => ({ operation, at }));

  /**
   * The send time of each call, in the order given, the way the middleware
   * goes: wait for the operation's own bucket, then take a shared token at the
   * moment of sending. Events run in time order, as timers would.
   */
  const simulate = (pacer: ApiGatewayPacer, input: Call[]): number[] => {
    const sent: number[] = [];
    const queue = input.map((call, index) => ({
      index,
      time: call.at + pacer.reserveOperation(call.operation, call.at),
    }));
    while (queue.length > 0) {
      queue.sort((x, y) => x.time - y.time || x.index - y.index);
      const next = queue.shift()!;
      const wait = pacer.takeShared(next.time);
      if (wait === 0) sent[next.index] = next.time;
      else queue.push({ index: next.index, time: next.time + wait });
    }
    return sent;
  };

  it('does not delay a small API: 30 calls of any kind go out at once', () => {
    const sent = simulate(new ApiGatewayPacer(), calls('GetResource', 30));
    expect(sent).toEqual(Array(30).fill(0));
  });

  it('settles at 8 per second once the shared burst of 30 is spent', () => {
    const sent = simulate(new ApiGatewayPacer(), calls('GetResource', 33));
    expect(sent.slice(0, 30)).toEqual(Array(30).fill(0));
    expect(sent.slice(30)).toEqual([125, 250, 375]);
  });

  it('refills the shared bucket while idle, up to its capacity', () => {
    const pacer = new ApiGatewayPacer();
    simulate(pacer, calls('GetResource', 30));
    expect(simulate(pacer, calls('GetResource', 1, 10_000))).toEqual([10_000]);
    // Idle for good: back to the full 30, not more.
    const sent = simulate(pacer, calls('GetResource', 32, 100_000));
    expect(sent.slice(0, 30)).toEqual(Array(30).fill(100_000));
    expect(sent[30]).toBe(100_125);
  });

  it('lets a few CreateResource calls through, then spaces them at 4 per second', () => {
    const sent = simulate(new ApiGatewayPacer(), calls('CreateResource', 8));
    expect(sent).toEqual([0, 0, 0, 0, 0, 250, 500, 750]);
  });

  it.each(['CreateResource', 'DeleteResource'])('spaces %s at 4 per second after its burst', (operation) => {
    const sent = simulate(new ApiGatewayPacer(), calls(operation, 7));
    expect(sent).toEqual([0, 0, 0, 0, 0, 250, 500]);
  });

  it('keeps CreateResource and DeleteResource in buckets of their own', () => {
    const sent = simulate(new ApiGatewayPacer(), [
      ...calls('CreateResource', 5),
      ...calls('DeleteResource', 1),
    ]);
    expect(sent).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('does not make an operation with no limit of its own wait for its own bucket', () => {
    const pacer = new ApiGatewayPacer();
    expect(pacer.reserveOperation('PutMethod', 0)).toBe(0);
  });

  it('lets other operations go out beside a CreateResource queue, not behind it', () => {
    // 100 CreateResource queue on their own bucket (until ~23.75 s); a
    // GetResource arriving at 100 ms is not part of that queue.
    const sent = simulate(new ApiGatewayPacer(), [
      ...calls('CreateResource', 100),
      { operation: 'GetResource', at: 100 },
    ]);
    expect(sent[100]).toBe(100);
    expect(sent[99]).toBe(23_750);
  });

  it('interleaves 10 CreateResource with 10 GetResource sent together', () => {
    const sent = simulate(new ApiGatewayPacer(), [
      ...calls('CreateResource', 10),
      ...calls('GetResource', 10),
    ]);
    expect(sent.slice(0, 10)).toEqual([0, 0, 0, 0, 0, 250, 500, 750, 1_000, 1_250]);
    expect(sent.slice(10)).toEqual(Array(10).fill(0));
  });

  it('still keeps the shared limit: past the burst, no more than 8 per second', () => {
    const sent = simulate(new ApiGatewayPacer(), [
      ...calls('GetResource', 30),
      ...calls('CreateResource', 10),
      ...calls('GetResource', 10),
    ]).sort((x, y) => x - y);
    // The n-th call (from 1) cannot go before the 30 burst tokens and the
    // refill have covered it.
    sent.forEach((at, index) => {
      expect(at).toBeGreaterThanOrEqual(Math.max(0, (index + 1 - 30) * 125) - 1);
    });
    expect(sent.at(-1)).toBeGreaterThanOrEqual((50 - 30) * 125 - 1);
  });

  it('shares one pacer per Region and keeps Regions apart', () => {
    expect(apiGatewayPacerFor('eu-west-1')).toBe(apiGatewayPacerFor('eu-west-1'));
    expect(apiGatewayPacerFor('eu-west-1')).not.toBe(apiGatewayPacerFor('us-east-1'));
  });

  it('does not make one Region wait for another', () => {
    const west = simulate(apiGatewayPacerFor('eu-west-1'), calls('CreateResource', 6));
    const east = simulate(apiGatewayPacerFor('us-east-1'), calls('CreateResource', 1));
    expect(west[5]).toBe(250);
    expect(east).toEqual([0]);
  });

  it('counts time on a monotonic clock by default', () => {
    const wall = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const pacer = new ApiGatewayPacer();
      for (let i = 0; i < 30; i++) expect(pacer.takeShared()).toBe(0);
      // The wall clock steps back an hour: nothing waits for it.
      wall.mockReturnValue(1_000_000 - 3_600_000);
      expect(pacer.takeShared()).toBeLessThanOrEqual(125);
    } finally {
      wall.mockRestore();
    }
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
    // `performance` too: the pacer counts on it, and the shared-token loop
    // would spin on the real clock while its sleeps run on the fake one.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
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

  it('holds calls past the shared burst of 30 and sends them at 8 per second', async () => {
    const { client, sentAt } = makeClient([]);
    withApiGatewayPacing(client);
    const start = Date.now();
    const settled = Promise.all(
      Array.from({ length: 33 }, () => client.send(new GetRestApiCommand({ restApiId: 'a' })))
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    expect(sentAt.map((at) => at - start)).toEqual([...Array(30).fill(0), 125, 250, 375]);
  });

  it('makes a limited operation take a shared token too', async () => {
    const { client, sentAt } = makeClient([]);
    withApiGatewayPacing(client);
    // The whole shared burst is spent; CreateResource has its own bucket free.
    const pacer = apiGatewayPacerFor('eu-west-1');
    for (let i = 0; i < 30; i++) expect(pacer.takeShared()).toBe(0);
    const start = Date.now();
    const settled = client.send(
      new CreateResourceCommand({ restApiId: 'a', parentId: 'p', pathPart: 'x' })
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    expect(sentAt.map((at) => at - start)).toEqual([125]);
  });

  it('paces the retried attempt of a throttled call like a first one', async () => {
    const { client, sentAt } = makeClient([throttle]);
    withApiGatewayPacing(client);
    const reserve = vi.spyOn(apiGatewayPacerFor('eu-west-1'), 'reserveOperation');

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
