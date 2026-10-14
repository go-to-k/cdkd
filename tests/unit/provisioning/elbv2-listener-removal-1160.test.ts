import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Issue #1160: removing AlpnPolicy, MutualAuthentication, Certificates,
// SslPolicy, Port or Protocol from a listener's template sent nothing for it,
// so ModifyListener kept the old value, and cdkd said nothing. cdkd still
// sends no reset (CloudFormation's behavior on these removals is unmeasured)
// and now names each one in a warning, except SslPolicy / Certificates on an
// HTTPS -> HTTP or TLS -> TCP change, which AWS drops itself.

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-elastic-load-balancing-v2', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-elastic-load-balancing-v2')>(
    '@aws-sdk/client-elastic-load-balancing-v2'
  );
  return {
    ...actual,
    ElasticLoadBalancingV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...logger, child: () => logger }) };
});

import { ModifyListenerCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { ELBv2Provider } from '../../../src/provisioning/providers/elbv2-provider.js';
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';
import { getLogger } from '../../../src/utils/logger.js';
import type { UpdateContext } from '../../../src/types/resource.js';

const LISTENER = 'AWS::ElasticLoadBalancingV2::Listener';
const LB_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/net/my-nlb/0123456789abcdef';
const LISTENER_ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/net/my-nlb/0123456789abcdef/fedcba9876543210';
const CERT = [{ CertificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/abc' }];

const tlsListener = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  LoadBalancerArn: LB_ARN,
  Port: 443,
  Protocol: 'TLS',
  DefaultActions: [{ Type: 'forward', TargetGroupArn: 'arn:tg' }],
  ...extra,
});

const httpsListener = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...tlsListener(),
  Protocol: 'HTTPS',
  ...extra,
});

const MTLS = { Mode: 'verify', TrustStoreArn: 'arn:aws:elasticloadbalancing:ts' };

const warn = getLogger().child('ELBv2Provider').warn as ReturnType<typeof vi.fn>;
const warnings = (): string[] => warn.mock.calls.map((c) => String(c[0]));

function modifyInput(): Record<string, unknown> {
  const calls = mockSend.mock.calls
    .map((c) => c[0] as object)
    .filter((c) => c instanceof ModifyListenerCommand) as ModifyListenerCommand[];
  expect(calls).toHaveLength(1);
  return calls[0]!.input as unknown as Record<string, unknown>;
}

async function update(
  desired: Record<string, unknown>,
  previous: Record<string, unknown>,
  context?: UpdateContext
): Promise<void> {
  await new ELBv2Provider().update('MyListener', LISTENER_ARN, LISTENER, desired, previous, context);
}

beforeEach(() => {
  mockSend.mockReset();
  mockSend.mockResolvedValue({});
  warn.mockClear();
});

