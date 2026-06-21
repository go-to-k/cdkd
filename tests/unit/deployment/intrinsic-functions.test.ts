import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

// Mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

// Mock EC2 DescribeAvailabilityZones response (default for backward compat
// — tests that need a different response can call `mockEc2Send.mockImplementation(...)`
// in their own setup).
const mockEc2Send = vi.fn().mockResolvedValue({
  AvailabilityZones: [
    { ZoneName: 'us-east-1a', State: 'available' },
    { ZoneName: 'us-east-1b', State: 'available' },
    { ZoneName: 'us-east-1c', State: 'available' },
  ],
});

// Mock AWS clients (for STS in pseudo parameter resolution and EC2 for GetAZs)
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
      }),
    },
    ec2: {
      send: mockEc2Send,
    },
  }),
}));

describe('IntrinsicFunctionResolver - Fn::FindInMap', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
  });

  it('should resolve Fn::FindInMap with valid mapping', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Mappings: {
        RegionMap: {
          'us-east-1': {
            AMI: 'ami-12345678',
            InstanceType: 't2.micro',
          },
          'us-west-2': {
            AMI: 'ami-87654321',
            InstanceType: 't2.small',
          },
        },
      },
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    const result = await resolver.resolve(
      { 'Fn::FindInMap': ['RegionMap', 'us-east-1', 'AMI'] },
      context
    );

    expect(result).toBe('ami-12345678');
  });

  it('should throw error when mapping name is not found', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Mappings: {
        RegionMap: {
          'us-east-1': { AMI: 'ami-12345678' },
        },
      },
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    await expect(
      resolver.resolve({ 'Fn::FindInMap': ['NonExistentMap', 'us-east-1', 'AMI'] }, context)
    ).rejects.toThrow("Fn::FindInMap: mapping 'NonExistentMap' not found in Mappings section");
  });

  it('should throw error when top-level key is not found', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Mappings: {
        RegionMap: {
          'us-east-1': { AMI: 'ami-12345678' },
        },
      },
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    await expect(
      resolver.resolve({ 'Fn::FindInMap': ['RegionMap', 'eu-west-1', 'AMI'] }, context)
    ).rejects.toThrow(
      "Fn::FindInMap: top-level key 'eu-west-1' not found in mapping 'RegionMap'"
    );
  });

  it('should throw error when second-level key is not found', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Mappings: {
        RegionMap: {
          'us-east-1': { AMI: 'ami-12345678' },
        },
      },
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    await expect(
      resolver.resolve({ 'Fn::FindInMap': ['RegionMap', 'us-east-1', 'VPC'] }, context)
    ).rejects.toThrow(
      "Fn::FindInMap: second-level key 'VPC' not found in mapping 'RegionMap' -> 'us-east-1'"
    );
  });

  it('should throw error when no Mappings section exists', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    await expect(
      resolver.resolve({ 'Fn::FindInMap': ['RegionMap', 'us-east-1', 'AMI'] }, context)
    ).rejects.toThrow('Fn::FindInMap: no Mappings section found in template');
  });

  it('should resolve Fn::FindInMap with nested Ref in arguments', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Mappings: {
        RegionMap: {
          'us-east-1': {
            AMI: 'ami-12345678',
          },
        },
      },
    };

    const context: ResolverContext = {
      template,
      resources: {},
      parameters: {
        MyRegion: 'us-east-1',
        MyKey: 'AMI',
      },
    };

    const result = await resolver.resolve(
      {
        'Fn::FindInMap': [
          'RegionMap',
          { Ref: 'MyRegion' },
          { Ref: 'MyKey' },
        ],
      },
      context
    );

    expect(result).toBe('ami-12345678');
  });

  it('should resolve Fn::FindInMap returning non-string values', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Mappings: {
        Config: {
          prod: {
            InstanceCount: 3,
            EnableLogging: true,
          },
        },
      },
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    const result = await resolver.resolve(
      { 'Fn::FindInMap': ['Config', 'prod', 'InstanceCount'] },
      context
    );

    expect(result).toBe(3);
  });

  it('should resolve the mapped value when the 4-arg form has a present key (DefaultValue ignored)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Mappings: {
        RegionMap: {
          'us-east-1': { AMI: 'ami-12345678' },
        },
      },
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    const result = await resolver.resolve(
      {
        'Fn::FindInMap': ['RegionMap', 'us-east-1', 'AMI', { DefaultValue: 'ami-default' }],
      },
      context
    );

    expect(result).toBe('ami-12345678');
  });

  it('should return DefaultValue when the top-level key is absent (4-arg form)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Mappings: {
        RegionMap: {
          'us-east-1': { AMI: 'ami-12345678' },
        },
      },
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    const result = await resolver.resolve(
      {
        'Fn::FindInMap': ['RegionMap', 'eu-west-1', 'AMI', { DefaultValue: 'ami-default' }],
      },
      context
    );

    expect(result).toBe('ami-default');
  });

  it('should return DefaultValue when the second-level key is absent (4-arg form)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Mappings: {
        RegionMap: {
          'us-east-1': { AMI: 'ami-12345678' },
        },
      },
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    const result = await resolver.resolve(
      {
        'Fn::FindInMap': ['RegionMap', 'us-east-1', 'VPC', { DefaultValue: 'vpc-default' }],
      },
      context
    );

    expect(result).toBe('vpc-default');
  });

  it('should resolve a DefaultValue that is itself an intrinsic', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Mappings: {
        RegionMap: {
          'us-east-1': { AMI: 'ami-12345678' },
        },
      },
    };

    const context: ResolverContext = {
      template,
      resources: {},
      parameters: {
        FallbackAmi: 'ami-from-param',
      },
    };

    // Top-level key absent -> the DefaultValue intrinsic ({Ref: FallbackAmi}) resolves.
    const refDefault = await resolver.resolve(
      {
        'Fn::FindInMap': [
          'RegionMap',
          'eu-west-1',
          'AMI',
          { DefaultValue: { Ref: 'FallbackAmi' } },
        ],
      },
      context
    );
    expect(refDefault).toBe('ami-from-param');

    // A nested Fn::Join DefaultValue also resolves.
    const joinDefault = await resolver.resolve(
      {
        'Fn::FindInMap': [
          'RegionMap',
          'eu-west-1',
          'AMI',
          { DefaultValue: { 'Fn::Join': ['-', ['ami', 'joined']] } },
        ],
      },
      context
    );
    expect(joinDefault).toBe('ami-joined');
  });

  it('should still throw when the key is absent and no DefaultValue is provided (3-arg form)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Mappings: {
        RegionMap: {
          'us-east-1': { AMI: 'ami-12345678' },
        },
      },
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    await expect(
      resolver.resolve({ 'Fn::FindInMap': ['RegionMap', 'eu-west-1', 'AMI'] }, context)
    ).rejects.toThrow(
      "Fn::FindInMap: top-level key 'eu-west-1' not found in mapping 'RegionMap'"
    );
  });
});

describe('IntrinsicFunctionResolver - Fn::Base64', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
  });

  it('should encode a simple string to Base64', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    const result = await resolver.resolve({ 'Fn::Base64': 'Hello, World!' }, context);

    expect(result).toBe(Buffer.from('Hello, World!').toString('base64'));
  });

  it('should resolve Fn::Base64 with nested intrinsic function', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    const result = await resolver.resolve(
      {
        'Fn::Base64': {
          'Fn::Join': ['-', ['hello', 'world']],
        },
      },
      context
    );

    expect(result).toBe(Buffer.from('hello-world').toString('base64'));
  });

  it('should resolve Fn::Base64 with Ref', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
    };

    const context: ResolverContext = {
      template,
      resources: {},
      parameters: {
        UserData: '#!/bin/bash\necho hello',
      },
    };

    const result = await resolver.resolve(
      { 'Fn::Base64': { Ref: 'UserData' } },
      context
    );

    expect(result).toBe(Buffer.from('#!/bin/bash\necho hello').toString('base64'));
  });

  it('should resolve Fn::Base64 with Fn::Sub', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
    };

    const context: ResolverContext = {
      template,
      resources: {},
      parameters: {
        AppName: 'myapp',
      },
    };

    const result = await resolver.resolve(
      {
        'Fn::Base64': {
          'Fn::Sub': '#!/bin/bash\necho ${AppName}',
        },
      },
      context
    );

    expect(result).toBe(Buffer.from('#!/bin/bash\necho myapp').toString('base64'));
  });

  it('should throw error when value does not resolve to a string', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    await expect(
      resolver.resolve({ 'Fn::Base64': ['not', 'a', 'string'] }, context)
    ).rejects.toThrow('Fn::Base64: value must resolve to a string');
  });
});

