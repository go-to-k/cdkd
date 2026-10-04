/**
 * Issue #3871: an SDK-provider type AWS reports as `NON_PROVISIONABLE` has no
 * Cloud Control route, so a key the schema snapshot does not know (#3713's
 * unrecognized-property route) must keep it on the SDK provider with a warn,
 * never auto-route it to Cloud Control, which has no handlers for it.
 *
 * The opt-out is per TYPE (`SDK_PROVIDER_NON_PROVISIONABLE_TYPES`), so four of
 * these types share a provider instance with types Cloud Control CAN manage;
 * those siblings must keep their route. Runs through the REAL registration.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { loadProviderClasses, registerAllProviders } from '../../../src/provisioning/register-providers.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.js';
import { SDK_PROVIDER_NON_PROVISIONABLE_TYPES } from '../../../src/provisioning/unsupported-types.js';

const providerClasses = await loadProviderClasses();

/** A key no CFn schema carries. */
const UNKNOWN = 'CdkdKeyNotInTheSchemaSnapshot';

function realRegistry(): { registry: ProviderRegistry; warn: ReturnType<typeof vi.fn> } {
  const registry = new ProviderRegistry();
  registerAllProviders(registry, providerClasses);
  const warn = vi.fn();
  (registry as unknown as { logger: Record<string, unknown> }).logger = {
    info: vi.fn(),
    warn,
    debug: vi.fn(),
    error: vi.fn(),
  };
  return { registry, warn };
}

/** The eleven types that still had a Cloud Control route before #3871. */
const FIXED = [
  'AWS::AppSync::GraphQLSchema',
  'AWS::BedrockAgentCore::Browser',
  'AWS::BedrockAgentCore::CodeInterpreter',
  'AWS::Budgets::Budget',
  'AWS::CloudFormation::WaitConditionHandle',
  'AWS::EC2::NetworkAclEntry',
  'AWS::Glue::Table',
  'AWS::IAM::Policy',
  'AWS::IAM::UserToGroupAddition',
  'AWS::SNS::TopicPolicy',
  'AWS::SQS::QueuePolicy',
] as const;

/** Each co-hosted NON_PROVISIONABLE type with a provisionable sibling on the same instance. */
const CO_HOSTED: ReadonlyArray<{ type: string; sibling: string }> = [
  { type: 'AWS::AppSync::GraphQLSchema', sibling: 'AWS::AppSync::GraphQLApi' },
  { type: 'AWS::EC2::NetworkAclEntry', sibling: 'AWS::EC2::NetworkAcl' },
  { type: 'AWS::Glue::Table', sibling: 'AWS::Glue::Database' },
  { type: 'AWS::IAM::UserToGroupAddition', sibling: 'AWS::IAM::Group' },
];

describe('NON_PROVISIONABLE SDK types keep an unrecognized key on the SDK route (#3871)', () => {
  for (const resourceType of FIXED) {
    describe(resourceType, () => {
      it('is listed as having no Cloud Control handlers, and its coverage says so', () => {
        expect(SDK_PROVIDER_NON_PROVISIONABLE_TYPES.has(resourceType)).toBe(true);
        expect(PROPERTY_COVERAGE_BY_TYPE.get(resourceType)?.ccRouteUnavailable).toBe(true);
      });

      it('getProviderFor keeps it on the SDK provider instead of routing via Cloud Control', () => {
        const { registry } = realRegistry();
        const decision = registry.getProviderFor({ resourceType, properties: { [UNKNOWN]: 'x' } });
        expect(decision.provisionedBy).toBe('sdk');
        expect(decision.ccRouteReason).toBeUndefined();
      });

      it('pre-flight warns once that the key has no Cloud Control route, and does not refuse', () => {
        const { registry, warn } = realRegistry();
        expect(() =>
          registry.validateResourceProperties([
            { logicalId: 'R', resourceType, properties: { [UNKNOWN]: 'x' } },
          ])
        ).not.toThrow();
        const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(UNKNOWN));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('cannot be routed via Cloud Control API');
        expect(lines[0]).toContain('NON_PROVISIONABLE');
      });
    });
  }
});

describe('a provisionable type sharing the provider instance keeps its Cloud Control route (#3871)', () => {
  for (const { type, sibling } of CO_HOSTED) {
    it(`${sibling} (co-hosted with ${type}) still auto-routes an unrecognized key via Cloud Control`, () => {
      const { registry } = realRegistry();
      // The premise: the two types share ONE provider instance, so a
      // provider-level opt-out could not have told them apart.
      expect(registry.getProviderFor({ resourceType: sibling }).provider).toBe(
        registry.getProviderFor({ resourceType: type }).provider
      );
      expect(SDK_PROVIDER_NON_PROVISIONABLE_TYPES.has(sibling)).toBe(false);
      expect(PROPERTY_COVERAGE_BY_TYPE.get(sibling)?.ccRouteUnavailable).toBe(false);

      const decision = registry.getProviderFor({
        resourceType: sibling,
        properties: { [UNKNOWN]: 'x' },
      });
      expect(decision.provisionedBy).toBe('cc-api');
      expect(decision.ccRouteReason?.properties).toEqual([UNKNOWN]);
    });
  }
});
