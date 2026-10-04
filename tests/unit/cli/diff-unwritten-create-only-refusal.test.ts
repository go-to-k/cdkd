import { describe, it, expect } from 'vite-plus/test';
import { findUnwrittenCreateOnlyRefusals } from '../../../src/cli/commands/diff-recursive.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#2790 — `cdkd diff` says which replacement rows `cdkd deploy`
 * refuses with `CREATE_ONLY_DROP_NEEDS_REPLACEMENT`, through the engine's own
 * predicate (`unwrittenCreateOnlyReplacement`).
 */
describe('findUnwrittenCreateOnlyRefusals', () => {
  const TYPE = 'AWS::EC2::Subnet';
  const DECLARED = { VpcId: 'vpc-1', CidrBlock: '10.0.0.0/24', AvailabilityZoneId: 'use1-az1' };

  function change(replacing: Array<[string, unknown]>): ResourceChange {
    return {
      logicalId: 'MySubnet',
      changeType: 'UPDATE',
      resourceType: TYPE,
      desiredProperties: DECLARED,
      currentProperties: DECLARED,
      propertyChanges: replacing.map(([path, newValue]) => ({
        path,
        oldValue: undefined,
        newValue,
        requiresReplacement: true,
      })),
    };
  }

  function record(extra: Partial<ResourceState> = {}): ResourceState {
    return {
      physicalId: 'subnet-1',
      resourceType: TYPE,
      properties: DECLARED,
      provisionedBy: 'sdk',
      acceptedCreateOnlyDrops: ['AvailabilityZoneId'],
      ...extra,
    };
  }

  const ROW = change([['AvailabilityZoneId', 'use1-az1']]);

  it('labels a row whose only replacement driver is a named, unchanged key', () => {
    const reasons = findUnwrittenCreateOnlyRefusals(new Map([['MySubnet', ROW]]), {
      MySubnet: record(),
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('MySubnet (AWS::EC2::Subnet)');
    expect(reasons[0]).toContain('CREATE_ONLY_DROP_NEEDS_REPLACEMENT');
    expect(reasons[0]).toContain('AvailabilityZoneId');
  });

  it.each([
    ['an imported record (no evidence)', { acceptedCreateOnlyDrops: undefined }],
    ['a cc-api record', { provisionedBy: 'cc-api' as const }],
    ['a record of another type', { resourceType: 'AWS::EC2::VPC' }],
  ])('does not label %s', (_label, extra) => {
    expect(
      findUnwrittenCreateOnlyRefusals(new Map([['MySubnet', ROW]]), { MySubnet: record(extra) })
    ).toEqual([]);
  });

  it('does not label a row another property also replaces', () => {
    const row = change([
      ['AvailabilityZoneId', 'use1-az1'],
      ['CidrBlock', '10.0.1.0/24'],
    ]);
    expect(
      findUnwrittenCreateOnlyRefusals(new Map([['MySubnet', row]]), { MySubnet: record() })
    ).toEqual([]);
  });

  it('does not label a row whose value the template changed', () => {
    const row = change([['AvailabilityZoneId', 'use1-az2']]);
    expect(
      findUnwrittenCreateOnlyRefusals(new Map([['MySubnet', row]]), { MySubnet: record() })
    ).toEqual([]);
  });

  it('ignores a row with no record', () => {
    expect(findUnwrittenCreateOnlyRefusals(new Map([['MySubnet', ROW]]), {})).toEqual([]);
  });
});
