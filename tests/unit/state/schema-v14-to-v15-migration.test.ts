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
  UNSETTLED_ITEMS_PER_PATH_CAP,
  UNSETTLED_ITEM_LENGTH_CAP,
  isUsableAttemptedName,
  unsettledContextOf,
  unsettledItemsField,
  unsettledItemsOf,
  withUnsettledItems,
  withoutUnsettledProperties,
} from '../../../src/state/unsettled-properties.js';

/**
 * Schema v15 — `ResourceState.unsettledItems` (go-to-k/cdkd#5498): the item
 * names a failed in-place update's calls were accepted for, under the
 * unsettled top-level keys they belong to.
 *
 * Through the REAL `S3StateBackend` read path, over a VERBATIM v14 document:
 * every version through 15 stays readable, a v14 document is read unchanged
 * (no attempted items), and a v15 document round-trips them. The current
 * version and the refusal past it are pinned by the latest bump's test
 * (`schema-v15-to-v16-migration.test.ts`).
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

/** A v14 binary's `state.json`, holding an unsettled mark. */
const V14_DOCUMENT = `{
  "version": 14,
  "stackName": "LegacyV14",
  "region": "us-east-1",
  "resources": {
    "Table": {
      "physicalId": "legacyv14-table",
      "resourceType": "AWS::DynamoDB::Table",
      "properties": { "TableName": "legacyv14-table" },
      "attributes": {},
      "dependencies": [],
      "provisionedBy": "sdk",
      "unsettledProperties": ["GlobalSecondaryIndexes"]
    }
  },
  "outputs": {},
  "exportNames": [],
  "lastModified": 1793000000000
}`;

