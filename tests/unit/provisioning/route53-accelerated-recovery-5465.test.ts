/**
 * Issue #5465: `HostedZoneFeatures`' only CloudFormation member is
 * `EnableAcceleratedRecovery` (boolean) — what aws-cdk-lib's
 * `CfnHostedZone.HostedZoneFeaturesProperty.enableAcceleratedRecovery`
 * emits. The provider used to read `AcceleratedRecoveryStatus` (the
 * GetHostedZone read-side status) instead, so a declared feature never
 * reached `UpdateHostedZoneFeatures`, and `readCurrentState` reported it
 * under the read-side key, which no template declares.
 *
 * As CloudFormation does, a create or update that toggles the feature returns
 * only once the zone's status settles at the requested value.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-route-53', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-route-53')>(
    '@aws-sdk/client-route-53'
  );
  return {
    ...actual,
    Route53Client: vi.fn().mockImplementation(() => ({
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

import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

const ZONE = 'Z1234567890';

/**
 * A fake Route 53: CreateHostedZone returns ZONE, and each GetHostedZone
 * answers the next status in `statuses` (the last one repeats; `undefined`
 * means no `Features` at all).
 */
function fakeAws(statuses: Array<string | undefined>): void {
  let reads = 0;
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'CreateHostedZoneCommand':
        return Promise.resolve({
          HostedZone: { Id: `/hostedzone/${ZONE}` },
          DelegationSet: { NameServers: [] },
        });
      case 'GetHostedZoneCommand': {
        const status = statuses[Math.min(reads, statuses.length - 1)];
        reads += 1;
        return Promise.resolve({
          HostedZone: {
            Id: `/hostedzone/${ZONE}`,
            Name: 'example.com.',
            ...(status !== undefined ? { Features: { AcceleratedRecoveryStatus: status } } : {}),
          },
          DelegationSet: { NameServers: [] },
        });
      }
      case 'ListTagsForResourceCommand':
        return Promise.resolve({ ResourceTagSet: { Tags: [] } });
      case 'ListQueryLoggingConfigsCommand':
        return Promise.resolve({ QueryLoggingConfigs: [] });
      default:
        return Promise.resolve({});
    }
  });
}

function sent(name: string): unknown[] {
  return mockSend.mock.calls
    .filter((c) => c[0].constructor.name === name)
    .map((c) => c[0].input);
}

