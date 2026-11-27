import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#7001: every attribute the audit classifies as MOVING on an
 * in-place update promotes its reader, both in the diff (the reader is
 * re-resolved after the upstream update) and in the export-change guard (an
 * export of it counts as changed). Driven by the committed audit
 * (`docs/_generated/in-place-attr-coverage.json`, generated from
 * `scripts/in-place-attr-classification.ts`), not by the shared.ts tables, so
 * a row deleted from `src/analyzer/diff-calculator/shared.ts` fails here.
 *
 * DescribeType is refused for every type, so create-only paths come from the
 * committed snapshot as in an offline deploy; no AWS call is made.
 */
const mockCloudFormationSend = vi.fn(() =>
  Promise.reject(
    Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403, requestId: 'test-request-id' },
    })
  )
);

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: { send: mockCloudFormationSend },
  }),
}));

import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { HAND_IN_PLACE_UPDATE_STATUS_ATTRS } from '../../../src/analyzer/diff-calculator/shared.js';
import {
  findAffectedExports,
  findChangedDeferredExports,
} from '../../../src/deployment/export-change-guard.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

interface SdkRow {
  type: string;
  attribute: string;
  verdict: 'never' | 'moved-by' | 'any-update' | 'prefix';
  properties?: string[];
}

const REPORT = JSON.parse(
  readFileSync(join(process.cwd(), 'docs/_generated/in-place-attr-coverage.json'), 'utf8')
) as { sdk: SdkRow[]; ccHand: SdkRow[]; ccMoving: Record<string, string[]> };

/** A property no type declares: an edit that moves nothing a row names. */
const UNRELATED = 'UnrelatedSetting7001';

/**
 * Values for a property whose create-only NESTED path or conditional
 * replacement rule a bare string change would trip (the upstream would be
 * replaced, which promotes every reader on its own): an in-place edit of it.
 */
const SAMPLES: Readonly<Record<string, readonly [unknown, unknown]>> = {
  'AWS::BedrockAgentCore::Evaluator.EvaluatorConfig': [
    { LlmAsAJudge: { Instructions: 'a' } },
    { LlmAsAJudge: { Instructions: 'b' } },
  ],
  'AWS::Pipes::Pipe.SourceParameters': [
    { SqsQueueParameters: { BatchSize: 1 } },
    { SqsQueueParameters: { BatchSize: 5 } },
  ],
  'AWS::EC2::VPCEndpoint.DnsOptions': [
    { DnsRecordIpType: 'ipv4' },
    { DnsRecordIpType: 'dualstack' },
  ],
};

// go-to-k/cdkd#7007: a Cloud Control pair classified by hand drives it too.
const movedBy = [...REPORT.sdk, ...REPORT.ccHand].filter((r) => r.verdict === 'moved-by');
const anyUpdate = [...REPORT.sdk, ...REPORT.ccHand].filter((r) => r.verdict === 'any-update');
/** go-to-k/cdkd#7007: SDK operational statuses, judged after the update like a generated row. */
const isStatusRow = (r: SdkRow): boolean =>
  HAND_IN_PLACE_UPDATE_STATUS_ATTRS[r.type]?.has(r.attribute) === true;
const statusRows = anyUpdate.filter(isStatusRow);
/** go-to-k/cdkd#7007: the Cloud Control pairs a moving rule settles. */
const ccAnyUpdate: SdkRow[] = Object.entries(REPORT.ccMoving).flatMap(([type, attrs]) =>
  attrs.map((attribute) => ({ type, attribute, verdict: 'any-update' as const }))
);

/** One (row, property) case per property a `moved-by` row names. */
const movedByCases = movedBy.flatMap((r) =>
  r.properties!.map((prop) => [`${r.type} ${r.attribute} <- ${prop}`, r, prop] as const)
);

const resolverFor =
  (state: StackState) =>
  async (value: unknown): Promise<unknown> => {
    const resolve = async (v: unknown): Promise<unknown> => {
      if (v === null || typeof v !== 'object') return v;
      if (Array.isArray(v)) return Promise.all(v.map((item) => resolve(item)));
      const obj = v as Record<string, unknown>;
      if ('Fn::GetAtt' in obj && Object.keys(obj).length === 1) {
        const [id, attr] = obj['Fn::GetAtt'] as [string, string];
        const attrValue = state.resources[id]?.attributes?.[attr];
        if (attrValue === undefined) throw new Error(`GetAtt ${id}.${attr} not found`);
        return attrValue;
      }
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(obj)) out[k] = await resolve(val);
      return out;
    };
    return resolve(value);
  };

