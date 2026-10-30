/**
 * State schema v13 (go-to-k/cdkd#5064): the write-ahead
 * `stack-instance.json` sibling, through the REAL `S3StateBackend`.
 *
 * - a first write with no sibling mints a fresh id and, with `writeAhead`,
 *   PUTs it with `If-None-Match: *`; without `writeAhead` (`cdkd import`) it
 *   PUTs nothing;
 * - a sibling an earlier run wrote is READ BACK (a re-run after a crash never
 *   mints a fresh id), and a lost race (412) reads the winner's id back;
 * - an unreadable sibling refuses, naming the stack and never the id;
 * - the first state save CARRYING the id deletes the sibling and purges its
 *   versions; a save without it, or for a stack this process minted nothing
 *   for, makes no extra call;
 * - `deleteState` deletes the sibling, fail-closed, before the record.
 */
import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import { STATE_SCHEMA_VERSION_CURRENT, type StackState } from '../../../src/types/state.js';
import { StateError } from '../../../src/utils/error-handler.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';
import {
  isStackInstanceId,
  parseStackInstanceSibling,
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

const logs = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...logs, child: () => logs }),
}));

const STACK = 'S';
const REGION = 'us-east-1';
const SIBLING_KEY = `cdkd/${STACK}/${REGION}/stack-instance.json`;
const STATE_KEY = `cdkd/${STACK}/${REGION}/state.json`;
const EARLIER_ID = '0b5c6a1e-3f2d-4c8b-9a7e-1d2c3b4a5f60';

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

/** A client that answers per command and key, and records every call. */
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
      if (handler === undefined) return {};
      return handler(command.input);
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
const preconditionFailed = (): never => {
  throw Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), {
    name: 'PreconditionFailed',
    $metadata: { httpStatusCode: 412 },
  });
};

const backendFor = (client: S3Client): S3StateBackend =>
  new S3StateBackend(client, { bucket: 'b', prefix: 'cdkd' }, { region: REGION });

const callsTo = (sent: Sent[], name: string, key: string): Sent[] =>
  sent.filter((c) => c.name === name && c.input['Key'] === key);

const state = (stackInstanceId?: string): StackState => ({
  version: STATE_SCHEMA_VERSION_CURRENT,
  stackName: STACK,
  region: REGION,
  resources: {},
  outputs: {},
  ...(stackInstanceId !== undefined && { stackInstanceId }),
  lastModified: 0,
});

/** Every message the backend logged or put in an error, joined. */
const everythingSaid = (extra: string[] = []): string =>
  [...Object.values(logs).flatMap((fn) => fn.mock.calls.map((c) => String(c[0]))), ...extra].join(
    '\n'
  );

