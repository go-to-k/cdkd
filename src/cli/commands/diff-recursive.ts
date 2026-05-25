import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceChange, StackState } from '../../types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../types/state.js';
import { DiffCalculator } from '../../analyzer/diff-calculator.js';
import { IntrinsicFunctionResolver } from '../../deployment/intrinsic-function-resolver.js';
import type { S3StateBackend } from '../../state/s3-state-backend.js';
import { NESTED_STACK_RESOURCE_TYPE } from './retire-cfn-stack.js';

/**
 * One node in the recursive `cdkd diff --recursive` tree (issue
 * [#555](https://github.com/go-to-k/cdkd/issues/555) A5).
 *
 * The root is the user-named top-level stack; every nested
 * `AWS::CloudFormation::Stack` row becomes a child node whose own diff is
 * computed against its deployed cdkd state file at
 * `cdkd/<parent>~<childLogicalId>/<region>/state.json`. Grandchildren
 * recurse the same way. Children are ordered DFS (template order first,
 * then state-only DELETE branches) so deep trees stay scannable top-down.
 */
export interface DiffTreeNode {
  /**
   * cdkd state stack name. For the root this is the physical CloudFormation
   * stack name; for a nested child it is the v6 state-key form
   * `<parent>~<childLogicalId>` (matching what `NestedStackProvider.create`
   * and the recursive `cdkd import` walk write).
   */
  stackName: string;
  /**
   * Header label rendered as `Nested stack: <displayName>`. Mirrors the A4
   * `state show --show-nested` convention of showing the full `~`-joined
   * state name so the parentage is unambiguous. Equal to `stackName`.
   */
  displayName: string;
  /** Region of this node's state record (children inherit the parent's region). */
  region: string;
  /** Per-resource changes for this node (includes `NO_CHANGE` entries — filter with {@link nodeHasChanges}). */
  changes: Map<string, ResourceChange>;
  /** Direct nested-stack children, DFS order. Empty for leaves and for non-recursive runs. */
  children: DiffTreeNode[];
}

/** Empty template used to diff a removed nested child's state → all DELETE. */
const EMPTY_TEMPLATE: CloudFormationTemplate = { Resources: {} };

/**
 * True when an absolute path is given. CDK emits relative asset paths for
 * nested templates (siblings of the parent template in `cdk.out`); an
 * absolute path means the synth output was hand-modified or produced by a
 * non-CDK toolchain. Kept local so the CLI layer does not import from the
 * provisioning layer.
 *
 * A hardened variant of the guard in
 * `src/provisioning/providers/nested-stack-provider.ts` — in addition to
 * `path.isAbsolute`, it also rejects Windows drive-letter (`C:\` / `C:/`)
 * and UNC (`\\server`) paths that `path.isAbsolute` misses when running on
 * a POSIX host. A future refactor could unify the two on this stricter form.
 */
function isAbsoluteCrossPlatform(p: string): boolean {
  return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
}

/**
 * Read + parse a nested child's synthesized CloudFormation template from
 * disk (the path comes from the parent row's `Metadata['aws:asset:path']`,
 * indexed at synth time into `StackInfo.nestedTemplates` for the top level
 * and via {@link indexNestedChildTemplates} for deeper levels).
 */
