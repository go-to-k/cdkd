import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const h = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  cwl: vi.fn(),
  sts: vi.fn(),
  sns: vi.fn(),
  ddb: vi.fn(),
  lambda: vi.fn(),
  lambdaWeb: vi.fn(),
  s3: vi.fn(),
}));

// One stable logger: every line a provider hands it is read back below.
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const logger: Record<string, unknown> = {
    debug: h.debug,
    info: h.info,
    warn: h.warn,
    error: h.error,
    setLevel: vi.fn(),
  };
  logger['child'] = () => logger;
  return { ...(await importOriginal<object>()), getLogger: () => logger };
});

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => {
  const wrap = (send: unknown): unknown => ({
    send,
    config: { region: () => Promise.resolve('us-east-1') },
  });
  return {
    ...(await importOriginal<object>()),
    getAwsClients: () => ({
      cloudWatchLogs: wrap(h.cwl),
      sts: wrap(h.sts),
      // The lookup before a topic create (go-to-k/cdkd#4403): the name is free.
      sns: wrap((command: { constructor: { name: string } }) =>
        command.constructor.name === 'GetTopicAttributesCommand'
          ? Promise.reject(Object.assign(new Error('Topic does not exist'), { name: 'NotFoundException' }))
          : h.sns(command)
      ),
      dynamoDB: wrap(h.ddb),
      lambda: wrap(h.lambda),
      lambdaWeb: wrap(h.lambdaWeb),
      s3: wrap(h.s3),
    }),
  };
});

// The revision create goes through its own client built from the SDK package.
vi.mock('@aws-sdk/client-lambda-web', async (importOriginal) => {
  class LambdaWebClient {
    send = (cmd: unknown): unknown => h.lambdaWeb(cmd);
    config = { region: () => Promise.resolve('us-east-1') };
  }
  return { ...(await importOriginal<object>()), LambdaWebClient };
});

vi.mock('../../../src/provisioning/providers/lambda-web-function-arns.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sleep: () => Promise.resolve(),
}));

// A nested child's destroy reports one failed resource.
vi.mock('../../../src/cli/commands/destroy-runner.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runDestroyForStack: vi.fn(async (stackName: string) => ({
    stackName,
    cancelled: false,
    skippedEmpty: false,
    deletedCount: 1,
    retainedCount: 0,
    skippedCount: 0,
    errorCount: 1,
    interrupted: false,
  })),
}));

import { buildProgram } from '../../../src/cli/program.js';
import { setPasteableRunFlags } from '../../../src/utils/pasteable-run-context.js';
import { differingRemedy } from '../../../src/analyzer/refactor-pairing.js';
import { resolveEcsTaskTarget } from '../../../src/local/ecs-task-resolver/target.js';
import {
  runAgentCoreWatchLoop,
  type AgentCoreWatchInvokeOutcome,
  type RunAgentCoreWatchLoopArgs,
} from '../../../src/local/invoke-agentcore-watch-loop.js';
import type { FileWatcher, ResolvedAgentCoreRuntime } from 'cdk-local/internal';
import type { Synthesizer } from '../../../src/synthesis/synthesizer.js';
import { withGuardDutyDetectorReadBackOps } from '../../../src/provisioning/guardduty-detector-patch.js';
import {
  crDeploySkipTail,
} from '../../../src/provisioning/providers/custom-resource/delete-skip-reasons.js';
import {
  divergentRecordRegionRefusalMessage,
  malformedDestroyOrphansRefusalMessage,
  malformedDestroyResourcesRefusalMessage,
  malformedExportResourcePropertiesRefusalMessage,
} from '../../../src/state/malformed-resources-bag.js';
import { doReleaseLock } from '../../../src/state/lock-manager/release.js';
import { acquireLock } from '../../../src/state/lock-manager/acquire.js';
import { pendingMovesRefusalMessage } from '../../../src/state/pending-moves.js';
import { applyCrossPrefixScan } from '../../../src/state/cross-prefix-stack-scan.js';
import { ExportInUseError, StackHasActiveImportsError } from '../../../src/utils/error-handler.js';
import { ASGProvider } from '../../../src/provisioning/providers/asg-provider.js';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { ServiceDiscoveryProvider } from '../../../src/provisioning/providers/servicediscovery-provider.js';
import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';
import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { FSxFileSystemProvider } from '../../../src/provisioning/providers/fsx-filesystem-provider.js';
import { allowUnscopedCreateTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { PipesPipeProvider } from '../../../src/provisioning/providers/pipes-provider.js';
import { KMSProvider } from '../../../src/provisioning/providers/kms-provider.js';
import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';
import { DocDBProvider } from '../../../src/provisioning/providers/docdb-provider.js';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { LambdaWebFunctionRevisionProvider } from '../../../src/provisioning/providers/lambda-web-function-revision-provider.js';
import { DynamoDBTableProvider } from '../../../src/provisioning/providers/dynamodb-table-provider.js';
import { withStackScopeBeforeStateRead } from '../../../src/provisioning/resource-name/stack-scope.js';
import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';
import { NestedStackProvider } from '../../../src/provisioning/providers/nested-stack-provider.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../../../src/provisioning/nested-stack-context.js';
import { manualBucketDeletionClause } from '../../../src/provisioning/providers/s3-bucket/shared.js';
import { applyBackupReplication } from '../../../src/provisioning/providers/rds/calls.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

/**
 * go-to-k/cdkd#6262, round 2, lane "rest" (provisioning / state / utils /
 * local / analyzer): every `cdkd ...` remedy these files print carries the
 * run's typed `--aws-emulator`, and prints byte-identical text with no flag.
 */
const EMU = 'https://127.0.0.1:4599';
const WITH = `--aws-emulator=${EMU}`;

beforeAll(() => allowUnscopedCreateTokensForTests(true));
afterAll(() => allowUnscopedCreateTokensForTests(false));

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset();
  buildProgram();
  setPasteableRunFlags({});
});
afterEach(() => {
  setPasteableRunFlags({});
  vi.restoreAllMocks();
});