describe('ELBv2 Listener update: a removed property ModifyListener keeps (#1160)', () => {
  it('a removed AlpnPolicy is not sent and is named in one warning', async () => {
    await update(
      tlsListener({ Certificates: CERT }),
      tlsListener({ Certificates: CERT, AlpnPolicy: ['HTTP2Preferred'] })
    );

    expect(modifyInput()).not.toHaveProperty('AlpnPolicy');
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('MyListener (AWS::ElasticLoadBalancingV2::Listener)');
    expect(warnings()[0]).toContain('property AlpnPolicy was removed from the template');
    expect(warnings()[0]).toContain('the current AWS value stays in place');
    // No claim about what CloudFormation would do: it is unmeasured.
    expect(warnings()[0]).not.toContain('CloudFormation');
  });

  it('a removed MutualAuthentication is not sent and is named in the warning', async () => {
    await update(
      httpsListener({ Certificates: CERT }),
      httpsListener({ Certificates: CERT, MutualAuthentication: MTLS })
    );

    expect(modifyInput()).not.toHaveProperty('MutualAuthentication');
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('property MutualAuthentication was removed');
  });

  it('a removed SslPolicy / Certificates on a listener that stays HTTPS is named in the warning', async () => {
    await update(
      httpsListener(),
      httpsListener({ Certificates: CERT, SslPolicy: 'ELBSecurityPolicy-TLS13-1-2-2021-06' })
    );

    const input = modifyInput();
    expect(input['SslPolicy']).toBeUndefined();
    expect(input).not.toHaveProperty('Certificates');
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('properties Certificates, SslPolicy were removed');
  });

  it('names a removed Port / Protocol too', async () => {
    const { Port: _port, Protocol: _protocol, ...rest } = tlsListener();
    await update(rest, tlsListener());

    const input = modifyInput();
    expect(input['Port']).toBeUndefined();
    expect(input['Protocol']).toBeUndefined();
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('properties Port, Protocol were removed');
  });

  it('a removed Protocol keeps the live protocol, so a removed SslPolicy is still named', async () => {
    const { Protocol: _protocol, ...rest } = httpsListener({ Certificates: CERT });
    await update(rest, httpsListener({ Certificates: CERT, SslPolicy: 'ELBSecurityPolicy-2016-08' }));

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('properties Protocol, SslPolicy were removed');
  });

  it('HTTPS -> HTTP dropping SslPolicy / Certificates warns about neither: AWS drops them itself', async () => {
    await update(
      httpsListener({ Protocol: 'HTTP', Port: 80 }),
      httpsListener({ Certificates: CERT, SslPolicy: 'ELBSecurityPolicy-2016-08' })
    );

    const input = modifyInput();
    expect(input['Protocol']).toBe('HTTP');
    expect(input['SslPolicy']).toBeUndefined();
    expect(input).not.toHaveProperty('Certificates');
    expect(warnings()).toEqual([]);
  });

  it('TLS -> TCP exempts SslPolicy / Certificates but still names a removed AlpnPolicy', async () => {
    await update(
      tlsListener({ Protocol: 'TCP' }),
      tlsListener({
        Certificates: CERT,
        SslPolicy: 'ELBSecurityPolicy-2016-08',
        AlpnPolicy: ['HTTP2Only'],
      })
    );

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('property AlpnPolicy was removed');
    expect(warnings()[0]).not.toContain('SslPolicy');
    expect(warnings()[0]).not.toContain('Certificates');
  });

  it('a protocol change that is not the documented downgrade exempts nothing', async () => {
    // HTTPS -> TCP is not a change AWS documents as dropping the policy.
    await update(
      httpsListener({ Protocol: 'TCP' }),
      httpsListener({ Certificates: CERT, SslPolicy: 'ELBSecurityPolicy-2016-08' })
    );

    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('properties Certificates, SslPolicy were removed');
  });

  it('a property never declared is neither sent nor warned about', async () => {
    await update(tlsListener({ Port: 8443 }), tlsListener());

    const input = modifyInput();
    expect(input).not.toHaveProperty('AlpnPolicy');
    expect(input).not.toHaveProperty('MutualAuthentication');
    expect(input).not.toHaveProperty('Certificates');
    expect(warnings()).toEqual([]);
  });

  it('a kept property is still forwarded while a removed sibling is named', async () => {
    await update(
      httpsListener({ Certificates: CERT, AlpnPolicy: ['HTTP2Optional'] }),
      httpsListener({ Certificates: CERT, AlpnPolicy: ['HTTP2Optional'], MutualAuthentication: MTLS })
    );

    const input = modifyInput();
    expect(input['AlpnPolicy']).toEqual(['HTTP2Optional']);
    expect(input['Certificates']).toEqual(CERT);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('property MutualAuthentication was removed');
  });

  it('reads the caller-computed removedProperties when it is set', async () => {
    // The caller's set is authoritative: here it names nothing, so nothing is
    // warned even though the bags alone would read AlpnPolicy as removed.
    await update(tlsListener(), tlsListener({ AlpnPolicy: ['HTTP2Only'] }), {
      removedProperties: new Set(),
    });
    expect(warnings()).toEqual([]);

    await update(tlsListener(), tlsListener({ AlpnPolicy: ['HTTP2Only'] }), {
      removedProperties: new Set(['AlpnPolicy']),
    });
    expect(warnings()).toHaveLength(1);
  });

  it('says nothing on drift --revert, whose previous side is an AWS readback', async () => {
    await update(tlsListener(), tlsListener({ AlpnPolicy: ['HTTP2Only'] }), {
      desiredFromAwsReadback: true,
    });
    expect(warnings()).toEqual([]);
  });

  it('uses the rollback wording when replaying a state record', async () => {
    await update(tlsListener(), tlsListener({ AlpnPolicy: ['HTTP2Only'] }), {
      replayingState: true,
    });
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('is absent from the state being restored');
    expect(warnings()[0]).toContain('the rollback leaves the value the failed deploy applied');
  });

  it('warns nothing when ModifyListener fails', async () => {
    mockSend.mockRejectedValue(Object.assign(new Error('boom'), { name: 'ValidationError' }));
    await expect(
      update(tlsListener(), tlsListener({ AlpnPolicy: ['HTTP2Only'] }))
    ).rejects.toThrow(/Failed to update Listener MyListener/);
    expect(warnings()).toEqual([]);
  });
});

describe('ELBv2Provider removalHandledInUpdate (#1160)', () => {
  const provider = new ELBv2Provider();

  it('covers every Listener property the provider handles, so the shared caller warns about none', () => {
    const handled = [...provider.handledProperties.get(LISTENER)!];
    expect(handled.length).toBe(10);
    expect([...provider.removalHandledInUpdate.get(LISTENER)!].sort()).toEqual(
      [...handled].sort()
    );
  });

  it('leaves a listener removal out of the shared warning, which claims a CloudFormation reset', () => {
    const prepared = prepareRemovalForUpdate(
      provider,
      LISTENER,
      tlsListener(),
      tlsListener({ AlpnPolicy: ['HTTP2Only'], MutualAuthentication: MTLS })
    );
    expect(prepared.context.removedProperties).toEqual(
      new Set(['AlpnPolicy', 'MutualAuthentication'])
    );
    expect(prepared.unhandled).toEqual([]);
    expect(prepared.injected).toEqual([]);
  });

  it('does not audit LoadBalancer or TargetGroup yet', () => {
    expect(provider.removalHandledInUpdate.has('AWS::ElasticLoadBalancingV2::LoadBalancer')).toBe(
      false
    );
    expect(provider.removalHandledInUpdate.has('AWS::ElasticLoadBalancingV2::TargetGroup')).toBe(
      false
    );
  });
});