/** The upstream edited from `before` to `after`, read by an SSM parameter. */
async function diffReader(
  row: SdkRow,
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Promise<Map<string, ResourceChange>> {
  const state: StackState = {
    version: 1,
    stackName: 'TestStack',
    resources: {
      Up: {
        physicalId: 'up-physical-id',
        resourceType: row.type,
        properties: before,
        attributes: { [row.attribute]: 'recorded-value' },
      },
      Reader: {
        physicalId: 'reader',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Type: 'String', Value: 'recorded-value' },
        attributes: {},
      },
    },
    outputs: {},
    lastModified: 0,
  };
  const template: CloudFormationTemplate = {
    Resources: {
      Up: { Type: row.type, Properties: after },
      Reader: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Type: 'String', Value: { 'Fn::GetAtt': ['Up', row.attribute] } },
      },
    },
  };
  return new DiffCalculator().calculateDiff(state, template, resolverFor(state));
}

function expectInPlaceUpstream(changes: Map<string, ResourceChange>): void {
  const up = changes.get('Up');
  expect(up?.changeType).toBe('UPDATE');
  // Vacuity guard: a REPLACED upstream promotes every reader on its own.
  expect(up?.propertyChanges?.some((pc) => pc.requiresReplacement === true)).toBe(false);
}

function expectReaderPromoted(changes: Map<string, ResourceChange>): void {
  const reader = changes.get('Reader');
  expect(reader?.changeType).toBe('UPDATE');
  const pc = reader?.propertyChanges?.find((c) => c.path === 'Value');
  expect(pc?.inPlacePropagated).toBe(true);
}

describe('a reader of an attribute the audit classifies as moving follows it (#7001)', () => {
  it('the audit has moving rows to drive this suite', () => {
    // A floor read from nothing this suite derives: the committed audit at
    // the time of #7001 holds 60 moved-by and 5 any-update pairs.
    expect(movedBy.length).toBeGreaterThanOrEqual(60);
    expect(anyUpdate.length).toBeGreaterThanOrEqual(5);
    // ...and #7007's update-timestamp rule settles over 350 Cloud Control pairs.
    expect(ccAnyUpdate.length).toBeGreaterThan(350);
  });

  it.each(movedByCases)('%s promotes the reader', async (_name, row, prop) => {
    const [oldValue, newValue] = SAMPLES[`${row.type}.${prop}`] ?? ['old-value', 'new-value'];
    const changes = await diffReader(
      row,
      { [prop]: oldValue, [UNRELATED]: 'same' },
      { [prop]: newValue, [UNRELATED]: 'same' }
    );
    expectInPlaceUpstream(changes);
    expectReaderPromoted(changes);
  });

  it.each(movedBy.map((r) => [`${r.type} ${r.attribute}`, r] as const))(
    '%s: an edit of another property leaves the reader alone',
    async (_name, row) => {
      const changes = await diffReader(
        row,
        { [UNRELATED]: 'old-value' },
        { [UNRELATED]: 'new-value' }
      );
      expectInPlaceUpstream(changes);
      expect(changes.get('Reader')?.changeType).toBe('NO_CHANGE');
    }
  );

  it.each([...anyUpdate, ...ccAnyUpdate].map((r) => [`${r.type} ${r.attribute}`, r] as const))(
    '%s: any in-place edit promotes the reader',
    async (_name, row) => {
      const changes = await diffReader(
        row,
        { [UNRELATED]: 'old-value' },
        { [UNRELATED]: 'new-value' }
      );
      expectInPlaceUpstream(changes);
      expectReaderPromoted(changes);
    }
  );
});

