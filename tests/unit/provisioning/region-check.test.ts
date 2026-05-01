import { describe, it, expect } from 'vitest';
import { assertRegionMatch } from '../../../src/provisioning/region-check.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

describe('assertRegionMatch', () => {
  const resourceType = 'AWS::Lambda::Function';
  const logicalId = 'MyFn';
  const physicalId = 'fn-123';

  describe('when expectedRegion is undefined', () => {
    it('returns silently regardless of clientRegion', () => {
      // Back-compat: callers that have not been threaded with a state region
      // must continue to see the previous idempotent NotFound behavior.
      expect(() =>
        assertRegionMatch('us-east-1', undefined, resourceType, logicalId, physicalId)
      ).not.toThrow();

      expect(() =>
        assertRegionMatch(undefined, undefined, resourceType, logicalId, physicalId)
      ).not.toThrow();
    });
  });

  describe('when clientRegion equals expectedRegion', () => {
    it('returns silently', () => {
      expect(() =>
        assertRegionMatch('us-east-1', 'us-east-1', resourceType, logicalId, physicalId)
      ).not.toThrow();
    });
  });

  describe('when clientRegion does not match expectedRegion', () => {
    it('throws ProvisioningError mentioning both regions', () => {
      expect(() =>
        assertRegionMatch('us-east-1', 'us-west-2', resourceType, logicalId, physicalId)
      ).toThrow(ProvisioningError);

      try {
        assertRegionMatch('us-east-1', 'us-west-2', resourceType, logicalId, physicalId);
        // Should be unreachable.
        expect.fail('expected ProvisioningError to be thrown');
      } catch (err) {
        const e = err as ProvisioningError;
        expect(e).toBeInstanceOf(ProvisioningError);
        expect(e.message).toContain('us-east-1');
        expect(e.message).toContain('us-west-2');
        expect(e.message).toContain(logicalId);
        expect(e.message).toContain(resourceType);
        expect(e.resourceType).toBe(resourceType);
        expect(e.logicalId).toBe(logicalId);
        expect(e.physicalId).toBe(physicalId);
      }
    });

    it('includes a hint to rerun with --region', () => {
      try {
        assertRegionMatch('us-east-1', 'eu-west-1', resourceType, logicalId, physicalId);
        expect.fail('expected ProvisioningError');
      } catch (err) {
        expect((err as Error).message).toContain('--region eu-west-1');
      }
    });
  });

  describe('when clientRegion is undefined and expectedRegion is set', () => {
    it('throws ProvisioningError', () => {
      // We refuse to silently swallow NotFound when we cannot even determine
      // what region the client is operating against — the resource may live
      // in expectedRegion and the destroy run would otherwise strip it from
      // state without ever calling AWS in the right region.
      expect(() =>
        assertRegionMatch(undefined, 'us-west-2', resourceType, logicalId, physicalId)
      ).toThrow(ProvisioningError);
    });
  });

  it('omits physicalId from the error when not provided', () => {
    try {
      assertRegionMatch('us-east-1', 'us-west-2', resourceType, logicalId);
      expect.fail('expected ProvisioningError');
    } catch (err) {
      const e = err as ProvisioningError;
      expect(e.physicalId).toBeUndefined();
    }
  });
});
