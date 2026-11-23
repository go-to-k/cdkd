/**
 * Stack-tag propagation (go-to-k/cdkd#6871): a stack's `StackProps.tags`
 * (the cloud assembly manifest's `tags`) reach every taggable resource of the
 * stack, as CloudFormation does with the stack tags the AWS CDK CLI passes it.
 *
 * Behaviour measured against CloudFormation (us-east-1, 2026-11-23):
 *
 * - Every taggable resource gets the stack tags merged into its tag property,
 *   list-shaped (`[{Key, Value}]`) and map-shaped (`{key: value}`) alike.
 * - On a key the resource declares itself, the RESOURCE's value wins.
 * - A stack-tag change with an unchanged template updates the resources in
 *   place: a removed stack key is untagged, the resource's own keys stay.
 * - A type whose registry schema says `taggable: false` gets none, and so did
 *   `AWS::EC2::PlacementGroup` (`tagUpdatable: false`), even at create. That
 *   is the one `tagUpdatable: false` type measured; this module skips every
 *   such type on the strength of it.
 * - Drift's expected side includes the propagated tags, so they belong in the
 *   desired (and so the recorded) properties.
 * - `AWS::DynamoDB::GlobalTable` has no top-level tag property (its schema has
 *   no `tagging` block); its tags live per replica. CloudFormation merged the
 *   stack tags into EVERY replica's `Tags` — a replica declaring no `Tags`
 *   included — each replica's own value winning on a shared key, and drift's
 *   expected `Replicas[].Tags` held the merged list (two-region probe,
 *   us-east-1 + us-west-2, 2026-11-24, go-to-k/cdkd#6891).
 *
 * This module is the PURE half: {@link applyStackTags} takes the per-type
 * answer as a function. `stack-tag-targets.ts` resolves it from
 * `cloudformation:DescribeType`.
 */

import { isIntrinsicShaped } from './create-only-properties.js';
import { hasNoRegistrySchema } from './describe-type.js';
import { defineOwnKey, hasOwnKey } from '../utils/own-keys.js';
import { displayIdent, safeMsg } from '../utils/display-safe.js';
import type { CloudFormationTemplate } from '../types/resource.js';

/** The nested-stack row type: its tags reach the child by threading, never by its own `Tags`. */
export const NESTED_STACK_ROW_TYPE = 'AWS::CloudFormation::Stack';

/**
 * `AWS::AutoScaling::AutoScalingGroup` tag entries carry a required
 * `PropagateAtLaunch`. CloudFormation sends `true` for a stack tag, and a tag
 * the group declares itself keeps its own value (measured us-east-1,
 * 2026-11-23, go-to-k/cdkd#6871).
 */
const PROPAGATE_AT_LAUNCH_TYPES: ReadonlySet<string> = new Set([
  'AWS::AutoScaling::AutoScalingGroup',
]);

/** What a resource type does with stack tags. */
export type StackTagTarget =
  /** Merge into the top-level `property`, in that property's shape. */
  | { readonly kind: 'apply'; readonly property: string; readonly shape: 'array' | 'object' }
  /**
   * Merge into each `Replicas[]` entry's list-shaped `Tags`
   * (`AWS::DynamoDB::GlobalTable`, go-to-k/cdkd#6891).
   */
  | { readonly kind: 'replicas' }
  /** CloudFormation applies none (not taggable, tags not updatable, no tag property). */
  | { readonly kind: 'skip' }
  /** cdkd cannot tell how; the resource is left alone and `reason` is warned once. */
  | { readonly kind: 'unknown'; readonly reason: string };

export interface ApplyStackTagsResult {
  /** A NEW template when anything was merged; the input itself otherwise. */
  readonly template: CloudFormationTemplate;
  /** Warnings, one per resource (or per type) stack tags were not applied to. */
  readonly warnings: string[];
}

