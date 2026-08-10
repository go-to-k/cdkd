import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock AWS clients before importing the provider
const mockSend = vi.fn();

vi.mock('@aws-sdk/client-route-53', async () => {
  const actual = await vi.importActual('@aws-sdk/client-route-53');
  return {
    ...actual,
    Route53Client: vi.fn().mockImplementation(() => ({ send: mockSend, config: { region: () => Promise.resolve('us-east-1') } })),
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

import {
  Route53Provider,
  isZoneDisabledForMutationError,
} from '../../../src/provisioning/providers/route53-provider.js';

describe('Route53Provider', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new Route53Provider();
  });

  // ─── AWS::Route53::HostedZone ──────────────────────────────────────

  describe('HostedZone', () => {
    describe('create', () => {
      it('should create hosted zone and return zone ID without /hostedzone/ prefix', async () => {
        mockSend.mockResolvedValueOnce({
          HostedZone: { Id: '/hostedzone/Z1234567890' },
          DelegationSet: {
            NameServers: ['ns-1.example.com', 'ns-2.example.com'],
          },
        });

        const result = await provider.create(
          'MyZone',
          'AWS::Route53::HostedZone',
          { Name: 'example.com' }
        );

        expect(result.physicalId).toBe('Z1234567890');
        expect(result.attributes).toEqual({
          Id: 'Z1234567890',
          NameServers: 'ns-1.example.com,ns-2.example.com',
        });
        expect(mockSend).toHaveBeenCalledTimes(1);

        const createCall = mockSend.mock.calls[0][0];
        expect(createCall.constructor.name).toBe('CreateHostedZoneCommand');
        expect(createCall.input.Name).toBe('example.com');
      });
    });

    describe('HostedZoneFeatures', () => {
      it('create: enables AcceleratedRecovery via post-create UpdateHostedZoneFeatures', async () => {
        // Create returns zone
        mockSend.mockResolvedValueOnce({
          HostedZone: { Id: '/hostedzone/Z1234567890' },
          DelegationSet: { NameServers: ['ns-1.example.com'] },
        });
        // UpdateHostedZoneFeatures resolves
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyZone', 'AWS::Route53::HostedZone', {
          Name: 'example.com',
          HostedZoneFeatures: { AcceleratedRecoveryStatus: 'ENABLED' },
        });

        expect(mockSend).toHaveBeenCalledTimes(2);
        const createCall = mockSend.mock.calls[0][0];
        const uhfCall = mockSend.mock.calls[1][0];
        expect(createCall.constructor.name).toBe('CreateHostedZoneCommand');
        expect(uhfCall.constructor.name).toBe('UpdateHostedZoneFeaturesCommand');
        expect(uhfCall.input).toEqual({
          HostedZoneId: 'Z1234567890',
          EnableAcceleratedRecovery: true,
        });
      });

      it('create: omits UpdateHostedZoneFeatures when HostedZoneFeatures is absent', async () => {
        mockSend.mockResolvedValueOnce({
          HostedZone: { Id: '/hostedzone/Z1234567890' },
          DelegationSet: { NameServers: [] },
        });

        await provider.create('MyZone', 'AWS::Route53::HostedZone', {
          Name: 'example.com',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateHostedZoneCommand');
      });

      it('create: omits UpdateHostedZoneFeatures when AcceleratedRecoveryStatus=DISABLED (matches AWS default)', async () => {
        mockSend.mockResolvedValueOnce({
          HostedZone: { Id: '/hostedzone/Z1234567890' },
          DelegationSet: { NameServers: [] },
        });

        await provider.create('MyZone', 'AWS::Route53::HostedZone', {
          Name: 'example.com',
          HostedZoneFeatures: { AcceleratedRecoveryStatus: 'DISABLED' },
        });

        // Only CreateHostedZone fires — DISABLED is the AWS default so we skip
        // the explicit toggle call.
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateHostedZoneCommand');
      });

      it('create: rolls back via DeleteHostedZone when UpdateHostedZoneFeatures fails (atomicity)', async () => {
        mockSend.mockResolvedValueOnce({
          HostedZone: { Id: '/hostedzone/Z1234567890' },
          DelegationSet: { NameServers: [] },
        });
        // UpdateHostedZoneFeatures fails
        mockSend.mockRejectedValueOnce(new Error('AccessDenied on UpdateHostedZoneFeatures'));
        // Rollback path also detaches any query logging config first
        // (HostedZoneNotEmpty would otherwise block DeleteHostedZone when
        // create() configured QueryLoggingConfig). ListQueryLoggingConfigs
        // returns empty → no DeleteQueryLoggingConfig fires.
        mockSend.mockResolvedValueOnce({ QueryLoggingConfigs: [] });
        // DeleteHostedZone (rollback) resolves
        mockSend.mockResolvedValueOnce({});

        await expect(
          provider.create('MyZone', 'AWS::Route53::HostedZone', {
            Name: 'example.com',
            HostedZoneFeatures: { AcceleratedRecoveryStatus: 'ENABLED' },
          })
        ).rejects.toThrow(/Failed to enable Accelerated Recovery/);

        // Sequence: CreateHostedZone → UpdateHostedZoneFeatures (fails) →
        // ListQueryLoggingConfigs (rollback QLC pre-cleanup) → DeleteHostedZone (rollback)
        expect(mockSend).toHaveBeenCalledTimes(4);
        expect(mockSend.mock.calls[0][0].constructor.name).toBe('CreateHostedZoneCommand');
        expect(mockSend.mock.calls[1][0].constructor.name).toBe('UpdateHostedZoneFeaturesCommand');
        expect(mockSend.mock.calls[2][0].constructor.name).toBe('ListQueryLoggingConfigsCommand');
        expect(mockSend.mock.calls[3][0].constructor.name).toBe('DeleteHostedZoneCommand');
      });

      it('update: prev=DISABLED → next=ENABLED fires UpdateHostedZoneFeatures', async () => {
        // updateHostedZone fires UpdateHostedZoneComment + (when diffed)
        // UpdateHostedZoneFeatures + final GetHostedZone for NS read.
        // applyHostedZoneTags / applyQueryLoggingConfig / syncVPCAssociations
        // no-op without their property set in `properties`.
        mockSend.mockResolvedValueOnce({}); // UpdateHostedZoneComment
        mockSend.mockResolvedValueOnce({}); // UpdateHostedZoneFeatures
        mockSend.mockResolvedValueOnce({ DelegationSet: { NameServers: [] } }); // GetHostedZone (final, for NS)

        await provider.update(
          'MyZone',
          'Z1234567890',
          'AWS::Route53::HostedZone',
          { Name: 'example.com', HostedZoneFeatures: { AcceleratedRecoveryStatus: 'ENABLED' } },
          { Name: 'example.com', HostedZoneFeatures: { AcceleratedRecoveryStatus: 'DISABLED' } }
        );

        const uhfCalls = mockSend.mock.calls.filter(
          (c) => c[0].constructor.name === 'UpdateHostedZoneFeaturesCommand'
        );
        expect(uhfCalls).toHaveLength(1);
        expect(uhfCalls[0][0].input).toEqual({
          HostedZoneId: 'Z1234567890',
          EnableAcceleratedRecovery: true,
        });
      });

      it('update: prev=ENABLED → next=undefined fires UpdateHostedZoneFeatures(false) (treat absent as DISABLED)', async () => {
        mockSend.mockResolvedValueOnce({}); // UpdateHostedZoneComment
        mockSend.mockResolvedValueOnce({}); // UpdateHostedZoneFeatures
        mockSend.mockResolvedValueOnce({ DelegationSet: { NameServers: [] } });

        await provider.update(
          'MyZone',
          'Z1234567890',
          'AWS::Route53::HostedZone',
          { Name: 'example.com' },
          { Name: 'example.com', HostedZoneFeatures: { AcceleratedRecoveryStatus: 'ENABLED' } }
        );

        const uhfCalls = mockSend.mock.calls.filter(
          (c) => c[0].constructor.name === 'UpdateHostedZoneFeaturesCommand'
        );
        expect(uhfCalls).toHaveLength(1);
        expect(uhfCalls[0][0].input).toEqual({
          HostedZoneId: 'Z1234567890',
          EnableAcceleratedRecovery: false,
        });
      });

      it('update: unchanged AcceleratedRecoveryStatus does NOT fire UpdateHostedZoneFeatures', async () => {
        mockSend.mockResolvedValueOnce({}); // UpdateHostedZoneComment
        mockSend.mockResolvedValueOnce({ DelegationSet: { NameServers: [] } }); // GetHostedZone (final)

        await provider.update(
          'MyZone',
          'Z1234567890',
          'AWS::Route53::HostedZone',
          { Name: 'example.com', HostedZoneFeatures: { AcceleratedRecoveryStatus: 'ENABLED' } },
          { Name: 'example.com', HostedZoneFeatures: { AcceleratedRecoveryStatus: 'ENABLED' } }
        );

        const uhfCalls = mockSend.mock.calls.filter(
          (c) => c[0].constructor.name === 'UpdateHostedZoneFeaturesCommand'
        );
        expect(uhfCalls).toHaveLength(0);
      });
    });

    // Nested-container guard for the `??` defaulting class (issue #1493).
    // `HostedZoneConfig` is INDEXED on both paths, so a string / array /
    // unresolved intrinsic yielded `undefined` and the comment silently
    // vanished on create — and on update it WIPED a live comment, because
    // UpdateHostedZoneComment is a whole-value write.
    describe('malformed HostedZoneConfig (issue #1493)', () => {
      it('refuses a string container on create instead of dropping the comment', async () => {
        await expect(
          provider.create('MyZone', 'AWS::Route53::HostedZone', {
            Name: 'example.com',
            HostedZoneConfig: 'my comment',
          })
        ).rejects.toThrow(
          /AWS::Route53::HostedZone HostedZoneConfig must be an object \(got a string\)/
        );
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('refuses a string container on update instead of wiping the live comment', async () => {
        await expect(
          provider.update(
            'MyZone',
            'Z1234567890',
            'AWS::Route53::HostedZone',
            { Name: 'example.com', HostedZoneConfig: 'my comment' },
            { Name: 'example.com' }
          )
        ).rejects.toThrow(/AWS::Route53::HostedZone HostedZoneConfig must be an object/);
        expect(mockSend).not.toHaveBeenCalled();
      });

      it('still sends the comment for a well-formed container', async () => {
        mockSend.mockResolvedValueOnce({
          HostedZone: { Id: '/hostedzone/Z1234567890', Name: 'example.com.' },
          DelegationSet: { NameServers: ['ns-1.example.com'] },
        });

        await provider.create('MyZone', 'AWS::Route53::HostedZone', {
          Name: 'example.com',
          HostedZoneConfig: { Comment: 'my comment' },
        });

        expect(mockSend.mock.calls[0][0].input.HostedZoneConfig).toMatchObject({
          Comment: 'my comment',
        });
      });

      it('still omits HostedZoneConfig entirely when the container is absent', async () => {
        mockSend.mockResolvedValueOnce({
          HostedZone: { Id: '/hostedzone/Z1234567890', Name: 'example.com.' },
          DelegationSet: { NameServers: ['ns-1.example.com'] },
        });

        await provider.create('MyZone', 'AWS::Route53::HostedZone', { Name: 'example.com' });

        expect(mockSend.mock.calls[0][0].input.HostedZoneConfig).toBeUndefined();
      });
    });

    describe('delete', () => {
      it('should delete hosted zone', async () => {
        // 1. ListQueryLoggingConfigs (cleanup before delete)
        mockSend.mockResolvedValueOnce({ QueryLoggingConfigs: [] });
        // 2. GetHostedZone (pre-delete AcceleratedRecovery probe; no
        //    Features block → short-circuits, no disable needed)
        mockSend.mockResolvedValueOnce({ HostedZone: { Id: '/hostedzone/Z1234567890' } });
        // 3. DeleteHostedZone
        mockSend.mockResolvedValueOnce({});

        await provider.delete(
          'MyZone',
          'Z1234567890',
          'AWS::Route53::HostedZone'
        );

        expect(mockSend).toHaveBeenCalledTimes(3);

        const listCall = mockSend.mock.calls[0][0];
        expect(listCall.constructor.name).toBe('ListQueryLoggingConfigsCommand');

        const probeCall = mockSend.mock.calls[1][0];
        expect(probeCall.constructor.name).toBe('GetHostedZoneCommand');

        const deleteCall = mockSend.mock.calls[2][0];
        expect(deleteCall.constructor.name).toBe('DeleteHostedZoneCommand');
        expect(deleteCall.input.Id).toBe('Z1234567890');
      });

      it('should handle NoSuchHostedZone', async () => {
        // ListQueryLoggingConfigs succeeds (or fails gracefully)
        mockSend.mockResolvedValueOnce({ QueryLoggingConfigs: [] });
        // GetHostedZone (AcceleratedRecovery probe) throws NoSuchHostedZone
        // → probe returns undefined and short-circuits; DeleteHostedZone
        // still fires and re-encounters NoSuchHostedZone, which the
        // existing idempotent-delete catch handles.
        const probeError = new Error('No such hosted zone');
        probeError.name = 'NoSuchHostedZone';
        mockSend.mockRejectedValueOnce(probeError);
        // DeleteHostedZone throws NoSuchHostedZone
        const error = new Error('No such hosted zone');
        error.name = 'NoSuchHostedZone';
        mockSend.mockRejectedValueOnce(error);

        await provider.delete(
          'MyZone',
          'Z1234567890',
          'AWS::Route53::HostedZone'
        );

        expect(mockSend).toHaveBeenCalledTimes(3);
      });

      it('disables AcceleratedRecovery and waits for DISABLED before DeleteHostedZone', async () => {
        // Speed up the test by overriding the poll interval to near-zero.
        process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'] = '1';
        process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'] = '5000';
        try {
          // 1. ListQueryLoggingConfigs
          mockSend.mockResolvedValueOnce({ QueryLoggingConfigs: [] });
          // 2. GetHostedZone (probe) → ENABLED
          mockSend.mockResolvedValueOnce({
            HostedZone: {
              Id: '/hostedzone/Z1234567890',
              Features: { AcceleratedRecoveryStatus: 'ENABLED' },
            },
          });
          // 3. UpdateHostedZoneFeatures(false)
          mockSend.mockResolvedValueOnce({});
          // 4. Poll GetHostedZone → DISABLING
          mockSend.mockResolvedValueOnce({
            HostedZone: {
              Id: '/hostedzone/Z1234567890',
              Features: { AcceleratedRecoveryStatus: 'DISABLING' },
            },
          });
          // 5. Poll GetHostedZone → DISABLED (settle)
          mockSend.mockResolvedValueOnce({
            HostedZone: {
              Id: '/hostedzone/Z1234567890',
              Features: { AcceleratedRecoveryStatus: 'DISABLED' },
            },
          });
          // 6. DeleteHostedZone
          mockSend.mockResolvedValueOnce({});

          await provider.delete('MyZone', 'Z1234567890', 'AWS::Route53::HostedZone');

          expect(mockSend).toHaveBeenCalledTimes(6);
          const uhfCall = mockSend.mock.calls[2][0];
          expect(uhfCall.constructor.name).toBe('UpdateHostedZoneFeaturesCommand');
          expect(uhfCall.input).toEqual({
            HostedZoneId: 'Z1234567890',
            EnableAcceleratedRecovery: false,
          });
          expect(mockSend.mock.calls[5][0].constructor.name).toBe('DeleteHostedZoneCommand');
        } finally {
          delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'];
          delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'];
        }
      });

      it('waits through DISABLING_HOSTED_ZONE_LOCKED (transient) to DISABLED before DeleteHostedZone', async () => {
        // Regression: AWS briefly locks the zone mid-disable, surfacing
        // DISABLING_HOSTED_ZONE_LOCKED. cdkd previously treated this as a
        // terminal "operator must resolve" failure; it is actually a
        // transient sub-state that settles to DISABLED on its own.
        process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'] = '1';
        process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'] = '5000';
        try {
          // 1. ListQueryLoggingConfigs
          mockSend.mockResolvedValueOnce({ QueryLoggingConfigs: [] });
          // 2. GetHostedZone (probe) → ENABLED
          mockSend.mockResolvedValueOnce({
            HostedZone: {
              Id: '/hostedzone/Z1234567890',
              Features: { AcceleratedRecoveryStatus: 'ENABLED' },
            },
          });
          // 3. UpdateHostedZoneFeatures(false)
          mockSend.mockResolvedValueOnce({});
          // 4. Poll GetHostedZone → DISABLING
          mockSend.mockResolvedValueOnce({
            HostedZone: {
              Id: '/hostedzone/Z1234567890',
              Features: { AcceleratedRecoveryStatus: 'DISABLING' },
            },
          });
          // 5. Poll GetHostedZone → DISABLING_HOSTED_ZONE_LOCKED (transient)
          mockSend.mockResolvedValueOnce({
            HostedZone: {
              Id: '/hostedzone/Z1234567890',
              Features: { AcceleratedRecoveryStatus: 'DISABLING_HOSTED_ZONE_LOCKED' },
            },
          });
          // 6. Poll GetHostedZone → DISABLED (settle)
          mockSend.mockResolvedValueOnce({
            HostedZone: {
              Id: '/hostedzone/Z1234567890',
              Features: { AcceleratedRecoveryStatus: 'DISABLED' },
            },
          });
          // 7. DeleteHostedZone
          mockSend.mockResolvedValueOnce({});

          await provider.delete('MyZone', 'Z1234567890', 'AWS::Route53::HostedZone');

          expect(mockSend).toHaveBeenCalledTimes(7);
          expect(mockSend.mock.calls[2][0].constructor.name).toBe('UpdateHostedZoneFeaturesCommand');
          expect(mockSend.mock.calls[6][0].constructor.name).toBe('DeleteHostedZoneCommand');
        } finally {
          delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'];
          delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'];
        }
      });

      it('initial probe already DISABLING_HOSTED_ZONE_LOCKED: waits to DISABLED without re-issuing disable', async () => {
        // The pre-delete probe can catch the zone already mid-disable AND
        // briefly locked. cdkd must NOT re-issue UpdateHostedZoneFeatures (a
        // disable is already in flight) — just wait through the lock transient
        // to DISABLED, then delete. Exercises the Phase-2 'already disabling'
        // branch directly from the initial probe (the branch the bug report
        // says AWS surfaces transiently).
        process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'] = '1';
        process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'] = '5000';
        try {
          // 1. ListQueryLoggingConfigs
          mockSend.mockResolvedValueOnce({ QueryLoggingConfigs: [] });
          // 2. GetHostedZone (probe) → DISABLING_HOSTED_ZONE_LOCKED (transient)
          mockSend.mockResolvedValueOnce({
            HostedZone: {
              Id: '/hostedzone/Z1234567890',
              Features: { AcceleratedRecoveryStatus: 'DISABLING_HOSTED_ZONE_LOCKED' },
            },
          });
          // 3. Poll GetHostedZone → DISABLED (settle)
          mockSend.mockResolvedValueOnce({
            HostedZone: {
              Id: '/hostedzone/Z1234567890',
              Features: { AcceleratedRecoveryStatus: 'DISABLED' },
            },
          });
          // 4. DeleteHostedZone
          mockSend.mockResolvedValueOnce({});

          await provider.delete('MyZone', 'Z1234567890', 'AWS::Route53::HostedZone');

          expect(mockSend).toHaveBeenCalledTimes(4);
          // No UpdateHostedZoneFeatures: a disable was already in flight, and a
          // LOCKED transient must NOT be treated as a terminal failure.
          const uhfCalls = mockSend.mock.calls.filter(
            (c) => c[0].constructor.name === 'UpdateHostedZoneFeaturesCommand'
          );
          expect(uhfCalls).toHaveLength(0);
          expect(mockSend.mock.calls[3][0].constructor.name).toBe('DeleteHostedZoneCommand');
        } finally {
          delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'];
          delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'];
        }
      });

      it('waits through ENABLING_HOSTED_ZONE_LOCKED (transient) before issuing disable', async () => {
        // Probe finds the zone mid-enable and briefly locked. cdkd must wait
        // for the enable to settle (AWS rejects a disable while enabling is in
        // flight), then issue the disable and wait for DISABLED — NOT bail.
        process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'] = '1';
        process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'] = '5000';
        try {
          // 1. ListQueryLoggingConfigs
          mockSend.mockResolvedValueOnce({ QueryLoggingConfigs: [] });
          // 2. GetHostedZone (probe) → ENABLING_HOSTED_ZONE_LOCKED (transient)
          mockSend.mockResolvedValueOnce({
            HostedZone: {
              Id: '/hostedzone/Z1234567890',
              Features: { AcceleratedRecoveryStatus: 'ENABLING_HOSTED_ZONE_LOCKED' },
            },
          });
          // 3. Phase-1 poll → ENABLED (enable settled)
          mockSend.mockResolvedValueOnce({
            HostedZone: {
              Id: '/hostedzone/Z1234567890',
              Features: { AcceleratedRecoveryStatus: 'ENABLED' },
            },
          });
          // 4. UpdateHostedZoneFeatures(false)
          mockSend.mockResolvedValueOnce({});
          // 5. Phase-2 poll → DISABLED (settle)
          mockSend.mockResolvedValueOnce({
            HostedZone: {
              Id: '/hostedzone/Z1234567890',
              Features: { AcceleratedRecoveryStatus: 'DISABLED' },
            },
          });
          // 6. DeleteHostedZone
          mockSend.mockResolvedValueOnce({});

          await provider.delete('MyZone', 'Z1234567890', 'AWS::Route53::HostedZone');

          expect(mockSend).toHaveBeenCalledTimes(6);
          expect(mockSend.mock.calls[3][0].constructor.name).toBe('UpdateHostedZoneFeaturesCommand');
          expect(mockSend.mock.calls[5][0].constructor.name).toBe('DeleteHostedZoneCommand');
        } finally {
          delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'];
          delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'];
        }
      });

      it('skips UpdateHostedZoneFeatures when AcceleratedRecovery already DISABLED', async () => {
        mockSend.mockResolvedValueOnce({ QueryLoggingConfigs: [] });
        // GetHostedZone (probe) → DISABLED — no disable + poll needed
        mockSend.mockResolvedValueOnce({
          HostedZone: {
            Id: '/hostedzone/Z1234567890',
            Features: { AcceleratedRecoveryStatus: 'DISABLED' },
          },
        });
        mockSend.mockResolvedValueOnce({}); // DeleteHostedZone

        await provider.delete('MyZone', 'Z1234567890', 'AWS::Route53::HostedZone');

        expect(mockSend).toHaveBeenCalledTimes(3);
        const uhfCalls = mockSend.mock.calls.filter(
          (c) => c[0].constructor.name === 'UpdateHostedZoneFeaturesCommand'
        );
        expect(uhfCalls).toHaveLength(0);
      });

      it('refuses delete when AcceleratedRecovery is in a failed state', async () => {
        mockSend.mockResolvedValueOnce({ QueryLoggingConfigs: [] });
        // GetHostedZone (probe) → ENABLE_FAILED — operator must resolve
        mockSend.mockResolvedValueOnce({
          HostedZone: {
            Id: '/hostedzone/Z1234567890',
            Features: { AcceleratedRecoveryStatus: 'ENABLE_FAILED' },
          },
        });

        await expect(
          provider.delete('MyZone', 'Z1234567890', 'AWS::Route53::HostedZone')
        ).rejects.toThrow(/AcceleratedRecoveryStatus is 'ENABLE_FAILED'/);

        // No UpdateHostedZoneFeatures, no DeleteHostedZone should fire.
        expect(mockSend.mock.calls).toHaveLength(2);
      });
    });
  });

  // ─── AWS::Route53::RecordSet ───────────────────────────────────────

  describe('RecordSet', () => {
    describe('create', () => {
      it('should create record set with composite physicalId (zoneId|name|type)', async () => {
        mockSend.mockResolvedValueOnce({});

        const result = await provider.create(
          'MyRecord',
          'AWS::Route53::RecordSet',
          {
            HostedZoneId: 'Z1234567890',
            Name: 'www.example.com.',
            Type: 'A',
            TTL: '300',
            ResourceRecords: ['1.2.3.4'],
          }
        );

        expect(result.physicalId).toBe('Z1234567890|www.example.com.|A');
        expect(mockSend).toHaveBeenCalledTimes(1);

        const changeCall = mockSend.mock.calls[0][0];
        expect(changeCall.constructor.name).toBe(
          'ChangeResourceRecordSetsCommand'
        );
        expect(changeCall.input.ChangeBatch.Changes[0].Action).toBe('CREATE');
      });

      it('should convert ResourceRecords strings to {Value} format', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyRecord', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z1234567890',
          Name: 'www.example.com.',
          Type: 'A',
          TTL: '300',
          ResourceRecords: ['1.2.3.4', '5.6.7.8'],
        });

        const changeCall = mockSend.mock.calls[0][0];
        const recordSet =
          changeCall.input.ChangeBatch.Changes[0].ResourceRecordSet;
        expect(recordSet.ResourceRecords).toEqual([
          { Value: '1.2.3.4' },
          { Value: '5.6.7.8' },
        ]);
      });

      it('should handle AliasTarget', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyAlias', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z1234567890',
          Name: 'www.example.com.',
          Type: 'A',
          AliasTarget: {
            HostedZoneId: 'Z2FDTNDATAQYW2',
            DNSName: 'd123456.cloudfront.net.',
            EvaluateTargetHealth: false,
          },
        });

        const changeCall = mockSend.mock.calls[0][0];
        const recordSet =
          changeCall.input.ChangeBatch.Changes[0].ResourceRecordSet;
        expect(recordSet.AliasTarget).toEqual({
          HostedZoneId: 'Z2FDTNDATAQYW2',
          DNSName: 'd123456.cloudfront.net.',
          EvaluateTargetHealth: false,
        });
        // AliasTarget records should not have TTL or ResourceRecords
        expect(recordSet.TTL).toBeUndefined();
        expect(recordSet.ResourceRecords).toBeUndefined();
      });

      it('should send GeoProximityLocation (AWSRegion + Bias) into the ChangeResourceRecordSets ResourceRecordSet', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyGeoProximity', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z1234567890',
          Name: 'geo.example.com.',
          Type: 'A',
          TTL: '300',
          ResourceRecords: ['198.51.100.1'],
          SetIdentifier: 'geo-use1',
          GeoProximityLocation: { AWSRegion: 'us-east-1', Bias: 10 },
        });

        const changeCall = mockSend.mock.calls[0][0];
        const recordSet =
          changeCall.input.ChangeBatch.Changes[0].ResourceRecordSet;
        expect(recordSet.SetIdentifier).toBe('geo-use1');
        expect(recordSet.GeoProximityLocation).toEqual({
          AWSRegion: 'us-east-1',
          Bias: 10,
        });
      });

      it('should coerce a string Bias to a number (CFn may emit numeric props as strings)', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyGeoProximityStrBias', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z1234567890',
          Name: 'geo3.example.com.',
          Type: 'A',
          TTL: '300',
          ResourceRecords: ['198.51.100.3'],
          SetIdentifier: 'geo-strbias',
          GeoProximityLocation: { AWSRegion: 'us-east-1', Bias: '10' },
        });

        const changeCall = mockSend.mock.calls[0][0];
        const recordSet =
          changeCall.input.ChangeBatch.Changes[0].ResourceRecordSet;
        // `Bias` must reach the SDK as a number, not the string '10'.
        expect(recordSet.GeoProximityLocation).toEqual({
          AWSRegion: 'us-east-1',
          Bias: 10,
        });
      });

      it('should map GeoProximityLocation Coordinates + LocalZoneGroup when present', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyGeoProximityCoords', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z1234567890',
          Name: 'geo2.example.com.',
          Type: 'A',
          TTL: '300',
          ResourceRecords: ['198.51.100.2'],
          SetIdentifier: 'geo-coords',
          GeoProximityLocation: {
            Coordinates: { Latitude: '49.22', Longitude: '-74.01' },
            Bias: 0,
          },
        });

        const changeCall = mockSend.mock.calls[0][0];
        const recordSet =
          changeCall.input.ChangeBatch.Changes[0].ResourceRecordSet;
        // Bias=0 must survive the omit-when-absent gate (falsy-value guard).
        expect(recordSet.GeoProximityLocation).toEqual({
          Coordinates: { Latitude: '49.22', Longitude: '-74.01' },
          Bias: 0,
        });
      });

      it('should omit GeoProximityLocation when absent', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyPlainRecord', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z1234567890',
          Name: 'www.example.com.',
          Type: 'A',
          TTL: '300',
          ResourceRecords: ['1.2.3.4'],
        });

        const changeCall = mockSend.mock.calls[0][0];
        const recordSet =
          changeCall.input.ChangeBatch.Changes[0].ResourceRecordSet;
        expect(recordSet.GeoProximityLocation).toBeUndefined();
      });

      it('should send CidrRoutingConfig (CollectionId + LocationName) into the ChangeResourceRecordSets ResourceRecordSet', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyCidrRecord', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z1234567890',
          Name: 'cidr.example.com.',
          Type: 'A',
          TTL: '300',
          ResourceRecords: ['198.51.100.4'],
          SetIdentifier: 'cidr-office',
          CidrRoutingConfig: { CollectionId: 'col-1234', LocationName: 'office' },
        });

        const changeCall = mockSend.mock.calls[0][0];
        const recordSet =
          changeCall.input.ChangeBatch.Changes[0].ResourceRecordSet;
        expect(recordSet.SetIdentifier).toBe('cidr-office');
        expect(recordSet.CidrRoutingConfig).toEqual({
          CollectionId: 'col-1234',
          LocationName: 'office',
        });
      });

      it('should map only the CidrRoutingConfig sub-fields that are present', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyCidrPartial', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z1234567890',
          Name: 'cidr2.example.com.',
          Type: 'A',
          TTL: '300',
          ResourceRecords: ['198.51.100.5'],
          SetIdentifier: 'cidr-default',
          // A default-location ('*') record still needs CollectionId.
          CidrRoutingConfig: { CollectionId: 'col-5678', LocationName: '*' },
        });

        const changeCall = mockSend.mock.calls[0][0];
        const recordSet =
          changeCall.input.ChangeBatch.Changes[0].ResourceRecordSet;
        expect(recordSet.CidrRoutingConfig).toEqual({
          CollectionId: 'col-5678',
          LocationName: '*',
        });
      });

      it('should omit CidrRoutingConfig when absent', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.create('MyNoCidrRecord', 'AWS::Route53::RecordSet', {
          HostedZoneId: 'Z1234567890',
          Name: 'plain2.example.com.',
          Type: 'A',
          TTL: '300',
          ResourceRecords: ['1.2.3.4'],
        });

        const changeCall = mockSend.mock.calls[0][0];
        const recordSet =
          changeCall.input.ChangeBatch.Changes[0].ResourceRecordSet;
        expect(recordSet.CidrRoutingConfig).toBeUndefined();
      });
    });

    describe('update', () => {
      it('should UPSERT record', async () => {
        mockSend.mockResolvedValueOnce({});

        const result = await provider.update(
          'MyRecord',
          'Z1234567890|www.example.com.|A',
          'AWS::Route53::RecordSet',
          {
            HostedZoneId: 'Z1234567890',
            Name: 'www.example.com.',
            Type: 'A',
            TTL: '600',
            ResourceRecords: ['1.2.3.4'],
          },
          {
            HostedZoneId: 'Z1234567890',
            Name: 'www.example.com.',
            Type: 'A',
            TTL: '300',
            ResourceRecords: ['1.2.3.4'],
          }
        );

        expect(result.physicalId).toBe('Z1234567890|www.example.com.|A');
        expect(result.wasReplaced).toBe(false);
        expect(mockSend).toHaveBeenCalledTimes(1);

        const changeCall = mockSend.mock.calls[0][0];
        expect(changeCall.input.ChangeBatch.Changes[0].Action).toBe('UPSERT');
      });
    });

    describe('delete', () => {
      it('should DELETE record', async () => {
        mockSend.mockResolvedValueOnce({});

        await provider.delete(
          'MyRecord',
          'Z1234567890|www.example.com.|A',
          'AWS::Route53::RecordSet',
          {
            HostedZoneId: 'Z1234567890',
            Name: 'www.example.com.',
            Type: 'A',
            TTL: '300',
            ResourceRecords: ['1.2.3.4'],
          }
        );

        expect(mockSend).toHaveBeenCalledTimes(1);

        const changeCall = mockSend.mock.calls[0][0];
        expect(changeCall.constructor.name).toBe(
          'ChangeResourceRecordSetsCommand'
        );
        expect(changeCall.input.ChangeBatch.Changes[0].Action).toBe('DELETE');
      });

      it('should handle not-found error (InvalidChangeBatch)', async () => {
        const error = new Error(
          'Tried to delete resource record set but it was not found'
        );
        error.name = 'InvalidChangeBatch';
        mockSend.mockRejectedValueOnce(error);

        await provider.delete(
          'MyRecord',
          'Z1234567890|www.example.com.|A',
          'AWS::Route53::RecordSet',
          {
            HostedZoneId: 'Z1234567890',
            Name: 'www.example.com.',
            Type: 'A',
            TTL: '300',
            ResourceRecords: ['1.2.3.4'],
          }
        );

        expect(mockSend).toHaveBeenCalledTimes(1);
      });

      // ─── issue #1467: zone mid AcceleratedRecovery transition ─────────
      // While the zone's AcceleratedRecoveryStatus is ENABLING, Route 53
      // refuses ChangeResourceRecordSets with "HostedZone <id> is marked
      // disabled for mutation". The delete path must wait for the
      // transition to settle and retry — without disabling the feature.
      const RECORD_PROPS = {
        HostedZoneId: 'Z1234567890',
        Name: 'www.example.com.',
        Type: 'A',
        TTL: '300',
        ResourceRecords: ['1.2.3.4'],
      };
      const deleteRecord = () =>
        provider.delete(
          'MyRecord',
          'Z1234567890|www.example.com.|A',
          'AWS::Route53::RecordSet',
          RECORD_PROPS
        );
      const disabledForMutation = () =>
        new Error('HostedZone Z1234567890 is marked disabled for mutation');
      const withFastPoll = async (fn: () => Promise<void>) => {
        process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'] = '1';
        process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'] = '2000';
        try {
          await fn();
        } finally {
          delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'];
          delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'];
        }
      };

      it('waits for the AcceleratedRecovery transition to settle and retries the delete (issue #1467)', async () =>
        withFastPoll(async () => {
          mockSend.mockReset();
          mockSend
            .mockRejectedValueOnce(disabledForMutation())
            .mockResolvedValueOnce({
              HostedZone: { Features: { AcceleratedRecoveryStatus: 'ENABLING' } },
            })
            .mockResolvedValueOnce({
              HostedZone: { Features: { AcceleratedRecoveryStatus: 'ENABLED' } },
            })
            .mockResolvedValueOnce({});

          await deleteRecord();

          expect(mockSend).toHaveBeenCalledTimes(4);
          expect(mockSend.mock.calls[0][0].constructor.name).toBe('ChangeResourceRecordSetsCommand');
          expect(mockSend.mock.calls[1][0].constructor.name).toBe('GetHostedZoneCommand');
          expect(mockSend.mock.calls[2][0].constructor.name).toBe('GetHostedZoneCommand');
          // The retry — the delete must NOT have issued any
          // UpdateHostedZoneFeatures (a record delete never flips the
          // zone-level feature).
          expect(mockSend.mock.calls[3][0].constructor.name).toBe('ChangeResourceRecordSetsCommand');
          expect(mockSend.mock.calls[3][0].input.ChangeBatch.Changes[0].Action).toBe('DELETE');
        }));

      it('surfaces an operator-recovery error when the transition lands in ENABLE_FAILED (issue #1467)', async () =>
        withFastPoll(async () => {
          mockSend.mockReset();
          mockSend
            .mockRejectedValueOnce(disabledForMutation())
            .mockResolvedValueOnce({
              HostedZone: { Features: { AcceleratedRecoveryStatus: 'ENABLE_FAILED' } },
            });

          const err: Error = await deleteRecord().then(
            () => {
              throw new Error('expected rejection');
            },
            (e: Error) => e
          );
          expect(err.message).toContain("AcceleratedRecoveryStatus is 'ENABLE_FAILED'");
          // The wait helper's ProvisioningError must surface as-is — the
          // outer catch's re-throw guard prevents the generic
          // "Failed to delete record set" double-wrap that would bury the
          // operator-recovery text in the cause chain.
          expect(err.message).not.toContain('Failed to delete record set');
        }));

      it('surfaces the settle timeout as an operator-actionable error (issue #1467)', async () => {
        process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'] = '1';
        process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'] = '30';
        try {
          mockSend.mockReset();
          mockSend.mockRejectedValueOnce(disabledForMutation()).mockResolvedValue({
            HostedZone: { Features: { AcceleratedRecoveryStatus: 'ENABLING' } },
          });

          const err: Error = await deleteRecord().then(
            () => {
              throw new Error('expected rejection');
            },
            (e: Error) => e
          );
          expect(err.message).toContain('Timed out after 30ms');
          expect(err.message).not.toContain('Failed to delete record set');
        } finally {
          delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'];
          delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'];
          // The persistent mockResolvedValue above survives
          // vi.clearAllMocks() (which clears calls, not implementations) —
          // reset here so it cannot leak into a later test that forgets its
          // own mockReset().
          mockSend.mockReset();
        }
      });

      it('treats a zone deleted during the settle wait as idempotent success (issue #1467)', async () =>
        withFastPoll(async () => {
          mockSend.mockReset();
          const gone = new Error('No hosted zone found with ID: Z1234567890');
          gone.name = 'NoSuchHostedZone';
          mockSend
            .mockRejectedValueOnce(disabledForMutation())
            // GetHostedZone during the wait: zone is gone → helper returns,
            // the retried ChangeResourceRecordSets then also sees the zone
            // gone → outer NoSuchHostedZone idempotency path.
            .mockRejectedValueOnce(gone)
            .mockRejectedValueOnce(gone);

          await expect(deleteRecord()).resolves.toBeUndefined();
          expect(mockSend).toHaveBeenCalledTimes(3);
        }));

      it('routes a not-found failure of the RETRY through the idempotency path (issue #1467)', async () =>
        withFastPoll(async () => {
          mockSend.mockReset();
          // Deliberately message-only (default Error name): pins the
          // message arm of the outer catch's OR-condition — the existing
          // not-found test above pins the InvalidChangeBatch name arm.
          const notFound = new Error(
            'Tried to delete resource record set but it was not found'
          );
          mockSend
            .mockRejectedValueOnce(disabledForMutation())
            .mockResolvedValueOnce({
              HostedZone: { Features: { AcceleratedRecoveryStatus: 'ENABLED' } },
            })
            // The retry finds the record already gone (deleted out-of-band
            // while we waited) → must land in the InvalidChangeBatch
            // idempotency path, not surface as a failure.
            .mockRejectedValueOnce(notFound);

          await expect(deleteRecord()).resolves.toBeUndefined();
          expect(mockSend).toHaveBeenCalledTimes(3);
        }));

      it('polls through every transient ARS status before retrying (issue #1467)', async () =>
        withFastPoll(async () => {
          mockSend.mockReset();
          mockSend
            .mockRejectedValueOnce(disabledForMutation())
            // Every documented in-flight status must be polled THROUGH (not
            // misclassified as terminal-failed): the *_HOSTED_ZONE_LOCKED
            // states are transient sub-states, DISABLING settles on its own.
            .mockResolvedValueOnce({
              HostedZone: { Features: { AcceleratedRecoveryStatus: 'ENABLING_HOSTED_ZONE_LOCKED' } },
            })
            .mockResolvedValueOnce({
              HostedZone: { Features: { AcceleratedRecoveryStatus: 'DISABLING_HOSTED_ZONE_LOCKED' } },
            })
            .mockResolvedValueOnce({
              HostedZone: { Features: { AcceleratedRecoveryStatus: 'DISABLING' } },
            })
            .mockResolvedValueOnce({
              HostedZone: { Features: { AcceleratedRecoveryStatus: 'DISABLED' } },
            })
            .mockResolvedValueOnce({});

          await expect(deleteRecord()).resolves.toBeUndefined();
          expect(mockSend).toHaveBeenCalledTimes(6);
          expect(mockSend.mock.calls[5][0].constructor.name).toBe('ChangeResourceRecordSetsCommand');
        }));

      it('retries immediately when the zone reports no Features block (issue #1467)', async () =>
        withFastPoll(async () => {
          mockSend.mockReset();
          mockSend
            .mockRejectedValueOnce(disabledForMutation())
            // GetHostedZone returns a zone with no Features → status
            // undefined → mutable, retry proceeds.
            .mockResolvedValueOnce({ HostedZone: {} })
            .mockResolvedValueOnce({});

          await expect(deleteRecord()).resolves.toBeUndefined();
          expect(mockSend).toHaveBeenCalledTimes(3);
        }));

      it('does not loop when the RETRY hits the mutation lock again (issue #1467)', async () =>
        withFastPoll(async () => {
          mockSend.mockReset();
          mockSend
            .mockRejectedValueOnce(disabledForMutation())
            .mockResolvedValueOnce({
              HostedZone: { Features: { AcceleratedRecoveryStatus: 'ENABLED' } },
            })
            // The retry fails with the SAME lock (zone re-entered a
            // transition). deleteRecordSet retries exactly once — the second
            // failure surfaces through the generic wrap, whose message still
            // matches RETRYABLE_ERROR_MESSAGE_PATTERNS so the engine-level
            // retry can pick it up.
            .mockRejectedValueOnce(disabledForMutation());

          const err: Error = await deleteRecord().then(
            () => {
              throw new Error('expected rejection');
            },
            (e: Error) => e
          );
          expect(err.message).toContain('Failed to delete record set MyRecord');
          expect(err.message).toContain('is marked disabled for mutation');
          // Exactly 3 sends: no second settle-wait, no unbounded loop.
          expect(mockSend).toHaveBeenCalledTimes(3);
        }));

      it('isZoneDisabledForMutationError matches the AWS wording and nothing else', () => {
        expect(
          isZoneDisabledForMutationError(
            new Error('HostedZone Z08017982576KEDFB5RGZ is marked disabled for mutation')
          )
        ).toBe(true);
        expect(isZoneDisabledForMutationError(new Error('Access Denied'))).toBe(false);
        expect(isZoneDisabledForMutationError('not-an-error')).toBe(false);
      });

      it('does not enter the settle-wait for unrelated mutation errors', async () => {
        mockSend.mockReset();
        mockSend.mockRejectedValueOnce(new Error('Access Denied'));

        await expect(deleteRecord()).rejects.toThrow(
          'Failed to delete record set MyRecord'
        );
        // No GetHostedZone poll — the error is not the mutation-disabled shape.
        expect(mockSend).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('import', () => {
    function makeInput(overrides: Record<string, unknown> = {}) {
      return {
        logicalId: 'MyZone',
        resourceType: 'AWS::Route53::HostedZone',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        ...overrides,
      };
    }

    it('explicit override (HostedZone): GetHostedZone verifies and returns id', async () => {
      mockSend.mockResolvedValueOnce({ HostedZone: { Id: '/hostedzone/Z123' } });

      const result = await provider.import(makeInput({ knownPhysicalId: 'Z123' }));

      expect(result).toEqual({ physicalId: 'Z123', attributes: {} });
      const call = mockSend.mock.calls[0][0];
      expect(call.constructor.name).toBe('GetHostedZoneCommand');
      expect(call.input).toEqual({ Id: 'Z123' });
    });

    it('returns null (HostedZone) without any AWS call when no override is given', async () => {
      // The `aws:cdk:path` tag walk is gone (issue #1134) -- AWS rejects
      // `aws:`-prefixed tag writes, so the tag never exists and the walk could
      // not match. Without `--resource` there is nothing left to look up, and
      // the provider must not burn a ListHostedZones page discovering that.
      const result = await provider.import(makeInput());

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('RecordSet: explicit override returned as-is, no AWS calls', async () => {
      const result = await provider.import(
        makeInput({
          resourceType: 'AWS::Route53::RecordSet',
          knownPhysicalId: 'Z123|www.example.com.|A',
        })
      );
      expect(result).toEqual({ physicalId: 'Z123|www.example.com.|A', attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('RecordSet: returns null without explicit override (not taggable)', async () => {
      const result = await provider.import(
        makeInput({ resourceType: 'AWS::Route53::RecordSet' })
      );
      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
