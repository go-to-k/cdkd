import { stripControlChars } from '../../utils/regexp.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CloudFormationTemplate, TemplateResource } from '../../types/resource.js';
import type { ResourceChange, StackState } from '../../types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../types/state.js';
import { DiffCalculator, INTRINSIC_KEYS } from '../../analyzer/diff-calculator.js';
import type { CanonicalizePropertiesFn } from '../../analyzer/diff-calculator.js';
import { TemplateParser } from '../../analyzer/template-parser.js';
import { IntrinsicFunctionResolver } from '../../deployment/intrinsic-function-resolver.js';
import {
  computeOutputsDiff,
  resolveTemplateOutputs,
  type OutputChange,
} from '../../analyzer/outputs-diff.js';
import { getLogger } from '../../utils/logger.js';
import type { S3StateBackend } from '../../state/s3-state-backend.js';
import {
  rewriteTemplateAssetReferences,
  type AssetRedirectMap,
} from '../../assets/asset-redirect.js';
import { findActionableSilentDrops } from '../../provisioning/property-coverage.js';
import { NESTED_STACK_RESOURCE_TYPE } from './retire-cfn-stack.js';

const logger = getLogger().child('DiffRecursive');

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
   * `[via CC API: RuntimeManagementConfig]` annotations on each diff line so users can
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

