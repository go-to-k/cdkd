/**
 * Issue #2177 — the ECS family's masked log sinks.
 *
 * `ECSProvider.create()` / `update()` now build ONE masked sink set per
 * operation from the context's masker and route every log line, the AWS error
 * text a failure message wraps, and every pasteable command through it. An
 * ECS physical id or ARN embeds the cluster name, task-definition family or
 * service name the template chose, so the sinks also mask a name whose source
 * value is secret-derived (`withDerivedNameMasks`), including a name recorded
 * from a PREVIOUS secret whose plaintext is in no bag of this deploy.
 *
 * Cases assert over the WHOLE transcript (every debug, info and warn line),
 * not one known line. The secrets are sized for the arm each case must
 * isolate:
 *
 *  - `LONG`, which the message-level mask catches: it fences the AWS-echo sites
 *    (a thrown failure), where only routing through the masker removes it;
 *  - `TINY_A` / `TINY_B`, two characters, below the masker's substring floor and
 *    in no fixed wording, so on a cdkd line only the RAW value mask or a
 *    derived-name needle can remove them.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, warnSpy, debugSpy, infoSpy, waitUntilServicesStableMock } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
  infoSpy: vi.fn(),
  waitUntilServicesStableMock: vi.fn(),
}));

vi.mock('@aws-sdk/client-ecs', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    ECSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
    waitUntilServicesStable: waitUntilServicesStableMock,
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: infoSpy,
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import { WITHHELD_AWS_COMMAND } from '../../../src/provisioning/replacement-protection-advice.js';
import {
  hasRedactedCause,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';

/** Long enough for the message-level substring arm. */
const LONG = 'ecs-secret-resource-value';
/** Two-character secrets in no fixed wording: only a RAW value mask or a needle removes them. */
const TINY_A = 'qx';
const TINY_B = 'jv';

const ARN_PREFIX = 'arn:aws:ecs:us-east-1:123456789012';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

const maskSecrets = createSecretMasker(bagOf(LONG, TINY_A, TINY_B));

/** An AWS-authored failure (the marker fields `describeAwsFailure` keys on). */
const awsAuthored = (name: string, message: string, statusCode = 400): Error =>
  Object.assign(new Error(message), {
    name,
    $fault: statusCode >= 500 ? 'server' : 'client',
    $metadata: { httpStatusCode: statusCode, requestId: 'req-0123456789' },
  });

const echo = (value = LONG): Error =>
  awsAuthored('InvalidParameterException', `Invalid value '${value}' for the request`);
/** The same text with only the secret masked: the diagnosis must survive the mask. */
const MASKED_ECHO = `Invalid value '${SECRET_MASK}' for the request`;

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

/** Every debug, info and warn line the provider wrote, joined. */
const transcript = (): string =>
  [...debugSpy.mock.calls, ...infoSpy.mock.calls, ...warnSpy.mock.calls]
    .map((args) => String(args[0]))
    .join('\n');

type Handler = (input: Record<string, unknown>) => unknown;

/** A fake ECS answering by command name; an absent handler answers `{}`. */
function fakeEcs(handlers: Record<string, Handler>): void {
  mockSend.mockImplementation(async (command: { input: Record<string, unknown> }) => {
    const handler = handlers[commandName(command)];
    return handler ? handler(command.input) : {};
  });
}

const throwing =
  (error: Error): Handler =>
  () => {
    throw error;
  };

async function thrownMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the operation to throw');
}

const clusterArn = (name: string): string => `${ARN_PREFIX}:cluster/${name}`;
const serviceArn = (cluster: string, name: string): string =>
  `${ARN_PREFIX}:service/${cluster}/${name}`;

