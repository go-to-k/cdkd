import { readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import {
  displayAssemblyPath,
  renderAssemblyPathEscape,
  resolveAssemblyPath,
} from '../../../utils/assembly-path.js';
import { hasReadableResources } from '../../../state/malformed-resources-bag.js';
import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { type LockRecoveryContext } from '../../../state/lock-contention-message.js';
import { NESTED_STACK_RESOURCE_TYPE } from '../retire-cfn-stack.js';
import { type StackState } from '../../../types/state.js';
import { parseCfnTemplateWithFormat, type TemplateFormat } from '../../yaml-cfn.js';
import {
  type CdkdStateStackTree,
  orphanCommandFor,
  plainOrNotShown,
  quotedOrNotShown,
  quotedRegion,
} from './render.js';

/**
 * Recursively load the cdkd-state tree rooted at `(rootStackName, region)`.
 * For every `AWS::CloudFormation::Stack` row in each level's
 * `state.resources`, derives the child's v6 state key
 * (`<parent>~<childLogicalId>`) and loads the child state file from S3,
 * then recurses.
 *
 * Throws if any expected child state file is missing — the parent's state
 * lists a nested-stack row but the child's `cdkd/<parent>~<child>/<region>/state.json`
 * does not exist. That state-tree inconsistency must be resolved before
 * any export attempt (typically via `cdkd state orphan <parent>` and a
 * full re-deploy, or by completing whatever partial operation left the
 * tree torn).
 *
 * Children at each level are loaded sequentially today (not `Promise.all`)
 * because the failure-mode shape is "fail fast on the first missing
 * child" rather than "list every missing child" — a single missing-child
 * pointer is enough for the user to identify the root cause without
 * fanning out N parallel `getState` calls on a torn tree. PR B2 may
 * revisit this once the per-child template-fetch / preprocessing /
 * upload pass dominates the wall-clock cost.
 *
 * Exported so the walker can be unit-tested independently of the orchestrator.
 *
 * Callers that already loaded the root state record up front (the typical
 * orchestrator shape — `exportCommand` always reads it via
 * `stateBackend.getState` before plan-build) can pass it via the optional
 * `prefetchedRootState` argument to save one S3 round-trip per export run.
 * Otherwise the walker fetches it itself, matching the standalone-use
 * signature.
 */
export async function buildCdkdStateStackTree(
  rootStackName: string,
  region: string,
  stateBackend: S3StateBackend,
  prefetchedRootState?: StackState,
  /**
   * The run's account flags (go-to-k/cdkd#4648), carried on the drop command
   * a missing-child refusal prints.
   */
  recovery?: LockRecoveryContext
): Promise<CdkdStateStackTree> {
  let rootState: StackState;
  if (prefetchedRootState !== undefined) {
    rootState = prefetchedRootState;
  } else {
    const rootResult = await stateBackend.getState(rootStackName, region);
    if (!rootResult) {
      // Guarded like the walker's refusals below, but DEFENSIVE rather than
      // reached: both production callers pass `prefetchedRootState`
      // (`state.ts`'s `--show-nested` branch and this file's own orchestrator),
      // so nothing today takes this arm. A caller that stops prefetching
      // inherits the guard instead of having to remember it (issue #3003).
      throw new Error(
        `No cdkd state found for stack ${quotedOrNotShown(rootStackName)} ` +
          `(${quotedRegion(region)}). ` +
          `Cannot build nested-stack tree.`
      );
    }
    rootState = rootResult.state;
  }
  return walkCdkdStateStackTree(rootStackName, region, rootState, stateBackend, recovery);
}

async function walkCdkdStateStackTree(
  stackName: string,
  region: string,
  state: StackState,
  stateBackend: S3StateBackend,
  // The run's account flags for the missing-child refusal's drop command
  // (go-to-k/cdkd#4648).
  recovery: LockRecoveryContext | undefined
): Promise<CdkdStateStackTree> {
  const nestedChildren = new Map<string, CdkdStateStackTree>();

  // A record whose `resources` is not a map of logical id to resource declares
  // no nested stack, so this walk has nothing to do — and doing it anyway costs
  // two things (issue #3172).
  //
  // `Object.entries` allocates one `[index, element]` pair per ELEMENT, so a
  // planted multi-megabyte string is a memory-exhaustion path: measured against
  // the shipped binary, a 5,000,000-character bag costs 1623 ms and 1277 MB, in
  // `--show-nested --json` as well as the text view, because the walk runs above
  // both. And a bag hand-edited from a MAP into a LIST of resource objects
  // survives the `entry?.resourceType` test below: the loop reads the list INDEX
  // as a logical id, looks for a child record at `<parent>~0`, finds none, and
  // hard-fails before anything is rendered.
  //
  // The test sits INSIDE the walker, not at its caller, because the walker
  // RECURSES: a guard at `stateShowCommand`'s call site covers the root and
  // nothing below it, and both costs above were re-measured live on a CHILD
  // record with exactly that arrangement in place. One predicate, at the one
  // place every depth passes through.
  //
  // Read-only, and deliberately NOT a repair: the node keeps the ORIGINAL
  // record, so `cdkd state show --show-nested --json` still emits the stored bag
  // and the evidence survives. `state.ts` repairs the bags it RENDERS, per node,
  // after its `--json` branches.
  //
  // TWO callers, and the second is why this returns rather than throws.
  // `stateShowCommand`'s `--show-nested` is the read-only one. `exportCommand`
  // (this file) also walks, to migrate a cdkd state tree to CloudFormation, and
  // there a record whose bag cannot be read must NOT be treated as a stack with
  // no children and quietly migrated. `runPerStackImportLoop` refuses every
  // tree node through `refuseMalformedResourcesForExport` before its pre-flight reads a bag
  // (issue #3188, pinned end to end in
  // `tests/unit/cli/export-malformed-child-bag.test.ts`). Returning childless
  // here is safe for export only because that refusal exists; if it ever
  // moves, this function is where export would start silently migrating a
  // truncated tree.
  if (!hasReadableResources(state)) return { stackName, region, state, nestedChildren };

  // No `?? {}` on the BAG: the guard above has already returned for every shape
  // it covered, absent and `null` included, so a fallback here can no longer
  // fire and would only make a later reader think the bag is guarded at the loop
  // instead of at the entry. Same rule `state.ts` applies at its own two sites.
  //
  // The possibly-`null` ENTRY guard stays and is a different question: a
  // hand-edited `{"R": null}` inside an otherwise readable map threw here before
  // anything rendered (issue #2947). A `null` entry cannot be a nested stack, so
  // the type check skips it.
  for (const [logicalId, entry] of Object.entries(state.resources) as Array<
    [string, (typeof state.resources)[string] | null]
  >) {
    if (entry?.resourceType !== NESTED_STACK_RESOURCE_TYPE) continue;
    const childStackName = `${stackName}~${logicalId}`;
    const childResult = await stateBackend.getState(childStackName, region);
    if (!childResult) {
      const orphan = orphanCommandFor(stackName, region, recovery);
      throw new Error(
        `cdkd state is missing nested-child ${quotedOrNotShown(childStackName)} (${quotedRegion(region)}). ` +
          `Parent stack ${quotedOrNotShown(stackName)} lists ${quotedOrNotShown(logicalId)} as an ` +
          `${NESTED_STACK_RESOURCE_TYPE} row but no child state file exists at ` +
          `${quotedOrNotShown(`cdkd/${childStackName}/${region}/state.json`)}. The cdkd state tree is ` +
          `inconsistent — re-deploy the parent stack to refresh, or drop the parent's record ` +
          `and re-import.${orphan.note}\nDrop it with: ${orphan.command}`
      );
    }
    // Sanity-check the child's recorded region against the walker's
    // expected region (the parent's region). AWS does not support
    // cross-region nested stacks today — design §6 — so a mismatch
    // is either a torn state file (manually edited) or a future
    // cross-region capability landing without a tree-shape bump. Fail
    // fast in either case so the orchestrator does not silently
    // proceed against a parent ↔ child pair whose AWS-side identity
    // we cannot guarantee.
    //
    // READ FROM THE REPORT, NOT FROM THE RECORD, since issue
    // go-to-k/cdkd#3328: `getState` now normalizes a region-scoped record's
    // `region` to the key's, so `childResult.state.region` can no longer
    // disagree and this check tested against it would be vacuous. The
    // divergence is handed over separately, on the SAME predicate this check
    // always applied — a body region that is present and is not the walk's.
    // The value is body content, so it goes through `quotedOrNotShown`
    // (go-to-k/cdkd#3950), which describes anything that is not plain.
    //
    // One shape stops being refused here and it is recorded rather than
    // implied: a child read from the LEGACY key (no region in the key) whose
    // body carries `null` / `''`. That branch is deliberately not normalized —
    // `tryGetLegacy` hands a body naming no region to any region (#2550) — so
    // nothing is reported for it. It is unreachable in practice: nested-child
    // records are region-scoped by construction (schema v6, long past the v2
    // key layout), so no cdkd version ever wrote a `<parent>~<child>` legacy
    // key.
    if (childResult.divergentBodyRegion !== undefined) {
      throw new Error(
        `cdkd state region mismatch: nested-child ${quotedOrNotShown(childStackName)} has ` +
          `state.region=${quotedOrNotShown(childResult.divergentBodyRegion)} but its parent ${quotedOrNotShown(stackName)} ` +
          `is being walked against region=${quotedOrNotShown(region)}. AWS does not support ` +
          `cross-region nested stacks; the state tree appears corrupt — ` +
          `re-deploy the parent stack to refresh.`
      );
    }
    nestedChildren.set(
      logicalId,
      await walkCdkdStateStackTree(
        childStackName,
        region,
        childResult.state,
        stateBackend,
        recovery
      )
    );
  }
  return { stackName, region, state, nestedChildren };
}

/**
 * Flatten a {@link CdkdStateStackTree} into a depth-first list of
 * `(stackName, region)` pairs in **leaf-first** order — same order PR B2's
 * state-cleanup pass will use to delete each adopted stack's cdkd state
 * after the CFn-side IMPORT succeeds (so a mid-walk failure leaves the
 * earlier parent's state intact for retry).
 *
 * Exported so callers (orchestrator user-facing summary, unit tests) can
 * iterate the tree in the same order without re-implementing the walk.
 */
export function flattenCdkdStateTreeLeafFirst(
  tree: CdkdStateStackTree
): Array<{ stackName: string; region: string }> {
  const out: Array<{ stackName: string; region: string }> = [];
  walk(tree);
  return out;

  function walk(node: CdkdStateStackTree): void {
    for (const child of node.nestedChildren.values()) {
      walk(child);
    }
    out.push({ stackName: node.stackName, region: node.region });
  }
}

/**
 * Flatten a {@link CdkdStateStackTree} into a depth-first list of
 * `(stackName, region)` pairs in **root-first** order — the inverse of
 * {@link flattenCdkdStateTreeLeafFirst}. Used by the parameter-resolution
 * pre-pass in `runPerStackImportLoop` (issue #464 follow-up): each child's
 * intrinsic-valued Parameters resolve against its parent's already-resolved
 * Parameters, so the parent must be visited first.
 *
 * Exported so callers (orchestrator parameter pre-pass, unit tests) can
 * iterate the tree in the same order without re-implementing the walk.
 */
export function flattenCdkdStateTreeRootFirst(
  tree: CdkdStateStackTree
): Array<{ stackName: string; region: string }> {
  const out: Array<{ stackName: string; region: string }> = [];
  walk(tree);
  return out;

  function walk(node: CdkdStateStackTree): void {
    out.push({ stackName: node.stackName, region: node.region });
    for (const child of node.nestedChildren.values()) {
      walk(child);
    }
  }
}

/**
 * Map a cdkd stack name to a CloudFormation-compatible stack name.
 *
 * Required because the cdkd v6 state-key form `<parent>~<childLogicalId>`
 * contains `~`, which CFn rejects in stack names (CFn accepts
 * `[a-zA-Z][-a-zA-Z0-9]*` only). The substitution chooses `-` to mirror
 * CFn's own auto-naming convention for nested stacks
 * (`<Parent>-<ChildLogicalId>-<RandomSuffix>` minus the suffix).
 *
 * Top-level cdkd stack names that already conform to CFn's character set
 * are passed through unchanged — `cdkd2cfnStackName('MyApp') === 'MyApp'`.
 *
 * The post-substitution result is validated against the same CFn
 * stack-name regex `parseCfnChildStackNameOverrides` enforces
 * (`[a-zA-Z][-a-zA-Z0-9]*`). The `~` → `-` swap only handles the v6
 * separator; a cdkd name that is otherwise CFn-illegal (leading digit /
 * underscore, embedded `.` or `/`, etc.) would still pass through and
 * surface as an opaque CFn API rejection deep inside the IMPORT loop.
 * Throwing here surfaces the problem at orchestrator pre-flight time with
 * an actionable pointer at the `--cfn-stack-name` / `--cfn-child-stack-name`
 * override escape hatch.
 *
 * Issue #464 design §9 Q8.
 */
export function cdkd2cfnStackName(cdkdStackName: string): string {
  const cfnName = cdkdStackName.replace(/~/g, '-');
  if (!/^[a-zA-Z][-a-zA-Z0-9]*$/.test(cfnName)) {
    throw new Error(
      // Through `quotedOrNotShown`, like every other quoted record-derived
      // name in this file (go-to-k/cdkd#3328 round 5, go-to-k/cdkd#3950):
      // `walkCdkdStateStackTree` mints a child's name from the record's own
      // `resources` keys, and this refusal is the FIRST thing a hostile one
      // reaches — a newline in it would forge lines around whatever follows,
      // and a quote in it would close cdkd's.
      `cdkd stack name ${quotedOrNotShown(cdkdStackName)} maps to CFn stack name ` +
        `${quotedOrNotShown(cfnName)}, which violates ` +
        `the CloudFormation stack-name constraint [a-zA-Z][-a-zA-Z0-9]* (must start with a ` +
        `letter; no '_', '.', '/', or other special characters). Supply an explicit name via ` +
        `--cfn-stack-name (root) or --cfn-child-stack-name '<cdkdName>=<cfnName>' (nested child).`
    );
  }
  return cfnName;
}

/**
 * Parse the repeatable `--cfn-child-stack-name <cdkdName>=<cfnName>` CLI
 * flag into a lookup map. Each entry maps a cdkd stack name (v6 form,
 * e.g. `MyApp~Database`) to the desired CFn stack name.
 *
 * Throws on a malformed entry (no `=`, empty cdkdName, empty cfnName, or
 * a CFn name that violates the CFn naming constraint) so the user sees
 * the problem before any AWS-side mutation. Duplicate cdkdName keys are
 * rejected to avoid silent last-wins behavior.
 *
 * Exported for unit testing.
 */
export function parseCfnChildStackNameOverrides(values: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!values || values.length === 0) return out;
  for (const raw of values) {
    const eq = raw.indexOf('=');
    if (eq < 0) {
      throw new Error(
        `--cfn-child-stack-name ${quotedOrNotShown(raw)} is not in '<cdkdName>=<cfnName>' form. ` +
          `Example: --cfn-child-stack-name 'MyApp~Database=my-app-database'.`
      );
    }
    const cdkdName = raw.slice(0, eq).trim();
    const cfnName = raw.slice(eq + 1).trim();
    if (!cdkdName) {
      throw new Error(
        `--cfn-child-stack-name ${quotedOrNotShown(raw)} has an empty cdkd stack name.`
      );
    }
    if (!cfnName) {
      throw new Error(
        `--cfn-child-stack-name ${quotedOrNotShown(raw)} has an empty CFn stack name.`
      );
    }
    if (!/^[a-zA-Z][-a-zA-Z0-9]*$/.test(cfnName)) {
      throw new Error(
        `--cfn-child-stack-name ${quotedOrNotShown(raw)}: CFn stack name ${quotedOrNotShown(cfnName)} must match ` +
          `[a-zA-Z][-a-zA-Z0-9]* (no '~', no '/', no '_', no '.').`
      );
    }
    if (out.has(cdkdName)) {
      throw new Error(
        `--cfn-child-stack-name: duplicate override for cdkd stack ${quotedOrNotShown(cdkdName)}. ` +
          `Pass it once with the final CFn name.`
      );
    }
    out.set(cdkdName, cfnName);
  }
  return out;
}

