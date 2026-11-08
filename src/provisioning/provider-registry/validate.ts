import { isNonProvisionable, unsupportedTypeIssueUrl } from '../unsupported-types.js';
import {
  buildMutuallyExclusiveMessage,
  findMutuallyExclusiveViolations,
} from '../mutually-exclusive-properties.js';
import { buildNestedRequiredMessage, findNestedRequiredViolations } from '../nested-required.js';
import { validatePropertyShapes } from '../property-shape.js';
import {
  buildSecureReferenceMessage,
  findSecureReferencePaths,
} from '../custom-resource-secure-references.js';
import type { ProviderRegistry } from '../provider-registry.js';

/**
 * Validate that all resource types have available providers
 *
 * This should be called before deployment starts to ensure all resources can be provisioned.
 *
 * @param resourceTypes Set of resource types to validate
 * @throws Error if any resource type doesn't have a provider
 */
export function validateResourceTypes(this: ProviderRegistry, resourceTypes: Set<string>): void {
  const unsupportedTypes: string[] = [];

  for (const resourceType of resourceTypes) {
    if (!this.hasProvider(resourceType)) {
      unsupportedTypes.push(resourceType);
    }
  }

  if (unsupportedTypes.length > 0) {
    const details = unsupportedTypes
      .map((type) => {
        const reason = isNonProvisionable(type)
          ? 'AWS reports this type as NON_PROVISIONABLE (Cloud Control API cannot manage it) and cdkd has no SDK provider for it.'
          : "cdkd does not currently support this type — no SDK provider is registered, and the type is either on cdkd's Cloud Control blocklist (pending a dedicated SDK provider) or is not an AWS:: namespace.";
        return `  - ${type}\n      ${reason}\n      Request support: ${unsupportedTypeIssueUrl(type)}`;
      })
      .join('\n');
    throw new Error(
      `The following resource types are not supported by cdkd:\n` +
        details +
        `\n\nTo attempt deployment anyway (Cloud Control will likely fail for NON_PROVISIONABLE types), ` +
        `re-run with: --allow-unsupported-types ${unsupportedTypes.join(',')}`
    );
  }

  this.logger.debug(`Validated ${resourceTypes.size} resource types: all have available providers`);
}

/**
 * Walk every resource in the template and identify top-level CFn
 * properties cdkd's SDK provider does not wire (SDK-unwired). As of
 * issue [#614](https://github.com/go-to-k/cdkd/issues/614), SDK-unwired properties
 * auto-route the resource through Cloud Control API by default (see
 * {@link getProviderFor}) — the method emits info-level routing decisions
 * for each SDK-unwired resource, plus warn-level lines for resources
 * where the user explicitly opted into leaving it unwritten via
 * `--allow-unsupported-properties`. The ONE remaining throw path is the
 * CC-route viability guard: when the auto-route target cannot manage the
 * type (`NON_PROVISIONABLE` or a provider-level `disableCcApiFallback`
 * opt-out — e.g. AWS::FSx::FileSystem's Windows/ONTAP/OpenZFS blocks),
 * this rejects pre-flight with a clear per-property error instead of
 * letting provisioning fail opaquely.
 *
 * Must be called AFTER {@link validateResourceTypes} — type-level errors
 * are still hard rejects. For a type allowed via `--allow-unsupported-types`,
 * the property check is a no-op (`findSdkUnwiredProperties` returns `[]`
 * for non-Tier-1 / unknown types).
 *
 * Since issue [#1634](https://github.com/go-to-k/cdkd/issues/1634) this
 * ALSO runs the mutually-exclusive-property check
 * ({@link validateMutuallyExclusiveProperties}), which throws BEFORE any
 * routing decision is logged — a template CloudFormation itself rejects
 * should not first produce a page of routing chatter. Issue
 * [#1802](https://github.com/go-to-k/cdkd/issues/1802) adds the nested
 * `required` check ({@link validateNestedRequiredProperties}) at the same
 * point, for the same reason. Issue
 * [#4357](https://github.com/go-to-k/cdkd/issues/4357) puts the property
 * SHAPE check (`property-shape.ts`: a list where the schema wants an object,
 * or the reverse) FIRST, since a wrong-kind value would otherwise surface
 * through the nested `required` walk as an unrelated missing member.
 *
 * @see findAutoRouteHits for the pure-functional pre-deploy plan-builder
 *      that returns the same information without logging.
 */
export function validateResourceProperties(
  this: ProviderRegistry,
  resources: Iterable<{
    logicalId: string;
    resourceType: string;
    properties: Record<string, unknown> | undefined;
    provisionedBy?: 'sdk' | 'cc-api' | undefined;
    previousProperties?: Record<string, unknown> | undefined;
  }>
): void {
  // Materialized because it is walked TWICE below and the caller's argument
  // is an Iterable — the deploy engine passes an array today, but a
  // generator would be silently empty on the second pass.
  const materialized = [...resources];
  validatePropertyShapes(materialized);
  this.validateMutuallyExclusiveProperties(materialized);
  this.validateNestedRequiredProperties(materialized);
  this.validateCustomResourceSecureReferences(materialized);
  this.reportSdkUnwiredDecisions(materialized);
}