function bothWays(render: () => string): { plain: string; emulated: string } {
  setPasteableRunFlags({});
  const plain = render();
  setPasteableRunFlags({ awsEmulator: EMU });
  const emulated = render();
  setPasteableRunFlags({});
  return { plain, emulated };
}

async function bothWaysAsync(
  render: () => Promise<string>
): Promise<{ plain: string; emulated: string }> {
  setPasteableRunFlags({});
  h.warn.mockClear();
  h.error.mockClear();
  const plain = await render();
  setPasteableRunFlags({ awsEmulator: EMU });
  h.warn.mockClear();
  h.error.mockClear();
  const emulated = await render();
  setPasteableRunFlags({});
  return { plain, emulated };
}

function thrown(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

const lines = (fn: { mock: { calls: unknown[][] } }): string =>
  fn.mock.calls.map((c) => String(c[0])).join('\n');

/** A fake SDK client answering by command class name; an Error value rejects. */
function client(routes: Record<string, unknown>, fallback: unknown = {}): never {
  return {
    send: vi.fn(async (command: { constructor: { name: string }; input?: unknown }) => {
      const route = routes[command.constructor.name];
      const value = typeof route === 'function' ? (route as (c: unknown) => unknown)(command) : route;
      if (value instanceof Error) throw value;
      return value === undefined ? fallback : value;
    }),
    config: { region: () => Promise.resolve('us-east-1') },
  } as never;
}

const awsErr = (name: string, message = name, httpStatusCode = 400): Error =>
  Object.assign(new Error(message), { name, $metadata: { httpStatusCode } });

describe('analyzer / local', () => {
  it('refactor-pairing: differingRemedy names cdkd refactor with the flag', () => {
    const { plain, emulated } = bothWays(() => differingRemedy(['Properties.X']));
    expect(plain).toContain('revert the property change, run cdkd refactor, then deploy');
    expect(emulated).toContain(`revert the property change, run cdkd refactor ${WITH}, then deploy`);
  });

  it('ecs-task-resolver/target: a Lambda given to run-task names cdkd local invoke', () => {
    const stacks = [
      {
        stackName: 'S',
        displayName: 'S',
        template: { Resources: { Fn: { Type: 'AWS::Lambda::Function' } } },
      },
    ] as never;
    const { plain, emulated } = bothWays(() => thrown(() => resolveEcsTaskTarget('S:Fn', stacks)));
    expect(plain).toContain('Use `cdkd local invoke` for Lambda;');
    expect(emulated).toContain(`Use \`cdkd local invoke ${WITH}\` for Lambda;`);
  });

  it('invoke-agentcore-watch-loop: a failed rebuild names the --watch re-run with the flag', async () => {
    const run = async (): Promise<string> => {
      let onChange: ((paths: readonly string[]) => void) | undefined;
      const watcher: FileWatcher = { close: vi.fn(async () => undefined) };
      const invokeOnce = vi
        .fn<RunAgentCoreWatchLoopArgs['invokeOnce']>()
        .mockImplementationOnce(async ({ abortSignal }): Promise<AgentCoreWatchInvokeOutcome> => {
          process.nextTick(() => onChange?.(['/abs/app.py']));
          await new Promise<void>((res) => {
            const bound = setTimeout(res, 300);
            abortSignal.addEventListener('abort', () => {
              clearTimeout(bound);
              res();
            });
          });
          return { pendingReload: abortSignal.aborted };
        })
        .mockImplementation(async () => ({ pendingReload: false }));
      await runAgentCoreWatchLoop({
        containerHost: '127.0.0.1',
        hostPort: 9001,
        options: { output: 'cdk.out' },
        resolvedTarget: 'ChatAgent',
        resolved: {} as ResolvedAgentCoreRuntime,
        synthesizer: {} as Synthesizer,
        synthOpts: {} as never,
        stacks: [],
        invokeOnce,
        rebuild: vi.fn(async () => {
          throw new Error('build failed');
        }),
        softReload: vi.fn(),
        __waitForPing: vi.fn(async () => undefined),
        __watcherFactory: (cb) => {
          onChange = cb;
          return watcher;
        },
        __classifierContext: async () => undefined,
      });
      return lines(h.error);
    };
    const { plain, emulated } = await bothWaysAsync(run);
    expect(plain).toContain('Re-run cdkd local invoke-agentcore --watch to recover.');
    expect(emulated).toContain(`Re-run cdkd local invoke-agentcore --watch ${WITH} to recover.`);
  });
});

describe('provisioning (shared)', () => {
  it('guardduty-detector-patch: an unrevertable Features diff names cdkd drift --accept', () => {
    const live = [
      { Name: 'S3_DATA_EVENTS', Status: 'ENABLED' },
      { Name: 'EBS_MALWARE_PROTECTION', Status: 'ENABLED' },
    ];
    const baseline = [...live].reverse();
    const render = (): string =>
      thrown(() =>
        withGuardDutyDetectorReadBackOps(
          'AWS::GuardDuty::Detector',
          [{ op: 'replace', path: '/Features', value: baseline }],
          { Features: baseline } as never,
          { previous: { Features: live } } as never
        )
      );
    const { plain, emulated } = bothWays(render);
    expect(plain).toContain('reverted. cdkd drift --accept would record the live list');
    expect(emulated).toContain(`reverted. cdkd drift --accept ${WITH} would record the live list`);
  });

  it('custom-resource/delete-skip-reasons: crDeploySkipTail names the deploy flag', () => {
    const { plain, emulated } = bothWays(() => crDeploySkipTail('Cr'));
    expect(plain).toContain("Meanwhile 'cdkd deploy --allow-unaddressed' exits 0");
    expect(emulated).toContain(`Meanwhile 'cdkd deploy --allow-unaddressed ${WITH}' exits 0`);
  });

  it('custom-resource/delete: a mask no coordinate names points at the deploy and the destroy', async () => {
    const SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:Stack-CrHandler';
    const { plain, emulated } = await bothWaysAsync(async () => {
      resetAccountInfoCache();
      h.sts.mockResolvedValue({ Account: '123456789012' });
      await new CustomResourceProvider({ responseBucket: 'test-bucket' }).delete(
        'SeedCr',
        'phys-1',
        'Custom::Seed',
        { ServiceToken: SERVICE_TOKEN, A: SECRET_MASK },
        { stackDestroy: true }
      );
      return lines(h.warn);
    });
    expect(plain).toContain(
      "a 'cdkd deploy' of the app first records which positions hold a NoEcho value, after which 'cdkd destroy' sends the delete."
    );
    expect(emulated).toContain(
      `a 'cdkd deploy ${WITH}' of the app first records which positions hold a NoEcho value, after which 'cdkd destroy ${WITH}' sends the delete.`
    );
  });

  it('s3-bucket/shared: the journaled manual-deletion clause names rollback --revert-failed', () => {
    const { plain, emulated } = bothWays(() => manualBucketDeletionClause('my-bucket', (t) => t, true));
    expect(plain).toContain('records the bucket for `cdkd rollback --revert-failed`;');
    expect(emulated).toContain(`records the bucket for \`cdkd rollback --revert-failed ${WITH}\`;`);
  });

  it('rds/calls: a drift --revert of an encrypted instance names cdkd deploy', async () => {
    const fake = { describeDBInstance: async () => ({ StorageEncrypted: true }) };
    const { plain, emulated } = await bothWaysAsync(async () => {
      try {
        await applyBackupReplication.call(
          fake as never,
          'Db',
          'db-1',
          { stop: false, start: { region: 'us-west-2' } } as never,
          true
        );
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    });
    expect(plain).toMatch(/replication properties and run cdkd deploy$/);
    expect(emulated).toMatch(new RegExp(`replication properties and run cdkd deploy ${WITH}$`));
  });
});

/**
 * The partial-create arms: the create made a resource, its cleanup failed,
 * and the message points at `cdkd rollback --revert-failed`. One row per
 * provider file; the sentence is the same in each.
 */
describe('provider partial-create remedies (cdkd rollback --revert-failed)', () => {
  const REVERT = '`cdkd rollback --revert-failed`';
  const REVERT_WITH = `\`cdkd rollback --revert-failed ${WITH}\``;

  const rows: Array<[string, () => Promise<string>]> = [
    [
      'asg/create.ts',
      async () => {
        const provider = new ASGProvider();
        const asg = client({
          CreateAutoScalingGroupCommand: {},
          EnableMetricsCollectionCommand: awsErr('ValidationError', 'wiring boom'),
          DeleteAutoScalingGroupCommand: awsErr('AccessDenied', 'delete refused'),
          DescribeAutoScalingGroupsCommand: { AutoScalingGroups: [] },
        });
        vi.spyOn(provider, 'getClient').mockReturnValue(asg);
        vi.spyOn(provider, 'getCreateClient').mockReturnValue(asg);
        vi.spyOn(provider, 'getEc2Client').mockReturnValue(client({}, { Reservations: [] }));
        const error = await provider
          .create('Asg', 'AWS::AutoScaling::AutoScalingGroup', {
            AutoScalingGroupName: 'my-asg',
            MinSize: 0,
            MaxSize: 1,
            MetricsCollection: [{ Granularity: '1Minute' }],
          })
          .catch((e: unknown) => e as Error);
        return (error as Error).message;
      },
    ],
    [
      'elbv2/listener.ts',
      async () => {
        const provider = new ELBv2Provider();
        vi.spyOn(provider, 'getClient').mockReturnValue(
          client({
            CreateListenerCommand: { Listeners: [{ ListenerArn: 'arn:aws:elasticloadbalancing:us-east-1:1:listener/app/a/b/c' }] },
            ModifyListenerAttributesCommand: awsErr('ValidationException', 'attribute refused'),
            DeleteListenerCommand: new Error('AccessDenied'),
          })
        );
        await provider
          .create('Listener', 'AWS::ElasticLoadBalancingV2::Listener', {
            LoadBalancerArn: 'arn:aws:elasticloadbalancing:us-east-1:1:loadbalancer/app/a/1',
            Port: 443,
            Protocol: 'HTTPS',
            DefaultActions: [{ Type: 'fixed-response', FixedResponseConfig: { StatusCode: '200' } }],
            ListenerAttributes: [{ Key: 'routing.http.request.x_amzn_mtls_clientcert.header_name', Value: 'x' }],
          })
          .catch(() => undefined);
        return lines(h.warn);
      },
    ],
    [
      'servicediscovery/service.ts',
      async () => {
        const provider = new ServiceDiscoveryProvider();
        vi.spyOn(provider, 'getClient').mockReturnValue(
          client({
            CreateServiceCommand: { Service: { Id: 'srv-1', Arn: 'arn:srv-1', Name: 'mysvc' } },
            UpdateServiceAttributesCommand: awsErr('InvalidInput', 'attribute refused'),
            DeleteServiceCommand: new Error('AccessDenied'),
          })
        );
        await provider
          .create('Svc', 'AWS::ServiceDiscovery::Service', {
            Name: 'mysvc',
            NamespaceId: 'ns-1',
            ServiceAttributes: { token: 'x' },
          })
          .catch(() => undefined);
        return lines(h.warn);
      },
    ],
    [
      'sns-topic/create.ts',
      async () => {
        h.sts.mockResolvedValue({ Account: '123456789012', Arn: 'arn:aws:iam::123456789012:user/u' });
        h.sns.mockImplementation(async (command: { constructor: { name: string } }) => {
          if (command.constructor.name === 'CreateTopicCommand') {
            return { TopicArn: 'arn:aws:sns:us-east-1:123:MyTopic' };
          }
          if (command.constructor.name === 'DeleteTopicCommand') throw new Error('AccessDenied');
          throw new Error('SetTopicAttributes boom');
        });
        await new SNSTopicProvider()
          .create('MyTopic', 'AWS::SNS::Topic', {
            TopicName: 'MyTopic',
            DataProtectionPolicy: { Name: 'test', Statement: [] },
          })
          .catch(() => undefined);
        return lines(h.warn);
      },
    ],
    [
      'logs-loggroup/create.ts',
      async () => {
        h.sts.mockResolvedValue({ Account: '123456789012' });
        h.cwl.mockImplementation(async (command: { constructor: { name: string } }) => {
          if (command.constructor.name === 'CreateLogGroupCommand') return {};
          if (command.constructor.name === 'PutRetentionPolicyCommand') throw new Error('put boom');
          throw new Error('delete boom');
        });
        const error = await new LogsLogGroupProvider()
          .create('MyLG', 'AWS::Logs::LogGroup', { LogGroupName: '/cdkd/lg', RetentionInDays: 7 })
          .catch((e: unknown) => e as Error);
        return `${lines(h.warn)}\n${(error as Error).message}`;
      },
    ],
    [
      'fsx-filesystem/create.ts',
      async () => {
        const provider = new FSxFileSystemProvider({ pollIntervalMs: 0, maxWaitMs: 5000 });
        vi.spyOn(provider, 'getClient').mockReturnValue(
          client({
            CreateFileSystemCommand: {
              FileSystem: { FileSystemId: 'fs-0123456789abcdef0', CreationTime: new Date() },
            },
            DescribeFileSystemsCommand: {
              FileSystems: [
                { FileSystemId: 'fs-0123456789abcdef0', Lifecycle: 'FAILED', FailureDetails: { Message: 'boom' } },
              ],
            },
            DeleteFileSystemCommand: new Error('AccessDenied'),
          })
        );
        await provider
          .create('MyFs', 'AWS::FSx::FileSystem', {
            FileSystemType: 'LUSTRE',
            StorageCapacity: 1200,
            SubnetIds: ['subnet-111'],
            LustreConfiguration: { DeploymentType: 'SCRATCH_2' },
          })
          .catch(() => undefined);
        return lines(h.warn);
      },
    ],
    [
      'pipes/create.ts',
      async () => {
        let clock = 0;
        const provider = new PipesPipeProvider({
          sleep: async (ms: number) => {
            clock += ms;
          },
          now: () => clock,
        });
        const pipes = client({
          CreatePipeCommand: {},
          DescribePipeCommand: { Name: 'my-pipe', CurrentState: 'CREATE_FAILED', CreationTime: new Date() },
          DeletePipeCommand: awsErr('ConflictException', 'busy'),
        });
        vi.spyOn(provider, 'getClient').mockReturnValue(pipes);
        vi.spyOn(provider, 'getCreateClient').mockReturnValue(pipes);
        const error = await provider
          .create('Pipe', 'AWS::Pipes::Pipe', { Name: 'my-pipe', RoleArn: 'r', Source: 's', Target: 't' })
          .catch((e: unknown) => e as Error);
        return (error as Error).message;
      },
    ],
    [
      'kms/key-create.ts',
      async () => {
        const provider = new KMSProvider();
        const kms = client({
          CreateKeyCommand: { KeyMetadata: { KeyId: 'key-001', Arn: 'arn:aws:kms:us-east-1:1:key/key-001' } },
          EnableKeyRotationCommand: awsErr('InternalFailure', 'boom', 500),
        });
        vi.spyOn(provider, 'getClient').mockReturnValue(kms);
        vi.spyOn(provider, 'getCreateClient').mockReturnValue(kms);
        await provider.create('Key', 'AWS::KMS::Key', { EnableKeyRotation: true }).catch(() => undefined);
        return lines(h.warn);
      },
    ],
    [
      'rds/cluster-create.ts',
      async () => {
        const provider = new RDSProvider();
        const rds = client({
          CreateDBClusterCommand: { DBCluster: { DBClusterIdentifier: 'my-cluster-xxx' } },
          DeleteDBClusterCommand: new Error('DeleteDBCluster also failed'),
        });
        vi.spyOn(provider, 'getClient').mockReturnValue(rds);
        vi.spyOn(provider, 'getCreateClient').mockReturnValue(rds);
        (provider as unknown as { waitForClusterAvailable: () => Promise<void> }).waitForClusterAvailable =
          async () => {
            throw new Error('Waiter timed out (original)');
          };
        await provider
          .create('MyCluster', 'AWS::RDS::DBCluster', { DBClusterIdentifier: 'my-cluster-xxx', Engine: 'aurora-mysql' })
          .catch(() => undefined);
        return lines(h.warn);
      },
    ],
    [
      'lambda-web-function-revision-provider.ts',
      async () => {
        const REV_ARN = 'arn:aws:lambda:us-east-1:123456789012:web-function/my-fn/revision/rev-abc12';
        h.lambdaWeb.mockImplementation(async (command: { constructor: { name: string } }) => {
          if (command.constructor.name === 'CreateWebFunctionRevisionCommand') {
            return { revisionArn: REV_ARN, revisionId: 'rev-abc12' };
          }
          if (command.constructor.name === 'GetWebFunctionRevisionCommand') {
            return { state: 'Failed', stateReason: 'build failed', errors: [{ errorCode: 'E1', errorMessage: 'bad zip' }] };
          }
          throw new Error(`unexpected ${command.constructor.name}`);
        });
        await new LambdaWebFunctionRevisionProvider()
          .create('Rev', 'AWS::Lambda::WebFunctionRevision', {
            FunctionName: 'arn:aws:lambda:us-east-1:123456789012:web-function/my-fn',
            BuildConfig: {
              CodeConfig: { S3Object: { Bucket: 'code-bucket', Key: 'app.zip', VersionId: 'v1' } },
              RuntimeConfig: { Runtime: 'nodejs24.x' },
            },
            ServiceConfig: { ExecutionRoleArn: 'arn:aws:iam::123456789012:role/exec', TimeoutSeconds: '30' },
          })
          .catch(() => undefined);
        return lines(h.warn);
      },
    ],
  ];

  it.each(rows)('%s names rollback --revert-failed with the typed flag', async (_file, run) => {
    const { plain, emulated } = await bothWaysAsync(run);
    expect(plain).toContain(REVERT);
    expect(plain).not.toContain('--aws-emulator');
    expect(emulated).toContain(REVERT_WITH);
  });
});

describe('provider remedies (other)', () => {
  it('dynamodb-table/gsi-updates: an adopted index names cdkd drift <STACK> (not the table) and drift --accept', async () => {
    const KEY_SCHEMA = [{ AttributeName: 'gsipk', KeyType: 'HASH' }];
    const PROJECTION = { ProjectionType: 'ALL' };
    const live = {
      TableName: 'my-table',
      TableArn: 'arn:aws:dynamodb:us-east-1:111111111111:table/my-table',
      TableStatus: 'ACTIVE',
      BillingModeSummary: { BillingMode: 'PROVISIONED' },
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: KEY_SCHEMA,
          Projection: PROJECTION,
          IndexStatus: 'ACTIVE',
          ProvisionedThroughput: { NumberOfDecreasesToday: 0, ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
          WarmThroughput: { ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000, Status: 'ACTIVE' },
        },
      ],
    };
    const { plain, emulated } = await bothWaysAsync(async () => {
      h.ddb.mockImplementation(async (cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'UpdateTableCommand' ? {} : { Table: live }
      );
      // A nested child's scope: drift is run on the TOP-LEVEL stack.
      await withStackScopeBeforeStateRead('AppStack~Child', () =>
        new DynamoDBTableProvider().update(
          'L',
          'my-table',
          'AWS::DynamoDB::Table',
          {
            BillingMode: 'PROVISIONED',
            GlobalSecondaryIndexes: [
              {
                IndexName: 'gsi1',
                KeySchema: KEY_SCHEMA,
                Projection: PROJECTION,
                ProvisionedThroughput: { ReadCapacityUnits: 25, WriteCapacityUnits: 5 },
                WarmThroughput: { ReadUnitsPerSecond: 24000, WriteUnitsPerSecond: 8000 },
              },
            ],
          },
          { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [] }
        )
      );
      return lines(h.warn);
    });
    expect(plain).toContain(
      'Run `cdkd drift AppStack` to confirm, and `cdkd drift --accept` if AWS is the source of truth.'
    );
    expect(plain).not.toContain('cdkd drift my-table');
    expect(emulated).toContain(
      `Run \`cdkd drift AppStack ${WITH}\` to confirm, and \`cdkd drift --accept ${WITH}\` if AWS is the source of truth.`
    );
  });

  it('dynamodb-table/index-warnings: a {0, 0} placeholder names cdkd deploy and drift --accept', async () => {
    const KEY_SCHEMA = [{ AttributeName: 'gsipk', KeyType: 'HASH' }];
    const PROJECTION = { ProjectionType: 'ALL' };
    const live = {
      TableName: 'my-table',
      TableArn: 'arn:aws:dynamodb:us-east-1:111111111111:table/my-table',
      TableStatus: 'ACTIVE',
      BillingModeSummary: { BillingMode: 'PROVISIONED' },
      GlobalSecondaryIndexes: [
        {
          IndexName: 'gsi1',
          KeySchema: KEY_SCHEMA,
          Projection: PROJECTION,
          IndexStatus: 'ACTIVE',
          ProvisionedThroughput: { NumberOfDecreasesToday: 0, ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        },
      ],
    };
    const { plain, emulated } = await bothWaysAsync(async () => {
      h.ddb.mockImplementation(async (cmd: { constructor: { name: string } }) =>
        cmd.constructor.name === 'UpdateTableCommand' ? {} : { Table: live }
      );
      await new DynamoDBTableProvider().update(
        'L',
        'my-table',
        'AWS::DynamoDB::Table',
        {
          BillingMode: 'PROVISIONED',
          GlobalSecondaryIndexes: [
            {
              IndexName: 'gsi1',
              KeySchema: KEY_SCHEMA,
              Projection: PROJECTION,
              ProvisionedThroughput: { ReadCapacityUnits: 0, WriteCapacityUnits: 0 },
            },
          ],
        },
        { BillingMode: 'PROVISIONED', GlobalSecondaryIndexes: [] },
        { replayingState: true }
      );
      return lines(h.warn);
    });
    expect(plain).toContain(
      'Re-run `cdkd deploy` (or `cdkd drift --accept`) to refresh the record.'
    );
    expect(emulated).toContain(
      `Re-run \`cdkd deploy ${WITH}\` (or \`cdkd drift --accept ${WITH}\`) to refresh the record.`
    );
  });

  it.each([
    ['rds/cluster-delete.ts', RDSProvider, 'AWS::RDS::DBCluster'],
    ['docdb/cluster-delete.ts', DocDBProvider, 'AWS::DocDB::DBCluster'],
  ] as const)('%s: a protected global member names cdkd destroy --remove-protection', async (_f, Provider, type) => {
    const run = async (): Promise<string> => {
      const provider = new Provider();
      vi.spyOn(provider, 'getClient').mockReturnValue(
        client({
          DescribeDBClustersCommand: {
            DBClusters: [
              { DBClusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:c', Status: 'available', DeletionProtection: true },
            ],
          },
        })
      );
      try {
        await provider.delete('L', 'c', type, { GlobalClusterIdentifier: 'my-global' });
      } catch (error) {
        return (error as Error).message;
      }
      return '';
    };
    const { plain, emulated } = await bothWaysAsync(run);
    expect(plain).toContain('turn it off (cdkd destroy --remove-protection does) and re-run');
    expect(emulated).toContain(
      `turn it off (cdkd destroy --remove-protection ${WITH} does) and re-run`
    );
  });

  it('route53/hosted-zone-delete: a timed-out accelerated-recovery wait names cdkd state destroy', async () => {
    const run = async (): Promise<string> => {
      process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'] = '1';
      process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'] = '1';
      try {
        const provider = new Route53Provider();
        vi.spyOn(provider, 'getClient').mockReturnValue(
          client({
            ListQueryLoggingConfigsCommand: { QueryLoggingConfigs: [] },
            GetHostedZoneCommand: { HostedZone: { Features: { AcceleratedRecoveryStatus: 'ENABLED' } } },
            DeleteHostedZoneCommand: awsErr('AccessDenied'),
          })
        );
        await provider.delete('L', 'Z1234567890', 'AWS::Route53::HostedZone');
      } catch (error) {
        return (error as Error).message;
      } finally {
        delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'];
        delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'];
      }
      return '';
    };
    const { plain, emulated } = await bothWaysAsync(run);
    expect(plain).toContain('re-run `cdkd state destroy` or disable manually via');
    expect(emulated).toContain(`re-run \`cdkd state destroy ${WITH}\` or disable manually via`);
  });

  it('route53/import: an unreadable NameServers names the cdkd import re-run', async () => {
    const { plain, emulated } = await bothWaysAsync(async () => {
      const provider = new Route53Provider();
      vi.spyOn(provider, 'getClient').mockReturnValue(
        client({
          ListHostedZonesByNameCommand: {
            HostedZones: [{ Id: '/hostedzone/ZREMEDY', Name: 'example.com.', Config: { PrivateZone: false } }],
            IsTruncated: false,
          },
          GetHostedZoneCommand: new Error('AccessDenied: route53:GetHostedZone'),
        })
      );
      await provider.import({
        logicalId: 'Zone',
        resourceType: 'AWS::Route53::HostedZone',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: { Name: 'example.com' },
      } as never);
      return lines(h.warn);
    });
    expect(plain).toContain('Re-run `cdkd import --resource Zone=ZREMEDY --force` once the permission');
    expect(emulated).toContain(
      `Re-run \`cdkd import --resource Zone=ZREMEDY --force ${WITH}\` once the permission`
    );
    expect(plain).toContain('a plain `cdkd deploy` does NOT heal');
    expect(emulated).toContain(`a plain \`cdkd deploy ${WITH}\` does NOT heal`);
  });

  it('nested-stack/delete: a failed child names cdkd state show with the flag', async () => {
    const childState = {
      version: 6,
      stackName: 'Parent~Child',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      lastModified: Date.now(),
    };
    const ctx = {
      stateBackend: { getState: vi.fn(async () => ({ state: childState, etag: 'etag-1' })) },
      lockManager: {},
      providerRegistry: {},
      parentStackName: 'Parent',
      parentRegion: 'us-east-1',
      accountId: '123456789012',
      awsClients: {},
      stateBucket: 'cdkd-state-test',
      dagBuilder: {},
      diffCalculator: {},
      options: { concurrency: 1 },
    } as unknown as NestedStackProviderContext;
    const { plain, emulated } = await bothWaysAsync(() =>
      withNestedStackContext(ctx, () =>
        new NestedStackProvider()
          .delete(
            'Child',
            'arn:cdkd-local:us-east-1:123:nested-stack/Parent/Child',
            'AWS::CloudFormation::Stack'
          )
          .then(
            () => '',
            (e: unknown) => (e as Error).message
          )
      )
    );
    expect(plain).toMatch(
      /^Inspect it with: cdkd state show 'Parent~Child' --state-bucket cdkd-state-test$/m
    );
    expect(emulated).toMatch(
      new RegExp(`^Inspect it with: cdkd state show 'Parent~Child' --state-bucket cdkd-state-test ${WITH}$`, 'm')
    );
  });
});

describe('state', () => {
  it('pending-moves: the refusal names cdkd refactor <stack> with the flag', () => {
    const state = {
      pendingMovesOut: [{ from: 'Old', toStack: 'D', toRegion: 'us-east-1', to: 'New', startedAt: 1 }],
    } as never;
    const { plain, emulated } = bothWays(() =>
      pendingMovesRefusalMessage(state, 'S', 'us-east-1', 'cdkd deploy')
    );
    expect(plain).toContain("Run 'cdkd refactor S' to finish the move, then re-run.");
    expect(emulated).toContain(`Run 'cdkd refactor S ${WITH}' to finish the move, then re-run.`);
  });

  it('cross-prefix-stack-scan: the refusals name cdkd state orphan with the flag', () => {
    const subject = { stackName: 'App', region: 'us-east-1', bucket: 'b' } as never;
    const several = bothWays(() =>
      thrown(() =>
        applyCrossPrefixScan({ kind: 'found', prefixes: ['a', 'b'] }, subject, 'deploy', vi.fn())
      )
    );
    expect(several.plain).toContain('release each other record with `cdkd state orphan` (it removes only');
    expect(several.emulated).toContain(
      `release each other record with \`cdkd state orphan ${WITH}\` (it removes only`
    );
    const one = bothWays(() =>
      thrown(() =>
        applyCrossPrefixScan({ kind: 'found', prefixes: ['team-b'] }, subject, 'destroy', vi.fn())
      )
    );
    expect(one.plain).toContain('drop the other record with `cdkd state orphan` (it removes only');
    expect(one.emulated).toContain(
      `drop the other record with \`cdkd state orphan ${WITH}\` (it removes only`
    );
  });

  it('malformed-resources-bag/resources: the destroy refusal names orphan and list --long', () => {
    const { plain, emulated } = bothWays(() =>
      malformedDestroyResourcesRefusalMessage('MyStack', 'us-east-1')
    );
    expect(plain).toContain("run 'cdkd state orphan' against the stack and the region");
    expect(emulated).toContain(`run 'cdkd state orphan ${WITH}' against the stack and the region`);
    expect(plain).toContain("Confirm the key with 'cdkd state list --long' —");
    expect(emulated).toContain(`Confirm the key with 'cdkd state list --long ${WITH}' —`);
  });

  it('malformed-resources-bag/orphans-container: the destroy refusal names orphan and list --long', () => {
    const { plain, emulated } = bothWays(() =>
      malformedDestroyOrphansRefusalMessage('MyStack', 'us-east-1')
    );
    expect(plain).toContain("run 'cdkd state orphan' against the stack and the region");
    expect(emulated).toContain(`run 'cdkd state orphan ${WITH}' against the stack and the region`);
    expect(plain).toContain("Confirm the key with 'cdkd state list --long' —");
    expect(emulated).toContain(`Confirm the key with 'cdkd state list --long ${WITH}' —`);
  });

  it('malformed-resources-bag/account-args: a withheld name points at state list --json', () => {
    const { plain, emulated } = bothWays(() =>
      malformedDestroyResourcesRefusalMessage('My Stack ', 'us-east-1')
    );
    expect(plain).toContain("List the records with 'cdkd state list --json', which prints each name");
    expect(emulated).toContain(
      `List the records with 'cdkd state list --json ${WITH}', which prints each name`
    );
  });

  it('malformed-resources-bag/properties: the export refusal names a selective cdkd import --force', () => {
    const { plain, emulated } = bothWays(() =>
      malformedExportResourcePropertiesRefusalMessage('MyStack', 'us-east-1', ['A'])
    );
    expect(plain).toContain("with a selective 'cdkd import --force', which records");
    expect(emulated).toContain(`with a selective 'cdkd import --force ${WITH}', which records`);
  });

  it('malformed-resources-bag/orphan-refusal: a legacy key with a shell-active name points at state list --json', () => {
    const { plain, emulated } = bothWays(() =>
      malformedExportResourcePropertiesRefusalMessage('a b', undefined, ['A'])
    );
    expect(plain).toContain("take the name from 'cdkd state list --json' and put it there");
    expect(emulated).toContain(
      `take the name from 'cdkd state list --json ${WITH}' and put it there`
    );
  });

  it('malformed-resources-bag/divergent-region: the shared listing pointer names state list --json', () => {
    const { plain, emulated } = bothWays(() =>
      divergentRecordRegionRefusalMessage('My Stack ', 'us-east-1', 'eu-west-1', 2)
    );
    expect(plain).toContain("List the records with 'cdkd state list --json', which prints each name");
    expect(emulated).toContain(
      `List the records with 'cdkd state list --json ${WITH}', which prints each name`
    );
  });

  describe('lock-manager', () => {
    const FORCE = 'cdkd force-unlock';
    const logger = (): { warn: ReturnType<typeof vi.fn>; debug: ReturnType<typeof vi.fn> } => ({
      warn: vi.fn(),
      debug: vi.fn(),
    });
    const held = (over: Record<string, unknown> = {}): never =>
      ({
        key: 'k',
        info: { owner: 'o', timestamp: 1, expiresAt: Date.now() + 60_000 },
        etag: '"e"',
        ...over,
      }) as never;

    const release = async (self: Record<string, unknown>, heldLock: never): Promise<string> => {
      const log = logger();
      await doReleaseLock.call(
        {
          ensureClientForBucket: async () => undefined,
          getLockKey: () => 'k',
          purgeLockVersions: async () => undefined,
          deferReleasePurge: false,
          logger: log,
          ...self,
        } as never,
        'S',
        'us-east-1',
        heldLock
      );
      return lines(log.warn);
    };

    it('release.ts: an unknown etag names force-unlock', async () => {
      const { plain, emulated } = await bothWaysAsync(() =>
        release({ stillOursByBody: async () => false }, held({ etag: undefined }))
      );
      expect(plain).toContain(`or clear it with ${FORCE}.`);
      expect(emulated).toContain(`or clear it with ${FORCE} ${WITH}.`);
    });

    it('release.ts: an uncertain etag on a foreign lock names force-unlock', async () => {
      const { plain, emulated } = await bothWaysAsync(() =>
        release(
          {
            deleteLock: async () => {
              throw new Error('412');
            },
            isForeignLockError: () => true,
          },
          held({ etagUncertain: true })
        )
      );
      expect(plain).toContain(`immediately with ${FORCE}.`);
      expect(emulated).toContain(`immediately with ${FORCE} ${WITH}.`);
    });

    it('release.ts: an unevaluable conditional delete names force-unlock', async () => {
      const { plain, emulated } = await bothWaysAsync(() =>
        release(
          {
            deleteLock: async () => {
              throw new Error('403');
            },
            isForeignLockError: () => false,
            isGoneError: () => false,
            isConditionUnsupportedError: () => true,
            stillOursByBody: async () => false,
          },
          held()
        )
      );
      expect(plain).toContain(`own, or clear it with ${FORCE}. If this repeats`);
      expect(emulated).toContain(`own, or clear it with ${FORCE} ${WITH}. If this repeats`);
    });

    const acquire = async (self: Record<string, unknown>): Promise<string> => {
      const log = logger();
      const result = await acquireLock.call(
        {
          ensureClientForBucket: async () => undefined,
          getLockKey: () => 'k',
          getDefaultOwner: () => 'o',
          ttlMs: 1000,
          logger: log,
          putLockObject: async () => {
            throw new Error('412');
          },
          isForeignLockError: () => true,
          isLockExpired: () => true,
          ...self,
        } as never,
        'S',
        'us-east-1'
      );
      expect(result).toBe(false);
      return lines(log.warn);
    };

    it('acquire.ts: an expired lock with no etag names force-unlock', async () => {
      const { plain, emulated } = await bothWaysAsync(() =>
        acquire({ getLockRecord: async () => ({ info: { owner: 'x', timestamp: 1, expiresAt: 1 }, etag: undefined }) })
      );
      expect(plain).toContain(`Clear it with ${FORCE}.`);
      expect(emulated).toContain(`Clear it with ${FORCE} ${WITH}.`);
    });

    it('acquire.ts: an unevaluable conditional takeover delete names force-unlock', async () => {
      const { plain, emulated } = await bothWaysAsync(() =>
        acquire({
          getLockRecord: async () => ({ info: { owner: 'x', timestamp: 1, expiresAt: 1 }, etag: '"e"' }),
          deleteLock: async () => {
            throw new Error('403');
          },
          isConditionUnsupportedError: () => true,
        })
      );
      expect(plain).toContain(`has since taken. Clear it with ${FORCE}.`);
      expect(emulated).toContain(`has since taken. Clear it with ${FORCE} ${WITH}.`);
    });
  });
});

describe('utils/error-handler/deploy-errors', () => {
  it('ExportInUseError names cdkd state show with the flag', () => {
    const { plain, emulated } = bothWays(
      () =>
        new ExportInUseError('Producer', 'us-east-1', [], {
          unreadable: [{ stackName: 'Consumer', region: 'us-east-1' }],
        }).message
    );
    expect(plain).toContain("(cdkd state show '<stack>'), then retry.");
    expect(emulated).toContain(`(cdkd state show '<stack>' ${WITH}), then retry.`);
  });

  it('StackHasActiveImportsError names cdkd destroy for the consumer with the flag', () => {
    const { plain, emulated } = bothWays(
      () =>
        new StackHasActiveImportsError('P', 'us-east-1', [
          { consumerStack: 'C', consumerRegion: 'us-east-1', exportName: 'E' },
        ] as never).message
    );
    expect(plain).toContain("Destroy the consumer first: cdkd destroy '<consumer-stack>'\n");
    expect(emulated).toContain(
      `Destroy the consumer first: cdkd destroy '<consumer-stack>' ${WITH}\n`
    );
  });
});
