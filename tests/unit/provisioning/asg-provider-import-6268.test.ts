import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#6268: `ASGProvider.import()` answers a caller's id (or the
// template's `AutoScalingGroupName`) with the attributes `create()` records,
// so `cdkd import` gets an explicit-id path and the #1852 stale-attribute heal
// can fill `Arn` into a record lacking it, which `Fn::GetAtt
// AutoScalingGroupARN` then serves instead of refusing.

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-auto-scaling', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-auto-scaling')>(
    '@aws-sdk/client-auto-scaling'
  );
  return {
    ...actual,
    AutoScalingClient: vi.fn(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn(async () => ({ Account: '123456789012' })) },
  }),
}));

import { DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { createReadOnlyAttributeHealerFactory } from '../../../src/deployment/read-only-attribute-healer.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import type { ResourceImportInput } from '../../../src/types/resource.js';
import type { ResourceState } from '../../../src/types/state.js';

const TYPE = 'AWS::AutoScaling::AutoScalingGroup';
const ARN =
  'arn:aws:autoscaling:us-east-1:123456789012:autoScalingGroup:3b75d676-c4d6-454e-98bf-245fe81d1685:autoScalingGroupName/my-asg';

const input = (over: Partial<ResourceImportInput> = {}): ResourceImportInput => ({
  logicalId: 'Asg',
  resourceType: TYPE,
  stackName: 'MyStack',
  region: 'us-east-1',
  properties: {},
  ...over,
});

const liveGroup = (over: Record<string, unknown> = {}) => ({
  AutoScalingGroups: [
    {
      AutoScalingGroupName: 'my-asg',
      AutoScalingGroupARN: ARN,
      LaunchTemplate: { LaunchTemplateId: 'lt-0123456789abcdef0', Version: '$Latest' },
      ...over,
    },
  ],
});

const describedNames = (): unknown[] =>
  mockSend.mock.calls
    .map(([c]) => c as { input: { AutoScalingGroupNames?: unknown } })
    .filter((c) => c instanceof DescribeAutoScalingGroupsCommand)
    .map((c) => c.input.AutoScalingGroupNames);

describe('ASGProvider.import (#6268)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('answers the caller id with Arn, AutoScalingGroupARN and LaunchTemplateID', async () => {
    mockSend.mockResolvedValue(liveGroup());
    await expect(new ASGProvider().import(input({ knownPhysicalId: 'my-asg' }))).resolves.toEqual({
      physicalId: 'my-asg',
      attributes: {
        Arn: ARN,
        AutoScalingGroupARN: ARN,
        LaunchTemplateID: 'lt-0123456789abcdef0',
      },
    });
    expect(describedNames()).toEqual([['my-asg']]);
  });

  it('prefers the caller id over the template name', async () => {
    mockSend.mockResolvedValue(liveGroup());
    await new ASGProvider().import(
      input({ knownPhysicalId: 'my-asg', properties: { AutoScalingGroupName: 'other' } })
    );
    expect(describedNames()).toEqual([['my-asg']]);
  });

  it('falls back to the template AutoScalingGroupName', async () => {
    mockSend.mockResolvedValue(liveGroup());
    const found = await new ASGProvider().import(
      input({ properties: { AutoScalingGroupName: 'my-asg' } })
    );
    expect(found?.physicalId).toBe('my-asg');
    expect(describedNames()).toEqual([['my-asg']]);
  });

  it('omits LaunchTemplateID for a group launched without a top-level LaunchTemplate', async () => {
    mockSend.mockResolvedValue(liveGroup({ LaunchTemplate: undefined }));
    const found = await new ASGProvider().import(input({ knownPhysicalId: 'my-asg' }));
    expect(found?.attributes).toEqual({ Arn: ARN, AutoScalingGroupARN: ARN });
  });

  it('returns null without calling AWS when there is no id and no name', async () => {
    await expect(new ASGProvider().import(input())).resolves.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns null for another resource type without calling AWS', async () => {
    await expect(
      new ASGProvider().import(input({ resourceType: 'AWS::EC2::Instance', knownPhysicalId: 'x' }))
    ).resolves.toBeNull();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('returns null when the group is gone (empty describe list)', async () => {
    mockSend.mockResolvedValue({ AutoScalingGroups: [] });
    await expect(
      new ASGProvider().import(input({ knownPhysicalId: 'my-asg' }))
    ).resolves.toBeNull();
  });

  it('returns null when AWS answers for a group of another name', async () => {
    mockSend.mockResolvedValue(liveGroup({ AutoScalingGroupName: 'someone-else' }));
    await expect(
      new ASGProvider().import(input({ knownPhysicalId: 'my-asg' }))
    ).resolves.toBeNull();
  });

  it('propagates a describe error rather than calling the group gone', async () => {
    const err = Object.assign(new Error('AutoScalingGroup name not found'), {
      name: 'ValidationError',
    });
    mockSend.mockRejectedValue(err);
    await expect(new ASGProvider().import(input({ knownPhysicalId: 'my-asg' }))).rejects.toBe(err);
  });
});

