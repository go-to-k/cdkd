// go-to-k/cdkd#6690: a nested member the shipped AWS SDK client does not model
// routes its resource through Cloud Control, which forwards it, instead of
// letting the SDK serializer drop it on a "successful" deploy.
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  ProviderRegistry,
  STICKY_CC_MIGRATION_EXEMPT,
  wouldReturnToSdkProvider,
} from '../../../src/provisioning/provider-registry.js';
import { CloudFrontDistributionProvider } from '../../../src/provisioning/providers/cloudfront-distribution-provider.js';
import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import {
  findActionableSdkUnwired,
  findSdkUnwiredProperties,
  getPropertyCoverage,
} from '../../../src/provisioning/property-coverage.js';
import {
  SDK_UNMODELLED_NESTED_PATHS,
  findSdkUnmodelledNestedProperties,
  sdkUnmodelledNestedRationale,
} from '../../../src/provisioning/sdk-unmodelled-nested-paths.js';

const DISTRIBUTION = 'AWS::CloudFront::Distribution';
const ZONE = 'AWS::Route53::HostedZone';

function zone(features: Record<string, unknown>): Record<string, unknown> {
  return { Name: 'example.com', HostedZoneConfig: { Comment: 'c' }, HostedZoneFeatures: features };
}

const GUARDED = zone({
  EnableAcceleratedRecovery: true,
  ChangeGuardrails: [
    { Name: 'NS_OCCLUSION_CHECK', Status: 'DISABLED' },
    { Name: 'DNSSEC_CHECK', Status: 'ENABLED' },
  ],
  EnablePublicDNSFallback: true,
});
const PLAIN = zone({ EnableAcceleratedRecovery: true });

function distribution(origin: Record<string, unknown>): Record<string, unknown> {
  return {
    DistributionConfig: {
      Enabled: true,
      DefaultCacheBehavior: { TargetOriginId: 'o2', ViewerProtocolPolicy: 'allow-all' },
      Origins: [
        { Id: 'o1', DomainName: 'a.example.com', CustomOriginConfig: { OriginProtocolPolicy: 'https-only' } },
        { Id: 'o2', DomainName: 'b.example.com', ...origin },
      ],
    },
  };
}

// @aws-sdk/client-cloudfront models OriginHttpVersion since 3.1175.0
// (go-to-k/cdkd#6932), so it is no longer declared.
const HTTP_VERSION = distribution({
  CustomOriginConfig: { OriginProtocolPolicy: 'https-only', OriginHttpVersion: 'http1.1' },
});

function registry(): ProviderRegistry {
  const r = new ProviderRegistry();
  r.register(DISTRIBUTION, new CloudFrontDistributionProvider());
  r.register(ZONE, new Route53Provider());
  return r;
}

describe('the declaration', () => {
  it('names only paths the schema fixture lists, under a top-level the SDK provider handles', () => {
    let paths = 0;
    for (const [type, declared] of Object.entries(SDK_UNMODELLED_NESTED_PATHS)) {
      const file = `tests/fixtures/cfn-schemas/${type.replaceAll('::', '-')}.json`;
      const nested = (
        JSON.parse(readFileSync(file, 'utf8')) as {
          nestedPropertyPaths: Record<string, string[]>;
        }
      ).nestedPropertyPaths;
      const coverage = getPropertyCoverage(type);
      expect(coverage, type).toBeDefined();
      expect(coverage!.ccRouteUnavailable, type).toBe(false);
      // Otherwise a routed resource never returns once the SDK models it.
      expect(STICKY_CC_MIGRATION_EXEMPT.get(type)?.mode, type).toBe('sdk-coverage');
      for (const path of declared) {
        const [top, ...rest] = path.split('.');
        expect(coverage!.handled.has(top!), path).toBe(true);
        expect(nested[top!] ?? [], path).toContain(rest.join('.'));
        paths++;
      }
    }
    expect(paths).toBeGreaterThanOrEqual(5);
  });
});

describe('findSdkUnmodelledNestedProperties', () => {
  it('finds a member in a non-empty array, and names the top-level once', () => {
    expect(findSdkUnmodelledNestedProperties(ZONE, GUARDED)).toEqual([
      {
        property: 'HostedZoneFeatures',
        rationale: sdkUnmodelledNestedRationale('HostedZoneFeatures.ChangeGuardrails'),
      },
    ]);
  });

  it.each([
    ['a zone using only modelled members', ZONE, PLAIN],
    ['a null member', ZONE, zone({ EnableAcceleratedRecovery: true, EnablePublicDNSFallback: null })],
    ['an empty guardrail list', ZONE, zone({ ChangeGuardrails: [] })],
    ['a distribution setting OriginHttpVersion', DISTRIBUTION, HTTP_VERSION],
    [
      'a distribution setting VpcOriginConfig.OriginHttpVersion',
      DISTRIBUTION,
      distribution({ VpcOriginConfig: { VpcOriginId: 'vo-1', OriginHttpVersion: 'http1.1' } }),
    ],
    ['a type with no declaration', 'AWS::SQS::Queue', { QueueName: 'q' }],
    ['no bag', ZONE, undefined],
  ])('finds nothing on %s', (_label, type, bag) => {
    expect(findSdkUnmodelledNestedProperties(type, bag)).toEqual([]);
  });

  it.each([
    ['HostedZoneConfig', { HostedZoneConfig: { Comment: 'c', HostedZoneTier: 'STANDARD' } }],
    ['HostedZoneFeatures', { HostedZoneFeatures: { EnablePublicDNSFallback: false } }],
    [
      'HostedZoneFeatures',
      { HostedZoneFeatures: { ChangeGuardrails: [{ Name: 'NS_OCCLUSION_CHECK', Status: 'ENABLED' }] } },
    ],
  ])('routes a zone on %s', (top, extra) => {
    expect(
      findSdkUnmodelledNestedProperties(ZONE, { Name: 'example.com', ...extra }).map((r) => r.property)
    ).toEqual([top]);
  });
});

