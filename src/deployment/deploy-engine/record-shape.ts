import type { DeployEngine } from '../deploy-engine.js';
import { TemplateParser } from '../../analyzer/template-parser.js';
import { findUnrewrittenAssetReferences } from '../../assets/asset-redirect.js';
import { withoutSilentDropProperties } from '../../provisioning/property-coverage.js';
import type { CloudFormationTemplate, EffectivePropertiesResult } from '../../types/resource.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { markSameGenerationBag } from '../secret-redaction.js';

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    auditResolvedAssetReferences: OmitThisParameter<typeof auditResolvedAssetReferences>;
    /** @internal */
    extractAllDependencies: OmitThisParameter<typeof extractAllDependencies>;
    /** @internal */
    propertiesToRecord: OmitThisParameter<typeof propertiesToRecord>;
    /** @internal */
    extractTemplateAttributes: OmitThisParameter<typeof extractTemplateAttributes>;
  }
}

/**
 * Issue #1002 PR 2 — §7 step 3 post-resolution audit (defense in depth).
 * No-op in legacy mode (`options.assetRedirect` unset). In cdkd-assets
 * mode, a resolved property still naming a mapped SOURCE (CDK bootstrap)
 * bucket / repo means a template shape the §7 rewrite missed — fail the
 * resource loudly BEFORE provisioning instead of deploying a split-brain
 * reference (assets live in cdkd storage, the property points at the CDK
 * bootstrap bucket that `cdk gc` may have emptied).
 */
/** @internal */
export function auditResolvedAssetReferences(
  this: DeployEngine,
  logicalId: string,
  resourceType: string,
  resolvedProps: Record<string, unknown>
): void {
  const redirect = this.options.assetRedirect;
  if (!redirect) return;
  const findings = findUnrewrittenAssetReferences(resolvedProps, redirect);
  if (findings.length === 0) return;
  const detail = findings.map((f) => `  - ${f.path}: still references '${f.source}'`).join('\n');
  throw new ProvisioningError(
    `Unrewritten asset reference on '${logicalId}' (${resourceType}): this region uses ` +
      `cdkd-owned asset storage, but the following resolved properties still point at the ` +
      `CDK bootstrap storage that 'cdk gc' may garbage-collect:\n${detail}\n` +
      `This is a template shape cdkd's asset-reference rewrite did not cover — deploying it ` +
      `would split-brain the stack (assets in cdkd storage, properties reading the CDK ` +
      `bucket). Please report this at https://github.com/go-to-k/cdkd/issues with the ` +
      `property shape. Workaround: deploy with --use-cdk-bootstrap-assets to pin the ` +
      `legacy destinations for this app.`,
    resourceType,
    logicalId
  );
}

/**
 * Create a resource with retry for transient errors
 *
 * Some resources fail immediately after their dependencies are created due to
 * AWS eventual consistency (e.g., Lambda fails if IAM Role hasn't propagated yet).
 * CloudFormation handles this internally; cdkd retries with exponential backoff.
 */
/**
 * Extract ALL dependencies for a resource from the template.
 *
 * Uses TemplateParser.extractDependencies() to capture Ref, Fn::GetAtt,
 * and DependsOn dependencies. This ensures the state contains complete
 * dependency information for correct deletion ordering (not just DependsOn).
 *
 * Template Parameter names are filtered out (issue #1032): a `Ref` to a
 * CFn Parameter is not a provisioning-order edge, and the destroy-side
 * graph build (which reconstructs a pseudo-template from state with no
 * `Parameters` section) would warn `depends on <Param>, but <Param> not
 * found in template` for every parameter-referencing resource.
 */
/** @internal */
export function extractAllDependencies(
  this: DeployEngine,
  template: CloudFormationTemplate | undefined,
  logicalId: string
): string[] | undefined {
  const resource = template?.Resources?.[logicalId];
  if (!resource) return undefined;
  const parser = new TemplateParser();
  const parameterNames = new Set(Object.keys(template?.Parameters ?? {}));
  const deps = [...parser.extractDependencies(resource)].filter((dep) => !parameterNames.has(dep));
  return deps.length > 0 ? deps : undefined;
}

