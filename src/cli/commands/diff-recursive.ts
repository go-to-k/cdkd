import { stripControlChars } from '../../utils/regexp.js';
import { displayIdent, displayStackName } from '../../utils/display-safe.js';
import {
  describeFileReadFailure,
  displayAssemblyPath,
  renderAssemblyPathEscape,
  resolveAssemblyPath,
} from '../../utils/assembly-path.js';
import { nullPrototypeRecord } from '../../utils/own-keys.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CloudFormationTemplate, TemplateResource } from '../../types/resource.js';
import type { ResourceChange, ResourceState, StackState } from '../../types/state.js';
import {
  STATE_SCHEMA_VERSION_CURRENT,
  hasReadableExportSet,
  importableOutputKeys,
  isReadableBag,
} from '../../types/state.js';
import {
  isSecretBearingReferenceString,
  keptWholeReasonText,
  mergeNoChangeOutputs,
} from '../../deployment/no-change-outputs-merge.js';
import { DiffCalculator, INTRINSIC_KEYS } from '../../analyzer/diff-calculator.js';
import type { CanonicalizePropertiesFn } from '../../analyzer/diff-calculator.js';
import { TemplateParser } from '../../analyzer/template-parser.js';
import {
  IntrinsicFunctionResolver,
  carriesDynamicReference,
  parameterTypeMayLoseSecretIdentity,
  coerceParameterTypedValue,
} from '../../deployment/intrinsic-function-resolver.js';
import {
  computeOutputsDiff,
  resolveTemplateOutputs,
  templateHasSecretDynamicReference,
  templateLetsConditionsReachOutputs,
  type OutputChange,
} from '../../analyzer/outputs-diff.js';
import { bindingSkippedOutputs } from '../../analyzer/skipped-outputs.js';
import { getLogger } from '../../utils/logger.js';
import type { S3StateBackend } from '../../state/s3-state-backend.js';
import {
  rewriteTemplateAssetReferences,
  type AssetRedirectMap,
} from '../../assets/asset-redirect.js';
import { findActionableSilentDrops } from '../../provisioning/property-coverage.js';
import { wouldReturnToSdkProvider } from '../../provisioning/provider-registry.js';
import { NESTED_STACK_RESOURCE_TYPE } from './retire-cfn-stack.js';
import {
  malformedExportNamesWarning,
  malformedOutputsWarning,
  malformedResourceEntriesWarning,
  malformedOrphanRecordsWarning,
  malformedResourcePropertiesWarning,
  malformedResourcesWarning,
  deployRefusesOrphanRowsReason,
  malformedOrphanRowsKeptWarning,
  isReadableOrphanRecord,
  previewableOrphanRecords,
  unpreviewableOrphanRecords,
  malformedOrphansWarning,
  repairMalformedOrphansForReadOnly,
  repairMalformedOutputsForReadOnly,
  repairMalformedResourceEntriesForReadOnly,
  repairMalformedResourcePropertiesForReadOnly,
  repairMalformedResourcesForReadOnly,
  displayLogicalId,
  UNREADABLE_ORPHANS_CONTAINER_ROW,
  UNREADABLE_RESOURCES_MAP_ROW,
} from '../../state/malformed-resources-bag.js';

/**
 * The one spelling of the routing token for a resource leaving Cloud Control
 * (issue #2719). A literal, because `collectCcApiRoutes` writes it and
 * `annotateRouting` special-cases it, and the integ fixture greps for it --
 * three places that must agree on a string.
 */
export const SDK_MIGRATION_TOKEN = 'returning to SDK provider';

const logger = getLogger().child('DiffRecursive');

/** Every `Ref` target reachable from a value, collected in one walk. */
function collectRefTargets(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const element of value) collectRefTargets(element, refs);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const obj = value as Record<string, unknown>;
  if (typeof obj['Ref'] === 'string') refs.add(obj['Ref']);
  for (const nested of Object.values(obj)) collectRefTargets(nested, refs);
}

/**
 * Whether ANY condition in `template` references one of `tokenParameterNames`
 * (issue #1903, review round 2).
 *
 * WHY THIS EXISTS AND WHY THE BROAD FORM IS NOT MERELY CONSERVATIVE. The
 * token-parameter guard originally skipped condition evaluation for the WHOLE
 * template as soon as any bound parameter was a redacted token, on the argument
 * that the cost is "a condition-false resource is diffed rather than pruned".
 * That is only half of it: leaving `conditions` UNDEFINED also means `resolveIf`
 * finds no entry, warns, and takes the FALSE branch for every `Fn::If` in every
 * property value — so a condition-TRUE property diffs as a spurious UPDATE
 * (perpetual, and `--fail` exits 1) and condition-gated resources surface as
 * phantom CREATEs. And it fired whenever ANY parameter was token-valued, even
 * when not one condition mentioned it.
 *
 * So the skip is narrowed to what it can actually get wrong: a condition whose
 * verdict DEPENDS on a value this side does not have.
 *
 * NO TRANSITIVE `{Condition: X}` WALK, and its absence is a reachability
 * argument rather than an omission. An `Fn::And` over a NAMED condition (issue
 * #840's shape) does inherit that condition's dependency — but the named
 * condition is itself an entry in this same `Conditions` map, and this scan
 * visits EVERY entry, so the dependency is already found directly on the
 * referenced condition. A chain walk was written first and measured dead: with
 * it removed, a template whose `IsDev` wraps `{Condition: IsProd}` while only
 * `IsProd` names the token parameter still answers `true`.
 */
function conditionsDependOnTokenParameters(
  template: CloudFormationTemplate,
  tokenParameterNames: ReadonlySet<string>
): boolean {
  const templateConditions = template.Conditions;
  if (!templateConditions || typeof templateConditions !== 'object') return false;
  if (tokenParameterNames.size === 0) return false;

  for (const definition of Object.values(templateConditions)) {
    const refs = new Set<string>();
    collectRefTargets(definition, refs);
    for (const ref of refs) {
      if (tokenParameterNames.has(ref)) return true;
    }
  }
  return false;
}

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
  /**
   * Per-resource Cloud Control API auto-route hits (issue [#614]). Maps each
   * logical ID that #614's auto-fallback would route via CC API to the
   * silent-drop property names that triggered the routing — surfaced as
   * `[via CC API: Body]` annotations on each diff line so users can
   * audit the routing decision before they deploy. Empty for stacks whose
   * template uses no silent-drop top-level property, and for state-only
   * DELETE branches (deletes route via the recorded `provisionedBy`, not via
   * template inspection).
   */
  ccApiRoutes: Map<string, string[]>;
  /**
   * Per-key changes to this node's persisted `Outputs` bag (issue #1921).
   *
   * Empty when the Outputs section is unchanged AND when any output could not
   * be resolved — see {@link resolveTemplateOutputs}. Only real changes are
   * carried (there is no `NO_CHANGE` member), so a non-empty array always means
   * the next deploy would write outputs, which is what makes an Outputs-ONLY
   * change reach {@link nodeHasChanges} instead of printing "No changes
   * detected" while the apply republishes the exports index.
   */
  outputChanges: OutputChange[];
  /**
   * Logical ids this node's diff read out of a rollback-orphan record rather
   * than out of `resources` (issue go-to-k/cdkd#2943). Their rows are ordinary
   * UPDATE / NO_CHANGE rows and carry an annotation.
   */
  adoptedOrphans: string[];
  /**
   * Reasons `cdkd deploy` would refuse THIS node (issue go-to-k/cdkd#2943).
   * Rendered after the rows, and non-empty anywhere in the tree makes
   * `cdkd diff` exit non-zero — the preview is complete, but the deploy it
   * describes cannot start.
   */
  blocking: string[];
  /**
   * Rows this node's state record holds that the diff could NOT read
   * (go-to-k/cdkd#3018): each unreadable entry's logical id,
   * `UNREADABLE_RESOURCES_MAP_ROW` when the whole `resources` map is not an
   * object, and each rollback-orphan record (`orphans[]`) the adoption preview
   * could not read as a resource — `''` for one with no string `logicalId`,
   * which renders as the `<unrenderable>` stand-in. The load drops the first
   * two so the rest of the stack can be diffed; `computeStackDiff` drops the
   * third before the preview, which throws on a `null` or `undefined` `state`
   * or a `null` record and silently keeps the other shapes. A
   * dropped row the template still declares then previews as a CREATE, but one
   * the TEMPLATE no longer declares reaches no change at all — it would lose its
   * DELETE row and let `--fail` exit 0 over a record that used to crash. Counted by {@link nodeHasChanges} for that
   * reason, rendered as its own block, and always present in `--json`.
   */
  unreadable: string[];
  /** Direct nested-stack children, DFS order. Empty for leaves and for non-recursive runs. */
  children: DiffTreeNode[];
}

/**
 * The reason a repaired `properties` map puts on the node's `blocking`
 * (go-to-k/cdkd#3335).
 *
 * `cdkd diff` REPAIRS this container and previews the record; `cdkd deploy`
 * REFUSES it inside `DiffCalculator.calculateDiff`, which both deploy paths
 * reach. So the preview is honest about the rows and wrong about what happens
 * next, and this is the sentence that says so.
 *
 * The ids are NOT re-rendered here: they have already been through
 * `malformedResourcePropertiesWarning`'s sanitizer in the warning printed
 * beside this, and the renderer strips control characters from every blocking
 * reason on the way out. The count is what this line adds — and the line does
 * not send the reader to that warning for the names, because the warning caps
 * at five before `and N more`, and under `--json` this reason ships in the
 * payload, where "above" has no referent.
 */
function deployRefusesPropertiesReason(logicalIds: readonly string[]): string {
  return (
    `${logicalIds.length} resource record(s) hold a 'properties' map that cannot be read. ` +
    `This preview repaired them to empty; 'cdkd deploy' refuses the record instead, so the ` +
    `deploy this previews will not start.`
  );
}

/**
 * The `outputs` twin of {@link deployRefusesPropertiesReason}, a constant
 * because the bag is refused as a whole and there is nothing to count.
 *
 * `refuseMalformedOutputs` in `DeployEngine` is what refuses it. This arm is
 * the one the issue could not drive end to end — a record whose template
 * declares no Outputs produces no delta at all, so before this the node had
 * nothing to report and `--fail` exited 0.
 */
const DEPLOY_REFUSES_OUTPUTS_REASON =
  `The 'outputs' bag cannot be read. This preview repaired it to empty; 'cdkd deploy' ` +
  `refuses the record instead, so the deploy this previews will not start.`;

/*
 * The reasons for the containers this command DROPS rather than repairs in
 * place (go-to-k/cdkd#3512): the `resources` bag, a `resources` entry, the
 * `orphans` container and an `orphans` row. Each already puts a row in the
 * node's `unreadable`, which `--fail` counts; `cdkd deploy` refuses the record
 * over every one of them, so each ALSO carries a blocking reason and exit 3
 * says so. The rule is the one go-to-k/cdkd#3335 set for the two containers
 * above: a container the deploy refuses is a reason, and whatever `unreadable`
 * row it had stays — `--json`'s `unreadable` still means "dropped from the
 * diff", and exit 3 outranks `--fail` where both fire.
 *
 * Count-only, like {@link deployRefusesPropertiesReason}: the rows are named in
 * `unreadable` and in the warning printed beside this.
 */
const DEPLOY_REFUSES_RESOURCES_BAG_REASON =
  `The 'resources' map cannot be read. This preview read it as empty; 'cdkd deploy' ` +
  `refuses the record instead, so the deploy this previews will not start.`;

function deployRefusesResourceEntriesReason(logicalIds: readonly string[]): string {
  return (
    `${logicalIds.length} resource record(s) in 'resources' cannot be read as resources. ` +
    `This preview dropped them; 'cdkd deploy' refuses the record instead, so the deploy ` +
    `this previews will not start.`
  );
}

const DEPLOY_REFUSES_ORPHANS_CONTAINER_REASON =
  `The 'orphans' field is not a list. This preview read it as empty; 'cdkd deploy' ` +
  `refuses the record instead, so the deploy this previews will not start.`;

function deployRefusesDroppedOrphanRowsReason(logicalIds: readonly string[]): string {
  return (
    `${logicalIds.length} rollback-orphan record(s) in 'orphans' cannot be read as resources. ` +
    `This preview dropped them; 'cdkd deploy' refuses the record instead, so the deploy ` +
    `this previews will not start.`
  );
}

/** How many unreadable row names the human preview lists before summarizing. */
const UNREADABLE_PREVIEW_NAMES = 10;

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
      `Failed to read nested template at ${displayAssemblyPath(templatePath)}: ${describeFileReadFailure(err, templatePath)}`
    );
  }
  try {
    return JSON.parse(raw) as CloudFormationTemplate;
  } catch (err) {
    throw new Error(
      `Failed to parse nested template at ${displayAssemblyPath(templatePath)}: ${describeFileReadFailure(err, templatePath)}`
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
  // Null-prototype, like every other nested-template index (issue
  // go-to-k/cdkd#3480): a logical id is a template key, so a `{}` literal drops
  // a row named `__proto__` through the inherited setter and answers a
  // never-indexed `toString` / `valueOf` with a prototype member.
  const result = nullPrototypeRecord<string>();
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (resource?.Type !== NESTED_STACK_RESOURCE_TYPE) continue;
    const meta = resource.Metadata as Record<string, unknown> | undefined;
    const assetPath = meta?.['aws:asset:path'];
    if (typeof assetPath !== 'string' || assetPath.length === 0) continue;
    if (isAbsoluteCrossPlatform(assetPath)) {
      // Sanitized for the reason this message itself gives: it fires only on a
      // hand-modified or non-CDK-generated assembly, so `logicalId` (a template
      // key) and `assetPath` (raw `Metadata`) are exactly the values an
      // attacker controls. The cycle refusal below cites this same threat model
      // as its reason to sanitize, so leaving its twin in the same walk raw
      // would be the inconsistency, not the fix.
      throw new Error(
        `Nested stack ${displayIdent(logicalId)} has ` +
          `Metadata['aws:asset:path']=${displayAssemblyPath(assetPath)} which is absolute. ` +
          `CDK emits relative asset paths for nested templates; an absolute path ` +
          `indicates the synth output was hand-modified or generated by a non-CDK toolchain. ` +
          `Refusing to load.`
      );
    }
    // The containment check `isAbsoluteCrossPlatform` is NOT (issue
    // go-to-k/cdkd#3489): `path.join` folds `..`, so an asset path of
    // `../../etc/passwd` resolved out of `dir` and was read and diffed as a
    // nested template. Both refusals stay and are worded apart, since the
    // absolute one still detects a non-CDK assembly on its own.
    const resolved = resolveAssemblyPath(dir, assetPath);
    if (!resolved.contained) {
      throw new Error(
        `Nested stack ${displayIdent(logicalId)} has ` +
          `Metadata['aws:asset:path']=${displayAssemblyPath(assetPath)} which ` +
          `${renderAssemblyPathEscape(resolved, dir)}`
      );
    }
    result[logicalId] = resolved.path;
  }
  return result;
}

