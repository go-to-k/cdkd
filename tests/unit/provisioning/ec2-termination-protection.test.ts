import { describe, it, expect, vi } from 'vite-plus/test';
import type { EC2Client } from '@aws-sdk/client-ec2';
import {
  disableInstanceApiTermination,
  isTerminationProtectionPropagationError,
  TERMINATION_PROTECTION_MAX_ATTEMPTS,
} from '../../../src/provisioning/ec2-termination-protection.js';

const logger = { debug: () => {} };

describe('ec2-termination-protection helpers', () => {
  describe('isTerminationProtectionPropagationError', () => {
    it('matches the SDK / Cloud Control "may not be terminated" 400', () => {
      expect(
        isTerminationProtectionPropagationError(
          "The instance 'i-abc' may not be terminated. Modify its 'disableApiTermination' instance attribute and try again."
        )
      ).toBe(true);
    });
    it('matches a Cloud Control DeleteResource wrapper of the same error', () => {
      expect(
        isTerminationProtectionPropagationError(
          "DELETE failed for ProtectedInstance: The instance 'i-abc' may not be terminated. Modify its 'disableApiTermination'..."
        )
      ).toBe(true);
    });
    it('does NOT match unrelated terminate errors', () => {
      expect(isTerminationProtectionPropagationError('InsufficientInstanceCapacity')).toBe(false);
      expect(isTerminationProtectionPropagationError('DependencyViolation')).toBe(false);
    });
  });

  describe('disableInstanceApiTermination', () => {
    it('sends ModifyInstanceAttribute with DisableApiTermination=false', async () => {
      const send = vi.fn((_cmd: unknown) => Promise.resolve({}));
      const client = { send } as unknown as EC2Client;

      await disableInstanceApiTermination(client, 'i-abc', logger);

      expect(send).toHaveBeenCalledTimes(1);
      const cmd = send.mock.calls[0]![0] as { constructor: { name: string }; input: unknown };
      expect(cmd.constructor.name).toBe('ModifyInstanceAttributeCommand');
      expect(cmd.input).toEqual({ InstanceId: 'i-abc', DisableApiTermination: { Value: false } });
    });

    it('swallows errors (non-fatal) so the caller can still attempt the delete', async () => {
      const send = vi.fn(() => Promise.reject(new Error('AccessDenied')));
      const client = { send } as unknown as EC2Client;

      await expect(disableInstanceApiTermination(client, 'i-abc', logger)).resolves.toBeUndefined();
    });
  });

  it('exposes a retry budget greater than 1', () => {
    expect(TERMINATION_PROTECTION_MAX_ATTEMPTS).toBeGreaterThan(1);
  });
});
