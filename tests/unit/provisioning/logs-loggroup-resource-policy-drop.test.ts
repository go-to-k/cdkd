/**
 * `AWS::Logs::LogGroup.ResourcePolicyDocument` declaration guard
 * (issue [#1412](https://github.com/go-to-k/cdkd/issues/1412)).
 *
 * The property used to sit in `LogsLogGroupProvider.handledProperties` purely
 * to keep the log group off the Cloud Control fallback path — the `create()`
 * site said so outright — while nothing wired it. A template setting it
 * therefore deployed with the policy silently discarded.
 *
 * It has no `CreateLogGroup` / `PutRetentionPolicy` counterpart: the value maps
 * to the separate `AWS::Logs::ResourcePolicy` type, whose `PutResourcePolicy`
 * API is ACCOUNT-wide rather than per-log-group, so owning it from this
 * provider would require inventing an ownership/lifecycle answer (which policy
 * name to claim, what to do on delete, how to reconcile two log groups with
 * conflicting documents). Managing the sibling resource is a separate feature.
 *
 * The fix declares the drop instead, which turns the invisible loss into the
 * #614 routing signal: a log group whose template sets it is provisioned
 * through Cloud Control API, where AWS's own resource handler applies the
 * policy. Each test below fails against the pre-fix declaration.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: {
      send: vi.fn(() => Promise.resolve({ Account: '123456789012' })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

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

import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { findSilentDropProperties } from '../../../src/provisioning/property-coverage.js';

const RESOURCE_TYPE = 'AWS::Logs::LogGroup';
const PROPERTY = 'ResourcePolicyDocument';

describe('AWS::Logs::LogGroup ResourcePolicyDocument (issue #1412)', () => {
  it('is NOT declared handled — the provider never delivers it to any Logs call', () => {
    const provider = new LogsLogGroupProvider();
    const handled = provider.handledProperties.get(RESOURCE_TYPE);
    expect(handled, 'LogsLogGroupProvider must declare handled properties').toBeDefined();
    expect([...handled!]).not.toContain(PROPERTY);
    // Everything this provider genuinely wires stays declared.
    expect([...handled!]).toEqual(
      expect.arrayContaining([
        'LogGroupName',
        'KmsKeyId',
        'RetentionInDays',
        'Tags',
        'DataProtectionPolicy',
        'LogGroupClass',
        'FieldIndexPolicies',
        'DeletionProtectionEnabled',
        'BearerTokenAuthenticationEnabled',
      ])
    );
  });

  it('is declared unhandledByDesign with a rationale naming the owning resource type', () => {
    const provider = new LogsLogGroupProvider();
    const byDesign = provider.unhandledByDesign?.get(RESOURCE_TYPE);
    expect(byDesign, 'the log group must carry an unhandledByDesign map').toBeDefined();
    const rationale = byDesign!.get(PROPERTY);
    expect(rationale, `${PROPERTY} must carry a rationale`).toBeDefined();
    expect(rationale!.length).toBeGreaterThan(20);
    expect(rationale).toMatch(/AWS::Logs::ResourcePolicy/);
  });

  it('is reported as a silent drop at pre-flight, so the resource auto-routes via CC API', () => {
    const drops = findSilentDropProperties(RESOURCE_TYPE, {
      LogGroupName: '/cdkd/probe',
      ResourcePolicyDocument: { Version: '2012-10-17', Statement: [] },
    });
    expect(drops.map((d) => d.property)).toContain(PROPERTY);
  });

  it('routes a log group that sets it through Cloud Control, and one that does not through the SDK provider', () => {
    const registry = new ProviderRegistry();
    registry.register(RESOURCE_TYPE, new LogsLogGroupProvider());

    const withPolicy = registry.getProviderFor({
      resourceType: RESOURCE_TYPE,
      properties: {
        LogGroupName: '/cdkd/probe',
        ResourcePolicyDocument: { Version: '2012-10-17', Statement: [] },
      },
    });
    expect(withPolicy.provisionedBy).toBe('cc-api');
    expect(withPolicy.provider).toBe(registry.getCloudControlProvider());

    const withoutPolicy = registry.getProviderFor({
      resourceType: RESOURCE_TYPE,
      properties: { LogGroupName: '/cdkd/probe', RetentionInDays: 7 },
    });
    expect(withoutPolicy.provisionedBy).toBe('sdk');
    expect(withoutPolicy.provider).not.toBe(registry.getCloudControlProvider());
  });

  it('does not opt out of the Cloud Control fallback, so no template is hard-rejected', () => {
    // The #614 viability guard throws pre-flight when a silent-drop type cannot
    // be CC-routed. Declaring the drop is only the honest answer while that
    // route stays available — pin it so a later `disableCcApiFallback` addition
    // cannot silently convert this into a hard reject.
    // Indexed through a record view on purpose: the provider class does not
    // DECLARE `disableCcApiFallback` at all (that absence is the thing being
    // pinned), so a direct property access does not type-check.
    const provider = new LogsLogGroupProvider() as unknown as Record<string, unknown>;
    expect(provider['disableCcApiFallback']).toBeUndefined();
  });
});
