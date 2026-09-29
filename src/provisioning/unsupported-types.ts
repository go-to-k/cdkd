/**
 * Helpers for cdkd's genuinely-unsupported resource types.
 *
 * The data ({@link NON_PROVISIONABLE_TYPES}) is generated from the
 * provider-coverage audit (`vp run gen:unsupported-types`); this module adds
 * the runtime predicates + the actionable issue link used by the pre-flight
 * check (see {@link ../provisioning/provider-registry.ProviderRegistry.validateResourceTypes}).
 */
import { NON_PROVISIONABLE_TYPES } from './unsupported-types.generated.js';

export { NON_PROVISIONABLE_TYPES };

/**
 * True if AWS reports the type as `ProvisioningType: NON_PROVISIONABLE`
 * (Cloud Control API cannot create/update/delete it) and cdkd has no SDK
 * provider for it.
 */
export function isNonProvisionable(resourceType: string): boolean {
  return NON_PROVISIONABLE_TYPES.has(resourceType);
}

/**
 * Resource types that HAVE an SDK provider and that AWS reports as
 * `ProvisioningType: NON_PROVISIONABLE` — Cloud Control has no handlers for
 * them, so the SDK provider is their only route (issue #3871).
 *
 * The generated {@link NON_PROVISIONABLE_TYPES} cannot carry them: the audit
 * behind it excludes every type with a registered provider. Without this set,
 * a route-driving key on one of these types — a silent drop (#614) or a key the
 * schema snapshot does not know (#3713) — would be auto-routed to Cloud Control
 * and fail mid-deploy with `UnsupportedActionException`. The set is per TYPE,
 * so a provider class serving provisionable types too needs nothing else.
 *
 * Membership is a MEASUREMENT: `aws cloudformation list-types --visibility
 * PUBLIC --type RESOURCE --provisioning-type NON_PROVISIONABLE`, intersected
 * with `register-providers.ts`. A provider added for a Tier 3 type must add the
 * type here; `property-coverage-cc-fallback-binding.test.ts` fails while a
 * registered type is still in the generated set and missing here. Keep it
 * sorted, one `'AWS::...'` literal per line: the property-coverage generator
 * and the schema-refresh diagnosis read it as text.
 */
export const SDK_PROVIDER_NON_PROVISIONABLE_TYPES: ReadonlySet<string> = new Set([
  'AWS::AppSync::GraphQLSchema',
  'AWS::BedrockAgentCore::Browser',
  'AWS::BedrockAgentCore::CodeInterpreter',
  'AWS::Budgets::Budget',
  'AWS::CloudFormation::WaitConditionHandle',
  'AWS::CloudWatch::AnomalyDetector',
  'AWS::CodeBuild::Project',
  'AWS::DocDB::DBCluster',
  'AWS::DocDB::DBInstance',
  'AWS::EC2::NetworkAclEntry',
  'AWS::EMR::Cluster',
  'AWS::EMR::InstanceFleetConfig',
  'AWS::FSx::FileSystem',
  'AWS::Glue::Table',
  'AWS::IAM::AccessKey',
  'AWS::IAM::Policy',
  'AWS::IAM::UserToGroupAddition',
  'AWS::SNS::TopicPolicy',
  'AWS::SQS::QueuePolicy',
]);

/**
 * The reason text for a type {@link hasNoCloudControlHandlers} answers true
 * for — ONE spelling for the routing refusal and the recreate refusal (#3887).
 */
export const NO_CC_HANDLERS_REASON =
  'ProvisioningType: NON_PROVISIONABLE — Cloud Control has no handlers for it';

/**
 * True when Cloud Control has no handlers for the type, whether or not cdkd
 * registers an SDK provider for it: the Tier 3 set plus
 * {@link SDK_PROVIDER_NON_PROVISIONABLE_TYPES}. The predicate the Cloud Control
 * auto-route reads; {@link isNonProvisionable} stays the unsupported-type one.
 */
export function hasNoCloudControlHandlers(resourceType: string): boolean {
  return isNonProvisionable(resourceType) || SDK_PROVIDER_NON_PROVISIONABLE_TYPES.has(resourceType);
}

/**
 * A 1-click pre-filled GitHub issue link requesting cdkd support for a
 * resource type. Surfaced in the pre-flight error so a user hitting an
 * unsupported type lands directly in the "request support" flow.
 */
export function unsupportedTypeIssueUrl(resourceType: string): string {
  const title = encodeURIComponent(`Support resource type ${resourceType}`);
  return `https://github.com/go-to-k/cdkd/issues/new?title=${title}&labels=resource-support`;
}