describe('IntrinsicFunctionResolver - Fn::GetAZs', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
    mockEc2Send.mockClear();
    mockEc2Send.mockResolvedValue({
      AvailabilityZones: [
        { ZoneName: 'us-east-1a', State: 'available' },
        { ZoneName: 'us-east-1b', State: 'available' },
        { ZoneName: 'us-east-1c', State: 'available' },
      ],
    });
  });

  it('should resolve Fn::GetAZs with empty string (current region)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    const result = await resolver.resolve({ 'Fn::GetAZs': '' }, context);

    expect(result).toEqual(['us-east-1a', 'us-east-1b', 'us-east-1c']);
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it('should resolve Fn::GetAZs with explicit region', async () => {
    mockEc2Send.mockResolvedValue({
      AvailabilityZones: [
        { ZoneName: 'eu-west-1a', State: 'available' },
        { ZoneName: 'eu-west-1b', State: 'available' },
      ],
    });

    const template: CloudFormationTemplate = {
      Resources: {},
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    const result = await resolver.resolve({ 'Fn::GetAZs': 'eu-west-1' }, context);

    expect(result).toEqual(['eu-west-1a', 'eu-west-1b']);
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it('should resolve Fn::GetAZs with Ref to AWS::Region', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    const result = await resolver.resolve(
      { 'Fn::GetAZs': { Ref: 'AWS::Region' } },
      context
    );

    expect(result).toEqual(['us-east-1a', 'us-east-1b', 'us-east-1c']);
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it('should cache results per region and not make repeated API calls', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    // First call
    await resolver.resolve({ 'Fn::GetAZs': '' }, context);
    // Second call (should use cache)
    await resolver.resolve({ 'Fn::GetAZs': '' }, context);

    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it('should return sorted AZ names', async () => {
    mockEc2Send.mockResolvedValue({
      AvailabilityZones: [
        { ZoneName: 'us-east-1c', State: 'available' },
        { ZoneName: 'us-east-1a', State: 'available' },
        { ZoneName: 'us-east-1b', State: 'available' },
      ],
    });

    const template: CloudFormationTemplate = {
      Resources: {},
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    const result = await resolver.resolve({ 'Fn::GetAZs': '' }, context);

    expect(result).toEqual(['us-east-1a', 'us-east-1b', 'us-east-1c']);
  });

  it('should throw error when EC2 API call fails', async () => {
    mockEc2Send.mockRejectedValue(new Error('Access Denied'));

    const template: CloudFormationTemplate = {
      Resources: {},
    };

    const context: ResolverContext = {
      template,
      resources: {},
    };

    await expect(
      resolver.resolve({ 'Fn::GetAZs': 'ap-northeast-1' }, context)
    ).rejects.toThrow(
      "Fn::GetAZs: failed to describe availability zones for region 'ap-northeast-1': Access Denied"
    );
  });
});

describe('IntrinsicFunctionResolver - Fn::GetStackOutput', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver('us-east-1');
    resetAccountInfoCache();
  });

  function makeStateBackend(
    states: Record<string, Record<string, { outputs: Record<string, unknown> }>>
  ) {
    return {
      getState: vi.fn(async (stackName: string, region: string) => {
        const byRegion = states[stackName];
        if (!byRegion) return null;
        const entry = byRegion[region];
        if (!entry) return null;
        return {
          state: {
            version: 2 as const,
            stackName,
            region,
            resources: {},
            outputs: entry.outputs,
            lastModified: 0,
          },
          etag: '"abc"',
        };
      }),
    } as unknown as ResolverContext['stateBackend'];
  }

  it('resolves a same-account same-region output', async () => {
    const stateBackend = makeStateBackend({
      Producer: {
        'us-east-1': { outputs: { ApiUrl: 'https://example.com' } },
      },
    });

    const context: ResolverContext = {
      template: { Resources: {} },
      resources: {},
      stateBackend,
      stackName: 'Consumer',
    };

    const result = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: 'Producer',
          OutputName: 'ApiUrl',
        },
      },
      context
    );

    expect(result).toBe('https://example.com');
  });

  it('resolves a same-account cross-region output', async () => {
    const stateBackend = makeStateBackend({
      Producer: {
        'us-west-2': { outputs: { Endpoint: 'arn:aws:foo' } },
      },
    });

    const context: ResolverContext = {
      template: { Resources: {} },
      resources: {},
      stateBackend,
      stackName: 'Consumer',
    };

    const result = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: 'Producer',
          Region: 'us-west-2',
          OutputName: 'Endpoint',
        },
      },
      context
    );

    expect(result).toBe('arn:aws:foo');
    expect(stateBackend!.getState).toHaveBeenCalledWith('Producer', 'us-west-2');
  });

  it('defaults Region to the consumer deploy region when omitted', async () => {
    const stateBackend = makeStateBackend({
      Producer: {
        'us-east-1': { outputs: { Value: 42 } },
      },
    });

    const context: ResolverContext = {
      template: { Resources: {} },
      resources: {},
      stateBackend,
      stackName: 'Consumer',
    };

    const result = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: 'Producer',
          OutputName: 'Value',
        },
      },
      context
    );

    expect(result).toBe(42);
    expect(stateBackend!.getState).toHaveBeenCalledWith('Producer', 'us-east-1');
  });

  it('resolves nested intrinsics in StackName / OutputName / Region', async () => {
    const stateBackend = makeStateBackend({
      Producer: {
        'us-west-2': { outputs: { Final: 'ok' } },
      },
    });

    const context: ResolverContext = {
      template: {
        Resources: {},
        Parameters: {},
      },
      resources: {},
      parameters: {
        ProducerStack: 'Producer',
        ProducerRegion: 'us-west-2',
        OutputKey: 'Final',
      },
      stateBackend,
      stackName: 'Consumer',
    };

    const result = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: { Ref: 'ProducerStack' },
          Region: { Ref: 'ProducerRegion' },
          OutputName: { Ref: 'OutputKey' },
        },
      },
      context
    );

    expect(result).toBe('ok');
  });

  it('throws when StackName is missing', async () => {
    const context: ResolverContext = {
      template: { Resources: {} },
      resources: {},
      stateBackend: makeStateBackend({}),
      stackName: 'Consumer',
    };

    await expect(
      resolver.resolve(
        { 'Fn::GetStackOutput': { OutputName: 'Foo' } },
        context
      )
    ).rejects.toThrow('Fn::GetStackOutput: StackName is required');
  });

  it('throws when OutputName is missing', async () => {
    const context: ResolverContext = {
      template: { Resources: {} },
      resources: {},
      stateBackend: makeStateBackend({}),
      stackName: 'Consumer',
    };

    await expect(
      resolver.resolve(
        { 'Fn::GetStackOutput': { StackName: 'Producer' } },
        context
      )
    ).rejects.toThrow('Fn::GetStackOutput: OutputName is required');
  });

  it('throws when state backend is not provided', async () => {
    const context: ResolverContext = {
      template: { Resources: {} },
      resources: {},
      stackName: 'Consumer',
    };

    await expect(
      resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'Producer',
            OutputName: 'Foo',
          },
        },
        context
      )
    ).rejects.toThrow(
      'Fn::GetStackOutput: state backend is required for cross-stack references'
    );
  });

  it('throws when producer stack is not in state', async () => {
    const stateBackend = makeStateBackend({});

    const context: ResolverContext = {
      template: { Resources: {} },
      resources: {},
      stateBackend,
      stackName: 'Consumer',
    };

    await expect(
      resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'Producer',
            Region: 'us-east-1',
            OutputName: 'Foo',
          },
        },
        context
      )
    ).rejects.toThrow(
      "Fn::GetStackOutput: stack 'Producer' not found in region 'us-east-1'"
    );
  });

  it('throws when output is missing from the producer stack', async () => {
    const stateBackend = makeStateBackend({
      Producer: {
        'us-east-1': { outputs: { Other: 'x' } },
      },
    });

    const context: ResolverContext = {
      template: { Resources: {} },
      resources: {},
      stateBackend,
      stackName: 'Consumer',
    };

    await expect(
      resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'Producer',
            OutputName: 'Missing',
          },
        },
        context
      )
    ).rejects.toThrow(
      "Fn::GetStackOutput: output 'Missing' not found in stack 'Producer' (us-east-1). Available outputs: Other"
    );
  });

  it('rejects RoleArn given as a Ref intrinsic (literal string required)', async () => {
    // Cross-account RoleArn must be a literal string in the template;
    // intrinsic chains (Ref / Fn::GetAtt / Fn::Sub) are intentionally
    // rejected at template-validation time because the resolver context
    // isn't guaranteed to have producer-account info available at
    // intrinsic-resolution time. Closes issue #449.
    // Full happy-path cross-account coverage lives in
    // tests/unit/deployment/intrinsic-getstackoutput-cross-account.test.ts.
    const context: ResolverContext = {
      template: { Resources: {} },
      resources: {},
      stateBackend: makeStateBackend({}),
      stackName: 'Consumer',
    };

    await expect(
      resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'Producer',
            Region: 'us-west-2',
            OutputName: 'Foo',
            RoleArn: { Ref: 'CrossAccountRoleArnParam' },
          },
        },
        context
      )
    ).rejects.toThrow(/RoleArn must be a literal string in the template/);
  });

  it('rejects self-reference (same stack name AND same region)', async () => {
    const stateBackend = makeStateBackend({
      Consumer: {
        'us-east-1': { outputs: { Foo: 'x' } },
      },
    });

    const context: ResolverContext = {
      template: { Resources: {} },
      resources: {},
      stateBackend,
      stackName: 'Consumer',
    };

    await expect(
      resolver.resolve(
        {
          'Fn::GetStackOutput': {
            StackName: 'Consumer',
            OutputName: 'Foo',
          },
        },
        context
      )
    ).rejects.toThrow(
      "Fn::GetStackOutput: cannot reference own stack 'Consumer' in the same region 'us-east-1'"
    );
  });

  it('allows same-stackName cross-region reference', async () => {
    // Two regions of the same stackName have independent state — referencing
    // the other region's record is legitimate, not a self-reference.
    const stateBackend = makeStateBackend({
      Shared: {
        'us-west-2': { outputs: { Foo: 'from-west' } },
      },
    });

    const context: ResolverContext = {
      template: { Resources: {} },
      resources: {},
      stateBackend,
      stackName: 'Shared',
    };

    const result = await resolver.resolve(
      {
        'Fn::GetStackOutput': {
          StackName: 'Shared',
          Region: 'us-west-2',
          OutputName: 'Foo',
        },
      },
      context
    );

    expect(result).toBe('from-west');
  });

  it('throws on non-object argument shape', async () => {
    const context: ResolverContext = {
      template: { Resources: {} },
      resources: {},
      stateBackend: makeStateBackend({}),
      stackName: 'Consumer',
    };

    await expect(
      resolver.resolve({ 'Fn::GetStackOutput': 'not-an-object' }, context)
    ).rejects.toThrow(
      'Fn::GetStackOutput: argument must be an object with StackName/OutputName/Region/RoleArn'
    );
  });
});

