import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateHttpNamespaceCommand,
  CreatePrivateDnsNamespaceCommand,
  CreatePublicDnsNamespaceCommand,
  CreateServiceCommand,
  DeleteServiceCommand,
  GetNamespaceCommand,
  GetOperationCommand,
  UpdateServiceAttributesCommand,
} from '@aws-sdk/client-servicediscovery';

// go-to-k/cdkd#4583: a namespace or service this create made and left behind is
// named for `cdkd rollback --revert-failed`; one it cleaned up, a refusal, and
// a create that never produced a resource are not.

const { mockSend, stsSend } = vi.hoisted(() => ({ mockSend: vi.fn(), stsSend: vi.fn() }));

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

vi.mock('@aws-sdk/client-sts', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-sts')>('@aws-sdk/client-sts');
  return { ...actual, STSClient: vi.fn().mockImplementation(() => ({ send: stsSend })) };
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
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const PRIVATE = 'AWS::ServiceDiscovery::PrivateDnsNamespace';
const HTTP = 'AWS::ServiceDiscovery::HttpNamespace';
const PUBLIC = 'AWS::ServiceDiscovery::PublicDnsNamespace';
const SERVICE = 'AWS::ServiceDiscovery::Service';

async function failure(
  provider: ServiceDiscoveryProvider,
  type: string,
  properties: Record<string, unknown>
): Promise<unknown> {
  return provider.create('Res', type, properties).then(
    () => expect.fail('create resolved'),
    (e: unknown) => e
  );
}

describe('ServiceDiscoveryProvider createdBeforeFailure mark (go-to-k/cdkd#4583)', () => {
  let provider: ServiceDiscoveryProvider;

  beforeEach(() => {
    mockSend.mockReset();
    stsSend.mockReset();
    provider = new ServiceDiscoveryProvider();
  });

  describe('namespaces', () => {
    // The create operation succeeds; the ARN lookup after it fails (GetNamespace
    // gives no ARN, then STS for the built ARN fails).
    function primeOperation(status: 'SUCCESS' | 'FAIL', targets: object = { NAMESPACE: 'ns-1' }): void {
      mockSend.mockImplementation(async (command: unknown) => {
        if (
          command instanceof CreatePrivateDnsNamespaceCommand ||
          command instanceof CreateHttpNamespaceCommand ||
          command instanceof CreatePublicDnsNamespaceCommand
        ) {
          return { OperationId: 'op-1' };
        }
        if (command instanceof GetOperationCommand) {
          return status === 'SUCCESS'
            ? { Operation: { Status: 'SUCCESS', Targets: targets } }
            : { Operation: { Status: 'FAIL', ErrorMessage: 'operation boom' } };
        }
        if (command instanceof GetNamespaceCommand) return { Namespace: {} };
        throw new Error(`unexpected ${String(command)}`);
      });
      stsSend.mockRejectedValue(new Error('sts boom'));
    }

    it.each([
      [PRIVATE, { Name: 'ns.local', Vpc: 'vpc-1' }],
      [HTTP, { Name: 'ns' }],
      [PUBLIC, { Name: 'ns.example.com' }],
    ])('marks the namespace id when the ARN lookup fails after the create (%s)', async (type, props) => {
      primeOperation('SUCCESS');
      expect(createdBeforeFailure(await failure(provider, type, props), 'Res', type)).toBe('ns-1');
    });

    it.each([
      [PRIVATE, { Name: 'ns.local', Vpc: 'vpc-1' }],
      [HTTP, { Name: 'ns' }],
      [PUBLIC, { Name: 'ns.example.com' }],
    ])(
      'does not mark the operation id pollOperation falls back to when AWS names no namespace (%s)',
      async (type, props) => {
        primeOperation('SUCCESS', {});
        const error = await failure(provider, type, props);
        expect(String(error)).toContain('sts boom');
        expect(createdBeforeFailure(error, 'Res', type)).toBeUndefined();
      }
    );

    it('does not mark when the create operation FAILED', async () => {
      primeOperation('FAIL');
      const error = await failure(provider, HTTP, { Name: 'ns' });
      expect(String(error)).toContain('operation boom');
      expect(createdBeforeFailure(error, 'Res', HTTP)).toBeUndefined();
    });

    it('does not mark when the create call itself fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('NamespaceAlreadyExists'));
      expect(
        createdBeforeFailure(await failure(provider, HTTP, { Name: 'ns' }), 'Res', HTTP)
      ).toBeUndefined();
    });

    it('does not mark a pre-flight refusal', async () => {
      const error = await failure(provider, PRIVATE, { Name: 'ns.local' });
      expect(mockSend).not.toHaveBeenCalled();
      expect(createdBeforeFailure(error, 'Res', PRIVATE)).toBeUndefined();
    });
  });

  describe('service', () => {
    const props = { Name: 'svc', ServiceAttributes: { team: 'cdkd' } };

    function prime(cleanup: 'ok' | 'fail'): void {
      mockSend.mockImplementation(async (command: unknown) => {
        if (command instanceof CreateServiceCommand) {
          return { Service: { Id: 'srv-1', Arn: 'arn:aws:servicediscovery:us-east-1:1:service/srv-1' } };
        }
        if (command instanceof UpdateServiceAttributesCommand) throw new Error('attributes boom');
        if (command instanceof DeleteServiceCommand) {
          if (cleanup === 'fail') throw new Error('DeleteService boom');
          return {};
        }
        throw new Error(`unexpected ${String(command)}`);
      });
    }

    it('marks the service id when the attributes fail and the cleanup delete fails', async () => {
      prime('fail');
      expect(createdBeforeFailure(await failure(provider, SERVICE, props), 'Res', SERVICE)).toBe(
        'srv-1'
      );
    });

    it('does not mark when the cleanup delete succeeded', async () => {
      prime('ok');
      const error = await failure(provider, SERVICE, props);
      expect(mockSend.mock.calls.some((c) => c[0] instanceof DeleteServiceCommand)).toBe(true);
      expect(createdBeforeFailure(error, 'Res', SERVICE)).toBeUndefined();
    });

    it('does not mark when CreateService itself fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('CreateService boom'));
      expect(
        createdBeforeFailure(await failure(provider, SERVICE, props), 'Res', SERVICE)
      ).toBeUndefined();
    });
  });
});
