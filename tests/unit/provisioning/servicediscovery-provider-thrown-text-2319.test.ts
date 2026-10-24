import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, debug } = vi.hoisted(() => ({ mockSend: vi.fn(), debug: vi.fn() }));

vi.mock('@aws-sdk/client-servicediscovery', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    ServiceDiscoveryClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const logger: Record<string, unknown> = {
    debug,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  logger['child'] = () => logger;
  return { getLogger: () => logger };
});

import { ServiceDiscoveryProvider } from '../../../src/provisioning/providers/servicediscovery-provider.js';
import {
  hasRedactedCause,
  isMarkedNonRetryable,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';

// go-to-k/cdkd#2319: every create / update / delete wrap is persisted to
// `deployments/{runId}.jsonl`, so an AWS-authored failure is named by its class
// plus the --verbose pointer, and a FAILED operation by its `ErrorCode`; AWS's
// text (the caller's role ARN) goes to the masked debug line and stays on
// `cause` for the retry classifiers.
const ACCOUNT = '111122223333';
const DENIED = `User: arn:aws:sts::${ACCOUNT}:assumed-role/deployer/s3cr3t is not authorized to perform: servicediscovery:X`;
const denied = (): Error =>
  Object.assign(new Error(DENIED), {
    name: 'AccessDeniedException',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });
const mask = (t: string): string => t.replaceAll('s3cr3t', '***');
const debugLines = (): string[] => debug.mock.calls.map((c) => String(c[0]));

const PRIVATE_DNS = 'AWS::ServiceDiscovery::PrivateDnsNamespace';
const SERVICE = 'AWS::ServiceDiscovery::Service';

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

const cases: Array<{ wrap: string; fail: string; run: (p: ServiceDiscoveryProvider) => Promise<unknown> }> = [
  {
    wrap: 'Failed to create private DNS namespace Ns',
    fail: 'CreatePrivateDnsNamespaceCommand',
    run: (p) => p.create('Ns', PRIVATE_DNS, { Name: 'ns.local', Vpc: 'vpc-1' }, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to update private DNS namespace Ns',
    fail: 'UpdatePrivateDnsNamespaceCommand',
    run: (p) =>
      p.update('Ns', 'ns-1', PRIVATE_DNS, { Description: 'a' }, { Description: 'b' }, {
        maskSecrets: mask,
      }),
  },
  {
    wrap: 'Failed to delete Cloud Map namespace Ns',
    fail: 'DeleteNamespaceCommand',
    run: (p) => p.delete('Ns', 'ns-1', PRIVATE_DNS, undefined, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to create service discovery service Svc',
    fail: 'CreateServiceCommand',
    run: (p) =>
      p.create('Svc', SERVICE, { Name: 'svc', NamespaceId: 'ns-1' }, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to update service discovery service Svc',
    fail: 'UpdateServiceCommand',
    run: (p) =>
      p.update('Svc', 'srv-1', SERVICE, { Description: 'a' }, { Description: 'b' }, {
        maskSecrets: mask,
      }),
  },
  {
    wrap: 'Failed to delete service discovery service Svc',
    fail: 'DeleteServiceCommand',
    run: (p) => p.delete('Svc', 'srv-1', SERVICE, undefined, { maskSecrets: mask }),
  },
];

describe('ServiceDiscoveryProvider thrown wraps withhold AWS text (#2319)', () => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new ServiceDiscoveryProvider();
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
    // The mask changed the text, so the wrap is stamped (issue #4259).
    expect(hasRedactedCause(failure)).toBe(true);
  });

  // The wrap names the class, and the delete classifiers read `NotFound` in a
  // message as "already deleted" unless the error is marked.
  it('delete namespace: an OperationNotFound from the poll is never read as gone', async () => {
    failOn('GetOperationCommand', Object.assign(new Error('gone'), {
        name: 'OperationNotFound',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      }), {
      DeleteNamespaceCommand: { OperationId: 'op-1' },
    });

    const failure = await caught(provider.delete('Ns', 'ns-1', PRIVATE_DNS));

    expect(failure.message).toBe(
      `Failed to delete Cloud Map namespace Ns: OperationNotFound. ${VERBOSE_POINTER}`
    );
    expect(isMarkedNotGone(failure)).toBe(true);
    expect(isMarkedNonRetryable(failure)).toBe(false);
  });

  it('delete service: a NotFound class that is not ServiceNotFound is never read as gone', async () => {
    failOn('DeleteServiceCommand', Object.assign(new Error('gone'), {
        name: 'NamespaceNotFound',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      }));

    const failure = await caught(provider.delete('Svc', 'srv-1', SERVICE));

    expect(isMarkedNotGone(failure)).toBe(true);
    expect(isMarkedNonRetryable(failure)).toBe(false);
  });

  it('an ordinary delete failure is not marked', async () => {
    failOn('DeleteServiceCommand', denied());

    const failure = await caught(provider.delete('Svc', 'srv-1', SERVICE));

    expect(isMarkedNotGone(failure)).toBe(false);
    expect(isMarkedNonRetryable(failure)).toBe(false);
  });

  it('a non-Error throw is withheld, unstamped', async () => {
    failOn('DeleteServiceCommand', 'raw s3cr3t value');

    const failure = await caught(provider.delete('Svc', 'srv-1', SERVICE));

    expect(failure.message).toBe(
      `Failed to delete service discovery service Svc: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it('restates an "already exists" from CreateService', async () => {
    failOn(
      'CreateServiceCommand',
      Object.assign(new Error('Service already exists'), {
        name: 'ServiceAlreadyExists',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      })
    );

    const failure = await caught(provider.create('Svc', SERVICE, { Name: 'svc', NamespaceId: 'ns-1' }));

    expect(failure.message).toBe(
      `Failed to create service discovery service Svc: ServiceAlreadyExists. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
  });

  it('does not restate it from the attributes wiring after the service was created', async () => {
    failOn(
      'UpdateServiceAttributesCommand',
      Object.assign(new Error('Attribute already exists'), {
        name: 'InvalidInput',
        $fault: 'client',
        $metadata: { httpStatusCode: 400 },
      }),
      { CreateServiceCommand: { Service: { Id: 'srv-1', Arn: 'arn:srv', Name: 'svc' } } }
    );

    const failure = await caught(
      provider.create('Svc', SERVICE, {
        Name: 'svc',
        NamespaceId: 'ns-1',
        ServiceAttributes: { team: 'core' },
      })
    );

    expect(mockSend.mock.calls.some((c) => c[0].constructor.name === 'UpdateServiceAttributesCommand')).toBe(true);
    expect(failure.message).toBe(
      `Failed to create service discovery service Svc: InvalidInput. ${VERBOSE_POINTER}`
    );
  });

  // Cloud Map's create / update / delete are operation-based: AWS reports the
  // rejection in a successful GetOperation's `ErrorMessage`.
  const failedOperation = (fields: Record<string, unknown>) => ({
    GetOperationCommand: { Operation: { Status: 'FAIL', ...fields } },
    CreatePrivateDnsNamespaceCommand: { OperationId: 'op-1' },
    DeleteNamespaceCommand: { OperationId: 'op-1' },
  });

  it.each([
    {
      label: 'create',
      shown: mask(DENIED),
      run: (p: ServiceDiscoveryProvider) =>
        p.create('Ns', PRIVATE_DNS, { Name: 'ns.local', Vpc: 'vpc-1' }, { maskSecrets: mask }),
    },
    {
      // A delete caller threads no masker into the poller (provider-masking.md).
      label: 'delete',
      shown: DENIED,
      run: (p: ServiceDiscoveryProvider) =>
        p.delete('Ns', 'ns-1', PRIVATE_DNS, undefined, { maskSecrets: mask }),
    },
  ])('$label: a FAILED operation is named by its ErrorCode', async (c) => {
    failOn('none', undefined, failedOperation({ ErrorCode: 'ACCESS_DENIED', ErrorMessage: DENIED }));

    const failure = await caught(c.run(provider));

    expect(failure.message).toBe(`Operation failed for Ns: ACCESS_DENIED. ${VERBOSE_POINTER}`);
    expect((failure.cause as Error).message).toBe(DENIED);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    expect(debugLines()).toContain(`Operation failed for Ns: ${c.shown}`);
  });

  it('a FAILED operation restates an "already exists"', async () => {
    failOn(
      'none',
      undefined,
      failedOperation({ ErrorCode: 'CANNOT_CREATE_HOSTED_ZONE', ErrorMessage: 'zone already exists' })
    );

    const failure = await caught(cases[0]!.run(provider));

    expect(failure.message).toBe(
      `Operation failed for Ns: CANNOT_CREATE_HOSTED_ZONE. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
  });
});
