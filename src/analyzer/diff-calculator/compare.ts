import type { TemplateResource } from '../../types/resource.js';
import type { PropertyChange, AttributeChange, ResourceState } from '../../types/state.js';
import type { ReplacementSiblings } from '../replacement-rules.js';
import {
  getCreateOnlyPropertyPaths,
  createOnlyChangeRequiresReplacement,
} from '../../provisioning/create-only-properties.js';
import { AWS_NO_VALUE } from '../../deployment/intrinsic-function-resolver.js';
import { maskerOrIdentity, type MaskerFn } from '../../provisioning/masked-retry-logger.js';
import { safeMsg } from '../../utils/display-safe.js';
import { DiffCalculator } from '../diff-calculator.js';
import { type IntrinsicResolveFn, replacementSidesForLog } from './shared.js';

/**
 * Best-effort resolution of template property intrinsics against current state.
 *
 * Iterates top-level properties and resolves each independently: if resolution
 * throws (e.g. Ref to a resource that isn't in state yet), the original value
 * is kept so downstream comparison falls back to the "assume intrinsic equals
 * anything" behavior for that one value instead of failing the whole diff.
 */
export async function resolveBestEffort(
  this: DiffCalculator,
  properties: Record<string, unknown>,
  resolveFn: IntrinsicResolveFn
): Promise<Record<string, unknown>> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    try {
      // Resolve a CLONE. The reason is the OWNERSHIP contract, not any
      // resolver's behaviour: this value is a leaf of a template its CALLER
      // still shares with other consumers, so nothing here may let a resolver
      // write through it. Both call sites share it — `cdkd diff` hands the
      // same object on to the Outputs resolution that follows, and `cdkd
      // deploy` re-resolves it against the in-flight state and provisions
      // from it. The deploy one is the consequence with teeth: a
      // resolved current-state value baked in here would still be read as a
      // literal then, and a genuinely-changed dependent of an in-place-updated
      // upstream would be skipped. Cloning makes that impossible whatever the
      // resolver does.
      // (The resolver does not mutate its input today: `resolveSub` wrote back
      // into the caller's `Fn::Sub` variable map until go-to-k/cdkd#2764
      // retired it, and this comment named that write-back. Kept as history so
      // the clone is not read as dead weight. Both directions are fenced:
      // `tests/unit/deployment/intrinsic-sub-variables-not-mutated.test.ts`
      // holds the resolver to it, and deleting this `structuredClone` reds
      // `does NOT mutate the desired template (resolveBestEffort resolves a
      // clone)` in `tests/unit/analyzer/diff-calculator.test.ts`.)
      const resolvedValue = await resolveFn(structuredClone(value));
      // Resolved one key at a time, a top-level `AWS::NoValue` (bare, or the
      // branch a condition-false `Fn::If` selects) comes back as the bare
      // symbol: the resolver drops such a key only while resolving the
      // ENCLOSING object, which this loop never hands it. Omit it the same
      // way, or it compares unequal to the absent recorded key and diffs as a
      // perpetual UPDATE (go-to-k/cdkd#4471). Nested and list positions are
      // already dropped inside the resolver.
      // The replacement predicates read the omission too, and only an ABSENT
      // key reads as absent: `durableConfigPresenceToggled` tests `== null`,
      // which the symbol fails (a removed `DurableConfig` planned an
      // in-place UPDATE that keeps the live config; an absent one a spurious
      // replacement), and the createOnly nested-path walk reported the
      // symbol unresolved and always replaced.
      if (resolvedValue === AWS_NO_VALUE) continue;
      resolved[key] = resolvedValue;
    } catch {
      resolved[key] = value;
    }
  }
  return resolved;
}

/**
 * Compare CloudFormation template-level attributes (`DeletionPolicy`,
 * `UpdateReplacePolicy`) between cdkd state and the synth template.
 *
 * Schema v5+ records these in `ResourceState`; state written by an older
 * cdkd binary has the fields undefined. Treating `undefined === undefined`
 * as "no change" means the first post-upgrade deploy of an unchanged
 * template doesn't spuriously fire an attribute diff.
 */
export function compareAttributes(
  this: DiffCalculator,
  currentResource: ResourceState,
  desiredResource: TemplateResource
): AttributeChange[] {
  const changes: AttributeChange[] = [];
  if (currentResource.deletionPolicy !== desiredResource.DeletionPolicy) {
    changes.push({
      attribute: 'DeletionPolicy',
      oldValue: currentResource.deletionPolicy,
      newValue: desiredResource.DeletionPolicy,
    });
  }
  if (currentResource.updateReplacePolicy !== desiredResource.UpdateReplacePolicy) {
    changes.push({
      attribute: 'UpdateReplacePolicy',
      oldValue: currentResource.updateReplacePolicy,
      newValue: desiredResource.UpdateReplacePolicy,
    });
  }
  return changes;
}