/** What one stack's diff yields: its per-resource changes plus its Outputs delta. */
export interface StackDiffResult {
  /** Per-resource changes, including `NO_CHANGE` entries. */
  changes: Map<string, ResourceChange>;
  /** Per-key Outputs changes (issue #1921); empty when unchanged or unresolvable. */
  outputChanges: OutputChange[];
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
  parameters?: Record<string, unknown>,
  /**
   * Same per-type normalization the deploy engine applies (issue #1591).
   * Without it `cdkd diff` forecasts a change `cdkd deploy` will never make —
   * the preview and the apply must narrow identically.
   */
  canonicalizeProperties?: CanonicalizePropertiesFn,
  /**
   * `--no-cfn-fallback` (issue #1697): false disables the resolver's
   * CloudFormation fallback for cross-stack references, mirroring the
   * deploy engine's option so preview and apply resolve identically.
   */
  cfnFallback?: boolean
): Promise<StackDiffResult> {
  const intrinsicResolver = new IntrinsicFunctionResolver(region, {
    cfnFallback: cfnFallback ?? true,
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
    mergedParameters = { ...parameters, ...templateParameters };
    parametersBound = true;
  } catch (error) {
    logger.debug(
      `Diff parameter binding for stack ${stackName} is partial: ${error instanceof Error ? error.message : String(error)}`
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
  if (parametersBound) {
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
        `Diff condition evaluation for stack ${stackName} skipped: ${error instanceof Error ? error.message : String(error)}`
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
  const changes = await diffCalculator.calculateDiff(
    currentState,
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
  const resolved = await resolveTemplateOutputs(effectiveTemplate, resolveFn, conditions);
  // A partially-resolved bag reports NO delta, exactly like the deploy engine's
  // NO-CHANGE branch declining to persist one (`resolutionFailed` there). That
  // branch is the one this preview stands in for; deploy's changed-resources
  // branch has no such gate, correctly, because by then every resource exists.
  // Being conservative in the same direction is what keeps an unchanged stack at
  // "no changes" instead of showing a phantom the apply would never write.
  // Nothing is lost: an output only fails to resolve because it references a
  // resource this deploy has yet to create, and that CREATE is already on the
  // resource side of the diff.
  let outputChanges: OutputChange[] = [];
  if (resolved.resolutionFailed) {
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
    const wouldHaveChanged = computeOutputsDiff(
      currentState.outputs,
      resolved.outputs,
      resolved.exportNames,
      resolved.secretSourceKeys
    ).filter((change) => !resolved.failedKeys.has(change.name));
    if (wouldHaveChanged.length > 0) {
      logger.warn(
        `Outputs of stack ${stackName} may have changed, but one or more could not be resolved ` +
          `against current state — omitting the Outputs section from this diff. ` +
          `It is usually an output referencing a resource this deploy has yet to create.`
      );
    }
  } else {
    outputChanges = computeOutputsDiff(
      currentState.outputs,
      resolved.outputs,
      resolved.exportNames,
      resolved.secretSourceKeys
    );
  }

  return { changes, outputChanges };
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
    parameters,
    canonicalizeProperties,
    assetRedirect,
    cfnFallback,
  } = args;

  const state = await loadStateOrEmpty(stackName, region, stateBackend);
  const { changes, outputChanges } = await computeStackDiff(
    state,
    template,
    region,
    stackName,
    stateBackend,
    diffCalculator,
    parameters,
    canonicalizeProperties,
    cfnFallback
  );
  const ccApiRoutes = collectCcApiRoutes(template, state);
  const node: DiffTreeNode = {
    stackName,
    displayName,
    region,
    changes,
    ccApiRoutes,
    outputChanges,
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
        `Nested template file not found for ${NESTED_STACK_RESOURCE_TYPE} '${logicalId}' under ` +
          `stack '${stackName}'. Verify the synth output emits Metadata['aws:asset:path'] on ` +
          `this resource (CDK 2.x cdk.NestedStack does so by default), then re-run synth.`
      );
    }
    const childStackName = `${stackName}~${logicalId}`;
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
    const childParameters = await resolveChildStackParameters(
      resource,
      template,
      state,
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
  const { changes, outputChanges } = await computeStackDiff(
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
    // State-only DELETE branches do not consult the template — routing is
    // already recorded on each resource's `provisionedBy`, and the diff line
    // only shows the type. No annotation surface.
    ccApiRoutes: new Map(),
    // The empty template carries no `Outputs`, so every persisted key diffs as
    // REMOVE — which is accurate: destroying the child drops its whole state
    // record, and any export it published stops resolving for consumers. No
    // special case, so this node obeys the same rule as every other.
    outputChanges,
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
 *    of property names (e.g. `RuntimeManagementConfig`).
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
function collectCcApiRoutes(
  template: CloudFormationTemplate,
  state: StackState
): Map<string, string[]> {
  const hits = new Map<string, string[]>();
  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    if (!resource) continue;
    if (resource.Type === 'AWS::CDK::Metadata') continue;
    if (resource.Type === NESTED_STACK_RESOURCE_TYPE) continue;
    const drops = findActionableSilentDrops(resource.Type, resource.Properties, EMPTY_ALLOW_SET);
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
    if (state.resources[logicalId]?.provisionedBy === 'cc-api') {
      hits.set(logicalId, ['sticky']);
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
  return node.outputChanges.length > 0;
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
 */
export function renderChangeLines(
  changes: Map<string, ResourceChange>,
  logFn: (msg: string) => void,
  ccApiRoutes?: Map<string, string[]>
): { create: number; update: number; delete: number } {
  let createCount = 0;
  let updateCount = 0;
  let deleteCount = 0;

  const annotateRouting = (logicalId: string): string => {
    const props = ccApiRoutes?.get(logicalId);
    if (!props || props.length === 0) return '';
    return ` [via CC API: ${props.join(', ')}]`;
  };

  for (const [logicalId, change] of changes.entries()) {
    switch (change.changeType) {
      case 'CREATE':
        createCount++;
        logFn(`  [+] ${logicalId} (${change.resourceType})${annotateRouting(logicalId)}`);
        break;
      case 'UPDATE': {
        updateCount++;
        logFn(`  [~] ${logicalId} (${change.resourceType})${annotateRouting(logicalId)}`);
        if (change.propertyChanges && change.propertyChanges.length > 0) {
          for (const propChange of change.propertyChanges) {
            const requiresReplace = propChange.requiresReplacement ? ' [requires replacement]' : '';
            // Issue #807: a propagated change shows old=<resolved value> /
            // new=<unresolved intrinsic> because the property's template
            // value did not change — only the physical ID / ARN it
            // references will change after the upstream replacement. Label
            // it so the apparent string -> {Ref} delta is not misread as a
            // literal value edit.
            const propagated = propChange.replacementPropagated ? ' [replacement propagated]' : '';
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

/** Stand-in printed instead of a withheld legacy-plaintext output value. */
const REDACTED_LEGACY_PLAINTEXT = '<redacted: legacy plaintext in state — run `cdkd scrub`>';

/**
 * Strip characters that let a template-controlled string manipulate the
 * TERMINAL rather than merely appear in it: C0 (incl. ESC, so no ANSI sequence
 * survives), DEL, C1 (the 8-bit CSI forms some terminals still honor), and the
 * bidi / format overrides that visually reorder a rendered line.
 *
 * Applied only on the human-render path. The `--json` payload is deliberately
 * left byte-faithful: it is a machine interface, an export NAME is data a
 * consumer may match on, and silently mutating it there would trade a real
 * correctness regression for a display concern belonging to whatever renders
 * the JSON. `JSON.stringify` already escapes everything below 0x20.
 *
 * The helper itself now lives in `src/utils/regexp.ts` — `outputs-export-alias`
 * prints the same class of string and had grown a second copy.
 */
/**
 * The same guard for an already-JSON-SERIALIZED value: C1 and the bidi marks
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
  if (nodeHasChanges(node)) {
    logFn(isRoot ? `\nStack ${node.stackName}:` : `\nNested stack: ${node.displayName}`);
    const {
      create,
      update,
      delete: del,
    } = renderChangeLines(node.changes, logFn, node.ccApiRoutes);
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
  }
  for (const child of node.children) {
    renderDiffTree(child, false, logFn);
  }
}