describe('Route53 HostedZoneFeatures.EnableAcceleratedRecovery (#5465)', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    mockSend.mockReset();
    // A 1 ms poll keeps the settle loops instant; the timeout case sets its own.
    vi.stubEnv('CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS', '1');
    provider = new Route53Provider();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('create', () => {
    it.each([
      ['the boolean true', true],
      ["the string 'true' a resolved template can carry", 'true'],
    ])('enables it for %s', async (_label, value) => {
      fakeAws(['ENABLED']);

      await provider.create('Zone', 'AWS::Route53::HostedZone', {
        Name: 'example.com',
        HostedZoneFeatures: { EnableAcceleratedRecovery: value },
      });

      expect(sent('UpdateHostedZoneFeaturesCommand')).toEqual([
        { HostedZoneId: ZONE, EnableAcceleratedRecovery: true },
      ]);
    });

    it.each([
      ['false', { EnableAcceleratedRecovery: false }],
      ['an empty HostedZoneFeatures', {}],
      // The read-side status is not a template property: it must not enable it.
      [
        "the read-side key AcceleratedRecoveryStatus: 'ENABLED'",
        { AcceleratedRecoveryStatus: 'ENABLED' },
      ],
    ])('sends nothing and waits for nothing for %s', async (_label, features) => {
      fakeAws(['ENABLING']);

      await provider.create('Zone', 'AWS::Route53::HostedZone', {
        Name: 'example.com',
        HostedZoneFeatures: features,
      });

      expect(sent('UpdateHostedZoneFeaturesCommand')).toEqual([]);
      expect(sent('GetHostedZoneCommand')).toEqual([]);
    });

    it('returns only once the zone reports ENABLED, past a stale DISABLED and the lock', async () => {
      // DISABLED first: the read right after the enable can still show the
      // pre-call status, which must not count as settled.
      fakeAws(['DISABLED', 'ENABLING_HOSTED_ZONE_LOCKED', 'ENABLING', 'ENABLED']);

      await provider.create('Zone', 'AWS::Route53::HostedZone', {
        Name: 'example.com',
        HostedZoneFeatures: { EnableAcceleratedRecovery: true },
      });

      expect(sent('GetHostedZoneCommand')).toHaveLength(4);
    });

    it('keeps polling while an enabled zone reports no Features yet', async () => {
      fakeAws([undefined, 'ENABLED']);

      await provider.create('Zone', 'AWS::Route53::HostedZone', {
        Name: 'example.com',
        HostedZoneFeatures: { EnableAcceleratedRecovery: true },
      });

      expect(sent('GetHostedZoneCommand')).toHaveLength(2);
    });

    it('fails with the operator prompt on ENABLE_FAILED, recording the created zone', async () => {
      fakeAws(['ENABLING', 'ENABLE_FAILED']);

      const err = await provider
        .create('Zone', 'AWS::Route53::HostedZone', {
          Name: 'example.com',
          HostedZoneFeatures: { EnableAcceleratedRecovery: true },
        })
        .then(
          () => undefined,
          (e: unknown) => e
        );

      expect(err).toBeInstanceOf(ProvisioningError);
      expect((err as Error).message).toContain(
        "AcceleratedRecoveryStatus is 'ENABLE_FAILED' — operator must resolve before the hosted zone Zone can be deployed"
      );
      // The zone is live and locked, so it is NOT rolled back here.
      expect(sent('DeleteHostedZoneCommand')).toEqual([]);
    });

    it('fails fast on an ENABLE_FAILED read between polls, with no transition seen (a fresh zone has no earlier failure)', async () => {
      // A 60 s timeout: a wait that ignored the failure would fail the test on time.
      vi.stubEnv('CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS', '60000');
      fakeAws(['DISABLED', 'ENABLE_FAILED']);

      await expect(
        provider.create('Zone', 'AWS::Route53::HostedZone', {
          Name: 'example.com',
          HostedZoneFeatures: { EnableAcceleratedRecovery: true },
        })
      ).rejects.toThrow("AcceleratedRecoveryStatus is 'ENABLE_FAILED' — operator must resolve");
      expect(sent('GetHostedZoneCommand')).toHaveLength(2);
    });

    it('times out with a re-run hint when the transition never settles', async () => {
      vi.stubEnv('CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS', '20');
      fakeAws(['ENABLING_HOSTED_ZONE_LOCKED']);

      await expect(
        provider.create('Zone', 'AWS::Route53::HostedZone', {
          Name: 'example.com',
          HostedZoneFeatures: { EnableAcceleratedRecovery: true },
        })
      ).rejects.toThrow(
        /Timed out after 20ms .* after the enable of Accelerated Recovery \(hosted zone Zone\); re-run the deploy once the transition settles/
      );
    });
  });

  describe('update', () => {
    async function runUpdate(
      next: Record<string, unknown> | undefined,
      prev: Record<string, unknown> | undefined
    ): Promise<void> {
      await provider.update(
        'Zone',
        ZONE,
        'AWS::Route53::HostedZone',
        { Name: 'example.com', ...(next ? { HostedZoneFeatures: next } : {}) },
        { Name: 'example.com', ...(prev ? { HostedZoneFeatures: prev } : {}) }
      );
    }

    it('enables it when added, waiting for ENABLED', async () => {
      fakeAws(['ENABLING', 'ENABLED']);
      await runUpdate({ EnableAcceleratedRecovery: true }, undefined);
      expect(sent('UpdateHostedZoneFeaturesCommand')).toEqual([
        { HostedZoneId: ZONE, EnableAcceleratedRecovery: true },
      ]);
      // Two settle reads, then the final name-server read.
      expect(sent('GetHostedZoneCommand')).toHaveLength(3);
    });

    it('enables it when flipped false -> true', async () => {
      fakeAws(['ENABLED']);
      await runUpdate({ EnableAcceleratedRecovery: true }, { EnableAcceleratedRecovery: false });
      expect(sent('UpdateHostedZoneFeaturesCommand')).toEqual([
        { HostedZoneId: ZONE, EnableAcceleratedRecovery: true },
      ]);
    });

    it('disables it when flipped true -> false, waiting for DISABLED', async () => {
      fakeAws(['ENABLED', 'DISABLING_HOSTED_ZONE_LOCKED', 'DISABLING', 'DISABLED']);
      await runUpdate({ EnableAcceleratedRecovery: false }, { EnableAcceleratedRecovery: true });
      expect(sent('UpdateHostedZoneFeaturesCommand')).toEqual([
        { HostedZoneId: ZONE, EnableAcceleratedRecovery: false },
      ]);
      // A stale ENABLED read is not "settled" for a disable.
      expect(sent('GetHostedZoneCommand')).toHaveLength(5);
    });

    it('disables it when HostedZoneFeatures is removed', async () => {
      fakeAws(['DISABLED']);
      await runUpdate(undefined, { EnableAcceleratedRecovery: true });
      expect(sent('UpdateHostedZoneFeaturesCommand')).toEqual([
        { HostedZoneId: ZONE, EnableAcceleratedRecovery: false },
      ]);
    });

    it.each([
      ["only the spelling changes (true -> 'true')", { EnableAcceleratedRecovery: 'true' }, { EnableAcceleratedRecovery: true }],
      ['it stays enabled', { EnableAcceleratedRecovery: true }, { EnableAcceleratedRecovery: true }],
      ['it was never declared', undefined, undefined],
    ])('sends nothing and waits for nothing when %s', async (_label, next, prev) => {
      // A transition in flight would hang a wait that should not run at all.
      fakeAws(['ENABLING_HOSTED_ZONE_LOCKED']);
      await runUpdate(next, prev);
      expect(sent('UpdateHostedZoneFeaturesCommand')).toEqual([]);
      // Only the final name-server read.
      expect(sent('GetHostedZoneCommand')).toHaveLength(1);
    });

    it('disables an ENABLE_FAILED zone: the stale pre-call ENABLE_FAILED read does not fail the wait', async () => {
      fakeAws(['ENABLE_FAILED', 'DISABLING', 'DISABLED']);
      await runUpdate({ EnableAcceleratedRecovery: false }, { EnableAcceleratedRecovery: true });
      expect(sent('UpdateHostedZoneFeaturesCommand')).toEqual([
        { HostedZoneId: ZONE, EnableAcceleratedRecovery: false },
      ]);
    });

    it("fails a disable on the disable's own DISABLE_FAILED, once a transition was read", async () => {
      fakeAws(['DISABLING', 'DISABLE_FAILED']);
      await expect(
        runUpdate({ EnableAcceleratedRecovery: false }, { EnableAcceleratedRecovery: true })
      ).rejects.toThrow(
        "AcceleratedRecoveryStatus is 'DISABLE_FAILED' — operator must resolve before the hosted zone Zone can be deployed"
      );
    });

    it('re-sends a disable to a DISABLE_FAILED zone: the stale pre-call failure does not fail the wait', async () => {
      fakeAws(['DISABLE_FAILED', 'DISABLING', 'DISABLED']);
      await runUpdate({ EnableAcceleratedRecovery: false }, { EnableAcceleratedRecovery: true });
      expect(sent('GetHostedZoneCommand')).toHaveLength(4);
    });

    it('leaves an unbroken own-direction failure to the deadline, naming the last status', async () => {
      vi.stubEnv('CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS', '20');
      fakeAws(['DISABLE_FAILED']);
      await expect(
        runUpdate({ EnableAcceleratedRecovery: false }, { EnableAcceleratedRecovery: true })
      ).rejects.toThrow(/re-run the deploy once the transition settles \(last status: DISABLE_FAILED\)/);
    });

    it('fails when the zone disappears during the settle wait', async () => {
      fakeAws(['ENABLED']);
      const gone = Object.assign(new Error('No hosted zone found'), { name: 'NoSuchHostedZone' });
      const base = mockSend.getMockImplementation()!;
      let reads = 0;
      // Only the settle wait's read answers gone: the final name-server read
      // succeeds, so the rejection can only come from the wait.
      mockSend.mockImplementation((command: { constructor: { name: string } }) =>
        command.constructor.name === 'GetHostedZoneCommand' && reads++ === 0
          ? Promise.reject(gone)
          : base(command)
      );
      await expect(runUpdate({ EnableAcceleratedRecovery: true }, undefined)).rejects.toThrow(
        /No hosted zone found/
      );
    });

    describe('state recorded from a pre-#5465 read-side-key override', () => {
      // The pre-#5465 provider ENABLED a zone whose template overrode
      // `HostedZoneFeatures.AcceleratedRecoveryStatus: 'ENABLED'`; state holds that key.
      const legacyState = { AcceleratedRecoveryStatus: 'ENABLED' };

      it('disables the feature when the override is removed', async () => {
        fakeAws(['DISABLED']);
        await runUpdate(undefined, legacyState);
        expect(sent('UpdateHostedZoneFeaturesCommand')).toEqual([
          { HostedZoneId: ZONE, EnableAcceleratedRecovery: false },
        ]);
      });

      it('sends nothing and waits for nothing when it moves to EnableAcceleratedRecovery: true', async () => {
        fakeAws(['ENABLING_HOSTED_ZONE_LOCKED']);
        await runUpdate({ EnableAcceleratedRecovery: true }, legacyState);
        expect(sent('UpdateHostedZoneFeaturesCommand')).toEqual([]);
        expect(sent('GetHostedZoneCommand')).toHaveLength(1);
      });
    });

    describe('drift --revert onto a baseline recorded before #5465', () => {
      // The pre-#5465 readback recorded the read-side status; the revert passes
      // that baseline as the desired side and the new readback as the previous.
      const legacyBaseline = { AcceleratedRecoveryStatus: 'ENABLED' };
      const readback = { EnableAcceleratedRecovery: true };

      it('reads the legacy ENABLED as enabled, so nothing is disabled', async () => {
        fakeAws(['ENABLED']);
        await provider.update(
          'Zone',
          ZONE,
          'AWS::Route53::HostedZone',
          { Name: 'example.com', HostedZoneFeatures: legacyBaseline },
          { Name: 'example.com', HostedZoneFeatures: readback },
          { desiredFromAwsReadback: true }
        );
        expect(sent('UpdateHostedZoneFeaturesCommand')).toEqual([]);
      });

      it('an ordinary deploy still does not take the read-side key as a declaration', async () => {
        fakeAws(['DISABLED']);
        await provider.update(
          'Zone',
          ZONE,
          'AWS::Route53::HostedZone',
          { Name: 'example.com', HostedZoneFeatures: legacyBaseline },
          { Name: 'example.com', HostedZoneFeatures: readback }
        );
        expect(sent('UpdateHostedZoneFeaturesCommand')).toEqual([
          { HostedZoneId: ZONE, EnableAcceleratedRecovery: false },
        ]);
      });
    });

    it('times out with a re-run hint when the disable never settles', async () => {
      vi.stubEnv('CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS', '20');
      fakeAws(['DISABLING_HOSTED_ZONE_LOCKED']);
      await expect(runUpdate(undefined, { EnableAcceleratedRecovery: true })).rejects.toThrow(
        /after the disable of Accelerated Recovery \(hosted zone Zone\); re-run the deploy once the transition settles/
      );
    });
  });

  describe('readCurrentState', () => {
    it.each([
      ['ENABLED', true],
      ['ENABLING', true],
      ['ENABLING_HOSTED_ZONE_LOCKED', true],
      ['DISABLED', false],
      ['DISABLING', false],
      ['DISABLING_HOSTED_ZONE_LOCKED', false],
      ['ENABLE_FAILED', false],
      // A failed disable leaves the feature on.
      ['DISABLE_FAILED', true],
    ])('reports status %s as EnableAcceleratedRecovery: %s', async (status, expected) => {
      fakeAws([status]);

      const result = (await provider.readCurrentState(
        ZONE,
        'Zone',
        'AWS::Route53::HostedZone'
      )) as Record<string, unknown>;

      expect(result['HostedZoneFeatures']).toEqual({ EnableAcceleratedRecovery: expected });
    });
  });
});
