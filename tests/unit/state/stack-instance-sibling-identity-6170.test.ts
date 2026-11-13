/**
 * The write-ahead sibling's `AWS::StackId` flag (go-to-k/cdkd#6170): version 1
 * is a legacy stack (flag false), version 2 carries `stackIdFromInstance: true`,
 * and the backend writes the candidate a deploy planned with and shares one
 * read between the peek and the write.
 */
import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { StateError } from '../../../src/utils/error-handler.js';import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';
import {
  parseStackInstanceSibling,
  parseStackInstanceSiblingIdentity,
  stackInstanceSiblingBody,
} from '../../../src/state/stack-instance-id.js';

vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: vi.fn().mockResolvedValue({ Account: '999999999999' }),
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input) => ({ ...input })),
}));

vi.mock('../../../src/utils/aws-region-resolver.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/utils/aws-region-resolver.js')
  >('../../../src/utils/aws-region-resolver.js');
  return { ...actual, resolveBucketRegion: vi.fn() };
});

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...fns, child: () => fns }) };
});

const STACK = 'S';
const REGION = 'us-east-1';
const SIBLING_KEY = `cdkd/${STACK}/${REGION}/stack-instance.json`;
const ID = '0b5c6a1e-3f2d-4c8b-9a7e-1d2c3b4a5f60';
const CANDIDATE = '1c6d7b2f-4a3e-4d9c-8b8f-2e3d4c5b6a71';

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

function makeClient(handlers: Record<string, (input: Record<string, unknown>) => unknown>): {
  client: S3Client;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const client = {
    send: vi.fn(async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      sent.push({ name, input: command.input });
      const handler = handlers[`${name} ${String(command.input['Key'] ?? '')}`] ?? handlers[name];
      return handler === undefined ? {} : handler(command.input);
    }),
    destroy: vi.fn(),
    config: {
      region: () => Promise.resolve(REGION),
      credentials: () =>
        Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' }),
    },
  };
  return { client: client as unknown as S3Client, sent };
}

const noSuchKey = (): never => {
  throw Object.assign(new Error('The specified key does not exist.'), {
    name: 'NoSuchKey',
    $metadata: { httpStatusCode: 404 },
  });
};
const bodyOf = (text: string) => ({ Body: { transformToString: () => Promise.resolve(text) } });
const backendFor = (client: S3Client): S3StateBackend =>
  new S3StateBackend(client, { bucket: 'b', prefix: 'cdkd' }, { region: REGION });
const callsTo = (sent: Sent[], name: string): Sent[] =>
  sent.filter((c) => c.name === name && c.input['Key'] === SIBLING_KEY);

describe('stack-instance sibling identity parsing (go-to-k/cdkd#6170)', () => {
  const body = (doc: Record<string, unknown>): string => JSON.stringify(doc);

  it('a version 1 body is a legacy stack: flag false', () => {
    expect(
      parseStackInstanceSiblingIdentity(body({ stackInstanceVersion: 1, stackInstanceId: ID }))
    ).toEqual({ stackInstanceId: ID, stackIdFromInstance: false });
  });

  it('a version 2 body with the flag true carries it', () => {
    expect(
      parseStackInstanceSiblingIdentity(
        body({ stackInstanceVersion: 2, stackInstanceId: ID, stackIdFromInstance: true })
      )
    ).toEqual({ stackInstanceId: ID, stackIdFromInstance: true });
  });

  it.each([
    ['version 2 without the flag', { stackInstanceVersion: 2, stackInstanceId: ID }],
    [
      'version 2 with the flag as a string',
      { stackInstanceVersion: 2, stackInstanceId: ID, stackIdFromInstance: 'true' },
    ],
    [
      'version 3',
      { stackInstanceVersion: 3, stackInstanceId: ID, stackIdFromInstance: true },
    ],
  ])('%s is refused (null)', (_label, doc) => {
    expect(parseStackInstanceSiblingIdentity(body(doc))).toBeNull();
    expect(parseStackInstanceSibling(body(doc))).toBeNull();
  });

  it('parseStackInstanceSibling still returns the id for versions 1 and 2', () => {
    expect(parseStackInstanceSibling(stackInstanceSiblingBody(ID))).toBe(ID);
    expect(parseStackInstanceSibling(stackInstanceSiblingBody(ID, true))).toBe(ID);
  });

  it('stackInstanceSiblingBody(id, true) round-trips through the identity parser', () => {
    expect(parseStackInstanceSiblingIdentity(stackInstanceSiblingBody(ID, true))).toEqual({
      stackInstanceId: ID,
      stackIdFromInstance: true,
    });
    expect(parseStackInstanceSiblingIdentity(stackInstanceSiblingBody(ID))).toEqual({
      stackInstanceId: ID,
      stackIdFromInstance: false,
    });
  });

  it('stackInstanceSiblingBody(id) is the version 1 shape, no flag', () => {
    expect(JSON.parse(stackInstanceSiblingBody(ID))).toStrictEqual({
      stackInstanceVersion: 1,
      stackInstanceId: ID,
    });
    expect(JSON.parse(stackInstanceSiblingBody(ID, true))).toStrictEqual({
      stackInstanceVersion: 2,
      stackInstanceId: ID,
      stackIdFromInstance: true,
    });
  });
});

