/**
 * go-to-k/cdkd#3937: ELBv2 `CreateLoadBalancer` / `CreateTargetGroup` answer
 * success with an existing resource of the requested name when its settings
 * match, so a replacement renamed onto it, or a plain create under it, is
 * probed first through the provider's `import()`. Pinned here under the
 * probe's exact input (the create bag's `Name`, no `knownPhysicalId`):
 *
 * - the lookup asks for the name the create SENDS — the provider rewrites a
 *   template name (stack-name prefix under `--prefix-user-supplied-names`,
 *   `_` to `-`), so a lookup of the template's spelling would miss the holder;
 * - only the service's own not-found error reads as free; any other failure,
 *   several matches, or an answer naming none throws, so the probe refuses;
 * - without a template `Name` nothing is looked up.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
    waitUntilLoadBalancerAvailable: vi.fn().mockResolvedValue({ state: 'SUCCESS' }),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import {
  createNameQuestion,
  replacementNameProbe,
} from '../../../src/deployment/replacement-name-holder.js';
import { withSkipPrefix, withStackName } from '../../../src/provisioning/resource-name.js';

const LB = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const LB_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/x/0123456789abcdef';
const TG_ARN = 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/x/0123456789abcdef';

const named = (error: string): Error =>
  Object.assign(new Error(`${error}: One or more resources not found`), { name: error });

/** The command's name and input, for each call `mockSend` saw. */
const sent = (): Array<{ command: string; input: Record<string, unknown> }> =>
  mockSend.mock.calls.map(([c]) => ({
    command: (c as { constructor: { name: string } }).constructor.name,
    input: (c as { input: Record<string, unknown> }).input,
  }));

const lookupInput = (resourceType: string, properties: Record<string, unknown>) => ({
  logicalId: 'Res',
  resourceType,
  stackName: 'MyStack',
  region: 'us-east-1',
  properties,
});

const cases = [
  {
    type: LB,
    describe: 'DescribeLoadBalancersCommand',
    create: 'CreateLoadBalancerCommand',
    notFound: 'LoadBalancerNotFoundException',
    answer: (items: unknown[]) => ({ LoadBalancers: items }),
    item: { LoadBalancerArn: LB_ARN, LoadBalancerName: 'theirs' },
    created: { LoadBalancers: [{ LoadBalancerArn: LB_ARN }] },
    arn: LB_ARN,
    arnKey: 'LoadBalancerArn',
    otherNotFound: 'TargetGroupNotFoundException',
  },
  {
    type: TG,
    describe: 'DescribeTargetGroupsCommand',
    create: 'CreateTargetGroupCommand',
    notFound: 'TargetGroupNotFoundException',
    answer: (items: unknown[]) => ({ TargetGroups: items }),
    item: { TargetGroupArn: TG_ARN, TargetGroupName: 'theirs' },
    created: { TargetGroups: [{ TargetGroupArn: TG_ARN }] },
    arn: TG_ARN,
    arnKey: 'TargetGroupArn',
    otherNotFound: 'LoadBalancerNotFoundException',
  },
] as const;