describe('IntrinsicFunctionResolver - Fn::GetAtt LaunchTemplate.LatestVersionNumber', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
    mockEc2Send.mockReset();
  });

  it('resolves to the actual version number from DescribeLaunchTemplates', async () => {
    // AWS::EC2::LaunchTemplate falls through to CC API in cdkd; the
    // intrinsic resolver must call DescribeLaunchTemplates to recover
    // LatestVersionNumber. Without this path, the resolver fell back
    // to the physicalId — `Create*AutoScalingGroup` then rejected
    // with "Invalid launch template version: either '$Default',
    // '$Latest', or a numeric version are allowed." (PR fix
    // discovered via the remove-protection integ).
    mockEc2Send.mockResolvedValue({
      LaunchTemplates: [
        {
          LaunchTemplateId: 'lt-0322d9ae11506ebfe',
          LatestVersionNumber: 1,
          DefaultVersionNumber: 1,
        },
      ],
    });

    const template: CloudFormationTemplate = {
      Resources: {
        MyLt: { Type: 'AWS::EC2::LaunchTemplate', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        MyLt: {
          physicalId: 'lt-0322d9ae11506ebfe',
          resourceType: 'AWS::EC2::LaunchTemplate',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['MyLt', 'LatestVersionNumber'] },
      context
    );
    expect(result).toBe('1');
  });

  it('falls back to "$Latest" when DescribeLaunchTemplates fails', async () => {
    // Defense-in-depth — `$Latest` is AWS-accepted as a special string
    // for "use the latest version at API call time", and is far
    // safer than the previous resource-id fallback which AWS rejects.
    mockEc2Send.mockRejectedValue(new Error('AccessDenied'));

    const template: CloudFormationTemplate = {
      Resources: {
        MyLt: { Type: 'AWS::EC2::LaunchTemplate', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        MyLt: {
          physicalId: 'lt-0322d9ae11506ebfe',
          resourceType: 'AWS::EC2::LaunchTemplate',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['MyLt', 'LatestVersionNumber'] },
      context
    );
    expect(result).toBe('$Latest');
  });

  it('resolves DefaultVersionNumber separately', async () => {
    mockEc2Send.mockResolvedValue({
      LaunchTemplates: [
        {
          LaunchTemplateId: 'lt-0322d9ae11506ebfe',
          LatestVersionNumber: 3,
          DefaultVersionNumber: 2,
        },
      ],
    });

    const template: CloudFormationTemplate = {
      Resources: {
        MyLt: { Type: 'AWS::EC2::LaunchTemplate', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        MyLt: {
          physicalId: 'lt-0322d9ae11506ebfe',
          resourceType: 'AWS::EC2::LaunchTemplate',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['MyLt', 'DefaultVersionNumber'] },
      context
    );
    expect(result).toBe('2');
  });
});

describe('IntrinsicFunctionResolver - AWS::ECR::Repository Fn::GetAtt', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
    mockEc2Send.mockReset();
  });

  it('resolves Arn to the correct ECR ARN', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        MyRepo: {
          physicalId: 'my-repo',
          resourceType: 'AWS::ECR::Repository',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['MyRepo', 'Arn'] },
      context
    );
    expect(result).toBe('arn:aws:ecr:us-east-1:123456789012:repository/my-repo');
  });

  it('resolves RepositoryUri to the correct ECR URI', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        MyRepo: {
          physicalId: 'my-repo',
          resourceType: 'AWS::ECR::Repository',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['MyRepo', 'RepositoryUri'] },
      context
    );
    expect(result).toBe('123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo');
  });

  it('falls back to physicalId for unknown ECR attributes', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyRepo: { Type: 'AWS::ECR::Repository', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        MyRepo: {
          physicalId: 'my-repo',
          resourceType: 'AWS::ECR::Repository',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['MyRepo', 'NotAField'] },
      context
    );
    expect(result).toBe('my-repo');
  });
});

describe('IntrinsicFunctionResolver - AWS::DynamoDB::GlobalTable Fn::GetAtt', () => {
  // CDK's TableV2 construct synthesizes as AWS::DynamoDB::GlobalTable (not
  // AWS::DynamoDB::Table). Pre-fix, the resolver's per-type branch only
  // matched AWS::DynamoDB::Table, so { Fn::GetAtt: [<TableV2>, 'Arn'] }
  // fell through to the bare physicalId and any IAM policy Resource: that
  // ARN failed with "must be in ARN format".
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
  });

  it('resolves Arn to the correct DynamoDB table ARN', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyTable: { Type: 'AWS::DynamoDB::GlobalTable', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        MyTable: {
          physicalId: 'MyStack-HistoryTable12345',
          resourceType: 'AWS::DynamoDB::GlobalTable',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['MyTable', 'Arn'] },
      context
    );
    expect(result).toBe(
      'arn:aws:dynamodb:us-east-1:123456789012:table/MyStack-HistoryTable12345'
    );
  });

  it('falls back to physicalId for unknown GlobalTable attributes', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyTable: { Type: 'AWS::DynamoDB::GlobalTable', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        MyTable: {
          physicalId: 'MyStack-HistoryTable12345',
          resourceType: 'AWS::DynamoDB::GlobalTable',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['MyTable', 'NotAField'] },
      context
    );
    expect(result).toBe('MyStack-HistoryTable12345');
  });
});

describe('IntrinsicFunctionResolver - per-type Arn handler sweep', () => {
  // Mechanical sweep covering CFn types where physicalId is a name/id
  // (not the full ARN) and downstream consumers (typically IAM Policy
  // Resource:) need a constructed ARN. Each row asserts the Arn shape
  // AWS uses. Same class of bug as #329 / #365 — when a row goes
  // missing, the resolver default-fallbacks to physicalId and the
  // consumer fails with "must be in ARN format".
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
  });

  const makeContext = (
    resourceType: string,
    physicalId: string,
    extraProps: Record<string, unknown> = {}
  ): ResolverContext => ({
    template: { Resources: { Target: { Type: resourceType, Properties: extraProps } } },
    resources: {
      Target: {
        physicalId,
        resourceType,
        properties: extraProps,
        attributes: {},
        dependencies: [],
      },
    },
  });

  const cases: Array<{
    type: string;
    physicalId: string;
    attribute: string;
    expected: string;
    extraProps?: Record<string, unknown>;
  }> = [
    {
      type: 'AWS::IAM::User',
      physicalId: 'my-user',
      attribute: 'Arn',
      expected: 'arn:aws:iam::123456789012:user/my-user',
    },
    {
      type: 'AWS::IAM::Group',
      physicalId: 'my-group',
      attribute: 'Arn',
      expected: 'arn:aws:iam::123456789012:group/my-group',
    },
    {
      type: 'AWS::IAM::InstanceProfile',
      physicalId: 'my-profile',
      attribute: 'Arn',
      expected: 'arn:aws:iam::123456789012:instance-profile/my-profile',
    },
    {
      type: 'AWS::KMS::Key',
      physicalId: '12345678-1234-1234-1234-123456789012',
      attribute: 'Arn',
      expected:
        'arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789012',
    },
    {
      type: 'AWS::Cognito::UserPool',
      physicalId: 'us-east-1_abc123',
      attribute: 'Arn',
      expected: 'arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_abc123',
    },
    {
      type: 'AWS::Kinesis::Stream',
      physicalId: 'my-stream',
      attribute: 'Arn',
      expected: 'arn:aws:kinesis:us-east-1:123456789012:stream/my-stream',
    },
    {
      type: 'AWS::Events::Rule',
      physicalId: 'my-rule',
      attribute: 'Arn',
      expected: 'arn:aws:events:us-east-1:123456789012:rule/my-rule',
    },
    {
      type: 'AWS::Events::Rule',
      physicalId: 'my-rule',
      attribute: 'Arn',
      expected: 'arn:aws:events:us-east-1:123456789012:rule/custom-bus/my-rule',
      extraProps: { EventBusName: 'custom-bus' },
    },
    {
      type: 'AWS::Events::EventBus',
      physicalId: 'my-bus',
      attribute: 'Arn',
      expected: 'arn:aws:events:us-east-1:123456789012:event-bus/my-bus',
    },
    {
      type: 'AWS::EFS::FileSystem',
      physicalId: 'fs-abc123',
      attribute: 'Arn',
      expected: 'arn:aws:elasticfilesystem:us-east-1:123456789012:file-system/fs-abc123',
    },
    {
      type: 'AWS::KinesisFirehose::DeliveryStream',
      physicalId: 'my-stream',
      attribute: 'Arn',
      expected: 'arn:aws:firehose:us-east-1:123456789012:deliverystream/my-stream',
    },
    {
      type: 'AWS::CodeBuild::Project',
      physicalId: 'my-project',
      attribute: 'Arn',
      expected: 'arn:aws:codebuild:us-east-1:123456789012:project/my-project',
    },
    {
      type: 'AWS::CloudTrail::Trail',
      physicalId: 'my-trail',
      attribute: 'Arn',
      expected: 'arn:aws:cloudtrail:us-east-1:123456789012:trail/my-trail',
    },
    {
      type: 'AWS::AppSync::GraphQLApi',
      physicalId: 'abcdefg12345',
      attribute: 'Arn',
      expected: 'arn:aws:appsync:us-east-1:123456789012:apis/abcdefg12345',
    },
    {
      type: 'AWS::ServiceDiscovery::PrivateDnsNamespace',
      physicalId: 'ns-abc123',
      attribute: 'Arn',
      expected: 'arn:aws:servicediscovery:us-east-1:123456789012:namespace/ns-abc123',
    },
    {
      type: 'AWS::ServiceDiscovery::Service',
      physicalId: 'srv-abc123',
      attribute: 'Arn',
      expected: 'arn:aws:servicediscovery:us-east-1:123456789012:service/srv-abc123',
    },
    {
      type: 'AWS::CloudWatch::Alarm',
      physicalId: 'my-alarm',
      attribute: 'Arn',
      expected: 'arn:aws:cloudwatch:us-east-1:123456789012:alarm:my-alarm',
    },
    {
      type: 'AWS::RDS::DBInstance',
      physicalId: 'my-db',
      attribute: 'DBInstanceArn',
      expected: 'arn:aws:rds:us-east-1:123456789012:db:my-db',
    },
    {
      type: 'AWS::RDS::DBCluster',
      physicalId: 'my-cluster',
      attribute: 'DBClusterArn',
      expected: 'arn:aws:rds:us-east-1:123456789012:cluster:my-cluster',
    },
    {
      type: 'AWS::DocDB::DBInstance',
      physicalId: 'my-docdb-inst',
      attribute: 'Arn',
      expected: 'arn:aws:rds:us-east-1:123456789012:db:my-docdb-inst',
    },
    {
      type: 'AWS::DocDB::DBCluster',
      physicalId: 'my-docdb-cluster',
      attribute: 'Arn',
      expected: 'arn:aws:rds:us-east-1:123456789012:cluster:my-docdb-cluster',
    },
    {
      type: 'AWS::Neptune::DBInstance',
      physicalId: 'my-neptune-inst',
      attribute: 'Arn',
      expected: 'arn:aws:rds:us-east-1:123456789012:db:my-neptune-inst',
    },
    {
      type: 'AWS::Neptune::DBCluster',
      physicalId: 'my-neptune-cluster',
      attribute: 'Arn',
      expected: 'arn:aws:rds:us-east-1:123456789012:cluster:my-neptune-cluster',
    },
    {
      type: 'AWS::S3Express::DirectoryBucket',
      physicalId: 'my-bucket--use1-az5--x-s3',
      attribute: 'Arn',
      expected: 'arn:aws:s3express:us-east-1:123456789012:bucket/my-bucket--use1-az5--x-s3',
    },
  ];

  for (const c of cases) {
    const label = c.extraProps?.['EventBusName']
      ? `${c.type} ${c.attribute} (with EventBusName=${String(c.extraProps['EventBusName'])})`
      : `${c.type} ${c.attribute}`;
    it(`resolves ${label} to the correct ARN`, async () => {
      const ctx = makeContext(c.type, c.physicalId, c.extraProps);
      const result = await resolver.resolve(
        { 'Fn::GetAtt': ['Target', c.attribute] },
        ctx
      );
      expect(result).toBe(c.expected);
    });
  }

  it('falls back to physicalId for unknown attributes on the new handlers', async () => {
    const ctx = makeContext('AWS::KMS::Key', 'abc-123');
    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Target', 'NotAField'] },
      ctx
    );
    expect(result).toBe('abc-123');
  });

  it('Events::Rule with EventBusName as an ARN extracts the bus name segment', async () => {
    const ctx = makeContext('AWS::Events::Rule', 'my-rule', {
      EventBusName: 'arn:aws:events:us-east-1:123456789012:event-bus/custom-bus',
    });
    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Target', 'Arn'] },
      ctx
    );
    expect(result).toBe('arn:aws:events:us-east-1:123456789012:rule/custom-bus/my-rule');
  });

  it('Events::Rule with EventBusName="default" uses the default-bus ARN format', async () => {
    const ctx = makeContext('AWS::Events::Rule', 'my-rule', {
      EventBusName: 'default',
    });
    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Target', 'Arn'] },
      ctx
    );
    expect(result).toBe('arn:aws:events:us-east-1:123456789012:rule/my-rule');
  });
});

