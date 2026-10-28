/**
 * go-to-k/cdkd#5380: a record's `unsettledProperties` makes the diff an
 * in-place UPDATE of each named key even when the template and the record
 * agree (labelled `unsettled`, never a replacement), the security diff reads
 * such a change as synthetic, and a rollback / `drift --revert` record built
 * after a successful `update()` carries no unsettled names.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

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
import { securityDiffTemplates } from '../../../src/analyzer/security-diff.js';
import { recordAfterRollbackUpdate } from '../../../src/deployment/rollback-executor/replay-retry.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const TYPE = 'AWS::KinesisFirehose::DeliveryStream';
const ENC = 'DeliveryStreamEncryptionConfigurationInput';

function record(extra: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'stream',
    resourceType: TYPE,
    properties: { DeliveryStreamName: 'stream' },
    attributes: {},
    dependencies: [],
    ...extra,
  } as ResourceState;
}

function stateOf(r: ResourceState): StackState {
  return {
    version: 14,
    stackName: 's',
    region: 'us-east-1',
    resources: { S: r },
    outputs: {},
    lastModified: 0,
  } as StackState;
}

const template = (properties: Record<string, unknown>): CloudFormationTemplate =>
  ({ Resources: { S: { Type: TYPE, Properties: properties } } }) as CloudFormationTemplate;

describe('DiffCalculator and unsettled properties (go-to-k/cdkd#5380)', () => {
  it('an unsettled key with an unchanged template is an in-place UPDATE labelled unsettled', async () => {
    const changes = await new DiffCalculator().calculateDiff(
      stateOf(record({ unsettledProperties: [ENC] })),
      template({ DeliveryStreamName: 'stream' })
    );
    const change = changes.get('S');
    expect(change?.changeType).toBe('UPDATE');
    expect(change?.propertyChanges).toEqual([
      { path: ENC, oldValue: undefined, newValue: undefined, requiresReplacement: false, unsettled: true },
    ]);
  });

  it('the same record without the field is NO_CHANGE', async () => {
    const changes = await new DiffCalculator().calculateDiff(
      stateOf(record()),
      template({ DeliveryStreamName: 'stream' })
    );
    expect(changes.get('S')?.changeType).toBe('NO_CHANGE');
  });

  it('a key the template also changed is listed once, as the template change', async () => {
    const changes = await new DiffCalculator().calculateDiff(
      stateOf(record({ unsettledProperties: [ENC] })),
      template({ DeliveryStreamName: 'stream', [ENC]: { KeyType: 'AWS_OWNED_CMK' } })
    );
    const pcs = changes.get('S')?.propertyChanges ?? [];
    expect(pcs.filter((pc) => pc.path === ENC)).toHaveLength(1);
    expect(pcs[0]?.unsettled).toBeUndefined();
  });
});

describe('securityDiffTemplates reads an unsettled change as synthetic', () => {
  it('leaves it out of both templates', () => {
    const out = securityDiffTemplates(
      [
        {
          logicalId: 'S',
          changeType: 'UPDATE',
          resourceType: TYPE,
          currentProperties: { DeliveryStreamName: 'stream' },
          desiredProperties: { DeliveryStreamName: 'stream' },
          propertyChanges: [
            { path: ENC, oldValue: undefined, newValue: undefined, requiresReplacement: false, unsettled: true },
          ],
        },
      ],
      { S: record() }
    );
    expect(out.oldTemplate.Resources).toEqual({});
    expect(out.newTemplate.Resources).toEqual({});
  });
});

describe('recordAfterRollbackUpdate settles what a failed deploy left unsettled', () => {
  it.each([
    ['an undefined result', undefined],
    ['an in-place result with nothing to record', { physicalId: 'stream', wasReplaced: false }],
    ['a result with attributes', { physicalId: 'stream', wasReplaced: false, attributes: { Arn: 'a' } }],
  ])('%s', (_label, result) => {
    const next = recordAfterRollbackUpdate(record({ unsettledProperties: [ENC] }), result as never);
    expect(Object.hasOwn(next, 'unsettledProperties')).toBe(false);
  });

  it('keeps every other field of the restored record', () => {
    const restored = record({ unsettledProperties: [ENC], deletionPolicy: 'Retain' });
    const next = recordAfterRollbackUpdate(restored, undefined);
    expect(next).toEqual(record({ deletionPolicy: 'Retain' }));
  });
});