describe('State schema v15 — unsettledItems (go-to-k/cdkd#5498)', () => {
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

  it('every version 1..15 stays readable (v16, go-to-k/cdkd#6170, is current)', () => {
    expect(STATE_SCHEMA_VERSION_CURRENT).toBeGreaterThanOrEqual(15);
    for (let v = 1; v <= 15; v++) expect(STATE_SCHEMA_VERSIONS_READABLE).toContain(v);
  });

  it('reads a verbatim v14 document unchanged, with no attempted items, and writes nothing on read', async () => {
    serve(V14_DOCUMENT);
    const state = (await backend.getState('LegacyV14', 'us-east-1'))?.state as StackState;
    expect(state).toEqual(JSON.parse(V14_DOCUMENT));
    expect(unsettledItemsOf(state.resources['Table']).size).toBe(0);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('reads a v15 document carrying attempted items as written', async () => {
    const v15 = JSON.parse(V14_DOCUMENT) as StackState;
    v15.version = 15;
    v15.resources['Table']!.unsettledItems = { GlobalSecondaryIndexes: ['gsi2'] };
    serve(JSON.stringify(v15));
    const state = (await backend.getState('LegacyV14', 'us-east-1'))?.state as StackState;
    expect(state).toEqual(v15);
    expect([...unsettledItemsOf(state.resources['Table']).get('GlobalSecondaryIndexes')!]).toEqual([
      'gsi2',
    ]);
  });

  it('saves the current version with the items intact', async () => {
    client.send.mockResolvedValue({ ETag: '"new"' });
    const state = JSON.parse(V14_DOCUMENT) as StackState;
    state.resources['Table']!.unsettledItems = { GlobalSecondaryIndexes: ['gsi2'] };
    await backend.saveState('LegacyV14', 'us-east-1', state, { expectedEtag: '"e"' });
    const body = client.send.mock.calls
      .map(([command]) => (command as { input?: { Body?: unknown } }).input?.Body)
      .find((b): b is string => typeof b === 'string');
    const saved = JSON.parse(body!) as StackState;
    expect(saved.version).toBe(STATE_SCHEMA_VERSION_CURRENT);
    expect(saved.resources['Table']!.unsettledItems).toEqual({ GlobalSecondaryIndexes: ['gsi2'] });
  });
});

describe('unsettledItems helpers (go-to-k/cdkd#5498)', () => {
  const record = (extra: Partial<ResourceState> = {}): ResourceState =>
    ({ physicalId: 'p', resourceType: 'T', properties: {}, ...extra }) as ResourceState;
  const GSI = 'GlobalSecondaryIndexes';

  it('reads only paths under an unsettled top key', () => {
    const r = record({
      unsettledProperties: [GSI],
      unsettledItems: { [GSI]: ['a'], Tags: ['k'], [`${GSI}.x`]: ['b'] },
    });
    const items = unsettledItemsOf(r);
    expect([...items.keys()].sort()).toEqual([GSI, `${GSI}.x`]);
    // No unsettled names: the items are not readable at all.
    expect(unsettledItemsOf(record({ unsettledItems: { [GSI]: ['a'] } })).size).toBe(0);
  });

  it('reads a malformed field or entry as none', () => {
    const base = { unsettledProperties: [GSI] };
    expect(unsettledItemsOf(null).size).toBe(0);
    expect(unsettledItemsOf(record({ ...base, unsettledItems: ['a'] as never })).size).toBe(0);
    expect(unsettledItemsOf(record({ ...base, unsettledItems: 'a' as never })).size).toBe(0);
    expect(unsettledItemsOf(record({ ...base, unsettledItems: { [GSI]: 'a' as never } })).size).toBe(0);
    expect([
      ...unsettledItemsOf(record({ ...base, unsettledItems: { [GSI]: ['a', 7, '', null] as never } })).get(GSI)!,
    ]).toEqual(['a']);
  });

  it('drops an over-long entry, and a whole path over the per-path cap', () => {
    const base = { unsettledProperties: [GSI] };
    const long = 'x'.repeat(UNSETTLED_ITEM_LENGTH_CAP + 1);
    const edge = 'y'.repeat(UNSETTLED_ITEM_LENGTH_CAP);
    expect([
      ...unsettledItemsOf(record({ ...base, unsettledItems: { [GSI]: [long, edge] } })).get(GSI)!,
    ]).toEqual([edge]);
    const at = Array.from({ length: UNSETTLED_ITEMS_PER_PATH_CAP }, (_, i) => `n${i}`);
    expect(unsettledItemsOf(record({ ...base, unsettledItems: { [GSI]: at } })).get(GSI)!.size).toBe(
      UNSETTLED_ITEMS_PER_PATH_CAP
    );
    const over = [...at, 'one-more'];
    expect(unsettledItemsOf(record({ ...base, unsettledItems: { [GSI]: over } })).size).toBe(0);
  });

  it('withUnsettledItems adds a sorted union under unsettled keys only', () => {
    const r = record({ unsettledProperties: [GSI], unsettledItems: { [GSI]: ['c'] } });
    const out = withUnsettledItems(
      r,
      new Map([
        [GSI, ['a', 'c', 'b']],
        ['Tags', ['k']],
      ])
    );
    expect(out.unsettledItems).toEqual({ [GSI]: ['a', 'b', 'c'] });
  });

  it('withUnsettledItems returns the record itself when nothing is added', () => {
    const r = record({ unsettledProperties: [GSI], unsettledItems: { [GSI]: ['a'] } });
    expect(withUnsettledItems(r, new Map([[GSI, ['a']]]))).toBe(r);
    const none = record({ unsettledProperties: [GSI] });
    expect(Object.hasOwn(withUnsettledItems(none, new Map([[GSI, ['']]])), 'unsettledItems')).toBe(
      false
    );
    // An unsettled key is required: items for a settled key are not written.
    const settled = record();
    expect(withUnsettledItems(settled, new Map([[GSI, ['a']]]))).toBe(settled);
  });

  it('withUnsettledItems does not write a path grown past the cap', () => {
    const at = Array.from({ length: UNSETTLED_ITEMS_PER_PATH_CAP }, (_, i) => `n${i}`);
    const r = record({ unsettledProperties: [GSI], unsettledItems: { [GSI]: at } });
    const out = withUnsettledItems(r, new Map([[GSI, ['one-more']]]));
    expect(out.unsettledItems).toEqual({});
    expect(unsettledItemsOf(out).size).toBe(0);
  });

  it('unsettledItemsField keeps only the paths under the kept keys', () => {
    const r = record({
      unsettledProperties: [GSI, 'Tags'],
      unsettledItems: { [GSI]: ['b', 'a'], Tags: ['k'] },
    });
    expect(unsettledItemsField(r, [GSI])).toEqual({ unsettledItems: { [GSI]: ['a', 'b'] } });
    expect(unsettledItemsField(r, [])).toEqual({});
    expect(unsettledItemsField(undefined, [GSI])).toEqual({});
  });

  it('withoutUnsettledProperties strips the items with the names', () => {
    const cleared = withoutUnsettledProperties(
      record({ unsettledProperties: [GSI], unsettledItems: { [GSI]: ['a'] } })
    );
    expect(Object.hasOwn(cleared, 'unsettledProperties')).toBe(false);
    expect(Object.hasOwn(cleared, 'unsettledItems')).toBe(false);
    // A stray items field without names is stripped too.
    const stray = withoutUnsettledProperties(record({ unsettledItems: { [GSI]: ['a'] } }));
    expect(Object.hasOwn(stray, 'unsettledItems')).toBe(false);
  });

  it('unsettledContextOf merges the attempted items of every record', () => {
    const ctx = unsettledContextOf(
      record({ unsettledProperties: [GSI], unsettledItems: { [GSI]: ['a'] } }),
      record({ unsettledProperties: [GSI], unsettledItems: { [GSI]: ['b'] } })
    );
    expect([...ctx.unsettledItems!.get(GSI)!].sort()).toEqual(['a', 'b']);
    expect(unsettledContextOf(record({ unsettledProperties: [GSI] })).unsettledItems).toBeUndefined();
    expect(unsettledContextOf(record({ unsettledItems: { [GSI]: ['a'] } }))).toEqual({});
  });

  it('isUsableAttemptedName refuses a dynamic reference and a masked name', () => {
    expect(isUsableAttemptedName('gsi2')).toBe(true);
    expect(isUsableAttemptedName('{{resolve:secretsmanager:s}}')).toBe(false);
    expect(isUsableAttemptedName('pre-{{resolve:ssm:p}}')).toBe(false);
    expect(isUsableAttemptedName('***')).toBe(false);
    expect(isUsableAttemptedName('idx-***')).toBe(false);
  });
});
