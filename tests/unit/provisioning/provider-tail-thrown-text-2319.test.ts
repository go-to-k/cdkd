import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// One shared `send` for every service: each case fails exactly one command by
// name, so a provider can share it without a per-client mock.
const { mockSend, debug, client } = vi.hoisted(() => {
  const send = vi.fn();
  return {
    mockSend: send,
    debug: vi.fn(),
    client: (): unknown => ({
      send,
      config: { region: () => Promise.resolve('us-east-1') },
      middlewareStack: { add: vi.fn(), addRelativeTo: vi.fn() },
    }),
  };
});

vi.mock('@aws-sdk/client-ecr', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  ECRClient: vi.fn().mockImplementation(client),
}));
vi.mock('@aws-sdk/client-sfn', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  SFNClient: vi.fn().mockImplementation(client),
}));
vi.mock('@aws-sdk/client-wafv2', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  WAFV2Client: vi.fn().mockImplementation(client),
}));
vi.mock('@aws-sdk/client-codebuild', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  CodeBuildClient: vi.fn().mockImplementation(client),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sqs: client(), sns: client(), sts: client() }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ ...childLogger, child: () => childLogger }) };
});

import { ECRProvider } from '../../../src/provisioning/providers/ecr-provider.js';
import { SQSQueueProvider } from '../../../src/provisioning/providers/sqs-queue-provider.js';
import { SNSTopicProvider } from '../../../src/provisioning/providers/sns-topic-provider.js';
import { StepFunctionsProvider } from '../../../src/provisioning/providers/stepfunctions-provider.js';
import { WAFv2WebACLProvider } from '../../../src/provisioning/providers/wafv2-provider.js';
import { CodeBuildProvider } from '../../../src/provisioning/providers/codebuild-provider.js';
import {
  hasRedactedCause,
  isMarkedNonRetryable,
  isNameCooldownError,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';
import { awsSdkError, relayedAwsSdkError } from '../_aws-sdk-error.js';

// go-to-k/cdkd#2319: every create / update / delete wrap of these six
// providers is persisted to `deployments/{runId}.jsonl`, so an AWS-authored
// failure is named by its class plus the --verbose pointer; AWS's text (the
// caller's role ARN) goes to the masked debug line and stays on `cause` for
// the retry classifiers.
const ACCOUNT = '111122223333';
const DENIED = `User: arn:aws:sts::${ACCOUNT}:assumed-role/deployer/s3cr3t is not authorized to perform: x:Y`;
const denied = (): Error => awsSdkError(DENIED, 'AccessDeniedException');
const mask = (t: string): string => t.replaceAll('s3cr3t', '***');
const ctx = { maskSecrets: mask };
const debugLines = (): string[] => debug.mock.calls.map((c) => String(c[0]));

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

/** Answer by command name; `fail` rejects with `error`, everything else `answers` or `{}`. */
function failOn(fail: string, error: unknown, answers: Record<string, unknown> = {}): void {
  mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === fail) throw error;
    return answers[name] ?? {};
  });
}

const WEBACL_ARN = `arn:aws:wafv2:us-east-1:${ACCOUNT}:regional/webacl/acl/abc-id`;
const WEBACL_PROPS = {
  Name: 'acl',
  Scope: 'REGIONAL',
  DefaultAction: { Allow: {} },
  VisibilityConfig: {
    SampledRequestsEnabled: false,
    CloudWatchMetricsEnabled: false,
    MetricName: 'm',
  },
};
const PROJECT_PROPS = {
  Name: 'my-project',
  Source: { Type: 'NO_SOURCE' },
  Environment: { Type: 'LINUX_CONTAINER', ComputeType: 'BUILD_GENERAL1_SMALL', Image: 'i' },
  ServiceRole: `arn:aws:iam::${ACCOUNT}:role/r`,
  Artifacts: { Type: 'NO_ARTIFACTS' },
};
const SM_PROPS = {
  StateMachineName: 'sm',
  DefinitionString: '{"StartAt":"A","States":{"A":{"Type":"Pass","End":true}}}',
  RoleArn: `arn:aws:iam::${ACCOUNT}:role/r`,
};
const QUEUE_URL = `https://sqs.us-east-1.amazonaws.com/${ACCOUNT}/q`;
const TOPIC_ARN = `arn:aws:sns:us-east-1:${ACCOUNT}:t`;

interface Case {
  wrap: string;
  fail: string;
  answers?: Record<string, unknown>;
  run: () => Promise<unknown>;
  op: 'create' | 'update' | 'delete';
}

