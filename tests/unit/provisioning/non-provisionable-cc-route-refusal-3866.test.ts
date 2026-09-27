/**
 * Issue #3866: `AWS::CodeBuild::Project`, `AWS::DocDB::DBCluster` and
 * `AWS::DocDB::DBInstance` are `ProvisioningType: NON_PROVISIONABLE`, so a
 * template using one of their SDK providers' silent-drop properties must be
 * REFUSED pre-flight rather than auto-routed to Cloud Control, which has no
 * handlers for them. `AWS::DocDB::DBSubnetGroup` is provisionable and must
 * KEEP its Cloud Control route — the reason it has its own provider class.
 *
 * Runs through the REAL registration (`registerAllProviders`), because the
 * defect lived in which provider instance serves which type.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { registerAllProviders } from '../../../src/provisioning/register-providers.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.js';

function realRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registerAllProviders(registry);
  return registry;
}

const REFUSED: ReadonlyArray<{
  resourceType: string;
  property: string;
  value: unknown;
  handled: Record<string, unknown>;
}> = [
  {
    resourceType: 'AWS::CodeBuild::Project',
    // What CDK's `webhook: true` emits.
    property: 'Triggers',
    value: { Webhook: true },
    handled: { Name: 'p', ServiceRole: 'arn:aws:iam::123456789012:role/r' },
  },
  {
    resourceType: 'AWS::DocDB::DBCluster',
    property: 'EnableCloudwatchLogsExports',
    value: ['audit'],
    handled: { MasterUsername: 'admin', StorageEncrypted: true },
  },
  {
    resourceType: 'AWS::DocDB::DBInstance',
    property: 'CACertificateIdentifier',
    value: 'rds-ca-rsa2048-g1',
    handled: { DBInstanceClass: 'db.r5.large', DBClusterIdentifier: 'c' },
  },
];

describe('NON_PROVISIONABLE SDK types refuse the Cloud Control auto-route (#3866)', () => {
  for (const { resourceType, property, value, handled } of REFUSED) {
    describe(resourceType, () => {
      it(`the probed property ${property} is a silent drop, so the case exercises the auto-route`, () => {
        expect(PROPERTY_COVERAGE_BY_TYPE.get(resourceType)?.silentDrop.has(property)).toBe(true);
        expect(PROPERTY_COVERAGE_BY_TYPE.get(resourceType)?.ccRouteUnavailable).toBe(true);
      });

      it('getProviderFor refuses instead of routing via Cloud Control', () => {
        const registry = realRegistry();
        let decision: unknown;
        let error: unknown;
        try {
          decision = registry.getProviderFor({
            resourceType,
            properties: { ...handled, [property]: value },
          });
        } catch (e) {
          error = e;
        }
        expect(decision).toBeUndefined();
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).toContain(`${resourceType} uses properties`);
        expect(message).toContain('cannot fall back to Cloud Control API');
        expect(message).toContain('ProvisioningType: NON_PROVISIONABLE');
        expect(message).toContain(`  - ${property}: `);
        expect(message).toContain(`--prefer-sdk-route ${resourceType}:${property}`);
      });

      it('the pre-flight property check refuses too, before any resource is provisioned', () => {
        const registry = realRegistry();
        expect(() =>
          registry.validateResourceProperties([
            { logicalId: 'R', resourceType, properties: { ...handled, [property]: value } },
          ])
        ).toThrow(/cannot fall back to Cloud Control API/);
      });

      it('an unrecognized property stays on the SDK route and warns it has no Cloud Control route (#3713)', () => {
        const registry = realRegistry();
        const warn = vi.fn();
        (registry as unknown as { logger: Record<string, unknown> }).logger = {
          info: vi.fn(),
          warn,
          debug: vi.fn(),
          error: vi.fn(),
        };
        const properties = { ...handled, NotYetInTheSchemaSnapshot: 'x' };
        const decision = registry.getProviderFor({ resourceType, properties });
        expect(decision.provisionedBy).toBe('sdk');
        expect(decision.ccRouteReason).toBeUndefined();
        expect(() =>
          registry.validateResourceProperties([{ logicalId: 'R', resourceType, properties }])
        ).not.toThrow();
        const lines = warn.mock.calls
          .map((c) => String(c[0]))
          .filter((line) => line.includes('NotYetInTheSchemaSnapshot'));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('cannot be routed via Cloud Control API');
      });

      it('a template without the property still takes the SDK provider', () => {
        const registry = realRegistry();
        const decision = registry.getProviderFor({ resourceType, properties: handled });
        expect(decision.provisionedBy).toBe('sdk');
        expect(decision.provider.disableCcApiFallback).toBe(true);
      });
    });
  }
});

describe('AWS::DocDB::DBSubnetGroup keeps its Cloud Control route (#3866)', () => {
  const SUBNET_GROUP = 'AWS::DocDB::DBSubnetGroup';

  it('is served by a provider that does not opt out, distinct from the cluster/instance one', () => {
    const registry = realRegistry();
    const subnetGroup = registry.getProviderFor({ resourceType: SUBNET_GROUP }).provider;
    const cluster = registry.getProviderFor({ resourceType: 'AWS::DocDB::DBCluster' }).provider;
    const instance = registry.getProviderFor({ resourceType: 'AWS::DocDB::DBInstance' }).provider;
    expect(subnetGroup.disableCcApiFallback).not.toBe(true);
    expect(subnetGroup).not.toBe(cluster);
    expect(cluster).toBe(instance);
    expect(PROPERTY_COVERAGE_BY_TYPE.get(SUBNET_GROUP)?.ccRouteUnavailable).toBe(false);
  });

  it('an unrecognized property still auto-routes it via Cloud Control (#3713) rather than refusing', () => {
    const registry = realRegistry();
    const decision = registry.getProviderFor({
      resourceType: SUBNET_GROUP,
      properties: {
        DBSubnetGroupDescription: 'd',
        SubnetIds: ['subnet-a', 'subnet-b'],
        NotYetInTheSchemaSnapshot: 'x',
      },
    });
    expect(decision.provisionedBy).toBe('cc-api');
    expect(decision.ccRouteReason?.properties).toEqual(['NotYetInTheSchemaSnapshot']);
  });

  it('a fully handled template stays on the SDK provider', () => {
    const registry = realRegistry();
    const decision = registry.getProviderFor({
      resourceType: SUBNET_GROUP,
      properties: { DBSubnetGroupDescription: 'd', SubnetIds: ['subnet-a', 'subnet-b'] },
    });
    expect(decision.provisionedBy).toBe('sdk');
  });
});
