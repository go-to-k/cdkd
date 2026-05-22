import { describe, it, expect, vi } from 'vite-plus/test';
import {
  prefetchCfnStack,
  validatePrefetchResult,
  type PrefetchResult,
} from '../../../../../src/cli/commands/migrate/cfn-stack-prefetch.js';
import { LocalMigrateError } from '../../../../../src/utils/error-handler.js';

/**
 * Build a mock CloudFormationClient whose `send()` returns scripted
 * responses keyed by command class name. Each entry is matched against
 * `cmd.constructor.name`.
 */
function buildMockCfnClient(
  responses: Record<string, unknown>
): { send: ReturnType<typeof vi.fn>; destroy?: () => void } {
  const send = vi.fn(async (cmd: { constructor: { name: string } }) => {
    const key = cmd.constructor.name;
    if (!(key in responses)) {
      throw new Error(`Unexpected CFn command: ${key}`);
    }
    const response = responses[key];
    if (response instanceof Error) throw response;
    return response;
  });
  return { send } as any;
}

describe('prefetchCfnStack', () => {
  it('returns stack status + resources + transformInfo on a clean stack', async () => {
    const client = buildMockCfnClient({
      DescribeStacksCommand: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] },
      DescribeStackResourcesCommand: {
        StackResources: [
          {
            LogicalResourceId: 'MyBucket',
            PhysicalResourceId: 'my-bucket-12345',
            ResourceType: 'AWS::S3::Bucket',
          },
          {
            LogicalResourceId: 'MyParam',
            PhysicalResourceId: '/cdkd/migrate/test/param',
            ResourceType: 'AWS::SSM::Parameter',
          },
        ],
      },
      GetTemplateCommand: {
        TemplateBody: JSON.stringify({
          Resources: {
            MyBucket: { Type: 'AWS::S3::Bucket' },
          },
        }),
      },
    });
    const result = await prefetchCfnStack('MyStack', client as any);
    expect(result.stackStatus).toBe('CREATE_COMPLETE');
    expect(result.resources).toHaveLength(2);
    expect(result.resources[0]!.LogicalResourceId).toBe('MyBucket');
    expect(result.resources[0]!.ResourceType).toBe('AWS::S3::Bucket');
    expect(result.transformInfo.hasSamTransform).toBe(false);
    expect(result.transformInfo.hasIncludeTransform).toBe(false);
  });

  it('throws LocalMigrateError when the stack does not exist', async () => {
    const client = buildMockCfnClient({
      DescribeStacksCommand: { Stacks: [] },
    });
    await expect(prefetchCfnStack('NoSuchStack', client as any)).rejects.toBeInstanceOf(
      LocalMigrateError
    );
  });

  it('detects an AWS::Serverless transform', async () => {
    const client = buildMockCfnClient({
      DescribeStacksCommand: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] },
      DescribeStackResourcesCommand: { StackResources: [] },
      GetTemplateCommand: {
        TemplateBody: JSON.stringify({
          Transform: 'AWS::Serverless-2016-10-31',
          Resources: {},
        }),
      },
    });
    const result = await prefetchCfnStack('SamStack', client as any);
    expect(result.transformInfo.hasSamTransform).toBe(true);
    expect(result.transformInfo.hasIncludeTransform).toBe(false);
  });

  it('detects an AWS::Include transform', async () => {
    const client = buildMockCfnClient({
      DescribeStacksCommand: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] },
      DescribeStackResourcesCommand: { StackResources: [] },
      GetTemplateCommand: {
        TemplateBody: JSON.stringify({
          Transform: 'AWS::Include',
          Resources: {},
        }),
      },
    });
    const result = await prefetchCfnStack('IncludeStack', client as any);
    expect(result.transformInfo.hasIncludeTransform).toBe(true);
    expect(result.transformInfo.hasSamTransform).toBe(false);
  });

  it('detects both transforms when Transform is an array', async () => {
    const client = buildMockCfnClient({
      DescribeStacksCommand: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] },
      DescribeStackResourcesCommand: { StackResources: [] },
      GetTemplateCommand: {
        TemplateBody: JSON.stringify({
          Transform: ['AWS::Serverless-2016-10-31', 'AWS::Include'],
          Resources: {},
        }),
      },
    });
    const result = await prefetchCfnStack('MultiStack', client as any);
    expect(result.transformInfo.hasSamTransform).toBe(true);
    expect(result.transformInfo.hasIncludeTransform).toBe(true);
  });

  it('treats a GetTemplate failure as best-effort (no transforms detected)', async () => {
    const client = buildMockCfnClient({
      DescribeStacksCommand: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] },
      DescribeStackResourcesCommand: {
        StackResources: [
          {
            LogicalResourceId: 'X',
            PhysicalResourceId: 'x',
            ResourceType: 'AWS::S3::Bucket',
          },
        ],
      },
      GetTemplateCommand: new Error('AccessDenied'),
    });
    const result = await prefetchCfnStack('StackName', client as any);
    expect(result.resources).toHaveLength(1);
    expect(result.transformInfo.hasSamTransform).toBe(false);
    expect(result.transformInfo.hasIncludeTransform).toBe(false);
  });

  it('skips resources with missing fields in DescribeStackResources', async () => {
    const client = buildMockCfnClient({
      DescribeStacksCommand: { Stacks: [{ StackStatus: 'CREATE_COMPLETE' }] },
      DescribeStackResourcesCommand: {
        StackResources: [
          {
            LogicalResourceId: 'Valid',
            PhysicalResourceId: 'p',
            ResourceType: 'AWS::S3::Bucket',
          },
          { LogicalResourceId: 'MissingPhysical', ResourceType: 'AWS::SSM::Parameter' },
          { LogicalResourceId: 'NoType', PhysicalResourceId: 'p' },
        ],
      },
      GetTemplateCommand: { TemplateBody: JSON.stringify({ Resources: {} }) },
    });
    const result = await prefetchCfnStack('PartialStack', client as any);
    expect(result.resources).toHaveLength(1);
    expect(result.resources[0]!.LogicalResourceId).toBe('Valid');
  });
});