describe('the stack-instance.json sibling (go-to-k/cdkd#5064)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    clearBucketRegionCache();
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue(REGION);
  });

  describe('stackInstanceIdForFirstWrite', () => {
    it('with no sibling, mints a fresh id and writes it ahead with If-None-Match: *', async () => {
      const { client, sent } = makeClient({ [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey });
      const id = await backendFor(client).stackInstanceIdForFirstWrite(STACK, REGION, {
        writeAhead: true,
      });
      expect(isStackInstanceId(id)).toBe(true);
      const puts = callsTo(sent, 'PutObjectCommand', SIBLING_KEY);
      expect(puts).toHaveLength(1);
      expect(puts[0]!.input['IfNoneMatch']).toBe('*');
      expect(parseStackInstanceSibling(String(puts[0]!.input['Body']))).toBe(id);
      // Read first, written once: nothing else.
      expect(sent.map((c) => c.name)).toEqual(['GetObjectCommand', 'PutObjectCommand']);
      expect(everythingSaid()).not.toContain(id);
    });

    it('mints a different id each time a stack is first written', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const { client } = makeClient({ [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey });
        ids.add(
          await backendFor(client).stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true })
        );
      }
      expect(ids.size).toBe(3);
    });

    it('REUSES the id an earlier, interrupted run wrote ahead, and writes nothing', async () => {
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: () => bodyOf(stackInstanceSiblingBody(EARLIER_ID)),
      });
      const id = await backendFor(client).stackInstanceIdForFirstWrite(STACK, REGION, {
        writeAhead: true,
      });
      expect(id).toBe(EARLIER_ID);
      expect(callsTo(sent, 'PutObjectCommand', SIBLING_KEY)).toHaveLength(0);
      expect(everythingSaid()).not.toContain(EARLIER_ID);
    });

    it('a lost race (412) reads the winner back instead of its own id', async () => {
      let reads = 0;
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: () =>
          reads++ === 0 ? noSuchKey() : bodyOf(stackInstanceSiblingBody(EARLIER_ID)),
        [`PutObjectCommand ${SIBLING_KEY}`]: preconditionFailed,
      });
      const id = await backendFor(client).stackInstanceIdForFirstWrite(STACK, REGION, {
        writeAhead: true,
      });
      expect(id).toBe(EARLIER_ID);
      expect(callsTo(sent, 'GetObjectCommand', SIBLING_KEY)).toHaveLength(2);
    });

    it('a 409 (a concurrent write in flight) is asked once more, and then succeeds', async () => {
      let puts = 0;
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey,
        [`PutObjectCommand ${SIBLING_KEY}`]: () => {
          if (puts++ === 0) {
            throw Object.assign(new Error('conflict'), {
              name: 'ConditionalRequestConflict',
              $metadata: { httpStatusCode: 409 },
            });
          }
          return {};
        },
      });
      const id = await backendFor(client).stackInstanceIdForFirstWrite(STACK, REGION, {
        writeAhead: true,
      });
      const bodies = callsTo(sent, 'PutObjectCommand', SIBLING_KEY);
      expect(bodies).toHaveLength(2);
      expect(bodies.every((c) => c.input['IfNoneMatch'] === '*')).toBe(true);
      expect(parseStackInstanceSibling(String(bodies[1]!.input['Body']))).toBe(id);
    });

    it('a second 409 reads the winner back', async () => {
      let reads = 0;
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: () =>
          reads++ === 0 ? noSuchKey() : bodyOf(stackInstanceSiblingBody(EARLIER_ID)),
        [`PutObjectCommand ${SIBLING_KEY}`]: () => {
          throw Object.assign(new Error('conflict'), {
            name: 'ConditionalRequestConflict',
            $metadata: { httpStatusCode: 409 },
          });
        },
      });
      const id = await backendFor(client).stackInstanceIdForFirstWrite(STACK, REGION, {
        writeAhead: true,
      });
      expect(id).toBe(EARLIER_ID);
      expect(callsTo(sent, 'PutObjectCommand', SIBLING_KEY)).toHaveLength(2);
    });

    it('an endpoint without conditional writes takes a plain PUT, and the first save still drops it', async () => {
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey,
        [`PutObjectCommand ${SIBLING_KEY}`]: (input) => {
          if (input['IfNoneMatch'] !== undefined) {
            throw Object.assign(new Error('not implemented'), {
              name: 'NotImplemented',
              $metadata: { httpStatusCode: 501 },
            });
          }
          return {};
        },
        [`PutObjectCommand ${STATE_KEY}`]: () => ({ ETag: '"e1"' }),
      });
      const backend = backendFor(client);
      const id = await backend.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true });
      const puts = callsTo(sent, 'PutObjectCommand', SIBLING_KEY);
      expect(puts).toHaveLength(2);
      expect(puts[1]!.input['IfNoneMatch']).toBeUndefined();
      expect(parseStackInstanceSibling(String(puts[1]!.input['Body']))).toBe(id);
      await backend.saveState(STACK, REGION, state(id));
      expect(callsTo(sent, 'DeleteObjectCommand', SIBLING_KEY)).toHaveLength(1);
    });

    it('a lost race whose winner cannot be read back refuses', async () => {
      const { client } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey,
        [`PutObjectCommand ${SIBLING_KEY}`]: preconditionFailed,
      });
      const caught = await backendFor(client)
        .stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true })
        .catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(StateError);
      expect((caught as Error).message).toMatch(/Nothing was created/);
    });

    it.each([
      ['a newer format', JSON.stringify({ stackInstanceVersion: 2, stackInstanceId: EARLIER_ID })],
      ['a damaged id', JSON.stringify({ stackInstanceVersion: 1, stackInstanceId: 'not-an-id' })],
      ['a body that is not JSON', '{'],
    ])('refuses %s, naming the stack, and writes nothing over it', async (_label, body) => {
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: () => bodyOf(body),
      });
      const caught = await backendFor(client)
        .stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true })
        .catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(StateError);
      expect((caught as Error).message).toMatch(/stack-instance\.json.*cannot read; upgrade cdkd/);
      expect((caught as Error).message).not.toContain(EARLIER_ID);
      expect(callsTo(sent, 'PutObjectCommand', SIBLING_KEY)).toHaveLength(0);
    });

    it('a failed read refuses before any write', async () => {
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: () => {
          throw Object.assign(new Error('Access Denied'), {
            name: 'AccessDenied',
            $metadata: { httpStatusCode: 403 },
          });
        },
      });
      const caught = await backendFor(client)
        .stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true })
        .catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(StateError);
      expect(callsTo(sent, 'PutObjectCommand', SIBLING_KEY)).toHaveLength(0);
    });

    it('without writeAhead (cdkd import) mints with no write, and still reuses a sibling', async () => {
      const fresh = makeClient({ [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey });
      const id = await backendFor(fresh.client).stackInstanceIdForFirstWrite(STACK, REGION, {
        writeAhead: false,
      });
      expect(isStackInstanceId(id)).toBe(true);
      expect(fresh.sent.map((c) => c.name)).toEqual(['GetObjectCommand']);

      const left = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: () => bodyOf(stackInstanceSiblingBody(EARLIER_ID)),
      });
      expect(
        await backendFor(left.client).stackInstanceIdForFirstWrite(STACK, REGION, {
          writeAhead: false,
        })
      ).toBe(EARLIER_ID);
    });
  });

  describe('prefetchStackInstanceSibling (#5200)', () => {
    it('serves the first write its read, so the write makes no second read', async () => {
      const { client, sent } = makeClient({ [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey });
      const backend = backendFor(client);
      backend.prefetchStackInstanceSibling(STACK, REGION);
      const id = await backend.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true });
      expect(isStackInstanceId(id)).toBe(true);
      expect(callsTo(sent, 'GetObjectCommand', SIBLING_KEY)).toHaveLength(1);
      expect(callsTo(sent, 'PutObjectCommand', SIBLING_KEY)).toHaveLength(1);
    });

    it('a prefetched id an earlier run wrote is reused, and nothing is written', async () => {
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: () => bodyOf(stackInstanceSiblingBody(EARLIER_ID)),
      });
      const backend = backendFor(client);
      backend.prefetchStackInstanceSibling(STACK, REGION);
      await expect(
        backend.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true })
      ).resolves.toBe(EARLIER_ID);
      expect(callsTo(sent, 'PutObjectCommand', SIBLING_KEY)).toHaveLength(0);
    });

    it('a prefetched read that failed refuses at the write, as an unprefetched one does', async () => {
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: () => {
          throw Object.assign(new Error('Access Denied'), {
            name: 'AccessDenied',
            $metadata: { httpStatusCode: 403 },
          });
        },
      });
      const backend = backendFor(client);
      backend.prefetchStackInstanceSibling(STACK, REGION);
      await expect(
        backend.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true })
      ).rejects.toBeInstanceOf(StateError);
      expect(callsTo(sent, 'PutObjectCommand', SIBLING_KEY)).toHaveLength(0);
    });

    it('is consumed once: a second first-write reads the sibling afresh', async () => {
      let reads = 0;
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: () => {
          reads += 1;
          return reads === 1 ? noSuchKey() : bodyOf(stackInstanceSiblingBody(EARLIER_ID));
        },
      });
      const backend = backendFor(client);
      backend.prefetchStackInstanceSibling(STACK, REGION);
      await backend.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true });
      // A stale prefetch ("absent") would mint a second id here.
      await expect(
        backend.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true })
      ).resolves.toBe(EARLIER_ID);
      expect(callsTo(sent, 'GetObjectCommand', SIBLING_KEY)).toHaveLength(2);
    });

    it('a lost race still reads the winner back afresh', async () => {
      let reads = 0;
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: () => {
          reads += 1;
          return reads === 1 ? noSuchKey() : bodyOf(stackInstanceSiblingBody(EARLIER_ID));
        },
        [`PutObjectCommand ${SIBLING_KEY}`]: preconditionFailed,
      });
      const backend = backendFor(client);
      backend.prefetchStackInstanceSibling(STACK, REGION);
      await expect(
        backend.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true })
      ).resolves.toBe(EARLIER_ID);
      expect(callsTo(sent, 'GetObjectCommand', SIBLING_KEY)).toHaveLength(2);
    });
  });

  describe('readStackInstanceSibling (read only)', () => {
    it('returns the id an earlier run wrote ahead with one read: no mint, no write, no post-save delete', async () => {
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: () => bodyOf(stackInstanceSiblingBody(EARLIER_ID)),
        [`PutObjectCommand ${STATE_KEY}`]: () => ({ ETag: '"e1"' }),
      });
      const backend = backendFor(client);
      expect(await backend.readStackInstanceSibling(STACK, REGION)).toBe(EARLIER_ID);
      expect(sent.map((c) => c.name)).toEqual(['GetObjectCommand']);
      // Not marked for the first save's delete: only the deploy's own resolve does that.
      await backend.saveState(STACK, REGION, state(EARLIER_ID));
      expect(callsTo(sent, 'DeleteObjectCommand', SIBLING_KEY)).toHaveLength(0);
      expect(everythingSaid()).not.toContain(EARLIER_ID);
    });

    it('returns undefined with no sibling, minting nothing', async () => {
      const { client, sent } = makeClient({ [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey });
      expect(await backendFor(client).readStackInstanceSibling(STACK, REGION)).toBeUndefined();
      expect(sent.map((c) => c.name)).toEqual(['GetObjectCommand']);
    });

    it('refuses a sibling this binary cannot read, or cannot read at all, naming the stack', async () => {
      for (const handler of [
        () => bodyOf('{"stackInstanceVersion":99,"stackInstanceId":"x"}'),
        () => {
          throw Object.assign(new Error('Access Denied'), {
            name: 'AccessDenied',
            $metadata: { httpStatusCode: 403 },
          });
        },
      ]) {
        const { client, sent } = makeClient({ [`GetObjectCommand ${SIBLING_KEY}`]: handler });
        const caught = await backendFor(client)
          .readStackInstanceSibling(STACK, REGION)
          .catch((e: unknown) => e);
        expect(caught).toBeInstanceOf(StateError);
        expect((caught as Error).message).toContain('write-ahead stack instance id of stack');
        expect(sent.map((c) => c.name)).toEqual(['GetObjectCommand']);
      }
    });
  });

  describe('the sibling after the first state save', () => {
    it('is deleted, and its versions purged, by the first save that carries its id', async () => {
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey,
        [`PutObjectCommand ${STATE_KEY}`]: () => ({ ETag: '"e1"' }),
      });
      const backend = backendFor(client);
      const id = await backend.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true });
      await backend.saveState(STACK, REGION, state(id));
      expect(callsTo(sent, 'DeleteObjectCommand', SIBLING_KEY)).toHaveLength(1);
      expect(
        sent.some((c) => c.name === 'ListObjectVersionsCommand' && c.input['Prefix'] === SIBLING_KEY)
      ).toBe(true);
      // Once: the next save makes no sibling call.
      const before = sent.length;
      await backend.saveState(STACK, REGION, state(id), { expectedEtag: '"e1"' });
      expect(sent.slice(before).map((c) => c.name)).toEqual(['PutObjectCommand']);
    });

    it('is kept by a save that does not carry its id (the re-run reads it back)', async () => {
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey,
        [`PutObjectCommand ${STATE_KEY}`]: () => ({ ETag: '"e1"' }),
      });
      const backend = backendFor(client);
      await backend.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true });
      await backend.saveState(STACK, REGION, state());
      expect(callsTo(sent, 'DeleteObjectCommand', SIBLING_KEY)).toHaveLength(0);
    });

    it('an ordinary save (no id resolved by this process) makes exactly one call', async () => {
      const { client, sent } = makeClient({
        [`PutObjectCommand ${STATE_KEY}`]: () => ({ ETag: '"e1"' }),
      });
      await backendFor(client).saveState(STACK, REGION, state(EARLIER_ID), {
        expectedEtag: '"e0"',
      });
      expect(sent.map((c) => c.name)).toEqual(['PutObjectCommand']);
    });

    it('a sibling this process wrote is removed by deleting its version, then purged (#5200)', async () => {
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey,
        [`PutObjectCommand ${SIBLING_KEY}`]: () => ({ VersionId: 'v-sibling-1' }),
        [`PutObjectCommand ${STATE_KEY}`]: () => ({ ETag: '"e1"' }),
      });
      const backend = backendFor(client);
      const id = await backend.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true });
      await backend.saveState(STACK, REGION, state(id));
      const deletes = callsTo(sent, 'DeleteObjectCommand', SIBLING_KEY);
      expect(deletes).toHaveLength(1);
      expect(deletes[0]!.input['VersionId']).toBe('v-sibling-1');
      // No plain delete (no delete marker), and the earlier lifetimes'
      // versions are still purged.
      expect(
        sent.some((c) => c.name === 'ListObjectVersionsCommand' && c.input['Prefix'] === SIBLING_KEY)
      ).toBe(true);
    });

    it('a failed version delete falls back to the delete and the version purge', async () => {
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey,
        [`PutObjectCommand ${SIBLING_KEY}`]: () => ({ VersionId: 'v-sibling-1' }),
        [`PutObjectCommand ${STATE_KEY}`]: () => ({ ETag: '"e1"' }),
        [`DeleteObjectCommand ${SIBLING_KEY}`]: (input) => {
          if (input['VersionId'] !== undefined) {
            throw Object.assign(new Error('Access Denied'), {
              name: 'AccessDenied',
              $metadata: { httpStatusCode: 403 },
            });
          }
          return {};
        },
      });
      const backend = backendFor(client);
      const id = await backend.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true });
      await backend.saveState(STACK, REGION, state(id));
      const deletes = callsTo(sent, 'DeleteObjectCommand', SIBLING_KEY);
      expect(deletes.map((c) => c.input['VersionId'])).toEqual(['v-sibling-1', undefined]);
      expect(
        sent.some((c) => c.name === 'ListObjectVersionsCommand' && c.input['Prefix'] === SIBLING_KEY)
      ).toBe(true);
    });

    it('a REUSED sibling (an earlier run wrote it) takes the delete and the version purge', async () => {
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: () => bodyOf(stackInstanceSiblingBody(EARLIER_ID)),
        [`PutObjectCommand ${STATE_KEY}`]: () => ({ ETag: '"e1"' }),
      });
      const backend = backendFor(client);
      const id = await backend.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true });
      await backend.saveState(STACK, REGION, state(id));
      expect(callsTo(sent, 'DeleteObjectCommand', SIBLING_KEY)[0]!.input['VersionId']).toBeUndefined();
      expect(
        sent.some((c) => c.name === 'ListObjectVersionsCommand' && c.input['Prefix'] === SIBLING_KEY)
      ).toBe(true);
    });

    it('with deferCleanup, returns after the PUT and hands the sibling delete over (#5200)', async () => {
      let releaseDelete!: () => void;
      const deleteHeld = new Promise<void>((r) => {
        releaseDelete = r;
      });
      const { client, sent } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey,
        [`PutObjectCommand ${STATE_KEY}`]: () => ({ ETag: '"e1"' }),
        [`DeleteObjectCommand ${SIBLING_KEY}`]: async () => {
          await deleteHeld;
          return {};
        },
      });
      const backend = backendFor(client);
      const id = await backend.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true });
      let handed: Promise<void> | undefined;
      // Resolves although the sibling delete is still held open.
      await expect(
        backend.saveState(STACK, REGION, state(id), {
          deferCleanup: (cleanup) => {
            handed = cleanup;
          },
        })
      ).resolves.toBe('"e1"');
      expect(handed).toBeDefined();
      expect(callsTo(sent, 'DeleteObjectCommand', SIBLING_KEY)).toHaveLength(1);
      releaseDelete();
      await handed;
      expect(
        sent.some((c) => c.name === 'ListObjectVersionsCommand' && c.input['Prefix'] === SIBLING_KEY)
      ).toBe(true);
    });

    it('with deferCleanup, a save with no sibling to drop hands nothing over', async () => {
      const { client } = makeClient({
        [`PutObjectCommand ${STATE_KEY}`]: () => ({ ETag: '"e1"' }),
      });
      const deferCleanup = vi.fn();
      await backendFor(client).saveState(STACK, REGION, state(EARLIER_ID), {
        expectedEtag: '"e0"',
        deferCleanup,
      });
      expect(deferCleanup).not.toHaveBeenCalled();
    });

    it('a failed sibling delete does not fail the save', async () => {
      const { client } = makeClient({
        [`GetObjectCommand ${SIBLING_KEY}`]: noSuchKey,
        [`PutObjectCommand ${STATE_KEY}`]: () => ({ ETag: '"e1"' }),
        [`DeleteObjectCommand ${SIBLING_KEY}`]: () => {
          throw Object.assign(new Error('Internal'), {
            name: 'InternalError',
            $metadata: { httpStatusCode: 500 },
          });
        },
      });
      const backend = backendFor(client);
      const id = await backend.stackInstanceIdForFirstWrite(STACK, REGION, { writeAhead: true });
      await expect(backend.saveState(STACK, REGION, state(id))).resolves.toBe('"e1"');
      expect(everythingSaid()).not.toContain(id);
    });
  });

  describe('deleteState', () => {
    it('deletes the sibling before the record, and purges its versions', async () => {
      const { client, sent } = makeClient({
        [`GetObjectCommand cdkd/${STACK}/state.json`]: noSuchKey,
      });
      await backendFor(client).deleteState(STACK, REGION);
      const deletes = sent.filter((c) => c.name === 'DeleteObjectCommand').map((c) => c.input['Key']);
      expect(deletes.indexOf(SIBLING_KEY)).toBeGreaterThanOrEqual(0);
      expect(deletes.indexOf(SIBLING_KEY)).toBeLessThan(deletes.indexOf(STATE_KEY));
      expect(
        sent.some((c) => c.name === 'ListObjectVersionsCommand' && c.input['Prefix'] === SIBLING_KEY)
      ).toBe(true);
    });

    it('a sibling that cannot be deleted keeps the record (fail-closed)', async () => {
      const { client, sent } = makeClient({
        [`DeleteObjectCommand ${SIBLING_KEY}`]: () => {
          throw Object.assign(new Error('Access Denied'), {
            name: 'AccessDenied',
            $metadata: { httpStatusCode: 403 },
          });
        },
      });
      const caught = await backendFor(client)
        .deleteState(STACK, REGION)
        .catch((e: unknown) => e);
      expect(caught).toBeInstanceOf(StateError);
      expect((caught as Error).message).toMatch(/stack instance id.*state record was left in place/);
      expect(callsTo(sent, 'DeleteObjectCommand', STATE_KEY)).toHaveLength(0);
    });
  });
});
