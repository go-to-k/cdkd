import { describe, it, expect, vi, beforeEach } from 'vitest';
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

// Mock AWS clients (for STS in pseudo parameter resolution)
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
      }),
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