describe('a managed policy AttachmentCount reader (#7001)', () => {
  const row: SdkRow = {
    type: 'AWS::IAM::ManagedPolicy',
    attribute: 'AttachmentCount',
    verdict: 'moved-by',
    properties: ['Roles', 'Users', 'Groups'],
  };

  it('follows a principal list that changes length', async () => {
    const changes = await diffReader(row, { Roles: ['a'] }, { Roles: ['a', 'b'] });
    expectReaderPromoted(changes);
  });

  it('is left alone by a same-length swap, which keeps the count', async () => {
    const changes = await diffReader(row, { Roles: ['a'] }, { Roles: ['b'] });
    expect(changes.get('Up')?.changeType).toBe('UPDATE');
    expect(changes.get('Reader')?.changeType).toBe('NO_CHANGE');
  });
});

describe('an S3 metadata table reader moves only when its table is created (#7001)', () => {
  const journal: SdkRow = {
    type: 'AWS::S3::Bucket',
    attribute: 'MetadataConfiguration.JournalTableConfiguration.TableArn',
    verdict: 'moved-by',
    properties: ['MetadataConfiguration'],
  };
  const inventory: SdkRow = {
    ...journal,
    attribute: 'MetadataConfiguration.InventoryTableConfiguration.TableArn',
  };
  const config = (days: number, inventoryState?: string) => ({
    Destination: { TableBucketType: 'aws' },
    JournalTableConfiguration: { RecordExpiration: { Expiration: 'ENABLED', Days: days } },
    ...(inventoryState !== undefined && {
      InventoryTableConfiguration: { ConfigurationState: inventoryState },
    }),
  });
  const guard = (row: SdkRow, oldValue: unknown, newValue: unknown) =>
    findAffectedExports({
      template: {
        Resources: { Up: { Type: row.type, Properties: {} } },
        Outputs: {
          Out: { Value: { 'Fn::GetAtt': ['Up', row.attribute] }, Export: { Name: 'X' } },
        },
      },
      conditions: {},
      changes: new Map([
        [
          'Up',
          {
            logicalId: 'Up',
            resourceType: row.type,
            changeType: 'UPDATE',
            propertyChanges: [
              { path: 'MetadataConfiguration', oldValue, newValue, requiresReplacement: false },
            ],
          },
        ],
      ]),
      currentState: {
        version: STATE_SCHEMA_VERSION_CURRENT,
        outputs: { Out: 'recorded-value', X: 'recorded-value' },
        exportNames: ['X'],
      } as unknown as StackState,
      resolve: () => Promise.resolve('recorded-value'),
      replaces: () => false,
    });

  it('a journal expiration edit or an inventory table turned on leaves the journal reader alone', async () => {
    for (const [before, after] of [
      [config(7), config(30)],
      [config(7), config(7, 'ENABLED')],
    ] as const) {
      const changes = await diffReader(
        journal,
        { MetadataConfiguration: before },
        { MetadataConfiguration: after }
      );
      expect(changes.get('Up')?.changeType).toBe('UPDATE');
      expect(changes.get('Reader')?.changeType).toBe('NO_CHANGE');
      expect(await guard(journal, before, after)).toEqual([]);
    }
  });

  it('adding the configuration promotes the journal reader and counts its export as changed', async () => {
    expectReaderPromoted(await diffReader(journal, {}, { MetadataConfiguration: config(7) }));
    expect(await guard(journal, undefined, config(7))).toEqual([
      { exportName: 'X', reason: 'changed' },
    ]);
  });

  it('removing the configuration promotes the journal reader', async () => {
    expectReaderPromoted(await diffReader(journal, { MetadataConfiguration: config(7) }, {}));
    expect(await guard(journal, config(7), undefined)).toEqual([
      { exportName: 'X', reason: 'changed' },
    ]);
  });

  it('an unreadable side (a scalar or an unresolved intrinsic) promotes, failing closed', async () => {
    const intrinsic = { 'Fn::If': ['Cond', config(7), { Ref: 'AWS::NoValue' }] };
    expect(await guard(journal, config(7), intrinsic)).toEqual([
      { exportName: 'X', reason: 'changed' },
    ]);
    expect(await guard(inventory, config(7, 'DISABLED'), intrinsic)).toEqual([
      { exportName: 'X', reason: 'changed' },
    ]);
    expect(await guard(journal, config(7), 'not-a-bag')).toEqual([
      { exportName: 'X', reason: 'changed' },
    ]);
  });

  it('an absent inventory table reads DISABLED: an explicit DISABLED moves nothing', async () => {
    const changes = await diffReader(
      inventory,
      { MetadataConfiguration: config(7) },
      { MetadataConfiguration: config(7, 'DISABLED') }
    );
    expect(changes.get('Up')?.changeType).toBe('UPDATE');
    expect(changes.get('Reader')?.changeType).toBe('NO_CHANGE');
    expect(await guard(inventory, config(7), config(7, 'DISABLED'))).toEqual([]);
  });

  it('an annotation reader follows the annotation table, not the inventory one', async () => {
    const annotation: SdkRow = {
      ...journal,
      attribute: 'MetadataConfiguration.AnnotationTableConfiguration.TableArn',
    };
    const withAnnotation = (state: string) => ({
      ...config(7),
      AnnotationTableConfiguration: { ConfigurationState: state },
    });
    expect(await guard(annotation, withAnnotation('ENABLED'), withAnnotation('DISABLED'))).toEqual([
      { exportName: 'X', reason: 'changed' },
    ]);
    expect(await guard(annotation, config(7, 'DISABLED'), config(7, 'ENABLED'))).toEqual([]);
  });

  it("an inventory reader follows its table's ConfigurationState, not a journal edit", async () => {
    const flip = [config(7, 'DISABLED'), config(7, 'ENABLED')] as const;
    expectReaderPromoted(
      await diffReader(inventory, { MetadataConfiguration: flip[0] }, { MetadataConfiguration: flip[1] })
    );
    expect(await guard(inventory, ...flip)).toEqual([{ exportName: 'X', reason: 'changed' }]);
    const journalOnly = [config(7, 'ENABLED'), config(30, 'ENABLED')] as const;
    const changes = await diffReader(
      inventory,
      { MetadataConfiguration: journalOnly[0] },
      { MetadataConfiguration: journalOnly[1] }
    );
    expect(changes.get('Reader')?.changeType).toBe('NO_CHANGE');
    expect(await guard(inventory, ...journalOnly)).toEqual([]);
  });
});