/**
 * Compare properties and return list of changes
 *
 * Uses ReplacementRulesRegistry to determine which property changes require replacement.
 * Reference: https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/using-cfn-updating-stacks-update-behaviors.html
 */
export async function compareProperties(
  this: DiffCalculator,
  resourceType: string,
  currentProperties: Record<string, unknown>,
  desiredProperties: Record<string, unknown>,
  maskForLog?: MaskerFn
): Promise<PropertyChange[]> {
  const changes: PropertyChange[] = [];

  // Get all property keys
  const allKeys = new Set([...Object.keys(currentProperties), ...Object.keys(desiredProperties)]);

  // Properties to ignore in diff (non-deterministic, changes on every synth)
  const ignoredProperties = new Set<string>();
  if (
    resourceType === 'AWS::CloudFormation::CustomResource' ||
    resourceType.startsWith('Custom::')
  ) {
    ignoredProperties.add('Timestamp');
  }

  // CFn-schema `createOnlyProperties` fallback for replacement detection.
  // The hand-authored `ReplacementRulesRegistry` only covers ~25 types, so an
  // immutable-property change on any OTHER type was previously mis-classified
  // as an in-place UPDATE. We consult the type's CFn registry schema (via
  // DescribeType, cached + graceful-degradation) for any changed property the
  // registry does not explicitly classify, so a createOnly change drives a
  // replacement regardless of whether the type has a hand-written rule.
  // Resolved lazily — only when a changed, registry-unclassified property is
  // actually found — so a no-change / fully-classified diff makes no AWS call.
  // Paths (not top-level reductions): a NESTED createOnly entry only forces
  // replacement when the value AT that path changed — sibling sub-properties
  // stay in-place-updatable (issue #960, AWS::Pipes::Pipe SourceParameters).
  let createOnlyPaths: ReadonlyArray<readonly string[]> | undefined;

  for (const key of allKeys) {
    if (ignoredProperties.has(key)) continue;

    const oldValue = currentProperties[key];
    const newValue = desiredProperties[key];

    if (!this.valuesEqual(oldValue, newValue)) {
      // Check if this property change requires replacement
      let requiresReplacement = this.replacementRules.requiresReplacement(
        resourceType,
        key,
        oldValue,
        newValue,
        { oldProperties: currentProperties, newProperties: desiredProperties }
      );

      // Schema fallback: only where the registry has NO explicit opinion (so
      // a deliberate `updateableProperties` / conditional classification is
      // never overridden). A createOnly property change IS a replacement.
      if (!requiresReplacement && !this.replacementRules.isClassified(resourceType, key)) {
        if (createOnlyPaths === undefined) {
          createOnlyPaths = await getCreateOnlyPropertyPaths(resourceType);
        }
        if (
          createOnlyChangeRequiresReplacement(createOnlyPaths, key, oldValue, newValue, (a, b) =>
            this.valuesEqual(a, b)
          )
        ) {
          requiresReplacement = true;
          this.logger.debug(
            `Property ${key} of ${resourceType} changed a createOnly path per the CFn schema — requires replacement`
          );
        }
      }

      changes.push({
        path: key,
        oldValue,
        newValue,
        requiresReplacement,
      });

      if (requiresReplacement) {
        const mask = maskerOrIdentity(maskForLog);
        const [oldText, newText] = replacementSidesForLog(oldValue, newValue, mask);
        this.logger.debug(
          mask(
            // The key and type are masked BEFORE `safeMsg`, which strips
            // control characters and could split a needle out of reach.
            safeMsg`Property ${mask(key)} of ${mask(resourceType)} requires replacement (from ${oldText} to ${newText})`
          )
        );
      }
    }
  }

  return changes;
}

/**
 * Whether an edit only the masked-property fingerprint sees
 * (go-to-k/cdkd#4451) needs a replacement. The registry decides where it has
 * a rule; otherwise only a property that is itself create-only per the CFn
 * schema does. A NESTED create-only path under it is not taken: the two
 * `***` values cannot say which part of the property moved, and a
 * replacement guessed from that would destroy a resource an in-place update
 * serves.
 *
 * A CONDITIONAL registry rule cannot judge two masks either (go-to-k/cdkd#4739):
 * it answers for the values it sees, and both are `***`. There the schema
 * decides as for an unclassified key — a whole-key create-only property (an
 * IAM role's `Path`) is replaced, through the engine's create-first guard,
 * and any other keeps its in-place update.
 */