describe('validatePrefetchResult', () => {
  const cleanBase: PrefetchResult = {
    stackStatus: 'CREATE_COMPLETE',
    resources: [],
    transformInfo: { hasSamTransform: false, hasIncludeTransform: false },
  };

  it('passes on an empty stack in CREATE_COMPLETE', () => {
    expect(() => validatePrefetchResult(cleanBase)).not.toThrow();
  });

  it('passes on a stack with only supported resource types', () => {
    expect(() =>
      validatePrefetchResult({
        ...cleanBase,
        resources: [
          { LogicalResourceId: 'B', PhysicalResourceId: 'b', ResourceType: 'AWS::S3::Bucket' },
          { LogicalResourceId: 'P', PhysicalResourceId: 'p', ResourceType: 'AWS::SSM::Parameter' },
        ],
      })
    ).not.toThrow();
  });

  it('rejects a Custom::* logical type', () => {
    expect(() =>
      validatePrefetchResult({
        ...cleanBase,
        resources: [
          {
            LogicalResourceId: 'CustomCleanup',
            PhysicalResourceId: 'arn:aws:cloudformation:...',
            ResourceType: 'Custom::Foo',
          },
        ],
      })
    ).toThrow(LocalMigrateError);
  });

  it('rejects AWS::CloudFormation::CustomResource', () => {
    expect(() =>
      validatePrefetchResult({
        ...cleanBase,
        resources: [
          {
            LogicalResourceId: 'CustomCFn',
            PhysicalResourceId: 'arn:aws:cloudformation:...',
            ResourceType: 'AWS::CloudFormation::CustomResource',
          },
        ],
      })
    ).toThrow(LocalMigrateError);
  });

  it('rejects AWS::CloudFormation::Stack (nested stacks)', () => {
    expect(() =>
      validatePrefetchResult({
        ...cleanBase,
        resources: [
          {
            LogicalResourceId: 'NestedStack',
            PhysicalResourceId: 'arn:aws:cloudformation:...',
            ResourceType: 'AWS::CloudFormation::Stack',
          },
        ],
      })
    ).toThrow(LocalMigrateError);
  });

  it('rejects when MULTIPLE offenders are present and lists them all', () => {
    try {
      validatePrefetchResult({
        ...cleanBase,
        resources: [
          {
            LogicalResourceId: 'CR',
            PhysicalResourceId: 'p',
            ResourceType: 'Custom::Foo',
          },
          {
            LogicalResourceId: 'Nested',
            PhysicalResourceId: 'p2',
            ResourceType: 'AWS::CloudFormation::Stack',
          },
          {
            LogicalResourceId: 'OK',
            PhysicalResourceId: 'p3',
            ResourceType: 'AWS::S3::Bucket',
          },
        ],
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LocalMigrateError);
      const msg = (e as Error).message;
      expect(msg).toMatch(/CR \(Custom::Foo\)/);
      expect(msg).toMatch(/Nested \(AWS::CloudFormation::Stack\)/);
      expect(msg).toMatch(/cdk migrate --from-stack/);
    }
  });

  it('rejects non-terminal stack status', () => {
    expect(() =>
      validatePrefetchResult({ ...cleanBase, stackStatus: 'UPDATE_IN_PROGRESS' })
    ).toThrow(LocalMigrateError);
  });

  it('rejects ROLLBACK_FAILED status', () => {
    expect(() =>
      validatePrefetchResult({ ...cleanBase, stackStatus: 'ROLLBACK_FAILED' })
    ).toThrow(LocalMigrateError);
  });

  it('passes when SAM transform is present (INFO-only)', () => {
    // SAM and Include transforms surface as INFO logs but do NOT
    // hard-fail the migration. Validate() only rejects resource-type
    // offenders + non-terminal states.
    expect(() =>
      validatePrefetchResult({
        ...cleanBase,
        transformInfo: { hasSamTransform: true, hasIncludeTransform: false },
      })
    ).not.toThrow();
  });
});
