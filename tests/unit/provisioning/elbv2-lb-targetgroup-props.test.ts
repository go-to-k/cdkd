import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// #609 ELBv2 LoadBalancer + TargetGroup silent-drop property backfill.
//
// LoadBalancer: EnablePrefixForIpv6SourceNat, Ipv4IpamPoolId,
// EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic,
// MinimumLoadBalancerCapacity, EnableCapacityReservationProvisionStabilize.
// TargetGroup: IpAddressType, TargetControlPort, TargetGroupAttributes,
// Targets.
//
// Every test here fails against the pre-#609 provider: none of these
// properties reached any AWS call (the silent-drop class).

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual('@aws-sdk/client-elastic-load-balancing-v2');
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
    waitUntilLoadBalancerAvailable: vi.fn().mockResolvedValue({ state: 'SUCCESS' }),
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
  ELBv2Provider,
  capacityReservationDelays,
} from '../../../src/provisioning/providers/elbv2-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const LB_TYPE = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
const TG_TYPE = 'AWS::ElasticLoadBalancingV2::TargetGroup';
const LB_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/my-nlb/1234567890abcdef';
const TG_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/my-tg/1234567890abcdef';

/** All send calls whose command constructor matches `name`. */
function callsOf(name: string) {
  return mockSend.mock.calls.filter((c) => c[0].constructor.name === name);
}