/**
 * The properties to RECORD in cdkd state for a just-provisioned resource.
 *
 * Normally the DESIRED (resolved) bag: state is the record of what the user
 * asked for, and the #1160 absent-field removal derivation reads it as the
 * previous side on the next deploy, so it must stay template-shaped.
 *
 * A provider may override it by returning `effectiveProperties` when it
 * deliberately NARROWED what it sent (issue #1591). Recording the desired
 * bag there would describe something AWS does not hold, and since
 * `readCurrentState` can only return what AWS does hold, the difference is
 * PERMANENT phantom drift — reported by every `cdkd drift`, and "repaired"
 * by `drift --revert` into another `update()` that narrows and re-reports.
 * The provider is the only layer that knows what it dropped, so it says so
 * and the engine records that instead.
 *
 * The SECOND narrowing (issue #2750) is the ROUTE's, not a provider's, and
 * the provider cannot report it: a silent-drop property is one the SDK
 * Provider has no wiring for at all, so it never sees the key to say it
 * dropped it. `provisionedBy === 'sdk'` is the whole condition — on that
 * route `getProviderFor` has already established that every silent drop in
 * this bag is allow-listed (an un-allowed one would have auto-routed the
 * resource to Cloud Control, which forwards the full map), so "what the SDK
 * route writes" and "what this deploy's flags permit dropping" are the same
 * set and no flag needs re-reading here.
 *
 * Recording the wider bag is what reopened the silent-drop class through the
 * state file: the record claimed a value AWS did not hold, so the later
 * Cloud Control re-route diffed the property as unchanged and its JSON Patch
 * omitted it. Every other reader of the bag was told the same lie —
 * `cdkd drift` (for a provider with no `readCurrentState`), rollback replay,
 * `cdkd export`, `cdkd state`.
 */
/** @internal */
export function propertiesToRecord(
  this: DeployEngine,
  desiredProperties: Record<string, unknown>,
  result: EffectivePropertiesResult,
  resourceType: string,
  provisionedBy: 'sdk' | 'cc-api'
): Record<string, unknown> {
  // Issue #2516: the desired bag is THIS pass's own resolution of today's
  // template and the provider just succeeded with it, so the object state
  // will hold is marked same-generation — the one fact the persist choke
  // point needs to write an embedded 1-3 character secret as its token
  // rather than leaving it in plaintext below the value scan's needle
  // floor. An `effectiveProperties` replacement is NOT marked HERE: a
  // provider may carry previous-state values into it (the DynamoDB
  // global-table provider restores the previous GSIs and billing mode), so an
  // object-level mark on it would vouch for leaves this pass never
  // resolved. A provider that built its bag from this pass's resolution alone
  // may mark it itself (`NestedStackProvider`, issue #4453); the narrowing
  // below keeps that mark only when it removes nothing, so such a provider
  // narrows first. Such a bag keeps the residual, stated on
  // `positionByEmbeddedSpan`.
  //
  // The mark goes on AFTER the route's silent-drop narrowing (issue #2750),
  // never before: that helper returns a NEW object whenever it drops a key,
  // so a mark taken first would sit on an object the record never holds.
  // Narrowing a bag this pass resolved leaves it this pass's own, so the
  // mark is still the engine's to make.
  if (result.effectiveProperties) {
    return provisionedBy === 'sdk'
      ? withoutSilentDropProperties(resourceType, result.effectiveProperties)
      : result.effectiveProperties;
  }
  const written =
    provisionedBy === 'sdk'
      ? withoutSilentDropProperties(resourceType, desiredProperties)
      : desiredProperties;
  return markSameGenerationBag(written);
}

/**
 * Read `DeletionPolicy` / `UpdateReplacePolicy` from the synth template
 * so they can be persisted in `ResourceState` (schema v5+). Always returns
 * both keys (`undefined` when the template does not carry the attribute)
 * so that spreading into an existing `ResourceState` reliably overrides a
 * previously-recorded value back to `undefined` — required when the user
 * removes the attribute from their CDK code. `JSON.stringify` then omits
 * the `undefined` keys when state is serialized to S3.
 */
/** @internal */
export function extractTemplateAttributes(
  this: DeployEngine,
  template: CloudFormationTemplate | undefined,
  logicalId: string
): {
  deletionPolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
  updateReplacePolicy: 'Delete' | 'Retain' | 'Snapshot' | 'RetainExceptOnCreate' | undefined;
} {
  const resource = template?.Resources?.[logicalId];
  return {
    deletionPolicy: resource?.DeletionPolicy,
    updateReplacePolicy: resource?.UpdateReplacePolicy,
  };
}