export function readNestedTemplate(templatePath: string): CloudFormationTemplate {
  let raw: string;
  try {
    raw = fs.readFileSync(templatePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `Failed to read nested template at ${templatePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  try {
    return JSON.parse(raw) as CloudFormationTemplate;
  } catch (err) {
    throw new Error(
      `Failed to parse nested template at ${templatePath}: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Index the direct `AWS::CloudFormation::Stack` children of `template`,
 * returning `childLogicalId → absolute template path`. The child templates
 * are siblings of `templatePath` in the same `cdk.out` directory, so each
 * row's `Metadata['aws:asset:path']` resolves against `dirname(templatePath)`.
 *
 * Mirrors `NestedStackProvider.indexGrandchildTemplates` — kept here so the
 * recursive diff walker has no dependency on the provisioning layer.
 */
export function indexNestedChildTemplates(
  template: CloudFormationTemplate,
  templatePath: string
): Record<string, string> {
  const dir = path.dirname(templatePath);
  const result: Record<string, string> = {};
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (resource?.Type !== NESTED_STACK_RESOURCE_TYPE) continue;
    const meta = resource.Metadata as Record<string, unknown> | undefined;
    const assetPath = meta?.['aws:asset:path'];
    if (typeof assetPath !== 'string' || assetPath.length === 0) continue;
    if (isAbsoluteCrossPlatform(assetPath)) {
      throw new Error(
        `Nested stack '${logicalId}' has Metadata['aws:asset:path']='${assetPath}' which is ` +
          `absolute. CDK emits relative asset paths for nested templates; an absolute path ` +
          `indicates the synth output was hand-modified or generated by a non-CDK toolchain. ` +
          `Refusing to load.`
      );
    }
    result[logicalId] = path.join(dir, assetPath);
  }
  return result;
}

/** Load a stack's cdkd state, or synthesize an empty record (→ all CREATE) when none exists. */
async function loadStateOrEmpty(
  stackName: string,
  region: string,
  stateBackend: S3StateBackend
): Promise<StackState> {
  const result = await stateBackend.getState(stackName, region);
  if (result) return result.state;
  return {
    stackName,
    region,
    resources: {},
    outputs: {},
    version: STATE_SCHEMA_VERSION_CURRENT,
    lastModified: Date.now(),
  };
}

/**
 * Compute the per-resource diff for one stack: `currentState` (cdkd state)
 * vs `template` (synth desired state), with a best-effort intrinsic
 * resolver so changes buried inside intrinsics (e.g. `Fn::Join` literal
 * args) are detected against resolved values in state.
 *
 * Pure with respect to AWS state mutation — only reads state (the resolver
 * may read producer state for `Fn::ImportValue` / `Fn::GetStackOutput`).
 */
export async function computeStackDiff(
  currentState: StackState,
  template: CloudFormationTemplate,
  region: string,
  stackName: string,
  stateBackend: S3StateBackend,
  diffCalculator: DiffCalculator
): Promise<Map<string, ResourceChange>> {
  const intrinsicResolver = new IntrinsicFunctionResolver(region);
  const resolveFn = (value: unknown): Promise<unknown> =>
    intrinsicResolver.resolve(value, {
      template,
      resources: currentState.resources,
      stateBackend,
      stackName,
    });
  return diffCalculator.calculateDiff(currentState, template, resolveFn);
}

/**
 * Build the diff tree for one stack and (when `recursive`) every nested
 * `AWS::CloudFormation::Stack` descendant.
 *
 * Children come from the **union** of the template's nested-stack rows and
 * the state's nested-stack rows so the tree previews the full next deploy:
 *
 *  - In template (present / CREATE / UPDATE): recurse via the child's synth
 *    template + child state. A child with no state file diffs against an
 *    empty state → all CREATE (the "nested child not deployed yet" case).
 *  - In state but NOT in template (removed from CDK code → DELETE): recurse
 *    via the child's state diffed against an empty template → all DELETE,
 *    descending into state-listed grandchildren the same way. This mirrors
 *    `cdkd deploy <parent>` cascade-deleting a removed nested stack.
 *
 * Missing child template path (a template row whose synth output lacks
 * `Metadata['aws:asset:path']`) is a hard error — synth is inconsistent
 * and the user should re-synth, exactly as `NestedStackProvider` would
 * fail at deploy time.
 */
export async function buildDiffTree(args: {
  stackName: string;
  displayName: string;
  region: string;
  template: CloudFormationTemplate;
  nestedTemplates: Record<string, string>;
  recursive: boolean;
  stateBackend: S3StateBackend;
  diffCalculator: DiffCalculator;
}): Promise<DiffTreeNode> {
  const {
    stackName,
    displayName,
    region,
    template,
    nestedTemplates,
    recursive,
    stateBackend,
    diffCalculator,
  } = args;

  const state = await loadStateOrEmpty(stackName, region, stateBackend);
  const changes = await computeStackDiff(
    state,
    template,
    region,
    stackName,
    stateBackend,
    diffCalculator
  );
  const node: DiffTreeNode = { stackName, displayName, region, changes, children: [] };
  if (!recursive) return node;

  // Template-present children, in template order (CREATE / UPDATE / present).
  const templateChildIds = new Set<string>();
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (resource?.Type !== NESTED_STACK_RESOURCE_TYPE) continue;
    templateChildIds.add(logicalId);
    const childTemplatePath = nestedTemplates[logicalId];
    if (!childTemplatePath) {
      throw new Error(
        `Nested template file not found for ${NESTED_STACK_RESOURCE_TYPE} '${logicalId}' under ` +
          `stack '${stackName}'. Verify the synth output emits Metadata['aws:asset:path'] on ` +
          `this resource (CDK 2.x cdk.NestedStack does so by default), then re-run synth.`
      );
    }
    const childStackName = `${stackName}~${logicalId}`;
    const childTemplate = readNestedTemplate(childTemplatePath);
    const grandchildTemplates = indexNestedChildTemplates(childTemplate, childTemplatePath);
    node.children.push(
      await buildDiffTree({
        stackName: childStackName,
        displayName: childStackName,
        region,
        template: childTemplate,
        nestedTemplates: grandchildTemplates,
        recursive: true,
        stateBackend,
        diffCalculator,
      })
    );
  }

  // State-only children (removed from the template → recursive DELETE).
  for (const [logicalId, resource] of Object.entries(state.resources)) {
    if (resource.resourceType !== NESTED_STACK_RESOURCE_TYPE) continue;
    if (templateChildIds.has(logicalId)) continue;
    node.children.push(
      await buildDeletedSubtree(`${stackName}~${logicalId}`, region, stateBackend, diffCalculator)
    );
  }

  return node;
}

/**
 * Build a diff subtree for a nested child that exists in state but no
 * longer in the parent's template — every resource diffs as DELETE
 * (state vs empty template), recursing into state-listed grandchildren
 * (also all DELETE).
 */
async function buildDeletedSubtree(
  stackName: string,
  region: string,
  stateBackend: S3StateBackend,
  diffCalculator: DiffCalculator
): Promise<DiffTreeNode> {
  const state = await loadStateOrEmpty(stackName, region, stateBackend);
  const changes = await computeStackDiff(
    state,
    EMPTY_TEMPLATE,
    region,
    stackName,
    stateBackend,
    diffCalculator
  );
  const node: DiffTreeNode = {
    stackName,
    displayName: stackName,
    region,
    changes,
    children: [],
  };
  for (const [logicalId, resource] of Object.entries(state.resources)) {
    if (resource.resourceType !== NESTED_STACK_RESOURCE_TYPE) continue;
    node.children.push(
      await buildDeletedSubtree(`${stackName}~${logicalId}`, region, stateBackend, diffCalculator)
    );
  }
  return node;
}

/** True when this node has at least one real (non-`NO_CHANGE`) change. */
export function nodeHasChanges(node: DiffTreeNode): boolean {
  for (const change of node.changes.values()) {
    if (change.changeType !== 'NO_CHANGE') return true;
  }
  return false;
}

/** True when this node OR any descendant has a real change (tree-wide drift detector for `--fail`). */
export function treeHasChanges(node: DiffTreeNode): boolean {
  if (nodeHasChanges(node)) return true;
  return node.children.some(treeHasChanges);
}

/** Serializable per-resource change record for `--json`. */
export interface DiffChangeJson {
  logicalId: string;
  changeType: ResourceChange['changeType'];
  resourceType: string;
  propertyChanges?: ResourceChange['propertyChanges'];
  attributeChanges?: ResourceChange['attributeChanges'];
}

/** Serializable diff-tree node for `--json` (nested when `--recursive`). */
export interface DiffNodeJson {
  stack: string;
  region: string;
  changes: DiffChangeJson[];
  children: DiffNodeJson[];
}

/**
 * Project a {@link DiffTreeNode} into the `--json` shape. `NO_CHANGE`
 * entries are dropped so machine consumers see only actionable changes;
 * `children` is always present (empty array on leaves / non-recursive) so
 * the key set is stable.
 */
export function diffTreeToJson(node: DiffTreeNode): DiffNodeJson {
  const changes: DiffChangeJson[] = [];
  for (const change of node.changes.values()) {
    if (change.changeType === 'NO_CHANGE') continue;
    changes.push({
      logicalId: change.logicalId,
      changeType: change.changeType,
      resourceType: change.resourceType,
      ...(change.propertyChanges && change.propertyChanges.length > 0
        ? { propertyChanges: change.propertyChanges }
        : {}),
      ...(change.attributeChanges && change.attributeChanges.length > 0
        ? { attributeChanges: change.attributeChanges }
        : {}),
    });
  }
  return {
    stack: node.stackName,
    region: node.region,
    changes,
    children: node.children.map(diffTreeToJson),
  };
}

const INTRINSIC_KEYS = new Set([
  'Ref',
  'Fn::Sub',
  'Fn::GetAtt',
  'Fn::Join',
  'Fn::Select',
  'Fn::Split',
  'Fn::If',
  'Fn::ImportValue',
  'Fn::FindInMap',
  'Fn::Base64',
  'Fn::GetAZs',
  'Fn::Equals',
  'Fn::And',
  'Fn::Or',
  'Fn::Not',
]);

function isIntrinsic(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 1 && INTRINSIC_KEYS.has(keys[0]!);
}

/**
 * Strip unchanged and intrinsic-only values from a diff value.
 *
 * Recursively compares `value` against `other` and keeps only the keys whose
 * values actually differ (excluding intrinsic vs resolved mismatches). This
 * produces a minimal diff showing only real changes.
 */
function stripUnchangedValues(value: unknown, other: unknown): unknown {
  // Primitives or nulls: return as-is (the caller already determined these differ)
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value;

  // If value itself is an intrinsic, omit it (it's not a real change)
  if (isIntrinsic(value)) return undefined;
  // If the other side is an intrinsic, the resolved value on this side is not a real change
  if (isIntrinsic(other)) return undefined;

  if (other === null || other === undefined || typeof other !== 'object' || Array.isArray(other)) {
    return value;
  }

  const valObj = value as Record<string, unknown>;
  const otherObj = other as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(valObj)) {
    const v = valObj[key];
    const o = otherObj[key];

    // If either side is intrinsic for this key, skip (not a real change)
    if (isIntrinsic(v) || isIntrinsic(o)) continue;

    // If values are deeply equal, skip
    if (JSON.stringify(v) === JSON.stringify(o)) continue;

    // Recurse for nested objects
    if (typeof v === 'object' && v !== null && typeof o === 'object' && o !== null) {
      const filtered = stripUnchangedValues(v, o);
      if (filtered !== undefined && JSON.stringify(filtered) !== '{}') {
        result[key] = filtered;
      }
    } else {
      result[key] = v;
    }
  }

  return Object.keys(result).length > 0 ? result : value;
}