/** Load a stack's cdkd state, or synthesize an empty record (→ all CREATE) when none exists. */
async function loadStateOrEmpty(
  stackName: string,
  region: string,
  stateBackend: S3StateBackend
): Promise<{ state: StackState; unreadable: string[]; deployRefusals: string[] }> {
  const result = await stateBackend.getState(stackName, region);
  if (result) {
    // What the repairs below take OUT of the record, returned beside it so the
    // node can report it (see `DiffTreeNode.unreadable`).
    const unreadable: string[] = [];
    // REPAIRED containers whose damage `cdkd deploy` REFUSES (go-to-k/cdkd#3335).
    // Separate from `unreadable`, which means "dropped from the diff": the
    // reader's question is different — not "did the diff read everything" but
    // "will the deploy this previews start at all" — so a DROPPED container
    // lands in both lists (go-to-k/cdkd#3512), and a repaired one previewed in
    // place in this one alone. They reach the node's `blocking`, so
    // `countBlocking` raises the exit-3 `DeployRefusalPreviewError` that
    // `cdkd diff` already spends on a refused adoption, ahead of `--fail`.
    //
    // Without this a record whose template declares nothing in the damaged
    // container has no delta, so `--fail` exited 0 and a CI step gating on it
    // passed over a record the next deploy stops on.
    const deployRefusals: string[] = [];
    if (repairMalformedResourcesForReadOnly(result.state)) {
      logger.warn(malformedResourcesWarning(stackName, region));
      // BOTH lists (go-to-k/cdkd#3512): the row says the diff dropped the bag,
      // which `--fail` counts, and the reason says the deploy refuses the
      // record (`refuseMalformedResourcesForDeploy`), which exit 3 reports —
      // including when the template declares nothing, where the empty bag
      // yields no change row at all.
      unreadable.push(UNREADABLE_RESOURCES_MAP_ROW);
      deployRefusals.push(DEPLOY_REFUSES_RESOURCES_BAG_REASON);
    }
    // go-to-k/cdkd#3018. The bag repair above is not the whole rule, and the
    // gap was invisible to the sweep that produced it: a file IMPORTING this
    // module reads as remedied, while `hasReadableResources` tests the BAG and
    // says nothing about an ENTRY. `{"resources": {"R": null}}` therefore
    // survived the repair and threw on `resource.resourceType` in the two
    // nested-child walks below (`buildDiffTree`, `buildDeletedSubtree`) — the
    // raw `TypeError` go-to-k/cdkd#3159 removed from this command's bag half.
    //
    // REPAIR and not refuse: `cdkd diff` never writes, which the refuse-vs-repair
    // fence in `tests/unit/state/malformed-resources-bag.test.ts` asserts of
    // both this file and `diff.ts` rather than leaving to argument.
    const dropped = repairMalformedResourceEntriesForReadOnly(result.state);
    if (dropped.length > 0) {
      logger.warn(malformedResourceEntriesWarning(stackName, region, dropped));
      // One at a time, never spread: `push(...ids)` passes each id as an
      // ARGUMENT and throws a bare `RangeError` past the engine's argument
      // limit — the orphan-row twin below records the measurement.
      for (const id of dropped) unreadable.push(id);
      // The same pair as the bag above (go-to-k/cdkd#3512): every entry this
      // drops is one `refuseMalformedResourceEntriesForDeploy` refuses the
      // record over — a `null` row and a typeless object alike, with or
      // without a torn `properties` map.
      deployRefusals.push(deployRefusesResourceEntriesReason(dropped));
    }
    // The same treatment one level DOWN, on each entry's `properties` bag
    // (go-to-k/cdkd#3191). A separate call rather than a widening of
    // `repairMalformedResourcesForReadOnly`, for the reason this file's
    // `outputs` note already gives: the containers are independent and a
    // record can be malformed in any one alone, so the warning must name the
    // one that is actually broken.
    //
    // Ordered AFTER the bag repair deliberately —
    // `repairMalformedResourcePropertiesForReadOnly` walks entries, and an
    // unreadable BAG has none to walk. And AFTER the entry drop above, which
    // is not order-free: an OBJECT entry with no `resourceType` and a torn
    // `properties` map satisfies BOTH predicates, so running this first would
    // warn that its properties preview as additions and then drop the row
    // that warning describes. Fenced in
    // `tests/unit/cli/diff-recursive-malformed-properties.test.ts`.
    //
    // This call is what keeps `cdkd diff` on the read-only side of the split:
    // the same defect REFUSES inside `DiffCalculator.calculateDiff`, which
    // both `cdkd deploy` paths reach. `cdkd diff` persists nothing, so it
    // previews the record and says how the preview is wrong instead.
    const unreadableProps = repairMalformedResourcePropertiesForReadOnly(result.state);
    if (unreadableProps.length > 0) {
      logger.warn(malformedResourcePropertiesWarning(stackName, region, unreadableProps));
      deployRefusals.push(deployRefusesPropertiesReason(unreadableProps));
    }
    // The SAME treatment for the `outputs` BAG (go-to-k/cdkd#3189). Every
    // consumer of that bag below this line takes it from
    // `currentState.outputs` — the resolver's stored-key lookups,
    // `mergeNoChangeOutputs`'s `persisted`, and `computeOutputsDiff`'s two
    // walks — so one call here dominates the bag, which is the placement rule
    // `src/state/malformed-resources-bag.ts`'s header records.
    //
    // Scoped to the BAG, deliberately, and still is: the Outputs flow also
    // reads `state.exportNames`, which this call does not touch. That half is
    // now guarded where it is READ rather than here —
    // `importableOutputKeys` (`src/types/state.ts`) used to call
    // `state.exportNames.filter(...)` unconditionally and threw a raw
    // `TypeError` from the `mergeNoChangeOutputs` call below on a hand-edited
    // non-array; it reads a non-array as an EMPTY export set now
    // (go-to-k/cdkd#3192). A guard here could not have covered it in any case:
    // that helper is reached from the exports index, the deploy-time resolver
    // and the local-command loader, none of which passes through this load.
    //
    // Separate warnings rather than one: they name different containers with
    // different consequences, and a record can be malformed in any one alone.
    if (repairMalformedOutputsForReadOnly(result.state)) {
      logger.warn(malformedOutputsWarning(stackName, region));
      deployRefusals.push(DEPLOY_REFUSES_OUTPUTS_REASON);
    }
    // The `orphans` CONTAINER, decided the same way and reported separately
    // (go-to-k/cdkd#3379). AT THE LOAD rather than at the adoption preview: the
    // preview is gated on `currentState.orphans?.length`, and for a STRING that
    // gate PASSES — `'abc'.length` is 3 — so the walk below it would render one
    // adoption row per character.
    if (repairMalformedOrphansForReadOnly(result.state)) {
      logger.warn(malformedOrphansWarning(stackName, region));
      unreadable.push(UNREADABLE_ORPHANS_CONTAINER_ROW);
      // `refuseMalformedOrphans` refuses the deploy over it (go-to-k/cdkd#3512).
      deployRefusals.push(DEPLOY_REFUSES_ORPHANS_CONTAINER_REASON);
    }
    // The `exportNames` FIELD, said out loud (go-to-k/cdkd#3192 review). The
    // predicate fails closed wherever it is read, which is right — it serves
    // five commands and holds no stack identity — but a LOUD wrong answer
    // (the raw `TypeError` this replaced) becoming a QUIET one is its own
    // regression, and this load is the one place that can name the record.
    //
    // AFTER the bag repair, deliberately: `hasReadableExportSet` also requires
    // a readable `outputs`, so asking it first would blame `exportNames` for a
    // damaged BAG. By here the bag is `{}` — readable — so a false verdict
    // isolates the field, and a record damaged in both containers gets one
    // accurate line about each rather than two about the same thing.
    // The `isReadableBag` conjunct is what keeps this about `exportNames`.
    // `hasReadableExportSet` requires a readable BAG too, and the repair above
    // exempts an ABSENT one — a record cdkd itself writes — so without this a
    // perfectly ordinary no-outputs record drew a line blaming its
    // `exportNames`. The guard is watched from BOTH directions: dropping this
    // conjunct reds the absent-bag floor one describe up, and disabling the
    // whole line reds the four damaged-shape cases that assert the warning
    // FIRES. Until review round 10 only the first direction was covered, so
    // `if (false)` here was a zero-red mutation.
    if (isReadableBag(result.state.outputs) && !hasReadableExportSet(result.state)) {
      logger.warn(malformedExportNamesWarning(stackName, region));
    }
    return { state: result.state, unreadable, deployRefusals };
  }
  return {
    state: {
      stackName,
      region,
      resources: {},
      outputs: {},
      version: STATE_SCHEMA_VERSION_CURRENT,
      lastModified: Date.now(),
    },
    unreadable: [],
    deployRefusals: [],
  };
}

/** What one stack's diff yields: its per-resource changes plus its Outputs delta. */
export interface StackDiffResult {
  /** Per-resource changes, including `NO_CHANGE` entries. */
  changes: Map<string, ResourceChange>;
  /** Per-key Outputs changes (issue #1921); empty when unchanged or unresolvable. */
  outputChanges: OutputChange[];
  /**
   * Logical ids this diff treated as ALREADY IN STATE because a rollback
   * orphan record was verified and spliced in (issue go-to-k/cdkd#2943).
   *
   * The rows for these are ordinary UPDATE / NO_CHANGE rows — the splice is
   * what makes them so — and carry an annotation, because a user who last saw
   * this resource fail and drop out of state would otherwise read the update
   * as cdkd having silently kept it.
   */
  adoptedOrphans: string[];
  /**
   * The adopted records themselves, keyed by logical id (issue
   * go-to-k/cdkd#2943).
   *
   * Returned alongside the names because `buildDiffTree` has two consumers
   * that read `resources` AFTER the diff and must see the same state the diff
   * saw: `collectCcApiRoutes` reads `provisionedBy` for the sticky-CC
   * annotation, and `resolveChildStackParameters` resolves a nested child's
   * `Parameters` against the parent's records. Handing them the un-spliced
   * state made an adopted `cc-api` row print without its routing annotation
   * and made a child parameter referencing an adopted resource drop silently.
   */
  adoptedRecords: Record<string, ResourceState>;
  /**
   * Reasons `cdkd deploy` would REFUSE, in its own words (issue
   * go-to-k/cdkd#2943). Non-empty means the deploy this preview describes
   * cannot start at all.
   *
   * Carried rather than thrown: `deploy` stops at the refusal because there is
   * nothing left to do, while a preview that dies before printing is a preview
   * that cannot be used to decide anything. So `cdkd diff` renders everything
   * it learned and reports these at the end.
   */
  blocking: string[];
  /**
   * Deploy refusals this node's ADOPTED records carry (go-to-k/cdkd#3335): a
   * spliced rollback-orphan record whose `properties` map this diff repaired
   * and `cdkd deploy` refuses. Separate from `blocking` because it is
   * TOP-LEVEL only — see `buildDiffTree`, which is where the gate lives.
   */
  deployRefusals: string[];
  /**
   * Rollback-orphan records (`orphans[]`) the adoption preview could not read
   * as a resource, dropped BEFORE the preview because it throws on one, and
   * carried here so `buildDiffTree` can append them to the node's
   * `unreadable` — `''` for a record with no string `logicalId`. Empty when the
   * stack holds no orphan records or no preview was supplied.
   */
  unreadableOrphans: string[];
}

/**
 * The value a TOKEN-valued child parameter must be COMPARED as, given its
 * declared `Type` (issue [#2327](https://github.com/go-to-k/cdkd/issues/2327)).
 *
 * `resolveChildStackParameters` sets `skipDynamicReferences`, so a
 * secret-bearing nested input reaches this diff as its unresolved
 * `{{resolve:...}}` expression rather than as the value the deploy will bind.
 * The comparison therefore has to reproduce the SHAPE the child's state holds
 * for that parameter, and the shape depends on the declared type:
 *
 * - `String`, and the AWS-specific SCALAR types — state holds the expression
 *   STRING. Keep the token.
 * - The LIST-SHAPED types — whatever `isListParameterType` accepts, i.e. any
 *   `List<...>` type or `CommaDelimitedList` (`List<AWS::EC2::Subnet::Id>`,
 *   `List<String>`, … are examples, NOT the population) — the deploy's own
 *   `coerceParameterValue` split the RESOLVED value on `,` before redaction,
 *   so state holds an ARRAY of expressions. Splitting the TOKEN the same way
 *   reproduces it, because the reference this fixture-shaped case is about
 *   carries no comma.
 * - `Number` / `List<Number>` — coercion produces `NaN`, which matches neither
 *   side. Keep the token. (A deploy that actually bound a secret to one of
 *   these is refused by `refuseCoercedInheritedSecret`, so there is no state to
 *   agree with anyway.)
 *
 * THE LINE IS NOT A TYPE NAME, IT IS WHETHER EVERY PART SURVIVED AS A STRING.
 * That is the only property this comparison needs, and it is why the code below
 * asks the coerced VALUE rather than the declared type. `List<Number>` is the
 * single list-shaped type that fails it, because its elements are numbers; every
 * other list-shaped type yields trimmed strings and is therefore split here.
 *
 * An earlier revision of this comment said `CommaDelimitedList` was the ONLY
 * splitting type that keeps its parts strings, and singled `List<String>` out as
 * reading like it belonged beside it while coming back as an unchanged STRING.
 * That was a true reading of `coerceParameterTypedValue` at the time -- its
 * `switch` named only `Number`, `List<Number>` and `CommaDelimitedList`, so every
 * other `List<...>` spelling fell to `default` -- and it was ALSO the bug, filed
 * as issue [#2347](https://github.com/go-to-k/cdkd/issues/2347) and since fixed:
 * the coercion now asks the shared `isListParameterType`
 * (`src/utils/parameter-types.ts`), so the whole `List<...>` family splits.
 * The note survives because the shape of the mistake is worth keeping: the claim
 * was measured against the coercion and was accurate about it, and the coercion
 * was the thing that was wrong. Measuring the right function does not make the
 * function right.
 *
 * This function needed no change for that fix, which is the point of deriving
 * rather than enumerating: it never named the splitting types, so widening them
 * moved it automatically.
 *
 * WHAT "carries no comma" DOES AND DOES NOT COVER. It is verified for the slots
 * that vary in practice -- secret id / parameter name and version stage -- and
 * NOT for the JSON-KEY slot, which may contain one:
 * `{{resolve:secretsmanager:sec:SecretString:a,b::}}` splits into TWO elements
 * (measured). The consequence is bounded to THIS function: a `cdkd diff
 * --recursive` over such a parameter reports a phantom change, because the
 * desired side has two elements where state has one. No write path is reached
 * -- the persist side never consults this -- and no plaintext is exposed. It is
 * not closed here because the fix belongs with a comma-aware split of the
 * expression grammar rather than with a comparison shim.
 *
 * MEASURED FROM THE REAL COERCION, never enumerated beside it — the same
 * discipline {@link parameterTypeMayLoseSecretIdentity} adopted after a
 * hand-kept type list was found wrong about one of its own three entries. The
 * test is what the coercion PRODUCED: an unchanged value, a non-array, or an
 * array carrying a non-string all keep the token, so a `Type` added to
 * `coerceParameterTypedValue` is covered the day it is added.
 */
