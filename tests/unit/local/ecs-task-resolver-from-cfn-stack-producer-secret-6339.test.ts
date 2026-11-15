/**
 * go-to-k/cdkd#6339: under `--from-cfn-stack` the cross-stack resolver is
 * cdk-local's `CfnLocalStateProvider` one, which (cdk-local 0.168.2) carries
 * the judged variants cdkd's own post-pass reads. A producer stack's exported
 * `AWS::AppSync::ApiKey` read through `Fn::ImportValue` is refused on the argv,
 * served value-less in `Environment`, and dropped as a `Secrets` `ValueFrom`;
 * a value cdk-local could not check is refused naming the failed call. The
 * CloudFormation SDK is stubbed on the shared client's prototype, so the
 * judging itself is cdk-local's real code.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  CloudFormationClient,
  CloudFormationServiceException,
  DescribeStacksCommand,
  GetTemplateCommand,
  ListExportsCommand,
  ListStackResourcesCommand,
} from '@aws-sdk/client-cloudformation';
import { CfnLocalStateProvider } from 'cdk-local';
import {
  applyCrossStackResolverToTask,
  assertEcsTaskCommandsResolved,
  resolveEcsTaskTarget,
} from '../../../src/local/ecs-task-resolver.js';
import type { ResolvedEcsTask } from '../../../src/local/ecs-task-resolver.js';
import { buildDockerRunArgs } from '../../../src/local/ecs-task-runner/docker-run-args.js';
import type { CrossStackResolver } from '../../../src/local/state-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const API_KEY = 'da2-producerkey6339abcdefgh';
const PRODUCER = 'arn:aws:cloudformation:us-east-1:123456789012:stack/Producer/1111';
const LOCKED = 'arn:aws:cloudformation:us-east-1:123456789012:stack/Locked/2222';
const LOCKED_SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:db-AbCdEf';
const LOCKED_PARAM_ARN = 'arn:aws:ssm:us-east-1:123456789012:parameter/app/db-password';

function stub(command: unknown): unknown {
  if (command instanceof ListExportsCommand) {
    return {
      Exports: [
        { Name: 'Producer-ApiKey', Value: API_KEY, ExportingStackId: PRODUCER },
        { Name: 'Producer-Plain', Value: 'plain-value-6339', ExportingStackId: PRODUCER },
        { Name: 'Locked-Bucket', Value: 'locked-bucket-6339', ExportingStackId: LOCKED },
        { Name: 'Locked-SecretArn', Value: LOCKED_SECRET_ARN, ExportingStackId: LOCKED },
        { Name: 'Locked-ParamArn', Value: LOCKED_PARAM_ARN, ExportingStackId: LOCKED },
      ],
    };
  }
  const stackName = (command as { input: { StackName?: string } }).input.StackName;
  if (command instanceof ListStackResourcesCommand) {
    return {
      StackResourceSummaries:
        stackName === PRODUCER
          ? [
              {
                LogicalResourceId: 'Key',
                ResourceType: 'AWS::AppSync::ApiKey',
                PhysicalResourceId: `arn:aws:appsync:us-east-1:123456789012:apis/abc/apikeys/${API_KEY}`,
              },
            ]
          : [],
    };
  }
  if (command instanceof DescribeStacksCommand) {
    const outputs =
      stackName === PRODUCER
        ? [
            { OutputKey: 'KeyOut', ExportName: 'Producer-ApiKey', OutputValue: API_KEY },
            { OutputKey: 'PlainOut', ExportName: 'Producer-Plain', OutputValue: 'plain-value-6339' },
          ]
        : [
            { OutputKey: 'BucketOut', ExportName: 'Locked-Bucket', OutputValue: 'locked-bucket-6339' },
            { OutputKey: 'ArnOut', ExportName: 'Locked-SecretArn', OutputValue: LOCKED_SECRET_ARN },
            { OutputKey: 'ParamOut', ExportName: 'Locked-ParamArn', OutputValue: LOCKED_PARAM_ARN },
          ];
    return { Stacks: [{ StackName: stackName, Outputs: outputs }] };
  }
  if (command instanceof GetTemplateCommand) {
    if (stackName === LOCKED) {
      throw new CloudFormationServiceException({
        name: 'AccessDenied',
        $fault: 'client',
        $metadata: {},
        message: 'not authorized to perform: cloudformation:GetTemplate',
      });
    }
    return {
      TemplateBody: JSON.stringify({
        Resources: { Key: { Type: 'AWS::AppSync::ApiKey', Properties: { ApiId: 'abc' } } },
        Outputs: {
          KeyOut: { Value: { 'Fn::GetAtt': ['Key', 'ApiKey'] }, Export: { Name: 'Producer-ApiKey' } },
          PlainOut: { Value: 'plain-value-6339', Export: { Name: 'Producer-Plain' } },
        },
      }),
    };
  }
  throw new Error(`unexpected CloudFormation call ${String((command as object).constructor.name)}`);
}

let provider: CfnLocalStateProvider;
beforeEach(() => {
  vi.spyOn(CloudFormationClient.prototype, 'send').mockImplementation((async (command: unknown) =>
    stub(command)) as never);
  provider = new CfnLocalStateProvider({ cfnStackName: 'Consumer', region: 'us-east-1' });
});
afterEach(() => {
  provider.dispose();
  vi.restoreAllMocks();
});

function task(container: Record<string, unknown>): ResolvedEcsTask {
  const stack: StackInfo = {
    stackName: 'Consumer',
    displayName: 'Consumer',
    artifactId: 'Consumer',
    template: {
      Resources: {
        TD: {
          Type: 'AWS::ECS::TaskDefinition',
          Properties: {
            Family: 'fam',
            NetworkMode: 'bridge',
            ContainerDefinitions: [{ Name: 'app', Image: 'busybox:latest', ...container }],
          },
        },
      },
    },
    dependencyNames: [],
  };
  return resolveEcsTaskTarget('TD', [stack], { stateResources: {} });
}

async function resolve(t: ResolvedEcsTask): Promise<void> {
  const resolver = (await provider.buildCrossStackResolver('us-east-1')) as CrossStackResolver;
  await applyCrossStackResolverToTask(t, { resources: {}, crossStackResolver: resolver });
}

function dockerArgs(t: ResolvedEcsTask): string[] {
  const container = t.containers[0]!;
  return buildDockerRunArgs({
    task: t,
    container,
    image: 'img',
    network: 'net',
    volumeByName: new Map(),
    secrets: [],
    plaintextEnvKeys: container.resolvedDynamicReferenceKeys ?? [],
    envOverrides: undefined,
    containerHost: '127.0.0.1',
    roleArn: undefined,
    platformOverride: undefined,
    region: 'us-east-1',
  }).args;
}

describe('--from-cfn-stack: a producer stack exported secret stays off the docker run argv (go-to-k/cdkd#6339)', () => {
  it('refuses the key in Command, and keeps a plain export inline', async () => {
    const t = task({
      Command: ['--plain', { 'Fn::ImportValue': 'Producer-Plain' }, '--key', { 'Fn::ImportValue': 'Producer-ApiKey' }],
    });
    await resolve(t);
    expect(dockerArgs(t).join(' ')).not.toContain(API_KEY);
    expect(() => assertEcsTaskCommandsResolved(t)).toThrow(
      /Command\[3\]: resolved a cross-stack value holding a secret of the producer stack/
    );
  });

  it('control: a plain export alone resolves onto the argv', async () => {
    const t = task({ Command: ['--plain', { 'Fn::ImportValue': 'Producer-Plain' }] });
    await resolve(t);
    expect(dockerArgs(t)).toContain('plain-value-6339');
    expect(() => assertEcsTaskCommandsResolved(t)).not.toThrow();
  });

  it('serves the key value-less in Environment, and a plain export inline', async () => {
    const t = task({
      Environment: [
        { Name: 'API_KEY', Value: { 'Fn::ImportValue': 'Producer-ApiKey' } },
        { Name: 'PLAIN', Value: { 'Fn::ImportValue': 'Producer-Plain' } },
      ],
    });
    await resolve(t);
    const args = dockerArgs(t);
    expect(args.join(' ')).not.toContain(API_KEY);
    expect(args).toContain('API_KEY');
    expect(args).toContain('PLAIN=plain-value-6339');
    expect(t.containers[0]!.environment['API_KEY']).toBe(API_KEY);
  });

  it('drops the key as a Secrets ValueFrom', async () => {
    const t = task({ Secrets: [{ Name: 'TOKEN', ValueFrom: { 'Fn::ImportValue': 'Producer-ApiKey' } }] });
    await resolve(t);
    expect(t.containers[0]!.secrets).toEqual([]);
  });

  it('refuses a value cdk-local could not check, naming the failed call and no value', async () => {
    const t = task({ Command: ['--bucket', { 'Fn::ImportValue': 'Locked-Bucket' }] });
    await resolve(t);
    expect(dockerArgs(t).join(' ')).not.toContain('locked-bucket-6339');
    let message = '';
    try {
      assertEcsTaskCommandsResolved(t);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(
      /Command\[1\]: resolved a cross-stack value cdkd could not check for secrets: GetTemplate of .*Locked.* failed: AccessDenied/
    );
    expect(message).not.toContain('locked-bucket-6339');
  });

  it('keeps an unchecked Secrets ValueFrom that is a well-formed secret ARN, and drops an unchecked non-ARN one', async () => {
    const t = task({
      Secrets: [
        { Name: 'DB', ValueFrom: { 'Fn::ImportValue': 'Locked-SecretArn' } },
        { Name: 'PARAM', ValueFrom: { 'Fn::ImportValue': 'Locked-ParamArn' } },
        { Name: 'OTHER', ValueFrom: { 'Fn::ImportValue': 'Locked-Bucket' } },
      ],
    });
    await resolve(t);
    expect(t.containers[0]!.secrets).toEqual([
      { name: 'DB', valueFrom: LOCKED_SECRET_ARN },
      { name: 'PARAM', valueFrom: LOCKED_PARAM_ARN },
    ]);
    expect(t.containers[0]!.droppedSecretNames).toEqual(['OTHER']);
  });

  it('still drops a ValueFrom judged a secret even when it is ARN-shaped', async () => {
    const t = task({ Secrets: [{ Name: 'DB', ValueFrom: { 'Fn::ImportValue': 'X' } }] });
    const judged = { value: LOCKED_SECRET_ARN, verdict: 'secret' as const };
    await applyCrossStackResolverToTask(t, {
      resources: {},
      crossStackResolver: {
        resolveImport: async () => LOCKED_SECRET_ARN,
        resolveGetStackOutput: async () => undefined,
        resolveImportJudged: async () => judged,
        resolveGetStackOutputJudged: async () => ({ value: undefined }),
      } as CrossStackResolver,
    });
    expect(t.containers[0]!.secrets).toEqual([]);
    expect(t.containers[0]!.droppedSecretNames).toEqual(['DB']);
  });
});