/** True for a non-null, non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A non-empty stack-tag map, or `undefined` (the zero-cost case). */
export function nonEmptyStackTags(
  tags: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> | undefined {
  return tags !== undefined && Object.keys(tags).length > 0 ? tags : undefined;
}

/**
 * The template resource types {@link applyStackTags} asks about: every type
 * but nested-stack rows and the schema-less ones.
 */
export function stackTagCandidateTypes(template: CloudFormationTemplate): string[] {
  const types = new Set<string>();
  const resources = isRecord(template.Resources) ? template.Resources : {};
  for (const resource of Object.values(resources)) {
    if (!isRecord(resource)) continue;
    const type = resource['Type'];
    if (typeof type !== 'string') continue;
    if (type === NESTED_STACK_ROW_TYPE || hasNoRegistrySchema(type)) continue;
    types.add(type);
  }
  return [...types];
}

/**
 * The keys a list-shaped tag property declares. `undefined` when any entry's
 * key is unknowable (a non-literal `Key`, a non-object entry, an intrinsic
 * entry other than an `Fn::If` between literal entries / `AWS::NoValue`).
 * An `Fn::If` entry contributes its branches' keys to `conditional`: a stack
 * key among them may or may not be declared, so it is unknowable too.
 */
function declaredListKeys(
  entries: readonly unknown[]
): { definite: Set<string>; conditional: Set<string> } | undefined {
  const definite = new Set<string>();
  const conditional = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) return undefined;
    if (isIntrinsicShaped(entry)) {
      const branches = entry['Fn::If'];
      if (!Array.isArray(branches) || branches.length !== 3) return undefined;
      for (const branch of branches.slice(1)) {
        if (isRecord(branch) && branch['Ref'] === 'AWS::NoValue') continue;
        if (!isRecord(branch) || isIntrinsicShaped(branch)) return undefined;
        const key = branch['Key'];
        if (typeof key !== 'string') return undefined;
        conditional.add(key);
      }
      continue;
    }
    const key = entry['Key'];
    if (typeof key !== 'string') return undefined;
    definite.add(key);
  }
  return { definite, conditional };
}

/**
 * The merged list: the declared entries untouched, then each stack key the
 * resource does not declare. `undefined` when a stack key's presence is
 * unknowable.
 */
function mergeList(
  current: readonly unknown[],
  stackTags: Readonly<Record<string, string>>,
  resourceType: string
): unknown[] | undefined {
  const declared = declaredListKeys(current);
  if (declared === undefined) return undefined;
  const added: unknown[] = [];
  for (const [key, value] of Object.entries(stackTags)) {
    if (declared.definite.has(key)) continue;
    if (declared.conditional.has(key)) return undefined;
    added.push(
      PROPAGATE_AT_LAUNCH_TYPES.has(resourceType)
        ? { Key: key, Value: value, PropagateAtLaunch: true }
        : { Key: key, Value: value }
    );
  }
  return added.length === 0 ? [...current] : [...current, ...added];
}

/** The merged map: the declared keys win, every other stack key is added. */
function mergeMap(
  current: Record<string, unknown>,
  stackTags: Readonly<Record<string, string>>
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(current)) defineOwnKey(merged, key, value);
  for (const [key, value] of Object.entries(stackTags)) {
    if (!hasOwnKey(merged, key)) defineOwnKey(merged, key, value);
  }
  return merged;
}

/**
 * The merged `Replicas` list: each replica's `Tags` merged like a list-shaped
 * tag property, a replica without `Tags` getting the stack tags alone.
 * `undefined` when the list, a replica, or a replica's `Tags` is not literal
 * enough to tell which keys it declares — then no replica is touched.
 */
function mergeReplicas(
  replicas: unknown,
  stackTags: Readonly<Record<string, string>>,
  resourceType: string
): unknown[] | undefined {
  if (!Array.isArray(replicas)) return undefined;
  const merged: unknown[] = [];
  for (const replica of replicas) {
    if (!isRecord(replica) || isIntrinsicShaped(replica)) return undefined;
    const current = hasOwnKey(replica, 'Tags') ? replica['Tags'] : undefined;
    if (current !== undefined && !Array.isArray(current)) return undefined;
    const tags = mergeList(current ?? [], stackTags, resourceType);
    if (tags === undefined) return undefined;
    const next: Record<string, unknown> = { ...replica };
    defineOwnKey(next, 'Tags', tags);
    merged.push(next);
  }
  return merged;
}

function notApplied(logicalId: string, resourceType: string, why: string): string {
  return safeMsg`Stack tags were not applied to ${displayIdent(logicalId)} (${resourceType}): ${why}. CloudFormation would tag it; cdkd leaves its tags as the template declares them.`;
}

/**
 * Merge `stackTags` into each taggable resource's tag property, returning a
 * NEW template (the input, and any cached copy of it, is never mutated). With
 * no stack tags it returns the input itself and asks `targetOf` nothing.
 *
 * Skipped: nested-stack rows (their tags reach the child by threading),
 * custom resources and other schema-less types, and every type `targetOf`
 * answers `skip`. A resource whose tag property is an intrinsic, or holds an
 * entry whose key cdkd cannot read, is left untouched with one warning: cdkd
 * never guesses which keys it declares.
 */
