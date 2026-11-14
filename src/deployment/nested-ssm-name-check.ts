/**
 * go-to-k/cdkd#6282: the one-time check of a stack's nested children for a
 * pre-#6272 generated SSM parameter name (`/<name>`, see
 * `ssm-slashed-name-heal.ts`).
 *
 * A nested child heals its own records only when its engine runs, and its
 * engine runs only when the parent's `AWS::CloudFormation::Stack` row is
 * provisioned. Upgrading cdkd changes no child template, so an unchanged tree
 * kept the broken grant. Once per stack record, the deploy reads each nested
 * child's record (and, below a child that has not been checked itself, each
 * grandchild's), and a row whose subtree holds such a name is updated in this
 * deploy so its child's engine runs and re-spells it. The stack record then
 * carries `nestedSsmNamesChecked`, and later deploys read nothing extra.
 *
 * The mark is written only when every recorded child was read and is clean or
 * has its row updated by this deploy; a read that fails, a child template the
 * assembly does not hold, or a cycle leaves it unset, so the next deploy checks
 * again. A stack with no nested-stack row is never checked, never marked, and
 * pays nothing.
 */
import { childTemplateLoader } from './nested-output-templates.js';
import { healSlashedSsmParameterNames } from './ssm-slashed-name-heal.js';
import { safeMsg } from '../utils/display-safe.js';
import { SECRET_MASK } from './secret-redaction/pairs.js';
import type { ChildTemplateLoader } from './masked-property-fingerprints.js';
import type { CloudFormationTemplate } from '../types/resource.js';
import type { ResourceState, StackState } from '../types/state.js';

const NESTED_STACK_TYPE = 'AWS::CloudFormation::Stack';

/** Reads a stack's record; `null` / `undefined` when it has none. */
export type NestedRecordReader = (
  stackName: string,
  region: string
) => Promise<StackState | null | undefined>;

