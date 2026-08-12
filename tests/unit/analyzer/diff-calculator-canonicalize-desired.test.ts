import { describe, it, expect, vi } from 'vite-plus/test';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { makeCanonicalizePropertiesFn } from '../../../src/provisioning/canonicalize-properties.js';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { registerAllProviders } from '../../../src/provisioning/register-providers.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: vi.fn(), config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

  // The REAL provider method through the REAL builder — NOT a local
  // re-implementation of the gate. A stand-in closure passes every row below
  // while `EC2Provider.canonicalizeDesiredProperties` is gutted to
  // `return properties`, which is exactly the false green a review found here.
  const provider = new EC2Provider();
  const canonicalize = makeCanonicalizePropertiesFn({
    hasProvider: (t: string) => t === RESOURCE_TYPE,
    getProvider: () => provider,
  });

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

  it('LEGACY state carrying the full bag is narrowed too — BOTH sides', async () => {
    // The population this issue names: a record written by a pre-#1590 binary
    // that still carries every destination key. Narrowing only the DESIRED
    // side flips the difference to a REMOVAL, which for a create-only property
    // is a REPLACEMENT whose create the engine issues with no context — the
    // provider's create-path refusal then fails a deploy that was green the
    // day before. Found by review; this row is the fence.
    const legacyState = {
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
            DestinationIpv6CidrBlock: '::/0',
            GatewayId: 'igw-1',
          },
          attributes: {},
        },
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;

    const changes = await new DiffCalculator().calculateDiff(
      legacyState,
      invalidTemplate,
      undefined,
      canonicalize
    );

    expect(changes.get('MyRoute')?.changeType).toBe('NO_CHANGE');
  });

  it('LEGACY state + a CORRECTED template still reports nothing to do', async () => {
    // The user fixed their template down to the single winning key. AWS already
    // holds exactly that route, so there is genuinely nothing to deploy; the
    // stale extra key in state is the (#1612) already-junk class, not a change.
    const legacyState = {
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
            DestinationIpv6CidrBlock: '::/0',
            GatewayId: 'igw-1',
          },
          attributes: {},
        },
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const corrected: CloudFormationTemplate = {
      Resources: {
        MyRoute: {
          Type: RESOURCE_TYPE,
          Properties: {
            RouteTableId: 'rtb-1',
            DestinationCidrBlock: '10.0.0.0/16',
            GatewayId: 'igw-1',
          },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(
      legacyState,
      corrected,
      undefined,
      canonicalize
    );

    expect(changes.get('MyRoute')?.changeType).toBe('NO_CHANGE');
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

  it('runs AFTER intrinsic resolution, not before', async () => {
    // The ordering the seam's JSDoc claims, pinned with the ONLY fixture that
    // can tell the two apart. An unresolved intrinsic is an OBJECT, and the
    // predicate is `Boolean`, so a truthy-resolving intrinsic picks the same
    // winner either way — the first version of this row asserted the ordering
    // and passed under both, which a review caught.
    //
    // Here the CIDR key resolves to a falsy `''`, so after resolution the IPv6
    // key is the only declared destination and nothing is narrowed — the diff
    // reports it as the new destination. Narrow-then-resolve would instead
    // count the unresolved CIDR OBJECT as declared, see two destinations, drop
    // IPv6 as the loser, and the diff would never mention it at all.
    const template: CloudFormationTemplate = {
      Resources: {
        MyRoute: {
          Type: RESOURCE_TYPE,
          Properties: {
            RouteTableId: 'rtb-1',
            DestinationCidrBlock: { __resolveTo: '' },
            DestinationIpv6CidrBlock: '::/0',
            GatewayId: 'igw-1',
          },
        },
      },
    };
    const resolveFn = (value: unknown) =>
      Promise.resolve(
        value && typeof value === 'object' && '__resolveTo' in (value as Record<string, unknown>)
          ? (value as Record<string, unknown>)['__resolveTo']
          : value
      );

    const changes = await new DiffCalculator().calculateDiff(
      narrowedState(),
      template,
      resolveFn,
      canonicalize
    );

    const paths = changes.get('MyRoute')?.propertyChanges?.map((pc) => pc.path) ?? [];
    // The IPv6 key SURVIVES into the diff — it is the only declared
    // destination once resolved. Under the wrong order it is narrowed away
    // before resolution and never reported.
    expect(paths).toContain('DestinationIpv6CidrBlock');
  });

  it('ANNOUNCES the narrowing — a losing-key edit is not discarded in silence', async () => {
    // The design rests on narrowing always being announced. On this path the
    // provider is never called, so without an explicit warn a user "fixing"
    // the wrong destination key would see cdkd report absolutely nothing.
    const warn = vi.fn();
    const calc = new DiffCalculator();
    (calc as unknown as { logger: { warn: unknown } }).logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    } as never;

    await calc.calculateDiff(narrowedState(), invalidTemplate, undefined, canonicalize);

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('MyRoute'));
  });

  it('does NOT warn when nothing was narrowed', async () => {
    const warn = vi.fn();
    const calc = new DiffCalculator();
    (calc as unknown as { logger: { warn: unknown } }).logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    } as never;
    const template: CloudFormationTemplate = {
      Resources: {
        MyRoute: {
          Type: RESOURCE_TYPE,
          Properties: {
            RouteTableId: 'rtb-1',
            DestinationCidrBlock: '10.0.0.0/16',
            GatewayId: 'igw-1',
          },
        },
      },
    };

    await calc.calculateDiff(narrowedState(), template, undefined, canonicalize);

    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves a cc-api-routed record un-narrowed on the CURRENT side', async () => {
    // CloudControlProvider sends AND records the full bag and reports no
    // effectiveProperties, so its record is not a narrowing artifact —
    // narrowing it here would hide a real difference rather than reveal one.
    const ccState = {
      version: 3,
      region: 'us-east-1',
      stackName: 'route-stack',
      resources: {
        MyRoute: {
          physicalId: 'rtb-1|10.0.0.0/16',
          resourceType: RESOURCE_TYPE,
          provisionedBy: 'cc-api',
          properties: {
            RouteTableId: 'rtb-1',
            DestinationCidrBlock: '10.0.0.0/16',
            DestinationIpv6CidrBlock: '::/0',
            GatewayId: 'igw-1',
          },
          attributes: {},
        },
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;

    const changes = await new DiffCalculator().calculateDiff(
      ccState,
      invalidTemplate,
      undefined,
      canonicalize
    );

    // Desired narrows, current does not -> the difference is REPORTED.
    expect(changes.get('MyRoute')?.changeType).toBe('UPDATE');
  });

  it('works through the REAL ProviderRegistry, not just a stub', async () => {
    // Every other row hands the builder a hand-written `{hasProvider,
    // getProvider}`. That hid a real break once already: adding `hasProvider`
    // to the production lookup silently no-opped the engine test until its
    // mock was updated by hand. This row goes through the actual registry, so
    // a lookup-contract change or a routing change for AWS::EC2::Route fails
    // here instead of passing green.
    const registry = new ProviderRegistry();
    registerAllProviders(registry);

    const changes = await new DiffCalculator().calculateDiff(
      narrowedState(),
      invalidTemplate,
      undefined,
      makeCanonicalizePropertiesFn(registry)
    );

    expect(changes.get('MyRoute')?.changeType).toBe('NO_CHANGE');
  });

  it('leaves an unrelated EC2 type untouched — the type guard, actually pinned', async () => {
    // NOTE: this fixture must use a type EC2Provider does NOT canonicalize.
    // It used `AWS::EC2::SecurityGroupIngress` until issue #1633 gave that
    // type its own arm, which made the new branch return BEFORE the Route
    // guard and silently stopped this row from pinning anything.
    // Through a lookup that hands EC2Provider to EVERY type, so deleting the
    // `resourceType !== 'AWS::EC2::Route'` guard changes the outcome. The
    // earlier version routed only Route to the provider, so the guard was
    // never reached and could be deleted with the suite green.
    const anyType = makeCanonicalizePropertiesFn({
      hasProvider: () => true,
      getProvider: () => provider,
    });
    const sgState = {
      version: 3,
      region: 'us-east-1',
      stackName: 'route-stack',
      resources: {
        MySg: {
          physicalId: 'sg-1',
          resourceType: 'AWS::EC2::NetworkAclEntry',
          properties: {
            DestinationCidrBlock: '10.0.0.0/16',
            DestinationIpv6CidrBlock: '::/0',
          },
          attributes: {},
        },
      },
      outputs: {},
      lastModified: 0,
    } as unknown as StackState;
    const sgTemplate: CloudFormationTemplate = {
      Resources: {
        MySg: {
          Type: 'AWS::EC2::NetworkAclEntry',
          Properties: {
            DestinationCidrBlock: '10.0.0.0/16',
            DestinationIpv6CidrBlock: '::/0',
          },
        },
      },
    };

    const changes = await new DiffCalculator().calculateDiff(
      sgState,
      sgTemplate,
      undefined,
      anyType
    );

    // Untouched on both sides -> equal -> NO_CHANGE. If the guard were gone,
    // both sides would still narrow equally, so the discriminating assertion
    // is on the PROPERTIES the change carries, checked below.
    expect(changes.get('MySg')?.changeType).toBe('NO_CHANGE');
    expect(anyType('AWS::EC2::NetworkAclEntry', sgTemplate.Resources['MySg']!.Properties!)).toEqual(
      sgTemplate.Resources['MySg']!.Properties
    );
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