function tokenValueForComparison(token: unknown, declaredType: string | undefined): unknown {
  if (typeof token !== 'string' || declaredType === undefined) return token;
  const coerced = coerceParameterTypedValue(token, declaredType);
  // `String` and every unrecognised type: the coercion is the identity.
  if (coerced === token) return token;
  // `Number`: a scalar that is no longer the token.
  if (!Array.isArray(coerced)) return token;
  // `List<Number>`: an array whose elements are no longer the token's text.
  if (!coerced.every((element) => typeof element === 'string')) return token;
  return coerced;
}

/**
 * Compute the per-resource diff for one stack: `currentState` (cdkd state)
 * vs `template` (synth desired state), with a best-effort intrinsic
 * resolver so changes buried inside intrinsics (e.g. `Fn::Join` literal
 * args) are detected against resolved values in state.
 *
 * Also computes the `Outputs` delta (issue #1921) — an Outputs-only change has
 * a byte-identical `Resources` section, so without it such a stack previews as
 * "No changes detected" while the apply persists new outputs and republishes
 * the exports index.
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
  diffCalculator: DiffCalculator,
  /**
   * The optional knobs, as ONE object rather than four trailing positionals
   * (issue #1926 review): the fourth arrival pushed this to ten parameters and
   * made `buildDeletedSubtree` pad with three `undefined`s to reach the one it
   * needed, which is exactly the call shape a wrong-slot bug hides in.
   */
  options: {
    parameters?: Record<string, unknown>;
    /**
     * Same per-type normalization the deploy engine applies (issue #1591).
     * Without it `cdkd diff` forecasts a change `cdkd deploy` will never make —
     * the preview and the apply must narrow identically.
     */
    canonicalizeProperties?: CanonicalizePropertiesFn;
    /**
     * `--no-cfn-fallback` (issue #1697): false disables the resolver's
     * CloudFormation fallback for cross-stack references, mirroring the
     * deploy engine's option so preview and apply resolve identically.
     */
    cfnFallback?: boolean;
    /**
     * Force the issue #1948 "stored key the template cannot account for"
     * withholding ON, regardless of what THIS template proves.
     *
     * Exactly one caller needs it and the reason is structural: a DELETED nested
     * child is diffed against an EMPTY template, so `templateHasSecretReference`
     * is false, `declaredKeys` and `desired` are empty, and NONE of the three
     * withholding arms can fire — a pre-GHSA child's whole stored bag would
     * render with values. The PARENT's template is the evidence available, and
     * `buildDeletedSubtree` passes it down.
     */
    inheritSecretBearingTemplate?: boolean;
    /**
     * Runs the SAME rollback-orphan pre-pass `cdkd deploy` runs, so the
     * preview predicts the deploy instead of reporting a CREATE the deploy
     * will not perform (issue go-to-k/cdkd#2943).
     *
     * Optional because it is the only thing on this path that calls a
     * PROVIDER: `cdkd diff` reaches AWS to resolve intrinsics, but until this
     * it never asked a provider whether a resource exists. Callers that cannot
     * afford that (or have no registry) omit it and get the pre-#2943
     * behaviour. The cost is zero when the state holds no records, which is
     * every stack that has not had a rollback orphan something.
     *
     * Receives the CONDITION-PRUNED template, matching
     * `DeployEngine.executeDeployment` — reading the raw template would
     * re-orphan a resource an `Fn::If` currently excludes.
     */
    previewOrphanAdoption?: (
      state: StackState,
      effectiveTemplate: CloudFormationTemplate,
      stackName: string,
      region: string
    ) => Promise<{ adopted: Record<string, ResourceState>; refusals: string[] }>;
  } = {}
): Promise<StackDiffResult> {
  const { parameters, canonicalizeProperties, cfnFallback, inheritSecretBearingTemplate } = options;
  const intrinsicResolver = new IntrinsicFunctionResolver(region, {
    cfnFallback: cfnFallback ?? true,
  });

  // Issue #2740: the source the skipped-output digests are compared against,
  // snapshotted HERE — before the parameter binding and condition evaluation
  // below, and before any resolution — at the same point of this flow as the
  // deploy engine's own snapshot, so the two digests agree. Taken as a deep
  // COPY so nothing downstream can make a resolved value visible to it; the
  // invariant and why it does not rest on any one resolver are in
  // `skipped-outputs.ts`. `Resources` is dropped: the digest never reads it.
  // The BINDING decision is made below, once the resource diff is in hand.
  const outputsDigestSource: CloudFormationTemplate = structuredClone({
    ...template,
    Resources: {},
  });

  // Mirror the deploy engine's parameter/condition preprocessing (steps
  // 2.5-2.7, issue #1027) so the diff matches what deploy will actually do.
  // Everything here is best-effort: a template whose parameters cannot be
  // bound (e.g. a required parameter with no default) falls back to the
  // pre-#1027 behavior — raw template, nested input parameters only — and
  // the calculator keeps unresolved intrinsics as-is.
  //
  // 1) Bind template `Parameters` (defaults + SSM-typed lookups). The
  //    nested-stack input parameters (see the resolver-context comment
  //    below) act as the user-provided values, exactly like
  //    `DeployEngineOptions.parameters` does on deploy.
  let mergedParameters: Record<string, unknown> | undefined = parameters;
  let parametersBound = false;
  // The names whose incoming value is a REDACTED `{{resolve:...}}` token rather
  // than the value the deploy will actually bind (issue #1903).
  // `resolveChildStackParameters` sets `skipDynamicReferences`, so a
  // secret-bearing nested input arrives here as its expression — which is right
  // for the COMPARISON (the child's state holds the expression too) and wrong
  // for anything that has to reason about the VALUE. Two such things live
  // below, and both are handled by knowing this set rather than by decrypting:
  //
  //  - `resolveParameters` COERCES by declared `Type`, so a `Type: Number`
  //    parameter fed a token becomes `NaN`, which then diffs against the real
  //    number in state on every run.
  //  - `evaluateConditions` compares it, so an `Fn::Equals` over a
  //    secret-valued parameter answers differently here than on deploy — where
  //    the deploy engine deliberately hands the CONDITION context the real
  //    values — and condition-gated child resources appear as phantom CREATEs
  //    or DELETEs.
  const tokenParameterNames = new Set(
    Object.entries(parameters ?? {})
      .filter(([, value]) => carriesDynamicReference(value))
      .map(([name]) => name)
  );
  // The deploy path REFUSES a token-valued child parameter whose declared
  // `Type` loses the plaintext under coercion -- asked of the coercion itself
  // via `parameterTypeMayLoseSecretIdentity`, never re-enumerated here. The
  // enumeration this replaced named `Number` / `List<Number>` and so stayed
  // silent on `CommaDelimitedList`, whose `,`-split shreds the dominant
  // Secrets Manager shape (a JSON blob) -- because coercing it drops the value
  // out of cdkd's string-keyed redaction model and the child's state.json would
  // keep the DECRYPTED secret (`refuseCoercedInheritedSecret`). `cdkd diff` is
  // best-effort by contract and must not hard-fail, so it says so instead —
  // otherwise the first the user hears of it is a failed deploy.
  for (const name of tokenParameterNames) {
    const declaredType = (template.Parameters?.[name] as { Type?: unknown } | undefined)?.Type;
    if (typeof declaredType === 'string' && parameterTypeMayLoseSecretIdentity(declaredType)) {
      logger.warn(
        `Stack ${displayStackName(stackName)}: parameter ${displayIdent(name)} is declared Type: ${displayIdent(declaredType)} and is fed ` +
          `a secret dynamic reference. 'cdkd deploy' refuses this when the coercion actually ` +
          `destroys the plaintext (a comma-bearing secret in a list-typed parameter) — declare ` +
          `it 'Type: String' — and this diff compares the unresolved reference, shaped by the ` +
          `declared type only where that keeps every part of it a string.`
      );
    }
  }
  try {
    const userParameters: Record<string, string> = {};
    for (const [name, value] of Object.entries(parameters ?? {})) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        userParameters[name] = String(value);
      }
    }
    const templateParameters = await intrinsicResolver.resolveParameters(template, userParameters);
    // `resolveParameters` output wins for template-declared parameters — it
    // carries the deploy-coerced values (a Number-typed nested input becomes
    // a number, like deploy) — while raw nested inputs survive for any name
    // the template does not declare.
    //
    // EXCEPT for a redacted token (see `tokenParameterNames`), which is bound to
    // the shape the CHILD'S STATE HOLDS for it -- see
    // {@link tokenValueForComparison}. An earlier revision kept the raw token
    // for EVERY such parameter and justified it as "exactly what the child's
    // state holds", which is true only for a SCALAR one; issue
    // [#2327](https://github.com/go-to-k/cdkd/issues/2327) measured that a
    // `CommaDelimitedList` parameter's state leaf is an ARRAY, so the raw token
    // compared a string against a list and reported a phantom change on every
    // run. An over-stated invariant in a comment is durable precisely because
    // it stops the next reader looking, which is why the correction is spelled
    // here rather than only in the helper.
    mergedParameters = { ...parameters, ...templateParameters };
    for (const name of tokenParameterNames) {
      const declaredType = (template.Parameters?.[name] as { Type?: unknown } | undefined)?.Type;
      mergedParameters[name] = tokenValueForComparison(
        (parameters ?? {})[name],
        typeof declaredType === 'string' ? declaredType : undefined
      );
    }
    parametersBound = true;
  } catch (error) {
    logger.debug(
      `Diff parameter binding for stack ${displayStackName(stackName)} is partial: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // 2) Evaluate `Conditions` and prune condition-false resources, so a
  //    condition-false resource is neither reported as "to create" nor
  //    diffed against state (matching deploy's `filterResourcesByCondition`
  //    step — a condition-false resource still in state correctly falls
  //    through to the DELETE path, exactly like deploy). ONLY when parameter
  //    binding succeeded: the resolver downgrades a condition it cannot
  //    evaluate (e.g. a Ref to the unbound parameter) to FALSE, so running
  //    this after a binding failure would prune condition-gated resources
  //    and report phantom DELETEs — the raw-template fallback must stay
  //    whole-template in that case.
  let effectiveTemplate = template;
  let conditions: Record<string, boolean> | undefined;
  // ALSO skipped when a CONDITION transitively references a redacted-token
  // parameter (issue #1903): the deploy engine evaluates its conditions against
  // the REAL parameter values, and this side does not have them and must not
  // fetch them. Rather than evaluate a condition on an expression string and
  // prune by the answer, fall back to the whole template — the SAME fallback
  // the `parametersBound` guard already takes, for the same reason (an
  // unreliable condition verdict prunes real resources and reports phantom
  // DELETEs).
  //
  // THE COST OF THE SKIP IS NOT MERELY "DIFFED RATHER THAN PRUNED", which is
  // what this comment used to claim. Leaving `conditions` undefined ALSO makes
  // `resolveIf` warn and take the FALSE branch for every `Fn::If` in every
  // property value, so a condition-true property diffs as a spurious UPDATE
  // (perpetual, and `--fail` exits 1) on top of the phantom CREATEs. That is
  // why the test is `conditionsDependOnTokenParameters` and not
  // `tokenParameterNames.size === 0`: the broad form fired whenever ANY
  // parameter was token-valued, including the common case where no condition
  // mentions one, and paid that price for nothing.
  if (parametersBound && !conditionsDependOnTokenParameters(template, tokenParameterNames)) {
    try {
      conditions = await intrinsicResolver.evaluateConditions({
        template,
        resources: currentState.resources,
        stateBackend,
        stackName,
        bestEffort: true,
        ...(mergedParameters && { parameters: mergedParameters }),
      });
      effectiveTemplate = new TemplateParser().filterResourcesByCondition(template, conditions);
    } catch (error) {
      logger.debug(
        `Diff condition evaluation for stack ${displayStackName(stackName)} skipped: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const resolveFn = (value: unknown): Promise<unknown> =>
    intrinsicResolver.resolve(value, {
      template: effectiveTemplate,
      resources: currentState.resources,
      stateBackend,
      stackName,
      // Diff resolution is best-effort (the calculator catches failures and
      // keeps the raw intrinsic): a Ref to a to-be-created resource is the
      // expected case here, so the resolver logs it at debug, not warn
      // (issue #1017).
      bestEffort: true,
      // Nested-stack children receive their input `Parameters` resolved
      // against the parent's deployed state (issue #555 follow-up). Without
      // this, a `Ref` to a synthesized nested-stack input parameter (e.g.
      // `referenceto<Parent>RootTopicName`) is neither a resource nor a
      // parameter in the diff context, so `resolveBestEffort` keeps the raw
      // intrinsic and the diff calculator reports a spurious UPDATE of every
      // property whose value derives from that parameter — even on a freshly
      // deployed tree. The deploy engine forwards exactly this resolved
      // parameter map to the child engine via `DeployEngineOptions.parameters`
      // (`NestedStackProvider.extractParameters`), so resolving here too makes
      // the recursive diff match what the deploy actually wrote to state.
      // Template-declared parameter defaults are merged in as well (issue
      // #1027) so `Ref` / `Fn::Sub` / `Fn::FindInMap` over parameters
      // resolve like they do on deploy.
      ...(mergedParameters && { parameters: mergedParameters }),
      // Evaluated conditions so `Fn::If` resolves in property values.
      ...(conditions && { conditions }),
      // Leave SECRET `{{resolve:...}}` dynamic references UNRESOLVED for diff
      // (GHSA fix): state stores the unresolved expression, so comparing the
      // desired side as its expression avoids a spurious perpetual change and
      // any live secret fetch that would print the plaintext. As on the deploy
      // engine's twin, an `ssm` reference is classified by the parameter's TYPE
      // rather than its spelling (issue #1901), so a not-yet-classified one
      // still costs one `GetParameter` here — issued with
      // `WithDecryption: false`, so a `SecureString` never yields plaintext.
      skipDynamicReferences: true,
    });
  // Rollback-orphan adoption, in the deploy's position: after condition
  // pruning, before the diff. `DiffCalculator` decides CREATE by ABSENCE from
  // state, so splicing a verified record in is the whole mechanism — there is
  // no new change type on either side.
  //
  // COPIED, never mutated in place: `DeployEngine` writes through its own
  // `currentState` because it goes on to deploy from it, while this function's
  // doc promises it only reads.
  //
  // An earlier version of this comment cited `collectCcApiRoutes` and
  // `resolveChildStackParameters` as the REASON for copying. That had the
  // argument backwards — those two are exactly the consumers that need to see
  // the spliced records, and handing them the un-spliced state starved them.
  // They are served by `adoptedRecords` below, which the caller merges.
  let adoptedOrphans: string[] = [];
  let adoptedRecords: Record<string, ResourceState> = {};
  let blocking: string[] = [];
  // go-to-k/cdkd#3335's reasons from the splice below, kept apart from
  // `blocking` so the caller can apply the top-level gate to them.
  const deployRefusals: string[] = [];
  let stateForDiff = currentState;
  // Joins the node's `unreadable` beside the load's dropped rows, for the
  // reason `DiffTreeNode.unreadable` gives: a torn orphan record used to ABORT
  // this command, and a run that now warns and exits 0 under `--fail` would
  // read as clean over exactly the record that used to crash it.
  const unreadableOrphans: string[] = [];
  if (currentState.orphans?.length && options.previewOrphanAdoption) {
    // The ENTRY half of the second pass below, and unlike that one it must run
    // BEFORE the preview rather than after it. `planOrphanAdoption` destructures
    // each record and routes a provider by `state.resourceType`; the `catch`
    // that guards that call names the same field AGAIN, so a record whose
    // `state` is `null` — or a primitive record, whose `state` destructures to
    // `undefined` — throws a TypeError straight OUT of the catch, and a `null`
    // record throws at the destructure before any `try`. Either aborts
    // `cdkd diff` — go-to-k/cdkd#3018's class, on the command a
    // user runs to inspect a record they already suspect. Repairing after the
    // preview cannot help: the throw happens inside it.
    //
    // `orphans` is its own container and `parseStateBody` does not validate it,
    // so neither the load's bag repair nor its entry repair has ever seen these
    // records. A record whose `logicalId` is not a string renders through
    // `displayLogicalId`'s existing `<unrenderable>` stand-in rather than a new
    // literal, which would re-open go-to-k/cdkd#3339's ambiguity.
    // The verdict comes from the module rather than a local re-spelling
    // (go-to-k/cdkd#3500). The local test asked only about `state`, so a row with
    // a healthy `state` and a non-string `logicalId` previewed as an adoption
    // here while every writer now refuses it.
    //
    // The PREVIEWABLE half, not the writers' full predicate: a row whose
    // `properties` map is torn stays, because `computeStackDiff` repairs and
    // names THAT below (only `properties` — the later pass does not touch
    // `attributes`). Dropping it here would retire a report `docs/cli-diff.md`
    // and `.claude/rules/state-malformed-properties.md` both describe.
    // Pushed one at a time, never spread: `push(...ids)` passes each element as an
    // ARGUMENT, so a record holding ~130k unusable rows aborts `cdkd diff` with a
    // bare `RangeError` naming no field, container or stack — on the command a
    // user runs BECAUSE the record is suspect (go-to-k/cdkd#3500 security review;
    // measured 100k OK, 130k over). The pre-image pushed per row and was immune.
    //
    // Rows SHARING a string `logicalId` are DROPPED here too, every one of them
    // (go-to-k/cdkd#3643) — both helpers below carry that list-level check, which
    // the per-row predicate cannot make. Dropped rather than kept-and-warned so
    // the preview never hands `planOrphanAdoption` two rows it would key onto one
    // adoption, and so `--fail` still predicts the deploy: a dropped row joins the
    // node's `unreadable`, which `--fail` counts, and the deploy refuses the
    // record over the same rows. Keeping them would preview one adoption for two
    // resources, which is the collapse the writers refuse.
    for (const id of unpreviewableOrphanRecords(currentState)) unreadableOrphans.push(id);
    const readableOrphans = previewableOrphanRecords(currentState);
    if (unreadableOrphans.length > 0) {
      // `false`: this command took the PREVIEWABLE predicate, so the diagnosis
      // must not name a torn map as a reason a row was dropped here.
      logger.warn(malformedOrphanRecordsWarning(stackName, region, unreadableOrphans, false));
      // Every row dropped here is one `refuseMalformedOrphanRecords` refuses
      // the deploy over — the previewable predicate is the NARROWER half of
      // that one — so it is a reason as well as an `unreadable` row
      // (go-to-k/cdkd#3512). Disjoint from the kept-row reason below: that arm
      // walks `readableOrphans`, which excludes every row named here.
      deployRefusals.push(deployRefusesDroppedOrphanRowsReason(unreadableOrphans));
    }
    // Names the `tornAdopted` arm below reports, so the arm after it does not say
    // the same thing about the same row twice (see that arm for why).
    let reportedByTheAdoptedPropertiesArm: readonly string[] = [];
    const plan = await options.previewOrphanAdoption(
      { ...currentState, orphans: readableOrphans },
      effectiveTemplate,
      stackName,
      region
    );
    adoptedOrphans = Object.keys(plan.adopted);
    adoptedRecords = plan.adopted;
    blocking = plan.refusals;
    if (adoptedOrphans.length > 0) {
      stateForDiff = {
        ...currentState,
        resources: { ...currentState.resources, ...plan.adopted },
      };
      // A SECOND properties repair, because this splice is the one place a
      // record enters the diff that `loadStateOrEmpty` never walked
      // (go-to-k/cdkd#3191 review). `planOrphanAdoption` builds each adopted
      // entry from `state.orphans[].state` verbatim, and that container is
      // outside the resource bag the load repaired — so a torn
      // `orphans[].state.properties` reached `calculateDiff` unguarded and
      // ABORTED `cdkd diff` with the deploy's refusal, on the command a user
      // runs precisely to inspect a record they already suspect.
      //
      // Scoped INSIDE this branch on purpose: with no adoption there is
      // nothing here the load did not already see, and running it
      // unconditionally would walk every entry a second time to find nothing.
      // The mutation lands on `plan.adopted`'s own records, never on
      // `state.orphans`, so the stored evidence survives for `cdkd state show`.
      const tornAdopted = repairMalformedResourcePropertiesForReadOnly(stateForDiff);
      reportedByTheAdoptedPropertiesArm = tornAdopted;
      if (tornAdopted.length > 0) {
        logger.warn(malformedResourcePropertiesWarning(stackName, region, tornAdopted));
        // The same deploy refusal the load's arm reports (go-to-k/cdkd#3335),
        // and it belongs here rather than beside the load because these
        // records never passed through it.
        //
        // Returned SEPARATELY from `blocking` rather than appended to it: this
        // function runs for every node, and the refusal is TOP-LEVEL only for
        // the reason `buildDiffTree` gives — appending here would exit 3 over a
        // nested child the deploy never diffs, which is the guarantee this
        // scope decision makes. `plan.refusals` is left where it is rather
        // than moved under the same gate — not because a refused adoption
        // reaches the deploy on an unchanged child (it does not; that child is
        // skipped there too), but because it predates this issue and narrowing
        // it is a change to go-to-k/cdkd#2943's contract, not to this one.
        deployRefusals.push(deployRefusesPropertiesReason(tornAdopted));
      }
    }

    // The OTHER half of KEEPING a row the writers refuse (go-to-k/cdkd#3641,
    // maintainer item M1). The two predicates disagree on one class — a torn
    // `properties` or `attributes` map — and keeping such a row is right: the arm
    // above names a torn `properties` map on an ADOPTED record. What was missing
    // is the deploy's verdict: `cdkd deploy` refuses the whole record over that
    // same row, so a preview that keeps the row and says nothing lets
    // `cdkd diff --fail` exit 0 and the deploy the operator runs next refuse. The
    // shapes that were NOT already refused at deploy are a torn `attributes` map
    // and a torn `properties` map on a row the adoption did not take — an ADOPTED
    // torn-`properties` row reached the deploy's refusal through `calculateDiff`
    // before this lane (go-to-k/cdkd#3641 item o5), which is why the arm above
    // reports it and this one subtracts it.
    //
    // Which rows: the ones the preview KEPT that the writers' per-row predicate
    // rejects. That predicate alone is enough HERE, and only here, because its
    // one blind spot — rows sharing a `logicalId` (go-to-k/cdkd#3643) — was
    // dropped from `readableOrphans` above.
    //
    // MINUS what the arm above already reported, which is the half a first cut
    // got wrong: for an adopted torn-`properties` row that arm already says the
    // deploy refuses the record, so a second reason is the same sentence about the
    // same row and it broke go-to-k/cdkd#3335's count contract (measured: that
    // fence pins `countBlocking` at 1 for exactly this shape, and the duplicate
    // made it 2). What this arm is FOR is the two cases nothing else covers: a
    // torn `attributes` map, which no pass repairs or names, and a torn
    // `properties` map on a row the adoption did NOT take — the likelier case,
    // since the deploy refuses before it would adopt anything.
    //
    // The exclusion is BY NAME, and that is exact here: every row in
    // `readableOrphans` carries a string `logicalId` no other row carries, since
    // rows sharing one were dropped above (go-to-k/cdkd#3643).
    const alreadyReported = new Set(reportedByTheAdoptedPropertiesArm);
    const previewedRowsTheDeployRefuses = readableOrphans
      .filter((record) => !isReadableOrphanRecord(record))
      .map((record) => (record as { logicalId: string }).logicalId)
      .filter((logicalId) => !alreadyReported.has(logicalId));
    if (previewedRowsTheDeployRefuses.length > 0) {
      // The WARNING fires at every node THIS RUN REACHES with an adoption preview
      // — a plain run visits no child, and a state-only child being DELETED is
      // built without the preview — while the exit-3 reason is top-level only
      // (go-to-k/cdkd#3641 round 2). That split is go-to-k/cdkd#3335's and it is
      // right — the deploy skips an unchanged nested-stack row, so a reason there
      // would report a refusal over a deploy that succeeds — but it is only SAFE
      // because every other class still warns at every node. This one did not:
      // the row is KEPT, so the drop warning above never speaks for it, and a
      // changed nested child printed nothing while its own deploy refused.
      logger.warn(malformedOrphanRowsKeptWarning(stackName, region, previewedRowsTheDeployRefuses));
      deployRefusals.push(deployRefusesOrphanRowsReason(previewedRowsTheDeployRefuses));
    }
  }

  const changes = await diffCalculator.calculateDiff(
    stateForDiff,
    effectiveTemplate,
    resolveFn,
    canonicalizeProperties
  );

  // Issue #1921: the Outputs section, resolved through the SAME resolver /
  // conditions the resource diff just used. Resolving here rather than in a
  // second pass matters — parameter binding and condition evaluation can issue
  // SSM calls, and a separate entry point would pay for them twice.
  //
  // `effectiveTemplate` mirrors the deploy engine's no-change branch. Condition
  // pruning only rewrites `Resources`, so its `Outputs` are the raw template's.
  // `currentState.outputs` is passed for ONE decision inside the resolver — the
  // LITERAL `Export.Name` of a secret-bearing stack, which the preview cannot
  // evaluate deploy's predicate for but state can answer (issue #1942): the bag
  // holding that alias key proves a previous deploy published it. See the
  // resolver's own note for the different-value / absent-key rows.
  // `bindingSkipped` (issue #2740) is what lets the preview agree with a
  // deploy that SKIPPED an output whose failure happens inside a secret lookup
  // this resolver never makes; see the resolver's doc. Decided HERE rather
  // than beside the snapshot because it needs `changes`: an output referencing
  // a resource this deploy will touch must NOT bind — the deploy would take
  // the changed-resources path, re-resolve every output, and publish the row
  // (and its `Export.Name`) the record would otherwise have hidden.
  const changedLogicalIds = new Set(
    [...changes.values()].filter((c) => c.changeType !== 'NO_CHANGE').map((c) => c.logicalId)
  );
  const bindingSkipped = bindingSkippedOutputs(
    outputsDigestSource,
    currentState.skippedOutputs,
    changedLogicalIds
  );
  const resolved = await resolveTemplateOutputs(
    effectiveTemplate,
    resolveFn,
    conditions,
    currentState.outputs,
    bindingSkipped
  );
  const templateHasSecretReference =
    resolved.templateHasSecretReference || inheritSecretBearingTemplate === true;
  const diffOutputsAgainst = (
    desired: Record<string, unknown>,
    exportNames: ReadonlySet<string>,
    forceLegacyRecord = false
  ): OutputChange[] =>
    computeOutputsDiff(currentState.outputs, desired, exportNames, resolved.secretSourceKeys, {
      declaredKeys: resolved.declaredKeys,
      templateHasSecretReference,
      forceLegacyRecord,
    });

  // A partially-resolved bag previews the deploy's NO-CHANGE merge when the
  // deploy will take that branch, and reports NO delta otherwise.
  //
  // The merge (issue #3101). With no resource change the deploy persists what
  // resolved and keeps each failed key's stored value (go-to-k/cdkd#2771), so a
  // sibling output added or changed beside a broken one IS written, and
  // suppressing it here let `--fail` exit 0 for a change the deploy makes. The
  // preview runs the deploy's own `mergeNoChangeOutputs` rather than a copy,
  // and only when `failuresMirrorDeploy` holds: every failure is one the deploy
  // records too (a throw, or `undefined`), named by output key.
  // `hasChanges` is the same predicate the deploy branches on.
  //
  // It also needs parameters that bound, and a template in which no condition
  // verdict can reach an output (`templateLetsConditionsReachOutputs`, whose
  // doc derives the routes). Conditions are evaluated best-effort here, so a
  // verdict can differ from the deploy's (a malformed `Fn::Sub` inside
  // `Fn::Equals` keeps its placeholder here and throws at deploy). The test is
  // not "declares no `Conditions`": every env-agnostic CDK app declares
  // `CDKMetadataAvailable` for its metadata resource alone. `conditions` stays
  // undefined when parameter binding failed, where a `Ref` to the unbound
  // parameter fails here and resolves at deploy. Both are shapes where the
  // preview KNOWS its resolution differs, so it keeps the suppression there.
  //
  // Everywhere the merge does run, a failure can still depend on something only
  // the deploy has: a secret this diff never fetches, used as a mapping key,
  // throws here and resolves at deploy, and the routes to such information are
  // not enumerable. So the preview never claims a failed output is unchanged:
  // it compares each one that has a stored value at that value, leaves the rest
  // out of the comparison, and a warning names both groups.
  //
  // The deploy runs the mixed-generation refusal TWICE: inside the merge, which
  // this preview shares, and again on the bag as its save redacts it
  // (`deploy-engine.ts`, after the observed-capture drain). The second check is
  // not reproduced here, and it CAN answer differently. This preview's own bag
  // never gains a late expression (it drains no captures and resolves with
  // `skipDynamicReferences`), but the DEPLOY's can: a secret recorded during
  // its drain whose plaintext equals a resolved literal output redacts that
  // output into an expression and turns `merged` into `kept`, the behaviour
  // `deploy-engine-outputs-only-change.test.ts` pins. What the deploy then
  // writes depends on the values: a row this preview showed may not be
  // written, and a late needle matching a STORED value makes the save redact
  // that value in whichever bag it keeps, a rewrite no diff path previews,
  // merge or not. `--strict-getatt` also departs from the preview: an output
  // whose resolution throws aborts the deploy instead of reaching the merge
  // (one that resolves to `undefined` still reaches it).
  //
  // The suppression, everywhere else. With a resource change pending an output
  // usually fails because it references a resource this deploy has yet to
  // create — that CREATE is already on the resource side — and this preview
  // cannot tell it from an output that will fail again. Deploy's
  // changed-resources branch has no gate at all, correctly, because by then
  // every resource exists. Since issue #2740 a key the last deploy skipped is
  // dropped before this point and never sets the flag — but only while its
  // record still BINDS (digest unchanged, the key still absent from state, no
  // referenced resource changing this run). Fail any of those and the key
  // resolves here like any other.
  let outputChanges: OutputChange[] = [];
  if (!resolved.resolutionFailed) {
    outputChanges = diffOutputsAgainst(resolved.outputs, resolved.exportNames);
  } else {
    const resourcesChange = diffCalculator.hasChanges(changes);
    const merge =
      resolved.failuresMirrorDeploy &&
      conditions !== undefined &&
      !templateLetsConditionsReachOutputs(template) &&
      !resourcesChange
        ? mergeNoChangeOutputs({
            persisted: currentState.outputs ?? {},
            resolved: withFailedOutputsUndefined(resolved.outputs, resolved.failedOutputKeys),
            declaredOutputs: effectiveTemplate.Outputs,
            previousExportNames: new Set(importableOutputKeys(currentState)),
            resolvedExportNames: [...resolved.exportNames],
          })
        : undefined;
    if (merge?.kind === 'merged') {
      // A carried key is compared at its STORED value, which erases evidence only
      // its resolved value held: an output that resolves to a secret expression
      // (an `Fn::GetAtt` to an attribute the record stores as one) marks a
      // pre-GHSA record through `desired`, and its carried plaintext does not.
      // Where such an expression can come from (a stored attribute, a parameter,
      // another stack's outputs) is not enumerable, so no test of the template
      // stands in for it; and a secret expression stored under another key does
      // not exonerate either, since pass 1 of `computeOutputsDiff` excuses only
      // the key that holds one. So the record is treated as legacy, and every
      // stored value on a rendered row withheld, whenever a carried key's stored
      // value is anything but a secret expression: the one value pass 1 would
      // have excused for that key.
      const storedOutputs = currentState.outputs ?? {};
      const withheld = merge.carriedKeys.some(
        (key) => !isSecretBearingReferenceString(storedOutputs[key])
      );
      outputChanges = diffOutputsAgainst(merge.outputs, new Set(merge.exportNames), withheld);
      // Every failure on this path is named (`failuresMirrorDeploy`), so the set
      // holds every output this pass FAILED. A key a binding #2740 record skipped
      // never reached resolution and is not in it: that record previews the key
      // as absent on every diff path, merge or not, as it documents.
      //
      // The #1948 residual `computeOutputsDiff` documents (a stack that deletes
      // its ONLY secret-bearing output prints that output's stored value as a
      // REMOVE row's `old:` side) reaches a RENDERED section on this path, where
      // the suppression used to hide it, only when every carried key's stored
      // value is a secret expression; otherwise the forced verdict above
      // withholds that row's value too.
      //
      // The warning splits the failed outputs the way the merge carries OUTPUT
      // keys: one with a stored value under its own name is carried and compared
      // at it, one without is not (the merge reads `hasOwn(persisted, key)`). The
      // latter's literal `Export.Name` alias can still be carried on its own, so
      // the second group is named for what it lacks, not as left out entirely.
      //
      // The withheld-values sentence is gated on the RENDERED result: the forced
      // verdict redacts only non-ADD rows, so an ADD-only or empty section has
      // nothing withheld to explain. Its reason names what forced it, a value
      // carried from state (an output key OR an alias), not "a failed output
      // compared at a stored value", which an alias-only carry contradicts. The
      // stand-in alone advises `cdkd scrub`, which finds nothing on a stack that
      // holds no secret, hence the sentence.
      const failed = [...resolved.failedOutputKeys];
      const isStored = (key: string): boolean =>
        Object.prototype.hasOwnProperty.call(storedOutputs, key);
      const compared = failed.filter(isStored);
      const unstored = failed.filter((key) => !isStored(key));
      const names = (keys: string[]): string => keys.map(stripControlChars).join(', ');
      const explainWithheld =
        withheld && outputChanges.some((change) => change.oldValueRedacted === true);
      logger.warn(
        `Outputs of stack ${stripControlChars(stackName)}: ${failed.length} output(s) could not be resolved for this diff.` +
          (compared.length > 0 ? ` Compared at their stored values: ${names(compared)}.` : '') +
          (unstored.length > 0
            ? ` No stored value under their own names: ${names(unstored)}.`
            : '') +
          ` The next deploy may write a value for any of them it can resolve.` +
          (explainWithheld
            ? ` Previous values in this Outputs section are withheld because a value carried from state for a failed output is not a secret reference, so this diff cannot rule out legacy plaintext in state. That reason no longer applies once every failed output resolves, though other legacy-plaintext checks still can withhold them.`
            : '')
      );
    } else {
      // Surface the case where the outputs DID differ but a resolution failure
      // suppressed the report, mirroring the deploy engine's twin warning
      // ("Outputs changed but one or more could not be resolved"). Silence would
      // leave "no Outputs section" ambiguous between "unchanged" and "could not
      // be computed".
      //
      // The failed keys are excluded first, and that exclusion is what keeps the
      // warning meaningful. Unlike the deploy side — which keeps an unresolved key
      // with the value `undefined` — this resolver DROPS it, so a naive diff reads
      // every failed key as a REMOVE. Without the filter the warning would fire on
      // the ordinary, expected case the resolver itself logs at debug (an output
      // referencing a resource this deploy will create), including on the very
      // first diff of a stack.
      // Reached with a merge in hand only when it KEPT the previous bag whole,
      // which the deploy announces with its own warning; this one names the same
      // reason. Without one, "a resource this deploy has yet to create" is the
      // likely cause only while a resource change is pending: on a stack with
      // none, a gate above refused the preview instead.
      const wouldHaveChanged = diffOutputsAgainst(resolved.outputs, resolved.exportNames).filter(
        (change) => !resolved.failedKeys.has(change.name)
      );
      if (wouldHaveChanged.length > 0) {
        logger.warn(
          `Outputs of stack ${stripControlChars(stackName)} may have changed, but one or more could not be resolved ` +
            `against current state — omitting the Outputs section from this diff. ` +
            (merge?.kind === 'kept'
              ? keptWholeReasonText(merge.reason)
              : resourcesChange
                ? `It is usually an output referencing a resource this deploy has yet to create.`
                : `The stack has no resource change; this diff cannot preview what the deploy does with the outputs that failed here.`)
        );
      }
    }
  }

  return {
    changes,
    outputChanges,
    adoptedOrphans,
    adoptedRecords,
    blocking,
    unreadableOrphans,
    deployRefusals,
  };
}

/**
 * The preview's bag in the shape `mergeNoChangeOutputs` reads from the deploy
 * engine: each failed OUTPUT present with the value `undefined`
 * (issue #3101). This resolver drops a failed key while the deploy keeps it,
 * and the merge tells "failed, keep the stored value" from "not produced,
 * remove it" by exactly that presence. A fresh null-prototype bag, like both
 * bags it stands between, so a resolved `__proto__` export alias survives the
 * copy as a data key.
 */
function withFailedOutputsUndefined(
  outputs: Record<string, unknown>,
  failedOutputKeys: ReadonlySet<string>
): Record<string, unknown> {
  const bag = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(outputs)) bag[key] = value;
  for (const key of failedOutputKeys) bag[key] = undefined;
  return bag;
}