const cases: Case[] = [
  // ECR
  {
    op: 'create',
    wrap: 'Failed to create ECR Repository Repo',
    fail: 'CreateRepositoryCommand',
    run: () =>
      new ECRProvider().create('Repo', 'AWS::ECR::Repository', { RepositoryName: 'repo' }, ctx),
  },
  {
    op: 'update',
    wrap: 'Failed to update ECR Repository Repo',
    fail: 'DescribeRepositoriesCommand',
    run: () => new ECRProvider().update('Repo', 'repo', 'AWS::ECR::Repository', {}, {}, ctx),
  },
  {
    op: 'delete',
    wrap: 'Failed to delete ECR Repository Repo',
    fail: 'DeleteRepositoryCommand',
    run: () => new ECRProvider().delete('Repo', 'repo', 'AWS::ECR::Repository', {}, ctx),
  },
  // SQS
  {
    op: 'create',
    wrap: 'Failed to create SQS queue Q',
    fail: 'CreateQueueCommand',
    run: () => new SQSQueueProvider().create('Q', 'AWS::SQS::Queue', { QueueName: 'q' }, ctx),
  },
  {
    op: 'update',
    wrap: 'Failed to update SQS queue Q',
    fail: 'SetQueueAttributesCommand',
    run: () =>
      new SQSQueueProvider().update(
        'Q',
        QUEUE_URL,
        'AWS::SQS::Queue',
        { QueueName: 'q', VisibilityTimeout: 60 },
        { QueueName: 'q', VisibilityTimeout: 30 },
        ctx
      ),
  },
  {
    op: 'delete',
    wrap: 'Failed to delete SQS queue Q',
    fail: 'DeleteQueueCommand',
    run: () => new SQSQueueProvider().delete('Q', QUEUE_URL, 'AWS::SQS::Queue', {}, ctx),
  },
  // SNS
  {
    op: 'create',
    wrap: 'Failed to create SNS topic T',
    fail: 'CreateTopicCommand',
    run: () => new SNSTopicProvider().create('T', 'AWS::SNS::Topic', { TopicName: 't' }, ctx),
  },
  {
    op: 'update',
    wrap: 'Failed to update SNS topic T',
    fail: 'SetTopicAttributesCommand',
    run: () =>
      new SNSTopicProvider().update(
        'T',
        TOPIC_ARN,
        'AWS::SNS::Topic',
        { TopicName: 't', DisplayName: 'after' },
        { TopicName: 't', DisplayName: 'before' },
        ctx
      ),
  },
  {
    op: 'delete',
    wrap: 'Failed to delete SNS topic T',
    fail: 'DeleteTopicCommand',
    run: () => new SNSTopicProvider().delete('T', TOPIC_ARN, 'AWS::SNS::Topic', {}, ctx),
  },
  // Step Functions
  {
    op: 'create',
    wrap: 'Failed to create Step Functions state machine Sm',
    fail: 'CreateStateMachineCommand',
    run: () =>
      new StepFunctionsProvider().create('Sm', 'AWS::StepFunctions::StateMachine', SM_PROPS, ctx),
  },
  {
    op: 'update',
    wrap: 'Failed to update Step Functions state machine Sm',
    fail: 'UpdateStateMachineCommand',
    run: () =>
      new StepFunctionsProvider().update(
        'Sm',
        `arn:aws:states:us-east-1:${ACCOUNT}:stateMachine:sm`,
        'AWS::StepFunctions::StateMachine',
        { ...SM_PROPS, DefinitionString: '{"StartAt":"B"}' },
        SM_PROPS,
        ctx
      ),
  },
  {
    op: 'delete',
    wrap: 'Failed to delete Step Functions state machine Sm',
    fail: 'DeleteStateMachineCommand',
    run: () =>
      new StepFunctionsProvider().delete(
        'Sm',
        `arn:aws:states:us-east-1:${ACCOUNT}:stateMachine:sm`,
        'AWS::StepFunctions::StateMachine',
        {},
        ctx
      ),
  },
  // WAFv2
  {
    op: 'create',
    wrap: 'Failed to create WAFv2 WebACL Acl',
    fail: 'CreateWebACLCommand',
    run: () => new WAFv2WebACLProvider().create('Acl', 'AWS::WAFv2::WebACL', WEBACL_PROPS, ctx),
  },
  {
    op: 'update',
    wrap: 'Failed to update WAFv2 WebACL Acl',
    fail: 'GetWebACLCommand',
    run: () =>
      new WAFv2WebACLProvider().update(
        'Acl',
        WEBACL_ARN,
        'AWS::WAFv2::WebACL',
        { ...WEBACL_PROPS, Description: 'after' },
        WEBACL_PROPS,
        ctx
      ),
  },
  {
    op: 'delete',
    wrap: 'Failed to delete WAFv2 WebACL Acl',
    fail: 'GetWebACLCommand',
    run: () => new WAFv2WebACLProvider().delete('Acl', WEBACL_ARN, 'AWS::WAFv2::WebACL', {}, ctx),
  },
  // CodeBuild
  {
    op: 'create',
    wrap: 'Failed to create CodeBuild Project Proj',
    fail: 'CreateProjectCommand',
    run: () => new CodeBuildProvider().create('Proj', 'AWS::CodeBuild::Project', PROJECT_PROPS, ctx),
  },
  {
    op: 'update',
    wrap: 'Failed to update CodeBuild Project Proj',
    fail: 'UpdateProjectCommand',
    run: () =>
      new CodeBuildProvider().update(
        'Proj',
        'my-project',
        'AWS::CodeBuild::Project',
        { ...PROJECT_PROPS, Description: 'after' },
        PROJECT_PROPS,
        ctx
      ),
  },
  {
    op: 'delete',
    wrap: 'Failed to delete CodeBuild Project Proj',
    fail: 'DeleteProjectCommand',
    run: () => new CodeBuildProvider().delete('Proj', 'my-project', 'AWS::CodeBuild::Project', {}, ctx),
  },
];

