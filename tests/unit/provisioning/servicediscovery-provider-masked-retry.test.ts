import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreatePrivateDnsNamespaceCommand,
  CreateHttpNamespaceCommand,
  CreatePublicDnsNamespaceCommand,
  CreateServiceCommand,
  GetOperationCommand,
  UpdatePrivateDnsNamespaceCommand,
  UpdateHttpNamespaceCommand,
  UpdatePublicDnsNamespaceCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-servicediscovery';
import { createSecretMasker } from '../../../src/deployment/secret-redaction.js';
import {
  hasRedactedCause,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';

/**
 * Issue #4259, Service Discovery half: every `create()` / `update()` arm masks
 * AWS's error text before joining it into its `Failed to create/update ...`
 * message (#2050, #2063). When a recorded secret spells part of the retry
 * table's wording, the mask cuts that wording out of the message, so the wrap
 * must be stamped (`markRedactedCause`) for the retry classifiers to read the
 * unmasked cause chain. One retryable case per wrap site, plus the unstamped
 * negative control.
 */

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-servicediscovery', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-servicediscovery')>(
    '@aws-sdk/client-servicediscovery'
  );
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
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  logger['child'] = () => logger;
  return { getLogger: () => logger };
});

import { ServiceDiscoveryProvider } from '../../../src/provisioning/providers/servicediscovery-provider.js';

const PRIVATE_DNS = 'AWS::ServiceDiscovery::PrivateDnsNamespace';
const HTTP_NS = 'AWS::ServiceDiscovery::HttpNamespace';
const PUBLIC_DNS = 'AWS::ServiceDiscovery::PublicDnsNamespace';
const SERVICE = 'AWS::ServiceDiscovery::Service';

/** A secret that spells part of the retry table's `does not exist` wording. */
const RETRY_WORD = 'exist';
const retryMasker = createSecretMasker(
  new Map([[RETRY_WORD, '{{resolve:secretsmanager:cloudmap-4259:SecretString:k::}}']])
);
const TRANSIENT = 'Namespace ns-0123456789abcdef does not exist';

/** An AWS-authored client rejection (400, so no transient-server arm fires). */
function awsRejection(message: string): Error {
  return Object.assign(new Error(message), {
    name: 'InvalidInput',
    $fault: 'client',
    $metadata: { httpStatusCode: 400, requestId: 'req-sd-4259' },
  });
}

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

type Masker = typeof retryMasker;

const SITES = [
  {
    site: 'create() PrivateDnsNamespace',
    command: CreatePrivateDnsNamespaceCommand,
    run: (p: ServiceDiscoveryProvider, m: Masker) =>
      p.create('Ns', PRIVATE_DNS, { Name: 'ns.local', Vpc: 'vpc-1' }, { maskSecrets: m }),
  },
  {
    site: 'update() PrivateDnsNamespace',
    command: UpdatePrivateDnsNamespaceCommand,
    run: (p: ServiceDiscoveryProvider, m: Masker) =>
      p.update(
        'Ns',
        'ns-abc',
        PRIVATE_DNS,
        { Description: 'a' },
        { Description: 'b' },
        { maskSecrets: m }
      ),
  },
  {
    site: 'create() HttpNamespace',
    command: CreateHttpNamespaceCommand,
    run: (p: ServiceDiscoveryProvider, m: Masker) =>
      p.create('Ns', HTTP_NS, { Name: 'ns-http' }, { maskSecrets: m }),
  },
  {
    site: 'update() HttpNamespace',
    command: UpdateHttpNamespaceCommand,
    run: (p: ServiceDiscoveryProvider, m: Masker) =>
      p.update('Ns', 'ns-abc', HTTP_NS, { Description: 'a' }, { Description: 'b' }, { maskSecrets: m }),
  },
  {
    site: 'create() PublicDnsNamespace',
    command: CreatePublicDnsNamespaceCommand,
    run: (p: ServiceDiscoveryProvider, m: Masker) =>
      p.create('Ns', PUBLIC_DNS, { Name: 'ns.example.com' }, { maskSecrets: m }),
  },
  {
    site: 'update() PublicDnsNamespace',
    command: UpdatePublicDnsNamespaceCommand,
    run: (p: ServiceDiscoveryProvider, m: Masker) =>
      p.update(
        'Ns',
        'ns-abc',
        PUBLIC_DNS,
        { Description: 'a' },
        { Description: 'b' },
        { maskSecrets: m }
      ),
  },
  {
    site: 'create() Service',
    command: CreateServiceCommand,
    run: (p: ServiceDiscoveryProvider, m: Masker) =>
      p.create('Svc', SERVICE, { Name: 'svc', NamespaceId: 'ns-abc' }, { maskSecrets: m }),
  },
  {
    site: 'update() Service',
    command: UpdateServiceCommand,
    run: (p: ServiceDiscoveryProvider, m: Masker) =>
      p.update('Svc', 'srv-1', SERVICE, { Description: 'a' }, { Description: 'b' }, { maskSecrets: m }),
  },
] as const;

