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

  it('rejects RoleArn (cross-account not yet supported)', async () => {
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
            RoleArn: 'arn:aws:iam::222222222222:role/CrossAccount',
          },
        },
        context
      )
    ).rejects.toThrow(
      'Fn::GetStackOutput: cross-account references via RoleArn are not yet supported'
    );
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
