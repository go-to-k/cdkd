import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSION_WITHOUT_NOECHO_MACS,
  STATE_SCHEMA_VERSIONS_READABLE,
  stateSchemaVersionFor,
  type StackState,
} from '../../../src/types/state.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';
import { StateError } from '../../../src/utils/error-handler.js';

/**
 * Schema v17 — `ResourceState.noEchoValueMacs` (go-to-k/cdkd#6146), a
 * CONDITIONAL bump: a save stamps 17 only when some record carries NoEcho value
 * MACs, so an older binary (whose failed update would keep a stale MAC
 * verbatim) refuses exactly those states, and every other state stays 16.
 *
 * Through the REAL `S3StateBackend` read and save paths: v17 is current and
 * every older version readable, a v16 document is read unchanged and saved as
 * 16, a state with a MAC is saved as 17 (wherever the record sits), and a
 * version past 17 is refused with "Upgrade cdkd", as a v16 binary refuses 17.
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

const MAC = 'kms-hmac-sha256:arn:aws:kms:us-east-1:123456789012:key/k:AAAA';

const record = (macs: boolean) => ({
  physicalId: '/p/r',
  resourceType: 'AWS::SSM::Parameter',
  properties: { Name: '/p/r', Value: '***' },
  attributes: {},
  dependencies: [],
  noEchoLeaves: [['Value']],
  ...(macs && { noEchoValueMacs: { Value: { Token: MAC } } }),
});

const stateWith = (extra: Partial<StackState> = {}, macs = false): StackState =>
  ({
    version: 16,
    stackName: 'S',
    region: 'us-east-1',
    resources: { R: record(macs) },
    outputs: {},
    lastModified: 0,
    ...extra,
  }) as StackState;

describe('State schema v17 — conditional on noEchoValueMacs (go-to-k/cdkd#6146)', () => {
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

  it('v17 is the current version, and every version 1..17 is readable', () => {
    expect(STATE_SCHEMA_VERSION_CURRENT).toBe(17);
    expect(STATE_SCHEMA_VERSION_WITHOUT_NOECHO_MACS).toBe(16);
    for (let v = 1; v <= 17; v++) expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(v);
    expect(STATE_SCHEMA_VERSIONS_READABLE).not.toContain(18);
  });

  it('a state with no MAC is saved as 16, so an older binary still reads it', async () => {
    expect(await savedVersion(stateWith())).toBe(16);
  });

  it.each([
    ['a resource', stateWith({}, true)],
    ['an orphan record', stateWith({ orphans: [{ logicalId: 'O', state: record(true) }] as never })],
    [
      'a superseded record',
      stateWith({
        supersededResources: [{ logicalId: 'R', supersededAt: 1, state: record(true) }] as never,
      }),
    ],
  ])('a MAC on %s makes the save stamp 17', async (_l, state) => {
    expect(stateSchemaVersionFor(state)).toBe(17);
    expect(await savedVersion(state)).toBe(17);
  });

  it('a superseded or orphan wrapper whose record holds no MAC stays 16', () => {
    expect(
      stateSchemaVersionFor(
        stateWith({
          orphans: [{ logicalId: 'O', state: record(false) }] as never,
          supersededResources: [{ logicalId: 'R', supersededAt: 1, state: record(false) }] as never,
        })
      )
    ).toBe(16);
  });

  it('reads a v16 document unchanged and a v17 document with its MAC', async () => {
    serve(JSON.stringify(stateWith()));
    expect((await backend.getState('S', 'us-east-1'))?.state).toEqual(stateWith());
    const v17 = { ...stateWith({}, true), version: 17 };
    serve(JSON.stringify(v17));
    const read = (await backend.getState('S', 'us-east-1'))?.state as StackState;
    expect(read.resources['R']?.noEchoValueMacs).toEqual({ Value: { Token: MAC } });
  });

  it('refuses version 18 with the "Upgrade cdkd" error, as a v16 binary refuses 17', async () => {
    serve(JSON.stringify({ version: 18, stackName: 'S', resources: {}, outputs: {}, lastModified: 0 }));
    const caught = await backend.getState('S', 'us-east-1').catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(StateError);
    expect((caught as Error).message).toMatch(/Unsupported state schema version 18/);
    expect((caught as Error).message).toMatch(/Upgrade cdkd/);
  });
});