describe('routing', () => {
  it('routes the resource through Cloud Control, and a plain one stays on the SDK provider', () => {
    const r = registry();
    const routed = r.getProviderFor({ resourceType: ZONE, properties: GUARDED });
    expect(routed.provisionedBy).toBe('cc-api');
    expect(routed.provider).toBe(r.getCloudControlProvider());
    expect(r.getProviderFor({ resourceType: ZONE, properties: PLAIN }).provisionedBy).toBe('sdk');
  });

  it('is a route, not a drop: the record and diff narrowings never see it', () => {
    expect(findSdkUnwiredProperties(ZONE, GUARDED)).toEqual([]);
    expect(findActionableSdkUnwired(ZONE, GUARDED, new Set()).map((d) => d.property)).toEqual([
      'HostedZoneFeatures',
    ]);
  });

  it('--prefer-sdk-route on the top-level keeps the SDK route', () => {
    const allowed = new Set([`${ZONE}:HostedZoneFeatures`]);
    expect(findActionableSdkUnwired(ZONE, GUARDED, allowed)).toEqual([]);
  });

  it('tells the user why the resource goes through Cloud Control', () => {
    const r = registry();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    (r as unknown as { logger: typeof logger }).logger = logger;
    r.reportSdkUnwiredDecisions([
      { logicalId: 'Zone', resourceType: ZONE, properties: GUARDED },
      { logicalId: 'Plain', resourceType: ZONE, properties: PLAIN },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = logger.info.mock.calls[0]![0] as string;
    expect(line).toContain('Zone (AWS::Route53::HostedZone): routing via Cloud Control API');
    expect(line).toContain(
      "HostedZoneFeatures: HostedZoneFeatures.ChangeGuardrails is not sent by cdkd's SDK provider"
    );
    expect(line).not.toContain('not modelled');
    expect(line).not.toContain('does not yet wire');
    expect(line).toContain(`--prefer-sdk-route ${ZONE}:HostedZoneFeatures`);
  });

  it('warns when --prefer-sdk-route keeps the resource where the member is dropped', () => {
    const r = registry();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    (r as unknown as { logger: typeof logger }).logger = logger;
    r.allowUnsupportedProperties([`${ZONE}:HostedZoneFeatures`]);
    expect(r.getProviderFor({ resourceType: ZONE, properties: GUARDED }).provisionedBy).toBe('sdk');
    r.reportSdkUnwiredDecisions([
      { logicalId: 'Zone', resourceType: ZONE, properties: GUARDED },
      { logicalId: 'Plain', resourceType: ZONE, properties: PLAIN },
    ]);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = logger.warn.mock.calls[0]![0] as string;
    expect(line).toContain('Zone (AWS::Route53::HostedZone): --prefer-sdk-route keeps');
    expect(line).toContain("ChangeGuardrails is not sent by cdkd's SDK provider");
  });

  it('keeps a Cloud-Control-recorded resource there until BOTH bags drop the member', () => {
    const back = (desired: Record<string, unknown>, previous: Record<string, unknown>): boolean =>
      wouldReturnToSdkProvider({
        resourceType: ZONE,
        desiredProperties: desired,
        previousProperties: previous,
      });
    expect(back(GUARDED, GUARDED)).toBe(false);
    // The removal deploy: Cloud Control must clear the member it applied.
    expect(back(PLAIN, GUARDED)).toBe(false);
    expect(back(PLAIN, PLAIN)).toBe(true);
  });
});

describe('a distribution setting OriginHttpVersion (go-to-k/cdkd#6932)', () => {
  it('stays on the SDK provider, which sends and reads back the member', () => {
    const r = registry();
    expect(r.getProviderFor({ resourceType: DISTRIBUTION, properties: HTTP_VERSION }).provisionedBy).toBe(
      'sdk'
    );
    expect(findActionableSdkUnwired(DISTRIBUTION, HTTP_VERSION, new Set())).toEqual([]);

    const provider = new CloudFrontDistributionProvider();
    const config = HTTP_VERSION['DistributionConfig'] as Record<string, unknown>;
    const sdk = provider.convertToSdkFormat(config);
    const items = (sdk['Origins'] as { Items: Array<Record<string, Record<string, unknown>>> }).Items;
    expect(items[1]!['CustomOriginConfig']!['OriginHttpVersion']).toBe('http1.1');
    const cfn = provider.convertToCfnFormat(sdk);
    const origins = cfn['Origins'] as Array<Record<string, Record<string, unknown>>>;
    expect(origins[1]!['CustomOriginConfig']!['OriginHttpVersion']).toBe('http1.1');
  });

  it('returns a distribution recorded on Cloud Control for the member to the SDK provider', () => {
    expect(
      wouldReturnToSdkProvider({
        resourceType: DISTRIBUTION,
        desiredProperties: HTTP_VERSION,
        previousProperties: HTTP_VERSION,
      })
    ).toBe(true);
  });
});
