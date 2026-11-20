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

const HTTP2 = distribution({
  CustomOriginConfig: { OriginProtocolPolicy: 'https-only', OriginHttpVersion: 'http2' },
});
const PLAIN = distribution({ CustomOriginConfig: { OriginProtocolPolicy: 'https-only' } });

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
    expect(paths).toBeGreaterThanOrEqual(10);
  });
});

describe('findSdkUnmodelledNestedProperties', () => {
  it('finds a member inside any array element, and names the top-level once', () => {
    expect(findSdkUnmodelledNestedProperties(DISTRIBUTION, HTTP2)).toEqual([
      {
        property: 'DistributionConfig',
        rationale: sdkUnmodelledNestedRationale(
          'DistributionConfig.Origins.CustomOriginConfig.OriginHttpVersion'
        ),
      },
    ]);
    const vpc = distribution({ VpcOriginConfig: { VpcOriginId: 'vo-1', OriginHttpVersion: 'http1.1' } });
    expect(findSdkUnmodelledNestedProperties(DISTRIBUTION, vpc).map((r) => r.property)).toEqual([
      'DistributionConfig',
    ]);
  });

  it.each([
    ['a plain distribution', DISTRIBUTION, PLAIN],
    [
      'a null member',
      DISTRIBUTION,
      distribution({ CustomOriginConfig: { OriginProtocolPolicy: 'https-only', OriginHttpVersion: null } }),
    ],
    ['an empty guardrail list', ZONE, { Name: 'example.com', HostedZoneFeatures: { ChangeGuardrails: [] } }],
    [
      'a zone using only modelled members',
      ZONE,
      {
        Name: 'example.com',
        HostedZoneConfig: { Comment: 'c' },
        HostedZoneFeatures: { EnableAcceleratedRecovery: true },
      },
    ],
    ['a type with no declaration', 'AWS::SQS::Queue', { QueueName: 'q' }],
    ['no bag', DISTRIBUTION, undefined],
  ])('finds nothing on %s', (_label, type, bag) => {
    expect(findSdkUnmodelledNestedProperties(type, bag)).toEqual([]);
  });

  it.each([
    ['HostedZoneConfig', { HostedZoneConfig: { Comment: 'c', HostedZoneTier: 'STANDARD' } }],
    ['HostedZoneFeatures', { HostedZoneFeatures: { EnablePublicDNSFallback: false } }],
    ['HostedZoneFeatures', { HostedZoneFeatures: { ChangeHistory: { Status: 'ENABLED' } } }],
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
    const routed = r.getProviderFor({ resourceType: DISTRIBUTION, properties: HTTP2 });
    expect(routed.provisionedBy).toBe('cc-api');
    expect(routed.provider).toBe(r.getCloudControlProvider());
    expect(r.getProviderFor({ resourceType: DISTRIBUTION, properties: PLAIN }).provisionedBy).toBe('sdk');

    const zone = { Name: 'example.com', HostedZoneFeatures: { ChangeHistory: { Status: 'ENABLED' } } };
    expect(r.getProviderFor({ resourceType: ZONE, properties: zone }).provisionedBy).toBe('cc-api');
  });

  it('is a route, not a drop: the record and diff narrowings never see it', () => {
    expect(findSdkUnwiredProperties(DISTRIBUTION, HTTP2)).toEqual([]);
    expect(findActionableSdkUnwired(DISTRIBUTION, HTTP2, new Set()).map((d) => d.property)).toEqual([
      'DistributionConfig',
    ]);
  });

  it('--prefer-sdk-route on the top-level keeps the SDK route', () => {
    const allowed = new Set([`${DISTRIBUTION}:DistributionConfig`]);
    expect(findActionableSdkUnwired(DISTRIBUTION, HTTP2, allowed)).toEqual([]);
  });

  it('tells the user why the resource goes through Cloud Control', () => {
    const r = registry();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    (r as unknown as { logger: typeof logger }).logger = logger;
    r.reportSdkUnwiredDecisions([
      { logicalId: 'Dist', resourceType: DISTRIBUTION, properties: HTTP2 },
      { logicalId: 'Plain', resourceType: DISTRIBUTION, properties: PLAIN },
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    const line = logger.info.mock.calls[0]![0] as string;
    expect(line).toContain('Dist (AWS::CloudFront::Distribution): routing via Cloud Control API');
    expect(line).toContain(
      'DistributionConfig: DistributionConfig.Origins.CustomOriginConfig.OriginHttpVersion is not modelled'
    );
    expect(line).not.toContain('does not yet wire');
    expect(line).toContain(`--prefer-sdk-route ${DISTRIBUTION}:DistributionConfig`);
  });

  it('warns when --prefer-sdk-route keeps the resource where the member is dropped', () => {
    const r = registry();
    const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
    (r as unknown as { logger: typeof logger }).logger = logger;
    r.allowUnsupportedProperties([`${DISTRIBUTION}:DistributionConfig`]);
    expect(r.getProviderFor({ resourceType: DISTRIBUTION, properties: HTTP2 }).provisionedBy).toBe('sdk');
    r.reportSdkUnwiredDecisions([
      { logicalId: 'Dist', resourceType: DISTRIBUTION, properties: HTTP2 },
      { logicalId: 'Plain', resourceType: DISTRIBUTION, properties: PLAIN },
    ]);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const line = logger.warn.mock.calls[0]![0] as string;
    expect(line).toContain('Dist (AWS::CloudFront::Distribution): --prefer-sdk-route keeps');
    expect(line).toContain('OriginHttpVersion is not modelled');
  });

  it('keeps a Cloud-Control-recorded resource there until BOTH bags drop the member', () => {
    const back = (desired: Record<string, unknown>, previous: Record<string, unknown>): boolean =>
      wouldReturnToSdkProvider({
        resourceType: DISTRIBUTION,
        desiredProperties: desired,
        previousProperties: previous,
      });
    expect(back(HTTP2, HTTP2)).toBe(false);
    // The removal deploy: Cloud Control must clear the member it applied.
    expect(back(PLAIN, HTTP2)).toBe(false);
    expect(back(PLAIN, PLAIN)).toBe(true);
  });
});
