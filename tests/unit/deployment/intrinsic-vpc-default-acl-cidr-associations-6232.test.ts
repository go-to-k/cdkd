import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: warnSpy, error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

const ec2Send = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ec2: { send: ec2Send },
  }),
}));

/**
 * go-to-k/cdkd#6232: `Fn::GetAtt [Vpc, DefaultNetworkAcl]` and
 * `[Vpc, CidrBlockAssociations]` had no resolver arm, so both fell back to the
 * VPC id with only a warning: an ACL slot got `vpc-...`, and `Fn::Select` on
 * the associations failed with "list must be an array, got string".
 */
const VPC_ID = 'vpc-0123456789abcdef0';
const makeContext = (attributes: Record<string, unknown>, physicalId = VPC_ID): ResolverContext => ({
  template: { Resources: { MyVpc: { Type: 'AWS::EC2::VPC', Properties: {} } } },
  resources: {
    MyVpc: {
      physicalId,
      resourceType: 'AWS::EC2::VPC',
      properties: {},
      attributes,
      dependencies: [],
    },
  },
});
const refusalOf = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    () => undefined,
    (e: unknown) => e
  );

describe('IntrinsicFunctionResolver - AWS::EC2::VPC DefaultNetworkAcl (#6232)', () => {
  let resolver: IntrinsicFunctionResolver;
  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver('us-east-1');
    resetAccountInfoCache();
    ec2Send.mockReset();
    warnSpy.mockReset();
  });

  it('serves a recorded DefaultNetworkAcl without any describe', async () => {
    ec2Send.mockRejectedValue(new Error('must not be called'));
    await expect(
      resolver.resolve(
        { 'Fn::GetAtt': ['MyVpc', 'DefaultNetworkAcl'] },
        makeContext({ VpcId: VPC_ID, DefaultNetworkAcl: 'acl-0aaa' })
      )
    ).resolves.toBe('acl-0aaa');
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('reads the default ACL live when the record omits it, filtered by vpc-id + default, never the VPC id', async () => {
    ec2Send.mockResolvedValue({ NetworkAcls: [{ NetworkAclId: 'acl-0default' }] });
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['MyVpc', 'DefaultNetworkAcl'] }, makeContext({ VpcId: VPC_ID }))
    ).resolves.toBe('acl-0default');
    expect(ec2Send).toHaveBeenCalledTimes(1);
    const cmd = ec2Send.mock.calls[0]![0] as { constructor: { name: string }; input: unknown };
    expect(cmd.constructor.name).toBe('DescribeNetworkAclsCommand');
    expect(cmd.input).toStrictEqual({
      Filters: [
        { Name: 'vpc-id', Values: [VPC_ID] },
        { Name: 'default', Values: ['true'] },
      ],
    });
    // The old fallback's warning is gone.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('refuses (unmarked: a retry can succeed) when the read fails', async () => {
    ec2Send.mockRejectedValue(Object.assign(new Error('Rate exceeded'), { name: 'Throttling' }));
    const refusal = await refusalOf(
      resolver.resolve({ 'Fn::GetAtt': ['MyVpc', 'DefaultNetworkAcl'] }, makeContext({}))
    );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((refusal as Error).message).toContain('DescribeNetworkAcls');
    expect(isMarkedNonRetryable(refusal as Error)).toBe(false);
  });

  it('refuses when the read finds no default ACL', async () => {
    ec2Send.mockResolvedValue({ NetworkAcls: [] });
    const refusal = await refusalOf(
      resolver.resolve({ 'Fn::GetAtt': ['MyVpc', 'DefaultNetworkAcl'] }, makeContext({}))
    );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((refusal as Error).message).toContain('found no default network ACL');
  });

  it('refuses (marked, no read) a physical id that is not a vpc-<hex>, since EC2 filters read * / ? as wildcards', async () => {
    ec2Send.mockRejectedValue(new Error('must not be called'));
    const refusal = await refusalOf(
      resolver.resolve(
        { 'Fn::GetAtt': ['MyVpc', 'DefaultNetworkAcl'] },
        makeContext({}, 'vpc-*')
      )
    );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((refusal as Error).message).toContain('is not a VPC id (vpc-<hex>)');
    expect(isMarkedNonRetryable(refusal as Error)).toBe(true);
    expect(ec2Send).not.toHaveBeenCalled();
  });
});