describe('IntrinsicFunctionResolver - Fn::Sub same-stack implicit Ref', () => {
  // Per the CloudFormation spec, when ${X} appears in a 1-arg Fn::Sub body
  // and X is not in the explicit variable map (the 2-arg form's second
  // element), then if X is a resource logical id in the same stack it
  // resolves as Ref X. See #275 — cdkd's resolver already routes through
  // resolveRef, so once the DAG fix makes the same-stack resource deploy
  // first, ${MyRepo} substitutes correctly.
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
  });

  const makeContext = (
    extra: Partial<ResolverContext> = {}
  ): ResolverContext => ({
    template: { Resources: {} },
    resources: {
      MyRepo: {
        physicalId: 'cdkmyrepo123-abcdef',
        resourceType: 'AWS::ECR::Repository',
        properties: {},
        attributes: { Arn: 'arn:aws:ecr:us-east-1:123456789012:repository/cdkmyrepo123-abcdef' },
        dependencies: [],
      },
    },
    ...extra,
  });

  it('resolves bare ${X} to the same-stack resource physical id', async () => {
    const result = await resolver.resolve({ 'Fn::Sub': '${MyRepo}' }, makeContext());
    expect(result).toBe('cdkmyrepo123-abcdef');
  });

  it('substitutes ${X} embedded in a surrounding template string', async () => {
    const result = await resolver.resolve(
      { 'Fn::Sub': 'prefix/${MyRepo}:tag' },
      makeContext()
    );
    expect(result).toBe('prefix/cdkmyrepo123-abcdef:tag');
  });

  it('resolves a real ECR image URI shape combining pseudo parameters + same-stack ref', async () => {
    // The exact body shape from #275's integ fixture.
    const result = await resolver.resolve(
      {
        'Fn::Sub':
          '${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/${MyRepo}:latest',
      },
      makeContext()
    );
    expect(result).toBe(
      '123456789012.dkr.ecr.us-east-1.amazonaws.com/cdkmyrepo123-abcdef:latest'
    );
  });

  it('resolves ${X.Attr} dotted form as implicit Fn::GetAtt', async () => {
    const result = await resolver.resolve({ 'Fn::Sub': '${MyRepo.Arn}' }, makeContext());
    expect(result).toBe('arn:aws:ecr:us-east-1:123456789012:repository/cdkmyrepo123-abcdef');
  });

  it('two-arg form variable map takes precedence over same-stack lookup', async () => {
    // When X appears in the 2-arg variable map, that wins regardless of
    // whether a same-stack resource named X exists.
    const result = await resolver.resolve(
      { 'Fn::Sub': ['${MyRepo}', { MyRepo: 'literal-from-map' }] },
      makeContext()
    );
    expect(result).toBe('literal-from-map');
  });

  it('keeps the placeholder literal when ${X} is not a resource / parameter / pseudo', async () => {
    const result = await resolver.resolve(
      { 'Fn::Sub': 'value=${NotARealResource}' },
      makeContext()
    );
    // Existing behavior: warn + keep ${NotARealResource} as-is.
    expect(result).toBe('value=${NotARealResource}');
  });
});

describe('IntrinsicFunctionResolver - Fn::Sub ${!Literal} escape', () => {
  // Per the CloudFormation spec, a `${` immediately followed by `!` is an
  // escape: `${!X}` renders as the LITERAL text `${X}` with NO variable
  // substitution. cdkd must strip the `!` and emit `${X}` verbatim without
  // attempting to resolve X as a variable / Ref / GetAtt (which previously
  // left the `${!X}` placeholder + a spurious "variable !X not found" warn).
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
  });

  const makeContext = (): ResolverContext => ({
    template: { Resources: {} },
    resources: {
      MyRepo: {
        physicalId: 'cdkmyrepo123-abcdef',
        resourceType: 'AWS::ECR::Repository',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    },
  });

  it('emits ${X} literally for a bare ${!X} escape (no substitution)', async () => {
    const result = await resolver.resolve({ 'Fn::Sub': '${!NotAVar}' }, makeContext());
    expect(result).toBe('${NotAVar}');
  });

  it('emits the literal inside a surrounding string (the integ-fixture shape)', async () => {
    const result = await resolver.resolve(
      { 'Fn::Sub': 'before-${!NotAVar}-after' },
      makeContext()
    );
    expect(result).toBe('before-${NotAVar}-after');
  });

  it('handles a mixed string: resolves ${Real} and escapes ${!Lit}', async () => {
    const result = await resolver.resolve(
      { 'Fn::Sub': 'pre-${MyRepo}-${!Lit}-post' },
      makeContext()
    );
    expect(result).toBe('pre-cdkmyrepo123-abcdef-${Lit}-post');
  });

  it('escapes a token even when a same-named variable exists in the 2-arg map', async () => {
    // ${!MyRepo} is a literal escape and must NOT pick up the variable map value.
    const result = await resolver.resolve(
      { 'Fn::Sub': ['${MyRepo}-${!MyRepo}', { MyRepo: 'from-map' }] },
      makeContext()
    );
    expect(result).toBe('from-map-${MyRepo}');
  });
});

describe('IntrinsicFunctionResolver - AWS::NotificationARNs pseudo parameter', () => {
  // cdkd has no stack-notification-ARN concept, so AWS::NotificationARNs is
  // always an empty list — which CloudFormation resolves to an empty string
  // in an Fn::Sub / Ref string context. Before the fix it resolved to
  // `undefined`, which left the literal `${AWS::NotificationARNs}` placeholder
  // in an Fn::Sub body (the pseudo branch was skipped on `undefined`).
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
  });

  const context: ResolverContext = {
    template: { Resources: {} },
    resources: {},
  };

  it('substitutes ${AWS::NotificationARNs} to an empty string in Fn::Sub', async () => {
    const result = await resolver.resolve(
      { 'Fn::Sub': '${AWS::NotificationARNs}' },
      context
    );
    expect(result).toBe('');
  });

  it('substitutes ${AWS::NotificationARNs} embedded in a surrounding Fn::Sub string', async () => {
    const result = await resolver.resolve(
      { 'Fn::Sub': 'notif=${AWS::NotificationARNs};done' },
      context
    );
    expect(result).toBe('notif=;done');
  });

  it('resolves a bare Ref: AWS::NotificationARNs to an empty string', async () => {
    const result = await resolver.resolve({ Ref: 'AWS::NotificationARNs' }, context);
    expect(result).toBe('');
  });
});