/**
 * Render one resource-change map into human-readable diff lines via `logFn`,
 * returning the per-type counts. Shared by the root stack block and every
 * nested-stack block.
 */
export function renderChangeLines(
  changes: Map<string, ResourceChange>,
  logFn: (msg: string) => void
): { create: number; update: number; delete: number } {
  let createCount = 0;
  let updateCount = 0;
  let deleteCount = 0;

  for (const [logicalId, change] of changes.entries()) {
    switch (change.changeType) {
      case 'CREATE':
        createCount++;
        logFn(`  [+] ${logicalId} (${change.resourceType})`);
        break;
      case 'UPDATE': {
        updateCount++;
        logFn(`  [~] ${logicalId} (${change.resourceType})`);
        if (change.propertyChanges && change.propertyChanges.length > 0) {
          for (const propChange of change.propertyChanges) {
            const requiresReplace = propChange.requiresReplacement ? ' [requires replacement]' : '';
            // Strip unchanged and intrinsic values to show only actual changes
            const oldFiltered = stripUnchangedValues(propChange.oldValue, propChange.newValue);
            const newFiltered = stripUnchangedValues(propChange.newValue, propChange.oldValue);
            const indent = '              ';
            const oldStr = (JSON.stringify(oldFiltered, null, 2) ?? 'undefined').replace(
              /\n/g,
              `\n${indent}`
            );
            const newStr = (JSON.stringify(newFiltered, null, 2) ?? 'undefined').replace(
              /\n/g,
              `\n${indent}`
            );
            logFn(`      - ${propChange.path}:${requiresReplace}`);
            logFn(`          old: ${oldStr}`);
            logFn(`          new: ${newStr}`);
          }
        }
        if (change.attributeChanges && change.attributeChanges.length > 0) {
          for (const attrChange of change.attributeChanges) {
            logFn(`      - ${attrChange.attribute}: [metadata only, no AWS API call]`);
            logFn(`          old: ${attrChange.oldValue ?? '(unset)'}`);
            logFn(`          new: ${attrChange.newValue ?? '(unset)'}`);
          }
        }
        break;
      }
      case 'DELETE':
        deleteCount++;
        logFn(`  [-] ${logicalId} (${change.resourceType})`);
        break;
    }
  }

  return { create: createCount, update: updateCount, delete: deleteCount };
}

/**
 * Render a diff tree (root + nested children, DFS) via `logFn`. Only nodes
 * that actually have changes get a block — unchanged nested children are
 * walked silently so the output shows only what the next deploy would do
 * (mirrors `cdk diff`, which lists only changed stacks). The root uses a
 * `Stack <name>:` header; every nested child uses `Nested stack: <name>`
 * (the A4 `state show --show-nested` convention, full `~`-joined name).
 */
export function renderDiffTree(
  node: DiffTreeNode,
  isRoot: boolean,
  logFn: (msg: string) => void
): void {
  if (nodeHasChanges(node)) {
    logFn(isRoot ? `\nStack ${node.stackName}:` : `\nNested stack: ${node.displayName}`);
    const { create, update, delete: del } = renderChangeLines(node.changes, logFn);
    logFn(`\n${create} to create, ${update} to update, ${del} to delete`);
  }
  for (const child of node.children) {
    renderDiffTree(child, false, logFn);
  }
}
