import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { StaleAttributeHealOutcome } from '../../../src/deployment/stale-attribute-heal.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
  }),
}));

/**
 * Issue #3627: these arms ANSWERED without the record — `undefined` for
 * DynamoDB `StreamArn` / IAM `RoleId`, a path-less ARN for IAM — so a record
 * lacking the attribute (one `cdkd import` wrote before its read-back fixes)
 * never reached the #1852 heal. Each now heals first, and falls back to its
 * old answer when the heal finds nothing or no healer is wired.
 */
const CASES: ReadonlyArray<{
  type: string;
  physicalId: string;
  attribute: string;
  healed: unknown;
  fallback: unknown;
}> = [
  {
    type: 'AWS::DynamoDB::Table',
    physicalId: 'orders',
    attribute: 'StreamArn',
    healed: 'arn:aws:dynamodb:us-east-1:123456789012:table/orders/stream/2026',
    fallback: undefined,
  },
  {
    type: 'AWS::DynamoDB::GlobalTable',
    physicalId: 'orders',
    attribute: 'StreamArn',
    healed: 'arn:aws:dynamodb:us-east-1:123456789012:table/orders/stream/2026',
    fallback: undefined,
  },
  {
    type: 'AWS::IAM::Role',
    physicalId: 'app-role',
    attribute: 'RoleId',
    healed: 'AROAEXAMPLE',
    fallback: undefined,
  },
  {
    type: 'AWS::IAM::Role',
    physicalId: 'app-role',
    attribute: 'Arn',
    healed: 'arn:aws:iam::123456789012:role/service/app-role',
    fallback: 'arn:aws:iam::123456789012:role/app-role',
  },
  {
    type: 'AWS::IAM::User',
    physicalId: 'alice',
    attribute: 'Arn',
    healed: 'arn:aws:iam::123456789012:user/team/alice',
    fallback: 'arn:aws:iam::123456789012:user/alice',
  },
  {
    type: 'AWS::IAM::Group',
    physicalId: 'devs',
    attribute: 'Arn',
    healed: 'arn:aws:iam::123456789012:group/team/devs',
    fallback: 'arn:aws:iam::123456789012:group/devs',
  },
  {
    type: 'AWS::IAM::InstanceProfile',
    physicalId: 'profile',
    attribute: 'Arn',
    healed: 'arn:aws:iam::123456789012:instance-profile/app/profile',
    fallback: 'arn:aws:iam::123456789012:instance-profile/profile',
  },
];

const resolveWith = (
  c: (typeof CASES)[number],
  healer?: ResolverContext['attributeHealer']
): Promise<unknown> => {
  const context: ResolverContext = {
    template: { Resources: { X: { Type: c.type, Properties: {} } } },
    resources: {
      X: {
        physicalId: c.physicalId,
        resourceType: c.type,
        properties: {},
        attributes: {},
        dependencies: [],
      },
    },
    ...(healer && { attributeHealer: healer }),
  };
  return new IntrinsicFunctionResolver('us-east-1').resolve(
    { 'Fn::GetAtt': ['X', c.attribute] },
    context
  );
};

describe('IntrinsicFunctionResolver - heal before constructing (issue #3627)', () => {
  beforeEach(() => resetAccountInfoCache());

  it.each(CASES)('$type $attribute is served from the heal read', async (c) => {
    const healer = vi.fn(
      async (): Promise<StaleAttributeHealOutcome> => ({
        kind: 'read',
        attributes: { [c.attribute]: c.healed },
      })
    );
    await expect(resolveWith(c, healer)).resolves.toBe(c.healed);
    expect(healer).toHaveBeenCalledTimes(1);
  });

  it.each(CASES)('$type $attribute keeps its old answer when the heal reads nothing', async (c) => {
    const healer = vi.fn(
      async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'read', attributes: {} })
    );
    await expect(resolveWith(c, healer)).resolves.toBe(c.fallback);
  });

  it('does not heal a record that already carries the attribute (the flat lookup answers)', async () => {
    const healer = vi.fn();
    const arn = 'arn:aws:iam::123456789012:role/service/app-role';
    const context: ResolverContext = {
      template: { Resources: { X: { Type: 'AWS::IAM::Role', Properties: {} } } },
      resources: {
        X: {
          physicalId: 'app-role',
          resourceType: 'AWS::IAM::Role',
          properties: {},
          attributes: { Arn: arn },
          dependencies: [],
        },
      },
      attributeHealer: healer,
    };
    await expect(
      new IntrinsicFunctionResolver('us-east-1').resolve({ 'Fn::GetAtt': ['X', 'Arn'] }, context)
    ).resolves.toBe(arn);
    expect(healer).not.toHaveBeenCalled();
  });

  it.each(CASES)('$type $attribute keeps its old answer with no healer wired', async (c) => {
    await expect(resolveWith(c)).resolves.toBe(c.fallback);
  });
});