describe('IntrinsicFunctionResolver - nested attribute path fallback (Issue #381)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
  });

  it('flat dot-key wins over nested-path walk (SDK provider shape)', async () => {
    const template: CloudFormationTemplate = {
      Resources: { Cluster: { Type: 'AWS::RDS::DBCluster', Properties: {} } },
    };
    const context: ResolverContext = {
      template,
      resources: {
        Cluster: {
          physicalId: 'my-cluster',
          resourceType: 'AWS::RDS::DBCluster',
          properties: {},
          // SDK-provider shape: flat dot-key.
          attributes: { 'Endpoint.Port': '3306' },
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['Cluster', 'Endpoint.Port'] },
      context
    );
    expect(result).toBe('3306');
  });

  it('falls back to nested-path walk when flat dot-key is missing (CC API shape)', async () => {
    const template: CloudFormationTemplate = {
      Resources: { Cluster: { Type: 'AWS::RDS::DBCluster', Properties: {} } },
    };
    const context: ResolverContext = {
      template,
      resources: {
        Cluster: {
          physicalId: 'my-cluster',
          resourceType: 'AWS::RDS::DBCluster',
          properties: {},
          // CC API shape: nested object.
          attributes: { Endpoint: { Port: 3306, Address: 'my-cluster.cluster-abc.us-east-1.rds.amazonaws.com' } },
          dependencies: [],
        },
      },
    };

    const port = await resolver.resolve({ 'Fn::GetAtt': ['Cluster', 'Endpoint.Port'] }, context);
    expect(port).toBe(3306);

    const addr = await resolver.resolve({ 'Fn::GetAtt': ['Cluster', 'Endpoint.Address'] }, context);
    expect(addr).toBe('my-cluster.cluster-abc.us-east-1.rds.amazonaws.com');
  });

  it('falls back to constructAttribute (physicalId default) when neither flat nor nested matches', async () => {
    const template: CloudFormationTemplate = {
      Resources: { Cluster: { Type: 'AWS::RDS::DBCluster', Properties: {} } },
    };
    const context: ResolverContext = {
      template,
      resources: {
        Cluster: {
          physicalId: 'my-cluster',
          resourceType: 'AWS::RDS::DBCluster',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    // Endpoint not in attributes, RDS DBCluster constructAttribute falls
    // through to physicalId for non-Arn attributes — this is the
    // pre-#381 behavior preserved as last-resort fallback.
    const port = await resolver.resolve({ 'Fn::GetAtt': ['Cluster', 'Endpoint.Port'] }, context);
    expect(port).toBe('my-cluster');
  });

  it('walks 3+ nested levels (defense-in-depth for deeper CFn shapes)', async () => {
    const template: CloudFormationTemplate = {
      Resources: { R: { Type: 'AWS::Custom::Foo', Properties: {} } },
    };
    const context: ResolverContext = {
      template,
      resources: {
        R: {
          physicalId: 'r',
          resourceType: 'AWS::Custom::Foo',
          properties: {},
          attributes: { A: { B: { C: 'deep-value' } } },
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve({ 'Fn::GetAtt': ['R', 'A.B.C'] }, context);
    expect(result).toBe('deep-value');
  });

  it('handles intermediate non-object cleanly (no TypeError on string-traversal)', async () => {
    const template: CloudFormationTemplate = {
      Resources: { R: { Type: 'AWS::Custom::Foo', Properties: {} } },
    };
    const context: ResolverContext = {
      template,
      resources: {
        R: {
          physicalId: 'r',
          resourceType: 'AWS::Custom::Foo',
          properties: {},
          attributes: { Endpoint: 'flat-string-not-object' },
          dependencies: [],
        },
      },
    };

    // 'Endpoint' is a flat string, can't walk into '.Port' — fall through.
    const result = await resolver.resolve({ 'Fn::GetAtt': ['R', 'Endpoint.Port'] }, context);
    // Custom resource type → constructAttribute falls through to physicalId.
    expect(result).toBe('r');
  });

  describe('AWS::ECS::Service Name attribute (constructAttribute fallback)', () => {
    const mkContext = (physicalId: string, attributes: Record<string, unknown> = {}): ResolverContext => {
      const template: CloudFormationTemplate = {
        Resources: { Svc: { Type: 'AWS::ECS::Service', Properties: {} } },
      };
      return {
        template,
        resources: {
          Svc: {
            physicalId,
            resourceType: 'AWS::ECS::Service',
            properties: {},
            attributes,
            dependencies: [],
          },
        },
      };
    };

    it('returns the last `/` segment of a plain service ARN as Name', async () => {
      const arn = 'arn:aws:ecs:us-east-1:111111111111:service/my-cluster/MyStack-MyService';
      const result = await resolver.resolve({ 'Fn::GetAtt': ['Svc', 'Name'] }, mkContext(arn));
      expect(result).toBe('MyStack-MyService');
    });

    it('handles the <serviceArn>|<clusterName> composite shape — strips suffix, returns last ARN segment', async () => {
      const composite =
        'arn:aws:ecs:us-east-1:111111111111:service/my-cluster/MyStack-MyService|my-cluster';
      const result = await resolver.resolve({ 'Fn::GetAtt': ['Svc', 'Name'] }, mkContext(composite));
      expect(result).toBe('MyStack-MyService');
    });

    it('handles the import-format <clusterArn>|<serviceName> composite shape — returns RHS', async () => {
      const composite =
        'arn:aws:ecs:us-east-1:111111111111:cluster/my-cluster|MyStack-MyService';
      const result = await resolver.resolve({ 'Fn::GetAtt': ['Svc', 'Name'] }, mkContext(composite));
      expect(result).toBe('MyStack-MyService');
    });

    it('prefers the flat-key attributes.Name when set (does not fall through to constructAttribute)', async () => {
      // The provider stores `attributes.Name` at create time; the flat-key
      // lookup hits before constructAttribute, so this is the happy path.
      const arn = 'arn:aws:ecs:us-east-1:111111111111:service/my-cluster/MyStack-MyService';
      const result = await resolver.resolve(
        { 'Fn::GetAtt': ['Svc', 'Name'] },
        mkContext(arn, { Name: 'cached-from-create' })
      );
      expect(result).toBe('cached-from-create');
    });

    it('falls back to physicalId for unknown attributes on AWS::ECS::Service', async () => {
      const arn = 'arn:aws:ecs:us-east-1:111111111111:service/my-cluster/MyStack-MyService';
      const result = await resolver.resolve(
        { 'Fn::GetAtt': ['Svc', 'NotAnAttribute'] },
        mkContext(arn)
      );
      expect(result).toBe(arn);
    });
  });
});

describe('IntrinsicFunctionResolver - unknown intrinsic detection', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
  });

  const context = (): ResolverContext => ({
    template: { Resources: {} },
    resources: {},
  });

  // (a) an unknown Fn:: throws with the issue link
  it('throws on an unknown Fn:: intrinsic with a pre-filled GitHub issue link', async () => {
    await expect(
      resolver.resolve({ 'Fn::ToJsonString': { foo: 'bar' } }, context())
    ).rejects.toThrow(
      'Unsupported CloudFormation intrinsic function "Fn::ToJsonString": cdkd does not support resolving it yet.'
    );

    await expect(
      resolver.resolve({ 'Fn::ToJsonString': { foo: 'bar' } }, context())
    ).rejects.toThrow(
      'https://github.com/go-to-k/cdkd/issues/new?title=Support%20intrinsic%20Fn%3A%3AToJsonString&labels=intrinsic-support'
    );
  });

  it.each([['Fn::Length'], ['Fn::ForEach'], ['Fn::Contains']])(
    'throws on CFn language-extension intrinsic %s',
    async (key) => {
      await expect(resolver.resolve({ [key]: [] }, context())).rejects.toThrow(
        `Unsupported CloudFormation intrinsic function "${key}"`
      );
    }
  );

  it('embeds the url-encoded intrinsic key in the issue title for an arbitrary unknown key', async () => {
    await expect(
      resolver.resolve({ 'Fn::SomethingNew': 1 }, context())
    ).rejects.toThrow(
      'title=Support%20intrinsic%20Fn%3A%3ASomethingNew&labels=intrinsic-support'
    );
  });

  // (b) a lone unknown single-key intrinsic throws (Ref-prefixed safety net is
  // covered by the false-positive guard below; here we cover a bare Fn:: key
  // that sits alone as the only key on the node).
  it('throws on a lone unknown single-key Fn:: intrinsic node', async () => {
    await expect(resolver.resolve({ 'Fn::Mystery': 'x' }, context())).rejects.toThrow(
      'Unsupported CloudFormation intrinsic function "Fn::Mystery"'
    );
  });

  it('throws when an unknown intrinsic is nested deep inside an object', async () => {
    await expect(
      resolver.resolve(
        { Properties: { Config: { Value: { 'Fn::Length': ['a', 'b'] } } } },
        context()
      )
    ).rejects.toThrow('Unsupported CloudFormation intrinsic function "Fn::Length"');
  });

  it('throws when an unknown intrinsic is nested inside an array', async () => {
    await expect(
      resolver.resolve([{ 'Fn::ToJsonString': {} }], context())
    ).rejects.toThrow('Unsupported CloudFormation intrinsic function "Fn::ToJsonString"');
  });

  // (c) false-positive guard: a multi-key object carrying an UNKNOWN
  // "Fn::Something" property alongside siblings must NOT trip the new
  // unknown-intrinsic detection — only a lone single-key node is flagged.
  // (A multi-key object whose key is `Ref` or a HANDLED `Fn::X` is governed by
  // the pre-existing `'X' in obj` branches at the top of resolveValue, which
  // intentionally match regardless of sibling keys — that path is unchanged.)
  it('does NOT throw on a multi-key object with an unknown "Fn::X" property alongside siblings', async () => {
    const input = { 'Fn::ToJsonString': 'data', Sibling: 'kept' };
    const result = await resolver.resolve(input, context());
    expect(result).toEqual({ 'Fn::ToJsonString': 'data', Sibling: 'kept' });
  });

  it('does NOT throw on a single-key object whose key is neither Ref nor Fn:: prefixed', async () => {
    const input = { Reference: 'not-an-intrinsic' };
    const result = await resolver.resolve(input, context());
    expect(result).toEqual({ Reference: 'not-an-intrinsic' });
  });

  it('does NOT throw on a single-key object whose key contains but does not start with "Fn::"', async () => {
    const input = { 'My::Fn::Thing': 'value' };
    const result = await resolver.resolve(input, context());
    expect(result).toEqual({ 'My::Fn::Thing': 'value' });
  });

  // (d) all existing handled intrinsics still resolve (smoke test that the
  // new detection did not break the recognized set).
  it('still resolves every handled intrinsic without throwing', async () => {
    const template: CloudFormationTemplate = {
      Resources: {},
      Mappings: { M: { K: { V: 'mapped' } } },
      Conditions: {},
      Parameters: {},
    };
    const ctx: ResolverContext = {
      template,
      resources: {
        Res: {
          physicalId: 'phys-id',
          resourceType: 'AWS::Custom::Foo',
          properties: {},
          attributes: { Attr: 'attr-val' },
          dependencies: [],
        },
      },
      parameters: { P: 'pval' },
      conditions: { C: true },
    };

    expect(await resolver.resolve({ Ref: 'Res' }, ctx)).toBe('phys-id');
    expect(await resolver.resolve({ Ref: 'P' }, ctx)).toBe('pval');
    expect(await resolver.resolve({ 'Fn::GetAtt': ['Res', 'Attr'] }, ctx)).toBe('attr-val');
    expect(await resolver.resolve({ 'Fn::Join': ['-', ['a', 'b']] }, ctx)).toBe('a-b');
    expect(await resolver.resolve({ 'Fn::Sub': 'static-text' }, ctx)).toBe('static-text');
    expect(await resolver.resolve({ 'Fn::Select': [1, ['a', 'b', 'c']] }, ctx)).toBe('b');
    expect(await resolver.resolve({ 'Fn::Split': [',', 'a,b'] }, ctx)).toEqual(['a', 'b']);
    expect(await resolver.resolve({ 'Fn::If': ['C', 'yes', 'no'] }, ctx)).toBe('yes');
    expect(await resolver.resolve({ 'Fn::Equals': ['x', 'x'] }, ctx)).toBe(true);
    expect(await resolver.resolve({ 'Fn::And': [true, true] }, ctx)).toBe(true);
    expect(await resolver.resolve({ 'Fn::Or': [false, true] }, ctx)).toBe(true);
    expect(await resolver.resolve({ 'Fn::Not': [false] }, ctx)).toBe(true);
    expect(await resolver.resolve({ 'Fn::FindInMap': ['M', 'K', 'V'] }, ctx)).toBe('mapped');
    expect(await resolver.resolve({ 'Fn::Base64': 'hi' }, ctx)).toBe(
      Buffer.from('hi').toString('base64')
    );
  });
});

describe('IntrinsicFunctionResolver - Fn::GetAtt with a dynamic (intrinsic) attribute name', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
  });

  const mkContext = (attrNameValue: unknown): ResolverContext => {
    const template: CloudFormationTemplate = {
      Resources: {
        Res: { Type: 'AWS::Custom::Foo', Properties: {} },
      },
      Parameters: {},
    };
    return {
      template,
      resources: {
        Res: {
          physicalId: 'phys-id',
          resourceType: 'AWS::Custom::Foo',
          properties: {},
          attributes: { Arn: 'the-arn-value' },
          dependencies: [],
        },
      },
      parameters: { AttrNameParam: attrNameValue as string },
    };
  };

  it('resolves a {Ref: AttrNameParam} attribute name the same as a literal attribute name', async () => {
    const context = mkContext('Arn');

    const dynamic = await resolver.resolve(
      { 'Fn::GetAtt': ['Res', { Ref: 'AttrNameParam' }] },
      context
    );
    const literal = await resolver.resolve({ 'Fn::GetAtt': ['Res', 'Arn'] }, context);

    expect(dynamic).toBe('the-arn-value');
    expect(dynamic).toBe(literal);
  });

  it('resolves an Fn::Sub attribute name the same as a literal attribute name', async () => {
    const context = mkContext('ignored');

    const dynamic = await resolver.resolve(
      { 'Fn::GetAtt': ['Res', { 'Fn::Sub': 'Arn' }] },
      context
    );

    expect(dynamic).toBe('the-arn-value');
  });

  it('throws a clear error when the resolved attribute name is not a string', async () => {
    // Parameter resolves to a non-string (e.g. a numeric CommaDelimitedList
    // entry coerced upstream); the GetAtt attribute name must be a string.
    const context = mkContext(['not', 'a', 'string']);

    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Res', { Ref: 'AttrNameParam' }] }, context)
    ).rejects.toThrow(/attribute name for Res must resolve to a string/);
  });
});