/**
 * Resolve a nested-stack child's input `Parameters` (declared on the parent's
 * `AWS::CloudFormation::Stack` row under `Properties.Parameters`) to scalar
 * values against the PARENT's deployed state + already-resolved parameters.
 *
 * This is the diff-time analogue of `NestedStackProvider.extractParameters`:
 * the deploy engine resolves these same `Parameters` against the parent's
 * resolver context and forwards the scalar map to the child engine as
 * `DeployEngineOptions.parameters`, so a `Ref` to a child input parameter
 * resolves at deploy time. The recursive diff must do the same or it reports
 * spurious changes on every freshly-deployed nested child whose property
 * derives from a passed-down parameter.
 *
 * Each value is resolved independently and best-effort: a value that cannot
 * be resolved (e.g. a `Ref` to a resource not yet in state) is dropped from
 * the map rather than forwarded as a raw intrinsic — leaving it out means the
 * child's `Ref` to that parameter falls through to the existing
 * intrinsic-vs-resolved comparison path (no behavior change for the
 * unresolvable case), while resolvable parameters (the freshly-deployed tree)
 * get exact scalar values.
 */
async function resolveChildStackParameters(
  parentStackRow: TemplateResource,
  parentTemplate: CloudFormationTemplate,
  parentState: StackState,
  region: string,
  parentStackName: string,
  stateBackend: S3StateBackend,
  parentParameters: Record<string, unknown> | undefined,
  cfnFallback?: boolean
): Promise<Record<string, unknown>> {
  const rawParams = parentStackRow.Properties?.['Parameters'];
  if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
    return {};
  }
  const resolver = new IntrinsicFunctionResolver(region, { cfnFallback: cfnFallback ?? true });
  const resolved: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rawParams as Record<string, unknown>)) {
    try {
      resolved[name] = await resolver.resolve(value, {
        template: parentTemplate,
        resources: parentState.resources,
        stateBackend,
        stackName: parentStackName,
        // Best-effort like computeStackDiff's resolver: an unresolvable
        // parameter is expected (caught + omitted below), not warn-worthy.
        bestEffort: true,
        ...(parentParameters && { parameters: parentParameters }),
        // Leave SECRET `{{resolve:...}}` dynamic references UNRESOLVED here
        // too (issue #1903). Without it `cdkd diff --recursive` DECRYPTED a
        // secret-bearing nested-stack input parameter at plan time and printed
        // the plaintext in the child's diff.
        //
        // This flag is only correct BECAUSE the deploy half landed with it:
        // `DeployEngineOptions.inheritedSecrets` now makes the child's
        // `state.json` hold the `{{resolve:...}}` expression rather than the
        // resolved value, so the desired side and the stored side are both
        // expressions. On its own it would have compared an expression against
        // a child state still holding plaintext and reported a spurious
        // perpetual change on every run — which is why the issue's two halves
        // could not be split.
        skipDynamicReferences: true,
      });
    } catch {
      // Unresolvable (e.g. references a not-yet-deployed resource): omit it so
      // the child diff falls back to the intrinsic-vs-resolved comparison.
    }
  }
  return resolved;
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
  /**
   * Rollback-orphan pre-pass, applied at EVERY node including nested children
   * (issue go-to-k/cdkd#2943) — `NestedStackProvider` runs a whole child
   * `DeployEngine` on the deploy path, so a child adopts there too, and a
   * preview that skipped children would diverge exactly where the deploy is
   * hardest to reason about. See `computeStackDiff`'s option of the same name.
   */
  previewOrphanAdoption?: (
    state: StackState,
    effectiveTemplate: CloudFormationTemplate,
    stackName: string,
    region: string
  ) => Promise<{ adopted: Record<string, ResourceState>; refusals: string[] }>;
  template: CloudFormationTemplate;
  nestedTemplates: Record<string, string>;
  recursive: boolean;
  stateBackend: S3StateBackend;
  diffCalculator: DiffCalculator;
  /**
   * Input `Parameters` for THIS node's template, already resolved to scalar
   * values against the parent's deployed state. Empty / undefined for the
   * top-level root (it takes no nested-stack input parameters). Threaded into
   * {@link computeStackDiff}'s resolver context so a `Ref` to a synthesized
   * nested-stack parameter resolves instead of surfacing as spurious drift.
   */
  parameters?: Record<string, unknown>;
  /**
   * Per-type property normalization shared with the deploy engine (issue
   * #1591). Threaded through the whole tree so a nested child's preview
   * narrows exactly like its apply.
   */
  canonicalizeProperties?: CanonicalizePropertiesFn;
  /**
   * Issue #1002 PR 2 — §6 asset-location mapping table, present when the
   * stack's region is in cdkd-assets mode. Every nested child template read
   * by this walker gets the §7 rewrite applied (nested templates bypass the
   * top-level rewrite in `diff.ts`), so the recursive diff previews the same
   * repointing the deploy will perform. The ROOT template is expected to be
   * rewritten by the caller before this is invoked.
   */
  assetRedirect?: AssetRedirectMap;
  /**
   * `--no-cfn-fallback` (issue #1697): false disables the CloudFormation
   * fallback for cross-stack references in every resolver this walker
   * constructs (per-stack diff + child-parameter resolution), mirroring
   * the deploy engine's option. Default (undefined) = fallback enabled.
   */
  cfnFallback?: boolean;
  /**
   * Does any template ABOVE this node in the tree carry a secret-bearing
   * dynamic reference (issue #1948 review)?
   *
   * Threaded rather than recomputed per level, because a DELETED child takes
   * its evidence from the nearest LIVE template and "nearest" is not the same
   * as "immediate parent": with a root that references a secret, an
   * intermediate child whose own template does not, and a deleted GRANDchild
   * holding a pre-GHSA bag, a per-level answer is `false` at the level that
   * matters and the stored plaintext prints. The flag accumulates with OR down
   * the walk so no intermediate level can break the chain.
   */
  parentHasSecretReference?: boolean;
  /**
   * Resolved absolute paths of every nested template ALREADY on the walk from
   * the root down to this node — the ancestor chain, not a global visited set
   * (issue go-to-k/cdkd#3239).
   *
   * The distinction is the whole point: two sibling rows may legitimately name
   * the SAME child template, and a global set would refuse that diamond as if
   * it were a cycle. Only a repeat along one root-to-node path is one.
   *
   * Absent at the root, because the root's own template arrives as an object
   * and the caller has no path for it. Termination does not depend on seeding
   * it: a child that names the root's file is not caught at that descent, but
   * the walk then re-enters the root's children and the FIRST of those repeats
   * a path this set already holds, so the cycle is refused one level later.
   */
  ancestorTemplatePaths?: ReadonlySet<string>;
  /**
   * True when this call is a nested CHILD rather than the stack the user
   * named (go-to-k/cdkd#3335).
   *
   * Explicit rather than inferred from `ancestorTemplatePaths` being
   * non-empty, which is what the first cut did: that set exists for CYCLE
   * detection, and reading "am I root" off it couples this decision to a
   * parameter nothing stops a future caller from seeding. The coupling is now
   * fenced — one case in
   * `tests/unit/cli/diff-recursive-deploy-refusal-blocking.test.ts` diffs a
   * damaged ROOT with that set already populated — so restoring the inference
   * reds rather than passing silently.
   *
   * REQUIRED, not optional-with-a-default, for the same reason: an optional
   * flag defaulting to `false` lets a future RECURSIVE call site forget it and
   * have its child treated as a root, promising exit 3 over a stack the deploy
   * skips. A required member makes that a compile error — the shape
   * `renderNoStackMatch` uses, per `.claude/rules/layout-cli.md`.
   *
   * Deriving the same answer from `stackName` containing `~` looks equivalent
   * and is NOT: a PREBUILT assembly supplies its own stack names, unvalidated,
   * so a TOP-LEVEL stack really can be called `A~B` and would lose its
   * repaired-container reasons under that reading. One case in the test file
   * above diffs a damaged root with such a name.
   */
  isNestedChild: boolean;
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
    parentHasSecretReference,
    parameters,
    canonicalizeProperties,
    assetRedirect,
    cfnFallback,
    previewOrphanAdoption,
    ancestorTemplatePaths,
    isNestedChild,
  } = args;

  const { state, unreadable, deployRefusals } = await loadStateOrEmpty(
    stackName,
    region,
    stateBackend
  );
  // TOP-LEVEL only (go-to-k/cdkd#3335), and the scope is a CONSERVATIVE
  // decision rather than a claim that the answer is unknowable. Some change
  // types do say the deploy reaches the child — a `CREATE` row provisions it,
  // a `DELETE` row removes it, and a property-changing `UPDATE` diffs it — but
  // the two commonest shapes say the opposite: the deploy skips a `NO_CHANGE`
  // nested-stack row, and an `UPDATE` moving only `DeletionPolicy` /
  // `UpdateReplacePolicy` refreshes the recorded attributes with no provider
  // call. Deriving reachability per shape is a bigger change than this issue,
  // and the cost of getting it wrong is exit 3 over a deploy that succeeds, so
  // every nested node keeps its warning and adds no reason. A lane narrowing
  // this later edits TWO sites, not one: a CREATE row and a property-changing
  // UPDATE reach this gate, while a DELETE child goes through
  // `buildDeletedSubtree`, which hard-codes `blocking: []` and never arrives
  // here at all.
  // Accumulated, not replaced: see `parentHasSecretReference`'s doc.
  const secretBearingAbove =
    parentHasSecretReference === true || templateHasSecretDynamicReference(template);
  const {
    changes,
    outputChanges,
    adoptedOrphans,
    adoptedRecords,
    blocking,
    unreadableOrphans,
    deployRefusals: adoptedDeployRefusals,
  } = await computeStackDiff(state, template, region, stackName, stateBackend, diffCalculator, {
    ...(parameters && { parameters }),
    ...(canonicalizeProperties && { canonicalizeProperties }),
    ...(cfnFallback !== undefined && { cfnFallback }),
    ...(previewOrphanAdoption && { previewOrphanAdoption }),
    // A live template of its own, so this node decides for itself; the
    // inherited flag only matters for the DELETED children below.
    inheritSecretBearingTemplate: false,
  });
  // The SAME state the diff read. `collectCcApiRoutes` reads `provisionedBy`
  // off each record for the sticky-Cloud-Control annotation, and an adopted
  // `cc-api` record is invisible in the un-spliced bag — the row would print
  // without `[via CC API: ...]` while the deploy routes it that way, which is
  // the inverse-of-truth annotation go-to-k/cdkd#2719 closed.
  const stateAfterAdoption =
    Object.keys(adoptedRecords).length > 0
      ? { ...state, resources: { ...state.resources, ...adoptedRecords } }
      : state;
  const ccApiRoutes = collectCcApiRoutes(template, stateAfterAdoption);
  const node: DiffTreeNode = {
    stackName,
    displayName,
    region,
    changes,
    ccApiRoutes,
    outputChanges,
    adoptedOrphans,
    blocking: isNestedChild ? blocking : [...deployRefusals, ...adoptedDeployRefusals, ...blocking],
    // The load's dropped rows first, then the orphan records the adoption
    // preview could not read — one list, because the reader of `--json` and
    // `--fail` asks one question of it: did the diff read everything?
    unreadable: [...unreadable, ...unreadableOrphans],
    children: [],
  };
  if (!recursive) return node;

  // Template-present children, in template order (CREATE / UPDATE / present).
  const templateChildIds = new Set<string>();
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (resource?.Type !== NESTED_STACK_RESOURCE_TYPE) continue;
    templateChildIds.add(logicalId);
    const childTemplatePath = nestedTemplates[logicalId];
    if (!childTemplatePath) {
      throw new Error(
        `Nested template file not found for ${NESTED_STACK_RESOURCE_TYPE} ${displayIdent(logicalId)} under ` +
          `stack ${displayStackName(stackName)}. Verify the synth output emits Metadata['aws:asset:path'] on ` +
          `this resource (CDK 2.x cdk.NestedStack does so by default), then re-run synth.`
      );
    }
    const childStackName = `${stackName}~${logicalId}`;
    // Refuse a template already on this root-to-node path before reading it
    // (issue go-to-k/cdkd#3239). `indexNestedChildTemplates` refuses only an
    // ABSOLUTE `aws:asset:path`; a RELATIVE one resolving back onto the chain
    // took the other branch and was joined unconditionally.
    //
    // What that cost is a DIAGNOSIS, not termination, and the difference is
    // worth stating because the obvious reading is wrong. This walk is already
    // bounded: `loadStateOrEmpty` runs at every node against `childStackName`,
    // which grows by one `~<logicalId>` per level, so S3's 1024-byte key limit
    // stops it — measured live at ~190 levels with
    // `Your key is too long`, after ~190 pointless state reads, naming a stack
    // that does not exist and never mentioning the asset path. So the template
    // arm is bounded by the SAME key limit as the state-only arm; it just had
    // no way to say what went wrong. Refusing at the first repeat does.
    //
    // A REFUSAL, not a depth cap, and the reason is local to this command: a
    // cyclic assembly has no correct diff to render, so truncating the walk
    // would under-report changes the next deploy would still make. A view
    // whose contract is that every record appears would answer differently.
    //
    // `path.resolve` is DEFENSIVE, not load-bearing, and saying so is the
    // point of this paragraph. Every path here is already normalized: synth
    // builds the root's entries with `resolveAssemblyPath(assemblyDir,
    // assetPath).path` (`src/synthesis/assembly-reader.ts`), which is absolute,
    // and every deeper one comes from this module's own call to the same
    // helper. So in the real pipeline a raw string
    // comparison would behave identically. It resolves anyway because the set
    // is keyed on the value, and a future caller that hands us an
    // unnormalized `nestedTemplates` would otherwise miss the first repeat
    // and refuse one level late.
    const resolvedChildPath = path.resolve(childTemplatePath);
    if (ancestorTemplatePaths?.has(resolvedChildPath) === true) {
      // `displaySafe` on ALL THREE interpolations: this refusal exists FOR a
      // hand-modified assembly, so every one of its inputs is
      // attacker-controlled. `logicalId` is a template key; the path derives
      // from `aws:asset:path`; and `stackName` is not exempt either, because
      // below the root it is built from template keys too
      // (`${stackName}~${logicalId}`, see the line above). Without this a
      // newline or a C1 byte forges terminal lines inside an error the user is
      // being asked to trust. `formatError` sanitizes only `cause`, so it does
      // not cover a bare `Error`'s message.
      throw new Error(
        `Nested stack ${displayIdent(logicalId)} under stack ${displayStackName(stackName)} ` +
          `resolves to nested template ${displayAssemblyPath(resolvedChildPath)}, which is already ` +
          `being diffed higher up the same nesting chain. Its Metadata['aws:asset:path'] ` +
          `closes a cycle; CDK emits an acyclic nested template tree, so this indicates the ` +
          `synth output was hand-modified or generated by a non-CDK toolchain. ` +
          `Refusing to diff.`
      );
    }
    const childAncestorTemplatePaths = new Set(ancestorTemplatePaths ?? []).add(resolvedChildPath);
    const childTemplate = readNestedTemplate(childTemplatePath);
    if (assetRedirect) {
      rewriteTemplateAssetReferences(childTemplate, assetRedirect);
    }
    const grandchildTemplates = indexNestedChildTemplates(childTemplate, childTemplatePath);
    // Resolve the child's input `Parameters` (declared on this parent's
    // `AWS::CloudFormation::Stack` row) against THIS node's deployed state +
    // already-resolved parameters, so the child's diff resolver can resolve a
    // `Ref` to one of those parameters — mirroring the deploy engine's
    // parent->child `DeployEngineOptions.parameters` forwarding.
    //
    // `stateAfterAdoption`, not `state`: a child parameter whose value is a
    // `Ref` / `Fn::GetAtt` to a resource this node just adopted resolves on
    // the deploy path and would drop here, swallowed by the best-effort catch,
    // leaving the child preview degraded for a reason nothing prints.
    const childParameters = await resolveChildStackParameters(
      resource,
      template,
      stateAfterAdoption,
      region,
      stackName,
      stateBackend,
      parameters,
      cfnFallback
    );
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
        parameters: childParameters,
        ...(canonicalizeProperties && { canonicalizeProperties }),
        ...(assetRedirect && { assetRedirect }),
        ...(cfnFallback !== undefined && { cfnFallback }),
        ...(previewOrphanAdoption && { previewOrphanAdoption }),
        ancestorTemplatePaths: childAncestorTemplatePaths,
        isNestedChild: true,
        parentHasSecretReference: secretBearingAbove,
      })
    );
  }

  // State-only children (removed from the template → recursive DELETE).
  for (const [logicalId, resource] of Object.entries(state.resources ?? {})) {
    if (resource.resourceType !== NESTED_STACK_RESOURCE_TYPE) continue;
    if (templateChildIds.has(logicalId)) continue;
    node.children.push(
      await buildDeletedSubtree(
        `${stackName}~${logicalId}`,
        region,
        stateBackend,
        diffCalculator,
        // The nearest LIVE template is the evidence the deleted child cannot
        // supply for itself (issue #1948 review): the child diffs against an
        // empty template, so without this its whole stored bag renders with
        // values. Accumulated from above, so an intermediate template that
        // happens to carry no reference cannot break the chain.
        secretBearingAbove
      )
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
  diffCalculator: DiffCalculator,
  parentHasSecretReference: boolean
): Promise<DiffTreeNode> {
  const { state, unreadable } = await loadStateOrEmpty(stackName, region, stateBackend);
  const { changes, outputChanges } = await computeStackDiff(
    state,
    EMPTY_TEMPLATE,
    region,
    stackName,
    stateBackend,
    diffCalculator,
    { inheritSecretBearingTemplate: parentHasSecretReference }
  );
  const node: DiffTreeNode = {
    stackName,
    displayName: stackName,
    region,
    changes,
    // State-only DELETE branches do not consult the template — routing is
    // already recorded on each resource's `provisionedBy`, and the diff line
    // only shows the type. No annotation surface.
    ccApiRoutes: new Map(),
    // Adoption needs a template that still DECLARES the logical id, and this
    // branch exists precisely because no template does. A record here is
    // carried, never adopted, so there is nothing to annotate and no ADOPTION
    // that could refuse. The load's repaired-container refusals are dropped
    // here too, as at every non-root node (go-to-k/cdkd#3335) — so `[]` is two
    // decisions, not an invariant.
    adoptedOrphans: [],
    blocking: [],
    unreadable,
    // The empty template carries no `Outputs`, so every persisted key diffs as
    // REMOVE — which is accurate: destroying the child drops its whole state
    // record, and any export it published stops resolving for consumers.
    //
    // Their VALUES are withheld whenever the parent's template proves a secret
    // reference (issue #1948 review). An empty template accounts for no key at
    // all, so the withholding is necessarily all-or-nothing here rather than
    // the per-key split a live template affords — an ordinary child in a
    // secret-handling tree therefore loses its printed values too. Fail-closed
    // is the right side to err on: the rows themselves are still reported, and
    // a bag with any secret expression in it still exonerates the record.
    outputChanges,
    children: [],
  };
  for (const [logicalId, resource] of Object.entries(state.resources ?? {})) {
    if (resource.resourceType !== NESTED_STACK_RESOURCE_TYPE) continue;
    node.children.push(
      // Propagated, not recomputed: a grandchild's template is gone for the
      // same reason its parent's is, so the evidence stays the nearest LIVE
      // template in the tree.
      await buildDeletedSubtree(
        `${stackName}~${logicalId}`,
        region,
        stateBackend,
        diffCalculator,
        parentHasSecretReference
      )
    );
  }
  return node;
}

const EMPTY_ALLOW_SET: ReadonlySet<string> = new Set();

/**
 * Walk every resource in `template` and return the logicalId → annotation
 * source map that #614's auto-fallback would route via Cloud Control API.
 *
 * Two annotation sources are merged into one map so the diff renderer
 * matches the live-progress label and the design §8 statement that the
 * `[via CC API: ...]` tag "stays visible whenever the resource has the
 * `provisionedBy: 'cc-api'` state field set OR is being introduced via the
 * auto-route":
 *
 *  - **Fresh hits**: a resource whose template uses one or more
 *    silent-drop top-level CFn properties. Annotation value is the list
 *    of property names (e.g. `Body`).
 *  - **Sticky hits**: a resource whose deployed state records
 *    `provisionedBy: 'cc-api'` (from a prior deploy) even when the
 *    current template's silent-drop set is empty. Annotation value is
 *    the single token `sticky` so the renderer prints `[via CC API:
 *    sticky]` — the routing decision is unchanged but the tag stays
 *    visible per #614's sticky-state semantics.
 *
 * When both sources fire on the same resource, the fresh-hit prop list
 * wins (more informative). Empty allow-set:
 * `--allow-unsupported-properties` is a deploy-only flag, so diff
 * renders every actionable drop as an auto-route hint.
 *
 * Excludes `AWS::CDK::Metadata` (filtered like the deploy pre-flight); also
 * excludes `AWS::CloudFormation::Stack` rows since nested-stack children
 * recurse through their own templates rather than carrying CC-routable
 * properties on the parent's row.
 */
export function collectCcApiRoutes(
  template: CloudFormationTemplate,
  state: StackState
): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (!resource) continue;
    if (resource.Type === 'AWS::CDK::Metadata') continue;
    if (resource.Type === NESTED_STACK_RESOURCE_TYPE) continue;
    // The record's bag is the baseline an unrecognized property is compared
    // against, as `getProviderFor` does on the update path (issue #3713).
    const drops = findActionableSilentDrops(
      resource.Type,
      resource.Properties,
      EMPTY_ALLOW_SET,
      state.resources[logicalId]?.properties
    );
    if (drops.length > 0) {
      hits.set(
        logicalId,
        drops.map((d) => d.property)
      );
      continue;
    }
    // Sticky-CC fallback: no fresh silent-drop hit, but the deployed state
    // pins routing to CC API → next op (UPDATE) still goes via CC API per
    // `getProviderFor` rule 2 (sticky). Surface the tag with the
    // distinguishing `sticky` token so the user can tell this case apart
    // from a fresh auto-route.
    const record = state.resources[logicalId];
    if (record?.provisionedBy === 'cc-api') {
      // ...unless the type is exempt AND this resource's own property bags say
      // the flip is safe, in which case the next op leaves Cloud Control
      // instead of staying on it (issue #2719). Before that check existed this
      // arm read the record alone, so `AWS::Scheduler::Schedule` -- exempt
      // since issue #961 -- was rendered `[via CC API: sticky]` while
      // `getProviderFor` routed it to the SDK provider: the annotation stated
      // the opposite of what the deploy would do.
      // No allow-set is threaded, matching the `findActionableSilentDrops` call
      // above and for the same structural reason: `cdkd diff` has no
      // `--allow-unsupported-properties` flag, so there is nothing to thread.
      // Inert today (an admitted `'sdk-coverage'` type has an empty silentDrop
      // map, so the allow set cannot change the answer) and it would diverge
      // from the deploy only for a future exempt type with a real drop — which
      // the admission bar in docs/provider-rules.md already discourages.
      const leaving = wouldReturnToSdkProvider({
        resourceType: resource.Type,
        // `?? {}` matches the engine's `change.desiredProperties || {}`
        // (deploy-engine.ts). Without it a template resource with NO
        // `Properties` block passes `undefined`, the predicate's
        // no-desired-bag gate returns false, and the annotation prints
        // `sticky` for a resource the deploy will flip -- the exact
        // inverse-of-truth this arm was changed to stop printing, one level
        // above the shared predicate. Reachable by removing the last property
        // from a cc-api-recorded resource.
        desiredProperties: resource.Properties ?? {},
        previousProperties: record.properties,
      });
      hits.set(logicalId, [leaving ? SDK_MIGRATION_TOKEN : 'sticky']);
    }
  }
  return hits;
}

