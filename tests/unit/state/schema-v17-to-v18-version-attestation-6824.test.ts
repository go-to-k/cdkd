import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSIONS_READABLE,
  stateSchemaVersionFor,
  type StackState,
} from '../../../src/types/state.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';
import { StateError } from '../../../src/utils/error-handler.js';

/**
 * Schema v18 — `ReferenceProvenance.versionsSent` (go-to-k/cdkd#6824), a
 * CONDITIONAL bump like v17: a save stamps 18 only when some record carries a
 * secret version attestation, so an older binary (which would send a rotated
 * password without the write-ahead and keep the attestation on a kill or a
 * failure save) refuses exactly those states. Every other state keeps 17 / 16.
 * Through the REAL `S3StateBackend` read and save paths.
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

const TOKEN = '{{resolve:secretsmanager:s:SecretString:password::}}';
const V1 = 'a1b2c3d4-0000-1111-2222-333333333333';
const MAC = 'kms-hmac-sha256:arn:aws:kms:us-east-1:123456789012:key/k:AAAA';

const record = (attested: boolean, macs = false) => ({
  physicalId: 'endpoint-1',
  resourceType: 'AWS::DMS::Endpoint',
  provisionedBy: 'cc-api',
  properties: { Password: TOKEN },
  attributes: {},
  dependencies: [],
  referenceProvenance: {
    [TOKEN]: { region: 'us-east-1', versions: [V1], ...(attested && { versionsSent: true }) },
  },
  ...(macs && { noEchoValueMacs: { Value: { Token: MAC } } }),
});

const stateWith = (extra: Partial<StackState> = {}, attested = false, macs = false): StackState =>
  ({
    version: 17,
    stackName: 'S',
    region: 'us-east-1',
    resources: { R: record(attested, macs) },
    outputs: {},
    lastModified: 0,
    ...extra,
  }) as StackState;

describe('State schema v18 — conditional on versionsSent (go-to-k/cdkd#6824)', () => {
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

  const savedVersion = async (state: StackState): Promise<unknown> => {
    client.send.mockResolvedValue({ ETag: '"new"' });
    await backend.saveState('S', 'us-east-1', state, { expectedEtag: '"e"' });
    const body = client.send.mock.calls
      .map(([command]) => (command as { input?: { Body?: unknown } }).input?.Body)
      .find((b): b is string => typeof b === 'string');
    return (JSON.parse(body!) as StackState).version;
  };

  it('v18 is current, and every version 1..18 is readable', () => {
    expect(STATE_SCHEMA_VERSION_CURRENT).toBe(18);
    for (let v = 1; v <= 18; v++) expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(v);
    expect(STATE_SCHEMA_VERSIONS_READABLE).not.toContain(19);
  });

  it('a plain singleton (no attestation) is saved as 16, a MAC beside it as 17', async () => {
    expect(await savedVersion(stateWith())).toBe(16);
    expect(stateSchemaVersionFor(stateWith({}, false, true))).toBe(17);
  });

  it.each([
    ['a resource', stateWith({}, true)],
    ['a resource beside a MAC', stateWith({}, true, true)],
    ['an orphan record', stateWith({ orphans: [{ logicalId: 'O', state: record(true) }] as never })],
    [
      'a superseded record',
      stateWith({
        supersededResources: [{ logicalId: 'R', supersededAt: 1, state: record(true) }] as never,
      }),
    ],
  ])('an attestation on %s makes the save stamp 18', async (_l, state) => {
    expect(stateSchemaVersionFor(state)).toBe(18);
    expect(await savedVersion(state)).toBe(18);
  });

  it('reads a v17 document unchanged and a v18 document with its attestation', async () => {
    serve(JSON.stringify(stateWith()));
    expect((await backend.getState('S', 'us-east-1'))?.state).toEqual(stateWith());
    serve(JSON.stringify({ ...stateWith({}, true), version: 18 }));
    const read = (await backend.getState('S', 'us-east-1'))?.state as StackState;
    expect(read.resources['R']?.referenceProvenance?.[TOKEN]?.versionsSent).toBe(true);
  });

  it('refuses version 19 with the "Upgrade cdkd" error, as a v17 binary refuses 18', async () => {
    serve(JSON.stringify({ version: 19, stackName: 'S', resources: {}, outputs: {}, lastModified: 0 }));
    const caught = await backend.getState('S', 'us-east-1').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(StateError);
    expect((caught as Error).message).toMatch(/Unsupported state schema version 19/);
    expect((caught as Error).message).toMatch(/Upgrade cdkd/);
  });
});