describe('IntrinsicFunctionResolver - Fn::Join over a list-returning intrinsic', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
  });

  it('should resolve Fn::Join whose second arg is Fn::Cidr (single list-returning intrinsic)', async () => {
    const context: ResolverContext = {
      resources: {},
      template: {} as CloudFormationTemplate,
    };

    // Fn::Cidr('10.0.0.0/16', 4, 8) -> 4 /24 blocks, joined by ','.
    const result = await resolver.resolve(
      { 'Fn::Join': [',', { 'Fn::Cidr': ['10.0.0.0/16', 4, 8] }] },
      context
    );

    expect(result).toBe('10.0.0.0/24,10.0.1.0/24,10.0.2.0/24,10.0.3.0/24');
  });

  it('should resolve Fn::Join whose second arg is Fn::Split', async () => {
    const context: ResolverContext = {
      resources: {},
      template: {} as CloudFormationTemplate,
    };

    // Fn::Split(',', 'a,b,c') -> ['a','b','c'], re-joined with '|'.
    const result = await resolver.resolve(
      { 'Fn::Join': ['|', { 'Fn::Split': [',', 'a,b,c'] }] },
      context
    );

    expect(result).toBe('a|b|c');
  });

  it('should resolve Fn::Join whose second arg is Fn::GetAZs', async () => {
    mockEc2Send.mockResolvedValueOnce({
      AvailabilityZones: [
        { ZoneName: 'us-east-1a', State: 'available' },
        { ZoneName: 'us-east-1b', State: 'available' },
        { ZoneName: 'us-east-1c', State: 'available' },
      ],
    });

    const context: ResolverContext = {
      resources: {},
      template: { Resources: {} },
    };

    const result = await resolver.resolve(
      { 'Fn::Join': [',', { 'Fn::GetAZs': '' }] },
      context
    );

    expect(result).toBe('us-east-1a,us-east-1b,us-east-1c');
  });

  it('should resolve Fn::Join whose second arg is a Ref to a CommaDelimitedList parameter', async () => {
    const context: ResolverContext = {
      resources: {},
      template: {} as CloudFormationTemplate,
      // A CommaDelimitedList parameter resolves to a real array value.
      parameters: { SubnetIds: ['subnet-aaa', 'subnet-bbb', 'subnet-ccc'] },
    };

    const result = await resolver.resolve(
      { 'Fn::Join': [',', { Ref: 'SubnetIds' }] },
      context
    );

    expect(result).toBe('subnet-aaa,subnet-bbb,subnet-ccc');
  });

  it('should still resolve Fn::Join whose second arg is a literal array (regression)', async () => {
    const context: ResolverContext = {
      resources: {},
      template: {} as CloudFormationTemplate,
    };

    const result = await resolver.resolve(
      { 'Fn::Join': ['-', ['a', 'b', 'c']] },
      context
    );

    expect(result).toBe('a-b-c');
  });

  it('should throw a clear error when the second arg resolves to a non-list', async () => {
    const context: ResolverContext = {
      resources: {},
      template: {} as CloudFormationTemplate,
      parameters: { NotAList: 'just-a-string' },
    };

    await expect(
      resolver.resolve({ 'Fn::Join': [',', { Ref: 'NotAList' }] }, context)
    ).rejects.toThrow(/Fn::Join's second argument must be a list/);
  });
});

