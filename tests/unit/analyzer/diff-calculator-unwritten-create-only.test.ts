import { describe, it, expect, vi } from 'vite-plus/test';

// The createOnly fallback is DescribeType-backed; serve the type's create-only
// set without an AWS call. The comparison beside it runs for real.
vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../src/provisioning/create-only-properties.js')
  >('../../../src/provisioning/create-only-properties.js');
  return {
    ...actual,
    getCreateOnlyPropertyPaths: async () => [['VpcId'], ['CidrBlock'], ['AvailabilityZoneId']],
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
import { getPropertyCoverage } from '../../../src/provisioning/property-coverage.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#2790 — the DIFF half.
 *
 * A create-only silent drop an earlier deploy accepted
 * (`--allow-unsupported-properties`) stays in the state record, because the
 * record must keep a flag-ful redeploy quiet. Compared as-is, a flag-less
 * deploy then saw the same value on both sides, called it NO_CHANGE, and the
 * property never reached AWS while the deploy reported success. The record
 * side now keeps it only while THIS deploy accepts the drop, so the flag-less
 * diff reports the addition — a replacement, which the engine refuses unless
 * it is opted into.
 */
describe('DiffCalculator — an unwritten create-only drop (#2790)', () => {
  const TYPE = 'AWS::EC2::Subnet';
  const CREATE_ONLY = 'AvailabilityZoneId';
  const PLAIN = 'EnableDns64';
  const ALLOW = new Set([`${TYPE}:${CREATE_ONLY}`]);
  const WRITTEN = { VpcId: 'vpc-1', CidrBlock: '10.0.0.0/24' };
  const DECLARED = { ...WRITTEN, [CREATE_ONLY]: 'use1-az1' };

  it('PREMISE: AvailabilityZoneId is a create-only drop, EnableDns64 a plain one', () => {
    const cov = getPropertyCoverage(TYPE);
    if (!cov) throw new Error(`${TYPE} lost its property-coverage record`);
    expect(cov.createOnlyDrops.has(CREATE_ONLY)).toBe(true);
    expect(cov.silentDrop.has(PLAIN)).toBe(true);
    expect(cov.createOnlyDrops.has(PLAIN)).toBe(false);
  });

  function stateWith(
    properties: Record<string, unknown>,
    provisionedBy: 'sdk' | 'cc-api' = 'sdk'
  ): StackState {
    return {
      version: 7,
      region: 'us-east-1',
      stackName: 'subnet-stack',
      resources: {
        MySubnet: {
          physicalId: 'subnet-1',
          resourceType: TYPE,
          properties,
          attributes: {},
          provisionedBy,
        },
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
  }

  function templateWith(properties: Record<string, unknown>): CloudFormationTemplate {
    return { Resources: { MySubnet: { Type: TYPE, Properties: properties } } };
  }

  async function diff(
    state: StackState,
    template: CloudFormationTemplate,
    allowed?: ReadonlySet<string>
  ) {
    const changes = await new DiffCalculator().calculateDiff(
      state,
      template,
      undefined,
      undefined,
      allowed
    );
    return changes.get('MySubnet')!;
  }

  it('stays NO_CHANGE while the deploy still accepts the drop', async () => {
    const change = await diff(stateWith(DECLARED), templateWith(DECLARED), ALLOW);
    expect(change.changeType).toBe('NO_CHANGE');
  });

  it('reports a REPLACEMENT once the flag is gone — the property was never written', async () => {
    const change = await diff(stateWith(DECLARED), templateWith(DECLARED), new Set());
    expect(change.changeType).toBe('UPDATE');
    expect(change.propertyChanges).toEqual([
      expect.objectContaining({
        path: CREATE_ONLY,
        oldValue: undefined,
        newValue: 'use1-az1',
        requiresReplacement: true,
      }),
    ]);
  });

  it('reports the same with no allow set at all — `cdkd diff` previews the flag-less deploy', async () => {
    const change = await diff(stateWith(DECLARED), templateWith(DECLARED));
    expect(change.propertyChanges?.map((pc) => [pc.path, pc.requiresReplacement])).toEqual([
      [CREATE_ONLY, true],
    ]);
  });

  it('reports it when a SIBLING drop is un-allowed, since the resource then routes', async () => {
    const change = await diff(
      stateWith(DECLARED),
      templateWith({ ...DECLARED, [PLAIN]: true }),
      ALLOW
    );
    const replacing = change.propertyChanges?.filter((pc) => pc.requiresReplacement);
    expect(replacing?.map((pc) => pc.path)).toEqual([CREATE_ONLY]);
  });

  it('leaves a cc-api record alone: Cloud Control DID write the key', async () => {
    const change = await diff(stateWith(DECLARED, 'cc-api'), templateWith(DECLARED), new Set());
    expect(change.changeType).toBe('NO_CHANGE');
  });

  it('does not replace when the template REMOVES a key AWS never held', async () => {
    // Before #2790 the record kept it and the removal read as a create-only
    // change: a destroy-and-recreate to take away a value AWS does not hold.
    const change = await diff(stateWith(DECLARED), templateWith(WRITTEN), new Set());
    expect(change.changeType).toBe('NO_CHANGE');
  });
});