describe('the backend and the sibling flag (go-to-k/cdkd#6170)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearBucketRegionCache();
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue(REGION);
  });

  it('with no sibling, writes a version 2 body carrying the candidate, and returns the candidate', async () => {
    const { client, sent } = makeClient({ [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey });
    const id = await backendFor(client).stackInstanceIdForFirstWrite(STACK, REGION, {
      writeAhead: true,
      candidate: { stackInstanceId: CANDIDATE, stackIdFromInstance: true },
    });
    expect(id).toBe(CANDIDATE);
    const puts = callsTo(sent, 'PutObjectCommand');
    expect(puts).toHaveLength(1);
    expect(JSON.parse(String(puts[0]!.input['Body']))).toStrictEqual({
      stackInstanceVersion: 2,
      stackInstanceId: CANDIDATE,
      stackIdFromInstance: true,
    });
  });

  it('an existing sibling wins over the candidate, and nothing is written', async () => {
    const { client, sent } = makeClient({
      [`GetObjectCommand ${SIBLING_KEY}`]: () => bodyOf(stackInstanceSiblingBody(ID)),
    });
    const id = await backendFor(client).stackInstanceIdForFirstWrite(STACK, REGION, {
      writeAhead: true,
      candidate: { stackInstanceId: CANDIDATE, stackIdFromInstance: true },
    });
    expect(id).toBe(ID);
    expect(callsTo(sent, 'PutObjectCommand')).toHaveLength(0);
  });

  it('peekStackInstanceSibling returns the identity (or null), and the write that follows shares its read', async () => {
    const present = makeClient({
      [`GetObjectCommand ${SIBLING_KEY}`]: () => bodyOf(stackInstanceSiblingBody(ID, true)),
    });
    const backend = backendFor(present.client);
    expect(await backend.peekStackInstanceSibling(STACK, REGION)).toEqual({
      stackInstanceId: ID,
      stackIdFromInstance: true,
    });
    expect(
      await backend.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true })
    ).toBe(ID);
    expect(callsTo(present.sent, 'GetObjectCommand')).toHaveLength(1);

    const absent = makeClient({ [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey });
    const backend2 = backendFor(absent.client);
    expect(await backend2.peekStackInstanceSibling(STACK, REGION)).toBeNull();
    await backend2.stackInstanceIdForFirstWrite(STACK, REGION, {
      writeAhead: true,
      candidate: { stackInstanceId: CANDIDATE, stackIdFromInstance: true },
    });
    expect(callsTo(absent.sent, 'GetObjectCommand')).toHaveLength(1);
    expect(callsTo(absent.sent, 'PutObjectCommand')).toHaveLength(1);
  });
});

describe('peekStackInstanceSibling refusals (go-to-k/cdkd#6170)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearBucketRegionCache();
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue(REGION);
  });

  it('an AccessDenied read rejects with a StateError naming the stack, never the id', async () => {
    const { client } = makeClient({
      [`GetObjectCommand ${SIBLING_KEY}`]: () => {
        throw Object.assign(new Error(`Access Denied for ${ID}`), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 },
        });
      },
    });
    const err = await backendFor(client)
      .peekStackInstanceSibling(STACK, REGION)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(StateError);
    const message = (err as StateError).message;
    expect(message).toContain(`stack ${STACK}`);
    expect(message).toContain('write-ahead stack instance id');
    expect(message).not.toContain(ID);
  });

  it('an unreadable body (version 3) rejects with the StateError readSiblingIdentity raises', async () => {
    const { client } = makeClient({
      [`GetObjectCommand ${SIBLING_KEY}`]: () =>
        bodyOf(
          JSON.stringify({
            stackInstanceVersion: 3,
            stackInstanceId: ID,
            stackIdFromInstance: true,
          })
        ),
    });
    const err = await backendFor(client)
      .peekStackInstanceSibling(STACK, REGION)
      .then(
        () => undefined,
        (e: unknown) => e
      );
    expect(err).toBeInstanceOf(StateError);
    expect((err as StateError).message).toContain('is in a format this cdkd version cannot read');
    expect((err as StateError).message).not.toContain(ID);
  });
});