/**
 * A read failure's cause for a sentence: the fs error code when it is one
 * (`ENOENT`, `EACCES`), else a fixed phrase. Never the error's message, which
 * quotes the path back (go-to-k/cdkd#3950). Exported for unit testing.
 */
export function fsReadErrorCause(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(code)
    ? code
    : 'the file could not be read';
}

/**
 * Read + parse a nested-stack child template from the synth cloud assembly.
 * The path is the absolute filesystem path AssemblyReader populated from
 * the parent template's `Metadata['aws:asset:path']` on each
 * `AWS::CloudFormation::Stack` resource.
 *
 * Format-aware: CDK 2.x always synthesizes JSON for nested templates, but
 * the codec recognizes both JSON and YAML so the helper is forward-compatible
 * with any synth output (and matches `parseTemplateFile` for `--template`).
 *
 * Sibling of `readNestedChildTemplate` in `import.ts`. Kept separate so
 * `export.ts` does not depend on `import.ts` internals and the return
 * shape (`Record<string, unknown>` + `TemplateFormat`) matches what
 * `executeImportChangeSet` / `executeUpdateChangeSet` consume. Consolidate
 * into a shared `nested-template-fs.ts` module if a third caller appears.
 */
function readNestedChildTemplateFile(
  templatePath: string,
  childLogicalId: string
): { template: Record<string, unknown>; format: TemplateFormat } {
  // Neither cause prints its error TEXT (go-to-k/cdkd#3950): Node's read error
  // echoes the path inside its own `'...'`, and a parse error echoes a snippet
  // of the file in `"..."`. The path is template text (`aws:asset:path`) and
  // the file is the template author's, so either would put their value back
  // inside a quote in a sentence that is pasted.
  let raw: string;
  try {
    raw = readFileSync(templatePath, 'utf-8');
  } catch (err) {
    throw new Error(
      `cdkd export: failed to read nested-stack template for ${quotedOrNotShown(childLogicalId)} at ` +
        `${quotedOrNotShown(templatePath)}: ${fsReadErrorCause(err)}`
    );
  }
  try {
    return parseCfnTemplateWithFormat(raw);
  } catch {
    throw new Error(
      `cdkd export: failed to parse nested-stack template for ${quotedOrNotShown(childLogicalId)} at ` +
        `${quotedOrNotShown(templatePath)}: it is not a template cdkd can parse (the parser's ` +
        `message is not shown, because it quotes the file's own text)`
    );
  }
}