/** True when this node has at least one real (non-`NO_CHANGE`) change. */
export function nodeHasChanges(node: DiffTreeNode): boolean {
  for (const change of node.changes.values()) {
    if (change.changeType !== 'NO_CHANGE') return true;
  }
  // Issue #1921: an Outputs-only change has no resource change at all, so this
  // arm is the ONLY thing standing between it and "No changes detected" — and
  // it is what makes `--fail` exit 1 for it, matching `cdk diff --fail`.
  //
  // go-to-k/cdkd#2943 adds the same arm for adoption, for the same reason and
  // found the same way — by running it against real AWS. An adopted record
  // whose properties already match the template diffs as NO_CHANGE, so a stack
  // whose only pending work is the adoption had every count at zero and
  // printed "No changes detected". The deploy does work there: it splices the
  // record into `resources` and persists the state without the orphan. A
  // preview that calls that nothing is wrong in the direction that matters —
  // the user ran `cdkd diff` precisely to find out whether the next deploy
  // will adopt or collide.
  //
  // go-to-k/cdkd#3018 adds the unreadable rows, for the reason `cdkd drift`
  // reports them as `notCompared`: the load DROPS them so the rest of the stack
  // can be diffed, and a dropped row the template no longer declares then has
  // no DELETE row. Without this arm `--fail` exits 0 over a record that used to
  // crash non-zero, which is the one direction this change must not take.
  return (
    node.outputChanges.length > 0 || node.adoptedOrphans.length > 0 || node.unreadable.length > 0
  );
}

