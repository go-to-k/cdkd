import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const { mockSend, waitUntilServicesStableMock, debug, warn } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  waitUntilServicesStableMock: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
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
    debug,
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ ...childLogger, child: () => childLogger }) };
});

import { ECSProvider } from '../../../src/provisioning/providers/ecs-provider.js';
import {
  hasRedactedCause,
  isMarkedNonRetryable,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';

// The by-name lookup before CreateService (go-to-k/cdkd#4403): the name is free.
vi.spyOn(
  ECSProvider.prototype as unknown as { serviceNameHeld(): Promise<boolean> },
  'serviceNameHeld'
).mockResolvedValue(false);

// go-to-k/cdkd#2319: every create / update / delete wrap is persisted to
// `deployments/{runId}.jsonl`, so an AWS-authored failure is named by its class
// plus the --verbose pointer; AWS's text (the caller's role ARN) goes to the
// masked debug line and stays on `cause` for the retry classifiers.
const ACCOUNT = '111122223333';
const DENIED = `User: arn:aws:sts::${ACCOUNT}:assumed-role/deployer/s3cr3t is not authorized to perform: ecs:X`;
const denied = (): Error =>
  Object.assign(new Error(DENIED), {
    name: 'AccessDeniedException',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });
const mask = (t: string): string => t.replaceAll('s3cr3t', '***');
const debugLines = (): string[] => debug.mock.calls.map((c) => String(c[0]));

const SERVICE_ARN = `arn:aws:ecs:us-east-1:${ACCOUNT}:service/c1/web`;
const SERVICE_PROPS = { Cluster: 'c1', ServiceName: 'web', TaskDefinition: 'td:1' };

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

/** Answer by command name; `fail` rejects with `error`, everything else `{}`. */
function failOn(fail: string, error: unknown, answers: Record<string, unknown> = {}): void {
  mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === fail) throw error;
    return answers[name] ?? {};
  });
}

