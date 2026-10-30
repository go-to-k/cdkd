import { describe, it, expect, vi } from 'vite-plus/test';

// The createOnly fallback is DescribeType-backed; serve the type's create-only
// set without an AWS call. The comparison beside it runs for real.
vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-properties.js')
  >('../../../src/provisioning/create-only-properties.js');
  return {
    ...actual,
    getCreateOnlyPropertyPaths: async () => [
      ['IcebergMetadata'],
      ['OpenTableFormat'],
      ['StorageClassConfiguration'],
      ['TableBucketARN'],
      ['WithoutMetadata'],
    ],
  };
});

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#5572 — the DIFF half. A record an earlier cdkd wrote under
 * `--allow-unsupported-properties AWS::S3Tables::Table:StorageClassConfiguration`
 * holds the key and names it in `acceptedCreateOnlyDrops`; AWS never got it.
 * After #2762 made the SDK provider write it, the unchanged template diffed
 * NO_CHANGE. It now reports the addition, a replacement.
 */
describe('DiffCalculator — an unwritten create-only key the provider now writes (#5572)', () => {
  const TYPE = 'AWS::S3Tables::Table';
  const KEY = 'StorageClassConfiguration';
  const WRITTEN = {
    TableBucketARN: 'arn:aws:s3tables:us-east-1:123456789012:bucket/b',
    Namespace: 'ns',
    TableName: 't',
    OpenTableFormat: 'ICEBERG',
  };
  const DECLARED = { ...WRITTEN, [KEY]: { StorageClass: 'INTELLIGENT_TIERING' } };

  function stateWith(evidence: string[] | null): StackState {
    return {
      version: 7,
      region: 'us-east-1',
      stackName: 's3t-stack',
      resources: {
        IcebergTable: {
          physicalId: 'ns|t',
          resourceType: TYPE,
          properties: DECLARED,
          attributes: {},
          dependencies: [],
          provisionedBy: 'sdk',
          ...(evidence !== null && { acceptedCreateOnlyDrops: evidence }),
        },
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
  }

  async function diff(state: StackState, properties: Record<string, unknown>, allowed?: ReadonlySet<string>) {
    const template: CloudFormationTemplate = {
      Resources: { IcebergTable: { Type: TYPE, Properties: properties } },
    };
    const changes = await new DiffCalculator().calculateDiff(
      state,
      template,
      undefined,
      undefined,
      allowed
    );
    return changes.get('IcebergTable')!;
  }

  it('reports a REPLACEMENT for the unchanged template', async () => {
    const change = await diff(stateWith([KEY]), DECLARED, new Set());
    expect(change.changeType).toBe('UPDATE');
    expect(change.propertyChanges).toEqual([
      expect.objectContaining({
        path: KEY,
        oldValue: undefined,
        newValue: DECLARED[KEY],
        requiresReplacement: true,
      }),
    ]);
  });

  it('reports it under the old flag too: a handled key is no longer a drop it can accept', async () => {
    const change = await diff(stateWith([KEY]), DECLARED, new Set([`${TYPE}:${KEY}`]));
    expect(change.changeType).toBe('UPDATE');
  });

  it('stays NO_CHANGE for a record with no evidence (AWS is presumed to hold it)', async () => {
    const change = await diff(stateWith(null), DECLARED, new Set());
    expect(change.changeType).toBe('NO_CHANGE');
  });

  it('never reports a replacement the refusal does not cover: a canonicalizer-only difference stays NO_CHANGE', async () => {
    // The record holds 5, the template "5"; the provider's canonicalizer makes
    // them equal, so the diff calls it NO_CHANGE. The refusal's own test is
    // raw, so it would NOT refuse this key: had the record side dropped it, the
    // unchanged template would read as an added create-only key and the
    // deploy would replace the table with no opt-in.
    const recorded = { ...WRITTEN, [KEY]: { StorageClass: 5 } };
    const declared = { ...WRITTEN, [KEY]: { StorageClass: '5' } };
    const state = stateWith([KEY]);
    state.resources['IcebergTable']!.properties = recorded;
    const template: CloudFormationTemplate = {
      Resources: { IcebergTable: { Type: TYPE, Properties: declared } },
    };
    const canonicalize = (_type: string, props: Record<string, unknown>) => {
      const sc = props[KEY] as { StorageClass?: unknown } | undefined;
      return sc === undefined
        ? props
        : { ...props, [KEY]: { ...sc, StorageClass: String(sc.StorageClass) } };
    };
    const changes = await new DiffCalculator().calculateDiff(
      state,
      template,
      undefined,
      canonicalize,
      new Set()
    );
    expect(changes.get('IcebergTable')!.changeType).toBe('NO_CHANGE');
  });

  it('stays NO_CHANGE when the template removes the key AWS never held', async () => {
    const change = await diff(stateWith([KEY]), WRITTEN, new Set());
    expect(change.changeType).toBe('NO_CHANGE');
  });
});