describe('IntrinsicFunctionResolver - evaluateConditions composite refs (#840)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
  });

  // Build a template whose conditions key off two parameters so we can drive
  // every truth combination through real `Fn::Equals` / `{Condition: X}` refs.
  const buildTemplate = (
    conditions: Record<string, unknown>
  ): CloudFormationTemplate => ({
    Resources: {},
    Parameters: {
      Tier: { Type: 'String' },
      Region: { Type: 'String' },
    },
    Conditions: conditions,
  });

  const truthCombos: Array<{ tier: string; region: string; premium: boolean; primary: boolean }> = [
    { tier: 'premium', region: 'primary', premium: true, primary: true },
    { tier: 'premium', region: 'secondary', premium: true, primary: false },
    { tier: 'basic', region: 'primary', premium: false, primary: true },
    { tier: 'basic', region: 'secondary', premium: false, primary: false },
  ];

  it('resolves Fn::And of two {Condition: X} refs for every truth combination', async () => {
    const template = buildTemplate({
      IsPremium: { 'Fn::Equals': [{ Ref: 'Tier' }, 'premium'] },
      IsPrimaryRegion: { 'Fn::Equals': [{ Ref: 'Region' }, 'primary'] },
      IsPremiumPrimary: {
        'Fn::And': [{ Condition: 'IsPremium' }, { Condition: 'IsPrimaryRegion' }],
      },
    });

    for (const c of truthCombos) {
      const conditions = await resolver.evaluateConditions({
        template,
        resources: {},
        parameters: { Tier: c.tier, Region: c.region },
      });
      expect(conditions['IsPremium']).toBe(c.premium);
      expect(conditions['IsPrimaryRegion']).toBe(c.primary);
      // And(premium, primary)
      expect(conditions['IsPremiumPrimary']).toBe(c.premium && c.primary);
    }
  });

  it('is declaration-order independent (composite declared BEFORE its referenced conditions)', async () => {
    // IsPremiumPrimary references IsPremium / IsPrimaryRegion but is declared
    // first. Object insertion order would have evaluated it before its deps
    // under the old code, mis-evaluating to And(false, false) = false.
    const template = buildTemplate({
      IsPremiumPrimary: {
        'Fn::And': [{ Condition: 'IsPremium' }, { Condition: 'IsPrimaryRegion' }],
      },
      IsPremium: { 'Fn::Equals': [{ Ref: 'Tier' }, 'premium'] },
      IsPrimaryRegion: { 'Fn::Equals': [{ Ref: 'Region' }, 'primary'] },
    });

    // basic + primary -> And(false, true) = false (the integ-failing case)
    const basic = await resolver.evaluateConditions({
      template,
      resources: {},
      parameters: { Tier: 'basic', Region: 'primary' },
    });
    expect(basic['IsPremium']).toBe(false);
    expect(basic['IsPrimaryRegion']).toBe(true);
    expect(basic['IsPremiumPrimary']).toBe(false);

    // premium + primary -> And(true, true) = true
    const premium = await resolver.evaluateConditions({
      template,
      resources: {},
      parameters: { Tier: 'premium', Region: 'primary' },
    });
    expect(premium['IsPremiumPrimary']).toBe(true);
  });

  it('resolves Fn::Or of {Condition: X} refs', async () => {
    const template = buildTemplate({
      IsPremium: { 'Fn::Equals': [{ Ref: 'Tier' }, 'premium'] },
      IsPrimaryRegion: { 'Fn::Equals': [{ Ref: 'Region' }, 'primary'] },
      IsPremiumOrPrimary: {
        'Fn::Or': [{ Condition: 'IsPremium' }, { Condition: 'IsPrimaryRegion' }],
      },
    });

    for (const c of truthCombos) {
      const conditions = await resolver.evaluateConditions({
        template,
        resources: {},
        parameters: { Tier: c.tier, Region: c.region },
      });
      expect(conditions['IsPremiumOrPrimary']).toBe(c.premium || c.primary);
    }
  });

  it('resolves Fn::Not of a {Condition: X} ref', async () => {
    const template = buildTemplate({
      IsPremium: { 'Fn::Equals': [{ Ref: 'Tier' }, 'premium'] },
      IsNotPremium: { 'Fn::Not': [{ Condition: 'IsPremium' }] },
    });

    const premium = await resolver.evaluateConditions({
      template,
      resources: {},
      parameters: { Tier: 'premium', Region: 'x' },
    });
    expect(premium['IsNotPremium']).toBe(false);

    const basic = await resolver.evaluateConditions({
      template,
      resources: {},
      parameters: { Tier: 'basic', Region: 'x' },
    });
    expect(basic['IsNotPremium']).toBe(true);
  });

  it('resolves nested composite refs (composite referencing another composite)', async () => {
    const template = buildTemplate({
      IsPremium: { 'Fn::Equals': [{ Ref: 'Tier' }, 'premium'] },
      IsPrimaryRegion: { 'Fn::Equals': [{ Ref: 'Region' }, 'primary'] },
      IsPremiumPrimary: {
        'Fn::And': [{ Condition: 'IsPremium' }, { Condition: 'IsPrimaryRegion' }],
      },
      // References the composite IsPremiumPrimary plus a leaf condition.
      IsDeployable: {
        'Fn::Or': [{ Condition: 'IsPremiumPrimary' }, { Condition: 'IsPrimaryRegion' }],
      },
    });

    const basicPrimary = await resolver.evaluateConditions({
      template,
      resources: {},
      parameters: { Tier: 'basic', Region: 'primary' },
    });
    // IsPremiumPrimary = And(false,true) = false; IsDeployable = Or(false,true) = true
    expect(basicPrimary['IsPremiumPrimary']).toBe(false);
    expect(basicPrimary['IsDeployable']).toBe(true);
  });

  it('downgrades a circular {Condition: X} reference to false instead of looping', async () => {
    const warnSpy = vi.spyOn(
      (resolver as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn'
    );
    const template = buildTemplate({
      CondA: { 'Fn::And': [{ Condition: 'CondB' }, { 'Fn::Equals': ['x', 'x'] }] },
      CondB: { 'Fn::And': [{ Condition: 'CondA' }, { 'Fn::Equals': ['x', 'x'] }] },
    });

    const conditions = await resolver.evaluateConditions({
      template,
      resources: {},
      parameters: {},
    });

    // Both collapse to false; no infinite recursion / stack overflow.
    expect(conditions['CondA']).toBe(false);
    expect(conditions['CondB']).toBe(false);
    expect(
      warnSpy.mock.calls.some(([m]) => String(m).includes('Circular condition reference'))
    ).toBe(true);
  });

  it('warns and assumes false for a {Condition: X} ref to an undeclared condition', async () => {
    const template = buildTemplate({
      IsBoth: { 'Fn::And': [{ Condition: 'Missing' }, { 'Fn::Equals': ['x', 'x'] }] },
    });

    const conditions = await resolver.evaluateConditions({
      template,
      resources: {},
      parameters: {},
    });
    // And(false, true) = false because Missing is undeclared.
    expect(conditions['IsBoth']).toBe(false);
  });

  it('does not misdetect a resource property literally named "Condition"', async () => {
    // A `{ Condition: 'X', Other: 'Y' }` object (>1 key) is a normal object,
    // not a condition reference — it must be resolved recursively, not routed
    // through resolveConditionReference.
    const result = await resolver.resolve(
      { Condition: 'SomeString', Other: { Ref: 'P' } },
      {
        template: { Resources: {} },
        resources: {},
        parameters: { P: 'pval' },
      }
    );
    expect(result).toEqual({ Condition: 'SomeString', Other: 'pval' });
  });

  it('does not coerce a single-key { Condition: "X" } resource property to a boolean in normal context', async () => {
    // A single-key `{ Condition: '<string>' }` object IS the named-condition
    // reference form — but only inside `evaluateConditions`, which threads a
    // `conditionResolver` hook onto the context. In a normal resource / output
    // property context (the public `resolve` entry, no conditionResolver) the
    // same shape is just a plain property literally named `Condition` and MUST
    // resolve as an ordinary object — never get coerced to `false` by
    // resolveConditionReference (which, lacking a resolver hook AND a
    // `conditions` map, would otherwise return false and corrupt the property).
    const result = await resolver.resolve(
      { Condition: 'Foo' },
      {
        template: { Resources: {} },
        resources: {},
        parameters: {},
      }
    );
    expect(result).toEqual({ Condition: 'Foo' });
    expect(result).not.toBe(false);
  });
});

