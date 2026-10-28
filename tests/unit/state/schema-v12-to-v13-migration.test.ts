import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSIONS_READABLE,
  stackInstanceIdCarriedFrom,
  type StackState,
} from '../../../src/types/state.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';
import {
  MalformedStackInstanceIdError,
  stackInstanceIdOf,
} from '../../../src/state/stack-instance-id.js';

/**
 * Schema v13 — `StackState.stackInstanceId` (go-to-k/cdkd#5064).
 *
 * Through the REAL `S3StateBackend` read path, over a VERBATIM v12 document
 * (the shape a v12 binary writes): v13 is current and every older version
 * readable, a v12 document is read unchanged with no id (a LEGACY stack: the
 * getter answers `undefined`), reading rewrites nothing, and a v13 document
 * round-trips its id. The refusal of a version past the current one is pinned
 * by the latest bump's test (`schema-v13-to-v14-migration.test.ts`). What a deploy over a v12 record
 * writes (no id minted) is pinned through the real engine in
 * `tests/unit/deployment/deploy-engine-stack-instance-id-5064.test.ts`.
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

const ID = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';

/** A v12 binary's `state.json`. */
const V12_DOCUMENT = `{
  "version": 12,
  "stackName": "LegacyV12",
  "region": "us-east-1",
  "resources": {
    "Bucket": {
      "physicalId": "legacyv12-bucket-1",
      "resourceType": "AWS::S3::Bucket",
      "properties": {},
      "attributes": { "Arn": "arn:aws:s3:::legacyv12-bucket-1" },
      "dependencies": [],
      "provisionedBy": "sdk"
    }
  },
  "outputs": {},
  "exportNames": [],
  "lastModified": 1792000000000
}`;

describe('State schema v13 — stackInstanceId (#5064)', () => {
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

  it('every version 1..13 stays readable (v14, go-to-k/cdkd#5380, is current)', () => {
    expect(STATE_SCHEMA_VERSION_CURRENT).toBeGreaterThanOrEqual(13);
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]) {
      expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(v);
    }
  });

  it('reads a verbatim v12 document unchanged, as a LEGACY stack, and writes nothing on read', async () => {
    serve(V12_DOCUMENT);
    const state = (await backend.getState('LegacyV12', 'us-east-1'))?.state as StackState;
    expect(state).toEqual(JSON.parse(V12_DOCUMENT));
    expect(Object.hasOwn(state, 'stackInstanceId')).toBe(false);
    expect(stackInstanceIdOf(state, 'LegacyV12')).toBeUndefined();
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('reads a v13 document carrying its id as written', async () => {
    const v13 = { ...(JSON.parse(V12_DOCUMENT) as StackState), version: 13, stackInstanceId: ID };
    serve(JSON.stringify(v13));
    const state = (await backend.getState('LegacyV12', 'us-east-1'))?.state as StackState;
    expect(state).toEqual(v13);
    expect(stackInstanceIdOf(state, 'LegacyV12')).toBe(ID);
  });

  it('saves the current version with the id intact, and a legacy record without one', async () => {
    client.send.mockResolvedValue({ ETag: '"new"' });
    const legacy = JSON.parse(V12_DOCUMENT) as StackState;
    await backend.saveState('LegacyV12', 'us-east-1', legacy, { expectedEtag: '"e"' });
    await backend.saveState(
      'LegacyV12',
      'us-east-1',
      { ...legacy, stackInstanceId: ID },
      { expectedEtag: '"new"' }
    );
    const bodies = client.send.mock.calls
      .map(([command]) => (command as { input?: { Body?: unknown } }).input?.Body)
      .filter((body): body is string => typeof body === 'string')
      .map((body) => JSON.parse(body) as StackState);
    expect(bodies.map((b) => b.version)).toEqual([
      STATE_SCHEMA_VERSION_CURRENT,
      STATE_SCHEMA_VERSION_CURRENT,
    ]);
    expect(Object.hasOwn(bodies[0]!, 'stackInstanceId')).toBe(false);
    expect(bodies[1]!.stackInstanceId).toBe(ID);
  });
});

describe('stackInstanceIdOf / stackInstanceIdCarriedFrom (#5064)', () => {
  it('the getter answers a well-formed id, undefined for a legacy record', () => {
    expect(stackInstanceIdOf({ stackInstanceId: ID }, 'S')).toBe(ID);
    expect(stackInstanceIdOf({}, 'S')).toBeUndefined();
    expect(stackInstanceIdOf(null, 'S')).toBeUndefined();
  });

  it.each([
    ['a number', 7],
    ['an empty string', ''],
    ['an uppercase id', ID.toUpperCase()],
    ['a non-v4 shape', '6f1c2b3a-4d5e-1f60-8a7b-9c0d1e2f3a4b'],
    ['a truncated id', ID.slice(0, 30)],
    ['null', null],
  ])('the getter REFUSES %s rather than reading it as legacy, never echoing it', (_l, value) => {
    let caught: unknown;
    try {
      stackInstanceIdOf({ stackInstanceId: value } as never, 'MyStack');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MalformedStackInstanceIdError);
    expect((caught as Error).message).toContain('MyStack');
    if (typeof value === 'string' && value !== '') {
      expect((caught as Error).message).not.toContain(value);
    }
  });

  it('the carrier keeps absent absent and a present value verbatim (even a malformed one)', () => {
    expect(stackInstanceIdCarriedFrom({})).toEqual({});
    expect(stackInstanceIdCarriedFrom(null)).toEqual({});
    expect(stackInstanceIdCarriedFrom(undefined)).toEqual({});
    expect(stackInstanceIdCarriedFrom({ stackInstanceId: ID })).toEqual({ stackInstanceId: ID });
    expect(stackInstanceIdCarriedFrom({ stackInstanceId: 'damaged' })).toEqual({
      stackInstanceId: 'damaged',
    });
    // A legacy record's carry adds no key at all.
    expect(Object.keys(stackInstanceIdCarriedFrom({}))).toEqual([]);
  });
});
