import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeleteNamespaceCommand, ResourceInUse } from '@aws-sdk/client-servicediscovery';

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
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

// Collapse the retry backoff to zero so the ~5.5 min real-time budget runs
// instantly; the retry COUNT is still exercised for real.
vi.mock('../../../src/deployment/retry.js', async () => {
  const actual =
    await vi.importActual<typeof import('../../../src/deployment/retry.js')>(
      '../../../src/deployment/retry.js'
    );
  return {
    ...actual,
    withRetry: (<T>(
      operation: () => Promise<T>,
      logicalId: string,
      opts: Record<string, unknown> = {}
    ) =>
      actual.withRetry(operation, logicalId, {
        ...opts,
        sleep: () => Promise.resolve(),
      })) as typeof actual.withRetry,
  };
});

import { ServiceDiscoveryProvider } from '../../../src/provisioning/providers/servicediscovery-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * Issue #609 (ecs-fargate SDK-route flip fallout): ECS Service Connect
 * deletes its Cloud Map services ASYNCHRONOUSLY after the owning ECS
 * service is deleted, so a DAG-ordered destroy can call DeleteNamespace
 * while the ECS-managed cleanup is still draining and get
 * `ResourceInUse: Namespace has associated services`. Observed live
 * 2026-08-11: destroy failed 22/23 on the namespace, and the associated
 * services were gone minutes later with no action taken.
 *
 * The provider retries the delete on exactly that signal (bounded budget)
 * and still fails fast on every other error.
 */
describe('ServiceDiscoveryProvider deleteNamespace ResourceInUse retry (#609)', () => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new ServiceDiscoveryProvider();
  });

  function resourceInUse(): ResourceInUse {
    return new ResourceInUse({
      message: 'Namespace has associated services; delete the services before deleting the namespace',
      $metadata: {},
    });
  }

  it('retries DeleteNamespace while ECS Service Connect services drain, then succeeds', async () => {
    mockSend
      .mockRejectedValueOnce(resourceInUse())
      .mockRejectedValueOnce(resourceInUse())
      .mockResolvedValueOnce({ OperationId: 'op-1' })
      .mockResolvedValueOnce({
        Operation: { Status: 'SUCCESS', Targets: { NAMESPACE: 'ns-test' } },
      });

    await expect(
      provider.delete('Namespace', 'ns-test', 'AWS::ServiceDiscovery::PrivateDnsNamespace')
    ).resolves.toBeUndefined();

    const deleteCalls = mockSend.mock.calls.filter(
      ([cmd]) => cmd instanceof DeleteNamespaceCommand
    );
    expect(deleteCalls).toHaveLength(3);
  });

  it('retries when the in-use signal surfaces via the async operation failure message', async () => {
    // DeleteNamespace accepted, but the operation itself fails with the
    // associated-services message (the async spelling of the same race).
    mockSend
      .mockResolvedValueOnce({ OperationId: 'op-1' })
      .mockResolvedValueOnce({
        Operation: {
          Status: 'FAIL',
          ErrorMessage: 'Namespace has associated services; delete the services first',
        },
      })
      .mockResolvedValueOnce({ OperationId: 'op-2' })
      .mockResolvedValueOnce({
        Operation: { Status: 'SUCCESS', Targets: { NAMESPACE: 'ns-test' } },
      });

    await expect(
      provider.delete('Namespace', 'ns-test', 'AWS::ServiceDiscovery::PrivateDnsNamespace')
    ).resolves.toBeUndefined();

    const deleteCalls = mockSend.mock.calls.filter(
      ([cmd]) => cmd instanceof DeleteNamespaceCommand
    );
    expect(deleteCalls).toHaveLength(2);
  });

  it('does NOT retry on other errors — fails fast with a wrapped ProvisioningError', async () => {
    mockSend.mockRejectedValueOnce(new Error('Access Denied'));

    await expect(
      provider.delete('Namespace', 'ns-test', 'AWS::ServiceDiscovery::PrivateDnsNamespace')
    ).rejects.toThrow(ProvisioningError);

    const deleteCalls = mockSend.mock.calls.filter(
      ([cmd]) => cmd instanceof DeleteNamespaceCommand
    );
    expect(deleteCalls).toHaveLength(1);
  });

  it('surfaces the in-use error after the bounded budget is exhausted', async () => {
    mockSend.mockRejectedValue(resourceInUse());

    await expect(
      provider.delete('Namespace', 'ns-test', 'AWS::ServiceDiscovery::PrivateDnsNamespace')
    ).rejects.toThrow(/has associated services/);

    const deleteCalls = mockSend.mock.calls.filter(
      ([cmd]) => cmd instanceof DeleteNamespaceCommand
    );
    // 1 initial attempt + 24 retries.
    expect(deleteCalls).toHaveLength(25);
  });
});