/** True when this node OR any descendant has a real change (tree-wide drift detector for `--fail`). */
/**
 * How many deploy refusals the whole tree carries (issue go-to-k/cdkd#2943).
 *
 * A COUNT rather than a boolean because the caller's message quotes it.
 * {@link treeIsWorthRendering} below IS a boolean built on this, added when
 * review found the render gate gated on changes alone — it derives from this
 * count rather than walking the tree again, so there is still one recursion to
 * keep in step.
 *
 * Deliberately SEPARATE from {@link treeHasChanges}: `--fail` answers "is
 * there a delta", and a refusal is not a delta — a user who runs
 * `cdkd diff --fail` in CI to detect drift must not have that signal merged
 * with "the deploy cannot start", which is true whether or not anything
 * changed.
 */
export function countBlocking(node: DiffTreeNode): number {
  return node.blocking.length + node.children.reduce((n, c) => n + countBlocking(c), 0);
}

/**
 * Whether `cdkd diff` should render this tree's block at all (issue
 * go-to-k/cdkd#2943).
 *
 * A named predicate rather than an inline conjunction at the call site,
 * because the two halves are easy to get wrong INDEPENDENTLY and were:
 * {@link renderDiffTree} was written to print a `Blocking` section for a node
 * with no changes, and the caller then skipped the render on
 * `!treeHasChanges` alone — so a changeless refusal would print "No changes
 * detected" and exit non-zero citing reasons that were never printed.
 */
