import type { CloudFormationTemplate } from '../types/resource.js';
import { stackInstanceIdCarriedFrom, type ResourceState, type StackState } from '../types/state.js';
import { defineOwnKey, hasOwnKey, hasPlainPrototype } from '../utils/own-keys.js';
import { retiredNameGenerationsAfter, withNameGenerationReached } from './name-generation.js';

/**
 * One logical-id rename `cdkd refactor` applies to a stack's record
 * (go-to-k/cdkd#5201): the record held under `from` moves to `to` unchanged,
 * so the AWS resource it names is kept rather than replaced.
 */
export interface LogicalIdRename {
  from: string;
  to: string;
}

/**
 * The record `state` becomes once every rename in `renames` is applied. Pure:
 * nothing is read from or written to AWS, because under cdkd a resource's
 * identity IS its state record.
 *
 * - The moved record keeps every field verbatim (physical id, attributes,
 *   observed baseline, secret bookkeeping), takes the template's
 *   `aws:cdk:path` for its new id, and raises its name-generation high-water
 *   mark past any generation the NEW id retired earlier, so a later
 *   replacement never asks AWS for a name an earlier copy of that id held.
 * - The OLD id's generation is retired, so re-adding the old logical id later
 *   asks for the next generation's name instead of the one the renamed
 *   resource still holds (a stack with a `stackInstanceId`; a legacy stack
 *   has no generations to retire).
 * - Every other record's `dependencies`, and any `Ref` / `Fn::GetAtt` /
 *   `Fn::Sub` naming an old id that its `properties` or `attributes` still
 *   hold unresolved, are rewritten to the new id.
 * - A superseded record (`supersededResources`) labelled with an old id is
 *   relabelled, as its replacement's record moved.
 * - `skippedOutputs` is DROPPED, as by every writer that rebuilds state
 *   outside a deploy (the flat rule on that field's doc).
 *
 * Throws on a rename the caller should have refused: an `from` not in
 * `resources`, a `to` already there, or an id named twice.
 */
export function applyLogicalIdRenames(
  state: StackState,
  renames: readonly LogicalIdRename[],
  template: CloudFormationTemplate
): StackState {
  const byFrom = new Map<string, string>();
  const targets = new Set<string>();
  for (const { from, to } of renames) {
    if (!hasOwnKey(state.resources, from)) {
      throw new Error(`Logical ID ${from} is not in the stack's state`);
    }
    if (hasOwnKey(state.resources, to)) {
      throw new Error(`Logical ID ${to} is already in the stack's state`);
    }
    if (byFrom.has(from) || targets.has(to) || from === to) {
      throw new Error(`Logical ID ${from} -> ${to} is named more than once`);
    }
    byFrom.set(from, to);
    targets.add(to);
  }

  const retiredBefore = state.retiredNameGenerations ?? {};
  const resources: Record<string, ResourceState> = {};
  const leaving: Array<{ logicalId: string; record: ResourceState }> = [];
  for (const [logicalId, record] of Object.entries(state.resources)) {
    const to = byFrom.get(logicalId);
    if (to === undefined) {
      defineOwnKey(resources, logicalId, rewriteRecordReferences(record, byFrom));
      continue;
    }
    leaving.push({ logicalId, record });
    const constructPath = constructPathOf(template, to);
    const retiredTo = hasOwnKey(retiredBefore, to) ? retiredBefore[to] : undefined;
    const moved = withNameGenerationReached(
      {
        ...rewriteRecordReferences(record, byFrom),
        ...(constructPath !== undefined && { constructPath }),
      },
      to,
      retiredTo
    );
    defineOwnKey(resources, to, moved);
  }

  const { skippedOutputs: _dropped, ...rest } = state;
  void _dropped;
  const retired = retiredNameGenerationsAfter(state, leaving);
  return {
    ...rest,
    ...stackInstanceIdCarriedFrom(state),
    resources,
    ...retired,
    ...(state.supersededResources !== undefined && {
      supersededResources: state.supersededResources.map((entry) => {
        const to = byFrom.get(entry.logicalId);
        return to === undefined ? entry : { ...entry, logicalId: to };
      }),
    }),
    lastModified: Date.now(),
  };
}

/** The template resource's `aws:cdk:path`, when it declares one. */
function constructPathOf(template: CloudFormationTemplate, logicalId: string): string | undefined {
  const resources = template.Resources ?? {};
  if (!hasOwnKey(resources, logicalId)) return undefined;
  const metadata = (resources[logicalId] as { Metadata?: unknown }).Metadata;
  if (metadata === null || typeof metadata !== 'object') return undefined;
  const path = (metadata as Record<string, unknown>)['aws:cdk:path'];
  return typeof path === 'string' ? path : undefined;
}

