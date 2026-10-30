import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateTrailCommand } from '@aws-sdk/client-cloudtrail';

const mockSend = vi.fn();
// Hoisted with the logger factory: it builds its child logger EAGERLY, so an
// outer `const` would hit the TDZ.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock('@aws-sdk/client-cloudtrail', async () => {
  const actual = await vi.importActual('@aws-sdk/client-cloudtrail');
  return {
    ...actual,
    CloudTrailClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
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

import { CloudTrailProvider } from '../../../src/provisioning/providers/cloudtrail-provider.js';
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';
import type { UpdateContext } from '../../../src/types/resource.js';
import { loadSchemaFixture } from './_property-coverage-utils.js';

const TRAIL_ARN = 'arn:aws:cloudtrail:us-east-1:0:trail/my-trail';
const TYPE = 'AWS::CloudTrail::Trail';
const BASE = { S3BucketName: 'my-bucket', IsLogging: true };

/** The single UpdateTrail input; asserts it was actually sent. */
function updateTrailInput(): Record<string, unknown> {
  const calls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateTrailCommand);
  expect(calls).toHaveLength(1);
  return calls[0]![0].input as Record<string, unknown>;
}

function warnings(): string[] {
  return warnSpy.mock.calls.map((c) => String(c[0]));
}

/** Runs the update the way the deploy engine does: removal prep, then update(). */
async function deployUpdate(
  desired: Record<string, unknown>,
  previous: Record<string, unknown>,
  extra: Partial<UpdateContext> = {}
): Promise<readonly string[]> {
  const provider = new CloudTrailProvider();
  const prep = prepareRemovalForUpdate(provider, TYPE, desired, previous);
  await provider.update('Trail', TRAIL_ARN, TYPE, prep.properties, previous, {
    ...prep.context,
    ...extra,
  });
  return prep.unhandled;
}

describe('CloudTrailProvider removals kept while CloudFormation is unmeasured (#5541)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
  });

  describe('IsOrganizationTrail', () => {
    it('removed: sends nothing for it and names it in the kept-removal warning', async () => {
      const unhandled = await deployUpdate(BASE, { ...BASE, IsOrganizationTrail: true });

      expect(updateTrailInput()['IsOrganizationTrail']).toBeUndefined();
      // The shared caller's line would claim a CloudFormation reset.
      expect(unhandled).toEqual([]);
      const lines = warnings();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('Trail (AWS::CloudTrail::Trail): property IsOrganizationTrail');
      expect(lines[0]).toContain('removed from the template');
      expect(lines[0]).toContain('whether CloudFormation resets it is unmeasured');
      expect(lines[0]).not.toContain('CloudFormation would reset');
    });

    it('present: a declared value still goes through, with no warning', async () => {
      await deployUpdate(
        { ...BASE, IsOrganizationTrail: true },
        { ...BASE, IsOrganizationTrail: false }
      );

      expect(updateTrailInput()['IsOrganizationTrail']).toBe(true);
      expect(warnings()).toEqual([]);
    });

    it('never present: sends nothing and warns nothing', async () => {
      await deployUpdate(BASE, BASE);

      expect(updateTrailInput()['IsOrganizationTrail']).toBeUndefined();
      expect(warnings()).toEqual([]);
    });

    it('a removed FALSE is not named: either CloudFormation answer leaves it false', async () => {
      const unhandled = await deployUpdate(BASE, { ...BASE, IsOrganizationTrail: false });

      expect(updateTrailInput()['IsOrganizationTrail']).toBeUndefined();
      expect(unhandled).toEqual([]);
      expect(warnings()).toEqual([]);
    });

    it('a direct call (no caller context) warns from the two bags', async () => {
      await new CloudTrailProvider().update('Trail', TRAIL_ARN, TYPE, BASE, {
        ...BASE,
        IsOrganizationTrail: true,
      });

      expect(updateTrailInput()['IsOrganizationTrail']).toBeUndefined();
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain('property IsOrganizationTrail was removed');
    });

    it('a rollback revert says what the rollback leaves, not a template removal', async () => {
      await deployUpdate(BASE, { ...BASE, IsOrganizationTrail: true }, { replayingState: true });

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain('IsOrganizationTrail is absent from the state being restored');
      expect(warnings()[0]).not.toContain('removed from the template');
    });

    it('drift --revert (an AWS readback previous side) warns nothing', async () => {
      await new CloudTrailProvider().update(
        'Trail',
        TRAIL_ARN,
        TYPE,
        BASE,
        { ...BASE, IsOrganizationTrail: true },
        { desiredFromAwsReadback: true }
      );

      expect(updateTrailInput()['IsOrganizationTrail']).toBeUndefined();
      expect(warnings()).toEqual([]);
    });
  });

  describe('IncludeGlobalServiceEvents', () => {
    it('kept on a multi-region trail: named in the same warning', async () => {
      const desired = { ...BASE, IsMultiRegionTrail: true };
      const unhandled = await deployUpdate(desired, {
        ...desired,
        IncludeGlobalServiceEvents: true,
      });

      expect(updateTrailInput()['IncludeGlobalServiceEvents']).toBeUndefined();
      expect(unhandled).toEqual([]);
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain('property IncludeGlobalServiceEvents was removed');
    });

    it('reset on a single-region trail: no warning', async () => {
      const desired = { ...BASE, IsMultiRegionTrail: false };
      await deployUpdate(desired, { ...desired, IncludeGlobalServiceEvents: true });

      expect(updateTrailInput()['IncludeGlobalServiceEvents']).toBe(false);
      expect(warnings()).toEqual([]);
    });

    it.each([false, 'false'])(
      'a removed previous %s is not named: the trail was single-region, live already equals the reset',
      async (prev) => {
        for (const desired of [BASE, { ...BASE, IsMultiRegionTrail: true }]) {
          warnSpy.mockClear();
          await deployUpdate(desired, { ...desired, IncludeGlobalServiceEvents: prev });
          expect(warnings().join('\n')).not.toContain('IncludeGlobalServiceEvents');
          mockSend.mockClear();
        }
      }
    );

    it('IsMultiRegionTrail undeclared on both sides: a removed true is named (may be multi-region)', async () => {
      await deployUpdate(BASE, { ...BASE, IncludeGlobalServiceEvents: true });

      expect(updateTrailInput()['IncludeGlobalServiceEvents']).toBeUndefined();
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain('property IncludeGlobalServiceEvents was removed');
    });

    it('both kept properties share ONE line', async () => {
      const desired = { ...BASE, IsMultiRegionTrail: true };
      await deployUpdate(desired, {
        ...desired,
        IncludeGlobalServiceEvents: true,
        IsOrganizationTrail: true,
      });

      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain(
        'properties IsOrganizationTrail, IncludeGlobalServiceEvents were removed'
      );
    });
  });

  it('the audit covers every writable schema Trail property: the shared caller line never fires', () => {
    const provider = new CloudTrailProvider();
    const schema = loadSchemaFixture(TYPE)!;
    const readOnly = new Set(schema.readOnlyProperties);
    const handled = schema.properties.filter((key) => !readOnly.has(key));
    const previous = Object.fromEntries(handled.map((key) => [key, 'x']));
    const prep = prepareRemovalForUpdate(provider, TYPE, {}, previous);

    expect(handled.length).toBeGreaterThan(10);
    expect(prep.unhandled).toEqual([]);
  });
});
