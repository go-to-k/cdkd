import { applyDefaultNameForFallback } from '../../provisioning/resource-name.js';
import type { ProviderRegistry } from '../../provisioning/provider-registry.js';
import type { ResourceChange, ResourceState } from '../../types/state.js';
import { deriveLabelRouting } from '../label-routing.js';
import type { DeployEngineOptions } from './options.js';

/**
 * Is this resource pinned to Cloud Control for this deploy (`--pin-cc-api`)?
 *
 * ONE implementation, called by the update dispatch and by the progress
 * label. They carried separate copies of this expression for one revision,
 * and a mutation probe caught the predictable result: neutering the LABEL's
 * copy left every test green, because the only cases that existed exercised
 * the dispatch's. Same shape as the duplicated flip predicate this lane
 * already collapsed once.
 *
 * SCOPED BY STACK, like `recreateTargets`. `NestedStackProvider.runChildDeploy`
 * spreads the parent's options into every child engine, and a logical id is
 * unique only within one template, so an unscoped set would pin a same-named
 * resource in a stack the user never named — silently, since a pin produces
 * no output of its own.
 */
export function isPinnedToCcApi(
  options: Pick<DeployEngineOptions, 'pinCcApi'>,
  stackName: string,
  logicalId: string
): boolean {
  return options.pinCcApi?.stackName === stackName && options.pinCcApi.logicalIds.has(logicalId);
}

/**
 * The `--recreate-via-*` direction for this resource, or `undefined`.
 *
 * Stack-scoped for the same reason as {@link isPinnedToCcApi}, and extracted
 * for a sharper one: the LABEL and the DISPATCH were computing "is this a
 * replacement" from DIFFERENT expressions. The dispatch asks
 * `propertyDrivenReplacement || recreateFlagged`; the label asked only the
 * property half. So a `--recreate-via-*` target whose property change does
 * not itself force a replacement took the label's non-replacement path and
 * was routed from the state record, while the dispatch routed it from the
 * flag -- mislabelling in BOTH directions, and rendering `Updating` over a
 * destroy + recreate.
 *
 * Three review rounds fixed three instances of that one class (the pin, then
 * the sticky inputs, then this) by subtracting one input at a time from the
 * label. The class closes by asking the same QUESTION at both sites instead.
 */
export function recreateDirectionFor(
  options: Pick<DeployEngineOptions, 'recreateTargets'>,
  stackName: string,
  logicalId: string
): 'sdk' | 'cc-api' | undefined {
  const targets =
    options.recreateTargets?.stackName === stackName ? options.recreateTargets : undefined;
  if (targets === undefined) return undefined;
  if (targets.viaCcApi.has(logicalId)) return 'cc-api';
  if (targets.viaSdkProvider.has(logicalId)) return 'sdk';
  return undefined;
}

export function peekRoutingForLabel(
  providerRegistry: ProviderRegistry,
  options: Pick<DeployEngineOptions, 'pinCcApi'>,
  change: ResourceChange,
  existingState: ResourceState | undefined,
  stackName: string,
  logicalId: string,
  needsReplacement = false,
  recreateDirection?: 'sdk' | 'cc-api'
): 'sdk' | 'cc-api' | undefined {
  // The pin is resolved HERE rather than inside `deriveLabelRouting` because
  // that function is exported and unit-tested without an engine; keeping it
  // free of `options` is what lets it be called with a plain registry.
  // `needsReplacement` already folds in the flag half -- the caller computes
  // it once so the VERB and this tag cannot disagree, which is the whole
  // lesson of {@link recreateDirectionFor}'s docstring.
  if (needsReplacement) {
    // Mirror `replaceDecision` argument for argument: it routes the NEW
    // physical resource, so it passes the recreate hint as `provisionedBy`
    // (never the record's layer — stickiness exists to spare an EXISTING
    // resource from churn, and a replacement is not that), `forceCcApi` only
    // for the CC direction, and the record's bag as `previousProperties` —
    // the baseline an unrecognized property is compared against (issue
    // #3713). `deriveLabelRouting` derives both from this synthetic record,
    // so it carries the hint and the record's `properties`, nothing else.
    const hintRecord = {
      ...(recreateDirection !== undefined && { provisionedBy: recreateDirection }),
      ...(existingState?.properties !== undefined && { properties: existingState.properties }),
    };
    return deriveLabelRouting(change, hintRecord, providerRegistry, recreateDirection === 'cc-api');
  }
  return deriveLabelRouting(
    change,
    existingState,
    providerRegistry,
    isPinnedToCcApi(options, stackName, logicalId)
  );
}

/**
 * Prepare a property map for a Cloud Control API call. When a Tier 1
 * resource is routed via Cloud Control (either because the user's
 * template hit silent-drop properties under #614 or because the resource
 * is sticky-routed via `provisionedBy: 'cc-api'`), CC requires the full
 * property map — including identifier-like fields (`BucketName`,
 * `RoleName`, etc.) that the SDK provider would have auto-generated.
 * This helper threads the property prep through the registered SDK
 * provider's `preparePropertiesForFallback` hook when defined, falling
 * back to `applyDefaultNameForFallback` (which mints stack-prefixed
 * names matching what the SDK provider would have done) otherwise.
 *
 * A type with no registered SDK provider (Tier 2 / CC-native) takes the
 * `applyDefaultNameForFallback` arm too, which fills a name only when the
 * type has a `FALLBACK_NAME_RULES` entry (`AWS::Lambda::CapacityProvider`,
 * issue #3174) and returns the bag unchanged otherwise. An UPDATE drops the
 * generated name again (`withoutGeneratedFallbackName`).
 */
export function preparePropertiesForCcApi(
  providerRegistry: ProviderRegistry,
  resourceType: string,
  resolvedProps: Record<string, unknown>,
  logicalId: string,
  // `'omit'` for an UPDATE, which takes the generated name back out: a name
  // only a create needs must not fail it (go-to-k/cdkd#5095).
  underivable: 'refuse' | 'omit' = 'refuse'
): Record<string, unknown> {
  const sdkProvider = providerRegistry.getRegisteredTypes().includes(resourceType)
    ? providerRegistry.getProvider(resourceType)
    : undefined;
  if (sdkProvider?.preparePropertiesForFallback) {
    return sdkProvider.preparePropertiesForFallback(logicalId, resourceType, resolvedProps);
  }
  return applyDefaultNameForFallback(logicalId, resourceType, resolvedProps, underivable);
}