describe('IntrinsicFunctionResolver - AWS::CloudWatch::CompositeAlarm Fn::GetAtt', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
    mockEc2Send.mockReset();
  });

  it('resolves Arn to the :alarm: ARN built from the physical id (not the alarm name)', async () => {
    // AWS::CloudWatch::CompositeAlarm has no SDK provider, so it is routed via
    // Cloud Control and its Arn may not be captured in attributes. Without the
    // constructAttribute case, Fn::GetAtt(<CompositeAlarm>, 'Arn') fell through
    // to the physicalId default and returned the alarm NAME instead of its ARN.
    const template: CloudFormationTemplate = {
      Resources: {
        MyComposite: { Type: 'AWS::CloudWatch::CompositeAlarm', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        MyComposite: {
          physicalId: 'my-composite-alarm',
          resourceType: 'AWS::CloudWatch::CompositeAlarm',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['MyComposite', 'Arn'] },
      context
    );
    expect(result).toBe('arn:aws:cloudwatch:us-east-1:123456789012:alarm:my-composite-alarm');
    // No live lookup is needed for a CompositeAlarm ARN.
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('falls back to the physical id for a non-Arn attribute', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        MyComposite: { Type: 'AWS::CloudWatch::CompositeAlarm', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        MyComposite: {
          physicalId: 'my-composite-alarm',
          resourceType: 'AWS::CloudWatch::CompositeAlarm',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['MyComposite', 'SomethingElse'] },
      context
    );
    expect(result).toBe('my-composite-alarm');
  });
});

describe('IntrinsicFunctionResolver - AWS::EC2::Instance Fn::GetAtt (live DescribeInstances)', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
    resetAccountInfoCache();
    mockEc2Send.mockReset();
  });

  it('resolves PrivateIp to the live IP from DescribeInstances (not the instance id)', async () => {
    // Without the live-lookup case, Fn::GetAtt(<Instance>, 'PrivateIp') fell
    // through to the physicalId default and handed the instance id to a
    // downstream consumer expecting an IP (e.g. an ELBv2 IP-target group
    // registration rejects `i-...` with `not a valid IPv4 address`).
    mockEc2Send.mockResolvedValue({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-0123456789abcdef0',
              PrivateIpAddress: '10.0.3.42',
              PublicIpAddress: '54.1.2.3',
              PrivateDnsName: 'ip-10-0-3-42.ec2.internal',
              PublicDnsName: 'ec2-54-1-2-3.compute-1.amazonaws.com',
              Placement: { AvailabilityZone: 'us-east-1a' },
            },
          ],
        },
      ],
    });

    const template: CloudFormationTemplate = {
      Resources: {
        MyInstance: { Type: 'AWS::EC2::Instance', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        MyInstance: {
          physicalId: 'i-0123456789abcdef0',
          resourceType: 'AWS::EC2::Instance',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['MyInstance', 'PrivateIp'] },
      context
    );
    expect(result).toBe('10.0.3.42');
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it('resolves the other live attributes (PublicIp / DnsName / AvailabilityZone)', async () => {
    mockEc2Send.mockResolvedValue({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: 'i-0123456789abcdef0',
              PrivateIpAddress: '10.0.3.42',
              PublicIpAddress: '54.1.2.3',
              PrivateDnsName: 'ip-10-0-3-42.ec2.internal',
              PublicDnsName: 'ec2-54-1-2-3.compute-1.amazonaws.com',
              Placement: { AvailabilityZone: 'us-east-1a' },
            },
          ],
        },
      ],
    });

    const template: CloudFormationTemplate = {
      Resources: {
        MyInstance: { Type: 'AWS::EC2::Instance', Properties: {} },
      },
    };
    const makeContext = (): ResolverContext => ({
      template,
      resources: {
        MyInstance: {
          physicalId: 'i-0123456789abcdef0',
          resourceType: 'AWS::EC2::Instance',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    });

    expect(await resolver.resolve({ 'Fn::GetAtt': ['MyInstance', 'PublicIp'] }, makeContext())).toBe(
      '54.1.2.3'
    );
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['MyInstance', 'PublicDnsName'] }, makeContext())
    ).toBe('ec2-54-1-2-3.compute-1.amazonaws.com');
    expect(
      await resolver.resolve({ 'Fn::GetAtt': ['MyInstance', 'AvailabilityZone'] }, makeContext())
    ).toBe('us-east-1a');
  });

  it('caches per (physicalId, attribute) so a repeated reference makes one DescribeInstances call', async () => {
    mockEc2Send.mockResolvedValue({
      Reservations: [{ Instances: [{ PrivateIpAddress: '10.0.3.42' }] }],
    });

    const template: CloudFormationTemplate = {
      Resources: {
        MyInstance: { Type: 'AWS::EC2::Instance', Properties: {} },
      },
    };
    const makeContext = (): ResolverContext => ({
      template,
      resources: {
        MyInstance: {
          physicalId: 'i-0123456789abcdef0',
          resourceType: 'AWS::EC2::Instance',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    });

    expect(await resolver.resolve({ 'Fn::GetAtt': ['MyInstance', 'PrivateIp'] }, makeContext())).toBe(
      '10.0.3.42'
    );
    expect(await resolver.resolve({ 'Fn::GetAtt': ['MyInstance', 'PrivateIp'] }, makeContext())).toBe(
      '10.0.3.42'
    );
    expect(mockEc2Send).toHaveBeenCalledTimes(1);
  });

  it('falls back to the physical id when DescribeInstances fails', async () => {
    mockEc2Send.mockRejectedValue(new Error('Access Denied'));

    const template: CloudFormationTemplate = {
      Resources: {
        MyInstance: { Type: 'AWS::EC2::Instance', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        MyInstance: {
          physicalId: 'i-0123456789abcdef0',
          resourceType: 'AWS::EC2::Instance',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve(
      { 'Fn::GetAtt': ['MyInstance', 'PrivateIp'] },
      context
    );
    expect(result).toBe('i-0123456789abcdef0');
  });
});

describe('IntrinsicFunctionResolver - Ref to AWS::ApiGateway::Model', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    resolver = new IntrinsicFunctionResolver();
  });

  // CFn `Ref` of an AWS::ApiGateway::Model returns the model NAME, but the model
  // is provisioned via Cloud Control whose primary identifier (cdkd's physical
  // id) is the compound `<restApiId>|<modelName>`. A method's RequestModels
  // wiring `{ "application/json": { "Ref": <Model> } }` would otherwise receive
  // `<restApiId>|<modelName>` and API Gateway rejects it with "Invalid model
  // identifier specified". The resolver must return just the model name.
  it('Ref returns the model name, not the compound <restApiId>|<modelName> physical id', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        PetModel: { Type: 'AWS::ApiGateway::Model', Properties: { Name: 'Pet' } },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        PetModel: {
          physicalId: 'tdo7p9w58k|Pet',
          resourceType: 'AWS::ApiGateway::Model',
          properties: { Name: 'Pet' },
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve({ Ref: 'PetModel' }, context);
    expect(result).toBe('Pet');
  });

  // Same bug class for AWS::ApiGateway::RequestValidator: CFn `Ref` returns the
  // RequestValidatorId, but the Cloud Control physical id is the compound
  // `<restApiId>|<requestValidatorId>`. A method wiring
  // `RequestValidatorId: { "Ref": <Validator> }` would otherwise get the
  // compound id and API Gateway rejects it with "Invalid Request Validator
  // identifier specified".
  it('Ref to AWS::ApiGateway::RequestValidator returns the validator id, not the compound physical id', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        BodyValidator: { Type: 'AWS::ApiGateway::RequestValidator', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        BodyValidator: {
          physicalId: 'tdo7p9w58k|abc123',
          resourceType: 'AWS::ApiGateway::RequestValidator',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve({ Ref: 'BodyValidator' }, context);
    expect(result).toBe('abc123');
  });

  // Same bug class for AWS::Cognito::UserPoolClient: CFn `Ref` returns the
  // client id, but the Cloud Control physical id is the compound
  // `<userPoolId>|<clientId>`. A consumer of the client id (CfnOutput, Lambda
  // env var, cognito-idp API) would otherwise get the compound id, which fails
  // Cognito's `[\w+]+` client-id validation.
  it('Ref to AWS::Cognito::UserPoolClient returns the client id, not the compound physical id', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Client: { Type: 'AWS::Cognito::UserPoolClient', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        Client: {
          physicalId: 'us-east-1_t1TBpabHO|9fut2hkhdues45051mvms2os5',
          resourceType: 'AWS::Cognito::UserPoolClient',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve({ Ref: 'Client' }, context);
    expect(result).toBe('9fut2hkhdues45051mvms2os5');
  });

  it('Ref falls back to the raw physical id when there is no pipe separator', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        PetModel: { Type: 'AWS::ApiGateway::Model', Properties: { Name: 'Pet' } },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        PetModel: {
          physicalId: 'Pet',
          resourceType: 'AWS::ApiGateway::Model',
          properties: { Name: 'Pet' },
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve({ Ref: 'PetModel' }, context);
    expect(result).toBe('Pet');
  });

  it('Ref to a non-Model resource still returns the full physical id', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Q: { Type: 'AWS::SQS::Queue', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        Q: {
          physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/my-queue',
          resourceType: 'AWS::SQS::Queue',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve({ Ref: 'Q' }, context);
    expect(result).toBe('https://sqs.us-east-1.amazonaws.com/123456789012/my-queue');
  });

  // Same bug class for AppConfig compound-id children. CFn `Ref` returns the
  // child's own id, but the Cloud Control physical id is the compound
  // `<appId>|<...>`. A HostedConfigurationVersion wiring
  // `ConfigurationProfileId: { Ref: <Profile> }` would otherwise receive the
  // compound and AppConfig rejects it ("Configuration Profile ... could not be
  // found").
  it('Ref to AWS::AppConfig::ConfigurationProfile returns the profile id (2-segment compound)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Profile: { Type: 'AWS::AppConfig::ConfigurationProfile', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        Profile: {
          physicalId: 'p15d7pf|93dtcij',
          resourceType: 'AWS::AppConfig::ConfigurationProfile',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve({ Ref: 'Profile' }, context);
    expect(result).toBe('93dtcij');
  });

  it('Ref to AWS::AppConfig::Environment returns the environment id (2-segment compound)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Env: { Type: 'AWS::AppConfig::Environment', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        Env: {
          physicalId: 'p15d7pf|envabc',
          resourceType: 'AWS::AppConfig::Environment',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve({ Ref: 'Env' }, context);
    expect(result).toBe('envabc');
  });

  // 3-segment compound: the extraction MUST take the segment after the LAST
  // pipe (`indexOf` would wrongly return `93dtcij|1`).
  it('Ref to AWS::AppConfig::HostedConfigurationVersion returns the version number (3-segment compound, last-pipe)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Version: { Type: 'AWS::AppConfig::HostedConfigurationVersion', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        Version: {
          physicalId: 'p15d7pf|93dtcij|1',
          resourceType: 'AWS::AppConfig::HostedConfigurationVersion',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve({ Ref: 'Version' }, context);
    expect(result).toBe('1');
  });

  it('Ref to AWS::AppConfig::Deployment returns the deployment number (3-segment compound, last-pipe)', async () => {
    const template: CloudFormationTemplate = {
      Resources: {
        Deployment: { Type: 'AWS::AppConfig::Deployment', Properties: {} },
      },
    };
    const context: ResolverContext = {
      template,
      resources: {
        Deployment: {
          physicalId: 'p15d7pf|envabc|3',
          resourceType: 'AWS::AppConfig::Deployment',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      },
    };

    const result = await resolver.resolve({ Ref: 'Deployment' }, context);
    expect(result).toBe('3');
  });
});