/**
 * Reject a template that declares two or more MUTUALLY EXCLUSIVE top-level
 * properties on one resource (issue
 * [#1634](https://github.com/go-to-k/cdkd/issues/1634)).
 *
 * Aggregated into ONE error listing every offending resource, mirroring
 * {@link validateResourceTypes} — a template with three bad routes should
 * report three, not fail three deploys in a row. There is deliberately no
 * `--allow-*` escape hatch: the combination is invalid at CloudFormation and
 * at the service API, so the only correct outcome is a template edit (see
 * the rule module's header).
 *
 * Unlike the provider-side refusal this fires even when the resource already
 * exists and the deploy diff classifies NO_CHANGE, which is the gap the
 * issue was filed for.
 */
export function validateMutuallyExclusiveProperties(
  this: ProviderRegistry,
  resources: Iterable<{
    logicalId: string;
    resourceType: string;
    properties: Record<string, unknown> | undefined;
  }>
): void {
  const lines: string[] = [];
  for (const { logicalId, resourceType, properties } of resources) {
    for (const violation of findMutuallyExclusiveViolations(resourceType, properties)) {
      lines.push(buildMutuallyExclusiveMessage(logicalId, violation));
    }
  }
  if (lines.length === 0) return;

  throw new Error(
    `The following resources declare mutually exclusive properties:\n` +
      lines.join('\n') +
      `\n\nCloudFormation rejects these combinations too — edit the template to ` +
      `declare only one of each set.`
  );
}

/**
 * Reject a template whose PRESENT nested property block lacks a member the
 * type's schema requires there, for the types CloudFormation was measured to
 * enforce that on (issue [#1802](https://github.com/go-to-k/cdkd/issues/1802);
 * the rule, its fail-safe bias and the measurement live in
 * `nested-required.ts`).
 *
 * Aggregated into ONE error, like {@link validateMutuallyExclusiveProperties},
 * and with no `--allow-*` escape hatch for the same reason: CloudFormation
 * rejects the template too, and declaring the member is always possible.
 */
export function validateNestedRequiredProperties(
  this: ProviderRegistry,
  resources: Iterable<{
    logicalId: string;
    resourceType: string;
    properties: Record<string, unknown> | undefined;
  }>
): void {
  const lines: string[] = [];
  for (const { logicalId, resourceType, properties } of resources) {
    for (const violation of findNestedRequiredViolations(resourceType, properties)) {
      lines.push(buildNestedRequiredMessage(logicalId, violation));
    }
  }
  if (lines.length === 0) return;

  throw new Error(
    `The following resources declare a nested property block without a member it requires:\n` +
      lines.join('\n') +
      `\n\nCloudFormation rejects these blocks too. ` +
      `Declare the missing members; leaving a whole block out is not a violation.`
  );
}

/**
 * Reject a custom resource whose properties hold a SECURE dynamic reference
 * (`{{resolve:secretsmanager:...}}` / `{{resolve:ssm-secure:...}}`), which
 * CloudFormation does not support in custom resources
 * (go-to-k/cdkd#3976; the rule lives in `custom-resource-secure-references.ts`).
 *
 * Aggregated into ONE error with no `--allow-*` escape hatch, like the two
 * checks above: CloudFormation documents the shape as unsupported. Fires on a NO_CHANGE
 * resource as well, so an existing stack holding one must edit its template
 * before its next deploy; `cdkd destroy` does not run this check.
 */
export function validateCustomResourceSecureReferences(
  this: ProviderRegistry,
  resources: Iterable<{
    logicalId: string;
    resourceType: string;
    properties: Record<string, unknown> | undefined;
  }>
): void {
  const lines: string[] = [];
  for (const { logicalId, resourceType, properties } of resources) {
    const paths = findSecureReferencePaths(resourceType, properties);
    if (paths.length > 0) lines.push(buildSecureReferenceMessage(logicalId, paths));
  }
  if (lines.length === 0) return;

  throw new Error(
    `The following custom resources pass a secure dynamic reference ` +
      `({{resolve:secretsmanager:...}} / {{resolve:ssm-secure:...}}) in their properties:\n` +
      lines.join('\n') +
      `\n\nCloudFormation does not support secure dynamic references in custom resources, ` +
      `so the template is rejected before anything is resolved. Have the handler read the ` +
      `secret itself (pass its name or ARN instead), or use a plain {{resolve:ssm:...}} ` +
      `parameter for a value that is not secret.`
  );
}
