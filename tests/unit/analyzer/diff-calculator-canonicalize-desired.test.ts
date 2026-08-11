import { describe, it, expect, vi } from 'vite-plus/test';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { narrowRouteDestinations } from '../../../src/provisioning/providers/ec2-provider.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

/**
 * Issue #1591, second half. Recording the NARROWED bag (`effectiveProperties`)
 * fixes drift, but on its own it BREAKS the next deploy: state then holds one
 * destination key while the still-invalid template holds two, so the diff reads
 * the extra key as a user-made ADD. Every `AWS::EC2::Route` destination key is
 * create-only in the registry schema, so that classifies as a REPLACEMENT — and
 * the engine's replacement create passes no context, so `createRoute` hits the
 * #1566 refusal and a previously-green no-op deploy starts FAILING. On the
 * degraded path (no `DescribeType`) it is worse: an in-place update, i.e. a
 * delete-and-recreate of a live route on every deploy.
 *
 * So the desired side is narrowed the same way, by the same helper. This is the
 * rule `drift-normalize.ts` already states for ordering — normalize BOTH sides
 * or the normalization manufactures the difference it was meant to remove.
 */
describe('DiffCalculator canonicalizeDesired (#1591)', () => {
  const RESOURCE_TYPE = 'AWS::EC2::Route';

  // What state carries AFTER the provider narrowed and the engine recorded it.
  const narrowedState = (): StackState =>
    ({
      version: 3,
      region: 'us-east-1',
      stackName: 'route-stack',
      resources: {
        MyRoute: {
          physicalId: 'rtb-1|10.0.0.0/16',
          resourceType: RESOURCE_TYPE,
          properties: {
            RouteTableId: 'rtb-1',
            DestinationCidrBlock: '10.0.0.0/16',
            GatewayId: 'igw-1',
          },
          attributes: {},
        },
      },
      outputs: {},
      lastModified: 0,
    }) as unknown as StackState;

  // The user's template, still carrying the CFn-invalid second destination key.
  const invalidTemplate: CloudFormationTemplate = {
    Resources: {
      MyRoute: {
        Type: RESOURCE_TYPE,
        Properties: {
          RouteTableId: 'rtb-1',
          DestinationCidrBlock: '10.0.0.0/16',
          DestinationIpv6CidrBlock: '::/0',
          GatewayId: 'igw-1',
        },
      },
    },
  };

  // The REAL provider helper, not a stand-in: if the two sides ever narrow
  // differently the bug returns, so the test must exercise the shared rule.
  const canonicalize = (resourceType: string, properties: Record<string, unknown>) => {
    if (resourceType !== RESOURCE_TYPE) return properties;
    const { declared, narrowed } = narrowRouteDestinations(properties);
    return declared.length > 1 ? narrowed : properties;
  };

  it('WITHOUT the canonicalizer the narrowing reads back as a change (the bug)', async () => {
    // Pinned deliberately: this is the regression the second half exists to
    // prevent, and asserting it here is what makes the next row meaningful
    // rather than vacuously green.
    const changes = await new DiffCalculator().calculateDiff(narrowedState(), invalidTemplate);

    expect(changes.get('MyRoute')?.changeType).toBe('UPDATE');
    expect(
      changes.get('MyRoute')?.propertyChanges?.map((pc) => pc.path)
    ).toContain('DestinationIpv6CidrBlock');
  });

  it('WITH the canonicalizer the deploy is a no-op again', async () => {
    const changes = await new DiffCalculator().calculateDiff(
      narrowedState(),
      invalidTemplate,
      undefined,
      canonicalize
    );

    // `calculateDiff` records a NO_CHANGE entry rather than omitting the
    // resource, so the assertion is on the classification — omitting it would
    // pass for a resource the diff never looked at.
    expect(changes.get('MyRoute')?.changeType).toBe('NO_CHANGE');
    expect(changes.get('MyRoute')?.propertyChanges ?? []).toEqual([]);
  });

  it('a REAL destination change is still reported', async () => {
    // The narrowing must not swallow an actual edit. Here the user changed the
    // winning key itself — one destination declared, nothing to narrow.
    const template: CloudFormationTemplate = {
      Resources: {
        MyRoute: {
          Type: RESOURCE_TYPE,
          Properties: {
            RouteTableId: 'rtb-1',
            DestinationCidrBlock: '192.168.0.0/16',
            GatewayId: 'igw-1',
          },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(
      narrowedState(),
      template,
      undefined,
      canonicalize
    );

    expect(changes.get('MyRoute')?.changeType).toBe('UPDATE');
    expect(
      changes.get('MyRoute')?.propertyChanges?.map((pc) => pc.path)
    ).toContain('DestinationCidrBlock');
  });

  it('a change to a NON-destination property is still reported', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyRoute: {
          Type: RESOURCE_TYPE,
          Properties: {
            RouteTableId: 'rtb-1',
            DestinationCidrBlock: '10.0.0.0/16',
            DestinationIpv6CidrBlock: '::/0',
            GatewayId: 'igw-CHANGED',
          },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(
      narrowedState(),
      template,
      undefined,
      canonicalize
    );

    expect(
      changes.get('MyRoute')?.propertyChanges?.map((pc) => pc.path)
    ).toContain('GatewayId');
  });

  it('leaves an unrelated resource type untouched', async () => {
    const state = {
      ...narrowedState(),
      resources: {
        MyBucket: {
          physicalId: 'b',
          resourceType: 'AWS::S3::Bucket',
          properties: { BucketName: 'b' },
          attributes: {},
        },
      },
    } as unknown as StackState;
    const template: CloudFormationTemplate = {
      Resources: {
        MyBucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'b2' } },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(
      state,
      template,
      undefined,
      canonicalize
    );

    expect(changes.get('MyBucket')?.changeType).toBe('UPDATE');
  });
});
