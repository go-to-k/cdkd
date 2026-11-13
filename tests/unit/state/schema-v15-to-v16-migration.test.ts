import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSIONS_READABLE,
  type StackState,
} from '../../../src/types/state.js';
import { stackInstanceIdCarriedFrom } from '../../../src/types/state/helpers.js';
import { stackIdTailFromInstanceId, stackIdTailOf } from '../../../src/state/stack-id-tail.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';
import { StateError } from '../../../src/utils/error-handler.js';

/**
 * Schema v16 — `StackState.stackIdFromInstance` (go-to-k/cdkd#6170): true on a
 * stack whose AWS::StackId tail is a UUID derived from its stackInstanceId.
 *
 * Through the REAL `S3StateBackend` read path, over a VERBATIM v15 document:
 * v16 is current and every older version readable, a v15 document is read
 * unchanged (legacy tail), a v16 document round-trips the marker, and a
 * version past 16 is refused with "Upgrade cdkd".
 */
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

function makeClient(): { send: ReturnType<typeof vi.fn> } & Record<string, unknown> {
  return {
    send: vi.fn(),
    destroy: vi.fn(),
    config: {
      region: () => Promise.resolve('us-east-1'),
      credentials: () =>
        Promise.resolve({ accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake-secret' }),
    },
  };
}

const INSTANCE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** A v15 binary's `state.json`. */
const V15_DOCUMENT = `{
  "version": 15,
  "stackName": "LegacyV15",
  "region": "us-east-1",
  "stackInstanceId": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  "resources": {
    "Table": {
      "physicalId": "legacyv15-table",
      "resourceType": "AWS::DynamoDB::Table",
      "properties": { "TableName": "legacyv15-table" },
      "attributes": {},
      "dependencies": [],
      "provisionedBy": "sdk"
    }
  },
  "outputs": {},
  "exportNames": [],
  "lastModified": 1793000000000
}`;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('State schema v16 — stackIdFromInstance (go-to-k/cdkd#6170)', () => {
  let client: ReturnType<typeof makeClient>;
  let backend: S3StateBackend;

  beforeEach(async () => {
    vi.clearAllMocks();
    clearBucketRegionCache();
    const { resolveBucketRegion } = await import('../../../src/utils/aws-region-resolver.js');
    vi.mocked(resolveBucketRegion).mockResolvedValue('us-east-1');
    client = makeClient();
    backend = new S3StateBackend(
      client as unknown as S3Client,
      { bucket: 'b', prefix: 'cdkd' },
      { region: 'us-east-1' }
    );
  });

  const serve = (body: string): void => {
    client.send.mockResolvedValueOnce({
      Body: { transformToString: () => Promise.resolve(body) },
      ETag: '"e"',
    });
  };

  const v16Document = (): StackState => {
    const v16 = JSON.parse(V15_DOCUMENT) as StackState;
    v16.version = 16;
    v16.stackIdFromInstance = true;
    return v16;
  };

  it('v16 is the current version, and every version 1..16 is readable', () => {
    expect(STATE_SCHEMA_VERSION_CURRENT).toBe(16);
    for (let v = 1; v <= 16; v++) expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(v);
    expect(STATE_SCHEMA_VERSIONS_READABLE).not.toContain(17);
  });

  it('reads a verbatim v15 document unchanged, with the legacy tail, and writes nothing on read', async () => {
    serve(V15_DOCUMENT);
    const state = (await backend.getState('LegacyV15', 'us-east-1'))?.state as StackState;
    expect(state).toEqual(JSON.parse(V15_DOCUMENT));
    expect(Object.hasOwn(state, 'stackIdFromInstance')).toBe(false);
    expect(stackIdTailOf(state, 'X')).toBeUndefined();
    expect(client.send).toHaveBeenCalledTimes(1);
    const puts = client.send.mock.calls.filter(
      ([command]) => (command as { constructor?: { name?: string } }).constructor?.name === 'PutObjectCommand'
    );
    expect(puts).toHaveLength(0);
  });

  it('round-trips a v16 document with the marker and derives a stable UUID tail', async () => {
    const v16 = v16Document();
    serve(JSON.stringify(v16));
    const state = (await backend.getState('LegacyV15', 'us-east-1'))?.state as StackState;
    expect(state).toEqual(v16);
    expect(state.stackIdFromInstance).toBe(true);
    const tail = stackIdTailOf(state, 'X');
    expect(tail).toMatch(UUID_V4);
    expect(tail).not.toBe(INSTANCE_ID);
    expect(stackIdTailOf(state, 'X')).toBe(tail);
    const other = { ...state, stackInstanceId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
    expect(stackIdTailOf(other, 'X')).toMatch(UUID_V4);
    expect(stackIdTailOf(other, 'X')).not.toBe(tail);
  });

  it('refuses version 17 with the "Upgrade cdkd" error, as a v15 binary refuses 16', async () => {
    serve(JSON.stringify({ version: 17, stackName: 'X', resources: {}, outputs: {}, lastModified: 0 }));
    const caught = await backend.getState('X', 'us-east-1').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(StateError);
    expect((caught as Error).message).toMatch(/Unsupported state schema version 17/);
    expect((caught as Error).message).toMatch(/1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16/);
    expect((caught as Error).message).toMatch(/Upgrade cdkd/);
  });

  it('saves version 16 with the marker intact', async () => {
    client.send.mockResolvedValue({ ETag: '"new"' });
    await backend.saveState('LegacyV15', 'us-east-1', v16Document(), { expectedEtag: '"e"' });
    const body = client.send.mock.calls
      .map(([command]) => (command as { input?: { Body?: unknown } }).input?.Body)
      .find((b): b is string => typeof b === 'string');
    const saved = JSON.parse(body!) as StackState;
    expect(saved.version).toBe(16);
    expect(saved.stackIdFromInstance).toBe(true);
  });

  it('stackInstanceIdCarriedFrom carries the marker only when present', () => {
    expect(
      stackInstanceIdCarriedFrom({ stackInstanceId: INSTANCE_ID, stackIdFromInstance: true })
    ).toEqual({ stackInstanceId: INSTANCE_ID, stackIdFromInstance: true });
    const legacy = stackInstanceIdCarriedFrom({ stackInstanceId: INSTANCE_ID });
    expect(Object.hasOwn(legacy, 'stackIdFromInstance')).toBe(false);
  });

  it('stackInstanceIdCarriedFrom carries a malformed marker verbatim, so the refusal survives a save', () => {
    const damaged = { stackInstanceId: INSTANCE_ID, stackIdFromInstance: 'true' } as unknown as StackState;
    const carried = stackInstanceIdCarriedFrom(damaged);
    expect(carried.stackIdFromInstance as unknown).toBe('true');
    expect(() => stackIdTailOf(carried, 'X')).toThrow(/stackIdFromInstance that is not true/);
  });

  it('stackIdTailOf throws when the marker is present without a stackInstanceId', () => {
    expect(() => stackIdTailOf({ stackIdFromInstance: true } as StackState, 'X')).toThrow(
      /holds no stackInstanceId/
    );
  });

  it.each([['true'], [1]])('stackIdTailOf refuses a marker that is %j, not true', (marker) => {
    expect(() =>
      stackIdTailOf({ stackInstanceId: INSTANCE_ID, stackIdFromInstance: marker } as never, 'X')
    ).toThrow(/stackIdFromInstance that is not true/);
  });

  it('stackIdTailOf refuses a marked record whose stackInstanceId is malformed', () => {
    expect(() =>
      stackIdTailOf({ stackInstanceId: 'not-an-id', stackIdFromInstance: true } as StackState, 'X')
    ).toThrow(/not a well-formed id|MalformedStackInstanceId/);
  });

  it('stackIdTailFromInstanceId is pinned: a v4-shaped UUID, stable across releases', () => {
    const tail = stackIdTailFromInstanceId('00000000-0000-4000-8000-000000000000');
    expect(tail).toMatch(UUID_V4);
    expect(tail).toBe('2d300264-2aa0-4589-ab27-cd6e9a259f23');
  });
});