/** The outcome of {@link checkNestedSsmNames}. */
export interface NestedSsmNameCheck {
  /** Rows whose child (or a descendant of it) holds a name to re-spell. */
  forcedRows: Set<string>;
  /**
   * Rows that would be forced but whose record holds a value cdkd stores
   * masked: updating one would reach the redacted-read refusal (#2274) and
   * fail a deploy of a stack nobody changed, so it is left for the next
   * deploy that changes that nested stack (named, never forced, and the
   * stack is still marked: the check would only find it again).
   */
  deferredRows: Set<string>;
  /** Every recorded child was read and is clean or in `forcedRows`. */
  complete: boolean;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether `value` holds the stored mask anywhere (a bounded walk). */
function holdsMask(value: unknown, depth = 0): boolean {
  if (depth > 64) return true;
  if (typeof value === 'string') return value.includes(SECRET_MASK);
  if (Array.isArray(value)) return value.some((item) => holdsMask(item, depth + 1));
  if (isObject(value)) return Object.values(value).some((item) => holdsMask(item, depth + 1));
  return false;
}

/** The template's nested-stack rows that have a nested-stack record. */
function recordedNestedRows(
  template: CloudFormationTemplate,
  records: unknown
): { rows: string[]; any: boolean } {
  const rows: string[] = [];
  let any = false;
  const resources = isObject(template.Resources) ? template.Resources : {};
  for (const [logicalId, resource] of Object.entries(resources)) {
    if (!isObject(resource) || resource['Type'] !== NESTED_STACK_TYPE) continue;
    any = true;
    const record =
      isObject(records) && Object.hasOwn(records, logicalId) ? records[logicalId] : undefined;
    if (isObject(record) && record['resourceType'] === NESTED_STACK_TYPE) rows.push(logicalId);
  }
  return { rows, any };
}

/** Whether `template` declares any nested-stack row. */
export function hasNestedStackRows(template: CloudFormationTemplate): boolean {
  return recordedNestedRows(template, undefined).any;
}

async function checkLevel(
  stackName: string,
  region: string,
  template: CloudFormationTemplate,
  records: Record<string, ResourceState> | undefined,
  loader: ChildTemplateLoader,
  chain: ReadonlySet<string>,
  readRecord: NestedRecordReader
): Promise<NestedSsmNameCheck> {
  const forcedRows = new Set<string>();
  const deferredRows = new Set<string>();
  let complete = true;
  const force = (logicalId: string): void => {
    const properties = records?.[logicalId]?.properties;
    (holdsMask(properties) ? deferredRows : forcedRows).add(logicalId);
  };
  await Promise.all(
    recordedNestedRows(template, records).rows.map(async (logicalId) => {
      const child = loader(logicalId);
      // No template in the assembly: no deploy of this child can run either
      // (the provider refuses the row), so there is nothing to heal by.
      if (child === undefined) return;
      // A cyclic tree (the deploy refuses it on its own): not checked.
      if (chain.has(child.identity)) {
        complete = false;
        return;
      }
      const childStackName = `${stackName}~${logicalId}`;
      let state: StackState | null | undefined;
      let heals: number;
      try {
        state = await readRecord(childStackName, region);
        if (!isObject(state)) return;
        heals = healSlashedSsmParameterNames(state, child.template, childStackName).heals.length;
      } catch {
        complete = false;
        return;
      }
      if (heals > 0) {
        force(logicalId);
        return;
      }
      // A child that checked its own children is clean below.
      if (state.nestedSsmNamesChecked === true) return;
      const below = await checkLevel(
        childStackName,
        region,
        child.template,
        isObject(state.resources) ? state.resources : undefined,
        child.childTemplate,
        new Set(chain).add(child.identity),
        readRecord
      );
      if (below.forcedRows.size > 0) force(logicalId);
      // Only a deferred row below: this row is deferred too, so the name the
      // grandchild keeps is still named (the stack is marked either way).
      else if (below.deferredRows.size > 0) deferredRows.add(logicalId);
      if (!below.complete) complete = false;
    })
  );
  return { forcedRows, deferredRows, complete };
}

/**
 * The check for the stack whose record is `state`, or `undefined` when there
 * is nothing to do: the record already carries the mark, or the template has
 * no nested-stack row (no read at all either way). `nestedTemplates` is the
 * assembly's index one level below this stack; without it nothing is checked
 * and the result is incomplete.
 */
export async function checkNestedSsmNames(args: {
  state: StackState;
  template: CloudFormationTemplate;
  stackName: string;
  region: string;
  nestedTemplates: Readonly<Record<string, string>> | undefined;
  readRecord: NestedRecordReader;
}): Promise<NestedSsmNameCheck | undefined> {
  const { state, template, stackName, region, nestedTemplates, readRecord } = args;
  if (state.nestedSsmNamesChecked === true || !hasNestedStackRows(template)) return undefined;
  const loader = childTemplateLoader(nestedTemplates);
  if (loader === undefined)
    return { forcedRows: new Set(), deferredRows: new Set(), complete: false };
  return checkLevel(
    stackName,
    region,
    template,
    isObject(state.resources) ? state.resources : undefined,
    loader,
    new Set(),
    readRecord
  );
}

/**
 * Whether every row this deploy updated for the check left its child healed
 * and checked as a whole, read from the child's saved record: it holds no name
 * to re-spell, and either has no nested-stack row or carries the mark (its own
 * deploy checked the grandchildren). A row the deploy did not end up sending,
 * or a child whose own check could not finish (a grandchild record it could
 * not read), fails it, so the parent's record stays unmarked. One read per
 * updated row, once; a failed read answers `false`.
 */
export async function forcedChildrenChecked(args: {
  forcedRows: ReadonlySet<string>;
  stackName: string;
  region: string;
  nestedTemplates: Readonly<Record<string, string>> | undefined;
  readRecord: NestedRecordReader;
}): Promise<boolean> {
  const { forcedRows, stackName, region, nestedTemplates, readRecord } = args;
  if (forcedRows.size === 0) return true;
  const loader = childTemplateLoader(nestedTemplates);
  if (loader === undefined) return false;
  const verdicts = await Promise.all(
    [...forcedRows].map(async (logicalId) => {
      const child = loader(logicalId);
      if (child === undefined) return false;
      const childStackName = `${stackName}~${logicalId}`;
      try {
        const state = await readRecord(childStackName, region);
        if (!isObject(state)) return false;
        if (healSlashedSsmParameterNames(state, child.template, childStackName).heals.length > 0) {
          return false;
        }
        return !hasNestedStackRows(child.template) || state.nestedSsmNamesChecked === true;
      } catch {
        return false;
      }
    })
  );
  return verdicts.every(Boolean);
}

/** The line `cdkd deploy` and `cdkd diff` print for a row the check defers. */
export function nestedSsmNameDeferredNote(logicalId: string): string {
  return (
    safeMsg`Nested stack ${logicalId}: a nested stack record below it holds an SSM parameter ` +
    `name cdkd generated before go-to-k/cdkd#6272, but its Parameters read a value cdkd stores ` +
    `masked, so it is not updated for that; the name is re-spelled by the next deploy that ` +
    `changes this nested stack (go-to-k/cdkd#6282)`
  );
}

/** The line `cdkd deploy` and `cdkd diff` print for a row the check updates. */
export function nestedSsmNameRowNote(logicalId: string): string {
  return (
    safeMsg`Nested stack ${logicalId}: a nested stack record below it holds an SSM parameter ` +
    `name cdkd generated before go-to-k/cdkd#6272, so this deploy updates the nested stack to ` +
    `re-spell it (go-to-k/cdkd#6282)`
  );
}
