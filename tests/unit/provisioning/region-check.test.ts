import { describe, it, expect } from 'vite-plus/test';
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

  // Issue #2301 added the `phase` parameter. It changes the MESSAGE and
  // nothing else: the comparison, the three outcomes and the thrown type are
  // one implementation on purpose, because a second copy is how the reactive
  // and pre-flight halves would drift apart.
  describe('phase (issue #2301)', () => {
    it('defaults to the historical NotFound wording, so no pre-#2301 call site changed', () => {
      try {
        assertRegionMatch('us-east-1', 'us-west-2', resourceType, logicalId, physicalId);
        expect.fail('expected ProvisioningError');
      } catch (err) {
        expect((err as Error).message).toContain(
          'Refusing to treat NotFound as idempotent delete success'
        );
      }
    });

    it('words a pre-delete refusal as a delete that has not happened yet', () => {
      try {
        assertRegionMatch(
          'us-east-1',
          'us-west-2',
          resourceType,
          logicalId,
          physicalId,
          'pre-delete'
        );
        expect.fail('expected ProvisioningError');
      } catch (err) {
        const message = (err as Error).message;
        // The reactive wording would be actively FALSE here: no `NotFound`
        // was received and no state record is about to be stripped.
        expect(message).not.toContain('NotFound');
        expect(message).toContain(`Refusing to delete ${logicalId}`);
        // The remediation names the region to point the CLIENT at, and does
        // NOT recommend `--region`: that flag is deprecated on non-bootstrap
        // commands, and on the one path where this refusal actually bites --
        // `drift --all --revert`, which spans several regions in a single run
        // -- setting it correctly for one stack sets it wrongly for the rest.
        expect(message).toContain('Point the AWS client at us-west-2');
        expect(message).toContain('AWS_REGION or your AWS profile');
        expect(message).not.toContain('--region us-west-2');
      }
    });

    it('words a pre-update refusal as an update, not a delete', () => {
      try {
        assertRegionMatch(
          'us-east-1',
          'us-west-2',
          resourceType,
          logicalId,
          physicalId,
          'pre-update'
        );
        expect.fail('expected ProvisioningError');
      } catch (err) {
        const message = (err as Error).message;
        expect(message).toContain(`Refusing to update ${logicalId}`);
        expect(message).not.toContain('Refusing to delete');
      }
    });

    it('names the unknown CLIENT region in every phase, and still throws', () => {
      for (const phase of ['not-found', 'pre-delete', 'pre-update'] as const) {
        expect(() =>
          assertRegionMatch(undefined, 'us-west-2', resourceType, logicalId, physicalId, phase)
        ).toThrow(ProvisioningError);
      }
    });

    it('stays a no-op on an unset expected region in EVERY phase -- the guard must not reject its own default', () => {
      for (const phase of ['not-found', 'pre-delete', 'pre-update'] as const) {
        expect(() =>
          assertRegionMatch('us-east-1', undefined, resourceType, logicalId, physicalId, phase)
        ).not.toThrow();
        expect(() =>
          assertRegionMatch('us-east-1', '', resourceType, logicalId, physicalId, phase)
        ).not.toThrow();
      }
    });

    it('stays silent on a match in EVERY phase', () => {
      for (const phase of ['not-found', 'pre-delete', 'pre-update'] as const) {
        expect(() =>
          assertRegionMatch('eu-west-1', 'eu-west-1', resourceType, logicalId, physicalId, phase)
        ).not.toThrow();
      }
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