export function treeIsWorthRendering(node: DiffTreeNode): boolean {
  // `treeHasChanges` already covers adoption since go-to-k/cdkd#2943 taught
  // `nodeHasChanges` about it, so this stays a two-term predicate.
  return treeHasChanges(node) || countBlocking(node) > 0;
}

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
  /**
   * Silent-drop property names that #614's auto-fallback would route via
   * Cloud Control API for this resource. Present only when the resource is
   * a CC-routed auto-route hit (matches the human renderer's
   * `[via CC API: <prop list>]` annotation).
   */
  ccApi?: string[];
}

/** Serializable Outputs change record for `--json` (issue #1921). */
export interface DiffOutputChangeJson {
  name: string;
  changeType: OutputChange['changeType'];
  oldValue?: unknown;
  newValue?: unknown;
  /**
   * Present and true when `oldValue` was WITHHELD because state holds legacy
   * secret plaintext for this key (run `cdkd scrub`). The change is still
   * reported; only the value is omitted.
   */
  oldValueRedacted?: boolean;
  /** True for an `Export.Name` key — the ones a consumer's `Fn::ImportValue` reads. */
  export: boolean;
}

/** Serializable diff-tree node for `--json` (nested when `--recursive`). */
export interface DiffNodeJson {
  stack: string;
  region: string;
  changes: DiffChangeJson[];
  /**
   * Outputs delta (issue #1921). Always present — empty array when unchanged —
   * for the same key-set stability reason as `children`.
   */
  outputChanges: DiffOutputChangeJson[];
  /**
   * Logical ids adopted from a rollback-orphan record (issue
   * go-to-k/cdkd#2943). Always present — empty array when none — for the same
   * key-set stability reason as `children`.
   */
  adoptedOrphans: string[];
  /**
   * Reasons `cdkd deploy` would refuse. Always present; non-empty means the
   * run this payload describes would not start. Consumers gating on the diff
   * must read this, not just `changes`.
   */
  blocking: string[];
  /**
   * Rows of the state record the diff could not read (go-to-k/cdkd#3018).
   * Always present; non-empty means `changes` is NOT the whole picture — a
   * record the template no longer declares has no DELETE row here.
   */
  unreadable: string[];
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
    const ccApi = node.ccApiRoutes.get(change.logicalId);
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
      ...(ccApi && ccApi.length > 0 ? { ccApi } : {}),
    });
  }
  return {
    stack: node.stackName,
    region: node.region,
    changes,
    outputChanges: node.outputChanges.map((change) => ({
      name: change.name,
      changeType: change.changeType,
      // `oldValue` / `newValue` are omitted rather than set to `undefined` so
      // `JSON.stringify` does not have to drop them: an ADD has no old side and
      // a REMOVE has no new side, and a key present-but-null would read as a
      // real null value.
      // A withheld legacy-plaintext value is withheld from `--json` too — that
      // payload is the one most likely to be captured by CI tooling.
      ...(change.changeType !== 'ADD' && !change.oldValueRedacted
        ? { oldValue: change.oldValue }
        : {}),
      ...(change.oldValueRedacted ? { oldValueRedacted: true } : {}),
      ...(change.changeType !== 'REMOVE' ? { newValue: change.newValue } : {}),
      export: change.isExport,
    })),
    adoptedOrphans: node.adoptedOrphans,
    blocking: node.blocking,
    unreadable: node.unreadable,
    children: node.children.map(diffTreeToJson),
  };
}

function isIntrinsic(value: unknown): boolean {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.length === 1 && INTRINSIC_KEYS.has(keys[0]!);
}

/**
 * Per-side rendering rule for a diff side that is NOT a plain object pair
 * (primitives, arrays, intrinsics). The both-plain-objects case is handled
 * jointly by {@link stripUnchangedValuePair}, which never delegates it here.
 */
function stripUnchangedValues(value: unknown, other: unknown): unknown {
  // Primitives or nulls: return as-is (the caller already determined these differ)
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value;

  // If value itself is an intrinsic, omit it (it's not a real change)
  if (isIntrinsic(value)) return undefined;
  // If the other side is an intrinsic, the resolved value on this side is not a real change
  if (isIntrinsic(other)) return undefined;

  // The other side is a primitive / array / null here (object-vs-object goes
  // through stripUnchangedValuePair), so this side renders in full.
  return value;
}

function isPlainNonIntrinsicObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !isIntrinsic(value)
  );
}

/**
 * Strip unchanged and intrinsic-only keys from BOTH sides of a property
 * change in ONE walk, so the two rendered sides stay symmetric (issue #1608).
 *
 * {@link stripUnchangedValues} runs per side, so a PURE KEY ADDITION pruned
 * the new side down to the added key while the old side — whose own keys are
 * all unchanged — hit the empty-result fallback and printed the FULL object.
 * That asymmetry reads as "the whole object is replaced by just the added
 * key" (i.e. everything else removed), the opposite of what deploy does.
 * Walking the UNION of keys once yields `old: {}` / `new: {AddedKey: ...}`
 * for an addition (and the mirror for a removal); the full-value fallback —
 * kept for sides differing only in key order or intrinsic-valued keys — now
 * fires only when BOTH sides pruned to nothing, so it can never be one-sided.
 * Non-object sides (primitives, arrays, intrinsics) keep the existing
 * per-side semantics via {@link stripUnchangedValues}.
 */
function stripUnchangedValuePair(oldValue: unknown, newValue: unknown): [unknown, unknown] {
  if (!isPlainNonIntrinsicObject(oldValue) || !isPlainNonIntrinsicObject(newValue)) {
    return [stripUnchangedValues(oldValue, newValue), stripUnchangedValues(newValue, oldValue)];
  }

  const oldResult: Record<string, unknown> = {};
  const newResult: Record<string, unknown> = {};
  // Object.hasOwn, not `in`: a user-controlled map key named after an
  // Object.prototype member (`toString`, `constructor`, ...) is `in` every
  // object via the prototype chain, so `in` would silently drop its
  // addition/removal from the union and copy inherited members into a side.
  const keys = [
    ...Object.keys(oldValue),
    ...Object.keys(newValue).filter((k) => !Object.hasOwn(oldValue, k)),
  ];

  for (const key of keys) {
    const o = oldValue[key];
    const n = newValue[key];

    // If either side is intrinsic for this key, skip (not a real change)
    if (isIntrinsic(o) || isIntrinsic(n)) continue;

    // If values are deeply equal, skip
    if (JSON.stringify(o) === JSON.stringify(n)) continue;

    // Recurse for nested objects
    if (isPlainNonIntrinsicObject(o) && isPlainNonIntrinsicObject(n)) {
      const [fo, fn] = stripUnchangedValuePair(o, n);
      if (fo !== undefined && JSON.stringify(fo) !== '{}') oldResult[key] = fo;
      if (fn !== undefined && JSON.stringify(fn) !== '{}') newResult[key] = fn;
    } else {
      if (Object.hasOwn(oldValue, key)) oldResult[key] = o;
      if (Object.hasOwn(newValue, key)) newResult[key] = n;
    }
  }

  if (Object.keys(oldResult).length === 0 && Object.keys(newResult).length === 0) {
    return [oldValue, newValue];
  }
  return [oldResult, newResult];
}