describe('the #3937 name probe against the real ELBv2 lookups', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new ELBv2Provider();
  });

  it('asks both types by the create bag, with no known physical id', () => {
    for (const { type } of cases) {
      expect(
        replacementNameProbe({
          resourceType: type,
          createdVia: 'sdk',
          change: {
            property: 'Name',
            desiredName: 'theirs',
            heldName: 'mine',
            heldProperty: 'Name',
            physicalId: LB_ARN,
          },
        }),
        type
      ).toEqual({});
      expect(createNameQuestion({ resourceType: type, createdVia: 'sdk', properties: { Name: 'n' } }), type).toEqual({
        property: 'Name',
        desiredName: 'n',
      });
    }
  });

  describe.each(cases)('$type', (c) => {
    it('answers the resource holding the name, by Describe on that name', async () => {
      mockSend.mockResolvedValueOnce(c.answer([c.item]));

      const found = await provider.import(lookupInput(c.type, { Name: 'theirs' }));

      expect(found?.physicalId).toBe(c.arn);
      expect(sent()).toEqual([{ command: c.describe, input: { Names: ['theirs'] } }]);
    });

    it("answers null on the service's own not-found error", async () => {
      mockSend.mockRejectedValueOnce(named(c.notFound));

      await expect(provider.import(lookupInput(c.type, { Name: 'theirs' }))).resolves.toBeNull();
    });

    it('throws on any other failure, even one whose message says "not found"', async () => {
      mockSend.mockRejectedValueOnce(named('AccessDenied'));
      await expect(provider.import(lookupInput(c.type, { Name: 'theirs' }))).rejects.toThrow(
        'One or more resources not found'
      );
      // The other type's not-found name is not this lookup's answer either.
      mockSend.mockRejectedValueOnce(named(c.otherNotFound));
      await expect(provider.import(lookupInput(c.type, { Name: 'theirs' }))).rejects.toThrow();
    });

    it('throws on an answer it cannot read: several matches, none, or one without an ARN', async () => {
      for (const items of [[c.item, c.item], [], [{}], [{ [c.arnKey]: '' }]]) {
        mockSend.mockResolvedValueOnce(c.answer(items));
        await expect(
          provider.import(lookupInput(c.type, { Name: 'theirs' })),
          JSON.stringify(items)
        ).rejects.toThrow('cdkd cannot tell which resource holds it');
      }
    });

    it('looks nothing up without a template Name', async () => {
      for (const properties of [{}, { Name: '' }, { Name: true }, { Name: Number.NaN }]) {
        await expect(provider.import(lookupInput(c.type, properties))).resolves.toBeNull();
      }
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('looks a numeric Name up under the decimal spelling the create sends', async () => {
      mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === c.describe) throw named(c.notFound);
        if (command.constructor.name === c.create) return c.created;
        return {};
      });

      await withSkipPrefix(true, () =>
        withStackName('MyStack', async () => {
          await provider.import(lookupInput(c.type, { Name: 7 }));
          await provider.create('Res', c.type, { Name: 7, TargetType: 'lambda' });
        })
      );

      expect(sent().find((x) => x.command === c.describe)?.input['Names']).toEqual(['7']);
      expect(sent().find((x) => x.command === c.create)?.input['Name']).toBe('7');
    });

    it('verifies a known physical id by ARN, as before', async () => {
      mockSend.mockResolvedValueOnce(c.answer([c.item]));

      const found = await provider.import({
        ...lookupInput(c.type, { Name: 'theirs' }),
        knownPhysicalId: c.arn,
      });

      expect(found?.physicalId).toBe(c.arn);
      expect(sent()[0]!.input).not.toHaveProperty('Names');
    });

    // The point of the shared derivation: whatever the create sends, the
    // lookup asks for — under either prefix flag, and after the provider's
    // `_` to `-` rewrite. A lookup of the template spelling would miss the
    // holder and the create would adopt it.
    it.each([
      { skip: false, declared: 'their_lb', wire: 'MyStack-their-lb' },
      { skip: true, declared: 'their_lb', wire: 'their-lb' },
      // Past the 32-character cap: truncated with a hash of the full name,
      // which both sides must compute alike.
      {
        skip: false,
        declared: 'a-load-balancer-name-well-past-the-cap',
        wire: 'MyStack-a-load-balancer-1352c42e',
      },
    ])('looks up the name the create sends (skip prefix: $skip)', async ({ skip, declared, wire }) => {
      mockSend.mockImplementation(async (command: { constructor: { name: string } }) => {
        if (command.constructor.name === c.describe) throw named(c.notFound);
        if (command.constructor.name === c.create) return c.created;
        return {};
      });

      await withSkipPrefix(skip, () =>
        withStackName('MyStack', async () => {
          await provider.import(lookupInput(c.type, { Name: declared }));
          await provider.create('Res', c.type, { Name: declared, TargetType: 'lambda' });
        })
      );

      const lookup = sent().find((s) => s.command === c.describe);
      const create = sent().find((s) => s.command === c.create);
      expect(lookup?.input['Names']).toEqual([wire]);
      expect(create?.input['Name']).toBe(wire);
    });
  });
});