describe('ELBv2 LoadBalancer + TargetGroup silent-drop props (#609)', () => {
  let provider: ELBv2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new ELBv2Provider();
    // Default dispatch: CreateLoadBalancer / CreateTargetGroup return their
    // resource; DescribeTargetGroups returns a TG; everything else returns {}.
    mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      switch (cmd.constructor.name) {
        case 'CreateLoadBalancerCommand':
          return Promise.resolve({
            LoadBalancers: [{ LoadBalancerArn: LB_ARN, LoadBalancerName: 'my-nlb' }],
          });
        case 'CreateTargetGroupCommand':
          return Promise.resolve({
            TargetGroups: [{ TargetGroupArn: TG_ARN, TargetGroupName: 'my-tg' }],
          });
        case 'DescribeTargetGroupsCommand':
          return Promise.resolve({
            TargetGroups: [{ TargetGroupArn: TG_ARN, TargetGroupName: 'my-tg' }],
          });
        case 'DescribeCapacityReservationCommand':
          return Promise.resolve({
            CapacityReservationState: [{ State: { Code: 'provisioned' } }],
          });
        default:
          return Promise.resolve({});
      }
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ─── LoadBalancer create ────────────────────────────────────────────

  describe('LoadBalancer create', () => {
    it('forwards EnablePrefixForIpv6SourceNat and nests Ipv4IpamPoolId into IpamPools', async () => {
      await provider.create('MyNlb', LB_TYPE, {
        Name: 'my-nlb',
        Type: 'network',
        Subnets: ['subnet-111'],
        EnablePrefixForIpv6SourceNat: 'on',
        Ipv4IpamPoolId: 'ipam-pool-0abc',
      });

      const [createCall] = callsOf('CreateLoadBalancerCommand');
      expect(createCall[0].input.EnablePrefixForIpv6SourceNat).toBe('on');
      expect(createCall[0].input.IpamPools).toEqual({ Ipv4IpamPoolId: 'ipam-pool-0abc' });
    });

    it('applies EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic via post-create SetSecurityGroups', async () => {
      await provider.create('MyNlb', LB_TYPE, {
        Name: 'my-nlb',
        Type: 'network',
        Subnets: ['subnet-111'],
        SecurityGroups: ['sg-123'],
        EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: 'on',
      });

      const [sgCall] = callsOf('SetSecurityGroupsCommand');
      expect(sgCall).toBeDefined();
      expect(sgCall[0].input).toEqual({
        LoadBalancerArn: LB_ARN,
        SecurityGroups: ['sg-123'],
        EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: 'on',
      });
    });

    it('does NOT call SetSecurityGroups when the enforce flag is absent', async () => {
      await provider.create('MyNlb', LB_TYPE, {
        Name: 'my-nlb',
        Type: 'network',
        Subnets: ['subnet-111'],
        SecurityGroups: ['sg-123'],
      });
      expect(callsOf('SetSecurityGroupsCommand')).toHaveLength(0);
    });

    it('applies MinimumLoadBalancerCapacity via post-create ModifyCapacityReservation', async () => {
      await provider.create('MyAlb', LB_TYPE, {
        Name: 'my-alb',
        Subnets: ['subnet-111'],
        MinimumLoadBalancerCapacity: { CapacityUnits: '100' },
      });

      const [capCall] = callsOf('ModifyCapacityReservationCommand');
      expect(capCall).toBeDefined();
      expect(capCall[0].input).toEqual({
        LoadBalancerArn: LB_ARN,
        MinimumLoadBalancerCapacity: { CapacityUnits: 100 },
      });
      // No stabilize flag → no DescribeCapacityReservation poll.
      expect(callsOf('DescribeCapacityReservationCommand')).toHaveLength(0);
    });

    it('waits for the reservation to provision when EnableCapacityReservationProvisionStabilize is true', async () => {
      const sleep = vi
        .spyOn(capacityReservationDelays, 'sleep')
        .mockResolvedValue(undefined);
      let describeCount = 0;
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        switch (cmd.constructor.name) {
          case 'CreateLoadBalancerCommand':
            return Promise.resolve({ LoadBalancers: [{ LoadBalancerArn: LB_ARN }] });
          case 'DescribeCapacityReservationCommand':
            describeCount++;
            return Promise.resolve({
              CapacityReservationState: [
                { State: { Code: describeCount < 3 ? 'pending' : 'provisioned' } },
              ],
            });
          default:
            return Promise.resolve({});
        }
      });

      await provider.create('MyAlb', LB_TYPE, {
        Name: 'my-alb',
        Subnets: ['subnet-111'],
        MinimumLoadBalancerCapacity: { CapacityUnits: 100 },
        EnableCapacityReservationProvisionStabilize: true,
      });

      expect(describeCount).toBe(3);
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('skips the stabilize poll under CDKD_NO_WAIT=true', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      try {
        await provider.create('MyAlb', LB_TYPE, {
          Name: 'my-alb',
          Subnets: ['subnet-111'],
          MinimumLoadBalancerCapacity: { CapacityUnits: 100 },
          EnableCapacityReservationProvisionStabilize: true,
        });
      } finally {
        delete process.env['CDKD_NO_WAIT'];
      }
      // ModifyCapacityReservation still fires; only the poll is skipped.
      expect(callsOf('ModifyCapacityReservationCommand')).toHaveLength(1);
      expect(callsOf('DescribeCapacityReservationCommand')).toHaveLength(0);
    });

    it('warns and continues when the reservation never provisions within the bound', async () => {
      const sleep = vi
        .spyOn(capacityReservationDelays, 'sleep')
        .mockResolvedValue(undefined);
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        switch (cmd.constructor.name) {
          case 'CreateLoadBalancerCommand':
            return Promise.resolve({ LoadBalancers: [{ LoadBalancerArn: LB_ARN }] });
          case 'DescribeCapacityReservationCommand':
            return Promise.resolve({
              CapacityReservationState: [{ State: { Code: 'pending' } }],
            });
          default:
            return Promise.resolve({});
        }
      });

      // Timeout is deliberately NOT a failure — the reservation keeps
      // provisioning asynchronously and ModifyCapacityReservation succeeded.
      await expect(
        provider.create('MyAlb', LB_TYPE, {
          Name: 'my-alb',
          Subnets: ['subnet-111'],
          MinimumLoadBalancerCapacity: { CapacityUnits: 100 },
          EnableCapacityReservationProvisionStabilize: true,
        })
      ).resolves.toMatchObject({ physicalId: LB_ARN });
      expect(callsOf('DescribeCapacityReservationCommand')).toHaveLength(40);
      expect(sleep).toHaveBeenCalledTimes(40);
      // No partial-create cleanup on a timeout.
      expect(callsOf('DeleteLoadBalancerCommand')).toHaveLength(0);
    });

    it('treats a transient DescribeCapacityReservation error as still-pending, not a failure', async () => {
      const sleep = vi
        .spyOn(capacityReservationDelays, 'sleep')
        .mockResolvedValue(undefined);
      let describeCount = 0;
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        switch (cmd.constructor.name) {
          case 'CreateLoadBalancerCommand':
            return Promise.resolve({ LoadBalancers: [{ LoadBalancerArn: LB_ARN }] });
          case 'DescribeCapacityReservationCommand':
            describeCount++;
            if (describeCount === 1) return Promise.reject(new Error('Rate exceeded'));
            return Promise.resolve({
              CapacityReservationState: [{ State: { Code: 'provisioned' } }],
            });
          default:
            return Promise.resolve({});
        }
      });

      // A throttle mid-poll must NOT escape into the partial-create cleanup
      // (which would delete a healthy LB) — it counts as still-pending.
      await expect(
        provider.create('MyAlb', LB_TYPE, {
          Name: 'my-alb',
          Subnets: ['subnet-111'],
          MinimumLoadBalancerCapacity: { CapacityUnits: 100 },
          EnableCapacityReservationProvisionStabilize: true,
        })
      ).resolves.toMatchObject({ physicalId: LB_ARN });
      expect(describeCount).toBe(2);
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(callsOf('DeleteLoadBalancerCommand')).toHaveLength(0);
    });

    it('honors the raw-YAML string spelling "true" of the stabilize flag', async () => {
      vi.spyOn(capacityReservationDelays, 'sleep').mockResolvedValue(undefined);
      await provider.create('MyAlb', LB_TYPE, {
        Name: 'my-alb',
        Subnets: ['subnet-111'],
        MinimumLoadBalancerCapacity: { CapacityUnits: 100 },
        EnableCapacityReservationProvisionStabilize: 'true',
      });
      expect(callsOf('DescribeCapacityReservationCommand').length).toBeGreaterThan(0);
    });

    it('treats an empty zonal state list as provisioned', async () => {
      const sleep = vi
        .spyOn(capacityReservationDelays, 'sleep')
        .mockResolvedValue(undefined);
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        switch (cmd.constructor.name) {
          case 'CreateLoadBalancerCommand':
            return Promise.resolve({ LoadBalancers: [{ LoadBalancerArn: LB_ARN }] });
          case 'DescribeCapacityReservationCommand':
            return Promise.resolve({});
          default:
            return Promise.resolve({});
        }
      });

      await provider.create('MyAlb', LB_TYPE, {
        Name: 'my-alb',
        Subnets: ['subnet-111'],
        MinimumLoadBalancerCapacity: { CapacityUnits: 100 },
        EnableCapacityReservationProvisionStabilize: true,
      });
      expect(callsOf('DescribeCapacityReservationCommand')).toHaveLength(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it('throws and cleans up the LB when a zonal capacity reservation reports failed', async () => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        switch (cmd.constructor.name) {
          case 'CreateLoadBalancerCommand':
            return Promise.resolve({ LoadBalancers: [{ LoadBalancerArn: LB_ARN }] });
          case 'DescribeCapacityReservationCommand':
            return Promise.resolve({
              CapacityReservationState: [
                { State: { Code: 'failed', Reason: 'InsufficientCapacity' }, AvailabilityZone: 'us-east-1a' },
              ],
            });
          default:
            return Promise.resolve({});
        }
      });

      await expect(
        provider.create('MyAlb', LB_TYPE, {
          Name: 'my-alb',
          Subnets: ['subnet-111'],
          MinimumLoadBalancerCapacity: { CapacityUnits: 100 },
          EnableCapacityReservationProvisionStabilize: true,
        })
      ).rejects.toThrow('InsufficientCapacity');

      // Best-effort partial-create cleanup fired.
      expect(callsOf('DeleteLoadBalancerCommand')).toHaveLength(1);
    });
  });

  // ─── LoadBalancer update ────────────────────────────────────────────

  describe('LoadBalancer update', () => {
    it('re-issues SetSubnets with EnablePrefixForIpv6SourceNat when only the flag changed', async () => {
      await provider.update(
        'MyNlb',
        LB_ARN,
        LB_TYPE,
        { Subnets: ['subnet-111'], EnablePrefixForIpv6SourceNat: 'on' },
        { Subnets: ['subnet-111'], EnablePrefixForIpv6SourceNat: 'off' }
      );

      const [subnetCall] = callsOf('SetSubnetsCommand');
      expect(subnetCall).toBeDefined();
      expect(subnetCall[0].input).toEqual({
        LoadBalancerArn: LB_ARN,
        Subnets: ['subnet-111'],
        EnablePrefixForIpv6SourceNat: 'on',
      });
    });

    it('re-issues SetSecurityGroups with the enforce flag when only the flag changed', async () => {
      await provider.update(
        'MyNlb',
        LB_ARN,
        LB_TYPE,
        {
          SecurityGroups: ['sg-123'],
          EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: 'on',
        },
        {
          SecurityGroups: ['sg-123'],
          EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: 'off',
        }
      );

      const [sgCall] = callsOf('SetSecurityGroupsCommand');
      expect(sgCall).toBeDefined();
      expect(sgCall[0].input).toEqual({
        LoadBalancerArn: LB_ARN,
        SecurityGroups: ['sg-123'],
        EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: 'on',
      });
    });

    it('sets the IPAM pool via ModifyIpPools and removes it via RemoveIpamPools', async () => {
      await provider.update('MyAlb', LB_ARN, LB_TYPE, { Ipv4IpamPoolId: 'ipam-pool-0abc' }, {});
      let [ipamCall] = callsOf('ModifyIpPoolsCommand');
      expect(ipamCall[0].input).toEqual({
        LoadBalancerArn: LB_ARN,
        IpamPools: { Ipv4IpamPoolId: 'ipam-pool-0abc' },
      });

      vi.clearAllMocks();
      await provider.update('MyAlb', LB_ARN, LB_TYPE, {}, { Ipv4IpamPoolId: 'ipam-pool-0abc' });
      [ipamCall] = callsOf('ModifyIpPoolsCommand');
      expect(ipamCall[0].input).toEqual({
        LoadBalancerArn: LB_ARN,
        RemoveIpamPools: ['ipv4'],
      });
    });

    it('sets capacity via ModifyCapacityReservation and resets it on removal', async () => {
      await provider.update(
        'MyAlb',
        LB_ARN,
        LB_TYPE,
        { MinimumLoadBalancerCapacity: { CapacityUnits: 200 } },
        { MinimumLoadBalancerCapacity: { CapacityUnits: 100 } }
      );
      let [capCall] = callsOf('ModifyCapacityReservationCommand');
      expect(capCall[0].input).toEqual({
        LoadBalancerArn: LB_ARN,
        MinimumLoadBalancerCapacity: { CapacityUnits: 200 },
      });

      vi.clearAllMocks();
      await provider.update(
        'MyAlb',
        LB_ARN,
        LB_TYPE,
        {},
        { MinimumLoadBalancerCapacity: { CapacityUnits: 200 } }
      );
      [capCall] = callsOf('ModifyCapacityReservationCommand');
      expect(capCall[0].input).toEqual({
        LoadBalancerArn: LB_ARN,
        ResetCapacityReservation: true,
      });
    });

    it('runs the stabilize poll on the update path when capacity changes with the flag set', async () => {
      vi.spyOn(capacityReservationDelays, 'sleep').mockResolvedValue(undefined);
      await provider.update(
        'MyAlb',
        LB_ARN,
        LB_TYPE,
        {
          MinimumLoadBalancerCapacity: { CapacityUnits: 200 },
          EnableCapacityReservationProvisionStabilize: true,
        },
        { MinimumLoadBalancerCapacity: { CapacityUnits: 100 } }
      );
      expect(callsOf('ModifyCapacityReservationCommand')).toHaveLength(1);
      expect(callsOf('DescribeCapacityReservationCommand').length).toBeGreaterThan(0);
    });

    // Issue #1609 item 1. Both of these fail against the pre-fix provider,
    // which pushed EVERY removed key back as `Value: ''`. The live A/B
    // (2026-08-11) proved AWS rejects that for a boolean-validated key —
    // "The value of 'deletion_protection.enabled' must be 'true' or 'false',
    // but was ''" — and a rejection fails the WHOLE Modify* call, so one
    // removed boolean took the entire deploy (and its rollback) down.

    it('resets a removed BOOLEAN LoadBalancerAttribute to its documented default, not the empty string', async () => {
      await provider.update(
        'MyLb',
        LB_ARN,
        LB_TYPE,
        {},
        { LoadBalancerAttributes: [{ Key: 'deletion_protection.enabled', Value: 'true' }] }
      );

      const [call] = callsOf('ModifyLoadBalancerAttributesCommand');
      expect(call[0].input.Attributes).toEqual([
        { Key: 'deletion_protection.enabled', Value: 'false' },
      ]);
    });

    it('resets a removed TRUE-defaulted LoadBalancerAttribute to true, not false', async () => {
      // Every other assertion in this file uses a key whose default is
      // 'false', so a table lookup replaced by `key.endsWith('.enabled') ?
      // 'false' : ''` would keep them all green. routing.http2.enabled
      // defaults to TRUE, so this is what forces a real table read — and the
      // wrong answer here silently disables HTTP/2 on the live LB.
      await provider.update(
        'MyLb',
        LB_ARN,
        LB_TYPE,
        {},
        { LoadBalancerAttributes: [{ Key: 'routing.http2.enabled', Value: 'false' }] }
      );

      const [call] = callsOf('ModifyLoadBalancerAttributesCommand');
      expect(call[0].input.Attributes).toEqual([{ Key: 'routing.http2.enabled', Value: 'true' }]);
    });

    it('resets a removed ENUM LoadBalancerAttribute to its documented default', async () => {
      // The ENUM entries are the other shape a boolean-only heuristic misses.
      await provider.update(
        'MyLb',
        LB_ARN,
        LB_TYPE,
        {},
        {
          LoadBalancerAttributes: [
            { Key: 'routing.http.desync_mitigation_mode', Value: 'strictest' },
            { Key: 'routing.http.xff_header_processing.mode', Value: 'preserve' },
          ],
        }
      );

      const [call] = callsOf('ModifyLoadBalancerAttributesCommand');
      expect(call[0].input.Attributes).toEqual([
        { Key: 'routing.http.desync_mitigation_mode', Value: 'defensive' },
        { Key: 'routing.http.xff_header_processing.mode', Value: 'append' },
      ]);
    });

    it('leaves a load-balancer-DEPENDENT default out of the table so it fails loudly', async () => {
      // ipv6.deny_all_igw_traffic defaults to false for an internet-facing LB
      // and TRUE for an internal one, and cdkd knows neither the type nor the
      // scheme at diff time. A hardcoded entry would send the wrong value for
      // half of all load balancers — and AWS ACCEPTS a valid boolean, so on an
      // internal LB that silently un-blocks internet-gateway access. It must
      // therefore fall through to '' (which AWS rejects) rather than guess.
      // Same rationale as load_balancing.cross_zone.enabled.
      await provider.update(
        'MyLb',
        LB_ARN,
        LB_TYPE,
        {},
        {
          LoadBalancerAttributes: [
            { Key: 'ipv6.deny_all_igw_traffic', Value: 'true' },
            { Key: 'load_balancing.cross_zone.enabled', Value: 'true' },
          ],
        }
      );

      const [call] = callsOf('ModifyLoadBalancerAttributesCommand');
      expect(call[0].input.Attributes).toEqual([
        { Key: 'ipv6.deny_all_igw_traffic', Value: '' },
        { Key: 'load_balancing.cross_zone.enabled', Value: '' },
      ]);
    });

    it('does NOT mass-reset when the previous side is a full readCurrentState snapshot (drift --revert)', async () => {
      // `cdkd drift --revert` calls update(..., newProperties,
      // outcome.awsProperties) — the previous side is the FULL AWS snapshot,
      // not a template. Against a state record with no observedProperties the
      // desired side is the template's one key, so every untemplated key looks
      // REMOVED. Writing documented defaults there would silently disable
      // deletion protection / logs / HTTP/2 / WAF fail-open on a live LB.
      // Before the defaults table existed this was accidentally safe ('' fails
      // validation, so the whole revert aborted), so the table MUST NOT turn
      // that loud refusal into a silent destructive write.
      await provider.update('MyLb', LB_ARN, LB_TYPE, {
        LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '120' }],
      }, {
        LoadBalancerAttributes: [
          { Key: 'idle_timeout.timeout_seconds', Value: '60' },
          // Everything below is AWS-reported and sitting at its default —
          // i.e. exactly what an untemplated key looks like.
          { Key: 'deletion_protection.enabled', Value: 'false' },
          { Key: 'access_logs.s3.enabled', Value: 'false' },
          { Key: 'connection_logs.s3.enabled', Value: 'false' },
          { Key: 'routing.http2.enabled', Value: 'true' },
          { Key: 'waf.fail_open.enabled', Value: 'false' },
          { Key: 'zonal_shift.config.enabled', Value: 'false' },
          { Key: 'routing.http.desync_mitigation_mode', Value: 'defensive' },
          { Key: 'routing.http.xff_header_processing.mode', Value: 'append' },
        ],
      });

      // ONLY the genuinely changed key is submitted. No default is written
      // back for any of the eight untemplated keys.
      const [call] = callsOf('ModifyLoadBalancerAttributesCommand');
      expect(call[0].input.Attributes).toEqual([
        { Key: 'idle_timeout.timeout_seconds', Value: '120' },
      ]);
    });

    it('still resets an untemplated key that AWS reports at a NON-default value', async () => {
      // The skip is exact, not blanket: a key sitting away from its default
      // was genuinely changed, so the reset must still fire.
      await provider.update(
        'MyLb',
        LB_ARN,
        LB_TYPE,
        {},
        { LoadBalancerAttributes: [{ Key: 'routing.http2.enabled', Value: 'false' }] }
      );

      const [call] = callsOf('ModifyLoadBalancerAttributesCommand');
      expect(call[0].input.Attributes).toEqual([{ Key: 'routing.http2.enabled', Value: 'true' }]);
    });

    it('does not walk the prototype chain for a key named __proto__ / constructor', async () => {
      await provider.update(
        'MyLb',
        LB_ARN,
        LB_TYPE,
        {},
        {
          LoadBalancerAttributes: [
            { Key: '__proto__', Value: 'x' },
            { Key: 'constructor', Value: 'y' },
            { Key: 'toString', Value: 'z' },
          ],
        }
      );

      const [call] = callsOf('ModifyLoadBalancerAttributesCommand');
      expect(call[0].input.Attributes).toEqual([
        { Key: '__proto__', Value: '' },
        { Key: 'constructor', Value: '' },
        { Key: 'toString', Value: '' },
      ]);
    });

    it('skips ModifyLoadBalancerAttributes when the attribute set is unchanged', async () => {
      await provider.update(
        'MyLb',
        LB_ARN,
        LB_TYPE,
        { LoadBalancerAttributes: [{ Key: 'routing.http2.enabled', Value: 'false' }] },
        { LoadBalancerAttributes: [{ Key: 'routing.http2.enabled', Value: 'false' }] }
      );
      expect(callsOf('ModifyLoadBalancerAttributesCommand')).toHaveLength(0);
    });

    it('keeps the empty-string reset for a removed NUMERIC LoadBalancerAttribute', async () => {
      // The empty string IS accepted for these (live-verified on
      // idle_timeout.timeout_seconds), so the fix must not regress them into
      // the defaults table — a key with no documented boolean/enum default
      // still clears via ''.
      await provider.update(
        'MyLb',
        LB_ARN,
        LB_TYPE,
        {},
        { LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '180' }] }
      );

      const [call] = callsOf('ModifyLoadBalancerAttributesCommand');
      expect(call[0].input.Attributes).toEqual([
        { Key: 'idle_timeout.timeout_seconds', Value: '' },
      ]);
    });

    it('retains a REMOVED flag: no SetSubnets / SetSecurityGroups call fires', async () => {
      // Pin the no-op polarity of the retain-on-removal decision (the
      // documented design in the provider comments): flag present before,
      // absent now, everything else unchanged → no Set* call at all.
      await provider.update(
        'MyNlb',
        LB_ARN,
        LB_TYPE,
        { Subnets: ['subnet-111'], SecurityGroups: ['sg-123'] },
        {
          Subnets: ['subnet-111'],
          SecurityGroups: ['sg-123'],
          EnablePrefixForIpv6SourceNat: 'on',
          EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: 'on',
        }
      );
      expect(callsOf('SetSubnetsCommand')).toHaveLength(0);
      expect(callsOf('SetSecurityGroupsCommand')).toHaveLength(0);
    });

    it('does not touch capacity or IPAM APIs when those properties are unchanged', async () => {
      await provider.update(
        'MyAlb',
        LB_ARN,
        LB_TYPE,
        { MinimumLoadBalancerCapacity: { CapacityUnits: 100 }, Ipv4IpamPoolId: 'ipam-pool-0abc' },
        { MinimumLoadBalancerCapacity: { CapacityUnits: 100 }, Ipv4IpamPoolId: 'ipam-pool-0abc' }
      );
      expect(callsOf('ModifyCapacityReservationCommand')).toHaveLength(0);
      expect(callsOf('ModifyIpPoolsCommand')).toHaveLength(0);
    });

    it('does not reject the update as unsupported when only the new properties changed', async () => {
      // Pin the polarity: these keys are handled now, so no
      // ResourceUpdateNotSupportedError fires (pre-fix they were unknown keys
      // ONLY because the whole property was silently dropped upstream).
      await expect(
        provider.update(
          'MyAlb',
          LB_ARN,
          LB_TYPE,
          { EnableCapacityReservationProvisionStabilize: true },
          { EnableCapacityReservationProvisionStabilize: false }
        )
      ).resolves.toEqual({ physicalId: LB_ARN, wasReplaced: false });
    });
  });

  // ─── TargetGroup create ─────────────────────────────────────────────

  describe('TargetGroup create', () => {
    it('forwards IpAddressType and TargetControlPort on CreateTargetGroup', async () => {
      await provider.create('MyTg', TG_TYPE, {
        Name: 'my-tg',
        Protocol: 'TCP',
        Port: 80,
        VpcId: 'vpc-123',
        TargetType: 'ip',
        IpAddressType: 'ipv6',
        TargetControlPort: '8443',
      });

      const [createCall] = callsOf('CreateTargetGroupCommand');
      expect(createCall[0].input.IpAddressType).toBe('ipv6');
      expect(createCall[0].input.TargetControlPort).toBe(8443);
    });

    it('applies TargetGroupAttributes and registers Targets post-create', async () => {
      await provider.create('MyTg', TG_TYPE, {
        Name: 'my-tg',
        Protocol: 'HTTP',
        Port: 80,
        VpcId: 'vpc-123',
        TargetType: 'ip',
        TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '45' }],
        Targets: [{ Id: '10.0.0.10', Port: '8080' }, { Id: '10.0.0.11' }],
      });

      const [attrCall] = callsOf('ModifyTargetGroupAttributesCommand');
      expect(attrCall[0].input).toEqual({
        TargetGroupArn: TG_ARN,
        Attributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '45' }],
      });

      const [regCall] = callsOf('RegisterTargetsCommand');
      expect(regCall[0].input).toEqual({
        TargetGroupArn: TG_ARN,
        Targets: [{ Id: '10.0.0.10', Port: 8080 }, { Id: '10.0.0.11' }],
      });
    });

    it('best-effort deletes the TG and rethrows when post-create wiring fails', async () => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        switch (cmd.constructor.name) {
          case 'CreateTargetGroupCommand':
            return Promise.resolve({ TargetGroups: [{ TargetGroupArn: TG_ARN }] });
          case 'RegisterTargetsCommand':
            return Promise.reject(new Error('Invalid target'));
          default:
            return Promise.resolve({});
        }
      });

      await expect(
        provider.create('MyTg', TG_TYPE, {
          Name: 'my-tg',
          Protocol: 'HTTP',
          Port: 80,
          VpcId: 'vpc-123',
          TargetType: 'ip',
          Targets: [{ Id: '10.0.0.10' }],
        })
      ).rejects.toThrow('Invalid target');

      expect(callsOf('DeleteTargetGroupCommand')).toHaveLength(1);
    });
  });

  // ─── TargetGroup update ─────────────────────────────────────────────

  describe('TargetGroup update', () => {
    it('rejects a TargetControlPort change with ResourceUpdateNotSupportedError', async () => {
      await expect(
        provider.update('MyTg', TG_ARN, TG_TYPE, { TargetControlPort: 9000 }, { TargetControlPort: 8443 })
      ).rejects.toThrow(ResourceUpdateNotSupportedError);
      expect(callsOf('ModifyTargetGroupCommand')).toHaveLength(0);
    });

    it('rejects an IpAddressType change with ResourceUpdateNotSupportedError', async () => {
      await expect(
        provider.update('MyTg', TG_ARN, TG_TYPE, { IpAddressType: 'ipv6' }, { IpAddressType: 'ipv4' })
      ).rejects.toThrow(ResourceUpdateNotSupportedError);
    });

    it('does not treat a TargetControlPort quoting difference ("8443" vs 8443) as a change', async () => {
      const result = await provider.update(
        'MyTg',
        TG_ARN,
        TG_TYPE,
        { TargetControlPort: '8443' },
        { TargetControlPort: 8443 }
      );
      expect(result.wasReplaced).toBe(false);
    });

    it('accepts an update where the immutable keys are unchanged', async () => {
      const result = await provider.update(
        'MyTg',
        TG_ARN,
        TG_TYPE,
        { IpAddressType: 'ipv4', TargetControlPort: 8443, HealthCheckPath: '/new' },
        { IpAddressType: 'ipv4', TargetControlPort: 8443, HealthCheckPath: '/old' }
      );
      expect(result.wasReplaced).toBe(false);
      expect(callsOf('ModifyTargetGroupCommand')).toHaveLength(1);
    });

    it('diffs TargetGroupAttributes: changed values win, removed keys reset to their documented default', async () => {
      // ModifyTargetGroupAttributes REJECTS Value:'' (unlike the LB /
      // Listener attribute APIs — live-verified 2026-08-11), so the removal
      // arm must send the documented default explicitly.
      await provider.update(
        'MyTg',
        TG_ARN,
        TG_TYPE,
        { TargetGroupAttributes: [{ Key: 'deregistration_delay.timeout_seconds', Value: '60' }] },
        {
          TargetGroupAttributes: [
            { Key: 'deregistration_delay.timeout_seconds', Value: '45' },
            { Key: 'stickiness.enabled', Value: 'true' },
          ],
        }
      );

      const [attrCall] = callsOf('ModifyTargetGroupAttributesCommand');
      expect(attrCall[0].input.Attributes).toEqual([
        { Key: 'deregistration_delay.timeout_seconds', Value: '60' },
        { Key: 'stickiness.enabled', Value: 'false' },
      ]);
      // Never the empty-string spelling — the API rejects it.
      for (const attr of attrCall[0].input.Attributes) {
        expect(attr.Value).not.toBe('');
      }
    });

    it('retains (and does not submit) a removed attribute with no documented default', async () => {
      await provider.update(
        'MyTg',
        TG_ARN,
        TG_TYPE,
        { TargetGroupAttributes: [] },
        {
          TargetGroupAttributes: [
            // Target-type-dependent default — deliberately not in the table.
            { Key: 'preserve_client_ip.enabled', Value: 'false' },
            { Key: 'deregistration_delay.timeout_seconds', Value: '45' },
          ],
        }
      );

      const [attrCall] = callsOf('ModifyTargetGroupAttributesCommand');
      // Only the known-default key is reset; the unknown one is retained.
      expect(attrCall[0].input.Attributes).toEqual([
        { Key: 'deregistration_delay.timeout_seconds', Value: '300' },
      ]);
    });

    it('skips ModifyTargetGroupAttributes when nothing changed', async () => {
      await provider.update(
        'MyTg',
        TG_ARN,
        TG_TYPE,
        { TargetGroupAttributes: [{ Key: 'stickiness.enabled', Value: 'true' }] },
        { TargetGroupAttributes: [{ Key: 'stickiness.enabled', Value: 'true' }] }
      );
      expect(callsOf('ModifyTargetGroupAttributesCommand')).toHaveLength(0);
    });

    it('registers added / changed targets and deregisters removed ones', async () => {
      await provider.update(
        'MyTg',
        TG_ARN,
        TG_TYPE,
        { Targets: [{ Id: '10.0.0.10', Port: 9090 }, { Id: '10.0.0.12' }] },
        { Targets: [{ Id: '10.0.0.10', Port: 8080 }, { Id: '10.0.0.11' }] }
      );

      const [regCall] = callsOf('RegisterTargetsCommand');
      expect(regCall[0].input.Targets).toEqual([
        { Id: '10.0.0.10', Port: 9090 },
        { Id: '10.0.0.12' },
      ]);
      const [deregCall] = callsOf('DeregisterTargetsCommand');
      expect(deregCall[0].input.Targets).toEqual([
        { Id: '10.0.0.10', Port: 8080 },
        { Id: '10.0.0.11' },
      ]);
    });

    it('registers BEFORE it deregisters so a re-spelled target never has zero registrations', async () => {
      // Issue #1609 item 3. The payloads above are asserted but the ORDER was
      // only a code comment — and the order IS the behavior: a target whose
      // Port changed is the same backend under two spellings, so deregistering
      // first would open a window with nothing registered. Pin the sequence,
      // not just the contents.
      await provider.update(
        'MyTg',
        TG_ARN,
        TG_TYPE,
        { Targets: [{ Id: '10.0.0.10', Port: 9090 }] },
        { Targets: [{ Id: '10.0.0.10', Port: 8080 }] }
      );

      const order = mockSend.mock.calls
        .map((c) => c[0].constructor.name)
        .filter((n) => n === 'RegisterTargetsCommand' || n === 'DeregisterTargetsCommand');
      expect(order).toEqual(['RegisterTargetsCommand', 'DeregisterTargetsCommand']);
    });

    it('deregisters every target when Targets is removed entirely', async () => {
      await provider.update(
        'MyTg',
        TG_ARN,
        TG_TYPE,
        {},
        { Targets: [{ Id: '10.0.0.10', Port: 8080 }, { Id: '10.0.0.11' }] }
      );
      expect(callsOf('RegisterTargetsCommand')).toHaveLength(0);
      const [deregCall] = callsOf('DeregisterTargetsCommand');
      expect(deregCall[0].input.Targets).toEqual([
        { Id: '10.0.0.10', Port: 8080 },
        { Id: '10.0.0.11' },
      ]);
    });

    it('drops malformed Targets entries (missing / empty / non-string Id) and keeps valid ones', async () => {
      await provider.update(
        'MyTg',
        TG_ARN,
        TG_TYPE,
        { Targets: [null, { Port: 80 }, { Id: '' }, { Id: 42 }, { Id: '10.0.0.5' }] },
        {}
      );
      const [regCall] = callsOf('RegisterTargetsCommand');
      expect(regCall[0].input.Targets).toEqual([{ Id: '10.0.0.5' }]);
    });

    it('does not call Register/DeregisterTargets when the target set is unchanged', async () => {
      await provider.update(
        'MyTg',
        TG_ARN,
        TG_TYPE,
        { Targets: [{ Id: '10.0.0.10', Port: 8080 }] },
        { Targets: [{ Id: '10.0.0.10', Port: 8080 }] }
      );
      expect(callsOf('RegisterTargetsCommand')).toHaveLength(0);
      expect(callsOf('DeregisterTargetsCommand')).toHaveLength(0);
    });
  });

  // ─── Listener update (issue #1609 item 1) ───────────────────────────

  describe('Listener update', () => {
    const LISTENER_TYPE = 'AWS::ElasticLoadBalancingV2::Listener';
    const LISTENER_ARN =
      'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/my-alb/abc/def';

    it('resets a removed BOOLEAN ListenerAttribute to its documented default, not the empty string', async () => {
      // The exact payload that failed the live removal deploy pre-fix:
      // "The value of 'routing.http.response.server.enabled' must be 'true'
      // or 'false', but was ''".
      await provider.update(
        'MyListener',
        LISTENER_ARN,
        LISTENER_TYPE,
        { LoadBalancerArn: LB_ARN, DefaultActions: [], Port: 80, Protocol: 'HTTP' },
        {
          LoadBalancerArn: LB_ARN,
          DefaultActions: [],
          Port: 80,
          Protocol: 'HTTP',
          ListenerAttributes: [
            { Key: 'routing.http.response.server.enabled', Value: 'false' },
          ],
        }
      );

      const [call] = callsOf('ModifyListenerAttributesCommand');
      expect(call[0].input.Attributes).toEqual([
        { Key: 'routing.http.response.server.enabled', Value: 'true' },
      ]);
    });

    it('keeps the empty-string reset for a removed free-form ListenerAttribute', async () => {
      await provider.update(
        'MyListener',
        LISTENER_ARN,
        LISTENER_TYPE,
        { LoadBalancerArn: LB_ARN, DefaultActions: [], Port: 80, Protocol: 'HTTP' },
        {
          LoadBalancerArn: LB_ARN,
          DefaultActions: [],
          Port: 80,
          Protocol: 'HTTP',
          ListenerAttributes: [
            {
              Key: 'routing.http.response.strict_transport_security.header_value',
              Value: 'max-age=31536000',
            },
          ],
        }
      );

      const [call] = callsOf('ModifyListenerAttributesCommand');
      expect(call[0].input.Attributes).toEqual([
        {
          Key: 'routing.http.response.strict_transport_security.header_value',
          Value: '',
        },
      ]);
    });
  });

  // ─── readCurrentState ───────────────────────────────────────────────

  describe('readCurrentState', () => {
    it('reads the new LoadBalancer fields, flattening IpamPools and capacity', async () => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        switch (cmd.constructor.name) {
          case 'DescribeLoadBalancersCommand':
            return Promise.resolve({
              LoadBalancers: [
                {
                  LoadBalancerArn: LB_ARN,
                  LoadBalancerName: 'my-nlb',
                  Type: 'network',
                  EnablePrefixForIpv6SourceNat: 'on',
                  EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: 'on',
                  IpamPools: { Ipv4IpamPoolId: 'ipam-pool-0abc' },
                },
              ],
            });
          case 'DescribeCapacityReservationCommand':
            return Promise.resolve({
              MinimumLoadBalancerCapacity: { CapacityUnits: 100 },
            });
          case 'DescribeLoadBalancerAttributesCommand':
            return Promise.resolve({ Attributes: [] });
          case 'DescribeTagsCommand':
            return Promise.resolve({ TagDescriptions: [{ Tags: [] }] });
          default:
            return Promise.resolve({});
        }
      });

      const state = await provider.readCurrentState!(LB_ARN, 'MyNlb', LB_TYPE);
      expect(state).toMatchObject({
        EnablePrefixForIpv6SourceNat: 'on',
        EnforceSecurityGroupInboundRulesOnPrivateLinkTraffic: 'on',
        Ipv4IpamPoolId: 'ipam-pool-0abc',
        MinimumLoadBalancerCapacity: { CapacityUnits: 100 },
      });
    });

    it('omits MinimumLoadBalancerCapacity when no reservation is set', async () => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        switch (cmd.constructor.name) {
          case 'DescribeLoadBalancersCommand':
            return Promise.resolve({ LoadBalancers: [{ LoadBalancerArn: LB_ARN }] });
          case 'DescribeCapacityReservationCommand':
            return Promise.resolve({ MinimumLoadBalancerCapacity: { CapacityUnits: 0 } });
          case 'DescribeLoadBalancerAttributesCommand':
            return Promise.resolve({ Attributes: [] });
          case 'DescribeTagsCommand':
            return Promise.resolve({ TagDescriptions: [{ Tags: [] }] });
          default:
            return Promise.resolve({});
        }
      });

      const state = await provider.readCurrentState!(LB_ARN, 'MyNlb', LB_TYPE);
      expect(state).not.toHaveProperty('MinimumLoadBalancerCapacity');
    });

    it('reads TargetGroup IpAddressType, TargetControlPort and sorted TargetGroupAttributes', async () => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        switch (cmd.constructor.name) {
          case 'DescribeTargetGroupsCommand':
            return Promise.resolve({
              TargetGroups: [
                {
                  TargetGroupArn: TG_ARN,
                  TargetGroupName: 'my-tg',
                  IpAddressType: 'ipv6',
                  TargetControlPort: 8443,
                },
              ],
            });
          case 'DescribeTargetGroupAttributesCommand':
            return Promise.resolve({
              Attributes: [
                { Key: 'stickiness.enabled', Value: 'false' },
                { Key: 'deregistration_delay.timeout_seconds', Value: '45' },
              ],
            });
          case 'DescribeTargetHealthCommand':
            return Promise.resolve({
              TargetHealthDescriptions: [
                { Target: { Id: '10.0.1.10', Port: 80 }, TargetHealth: { State: 'healthy' } },
              ],
            });
          case 'DescribeTagsCommand':
            return Promise.resolve({ TagDescriptions: [{ Tags: [] }] });
          default:
            return Promise.resolve({});
        }
      });

      const state = await provider.readCurrentState!(TG_ARN, 'MyTg', TG_TYPE);
      expect(state).toMatchObject({
        IpAddressType: 'ipv6',
        TargetControlPort: 8443,
        TargetGroupAttributes: [
          { Key: 'deregistration_delay.timeout_seconds', Value: '45' },
          { Key: 'stickiness.enabled', Value: 'false' },
        ],
        // Targets ARE read back since issue #1620 — see
        // `attachRegisteredTargets` / `getDriftUnorderedPaths`.
        Targets: [{ Id: '10.0.1.10', Port: 80 }],
      });
    });

    // Issue #1609 item 4. The two reads the #609 batch added are best-effort
    // and their catch arms are TWO different decisions the happy-path tests
    // above cannot tell apart: a NotFound means the resource is gone and the
    // whole read must return `undefined` (so drift reports a deletion, not a
    // property diff), while any other failure — a missing IAM permission is
    // the realistic one — must leave the key ABSENT and the rest of the state
    // intact, because emitting a wrong value there fires false drift on every
    // single run.

    it('returns undefined when DescribeCapacityReservation reports the LB is gone', async () => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        switch (cmd.constructor.name) {
          case 'DescribeLoadBalancersCommand':
            return Promise.resolve({ LoadBalancers: [{ LoadBalancerArn: LB_ARN }] });
          case 'DescribeCapacityReservationCommand': {
            const err = new Error('Load balancer not found');
            err.name = 'LoadBalancerNotFoundException';
            return Promise.reject(err);
          }
          default:
            return Promise.resolve({});
        }
      });

      expect(await provider.readCurrentState!(LB_ARN, 'MyNlb', LB_TYPE)).toBeUndefined();
    });

    it('leaves MinimumLoadBalancerCapacity absent when DescribeCapacityReservation is denied', async () => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        switch (cmd.constructor.name) {
          case 'DescribeLoadBalancersCommand':
            return Promise.resolve({
              LoadBalancers: [{ LoadBalancerArn: LB_ARN, LoadBalancerName: 'my-nlb' }],
            });
          case 'DescribeCapacityReservationCommand': {
            const err = new Error('User is not authorized to perform: elasticloadbalancing:DescribeCapacityReservation');
            err.name = 'AccessDeniedException';
            return Promise.reject(err);
          }
          case 'DescribeLoadBalancerAttributesCommand':
            return Promise.resolve({ Attributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }] });
          case 'DescribeTagsCommand':
            return Promise.resolve({ TagDescriptions: [{ Tags: [] }] });
          default:
            return Promise.resolve({});
        }
      });

      const state = await provider.readCurrentState!(LB_ARN, 'MyNlb', LB_TYPE);
      expect(state).toBeDefined();
      expect(state).not.toHaveProperty('MinimumLoadBalancerCapacity');
      // The read continues past the denied call — a permission gap on one
      // attribute must not blank the whole snapshot.
      expect(state).toMatchObject({
        Name: 'my-nlb',
        LoadBalancerAttributes: [{ Key: 'idle_timeout.timeout_seconds', Value: '60' }],
      });
    });

    it('returns undefined when DescribeTargetGroupAttributes reports the TG is gone', async () => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        switch (cmd.constructor.name) {
          case 'DescribeTargetGroupsCommand':
            return Promise.resolve({ TargetGroups: [{ TargetGroupArn: TG_ARN }] });
          case 'DescribeTargetGroupAttributesCommand': {
            const err = new Error('Target group does not exist');
            err.name = 'TargetGroupNotFoundException';
            return Promise.reject(err);
          }
          default:
            return Promise.resolve({});
        }
      });

      expect(await provider.readCurrentState!(TG_ARN, 'MyTg', TG_TYPE)).toBeUndefined();
    });

    it('leaves TargetGroupAttributes absent when DescribeTargetGroupAttributes is denied', async () => {
      mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
        switch (cmd.constructor.name) {
          case 'DescribeTargetGroupsCommand':
            return Promise.resolve({
              TargetGroups: [
                { TargetGroupArn: TG_ARN, TargetGroupName: 'my-tg', IpAddressType: 'ipv4' },
              ],
            });
          case 'DescribeTargetGroupAttributesCommand': {
            const err = new Error('User is not authorized to perform: elasticloadbalancing:DescribeTargetGroupAttributes');
            err.name = 'AccessDeniedException';
            return Promise.reject(err);
          }
          case 'DescribeTagsCommand':
            return Promise.resolve({ TagDescriptions: [{ Tags: [] }] });
          default:
            return Promise.resolve({});
        }
      });

      const state = await provider.readCurrentState!(TG_ARN, 'MyTg', TG_TYPE);
      expect(state).toBeDefined();
      expect(state).not.toHaveProperty('TargetGroupAttributes');
      expect(state).toMatchObject({ Name: 'my-tg', IpAddressType: 'ipv4' });
    });
  });

  describe('getDriftUnknownPaths', () => {
    it('declares the write-only / unreadable paths per type', () => {
      expect(provider.getDriftUnknownPaths(LB_TYPE)).toEqual([
        'EnableCapacityReservationProvisionStabilize',
      ]);
      // `Targets` moved OUT of the TYPE-level list in issue #1620 — it is read
      // back via DescribeTargetHealth and declared UNORDERED instead. With no
      // properties bag the contract is to fall back to COMPARING.
      expect(provider.getDriftUnknownPaths(TG_TYPE)).toEqual([]);
      expect(provider.getDriftUnknownPaths('AWS::ElasticLoadBalancingV2::Listener')).toEqual([]);
    });
  });

  describe('getDriftUnknownPaths — per-resource Targets scoping (#1620 / #1602)', () => {
    it('COMPARES Targets when the template declares them', () => {
      expect(
        provider.getDriftUnknownPaths(TG_TYPE, { Protocol: 'HTTP', Targets: [{ Id: '10.0.0.1' }] })
      ).toEqual([]);
    });

    it('IGNORES Targets when the template declares none (ECS / ASG-managed target group)', () => {
      // The #1498 class: a sibling resource registers the targets and keeps
      // re-registering as it scales. Comparing would report drift on every
      // scale event and `--revert` would deregister the live tasks.
      expect(provider.getDriftUnknownPaths(TG_TYPE, { Protocol: 'HTTP', VpcId: 'vpc-1' })).toEqual([
        'Targets',
      ]);
    });

    it('COMPARES an explicitly EMPTY templated target list', () => {
      // `Targets: []` is a real declaration — "this target group has no
      // targets" — so a console-side registration IS drift the user wants.
      expect(provider.getDriftUnknownPaths(TG_TYPE, { Protocol: 'HTTP', Targets: [] })).toEqual([]);
    });

    it('falls back to COMPARING on an absent or empty properties bag', () => {
      // Contract from `ResourceProvider.getDriftUnknownPaths`: a provider must
      // tolerate a missing bag, and hiding real drift is the worse failure.
      expect(provider.getDriftUnknownPaths(TG_TYPE, undefined)).toEqual([]);
      expect(provider.getDriftUnknownPaths(TG_TYPE, {})).toEqual([]);
    });

    it('does not leak the scoping onto the sibling ELBv2 types', () => {
      expect(provider.getDriftUnknownPaths(LB_TYPE, { Name: 'lb' })).toEqual([
        'EnableCapacityReservationProvisionStabilize',
      ]);
      expect(
        provider.getDriftUnknownPaths('AWS::ElasticLoadBalancingV2::Listener', { Port: 443 })
      ).toEqual([]);
    });
  });

  describe('getDriftUnorderedPaths (#1620)', () => {
    it('declares TargetGroup.Targets unordered, and nothing on the sibling types', () => {
      expect(provider.getDriftUnorderedPaths(TG_TYPE)).toEqual(['Targets']);
      expect(provider.getDriftUnorderedPaths(LB_TYPE)).toEqual([]);
      expect(provider.getDriftUnorderedPaths('AWS::ElasticLoadBalancingV2::Listener')).toEqual([]);
    });
  });
});
