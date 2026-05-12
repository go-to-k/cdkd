import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DeleteInternetGatewayCommand, DetachInternetGatewayCommand } from '@aws-sdk/client-ec2';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

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

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * Tests for `EC2Provider` IGW + VPCGatewayAttachment delete retry budget
 * extension on `DependencyViolation` errors. AWS releases an EC2
 * Instance's auto-assigned public IP → IGW mapping asynchronously after
 * `TerminateInstances` (5–10 min lag); the standard cdkd retry budget
 * (~1 min) is insufficient. The new in-provider helper extends the
 * budget to 10 min (configurable for tests) so destroys after
 * `--remove-protection` are self-healing.
 */
describe('EC2Provider IGW DependencyViolation retry', () => {
  let provider: EC2Provider;
  // Override the per-instance sleep so tests don't wait real time.
  // Replaces the helper's `setTimeout`-based sleep with an immediate
  // resolve so `vi.useFakeTimers()` is not needed (the helper's
  // exponential-backoff scheduling is exercised through call counts
  // and per-attempt delays are validated separately).
  const installFastSleep = (p: EC2Provider): void => {
    (p as unknown as { sleep: (ms: number) => Promise<void> }).sleep = vi.fn(() =>
      Promise.resolve()
    );
  };

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EC2Provider();
    installFastSleep(provider);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper: build an AWS-shaped DependencyViolation error.
  const dependencyViolationError = (
    message = 'The internetGateway has dependencies and cannot be deleted.'
  ): Error => {
    const err = new Error(message);
    (err as Error & { name: string; Code: string }).name = 'DependencyViolation';
    (err as Error & { name: string; Code: string }).Code = 'DependencyViolation';
    return err;
  };

  describe('deleteInternetGateway', () => {
    it('retries on DependencyViolation until success', async () => {
      // Throw DependencyViolation 3 times, then succeed.
      let calls = 0;
      mockSend.mockImplementation((cmd) => {
        if (cmd instanceof DeleteInternetGatewayCommand) {
          calls += 1;
          if (calls <= 3) return Promise.reject(dependencyViolationError());
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      await provider.delete('Igw', 'igw-1', 'AWS::EC2::InternetGateway', {});

      const igwCalls = mockSend.mock.calls.filter(
        (c) => c[0] instanceof DeleteInternetGatewayCommand
      );
      expect(igwCalls).toHaveLength(4); // 3 failed + 1 successful
    });

    it('retries on DependencyViolation message variant ("mapped public address(es)")', async () => {
      let calls = 0;
      mockSend.mockImplementation((cmd) => {
        if (cmd instanceof DeleteInternetGatewayCommand) {
          calls += 1;
          if (calls <= 1) {
            // The exact AWS message for the public-IP-still-mapped case.
            return Promise.reject(
              new Error(
                'Network has some mapped public address(es). Please unmap those public address(es) before detaching the gateway.'
              )
            );
          }
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      await provider.delete('Igw', 'igw-1', 'AWS::EC2::InternetGateway', {});

      const igwCalls = mockSend.mock.calls.filter(
        (c) => c[0] instanceof DeleteInternetGatewayCommand
      );
      expect(igwCalls).toHaveLength(2);
    });

    it('propagates non-DependencyViolation errors immediately (no retry)', async () => {
      const accessDenied = new Error(
        'User is not authorized to perform: ec2:DeleteInternetGateway'
      );
      (accessDenied as Error & { name: string; Code: string }).name = 'UnauthorizedOperation';
      (accessDenied as Error & { name: string; Code: string }).Code = 'UnauthorizedOperation';

      mockSend.mockImplementation((cmd) => {
        if (cmd instanceof DeleteInternetGatewayCommand) return Promise.reject(accessDenied);
        return Promise.resolve({});
      });

      await expect(
        provider.delete('Igw', 'igw-1', 'AWS::EC2::InternetGateway', {})
      ).rejects.toBeInstanceOf(ProvisioningError);

      const igwCalls = mockSend.mock.calls.filter(
        (c) => c[0] instanceof DeleteInternetGatewayCommand
      );
      // Exactly one attempt — non-DependencyViolation must NOT retry.
      expect(igwCalls).toHaveLength(1);
    });

    it('exhausts budget and throws on persistent DependencyViolation', async () => {
      // Override the helper's budget via a tiny custom call. Use the
      // private method directly so we can pass a 1ms budget without
      // hitting the 10-min default.
      mockSend.mockImplementation(() => Promise.reject(dependencyViolationError()));

      await expect(
        (
          provider as unknown as {
            withDependencyViolationRetry: <T>(
              op: () => Promise<T>,
              opts: { description: string; totalBudgetMs?: number }
            ) => Promise<T>;
          }
        ).withDependencyViolationRetry(
          () => mockSend(new DeleteInternetGatewayCommand({ InternetGatewayId: 'igw-1' })),
          { description: 'test', totalBudgetMs: 1 }
        )
      ).rejects.toThrow('has dependencies');

      // At least one attempt must have fired; the budget exhausting is
      // checked after the throw resolves.
      expect(mockSend).toHaveBeenCalled();
    });
  });

  describe('deleteVpcGatewayAttachment', () => {
    it('retries on DependencyViolation until success', async () => {
      let calls = 0;
      mockSend.mockImplementation((cmd) => {
        if (cmd instanceof DetachInternetGatewayCommand) {
          calls += 1;
          if (calls <= 2) return Promise.reject(dependencyViolationError());
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      await provider.delete('Attach', 'igw-1|vpc-1', 'AWS::EC2::VPCGatewayAttachment', {});

      const detachCalls = mockSend.mock.calls.filter(
        (c) => c[0] instanceof DetachInternetGatewayCommand
      );
      expect(detachCalls).toHaveLength(3); // 2 failed + 1 successful
    });

    it('propagates non-DependencyViolation errors immediately (no retry)', async () => {
      const throttle = new Error('Rate exceeded');
      (throttle as Error & { name: string; Code: string }).name = 'Throttling';
      (throttle as Error & { name: string; Code: string }).Code = 'Throttling';

      mockSend.mockImplementation((cmd) => {
        if (cmd instanceof DetachInternetGatewayCommand) return Promise.reject(throttle);
        return Promise.resolve({});
      });

      await expect(
        provider.delete('Attach', 'igw-1|vpc-1', 'AWS::EC2::VPCGatewayAttachment', {})
      ).rejects.toBeInstanceOf(ProvisioningError);

      const detachCalls = mockSend.mock.calls.filter(
        (c) => c[0] instanceof DetachInternetGatewayCommand
      );
      expect(detachCalls).toHaveLength(1);
    });

    it('exhausts budget and throws on persistent DependencyViolation', async () => {
      mockSend.mockImplementation(() => Promise.reject(dependencyViolationError()));

      await expect(
        (
          provider as unknown as {
            withDependencyViolationRetry: <T>(
              op: () => Promise<T>,
              opts: { description: string; totalBudgetMs?: number }
            ) => Promise<T>;
          }
        ).withDependencyViolationRetry(
          () =>
            mockSend(
              new DetachInternetGatewayCommand({
                InternetGatewayId: 'igw-1',
                VpcId: 'vpc-1',
              })
            ),
          { description: 'test', totalBudgetMs: 1 }
        )
      ).rejects.toThrow('has dependencies');

      expect(mockSend).toHaveBeenCalled();
    });
  });

  describe('not-found idempotency preserved', () => {
    it('deleteInternetGateway: NotFound short-circuits without retry', async () => {
      const notFound = new Error('The internetGateway igw-1 does not exist');
      (notFound as Error & { name: string }).name = 'InvalidInternetGatewayID.NotFound';

      mockSend.mockImplementation((cmd) => {
        if (cmd instanceof DeleteInternetGatewayCommand) return Promise.reject(notFound);
        return Promise.resolve({});
      });

      // Same region as state region → idempotent success.
      await provider.delete(
        'Igw',
        'igw-1',
        'AWS::EC2::InternetGateway',
        {},
        {
          expectedRegion: 'us-east-1',
        }
      );

      const igwCalls = mockSend.mock.calls.filter(
        (c) => c[0] instanceof DeleteInternetGatewayCommand
      );
      expect(igwCalls).toHaveLength(1);
    });

    it('deleteVpcGatewayAttachment: NotFound short-circuits without retry', async () => {
      const notFound = new Error('not found');
      (notFound as Error & { name: string }).name = 'InvalidInternetGatewayID.NotFound';

      mockSend.mockImplementation((cmd) => {
        if (cmd instanceof DetachInternetGatewayCommand) return Promise.reject(notFound);
        return Promise.resolve({});
      });

      await provider.delete(
        'Attach',
        'igw-1|vpc-1',
        'AWS::EC2::VPCGatewayAttachment',
        {},
        {
          expectedRegion: 'us-east-1',
        }
      );

      const detachCalls = mockSend.mock.calls.filter(
        (c) => c[0] instanceof DetachInternetGatewayCommand
      );
      expect(detachCalls).toHaveLength(1);
    });
  });
});