describe('ECSProvider masked log sinks (issue #2177)', () => {
  let provider: ECSProvider;
  let savedFullWait: string | undefined;

  beforeEach(() => {
    mockSend.mockReset();
    warnSpy.mockReset();
    debugSpy.mockReset();
    infoSpy.mockReset();
    waitUntilServicesStableMock.mockReset();
    savedFullWait = process.env['CDKD_FULL_WAIT'];
    delete process.env['CDKD_FULL_WAIT'];
    provider = new ECSProvider();
  });

  afterEach(() => {
    if (savedFullWait === undefined) delete process.env['CDKD_FULL_WAIT'];
    else process.env['CDKD_FULL_WAIT'] = savedFullWait;
  });

  describe('a secret-derived name on cdkd lines', () => {
    it('create() Cluster: the cluster name inside the success line ARN', async () => {
      fakeEcs({ CreateClusterCommand: () => ({ cluster: { clusterArn: clusterArn(TINY_A) } }) });
      const result = await provider.create(
        'Clu',
        'AWS::ECS::Cluster',
        { ClusterName: TINY_A },
        { maskSecrets }
      );
      expect(result.physicalId).toBe(TINY_A);
      const lines = transcript();
      expect(lines).toContain(
        `Successfully created ECS cluster Clu: ${ARN_PREFIX}:cluster/${SECRET_MASK}`
      );
      expect(lines).not.toContain(TINY_A);
    });

    it('create() TaskDefinition: the family inside the success line ARN', async () => {
      fakeEcs({
        RegisterTaskDefinitionCommand: () => ({
          taskDefinition: { taskDefinitionArn: `${ARN_PREFIX}:task-definition/${TINY_A}:1` },
        }),
      });
      await provider.create(
        'Td',
        'AWS::ECS::TaskDefinition',
        { Family: TINY_A, ContainerDefinitions: [{ Name: 'app', Image: 'nginx' }] },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(
        `Successfully created ECS task definition Td: ${ARN_PREFIX}:task-definition/${SECRET_MASK}:1`
      );
      expect(lines).not.toContain(TINY_A);
    });

    it('create() Service: the names in the ARN, and the INFO wait command is withheld', async () => {
      fakeEcs({
        CreateServiceCommand: () => ({
          service: { serviceArn: serviceArn(TINY_B, TINY_A), serviceName: TINY_A },
        }),
      });
      await provider.create(
        'Svc',
        'AWS::ECS::Service',
        { Cluster: TINY_B, ServiceName: TINY_A, TaskDefinition: 'td:1' },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(
        `Successfully created ECS service Svc: ${ARN_PREFIX}:service/${SECRET_MASK}/${SECRET_MASK}`
      );
      const info = infoSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(info).toContain('ECS service Svc accepted');
      expect(info).toContain(WITHHELD_AWS_COMMAND);
      expect(lines).not.toContain(TINY_A);
      expect(lines).not.toContain(TINY_B);
    });

    it('create() Service: a Cluster ARN masks the cluster name the service ARN embeds', async () => {
      fakeEcs({
        CreateServiceCommand: () => ({
          service: { serviceArn: serviceArn(TINY_B, 'web'), serviceName: 'web' },
        }),
      });
      // The whole ARN is the secret-derived value (it embeds `TINY_B`); only
      // the cluster-name pair reaches the bare segment in the service ARN.
      const clusterRef = clusterArn(TINY_B);
      const masker = (text: string): string =>
        maskSecrets(text).replaceAll(clusterRef, SECRET_MASK);
      await provider.create(
        'Svc',
        'AWS::ECS::Service',
        { Cluster: clusterRef, ServiceName: 'web', TaskDefinition: 'td:1' },
        { maskSecrets: masker }
      );
      const lines = transcript();
      expect(lines).toContain(
        `Successfully created ECS service Svc: ${ARN_PREFIX}:service/${SECRET_MASK}/web`
      );
      expect(lines).not.toContain(TINY_B);
    });

    it('update() Cluster: the name on every line and inside the tag lines ARN', async () => {
      fakeEcs({
        DescribeClustersCommand: () => ({ clusters: [{ clusterArn: clusterArn(TINY_A) }] }),
      });
      await provider.update(
        'Clu',
        TINY_A,
        'AWS::ECS::Cluster',
        {
          ClusterName: TINY_A,
          CapacityProviders: ['FARGATE'],
          ClusterSettings: [{ Name: 'containerInsights', Value: 'enabled' }],
          Tags: [{ Key: 'team', Value: 'core' }],
        },
        { ClusterName: TINY_A, Tags: [{ Key: 'old', Value: 'gone' }] },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(`Updating ECS cluster Clu: ${SECRET_MASK}`);
      expect(lines).toContain(`Updated capacity providers for ECS cluster ${SECRET_MASK}`);
      expect(lines).toContain(`Updated ECS cluster ${SECRET_MASK} (settings=true`);
      expect(lines).toContain(
        `Added/updated 1 tag(s) on ECS resource ${ARN_PREFIX}:cluster/${SECRET_MASK}`
      );
      expect(lines).toContain(`Removed 1 tag(s) from ECS resource ${ARN_PREFIX}:cluster/${SECRET_MASK}`);
      expect(lines).not.toContain(TINY_A);
    });

    it('update() Service: the names in the recorded ARN and in the INFO command', async () => {
      const arn = serviceArn(TINY_B, TINY_A);
      fakeEcs({
        UpdateServiceCommand: () => ({ service: { serviceArn: arn, serviceName: TINY_A } }),
      });
      await provider.update(
        'Svc',
        arn,
        'AWS::ECS::Service',
        {
          Cluster: TINY_B,
          ServiceName: TINY_A,
          DesiredCount: 2,
          Tags: [{ Key: 'team', Value: 'core' }],
        },
        { Cluster: TINY_B, ServiceName: TINY_A, DesiredCount: 1 },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(
        `Updating ECS service Svc: ${ARN_PREFIX}:service/${SECRET_MASK}/${SECRET_MASK}`
      );
      expect(lines).toContain(
        `Added/updated 1 tag(s) on ECS resource ${ARN_PREFIX}:service/${SECRET_MASK}/${SECRET_MASK}`
      );
      expect(infoSpy.mock.calls.map((a) => String(a[0])).join('\n')).toContain(
        WITHHELD_AWS_COMMAND
      );
      expect(lines).not.toContain(TINY_A);
      expect(lines).not.toContain(TINY_B);
    });

    it('update() Service: a non-ECS controller refusal masks the controller type RAW', async () => {
      const message = await thrownMessage(
        provider.update(
          'Svc',
          serviceArn('c1', 'web'),
          'AWS::ECS::Service',
          {
            Cluster: 'c1',
            DeploymentController: { Type: TINY_A },
            LoadBalancers: [{ ContainerName: 'app', ContainerPort: 80 }],
          },
          { Cluster: 'c1', DeploymentController: { Type: TINY_A } },
          { maskSecrets }
        )
      );
      expect(message).toContain(`under the '${SECRET_MASK}' deployment controller`);
      expect(message).not.toContain(TINY_A);
    });

    it('no context: lines print unmasked (back-compat, absent means identity)', async () => {
      fakeEcs({ CreateClusterCommand: () => ({ cluster: { clusterArn: clusterArn(TINY_A) } }) });
      await provider.create('Clu', 'AWS::ECS::Cluster', { ClusterName: TINY_A });
      expect(transcript()).toContain(`Successfully created ECS cluster Clu: ${clusterArn(TINY_A)}`);
    });

    it('an ordinary name renders unchanged (negative control)', async () => {
      const arn = serviceArn('prod-cluster', 'web');
      fakeEcs({
        DescribeClustersCommand: () => ({ clusters: [{ clusterArn: clusterArn('prod-cluster') }] }),
        UpdateServiceCommand: () => ({ service: { serviceArn: arn, serviceName: 'web' } }),
      });
      await provider.update(
        'Clu',
        'prod-cluster',
        'AWS::ECS::Cluster',
        { ClusterName: 'prod-cluster', CapacityProviders: ['FARGATE'] },
        { ClusterName: 'prod-cluster' },
        { maskSecrets }
      );
      await provider.update(
        'Svc',
        arn,
        'AWS::ECS::Service',
        { Cluster: 'prod-cluster', ServiceName: 'web', DesiredCount: 2 },
        { Cluster: 'prod-cluster', ServiceName: 'web', DesiredCount: 1 },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain('Updating ECS cluster Clu: prod-cluster');
      expect(lines).toContain(`Updating ECS service Svc: ${arn}`);
      expect(lines).toContain(
        'aws ecs wait services-stable --cluster prod-cluster --services web'
      );
      expect(lines).not.toContain(SECRET_MASK);
    });
  });

  describe('AWS text quoting a request value back', () => {
    const cases: Array<{
      label: string;
      prefix: string;
      failingCommand: string;
      run: (p: ECSProvider) => Promise<unknown>;
    }> = [
      {
        label: 'create() Cluster',
        prefix: 'Failed to create ECS cluster Clu:',
        failingCommand: 'CreateClusterCommand',
        run: (p) =>
          p.create('Clu', 'AWS::ECS::Cluster', { ClusterName: LONG }, { maskSecrets }),
      },
      {
        label: 'update() Cluster',
        prefix: 'Failed to update ECS cluster Clu:',
        failingCommand: 'PutClusterCapacityProvidersCommand',
        run: (p) =>
          p.update(
            'Clu',
            'c1',
            'AWS::ECS::Cluster',
            { CapacityProviders: [LONG] },
            {},
            { maskSecrets }
          ),
      },
      {
        label: 'create() TaskDefinition',
        prefix: 'Failed to create ECS task definition Td:',
        failingCommand: 'RegisterTaskDefinitionCommand',
        run: (p) =>
          p.create(
            'Td',
            'AWS::ECS::TaskDefinition',
            { Family: 'fam', ExecutionRoleArn: LONG },
            { maskSecrets }
          ),
      },
      {
        label: 'create() Service',
        prefix: 'Failed to create ECS service Svc:',
        failingCommand: 'CreateServiceCommand',
        run: (p) =>
          p.create(
            'Svc',
            'AWS::ECS::Service',
            { Cluster: 'c1', ServiceName: 'web', TaskDefinition: LONG },
            { maskSecrets }
          ),
      },
      {
        label: 'update() Service',
        prefix: 'Failed to update ECS service Svc:',
        failingCommand: 'UpdateServiceCommand',
        run: (p) =>
          p.update(
            'Svc',
            serviceArn('c1', 'web'),
            'AWS::ECS::Service',
            { Cluster: 'c1', TaskDefinition: LONG },
            { Cluster: 'c1' },
            { maskSecrets }
          ),
      },
    ];

    for (const c of cases) {
      it(`${c.label} failure message`, async () => {
        fakeEcs({ [c.failingCommand]: throwing(echo()) });
        const message = await thrownMessage(c.run(provider));
        expect(message).toContain(c.prefix);
        expect(message).not.toContain(LONG);
        expect(message).toContain(MASKED_ECHO);
      });
    }

    it('create() Service: a short secret name AWS echoes back is masked by the needle', async () => {
      fakeEcs({
        CreateServiceCommand: throwing(
          awsAuthored('InvalidParameterException', `Creation of service was not idempotent: ${TINY_A}`)
        ),
      });
      const message = await thrownMessage(
        provider.create(
          'Svc',
          'AWS::ECS::Service',
          { Cluster: 'c1', ServiceName: TINY_A, TaskDefinition: 'td:1' },
          { maskSecrets }
        )
      );
      expect(message).toContain(`Creation of service was not idempotent: ${SECRET_MASK}`);
      expect(message).not.toContain(TINY_A);
    });

    it('update() Service: a malformed DeploymentController refusal goes through the masker', async () => {
      const message = await thrownMessage(
        provider.update(
          'Svc',
          serviceArn('c1', 'web'),
          'AWS::ECS::Service',
          { Cluster: 'c1', DeploymentController: LONG },
          { Cluster: 'c1' },
          { maskSecrets: (text) => maskSecrets(text).replaceAll('DeploymentController', 'DC') }
        )
      );
      // The refusal is cdkd text about the block; reaching the masker is the
      // property under test, observed through a masker that rewrites a word.
      expect(message).toContain('AWS::ECS::Service DC must be an object');
    });

    it('create() Service under --full-wait: the successful cleanup warning masks the ARN', async () => {
      process.env['CDKD_FULL_WAIT'] = 'true';
      waitUntilServicesStableMock.mockRejectedValue(new Error('Waiter has timed out'));
      fakeEcs({
        CreateServiceCommand: () => ({
          service: { serviceArn: serviceArn(TINY_B, TINY_A), serviceName: TINY_A },
        }),
      });
      await thrownMessage(
        provider.create(
          'Svc',
          'AWS::ECS::Service',
          { Cluster: TINY_B, ServiceName: TINY_A, TaskDefinition: 'td:1' },
          { maskSecrets }
        )
      );
      const warned = warnSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(warned).toContain(
        `Deleted partially-created ECS service Svc (${ARN_PREFIX}:service/${SECRET_MASK}/${SECRET_MASK})`
      );
      expect(warned).toContain(WITHHELD_AWS_COMMAND);
      expect(warned).not.toContain(TINY_A);
      expect(warned).not.toContain(TINY_B);
    });

    it('create() Service under --full-wait: cleanup warning and wait failure, commands withheld', async () => {
      process.env['CDKD_FULL_WAIT'] = 'true';
      waitUntilServicesStableMock.mockRejectedValue(new Error('Waiter has timed out'));
      fakeEcs({
        CreateServiceCommand: () => ({
          service: { serviceArn: serviceArn(TINY_B, TINY_A), serviceName: TINY_A },
        }),
        DeleteServiceCommand: throwing(echo()),
      });
      const message = await thrownMessage(
        provider.create(
          'Svc',
          'AWS::ECS::Service',
          { Cluster: TINY_B, ServiceName: TINY_A, TaskDefinition: 'td:1' },
          { maskSecrets }
        )
      );
      const warned = warnSpy.mock.calls.map((args) => String(args[0])).join('\n');
      expect(warned).toContain(
        `Failed to clean up partially-created ECS service Svc (${ARN_PREFIX}:service/${SECRET_MASK}/${SECRET_MASK}):`
      );
      expect(warned).toContain(MASKED_ECHO);
      expect(warned).toContain(WITHHELD_AWS_COMMAND);
      expect(message).toContain('did not reach steady state under --full-wait');
      expect(message).toContain(WITHHELD_AWS_COMMAND);
      for (const text of [warned, message, transcript()]) {
        expect(text).not.toContain(LONG);
        expect(text).not.toContain(TINY_A);
        expect(text).not.toContain(TINY_B);
      }
    });
  });

  describe('only the DESIRED side names the secret', () => {
    // No previous name was recorded (state carries none), so only the desired
    // side's pair can make the physical id a needle. The two-character secrets
    // sit below the base masker's substring floor, so inside an ARN or an AWS
    // echo only that needle removes them.
    it('update() Cluster: the name inside the tag lines ARN and an AWS echo', async () => {
      fakeEcs({
        DescribeClustersCommand: () => ({ clusters: [{ clusterArn: clusterArn(TINY_A) }] }),
        TagResourceCommand: throwing(
          awsAuthored('ClusterNotFoundException', `Cluster not found: ${TINY_A}`)
        ),
      });
      const message = await thrownMessage(
        provider.update(
          'Clu',
          TINY_A,
          'AWS::ECS::Cluster',
          { ClusterName: TINY_A, Tags: [{ Key: 'team', Value: 'core' }] },
          {},
          { maskSecrets }
        )
      );
      expect(message).toContain(`Cluster not found: ${SECRET_MASK}`);
      expect(`${message}\n${transcript()}`).not.toContain(TINY_A);
    });

    it('update() Service: the names inside the recorded ARN and the INFO command', async () => {
      const arn = serviceArn(TINY_B, TINY_A);
      fakeEcs({
        UpdateServiceCommand: () => ({ service: { serviceArn: arn, serviceName: TINY_A } }),
      });
      await provider.update(
        'Svc',
        arn,
        'AWS::ECS::Service',
        { Cluster: TINY_B, ServiceName: TINY_A, DesiredCount: 2 },
        { DesiredCount: 1 },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(
        `Updating ECS service Svc: ${ARN_PREFIX}:service/${SECRET_MASK}/${SECRET_MASK}`
      );
      expect(lines).toContain(WITHHELD_AWS_COMMAND);
      expect(lines).not.toContain(TINY_A);
      expect(lines).not.toContain(TINY_B);
    });

    it('update() Service whose RECORDED ServiceName is the reference: the lines past the ServiceName guard are masked (go-to-k/cdkd#4263)', async () => {
      // Before go-to-k/cdkd#4263 the guard refused this shape (desired
      // plaintext, recorded reference) before any line below it ran.
      const arn = serviceArn(TINY_B, TINY_A);
      fakeEcs({
        UpdateServiceCommand: () => ({ service: { serviceArn: arn, serviceName: TINY_A } }),
      });
      await provider.update(
        'Svc',
        arn,
        'AWS::ECS::Service',
        { Cluster: TINY_B, ServiceName: TINY_A, DesiredCount: 2 },
        {
          Cluster: TINY_B,
          ServiceName: `{{resolve:secretsmanager:svc:SecretString:name}}`,
          DesiredCount: 1,
        },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(WITHHELD_AWS_COMMAND);
      expect(lines).not.toContain(TINY_A);
      expect(lines).not.toContain(TINY_B);
    });
  });

  describe('the desired Cluster value itself', () => {
    it('update() Service: a short secret Cluster AWS echoes back, with no cluster in the ARN', async () => {
      // A legacy short-format service ARN carries no cluster name, so only the
      // desired Cluster value's own pair makes it a needle for the echo.
      fakeEcs({
        UpdateServiceCommand: throwing(
          awsAuthored('ClusterNotFoundException', `Cluster not found: ${TINY_B}`)
        ),
      });
      const message = await thrownMessage(
        provider.update(
          'Svc',
          `${ARN_PREFIX}:service/web`,
          'AWS::ECS::Service',
          { Cluster: TINY_B, DesiredCount: 2 },
          { DesiredCount: 1 },
          { maskSecrets }
        )
      );
      expect(message).toContain(`Cluster not found: ${SECRET_MASK}`);
      expect(`${message}\n${transcript()}`).not.toContain(TINY_B);
    });
  });

  describe('a rotated secret the desired side names', () => {
    it('update() Service: the OLD cluster name inside the recorded ARN', async () => {
      // The desired `Cluster` resolves to the NEW plaintext (in this deploy's
      // bag) while the recorded ARN still embeds the OLD name, which is in no
      // bag; no previous value was recorded. Only the desired value paired
      // with the recorded cluster name removes it.
      const OLD_CLUSTER = 'old-rotated-cluster';
      const arn = serviceArn(OLD_CLUSTER, 'web');
      fakeEcs({
        UpdateServiceCommand: () => ({ service: { serviceArn: arn, serviceName: 'web' } }),
      });
      await provider.update(
        'Svc',
        arn,
        'AWS::ECS::Service',
        { Cluster: LONG, DesiredCount: 2 },
        { DesiredCount: 1 },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(`Updating ECS service Svc: ${ARN_PREFIX}:service/${SECRET_MASK}/web`);
      expect(lines).not.toContain(OLD_CLUSTER);
    });
  });

  describe('a masked failure still classifies as retryable (issue #4244 class)', () => {
    /** A secret spelling part of the retry table's `does not exist` wording. */
    const RETRY_WORD = 'exist';
    const retryMasker = createSecretMasker(bagOf(RETRY_WORD));
    const TRANSIENT = 'Resource xyz does not exist';
    const retryable = (error: Error): boolean =>
      isRetryableTransientError(error, retryClassificationText(error));

    async function thrown(promise: Promise<unknown>): Promise<Error> {
      try {
        await promise;
      } catch (error) {
        return error as Error;
      }
      throw new Error('expected the operation to throw');
    }

    type Masker = (text: string) => string;
    const sites: Array<{
      label: string;
      prefix: string;
      failingCommand: string;
      run: (p: ECSProvider, mask: Masker) => Promise<unknown>;
    }> = [
      {
        label: 'create() Cluster',
        prefix: 'Failed to create ECS cluster Clu:',
        failingCommand: 'CreateClusterCommand',
        run: (p, mask) =>
          p.create('Clu', 'AWS::ECS::Cluster', { ClusterName: 'c1' }, { maskSecrets: mask }),
      },
      {
        label: 'update() Cluster',
        prefix: 'Failed to update ECS cluster Clu:',
        failingCommand: 'PutClusterCapacityProvidersCommand',
        run: (p, mask) =>
          p.update(
            'Clu',
            'c1',
            'AWS::ECS::Cluster',
            { CapacityProviders: ['FARGATE'] },
            {},
            { maskSecrets: mask }
          ),
      },
      {
        label: 'create() TaskDefinition',
        prefix: 'Failed to create ECS task definition Td:',
        failingCommand: 'RegisterTaskDefinitionCommand',
        run: (p, mask) =>
          p.create('Td', 'AWS::ECS::TaskDefinition', { Family: 'fam' }, { maskSecrets: mask }),
      },
      {
        label: 'create() Service',
        prefix: 'Failed to create ECS service Svc:',
        failingCommand: 'CreateServiceCommand',
        run: (p, mask) =>
          p.create(
            'Svc',
            'AWS::ECS::Service',
            { Cluster: 'c1', ServiceName: 'web', TaskDefinition: 'td:1' },
            { maskSecrets: mask }
          ),
      },
      {
        label: 'update() Service',
        prefix: 'Failed to update ECS service Svc:',
        failingCommand: 'UpdateServiceCommand',
        run: (p, mask) =>
          p.update(
            'Svc',
            serviceArn('c1', 'web'),
            'AWS::ECS::Service',
            { Cluster: 'c1', DesiredCount: 2 },
            { Cluster: 'c1', DesiredCount: 1 },
            { maskSecrets: mask }
          ),
      },
    ];

    for (const c of sites) {
      it(`${c.label}: the stamp keeps it retryable`, async () => {
        fakeEcs({ [c.failingCommand]: throwing(new Error(TRANSIENT)) });
        const failure = await thrown(c.run(provider, retryMasker));
        expect(failure.message).toContain(c.prefix);
        // Premise: the mask cut the retry wording out of the message itself.
        expect(failure.message).not.toContain('does not exist');
        expect(isRetryableTransientError(failure, failure.message)).toBe(false);
        expect(hasRedactedCause(failure)).toBe(true);
        expect(retryable(failure)).toBe(true);
      });

      it(`${c.label}: a failure the mask left unchanged is not stamped`, async () => {
        fakeEcs({ [c.failingCommand]: throwing(new Error('Bad request parameter')) });
        const failure = await thrown(c.run(provider, retryMasker));
        expect(failure.message).toContain(`${c.prefix} Bad request parameter`);
        expect(hasRedactedCause(failure)).toBe(false);
        expect(retryable(failure)).toBe(false);
      });
    }

    it('update() Cluster: a derived-name needle cutting the wording is stamped too', async () => {
      // `not` is a secret-derived cluster name below the base masker's
      // substring floor, so only the operation's needle removes it -- and with
      // it the `does not exist` wording the retry table keys on.
      fakeEcs({ PutClusterCapacityProvidersCommand: throwing(new Error(TRANSIENT)) });
      const failure = await thrown(
        provider.update(
          'Clu',
          'not',
          'AWS::ECS::Cluster',
          { ClusterName: 'not', CapacityProviders: ['FARGATE'] },
          {},
          { maskSecrets: createSecretMasker(bagOf('not')) }
        )
      );
      expect(failure.message).toContain(`does ${SECRET_MASK} exist`);
      expect(isRetryableTransientError(failure, failure.message)).toBe(false);
      expect(hasRedactedCause(failure)).toBe(true);
      expect(retryable(failure)).toBe(true);
    });

    it('update() Service: a masked DeploymentController refusal is stamped', async () => {
      const failure = await thrown(
        provider.update(
          'Svc',
          serviceArn('c1', 'web'),
          'AWS::ECS::Service',
          { Cluster: 'c1', DeploymentController: 'x' },
          { Cluster: 'c1' },
          { maskSecrets: (text) => text.replaceAll('DeploymentController', 'DC') }
        )
      );
      expect(failure.message).toContain('AWS::ECS::Service DC must be an object');
      expect(hasRedactedCause(failure)).toBe(true);
    });
  });

  describe('a name recorded from a PREVIOUS secret', () => {
    // A rotated or re-pointed secret: state recorded the PREVIOUS name as its
    // reference, so the redacted diff sees no name change and routes the
    // deploy to update(). The physical id carries the OLD plaintext, which is
    // in no bag of this deploy, so the base masker alone cannot recognise it.
    const OLD_NAME = 'old-secret-cluster-name';

    it('update() Cluster: the recorded name on every line and in an AWS echo', async () => {
      fakeEcs({ PutClusterCapacityProvidersCommand: throwing(echo(OLD_NAME)) });
      const message = await thrownMessage(
        provider.update(
          'Clu',
          OLD_NAME,
          'AWS::ECS::Cluster',
          { ClusterName: LONG, CapacityProviders: ['FARGATE'] },
          { ClusterName: '{{resolve:secretsmanager:cluster-name}}' },
          { maskSecrets }
        )
      );
      expect(message).toContain(MASKED_ECHO);
      expect(message).not.toContain(OLD_NAME);
      expect(transcript()).toContain(`Updating ECS cluster Clu: ${SECRET_MASK}`);
      expect(transcript()).not.toContain(OLD_NAME);
    });

    it('update() Cluster: a recorded *** previous name counts as secret-derived (backstop)', async () => {
      fakeEcs({});
      await provider.update(
        'Clu',
        OLD_NAME,
        'AWS::ECS::Cluster',
        { ClusterName: OLD_NAME, CapacityProviders: ['FARGATE'] },
        { ClusterName: SECRET_MASK },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(`Updated capacity providers for ECS cluster ${SECRET_MASK}`);
      expect(lines).not.toContain(OLD_NAME);
    });

    it('update() Service: a legacy short-format ARN still yields the recorded service name', async () => {
      const OLD_SERVICE = 'old-secret-short-service';
      const arn = `${ARN_PREFIX}:service/${OLD_SERVICE}`;
      fakeEcs({ UpdateServiceCommand: throwing(echo(OLD_SERVICE)) });
      const message = await thrownMessage(
        provider.update(
          'Svc',
          arn,
          'AWS::ECS::Service',
          { DesiredCount: 2 },
          { ServiceName: '{{resolve:secretsmanager:service}}', DesiredCount: 1 },
          { maskSecrets }
        )
      );
      expect(message).toContain(MASKED_ECHO);
      expect(transcript()).toContain(`Updating ECS service Svc: ${ARN_PREFIX}:service/${SECRET_MASK}`);
      expect(`${message}\n${transcript()}`).not.toContain(OLD_SERVICE);
    });

    it('update() Service: the composite <clusterArn>|<serviceName> id yields both recorded names', async () => {
      const OLD_SERVICE = 'old-secret-composite-svc';
      const OLD_CLUSTER = 'old-secret-composite-cl';
      const id = `${clusterArn(OLD_CLUSTER)}|${OLD_SERVICE}`;
      fakeEcs({ UpdateServiceCommand: throwing(echo(`${OLD_CLUSTER}/${OLD_SERVICE}`)) });
      const message = await thrownMessage(
        provider.update(
          'Svc',
          id,
          'AWS::ECS::Service',
          { DesiredCount: 2 },
          {
            Cluster: '{{resolve:secretsmanager:cluster}}',
            ServiceName: '{{resolve:secretsmanager:service}}',
            DesiredCount: 1,
          },
          { maskSecrets }
        )
      );
      const all = `${message}\n${transcript()}`;
      expect(transcript()).toContain(
        `Updating ECS service Svc: ${ARN_PREFIX}:cluster/${SECRET_MASK}|${SECRET_MASK}`
      );
      expect(all).not.toContain(OLD_SERVICE);
      expect(all).not.toContain(OLD_CLUSTER);
    });

    it('update() Service: a bare service-name physical id is its own recorded name', async () => {
      const OLD_SERVICE = 'old-secret-bare-service';
      fakeEcs({ UpdateServiceCommand: throwing(echo(OLD_SERVICE)) });
      const message = await thrownMessage(
        provider.update(
          'Svc',
          OLD_SERVICE,
          'AWS::ECS::Service',
          { DesiredCount: 2 },
          { ServiceName: '{{resolve:secretsmanager:service}}', DesiredCount: 1 },
          { maskSecrets }
        )
      );
      expect(message).toContain(MASKED_ECHO);
      expect(transcript()).toContain(`Updating ECS service Svc: ${SECRET_MASK}`);
      expect(`${message}\n${transcript()}`).not.toContain(OLD_SERVICE);
    });

    it('update() Service: a recorded service and cluster name from previous references', async () => {
      const OLD_SERVICE = 'old-secret-service-name';
      const OLD_CLUSTER = 'old-secret-cluster';
      const arn = serviceArn(OLD_CLUSTER, OLD_SERVICE);
      fakeEcs({
        UpdateServiceCommand: () => ({ service: { serviceArn: arn, serviceName: OLD_SERVICE } }),
      });
      // The desired side omits ServiceName so the immutable-name guard does
      // not fire; only the previous references name the recorded values.
      await provider.update(
        'Svc',
        arn,
        'AWS::ECS::Service',
        { Cluster: OLD_CLUSTER, DesiredCount: 2 },
        {
          Cluster: '{{resolve:secretsmanager:cluster}}',
          ServiceName: '{{resolve:secretsmanager:service}}',
          DesiredCount: 1,
        },
        { maskSecrets }
      );
      const lines = transcript();
      expect(lines).toContain(
        `Updating ECS service Svc: ${ARN_PREFIX}:service/${SECRET_MASK}/${SECRET_MASK}`
      );
      expect(lines).toContain(WITHHELD_AWS_COMMAND);
      expect(lines).not.toContain(OLD_SERVICE);
      expect(lines).not.toContain(OLD_CLUSTER);
    });
  });
});