export function applyStackTags(
  template: CloudFormationTemplate,
  stackTags: Readonly<Record<string, string>> | undefined,
  targetOf: (resourceType: string) => StackTagTarget
): ApplyStackTagsResult {
  const tags = nonEmptyStackTags(stackTags);
  const warnings: string[] = [];
  if (tags === undefined || !isRecord(template.Resources)) return { template, warnings };
  let resources: Record<string, unknown> | undefined;
  const warnedTypes = new Set<string>();
  for (const [logicalId, resource] of Object.entries(template.Resources)) {
    if (!isRecord(resource)) continue;
    const type = resource['Type'];
    if (typeof type !== 'string') continue;
    if (type === NESTED_STACK_ROW_TYPE || hasNoRegistrySchema(type)) continue;
    const target = targetOf(type);
    if (target.kind === 'skip') continue;
    if (target.kind === 'unknown') {
      if (!warnedTypes.has(type)) {
        warnedTypes.add(type);
        warnings.push(
          safeMsg`Stack tags were not applied to resources of type ${type}: ${target.reason}.`
        );
      }
      continue;
    }
    const properties = resource['Properties'];
    if (properties !== undefined && (!isRecord(properties) || isIntrinsicShaped(properties))) {
      warnings.push(notApplied(logicalId, type, 'its Properties are not a literal map'));
      continue;
    }
    let property: string;
    let merged: unknown;
    let why: string;
    if (target.kind === 'replicas') {
      property = 'Replicas';
      merged = mergeReplicas(isRecord(properties) ? properties[property] : undefined, tags, type);
      why =
        'its Replicas is not a literal list, or a replica or its Tags is an intrinsic or holds a tag whose key cdkd cannot read';
    } else {
      property = target.property;
      const current = isRecord(properties) ? properties[property] : undefined;
      if (current === undefined) {
        merged =
          target.shape === 'array'
            ? mergeList([], tags, type)
            : mergeMap({} as Record<string, unknown>, tags);
      } else if (target.shape === 'array' && Array.isArray(current)) {
        merged = mergeList(current, tags, type);
      } else if (target.shape === 'object' && isRecord(current) && !isIntrinsicShaped(current)) {
        merged = mergeMap(current, tags);
      }
      why = `its ${property} is an intrinsic or holds a tag whose key cdkd cannot read`;
    }
    if (merged === undefined) {
      warnings.push(notApplied(logicalId, type, why));
      continue;
    }
    resources ??= { ...template.Resources };
    const nextProperties: Record<string, unknown> = { ...(properties ?? {}) };
    defineOwnKey(nextProperties, property, merged);
    defineOwnKey(resources, logicalId, { ...resource, Properties: nextProperties });
  }
  return {
    template:
      resources === undefined
        ? template
        : { ...template, Resources: resources as CloudFormationTemplate['Resources'] },
    warnings,
  };
}

/**
 * The literal tags of a nested-stack row's `Tags` (`[{Key, Value}]`), or
 * `undefined` when any entry is not a literal string pair (an intrinsic).
 * Absent / `null` is no tags.
 */
export function literalRowTags(value: unknown): Record<string, string> | undefined {
  if (value === undefined || value === null) return {};
  if (!Array.isArray(value)) return undefined;
  const tags: Record<string, string> = {};
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const key = entry['Key'];
    const tagValue = entry['Value'];
    if (typeof key !== 'string' || typeof tagValue !== 'string') return undefined;
    defineOwnKey(tags, key, tagValue);
  }
  return tags;
}

/**
 * A nested child's effective stack tags: the parent's, with the row's own
 * `Tags` winning on a shared key (CloudFormation's nested-stack tagging).
 */
export function childStackTags(
  parentTags: Readonly<Record<string, string>> | undefined,
  rowTags: Readonly<Record<string, string>> | undefined
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(parentTags ?? {})) defineOwnKey(merged, key, value);
  for (const [key, value] of Object.entries(rowTags ?? {})) defineOwnKey(merged, key, value);
  return merged;
}

/** Two tag maps hold the same pairs. */
export function sameTags(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined
): boolean {
  const left = Object.entries(a ?? {});
  const right = b ?? {};
  if (left.length !== Object.keys(right).length) return false;
  return left.every(([key, value]) => hasOwnKey(right, key) && right[key] === value);
}