describe('the export-change guard counts an export of a moving attribute as changed (#7001)', () => {
  const EXPORT = 'Producer:ExportsOutputUp';

  const run = (row: SdkRow, path: string, replaced = false) =>
    findAffectedExports({
      template: {
        Resources: { Up: { Type: row.type, Properties: {} } },
        Outputs: {
          ExportsOutputUp: {
            Value: { 'Fn::GetAtt': ['Up', row.attribute] },
            Export: { Name: EXPORT },
          },
        },
      },
      conditions: {},
      changes: new Map([
        [
          'Up',
          {
            logicalId: 'Up',
            resourceType: row.type,
            changeType: 'UPDATE',
            propertyChanges: [
              { path, oldValue: 'old-value', newValue: 'new-value', requiresReplacement: false },
            ],
          },
        ],
      ]),
      currentState: {
        version: STATE_SCHEMA_VERSION_CURRENT,
        outputs: { ExportsOutputUp: 'recorded-value', [EXPORT]: 'recorded-value' },
        exportNames: [EXPORT],
      } as unknown as StackState,
      resolve: () => Promise.resolve('recorded-value'),
      replaces: () => replaced,
    });

  it.each(movedByCases)('%s', async (_name, row, prop) => {
    expect(await run(row, prop)).toEqual([{ exportName: EXPORT, reason: 'changed' }]);
    expect(await run(row, UNRELATED)).toEqual([]);
  });

  it.each(anyUpdate.filter((r) => !isStatusRow(r)).map((r) => [`${r.type} ${r.attribute}`, r] as const))(
    '%s on any edit',
    async (_name, row) => {
      expect(await run(row, UNRELATED)).toEqual([{ exportName: EXPORT, reason: 'changed' }]);
    }
  );
});