describe('IntrinsicFunctionResolver - AWS::EC2::VPC CidrBlockAssociations (#6232)', () => {
  let resolver: IntrinsicFunctionResolver;
  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver('us-east-1');
    resetAccountInfoCache();
    ec2Send.mockReset();
    warnSpy.mockReset();
  });

  it('answers the LIST of association ids read live, so Fn::Select over it works', async () => {
    ec2Send.mockResolvedValue({
      Vpcs: [
        {
          VpcId: VPC_ID,
          CidrBlockAssociationSet: [
            {
              AssociationId: 'vpc-cidr-assoc-0primary',
              CidrBlock: '10.0.0.0/16',
              CidrBlockState: { State: 'associated' },
            },
            {
              AssociationId: 'vpc-cidr-assoc-0second',
              CidrBlock: '10.1.0.0/16',
              CidrBlockState: { State: 'associated' },
            },
          ],
        },
      ],
    });
    await expect(
      resolver.resolve(
        { 'Fn::GetAtt': ['MyVpc', 'CidrBlockAssociations'] },
        makeContext({ VpcId: VPC_ID })
      )
    ).resolves.toStrictEqual(['vpc-cidr-assoc-0primary', 'vpc-cidr-assoc-0second']);
    await expect(
      resolver.resolve(
        { 'Fn::Select': [0, { 'Fn::GetAtt': ['MyVpc', 'CidrBlockAssociations'] }] },
        makeContext({ VpcId: VPC_ID })
      )
    ).resolves.toBe('vpc-cidr-assoc-0primary');
    const cmd = ec2Send.mock.calls[0]![0] as { constructor: { name: string }; input: unknown };
    expect(cmd.constructor.name).toBe('DescribeVpcsCommand');
    expect(cmd.input).toStrictEqual({ VpcIds: [VPC_ID] });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('refuses when the read fails, never handing the VPC id to a list consumer', async () => {
    ec2Send.mockRejectedValue(Object.assign(new Error('Rate exceeded'), { name: 'Throttling' }));
    const refusal = await refusalOf(
      resolver.resolve({ 'Fn::GetAtt': ['MyVpc', 'CidrBlockAssociations'] }, makeContext({}))
    );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((refusal as Error).message).toContain('DescribeVpcs');
  });

  it('refuses when the VPC reports no associated block', async () => {
    ec2Send.mockResolvedValue({ Vpcs: [{ VpcId: VPC_ID, CidrBlockAssociationSet: [] }] });
    const refusal = await refusalOf(
      resolver.resolve({ 'Fn::GetAtt': ['MyVpc', 'CidrBlockAssociations'] }, makeContext({}))
    );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((refusal as Error).message).toContain('no associated CIDR block');
  });

  it('says the VPC was not found when DescribeVpcs returns none', async () => {
    ec2Send.mockResolvedValue({ Vpcs: [] });
    const refusal = await refusalOf(
      resolver.resolve({ 'Fn::GetAtt': ['MyVpc', 'CidrBlockAssociations'] }, makeContext({}))
    );
    expect(refusal).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect((refusal as Error).message).toContain('found no VPC with this id');
  });

  it('leaves out a disassociated or failed association, keeping an associating one', async () => {
    ec2Send.mockResolvedValue({
      Vpcs: [
        {
          VpcId: VPC_ID,
          CidrBlockAssociationSet: [
            { AssociationId: 'vpc-cidr-assoc-0gone', CidrBlockState: { State: 'disassociated' } },
            { AssociationId: 'vpc-cidr-assoc-0primary', CidrBlockState: { State: 'associated' } },
            { AssociationId: 'vpc-cidr-assoc-0bad', CidrBlockState: { State: 'failed' } },
            { AssociationId: 'vpc-cidr-assoc-0new', CidrBlockState: { State: 'associating' } },
          ],
        },
      ],
    });
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['MyVpc', 'CidrBlockAssociations'] }, makeContext({}))
    ).resolves.toStrictEqual(['vpc-cidr-assoc-0primary', 'vpc-cidr-assoc-0new']);
  });

  it('reads live even when a (Cloud Control) record holds a stale list', async () => {
    ec2Send.mockResolvedValue({
      Vpcs: [
        {
          VpcId: VPC_ID,
          CidrBlockAssociationSet: [
            { AssociationId: 'vpc-cidr-assoc-0primary', CidrBlockState: { State: 'associated' } },
            { AssociationId: 'vpc-cidr-assoc-0later', CidrBlockState: { State: 'associated' } },
          ],
        },
      ],
    });
    await expect(
      resolver.resolve(
        { 'Fn::GetAtt': ['MyVpc', 'CidrBlockAssociations'] },
        makeContext({ CidrBlockAssociations: ['vpc-cidr-assoc-0primary'] })
      )
    ).resolves.toStrictEqual(['vpc-cidr-assoc-0primary', 'vpc-cidr-assoc-0later']);
    expect(ec2Send).toHaveBeenCalledTimes(1);
  });
});
