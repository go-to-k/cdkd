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
 *   relabelled, as its replacement's record moved; it and every rollback-orphan
 *   record have their references rewritten as the live records do.
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
    ...(Array.isArray(state.supersededResources) && {
      supersededResources: state.supersededResources.map((entry) => {
        if (entry === null || typeof entry !== 'object') return entry;
        const to = byFrom.get(entry.logicalId);
        return {
          ...entry,
          ...(to !== undefined && { logicalId: to }),
          state: rewriteRecordReferences(entry.state, byFrom),
        };
      }),
    }),
    // A rollback-orphan record keeps its own logical id (the refactor refuses
    // to rename one), but a dependency it names may be a renamed id.
    ...(Array.isArray(state.orphans) && {
      orphans: state.orphans.map((entry) =>
        entry === null || typeof entry !== 'object'
          ? entry
          : { ...entry, state: rewriteRecordReferences(entry.state, byFrom) }
      ),
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

/** One record moving between two stacks (go-to-k/cdkd#5202). */
export interface LogicalIdMove {
  /** Its logical id in the source stack. */
  from: string;
  /** Its logical id in the destination stack. */
  to: string;
}

/**
 * The SOURCE stack's record once `moves` leave it: each moved record is
 * dropped (its AWS resource is now the destination's), every remaining
 * record's `dependencies` entry naming one is dropped (the reference is now
 * cross-stack), and each moved id's name generation is retired as for any
 * record that leaves a stack. `skippedOutputs` is dropped by the flat rule.
 * Throws on a `from` not in `resources`.
 */
export function removeMovedRecords(state: StackState, moves: readonly LogicalIdMove[]): StackState {
  const leavingIds = new Set<string>();
  for (const { from } of moves) {
    if (!hasOwnKey(state.resources, from)) {
      throw new Error(`Logical ID ${from} is not in the source stack's state`);
    }
    leavingIds.add(from);
  }
  const resources: Record<string, ResourceState> = {};
  const leaving: Array<{ logicalId: string; record: ResourceState }> = [];
  for (const [logicalId, record] of Object.entries(state.resources)) {
    if (leavingIds.has(logicalId)) {
      leaving.push({ logicalId, record });
      continue;
    }
    defineOwnKey(resources, logicalId, withoutDependencies(record, leavingIds));
  }
  const { skippedOutputs: _dropped, ...rest } = state;
  void _dropped;
  return {
    ...rest,
    ...stackInstanceIdCarriedFrom(state),
    resources,
    ...retiredNameGenerationsAfter(state, leaving),
    ...(Array.isArray(state.orphans) && {
      orphans: state.orphans.map((entry) =>
        entry === null || typeof entry !== 'object'
          ? entry
          : { ...entry, state: withoutDependencies(entry.state, leavingIds) }
      ),
    }),
    lastModified: Date.now(),
  };
}

/**
 * The DESTINATION stack's record once `moved` arrive: each record is added
 * under its new logical id verbatim (physical id, attributes, observed
 * baseline and secret bookkeeping), with the template's construct path, its
 * references to the other moved records renamed, its dependencies on records
 * that stayed in the source dropped, and its name-generation high-water mark
 * raised past any generation the destination retired for that id. Throws on
 * a `to` already in `resources`.
 */
export function insertMovedRecords(
  state: StackState,
  moved: ReadonlyArray<LogicalIdMove & { record: ResourceState; source?: string }>,
  template: CloudFormationTemplate
): StackState {
  // References resolve within the record's OWN source stack: two sources can
  // move records sharing a logical id (one construct path, two stacks).
  const renamesBySource = new Map<string | undefined, Map<string, string>>();
  for (const m of moved) {
    const group = renamesBySource.get(m.source) ?? new Map<string, string>();
    group.set(m.from, m.to);
    renamesBySource.set(m.source, group);
  }
  const resources: Record<string, ResourceState> = {};
  for (const [logicalId, record] of Object.entries(state.resources)) {
    defineOwnKey(resources, logicalId, record);
  }
  const retired = state.retiredNameGenerations ?? {};
  for (const { to, record, source } of moved) {
    if (hasOwnKey(state.resources, to) || hasOwnKey(resources, to)) {
      throw new Error(`Logical ID ${to} is already in the destination stack's state`);
    }
    const group = renamesBySource.get(source)!;
    const coMoved = new Set(group.values());
    const renamed = rewriteRecordReferences(record, group);
    const kept =
      renamed !== null && typeof renamed === 'object' && Array.isArray(renamed.dependencies)
        ? {
            ...renamed,
            dependencies: renamed.dependencies.filter(
              (dep) => typeof dep !== 'string' || coMoved.has(dep)
            ),
          }
        : renamed;
    const constructPath = constructPathOf(template, to);
    defineOwnKey(
      resources,
      to,
      withNameGenerationReached(
        { ...kept, ...(constructPath !== undefined && { constructPath }) },
        to,
        hasOwnKey(retired, to) ? retired[to] : undefined
      )
    );
  }
  const { skippedOutputs: _dropped, ...rest } = state;
  void _dropped;
  return {
    ...rest,
    ...stackInstanceIdCarriedFrom(state),
    resources,
    lastModified: Date.now(),
  };
}

/** `record` with each `dependencies` entry in `drop` removed; anything unreadable verbatim. */
function withoutDependencies(record: ResourceState, drop: ReadonlySet<string>): ResourceState {
  if (record === null || typeof record !== 'object' || !Array.isArray(record.dependencies)) {
    return record;
  }
  return {
    ...record,
    dependencies: record.dependencies.filter((dep) => typeof dep !== 'string' || !drop.has(dep)),
  };
}