describe('Fn::GetAtt AutoScalingGroupARN heals a record lacking Arn through import() (#6268)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    resetAccountInfoCache();
  });

  const record = (): ResourceState => ({
    physicalId: 'my-asg',
    resourceType: TYPE,
    properties: { MinSize: '1', MaxSize: '1' },
    attributes: {},
    dependencies: [],
  });

  // The real healer over the real provider: only the DescribeAutoScalingGroups
  // answer differs between the cases.
  const resolveArn = (): Promise<unknown> => {
    const provider = new ASGProvider();
    const healer = createReadOnlyAttributeHealerFactory({
      getProvider: () => provider,
      inRegion: (_region, fn) => fn(),
    })('MyStack', 'us-east-1');
    const context = {
      template: { Resources: { Asg: { Type: TYPE, Properties: {} } } },
      resources: { Asg: record() },
      attributeHealer: healer,
    } as unknown as ResolverContext;
    return new IntrinsicFunctionResolver('us-east-1').resolve(
      { 'Fn::GetAtt': ['Asg', 'AutoScalingGroupARN'] },
      context
    );
  };

  const refusalOf = async (run: Promise<unknown>): Promise<Error> => {
    const outcome = await run.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    if (!('error' in outcome)) {
      throw new Error(`expected a refusal, got ${JSON.stringify(outcome.value)}`);
    }
    return outcome.error as Error;
  };

  it('serves the ARN the provider re-read', async () => {
    mockSend.mockResolvedValue(liveGroup());
    await expect(resolveArn()).resolves.toBe(ARN);
    expect(describedNames()).toEqual([['my-asg']]);
  });

  it('still refuses, never serving the group name, when the re-read finds no group', async () => {
    mockSend.mockResolvedValue({ AutoScalingGroups: [] });
    const error = await refusalOf(resolveArn());
    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(error.message).toContain('Cannot resolve Fn::GetAtt [Asg, AutoScalingGroupARN]');
    expect(error.message).toContain('its ARN carries a group id cdkd cannot build');
    // Worded from the heal's `not-found` outcome, not a generic remedy.
    expect(error.message).toContain('AWS reports no resource behind the recorded physical id');
    expect(error.message).not.toContain('my-asg');
    expect(describedNames()).toEqual([['my-asg']]);
  });

  it('still refuses when the re-read group reports no AutoScalingGroupARN', async () => {
    mockSend.mockResolvedValue(liveGroup({ AutoScalingGroupARN: undefined }));
    const error = await refusalOf(resolveArn());
    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(error.message).toContain('Cannot resolve Fn::GetAtt [Asg, AutoScalingGroupARN]');
    // Worded from the heal's `read` outcome: the read ran and lacked the value.
    expect(error.message).toContain('the read reports no usable value for this attribute either');
    expect(error.message).not.toContain('my-asg');
    expect(describedNames()).toEqual([['my-asg']]);
  });
});