const deletes = cases.filter((c) => c.op === 'delete');
const creates = cases.filter((c) => c.op === 'create');

describe('ECR / SQS / SNS / Step Functions / WAFv2 / CodeBuild thrown wraps withhold AWS text (#2319)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
  });

  it.each(cases)('$wrap ($fail): an AWS-authored failure is named by its class', async (c) => {
    failOn(c.fail, denied(), c.answers);

    const failure = await caught(c.run());

    expect(mockSend.mock.calls.some((call) => call[0].constructor.name === c.fail)).toBe(true);
    expect(failure.message).toBe(`${c.wrap}: AccessDeniedException. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain(ACCOUNT);
    expect((failure.cause as Error).message).toBe(DENIED);
    expect(hasRedactedCause(failure)).toBe(true);
    // `not authorized to perform` is retryable (IAM propagation), read on the chain.
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    expect(debugLines()).toContain(`${c.wrap}: ${mask(DENIED)}`);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  it.each(cases)('$wrap ($fail): a cdkd-authored failure keeps its text, masked', async (c) => {
    failOn(c.fail, relayedAwsSdkError('relayed near s3cr3t'), c.answers);

    const failure = await caught(c.run());

    expect(failure.message).toBe(`${c.wrap}: relayed near ***`);
    // The mask changed the text, so the wrap is stamped (issue #4244).
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it.each(cases)('$wrap ($fail): an unmasked cdkd-authored failure is not stamped', async (c) => {
    failOn(c.fail, new Error('socket hang up'), c.answers);

    const failure = await caught(c.run());

    expect(failure.message).toBe(`${c.wrap}: socket hang up`);
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it.each(cases)('$wrap ($fail): a non-Error throw is withheld, unstamped', async (c) => {
    failOn(c.fail, 'raw s3cr3t value', c.answers);

    const failure = await caught(c.run());

    expect(failure.message).toBe(`${c.wrap}: a non-Error value of type string. ${VERBOSE_POINTER}`);
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it.each(deletes)('$wrap: a NotFound class that is not the resource never reads as gone', async (c) => {
    // The class name spells `NotFoundException`, which the destroy and deploy
    // delete classifiers read as "already deleted" unless the error is marked.
    failOn(c.fail, awsSdkError('The KMS key was not found.', 'KMSNotFoundException'));

    const failure = await caught(c.run());

    expect(failure.message).toBe(`${c.wrap}: KMSNotFoundException. ${VERBOSE_POINTER}`);
    expect(isMarkedNotGone(failure)).toBe(true);
    expect(isMarkedNonRetryable(failure)).toBe(false);
  });

  it.each(deletes)('$wrap: an ordinary delete failure is not marked', async (c) => {
    failOn(c.fail, denied());

    const failure = await caught(c.run());

    expect(isMarkedNotGone(failure)).toBe(false);
    expect(isMarkedNonRetryable(failure)).toBe(false);
  });

  it.each(creates)('$wrap: restates an "already exists" from the create call', async (c) => {
    failOn(c.fail, awsSdkError('Resource already exists', 'ResourceAlreadyExistsException'));

    const failure = await caught(c.run());

    expect(failure.message).toBe(
      `${c.wrap}: ResourceAlreadyExistsException. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
  });

  it('ECR: does not restate "already exists" from a post-create step', async () => {
    failOn(
      'PutLifecyclePolicyCommand',
      awsSdkError('Lifecycle policy already exists', 'ResourceAlreadyExistsException'),
      {
        CreateRepositoryCommand: {
          repository: { repositoryName: 'repo', repositoryArn: 'arn', repositoryUri: 'uri' },
        },
      }
    );

    const failure = await caught(
      new ECRProvider().create(
        'Repo',
        'AWS::ECR::Repository',
        { RepositoryName: 'repo', LifecyclePolicy: { LifecyclePolicyText: '{}' } },
        ctx
      )
    );

    expect(failure.message).toBe(
      `Failed to create ECR Repository Repo: ResourceAlreadyExistsException. ${VERBOSE_POINTER}`
    );
  });

  it('SQS: a create in the name cooldown stays retryable on the cooldown schedule', async () => {
    const cooldown =
      'You must wait 60 seconds after deleting a queue before you can create another with the same name.';
    failOn('CreateQueueCommand', awsSdkError(cooldown, 'QueueDeletedRecently'));

    const failure = await caught(cases[3]!.run());

    expect(failure.message).toBe(
      `Failed to create SQS queue Q: QueueDeletedRecently. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain('wait 60 seconds');
    expect(isNameCooldownError(retryClassificationText(failure))).toBe(true);
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
  });
});