/**
 * `record` with every reference to a renamed id rewritten. A value this walk
 * cannot read (a non-object entry, a non-array `dependencies`) is returned
 * verbatim: a refactor renames, it never repairs or reshapes a record.
 */
function rewriteRecordReferences(
  record: ResourceState,
  renames: ReadonlyMap<string, string>
): ResourceState {
  if (record === null || typeof record !== 'object' || !hasPlainPrototype(record)) return record;
  const out: ResourceState = { ...record };
  if (Array.isArray(record.dependencies)) {
    const seen = new Set<string>();
    out.dependencies = [];
    for (const dependency of record.dependencies) {
      const renamed =
        typeof dependency === 'string' ? (renames.get(dependency) ?? dependency) : dependency;
      if (typeof renamed === 'string') {
        if (seen.has(renamed)) continue;
        seen.add(renamed);
      }
      out.dependencies.push(renamed);
    }
  }
  if (record.properties !== undefined) {
    out.properties = renameReferencesInValue(record.properties, renames) as Record<string, unknown>;
  }
  if (record.attributes !== undefined) {
    out.attributes = renameReferencesInValue(record.attributes, renames) as Record<string, unknown>;
  }
  return out;
}

/**
 * `value` with each `Ref` / `Fn::GetAtt` / `Fn::Sub` reference to a renamed
 * logical id pointed at its new id. A `Fn::Sub` placeholder that its own
 * variable map defines is a variable, not a resource, and is left alone.
 * Exported for its unit tests.
 */
export function renameReferencesInValue(
  value: unknown,
  renames: ReadonlyMap<string, string>
): unknown {
  if (Array.isArray(value)) return value.map((item) => renameReferencesInValue(item, renames));
  if (value === null || typeof value !== 'object' || !hasPlainPrototype(value)) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 1) {
    const [key, arg] = entries[0]!;
    if (key === 'Ref' && typeof arg === 'string') {
      return { Ref: renames.get(arg) ?? arg };
    }
    if (key === 'Fn::GetAtt') return { 'Fn::GetAtt': renameGetAttArgument(arg, renames) };
    if (key === 'Fn::Sub') return { 'Fn::Sub': renameSubArgument(arg, renames) };
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    defineOwnKey(out, key, renameReferencesInValue(item, renames));
  }
  return out;
}

function renameGetAttArgument(arg: unknown, renames: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(arg) && arg.length >= 1 && typeof arg[0] === 'string') {
    const [target, ...rest] = arg as [string, ...unknown[]];
    return [
      renames.get(target) ?? target,
      ...rest.map((item) => renameReferencesInValue(item, renames)),
    ];
  }
  if (typeof arg === 'string') {
    const dot = arg.indexOf('.');
    if (dot > 0) {
      const target = arg.slice(0, dot);
      const renamed = renames.get(target);
      if (renamed !== undefined) return `${renamed}${arg.slice(dot)}`;
    }
    return arg;
  }
  return renameReferencesInValue(arg, renames);
}

function renameSubArgument(arg: unknown, renames: ReadonlyMap<string, string>): unknown {
  if (typeof arg === 'string') return renameSubTemplate(arg, renames, new Set());
  if (Array.isArray(arg) && arg.length >= 1 && typeof arg[0] === 'string') {
    const variables = arg[1];
    const shadowed = new Set(
      variables !== null && typeof variables === 'object' && !Array.isArray(variables)
        ? Object.keys(variables)
        : []
    );
    return [
      renameSubTemplate(arg[0], renames, shadowed),
      ...arg.slice(1).map((item) => renameReferencesInValue(item, renames)),
    ];
  }
  return renameReferencesInValue(arg, renames);
}

/**
 * A `Fn::Sub` template string with each `${Id}` / `${Id.Attr}` placeholder of
 * a renamed id rewritten. `${!Literal}` is CloudFormation's escape for a
 * literal `${`, so it is skipped.
 */
function renameSubTemplate(
  template: string,
  renames: ReadonlyMap<string, string>,
  shadowed: ReadonlySet<string>
): string {
  return template.replace(/\$\{([^}]*)\}/g, (whole, inner: string) => {
    if (inner.startsWith('!')) return whole;
    const dot = inner.indexOf('.');
    const target = dot === -1 ? inner : inner.slice(0, dot);
    if (shadowed.has(target) || shadowed.has(inner)) return whole;
    const renamed = renames.get(target);
    if (renamed === undefined) return whole;
    return `\${${renamed}${dot === -1 ? '' : inner.slice(dot)}}`;
  });
}