/**
 * Index every `AWS::CloudFormation::Stack` row in `template` by its
 * `Metadata['aws:asset:path']`, returning `{logicalId: <absolute-path>}`.
 * Mirrors `AssemblyReader.extractStackInfo`'s nested-template indexing
 * (line ~277 of `assembly-reader.ts`) so the same logic applies to
 * arbitrary depth — grandchild templates are siblings of their parent
 * child template in the same cdk.out subdirectory.
 *
 * Refuses absolute `aws:asset:path` values (CDK emits relative paths
 * only; an absolute path indicates hand-modified synth output or a
 * non-CDK toolchain — `path.join(dir, '/abs/foo')` would silently bypass
 * the `dir` argument).
 *
 * Also refuses a path that RESOLVES outside `templateDir`, which the absolute
 * check cannot see — `path.join` folds `..`
 * ([#3489](https://github.com/go-to-k/cdkd/issues/3489)).
 *
 * Sibling of `indexGrandchildTemplatePaths` in `import.ts`. Same rationale
 * for separate definitions as `readNestedChildTemplateFile` above. Exported
 * for unit testing.
 */
export function indexNestedTemplatePaths(
  template: Record<string, unknown>,
  templateDir: string
): Record<string, string> {
  // Null-prototype, like every other nested-template index (issue
  // go-to-k/cdkd#3480): a logical id is a template key, so a `{}` literal drops
  // a row named `__proto__` through the inherited setter and answers a
  // never-indexed `toString` / `valueOf` with a prototype member.
  const result = nullPrototypeRecord<string>();
  const resources = template['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) return result;
  for (const [logicalId, resource] of Object.entries(resources as Record<string, unknown>)) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
    const r = resource as { Type?: string; Metadata?: Record<string, unknown> };
    if (r.Type !== NESTED_STACK_RESOURCE_TYPE) continue;
    const assetPath = r.Metadata?.['aws:asset:path'];
    if (typeof assetPath !== 'string' || assetPath.length === 0) continue;
    if (nodePath.isAbsolute(assetPath)) {
      throw new Error(
        `cdkd export: nested-stack ${plainOrNotShown(logicalId)} has ` +
          `Metadata['aws:asset:path']=${displayAssemblyPath(assetPath)} ` +
          `which is absolute. CDK emits relative asset paths for nested templates.`
      );
    }
    // The containment check the tripwire above is NOT (issue
    // go-to-k/cdkd#3489): `path.join` folds `..`, so a row of
    // `../../etc/passwd` resolved out of `templateDir` and its contents were
    // read and written into the exported CloudFormation template. Both
    // refusals stay, worded apart.
    const resolved = resolveAssemblyPath(templateDir, assetPath);
    if (!resolved.contained) {
      throw new Error(
        `cdkd export: nested-stack ${plainOrNotShown(logicalId)} has ` +
          `Metadata['aws:asset:path']=${displayAssemblyPath(assetPath)} which ` +
          `${renderAssemblyPathEscape(resolved, templateDir)}`
      );
    }
    result[logicalId] = resolved.path;
  }
  return result;
}