/** Reject `command` with `error`; every other call succeeds. */
function rejectOn(command: abstract new (...args: never[]) => object, error: Error): void {
  mockSend.mockImplementation((sent: unknown) =>
    sent instanceof command ? Promise.reject(error) : Promise.resolve({})
  );
}

describe('ServiceDiscoveryProvider: a masked failure still classifies as retryable (issue #4259)', () => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
  });

  it.each(SITES)('$site: the stamp keeps it retryable', async ({ command, run }) => {
    rejectOn(command, awsRejection(TRANSIENT));
    const failure = await thrown(run(provider, retryMasker));
    // Non-vacuity: the rejection came from the site's own command.
    expect(mockSend.mock.calls.some((c) => c[0] instanceof command)).toBe(true);
    // Premise: the mask cut the retry wording out of the message itself.
    expect(failure.message).not.toContain('does not exist');
    expect(isRetryableTransientError(failure, failure.message)).toBe(false);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(retryable(failure)).toBe(true);
  });

  it.each(SITES)(
    '$site: a failure the mask left unchanged is not stamped',
    async ({ command, run }) => {
      rejectOn(command, awsRejection('Bad request parameter'));
      const failure = await thrown(run(provider, retryMasker));
      expect(failure.message).toContain('Bad request parameter');
      expect(hasRedactedCause(failure)).toBe(false);
      expect(retryable(failure)).toBe(false);
    }
  );
});

/**
 * Issue #4299: a FAILED operation surfaces through `pollOperation`, whose
 * `ProvisioningError` the arms re-throw verbatim. Its text is AWS's
 * `Operation.ErrorMessage`, not a caught error, so the unmasked text must be
 * attached as the `cause` for the stamp to have a chain to point at.
 */
describe('ServiceDiscoveryProvider: a masked FAILED operation keeps its classification (issue #4299)', () => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ServiceDiscoveryProvider();
  });

  function failOperation(errorMessage: string): void {
    mockSend.mockImplementation((sent: unknown) => {
      if (sent instanceof CreateHttpNamespaceCommand) {
        return Promise.resolve({ OperationId: 'op-4299' });
      }
      if (sent instanceof GetOperationCommand) {
        return Promise.resolve({ Operation: { Status: 'FAIL', ErrorMessage: errorMessage } });
      }
      return Promise.resolve({});
    });
  }

  it('the stamp keeps a masked retry wording retryable', async () => {
    failOperation(TRANSIENT);
    const failure = await thrown(
      provider.create('Ns', HTTP_NS, { Name: 'ns-http' }, { maskSecrets: retryMasker })
    );
    // Non-vacuity: the failure came from the poll's FAIL arm.
    expect(mockSend.mock.calls.some((c) => c[0] instanceof GetOperationCommand)).toBe(true);
    expect(failure.message).toContain('Operation failed for Ns');
    // Premise: the mask cut the retry wording out of the message itself.
    expect(failure.message).not.toContain('does not exist');
    expect(isRetryableTransientError(failure, failure.message)).toBe(false);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(retryable(failure)).toBe(true);
  });

  it('classifies exactly as the unmasked message does', async () => {
    failOperation(TRANSIENT);
    const unmasked = await thrown(provider.create('Ns', HTTP_NS, { Name: 'ns-http' }));
    expect(unmasked.message).toContain('does not exist');
    expect(hasRedactedCause(unmasked)).toBe(false);
    expect(retryable(unmasked)).toBe(true);
  });

  it('a FAILED message the mask left unchanged is not stamped', async () => {
    failOperation('Bad request parameter');
    const failure = await thrown(
      provider.create('Ns', HTTP_NS, { Name: 'ns-http' }, { maskSecrets: retryMasker })
    );
    expect(failure.message).toContain('Bad request parameter');
    expect(hasRedactedCause(failure)).toBe(false);
    expect(retryable(failure)).toBe(false);
  });
});