export async function maskedEditRequiresReplacement(
  this: DiffCalculator,
  resourceType: string,
  key: string,
  oldValue: unknown,
  newValue: unknown,
  siblings: ReplacementSiblings
): Promise<boolean> {
  if (this.replacementRules.requiresReplacement(resourceType, key, oldValue, newValue, siblings)) {
    return true;
  }
  if (
    this.replacementRules.isClassified(resourceType, key) &&
    this.replacementRules.conditionalReplacementVerdict(
      resourceType,
      key,
      oldValue,
      newValue,
      siblings
    ) === undefined
  ) {
    return false;
  }
  const createOnlyPaths = await getCreateOnlyPropertyPaths(resourceType);
  return createOnlyPaths.some((path) => path.length === 1 && path[0] === key);
}

/**
 * Check if a value is itself a CloudFormation intrinsic function.
 * e.g. { "Ref": "MyResource" } or { "Fn::GetAtt": ["Res", "Arn"] }
 * Does NOT match objects that merely contain intrinsics as nested children.
 */
export function isIntrinsic(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 1 && DiffCalculator.INTRINSIC_KEYS.has(keys[0]!);
}

/**
 * Deep equality check for values
 *
 * State stores resolved values (`"arn:aws:s3:::my-bucket"`); the synth
 * template holds unresolved intrinsics (`{ "Fn::GetAtt": ["MyBucket", "Arn"] }`).
 * Before reaching this comparator, `resolveBestEffort` already tried to
 * resolve the template side against current state, so a remaining raw
 * intrinsic typically means the resolver couldn't resolve it — most
 * commonly because the intrinsic references a resource NOT YET in state
 * (e.g., a newly-introduced resource the next deploy will CREATE).
 *
 * Two cases when an intrinsic still reaches here:
 *
 * 1. Both sides intrinsic: state was written by an older cdkd that didn't
 *    fully resolve at deploy time. Structural compare suffices —
 *    `Fn::GetAtt: [X, Arn]` matches `Fn::GetAtt: [X, Arn]` byte-for-byte.
 *
 * 2. One side intrinsic, other side concrete: the unresolvable intrinsic
 *    points at something different from what's currently in state. Treat
 *    as NOT equal so the resource is classified as UPDATE.
 *
 * Pre-fix this branch returned `true` (equal) for case 2, which silently
 * dropped real diffs — e.g., when an IAM Policy's `Resource: Fn::GetAtt:
 * [Bucket, Arn]` is rebound to a renamed bucket (logical ID changed
 * because the construct path moved), the resolver couldn't find the new
 * bucket in state and the policy stayed at the old bucket's ARN after
 * deploy. The next CR invocation against the new bucket then failed with
 * AccessDenied because the IAM Policy was never UPDATED.
 */
export function valuesEqual(this: DiffCalculator, a: unknown, b: unknown): boolean {
  // Strict equality check
  if (a === b) {
    return true;
  }

  // Null/undefined check
  if (a == null || b == null) {
    return a === b;
  }

  const aIntrinsic = DiffCalculator.isIntrinsic(a);
  const bIntrinsic = DiffCalculator.isIntrinsic(b);
  if (aIntrinsic !== bIntrinsic) {
    // One side intrinsic, other side concrete: changed.
    return false;
  }
  // Both intrinsics OR both concrete: fall through to the standard
  // array / object / primitive compare. For two intrinsics the
  // object-compare path below walks the single intrinsic key and
  // recursively compares its value (arrays positionally; nested
  // objects by key membership, key-order-insensitive — which matters
  // for `Fn::Sub`'s 2-arg form `[template, {VarA, VarB}]` where the
  // variable map's key order can differ between a synth-fresh object
  // literal and a `JSON.parse`'d state record).

  // Array check
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    return a.every((val, index) => this.valuesEqual(val, b[index]));
  }

  // Object check — recurse into each key so intrinsics are detected per-value
  if (typeof a === 'object' && typeof b === 'object') {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;

    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);

    // SYMMETRIC compare: a key present only in the OLD (state) side is a
    // genuine REMOVAL and must be detected — e.g. a Lambda env var dropped from
    // `Environment.Variables`, which AWS replaces wholesale (the dropped key
    // must reach AWS). The prior asymmetric compare (only walking the new-side
    // keys) silently swallowed nested-map-key removals: top-level property
    // removal + array-element removal were already caught (by the caller's
    // key-union + array-length check), but a key removed from a NESTED object
    // (Environment.Variables, Tags maps, etc.) compared equal and never
    // re-provisioned. cdkd stores the resolved TEMPLATE properties in
    // `state.properties` (AWS-observed defaults live in `observedProperties`),
    // so the old-side keys here are template-derived too — a length mismatch is
    // a real add or remove, not an AWS-added default.
    if (aKeys.length !== bKeys.length) {
      return false; // key added OR removed
    }
    for (const key of bKeys) {
      if (!Object.hasOwn(aObj, key)) {
        return false; // New key added in template
      }
      if (!this.valuesEqual(aObj[key], bObj[key])) {
        return false;
      }
    }
    return true;
  }

  // Primitive types
  return false;
}
