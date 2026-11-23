/**
 * Which nested-stack rows must run their child's engine because the child's
 * effective stack tags changed (go-to-k/cdkd#6871).
 *
 * A nested child's resources carry the child's effective stack tags: the
 * parent's stack tags with the row's own `Tags` winning. CloudFormation
 * updates a nested stack when either changes, even with the child template
 * unchanged. In cdkd the row updates (and so runs the child engine) only when
 * its own properties diff, and `Tags` is not one of them, so the parent
 * records what each row's child was deployed with
 * (`StackState.nestedStackTags`) and a row whose tags differ is forced to
 * UPDATE. A record without the field reads every row as `{}`: a tagged row
 * runs once to catch up, an untagged one costs nothing.
 *
 * Shared by `cdkd deploy` and `cdkd diff`, so the preview shows the same
 * row UPDATE.
 */

import {
  childStackTags,
  literalRowTags,
  NESTED_STACK_ROW_TYPE,
  sameTags,
} from '../provisioning/stack-tags.js';
import { hasOwnKey } from '../utils/own-keys.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { ResourceChange } from '../types/state/changes.js';
import type { ResourceState, StackState } from '../types/state.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Per nested-stack row of `template`, its child's effective stack tags, or
 * `undefined` when the row's `Tags` are not literal (an intrinsic): those are
 * known only once resolved, so such a row runs its child on every deploy.
 */
export function expectedNestedStackTags(
  template: CloudFormationTemplate,
  stackTags: Readonly<Record<string, string>> | undefined
): Map<string, Record<string, string> | undefined> {
  const expected = new Map<string, Record<string, string> | undefined>();
  const resources = isRecord(template.Resources) ? template.Resources : {};
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (!isRecord(resource) || resource['Type'] !== NESTED_STACK_ROW_TYPE) continue;
    const properties = resource['Properties'];
    const rowTags = literalRowTags(isRecord(properties) ? properties['Tags'] : undefined);
    expected.set(logicalId, rowTags === undefined ? undefined : childStackTags(stackTags, rowTags));
  }
  return expected;
}

/**
 * The record's `nestedStackTags`, or `undefined` when it is malformed (no
 * verdict: every recorded row then runs once and the save rewrites it).
 * Absent is `{}`.
 */
export function recordedNestedStackTagsOf(
  state: Pick<StackState, 'nestedStackTags'> | undefined
): Record<string, Record<string, string>> | undefined {
  const field: unknown = state?.nestedStackTags;
  if (field === undefined) return {};
  if (!isRecord(field)) return undefined;
  for (const tags of Object.values(field)) {
    if (!isRecord(tags) || Object.values(tags).some((v) => typeof v !== 'string')) {
      return undefined;
    }
  }
  return field as Record<string, Record<string, string>>;
}

/**
 * The rows whose child must run for its tags: a row already recorded as a
 * nested stack (a new row is a CREATE, which runs the child anyway) whose
 * expected tags are unknowable or differ from the recorded ones.
 */
export function nestedRowsNeedingTagRun(
  expected: ReadonlyMap<string, Record<string, string> | undefined>,
  state: Pick<StackState, 'nestedStackTags'> & { resources?: Record<string, ResourceState> }
): Set<string> {
  const rows = new Set<string>();
  if (expected.size === 0) return rows;
  const recorded = recordedNestedStackTagsOf(state);
  const resources = isRecord(state.resources) ? state.resources : {};
  for (const [logicalId, tags] of expected) {
    const record = hasOwnKey(resources, logicalId) ? resources[logicalId] : undefined;
    if (!isRecord(record) || record['resourceType'] !== NESTED_STACK_ROW_TYPE) continue;
    if (tags === undefined || recorded === undefined) {
      rows.add(logicalId);
      continue;
    }
    const previous = hasOwnKey(recorded, logicalId) ? recorded[logicalId] : undefined;
    if (!sameTags(previous ?? {}, tags)) rows.add(logicalId);
  }
  return rows;
}

/**
 * The `nestedStackTags` field a successful deploy writes: every row with
 * known, non-empty tags; `undefined` (no field) when there are none.
 */
export function nestedStackTagsField(
  expected: ReadonlyMap<string, Record<string, string> | undefined>
): Record<string, Record<string, string>> | undefined {
  const field: Record<string, Record<string, string>> = {};
  for (const [logicalId, tags] of expected) {
    if (tags !== undefined && Object.keys(tags).length > 0) {
      Object.defineProperty(field, logicalId, {
        value: tags,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  }
  return Object.keys(field).length > 0 ? field : undefined;
}

/**
 * Turn each of `rows` the diff left `NO_CHANGE` into an UPDATE with no
 * property change, and mark every one of them (an UPDATE included)
 * `nestedStackTagsChanged`, so the engine calls the provider and the child's
 * engine runs.
 */
export function markStackTagChildRuns(
  changes: Map<string, ResourceChange>,
  rows: ReadonlySet<string>
): void {
  for (const logicalId of rows) {
    const change = changes.get(logicalId);
    if (change?.resourceType !== NESTED_STACK_ROW_TYPE) continue;
    if (change.changeType === 'NO_CHANGE') {
      change.changeType = 'UPDATE';
      change.propertyChanges = [];
    }
    if (change.changeType === 'UPDATE') change.nestedStackTagsChanged = true;
  }
}

/**
 * The diff-time step both `cdkd deploy` and `cdkd diff` run once the
 * calculator is done: each row's expected child tags (a row whose `Tags` are
 * not literal resolved with the DIFF's resolver, which leaves a secret
 * reference as its expression, the spelling the provider hands the child),
 * the rows they force marked, and the expected map returned for the record
 * (deploy) and the child walk (diff). A row whose tags still cannot be read
 * stays unknowable: it runs every deploy and is not recorded.
 */
export async function settleStackTagChildRuns(args: {
  changes: Map<string, ResourceChange>;
  template: CloudFormationTemplate;
  stackTags: Readonly<Record<string, string>> | undefined;
  state: Pick<StackState, 'nestedStackTags'> & { resources?: Record<string, ResourceState> };
  resolve: ((value: unknown) => Promise<unknown>) | undefined;
}): Promise<Map<string, Record<string, string> | undefined>> {
  const expected = expectedNestedStackTags(args.template, args.stackTags);
  const resources = isRecord(args.template.Resources) ? args.template.Resources : {};
  for (const [logicalId, tags] of expected) {
    if (tags !== undefined || args.resolve === undefined) continue;
    const resource = resources[logicalId];
    const properties = isRecord(resource) ? resource['Properties'] : undefined;
    try {
      const resolved = await args.resolve(isRecord(properties) ? properties['Tags'] : undefined);
      const rowTags = literalRowTags(resolved);
      if (rowTags !== undefined) expected.set(logicalId, childStackTags(args.stackTags, rowTags));
    } catch {
      // Unresolvable at diff time: the row stays unknowable and runs.
    }
  }
  markStackTagChildRuns(args.changes, nestedRowsNeedingTagRun(expected, args.state));
  return expected;
}
