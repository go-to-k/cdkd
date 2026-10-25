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

afterEach(() => {
  resetApiGatewayPacersForTests();
});

describe('ApiGatewayPacer', () => {
  it('spaces calls of one operation with no limit of its own by the shared interval', () => {
    const pacer = new ApiGatewayPacer();
    const waits = [0, 1, 2, 3].map(() => pacer.reserve('GetResource', 1_000));
    expect(waits).toEqual([0, 125, 250, 375]);
  });

  it('spaces CreateResource at 4 per second, under the documented 5', () => {
    const pacer = new ApiGatewayPacer();
    const waits = Array.from({ length: 5 }, () => pacer.reserve('CreateResource', 0));
    expect(waits).toEqual([0, 250, 500, 750, 1_000]);
  });

  it('keeps all operations under 8 per second together', () => {
    const pacer = new ApiGatewayPacer();
    const operations = ['PutMethod', 'PutIntegration', 'GetResource', 'DeleteMethod', 'PutMethod'];
    const waits = operations.map((operation) => pacer.reserve(operation, 0));
    expect(waits).toEqual([0, 125, 250, 375, 500]);
  });

  it('lets another operation take the shared slot a CreateResource wait left free', () => {
    const pacer = new ApiGatewayPacer();
    expect(pacer.reserve('CreateResource', 0)).toBe(0);
    expect(pacer.reserve('CreateResource', 0)).toBe(250);
    // The second CreateResource took the 125 ms slot too; the next call of any
    // kind follows it, never in front of it.
    expect(pacer.reserve('GetResource', 0)).toBe(250);
  });

  it('charges DeleteResource to its own lane, not to CreateResource', () => {
    const pacer = new ApiGatewayPacer();
    expect(pacer.reserve('CreateResource', 0)).toBe(0);
    expect(pacer.reserve('DeleteResource', 0)).toBe(125);
  });

  it('does not wait once the earlier slots are in the past', () => {
    const pacer = new ApiGatewayPacer();
    pacer.reserve('CreateResource', 0);
    pacer.reserve('CreateResource', 0);
    expect(pacer.reserve('CreateResource', 10_000)).toBe(0);
  });

  it('shares one pacer per Region and keeps Regions apart', () => {
    expect(apiGatewayPacerFor('eu-west-1')).toBe(apiGatewayPacerFor('eu-west-1'));
    expect(apiGatewayPacerFor('eu-west-1')).not.toBe(apiGatewayPacerFor('us-east-1'));
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

  it('sends a burst of CreateResource calls 250 ms apart', async () => {
    const { client, sentAt } = makeClient([]);
    withApiGatewayPacing(client);
    const sends = Array.from({ length: 5 }, () =>
      client.send(new CreateResourceCommand({ restApiId: 'a', parentId: 'p', pathPart: 'x' }))
    );

    const settled = Promise.all(sends);
    for (let i = 0; i < 40; i++) await vi.advanceTimersByTimeAsync(250);
    await settled;

    const gaps = sentAt.slice(1).map((at, i) => at - sentAt[i]!);
    expect(sentAt).toHaveLength(5);
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

describe('the shared API Gateway client', () => {
  it('is built with more SDK attempts than the default 3', async () => {
    const client = new AwsClients({ region: 'eu-west-1' }).apiGateway;
    expect(await client.config.maxAttempts()).toBe(API_GATEWAY_MAX_ATTEMPTS);
  });
});