/**
 * Per-stack metadata required by {@link runPerStackImportLoop}: the cdkd
 * stack name, region, loaded state, parsed template, and template format.
 * One entry per node in the {@link CdkdStateStackTree}.
 */
export interface PerStackImportNode {
  cdkdStackName: string;
  region: string;
  state: StackState;
  template: Record<string, unknown>;
  templateFormat: TemplateFormat;
}

/**
 * Walk the cdkd state tree alongside the synth output's nested-template
 * file paths, materializing each node's parsed template + format. The
 * walker indexes children's paths from the parent template's
 * `Metadata['aws:asset:path']` (same mechanism `AssemblyReader` uses for
 * the root parent), so grandchildren and deeper levels are loaded
 * recursively without any caller-side index plumbing.
 *
 * Throws if any tree node has a child whose template path is missing from
 * the parent template's nested-template index — that mismatch indicates
 * a torn synth output (the child state file exists but the parent CDK
 * code no longer references it) and the run cannot proceed safely.
 *
 * Returns a map keyed by cdkd stack name (matching tree node names) so
 * {@link runPerStackImportLoop} can look each node's template up by name
 * without re-traversing the tree.
 *
 * Exported so the recursion shape is unit-testable independently of the
 * orchestrator.
 */
export function buildPerStackImportNodes(
  rootStackName: string,
  rootTemplate: Record<string, unknown>,
  rootNestedTemplatePaths: Record<string, string>,
  rootTemplateFormat: TemplateFormat,
  tree: CdkdStateStackTree,
  // The run's account flags for the out-of-sync child's drop command
  // (go-to-k/cdkd#4648).
  recovery?: LockRecoveryContext
): Map<string, PerStackImportNode> {
  if (tree.stackName !== rootStackName) {
    throw new Error(
      // The last raw rendering of a record-derived name in this file
      // (go-to-k/cdkd#3328 round 5): `walkCdkdStateStackTree` mints every
      // non-root node's name from the record's own `resources` keys, so an
      // internal-consistency message is no exception to the rule.
      `buildPerStackImportNodes: tree root ${quotedOrNotShown(tree.stackName)} does not match ` +
        `expected root stack name ${quotedOrNotShown(rootStackName)}.`
    );
  }
  const out = new Map<string, PerStackImportNode>();
  walk(tree, rootTemplate, rootNestedTemplatePaths, rootTemplateFormat);
  return out;

  function walk(
    node: CdkdStateStackTree,
    nodeTemplate: Record<string, unknown>,
    nodeNestedTemplatePaths: Record<string, string>,
    nodeFormat: TemplateFormat
  ): void {
    out.set(node.stackName, {
      cdkdStackName: node.stackName,
      region: node.region,
      state: node.state,
      template: nodeTemplate,
      templateFormat: nodeFormat,
    });
    for (const [childLogicalId, childNode] of node.nestedChildren) {
      const childTemplatePath = nodeNestedTemplatePaths[childLogicalId];
      if (!childTemplatePath) {
        const orphan = orphanCommandFor(childNode.stackName, childNode.region, recovery);
        throw new Error(
          `cdkd export: nested-stack child ${quotedOrNotShown(childLogicalId)} under parent ` +
            `${quotedOrNotShown(node.stackName)} has cdkd state but no Metadata['aws:asset:path'] ` +
            `in the parent template's ${quotedOrNotShown(childLogicalId)} row. The synth output ` +
            `and the cdkd state tree are out of sync — re-deploy the parent stack ` +
            `to refresh, or remove the cdkd state for the orphaned child.${orphan.note}\n` +
            `Remove it with: ${orphan.command}`
        );
      }
      const { template: childTemplate, format: childFormat } = readNestedChildTemplateFile(
        childTemplatePath,
        childLogicalId
      );
      const childNestedPaths = indexNestedTemplatePaths(
        childTemplate,
        nodePath.dirname(childTemplatePath)
      );
      walk(childNode, childTemplate, childNestedPaths, childFormat);
    }
  }
}

/**
 * A nested-stack row detected in the parent template + matched against the
 * parent's cdkd state. Surfaced by {@link buildImportPlan} so the
 * orchestrator can route the row through the recursive nested-stack
 * tree walker (issue [#464](https://github.com/go-to-k/cdkd/issues/464)
 * PR B1 + PR B2) instead of the per-resource IMPORT path.
 *
 * Holds only the parent-side row identifiers; the child's full state /
 * sub-template / further descendants are loaded separately by
 * {@link buildCdkdStateStackTree}. Keeping the two passes separate means
 * `buildImportPlan` stays pure (no state-backend I/O) and the tree walker
 * stays focused on the recursive load.
 */
export interface NestedStackRow {
  /** Logical id of the `AWS::CloudFormation::Stack` row in the parent's template. */
  logicalId: string;
  /**
   * The v6 child state-key's stack-name portion: `<parent>~<childLogicalId>`.
   * Derived deterministically from `(parentStackName, logicalId)` so the
   * orchestrator can quote it in user-facing error messages without
   * round-tripping through {@link buildCdkdStateStackTree}.
   */
  childStackName: string;
}
