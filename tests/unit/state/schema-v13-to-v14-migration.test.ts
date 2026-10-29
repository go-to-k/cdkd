import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  STATE_SCHEMA_VERSIONS_READABLE,
  type ResourceState,
  type StackState,
} from '../../../src/types/state.js';
import { clearBucketRegionCache } from '../../../src/utils/aws-region-resolver.js';
import {
  unsettledPropertiesOf,
  withUnsettledProperties,
  withoutUnsettledProperties,
} from '../../../src/state/unsettled-properties.js';

/**
 * Schema v14 — `ResourceState.unsettledProperties` (go-to-k/cdkd#5380).
 *
 * Through the REAL `S3StateBackend` read path, over a VERBATIM v13 document:
 * every version through 14 stays readable, a v13 document is read
 * unchanged (nothing unsettled), and a v14 document round-trips the names. The
 * current version and the refusal past it are pinned by the latest bump's
 * test (`schema-v14-to-v15-migration.test.ts`). What
 * the deploy engine writes is pinned in
 * `tests/unit/deployment/deploy-engine-unsettled-properties-5380.test.ts`.
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

const ENC = 'DeliveryStreamEncryptionConfigurationInput';

/** A v13 binary's `state.json`. */
const V13_DOCUMENT = `{
  "version": 13,
  "stackName": "LegacyV13",
  "region": "us-east-1",
  "resources": {
    "Stream": {
      "physicalId": "legacyv13-stream",
      "resourceType": "AWS::KinesisFirehose::DeliveryStream",
      "properties": { "DeliveryStreamName": "legacyv13-stream" },
      "attributes": {},
      "dependencies": [],
      "provisionedBy": "sdk"
    }
  },
  "outputs": {},
  "exportNames": [],
  "lastModified": 1793000000000
}`;

describe('State schema v14 — unsettledProperties (go-to-k/cdkd#5380)', () => {
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

  it('every version 1..14 stays readable (v15, go-to-k/cdkd#5498, is current)', () => {
    expect(STATE_SCHEMA_VERSION_CURRENT).toBeGreaterThanOrEqual(14);
    for (const v of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]) {
      expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(v);
    }
  });

  it('reads a verbatim v13 document unchanged, with nothing unsettled, and writes nothing on read', async () => {
    serve(V13_DOCUMENT);
    const state = (await backend.getState('LegacyV13', 'us-east-1'))?.state as StackState;
    expect(state).toEqual(JSON.parse(V13_DOCUMENT));
    expect(unsettledPropertiesOf(state.resources['Stream']).size).toBe(0);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('reads a v14 document carrying unsettled names as written', async () => {
    const v14 = JSON.parse(V13_DOCUMENT) as StackState;
    v14.version = 14;
    v14.resources['Stream']!.unsettledProperties = [ENC];
    serve(JSON.stringify(v14));
    const state = (await backend.getState('LegacyV13', 'us-east-1'))?.state as StackState;
    expect(state).toEqual(v14);
    expect([...unsettledPropertiesOf(state.resources['Stream'])]).toEqual([ENC]);
  });

  it('saves the current version with the names intact', async () => {
    client.send.mockResolvedValue({ ETag: '"new"' });
    const state = JSON.parse(V13_DOCUMENT) as StackState;
    state.resources['Stream']!.unsettledProperties = [ENC];
    await backend.saveState('LegacyV13', 'us-east-1', state, { expectedEtag: '"e"' });
    const body = client.send.mock.calls
      .map(([command]) => (command as { input?: { Body?: unknown } }).input?.Body)
      .find((b): b is string => typeof b === 'string');
    const saved = JSON.parse(body!) as StackState;
    expect(saved.version).toBe(STATE_SCHEMA_VERSION_CURRENT);
    expect(saved.resources['Stream']!.unsettledProperties).toEqual([ENC]);
  });
});

describe('unsettledPropertiesOf / withUnsettledProperties / withoutUnsettledProperties', () => {
  const record = (extra: Partial<ResourceState> = {}): ResourceState =>
    ({ physicalId: 'p', resourceType: 'T', properties: {}, ...extra }) as ResourceState;

  it('reads the names, a malformed field or entry as none', () => {
    expect([...unsettledPropertiesOf(record({ unsettledProperties: ['B', 'A'] }))]).toEqual(['B', 'A']);
    expect(unsettledPropertiesOf(record()).size).toBe(0);
    expect(unsettledPropertiesOf(null).size).toBe(0);
    expect(unsettledPropertiesOf(record({ unsettledProperties: 'A' as never })).size).toBe(0);
    expect([
      ...unsettledPropertiesOf(record({ unsettledProperties: ['A', 7, '', null] as never })),
    ]).toEqual(['A']);
  });

  it('adds names as a sorted, deduplicated union with the record\'s own', () => {
    expect(withUnsettledProperties(record({ unsettledProperties: ['C'] }), ['A', 'C', 'B'])).toEqual(
      record({ unsettledProperties: ['A', 'B', 'C'] })
    );
  });

  it('returns the record itself when nothing is added, and adds no key for no names', () => {
    const held = record({ unsettledProperties: ['A'] });
    expect(withUnsettledProperties(held, ['A'])).toBe(held);
    const none = record();
    expect(Object.hasOwn(withUnsettledProperties(none, []), 'unsettledProperties')).toBe(false);
    expect(Object.hasOwn(withUnsettledProperties(none, ['']), 'unsettledProperties')).toBe(false);
  });

  it('removes the field, and returns a record without one as it is', () => {
    const cleared = withoutUnsettledProperties(record({ unsettledProperties: ['A'] }));
    expect(Object.hasOwn(cleared, 'unsettledProperties')).toBe(false);
    const none = record();
    expect(withoutUnsettledProperties(none)).toBe(none);
  });
});