const cases: Array<{ wrap: string; fail: string; run: (p: ECSProvider) => Promise<unknown> }> = [
  {
    wrap: 'Failed to create ECS cluster Clu',
    fail: 'CreateClusterCommand',
    run: (p) => p.create('Clu', 'AWS::ECS::Cluster', { ClusterName: 'c1' }, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to update ECS cluster Clu',
    fail: 'PutClusterCapacityProvidersCommand',
    run: (p) =>
      p.update(
        'Clu',
        'c1',
        'AWS::ECS::Cluster',
        { ClusterName: 'c1', CapacityProviders: ['FARGATE'] },
        { ClusterName: 'c1' },
        { maskSecrets: mask }
      ),
  },
  {
    wrap: 'Failed to delete ECS cluster Clu',
    fail: 'DeleteClusterCommand',
    run: (p) => p.delete('Clu', 'c1', 'AWS::ECS::Cluster', undefined, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to create ECS task definition Td',
    fail: 'RegisterTaskDefinitionCommand',
    run: (p) =>
      p.create('Td', 'AWS::ECS::TaskDefinition', { Family: 'fam' }, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to delete ECS task definition Td',
    fail: 'DeregisterTaskDefinitionCommand',
    run: (p) =>
      p.delete('Td', 'arn:td:1', 'AWS::ECS::TaskDefinition', undefined, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to create ECS service Svc',
    fail: 'CreateServiceCommand',
    run: (p) => p.create('Svc', 'AWS::ECS::Service', SERVICE_PROPS, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to update ECS service Svc',
    fail: 'UpdateServiceCommand',
    run: (p) =>
      p.update(
        'Svc',
        SERVICE_ARN,
        'AWS::ECS::Service',
        { Cluster: 'c1', DesiredCount: 2 },
        { Cluster: 'c1', DesiredCount: 1 },
        { maskSecrets: mask }
      ),
  },
  {
    wrap: 'Failed to delete ECS service Svc',
    fail: 'DeleteServiceCommand',
    run: (p) =>
      p.delete('Svc', SERVICE_ARN, 'AWS::ECS::Service', { Cluster: 'c1' }, { maskSecrets: mask }),
  },
];

describe('ECSProvider thrown wraps withhold AWS text (#2319)', () => {
  let provider: ECSProvider;
  const savedFullWait = process.env['CDKD_FULL_WAIT'];

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    waitUntilServicesStableMock.mockReset();
    waitUntilServicesStableMock.mockResolvedValue({ state: 'SUCCESS' });
    delete process.env['CDKD_FULL_WAIT'];
    provider = new ECSProvider();
  });

  afterEach(() => {
    if (savedFullWait === undefined) delete process.env['CDKD_FULL_WAIT'];
    else process.env['CDKD_FULL_WAIT'] = savedFullWait;
  });

  it.each(cases)('$wrap: an AWS-authored failure is named by its class', async (c) => {
    failOn(c.fail, denied());

    const failure = await caught(c.run(provider));

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

  it.each(cases)('$wrap: a cdkd-authored failure keeps its text, masked', async (c) => {
    failOn(c.fail, new Error('socket hang up near s3cr3t'));

    const failure = await caught(c.run(provider));

    expect(failure.message).toBe(`${c.wrap}: socket hang up near ***`);
    // The mask changed the text, so the wrap is stamped (issue #4244).
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it('a cdkd-authored failure the mask leaves alone is not stamped', async () => {
    failOn('CreateClusterCommand', new Error('socket hang up'));

    const failure = await caught(cases[0]!.run(provider));

    expect(failure.message).toBe(`${cases[0]!.wrap}: socket hang up`);
    expect(hasRedactedCause(failure)).toBe(false);
  });

  // The wrap names the class, and the delete classifiers read `NotFound` in a
  // message as "already deleted" unless the error is marked.
  it('delete service: a Service Connect NamespaceNotFoundException is never read as gone', async () => {
    failOn('UpdateServiceCommand', Object.assign(new Error('gone'), {
        name: 'NamespaceNotFoundException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      }));

    const failure = await caught(cases[7]!.run(provider));

    expect(failure.message).toBe(
      `Failed to delete ECS service Svc: NamespaceNotFoundException. ${VERBOSE_POINTER}`
    );
    expect(isMarkedNotGone(failure)).toBe(true);
    expect(isMarkedNonRetryable(failure)).toBe(false);
  });

  it('delete service: a missing cluster still reads as gone (unmarked)', async () => {
    failOn('DeleteServiceCommand', Object.assign(new Error('gone'), {
        name: 'ClusterNotFoundException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      }));

    const failure = await caught(cases[7]!.run(provider));

    expect(isMarkedNotGone(failure)).toBe(false);
    expect(isMarkedNonRetryable(failure)).toBe(false);
  });

  it.each([
    { label: 'cluster', fail: 'DeleteClusterCommand', index: 2 },
    { label: 'task definition', fail: 'DeregisterTaskDefinitionCommand', index: 4 },
  ])('delete $label: an unrelated NotFound class is never read as gone', async (c) => {
    failOn(c.fail, Object.assign(new Error('gone'), {
        name: 'KeyNotFoundFault',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      }));

    const failure = await caught(cases[c.index]!.run(provider));

    expect(isMarkedNotGone(failure)).toBe(true);
    expect(isMarkedNonRetryable(failure)).toBe(false);
  });

  it('an ordinary delete failure is not marked', async () => {
    failOn('DeleteClusterCommand', denied());

    const failure = await caught(cases[2]!.run(provider));

    expect(isMarkedNotGone(failure)).toBe(false);
    expect(isMarkedNonRetryable(failure)).toBe(false);
  });

  it('a non-Error throw is withheld, unstamped', async () => {
    failOn('DeleteClusterCommand', 'raw s3cr3t value');

    const failure = await caught(provider.delete('Clu', 'c1', 'AWS::ECS::Cluster'));

    expect(failure.message).toBe(
      `Failed to delete ECS cluster Clu: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it('restates an "already exists" from CreateService', async () => {
    failOn(
      'CreateServiceCommand',
      Object.assign(new Error('Creation of service was not idempotent: already exists'), {
        name: 'InvalidParameterException',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );

    const failure = await caught(provider.create('Svc', 'AWS::ECS::Service', SERVICE_PROPS));

    expect(failure.message).toBe(
      `Failed to create ECS service Svc: InvalidParameterException. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
  });

  // `@smithy/util-waiter` throws a plain `Error` whose message is the JSON of
  // the waiter result: every DescribeServices answer and failure text it saw.
  const waiterTimeout = (): Error => {
    const error = new Error(
      JSON.stringify({
        state: 'TIMEOUT',
        observedResponses: { [`403: ${DENIED}`]: 3 },
        reason: 'Waiter has timed out',
      })
    );
    error.name = 'TimeoutError';
    return error;
  };

  it.each([
    {
      label: 'create',
      wrap: 'Failed to create ECS service Svc: ECS service Svc did not reach steady state under --full-wait: the ServicesStable waiter ended in state TIMEOUT (TimeoutError). ',
      answers: { CreateServiceCommand: { service: { serviceArn: SERVICE_ARN, serviceName: 'web' } } },
      run: (p: ECSProvider) =>
        p.create('Svc', 'AWS::ECS::Service', SERVICE_PROPS, { maskSecrets: mask }),
    },
    {
      label: 'update',
      wrap: `Failed to update ECS service Svc: the ServicesStable waiter ended in state TIMEOUT (TimeoutError). ${VERBOSE_POINTER}`,
      answers: { UpdateServiceCommand: { service: { serviceArn: SERVICE_ARN, serviceName: 'web' } } },
      run: (p: ECSProvider) =>
        p.update(
          'Svc',
          SERVICE_ARN,
          'AWS::ECS::Service',
          { Cluster: 'c1', DesiredCount: 2 },
          { Cluster: 'c1', DesiredCount: 1 },
          { maskSecrets: mask }
        ),
    },
  ])('$label under --full-wait: the waiter result is withheld', async (c) => {
    process.env['CDKD_FULL_WAIT'] = 'true';
    failOn('none', undefined, c.answers);
    const timeout = waiterTimeout();
    waitUntilServicesStableMock.mockRejectedValue(timeout);

    const failure = await caught(c.run(provider));

    expect(failure.message.startsWith(c.wrap)).toBe(true);
    // The reduced link keeps the waiter's name for the chain walks.
    const names: string[] = [];
    for (let e: unknown = failure; e instanceof Error; e = e.cause) names.push(e.name);
    expect(names.filter((n) => n === 'TimeoutError')).toHaveLength(2);
    expect(failure.message).not.toContain(ACCOUNT);
    expect(failure.message).not.toContain('observedResponses');
    expect(hasRedactedCause(failure)).toBe(true);
    // The waiter error is still on the chain for the classifiers.
    expect(retryClassificationText(failure)).toContain('not authorized to perform');
    const result = debugLines().find((l) => l.includes('ServicesStable waiter result'));
    expect(result).toBeDefined();
    expect(result).toContain(ACCOUNT);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  it('a waiter error that is no waiter result keeps its text', async () => {
    process.env['CDKD_FULL_WAIT'] = 'true';
    failOn('none', undefined, {
      UpdateServiceCommand: { service: { serviceArn: SERVICE_ARN, serviceName: 'web' } },
    });
    waitUntilServicesStableMock.mockRejectedValue(new Error('Waiter has timed out'));

    const failure = await caught(cases[6]!.run(provider));

    expect(failure.message).toBe('Failed to update ECS service Svc: Waiter has timed out');
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it('a JSON waiter error with no state keeps its text', async () => {
    process.env['CDKD_FULL_WAIT'] = 'true';
    failOn('none', undefined, {
      UpdateServiceCommand: { service: { serviceArn: SERVICE_ARN, serviceName: 'web' } },
    });
    waitUntilServicesStableMock.mockRejectedValue(new Error(JSON.stringify({ foo: 1 })));

    const failure = await caught(cases[6]!.run(provider));

    expect(failure.message).toBe('Failed to update ECS service Svc: {"foo":1}');
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it('a FAILURE waiter result with the plain Error name names the state only', async () => {
    process.env['CDKD_FULL_WAIT'] = 'true';
    failOn('none', undefined, {
      UpdateServiceCommand: { service: { serviceArn: SERVICE_ARN, serviceName: 'web' } },
    });
    waitUntilServicesStableMock.mockRejectedValue(
      new Error(JSON.stringify({ state: 'FAILURE', reason: { serviceArn: SERVICE_ARN } }))
    );

    const failure = await caught(cases[6]!.run(provider));

    expect(failure.message).toBe(
      `Failed to update ECS service Svc: the ServicesStable waiter ended in state FAILURE. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain(ACCOUNT);
  });

  it('create under --full-wait: a denied rollout read is named by its class', async () => {
    process.env['CDKD_FULL_WAIT'] = 'true';
    failOn('DescribeServicesCommand', denied(), {
      CreateServiceCommand: { service: { serviceArn: SERVICE_ARN, serviceName: 'web' } },
    });

    const failure = await caught(
      provider.create('Svc', 'AWS::ECS::Service', SERVICE_PROPS, { maskSecrets: mask })
    );

    expect(failure.message).toContain(
      `did not reach steady state under --full-wait: AccessDeniedException. Re-run with --verbose for AWS's own message. Inspect`
    );
    expect(failure.message).not.toContain(ACCOUNT);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    expect(debugLines().join('\n')).toContain(mask(DENIED));
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  it("import: DescribeClusters' failure detail goes to debug", async () => {
    mockSend.mockResolvedValue({
      clusters: [],
      failures: [{ reason: 'ACCESS_DENIED', detail: `denied for ${ACCOUNT}` }],
    });

    const failure = await caught(
      provider.import({
        logicalId: 'Clu',
        resourceType: 'AWS::ECS::Cluster',
        stackName: 'S',
        region: 'us-east-1',
        properties: { ClusterName: 'theirs' },
      })
    );

    expect(failure.message).toBe(
      `DescribeClusters did not answer for cluster theirs: ACCESS_DENIED. ${VERBOSE_POINTER}`
    );
    expect(debugLines().join('\n')).toContain(`denied for ${ACCOUNT}`);
  });
});