describe('an export of a Cloud Control update time is judged after the update (#7007)', () => {
  const EXPORT = 'Producer:ExportsOutputUp';
  const guard = (row: SdkRow, changeType: 'UPDATE' | 'DELETE', replaced: boolean) =>
    findAffectedExports({
      template: {
        Resources: { Up: { Type: row.type, Properties: {} } },
        Outputs: {
          ExportsOutputUp: {
            Value: { 'Fn::GetAtt': ['Up', row.attribute] },
            Export: { Name: EXPORT },
          },
        },
      },
      conditions: {},
      changes: new Map([
        [
          'Up',
          {
            logicalId: 'Up',
            resourceType: row.type,
            changeType,
            propertyChanges: [
              { path: 'Tags', oldValue: [], newValue: [{ Key: 'k', Value: 'v' }], requiresReplacement: false },
            ],
          },
        ],
      ]),
      currentState: {
        version: STATE_SCHEMA_VERSION_CURRENT,
        outputs: { ExportsOutputUp: 'recorded-value', [EXPORT]: 'recorded-value' },
        exportNames: [EXPORT],
      } as unknown as StackState,
      resolve: () => Promise.resolve('recorded-value'),
      replaces: () => replaced,
    });
  const after = (found: Awaited<ReturnType<typeof guard>>, value: string) =>
    findChangedDeferredExports(found, { outputs: { [EXPORT]: 'recorded-value' } }, () =>
      Promise.resolve(value)
    );

  it('every SDK operational status row is a hand any-update verdict (#7007 part 5)', () => {
    const rows = Object.entries(HAND_IN_PLACE_UPDATE_STATUS_ATTRS).flatMap(([type, attrs]) =>
      [...attrs].map((attribute) => `${type}.${attribute}`)
    );
    expect(rows.length).toBeGreaterThanOrEqual(24);
    expect(statusRows.map((r) => `${r.type}.${r.attribute}`).sort()).toEqual(rows.sort());
  });

  it.each([...ccAnyUpdate, ...statusRows].map((r) => [`${r.type} ${r.attribute}`, r] as const))(
    '%s: a tag edit defers; refused only when the value moved',
    async (_name, row) => {
      const found = await guard(row, 'UPDATE', false);
      expect(found).toEqual([
        { exportName: EXPORT, reason: 'deferred', value: { 'Fn::GetAtt': ['Up', row.attribute] } },
      ]);
      expect(await after(found, 'recorded-value')).toEqual([]);
      expect(await after(found, 'moved-value')).toEqual([{ exportName: EXPORT, reason: 'changed' }]);
    }
  );

  it('a replaced or deleted upstream is still refused at plan time', async () => {
    const row = ccAnyUpdate[0]!;
    expect(await guard(row, 'UPDATE', true)).toEqual([{ exportName: EXPORT, reason: 'changed' }]);
    expect(await guard(row, 'DELETE', false)).toEqual([{ exportName: EXPORT, reason: 'changed' }]);
  });

  it('a hand any-update row is still a plan-time change', async () => {
    const row = anyUpdate.find((r) => r.type === 'AWS::EC2::Instance' && !isStatusRow(r))!;
    expect(await guard(row, 'UPDATE', false)).toEqual([{ exportName: EXPORT, reason: 'changed' }]);
  });
});

describe('a server certificate Path change moves no ARN (#7007)', () => {
  // The Cloud Control handler cannot apply a Path (no
  // iam:UpdateServerCertificate; measured: the ARN stayed), so an imported
  // Arn export is not refused, as CloudFormation accepts the deploy.
  it('does not refuse an imported Arn export on a Path-only change', async () => {
    const EXPORT = 'Producer:CertArn';
    const found = await findAffectedExports({
      template: {
        Resources: { Cert: { Type: 'AWS::IAM::ServerCertificate', Properties: {} } },
        Outputs: {
          CertArn: { Value: { 'Fn::GetAtt': ['Cert', 'Arn'] }, Export: { Name: EXPORT } },
        },
      },
      conditions: {},
      changes: new Map([
        [
          'Cert',
          {
            logicalId: 'Cert',
            resourceType: 'AWS::IAM::ServerCertificate',
            changeType: 'UPDATE',
            propertyChanges: [
              { path: 'Path', oldValue: '/a/', newValue: '/b/', requiresReplacement: false },
            ],
          },
        ],
      ]),
      currentState: {
        version: STATE_SCHEMA_VERSION_CURRENT,
        outputs: { CertArn: 'recorded-value', [EXPORT]: 'recorded-value' },
        exportNames: [EXPORT],
      } as unknown as StackState,
      resolve: () => Promise.resolve('recorded-value'),
      replaces: () => false,
    });
    expect(found).toEqual([]);
  });
});