/**
 * Render one side of a property change for the diff output.
 *
 * A side whose WHOLE value is still a raw intrinsic could not be resolved
 * against current state — most commonly a `Ref` / `Fn::GetAtt` to a resource
 * this same deploy will CREATE (the CDK logical-id-churn dance: an
 * `AWS::ApiGateway::Deployment` hash rotation, a `fn.currentVersion` Lambda
 * Version). Rendering that via the strip-unchanged pass collapsed it to
 * the literal string `undefined`, which reads as "this property is being
 * removed" (issue #1017). Instead, render the raw intrinsic compactly and —
 * on the NEW side — annotate that the value only exists after the deploy.
 * Everything else renders the pre-filtered value computed jointly for both
 * sides by {@link stripUnchangedValuePair}.
 */
function renderDiffValue(
  own: unknown,
  filtered: unknown,
  indent: string,
  isNewSide: boolean
): string {
  if (isIntrinsic(own)) {
    const suffix = isNewSide ? ' (known after deploy)' : '';
    return `${JSON.stringify(own)}${suffix}`;
  }
  return (JSON.stringify(filtered, null, 2) ?? 'undefined').replace(/\n/g, `\n${indent}`);
}

/**
 * Render one resource-change map into human-readable diff lines via `logFn`,
 * returning the per-type counts. Shared by the root stack block and every
 * nested-stack block.
 *
 * When `ccApiRoutes` is supplied, every CREATE / UPDATE line whose logical ID
 * appears in the map gets a `[via CC API: <props>]` suffix so the user sees
 * #614's auto-fallback decision at plan time. DELETE lines are not annotated
 * — the delete routing is recorded on each resource's `provisionedBy` state
 * field rather than re-derived from the template.
 *
 * `adoptedOrphans` annotates the rows whose resource is in this diff only
 * because a rollback-orphan record was verified and spliced in (issue
 * go-to-k/cdkd#2943). Without it the row is indistinguishable from an ordinary
 * update, and the user last saw that resource FAIL and leave state — so an
 * unannotated `[~]` reads as cdkd having quietly kept managing it. Both
 * annotations can apply to one row; adoption is printed first because it is
 * why the row exists at all, where the routing describes how it will be
 * carried out.
 */
export function renderChangeLines(
  changes: Map<string, ResourceChange>,
  logFn: (msg: string) => void,
  ccApiRoutes?: Map<string, string[]>,
  adoptedOrphans?: readonly string[]
): { create: number; update: number; delete: number } {
  let createCount = 0;
  let updateCount = 0;
  let deleteCount = 0;

  const adopted = new Set(adoptedOrphans ?? []);
  const annotateAdoption = (logicalId: string): string =>
    adopted.has(logicalId) ? ' [adopted from a rollback orphan]' : '';

  const annotateRouting = (logicalId: string): string => {
    const props = ccApiRoutes?.get(logicalId);
    if (!props || props.length === 0) return '';
    // The migration token describes a resource LEAVING Cloud Control, so it
    // cannot wear the `via CC API:` prefix the other tokens share -- that
    // read `[via CC API: returning to SDK provider]`, which says both things
    // at once. It is the only token that is a whole phrase rather than a
    // property name, hence the special case rather than a prefix variable.
    if (props.length === 1 && props[0] === SDK_MIGRATION_TOKEN) {
      return ` [${SDK_MIGRATION_TOKEN}]`;
    }
    return ` [via CC API: ${props.join(', ')}]`;
  };

  for (const [logicalId, change] of changes.entries()) {
    switch (change.changeType) {
      case 'CREATE':
        createCount++;
        logFn(
          `  [+] ${logicalId} (${change.resourceType})` +
            `${annotateAdoption(logicalId)}${annotateRouting(logicalId)}`
        );
        break;
      case 'UPDATE': {
        updateCount++;
        logFn(
          `  [~] ${logicalId} (${change.resourceType})` +
            `${annotateAdoption(logicalId)}${annotateRouting(logicalId)}`
        );
        if (change.propertyChanges && change.propertyChanges.length > 0) {
          for (const propChange of change.propertyChanges) {
            const requiresReplace = propChange.requiresReplacement ? ' [requires replacement]' : '';
            // Issue #807: a propagated change shows old=<resolved value> /
            // new=<unresolved intrinsic> because the property's template
            // value did not change — only the physical ID / ARN it
            // references will change after the upstream replacement. Label
            // it so the apparent string -> {Ref} delta is not misread as a
            // literal value edit.
            // go-to-k/cdkd#3662: the in-place twin — the reader was promoted
            // because an attribute it reads of an updated resource (a nested
            // stack output, a custom resource's `Data`) MAY move, which only
            // the deploy learns; the old side is the resolved value, the new
            // side the reading intrinsic.
            const propagated = propChange.replacementPropagated
              ? ' [replacement propagated]'
              : propChange.inPlacePropagated
                ? ' [attribute propagated]'
                : '';
            const indent = '              ';
            const [oldFiltered, newFiltered] = stripUnchangedValuePair(
              propChange.oldValue,
              propChange.newValue
            );
            const oldStr = renderDiffValue(propChange.oldValue, oldFiltered, indent, false);
            const newStr = renderDiffValue(propChange.newValue, newFiltered, indent, true);
            logFn(`      - ${propChange.path}:${requiresReplace}${propagated}`);
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
 * Stand-in printed instead of a withheld stored output value.
 *
 * Worded as a POSSIBILITY because both reasons the value is withheld are
 * suspicions rather than detections — a record that LOOKS pre-GHSA, and a
 * stored key today's template cannot account for (issue #1948), which is
 * undecidable by construction. Stating it as a fact would be wrong on the
 * benign half of each, and `cdkd scrub` finding nothing is the expected
 * outcome there.
 */
const REDACTED_LEGACY_PLAINTEXT = '<redacted: may be legacy plaintext in state — run `cdkd scrub`>';

/**
 * The guard for an already-JSON-SERIALIZED value: C1 and the bidi marks
 * only, deliberately NOT C0.
 *
 * `JSON.stringify` escapes every character below 0x20 that occurs INSIDE a
 * string, so the only C0 left on this path is the pretty-printer's own
 * structural newlines — stripping those collapses a multi-line value onto a
 * single line. What `JSON.stringify` passes through unchanged is the C1 range
 * and the bidi overrides, and those are what this removes.
 */
function stripDisplayOnlyChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
}

/**
 * Render one node's Outputs delta (issue #1921) via `logFn`, returning the
 * per-kind counts. Emits nothing when there is no delta, so an unchanged
 * Outputs section adds no noise to a resource-only diff.
 *
 * Rows are keyed by the PERSISTED bag key, which is what `StackState.outputs`
 * holds and what the exports index publishes. An output carrying an
 * `Export.Name` therefore shows TWO rows — its logical name and its export
 * name — because the deploy writes both keys. That is the useful half for the
 * motivating case: the `[export]`-tagged row IS the string a downstream
 * `Fn::ImportValue` resolves, so the user can match it against the consumer
 * that was failing with "export not found".
 */
export function renderOutputChangeLines(
  outputChanges: readonly OutputChange[],
  logFn: (msg: string) => void
): { add: number; change: number; remove: number } {
  const counts = { add: 0, change: 0, remove: 0 };
  if (outputChanges.length === 0) return counts;

  logFn('\n  Outputs:');
  const indent = '            ';
  // Values are guarded too, but with the C0 range EXCLUDED — see
  // `stripDisplayOnlyChars`. Using the full class here deleted the
  // pretty-printer's newlines and collapsed every multi-line value onto one line.
  const render = (value: unknown): string =>
    stripDisplayOnlyChars(
      (JSON.stringify(value, null, 2) ?? 'undefined').replace(/\n/g, `\n${indent}`)
    );
  const renderOld = (change: OutputChange): string =>
    change.oldValueRedacted ? REDACTED_LEGACY_PLAINTEXT : render(change.oldValue);

  for (const change of outputChanges) {
    const exported = change.isExport ? ' [export]' : '';
    // Unlike a resource line's logical id — which CloudFormation constrains to
    // [A-Za-z0-9] — an Outputs bag key can be an `Export.Name` that cdkd
    // RESOLVED from an `Fn::Sub` / parameter / SSM value, so it never passed a
    // CFn validator and may carry control characters or ANSI escapes that would
    // rewrite the surrounding terminal output.
    const name = stripControlChars(change.name);
    switch (change.changeType) {
      case 'ADD':
        counts.add++;
        logFn(`    [+] ${name}${exported}`);
        logFn(`          new: ${render(change.newValue)}`);
        break;
      case 'MODIFY':
        counts.change++;
        logFn(`    [~] ${name}${exported}`);
        logFn(`          old: ${renderOld(change)}`);
        logFn(`          new: ${render(change.newValue)}`);
        break;
      case 'REMOVE':
        counts.remove++;
        logFn(`    [-] ${name}${exported}`);
        logFn(`          old: ${renderOld(change)}`);
        break;
    }
  }
  return counts;
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
  // Either condition prints the block. A refusal today always arrives BESIDE a
  // change — (d) fires only for a record the template still declares, which
  // the diff reports as a create — but gating the header on `nodeHasChanges`
  // alone would make that coincidence load-bearing, and a refusal nobody
  // prints is the one outcome this section exists to prevent.
  const hasChanges = nodeHasChanges(node);
  if (hasChanges || node.blocking.length > 0) {
    logFn(
      isRoot
        ? `\nStack ${stripControlChars(node.stackName)}:`
        : `\nNested stack: ${stripControlChars(node.displayName)}`
    );
  }
  if (hasChanges) {
    const {
      create,
      update,
      delete: del,
    } = renderChangeLines(node.changes, logFn, node.ccApiRoutes, node.adoptedOrphans);
    const outputs = renderOutputChangeLines(node.outputChanges, logFn);
    logFn(`\n${create} to create, ${update} to update, ${del} to delete`);
    // A SECOND summary line rather than extra terms on the first: the resource
    // counts drive what the deploy does to AWS, while an Outputs change is a
    // state / exports-index write with no resource operation behind it. Folding
    // them together would read as "1 to update" for a stack whose resources are
    // untouched. Printed only when there is something to say.
    if (outputs.add + outputs.change + outputs.remove > 0) {
      logFn(
        `${outputs.add} output(s) to add, ${outputs.change} to change, ${outputs.remove} to remove`
      );
    }
    // A THIRD summary line, and the only place an adoption is guaranteed to
    // appear. The per-row annotation rides a CREATE or UPDATE row, and an
    // adopted record that already matches the template produces neither — it
    // is NO_CHANGE, which renders nothing. Measured against real AWS: the
    // fixture's adopted role matched, so the preview named it nowhere.
    //
    // The ids are STATE-CHOSEN (an orphan record's `logicalId`), so they take
    // `displayLogicalId`, as the unreadable-row line below does — not
    // `stripControlChars`, which keeps U+2028 / U+2029 and draws no boundary,
    // so an id spelled `A (AWS::IAM::Role), B` read as two adoptions on the
    // `', '`-joined line (go-to-k/cdkd#3642 review). `--json`'s
    // `adoptedOrphans` keeps the raw keys: a machine payload needs the id
    // itself, and a many-to-one rendering there would be a collision.
    if (node.adoptedOrphans.length > 0) {
      logFn(
        `${node.adoptedOrphans.length} resource(s) to adopt from a previous rollback: ` +
          `${node.adoptedOrphans.map((id) => displayLogicalId(id)).join(', ')}`
      );
    }
    // A FOURTH line, for the rows the diff could not read (go-to-k/cdkd#3018).
    // A dropped row the template still declares IS above, as a create — the
    // diff has no record of it — but one the template no longer declares has
    // no row at all, not even a delete, so this line is the only place the
    // preview names it. Worded for both, since the node cannot tell a reader
    // which dropped id is which without re-reading the template.
    //
    // CAPPED at ten names, like the other lists of this kind (`cdkd export`'s
    // baseline report, the drift warnings): the count leads the line and
    // `--json` keeps every id, so a record with thousands of broken rows cannot
    // print one megabyte-long line. The create clause is for logical ids only:
    // the map row is not one, so a lone map row gets no such sentence.
    if (node.unreadable.length > 0) {
      // The map row is cdkd's own literal and renders bare. A logical id takes
      // `displayLogicalId`, whose quoting keeps an id padded to look like a
      // healthy sibling visibly distinct. Stated rather than solved: a planted
      // entry whose id IS the map-row literal is still indistinguishable from
      // it here and in `--json`, since the node records only strings.
      const named = node.unreadable
        .slice(0, UNREADABLE_PREVIEW_NAMES)
        .map((id) =>
          id === UNREADABLE_RESOURCES_MAP_ROW || id === UNREADABLE_ORPHANS_CONTAINER_ROW
            ? id
            : displayLogicalId(id)
        );
      const rest = node.unreadable.length - named.length;
      // The sentence below is about LOGICAL IDS, so it is suppressed when every
      // row is a container stand-in rather than only when the one row is the
      // resources map: a node whose sole row is `(orphans container)` would
      // otherwise claim the template declares one of them
      // (go-to-k/cdkd#3379). Stated rather than solved, and the same bound the
      // mapping above carries: two planted ids spelled exactly like the two
      // stand-in rows suppress it too, since the node records only strings.
      const onlyContainerRows = node.unreadable.every(
        (id) => id === UNREADABLE_RESOURCES_MAP_ROW || id === UNREADABLE_ORPHANS_CONTAINER_ROW
      );
      logFn(
        `${node.unreadable.length} state record row(s) could not be read: ` +
          `${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}.` +
          (onlyContainerRows
            ? ''
            : ` One the template still declares is shown above as a create; one it no ` +
              `longer declares is not shown above.`)
      );
    }
  }
  // AFTER the rows and the summaries, for the same reason `cdkd diff` renders
  // at all when a deploy would refuse: the user came here to see what the
  // deploy would do, and the refusal is one more thing it would do rather than
  // a reason to withhold the rest.
  if (node.blocking.length > 0) {
    logFn('\n  Blocking (cdkd deploy will refuse):');
    for (const reason of node.blocking) {
      logFn(`    ! ${stripControlChars(reason)}`);
    }
  }
  for (const child of node.children) {
    renderDiffTree(child, false, logFn);
  }
}
