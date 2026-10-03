import { describe, it, expect, afterEach, vi } from 'vite-plus/test';
import { Readable } from 'node:stream';
import {
  CreateFileSystemCommand,
  EFSClient,
  FileSystemAlreadyExists,
} from '@aws-sdk/client-efs';
import {
  CLOCK_FALLBACK_MARGIN_MS,
  SERVER_CLOCK_MARGIN_MS,
  earliestOwnCreationTime,
  serverClockReading,
  withServerClock,
} from '../../../src/provisioning/providers/server-clock.js';

/**
 * go-to-k/cdkd#4428: the FSx / EFS creation-time gate compares AWS's
 * `CreationTime` with AWS's own clock, read from the response's HTTP `Date`.
 */
describe('earliestOwnCreationTime', () => {
  it('moves the first send onto AWS\'s clock by the skew measured at the response', () => {
    // Local clock 30s ahead: sent and answered at local 130s, AWS said 100s.
    const reading = { sentAtMs: 130_000, receivedAtMs: 130_000, serverDateMs: 100_000 };
    expect(earliestOwnCreationTime(130_000, reading)).toBe(100_000 - SERVER_CLOCK_MARGIN_MS);
    // An earlier first send moves by the same skew.
    expect(earliestOwnCreationTime(70_000, reading)).toBe(40_000 - SERVER_CLOCK_MARGIN_MS);
  });

  it('reduces to serverDate - requestDuration - margin for a create sent once', () => {
    const reading = { sentAtMs: 1_000, receivedAtMs: 3_000, serverDateMs: 50_000 };
    expect(earliestOwnCreationTime(1_000, reading)).toBe(50_000 - 2_000 - SERVER_CLOCK_MARGIN_MS);
  });

  it('falls back to the SigV4 5-minute bound on the local clock with no Date header', () => {
    expect(earliestOwnCreationTime(1_000_000, undefined)).toBe(1_000_000 - CLOCK_FALLBACK_MARGIN_MS);
    expect(
      earliestOwnCreationTime(1_000_000, { sentAtMs: 0, receivedAtMs: 0, serverDateMs: undefined })
    ).toBe(1_000_000 - CLOCK_FALLBACK_MARGIN_MS);
  });
});

/**
 * A REAL `EFSClient` (no module mock) against a stub HTTP handler: pins that
 * the middleware sits inside the deserializer, so it reads the raw `Date`
 * header of a success AND of an error response, on the SDK version this repo
 * pins.
 */
describe('withServerClock against a real SDK client', () => {
  const SERVER_DATE = 'Fri, 02 Oct 2026 00:00:00 GMT';
  afterEach(() => {
    vi.useRealTimers();
  });

  const makeClient = (response: { status: number; headers: Record<string, string>; body: string }) =>
    new EFSClient({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
      maxAttempts: 1,
      requestHandler: {
        handle: async () => ({
          response: {
            statusCode: response.status,
            headers: response.headers,
            body: Readable.from([Buffer.from(response.body)]),
          },
        }),
      } as never,
    });

  it('records the Date header of a success response', async () => {
    const client = makeClient({
      status: 201,
      headers: { 'content-type': 'application/json', date: SERVER_DATE },
      body: JSON.stringify({ FileSystemId: 'fs-1', CreationToken: 't', LifeCycleState: 'creating' }),
    });
    const command = withServerClock(new CreateFileSystemCommand({ CreationToken: 't' }));

    const out = await client.send(command);

    expect(out.FileSystemId).toBe('fs-1');
    expect(serverClockReading(command)?.serverDateMs).toBe(Date.parse(SERVER_DATE));
  });

  it('records the Date header of an error response before it is thrown', async () => {
    const client = makeClient({
      status: 409,
      headers: {
        'content-type': 'application/json',
        'x-amzn-errortype': 'FileSystemAlreadyExists',
        Date: SERVER_DATE,
      },
      body: JSON.stringify({
        ErrorCode: 'FileSystemAlreadyExists',
        Message: 'already exists',
        FileSystemId: 'fs-held',
      }),
    });
    const command = withServerClock(new CreateFileSystemCommand({ CreationToken: 't' }));

    const error = await client.send(command).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FileSystemAlreadyExists);
    expect(serverClockReading(command)?.serverDateMs).toBe(Date.parse(SERVER_DATE));
  });

  it('records no server date when the response carries none', async () => {
    const client = makeClient({
      status: 201,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ FileSystemId: 'fs-1' }),
    });
    const command = withServerClock(new CreateFileSystemCommand({ CreationToken: 't' }));

    await client.send(command);

    const reading = serverClockReading(command);
    expect(reading).toBeDefined();
    expect(reading?.serverDateMs).toBeUndefined();
  });
});
