import { hintSidesOf, rollbackOrphanIds } from '../../../analyzer/refactor-hints.js';
import { displayIdent, displayStackName } from '../../../utils/display-safe.js';
import { displayAssemblyPath } from '../../../utils/assembly-path.js';
import {
  findNestedTemplateTreeDefect,
  renderNestedTemplateTreeDefect,
  templateIdentity,
} from '../../../utils/nested-template-cycle.js';
import * as path from 'node:path';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { ResourceState, StackState } from '../../../types/state.js';
import { DiffCalculator } from '../../../analyzer/diff-calculator.js';
import type { CanonicalizePropertiesFn } from '../../../analyzer/diff-calculator.js';
import type { ProducerLookup } from '../../../deployment/intrinsic-resolver/cdk-cross-account-ref.js';
import { templateHasSecretDynamicReference } from '../../../analyzer/outputs-diff.js';
import {
  hasMaskableValues,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import { noEchoParameterNamesOf } from '../../../deployment/deploy-engine/noecho.js';
import { secretNamedRecordNeedles } from '../../../deployment/secret-name-needles.js';
import { withPrintingSecrets } from '../../../deployment/resource-secrets-scope.js';
import type { S3StateBackend } from '../../../state/s3-state-backend.js';
import type { StaleAttributeHealer } from '../../../deployment/stale-attribute-heal.js';
import {
  rewriteTemplateAssetReferences,
  type AssetRedirectMap,
} from '../../../assets/asset-redirect.js';
import {
  prefetchCreateOnlyPropertyPaths,
  templateResourceTypes,
} from '../../../provisioning/create-only-properties.js';
import { NESTED_STACK_RESOURCE_TYPE } from '../retire-cfn-stack.js';
import { findDestructiveChanges } from '../../../analyzer/destructive-changes.js';
import type { LockRecoveryContext } from '../../../state/lock-contention-message.js';
import type { ReferenceProvenance } from '../../../types/state.js';
import { inheritedProvenanceForChildDiff } from '../../../deployment/read-provenance-sources.js';
import type {
  DiffTreeNode,
  CcRouteUnavailableReason,
  StackDiffResult,
  SecretTokensByParameter,
} from './types.js';
import {
  EMPTY_TEMPLATE,
  readNestedTemplate,
  indexNestedChildTemplates,
} from './nested-template.js';
import { loadStateOrEmpty } from './load-state.js';
import { diffPrintingSecrets } from './printing.js';
import { computeStackDiff } from './compute-stack-diff.js';
import {
  noEchoFedChildParameters,
  resolveChildStackParameters,
  recordedTemplateResources,
  healerUnderRecordPrintingBag,
} from './child-parameters.js';
import { collectCcApiRoutes } from './routes.js';

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
  /**
   * Builds the READ-ONLY stale-attribute healer for one node (issue
   * go-to-k/cdkd#3456), at EVERY node including nested children, since each
   * child deploys through its own engine and that engine heals too. See
   * `computeStackDiff`'s `attributeHealer`.
   */
  attributeHealerFor?: (stackName: string, region: string) => StaleAttributeHealer;
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
   * The input parameters the parent row names but could not resolve for this
   * diff (go-to-k/cdkd#4479); see `computeStackDiff`'s option of this name.
   */
  parentUnresolvedParameters?: ReadonlySet<string>;
  /**
   * Per-type property normalization shared with the deploy engine (issue
   * #1591). Threaded through the whole tree so a nested child's preview
   * narrows exactly like its apply.
   */
  canonicalizeProperties?: CanonicalizePropertiesFn;
  /**
   * The registry's answer, threaded through the whole tree so a nested child's
   * rows read the deploy's refusal too; see {@link CcRouteUnavailableReason}.
   * Optional only for hand-built walks, where every type counts as routable;
   * `cdkd diff` always passes it.
   */
  ccRouteUnavailableReason?: CcRouteUnavailableReason;
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
  /** As `computeStackDiff`'s `producerLookup`; handed to every node of the tree. */
  producerLookup?: ProducerLookup;
  /** As `computeStackDiff`'s `consumerAccount`; handed to every node of the tree. */
  consumerAccount?: string;
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
   * `templateIdentity` of every nested template ALREADY on the walk from the
   * root down to this node — the ancestor chain, not a global visited set
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
  /**
   * The parent node's printing corpus (go-to-k/cdkd#4049), see
   * {@link StackDiffResult.printingSecrets}. Absent at the root.
   */
  inheritedSecrets?: RecordedSecretValues;
  /**
   * The mask-only needles this child's row read from secret-named resources,
   * plus the parent's own (go-to-k/cdkd#3869); see `computeStackDiff`'s
   * option of the same name. Absent at the root.
   */
  inheritedDerivedNames?: RecordedSecretValues;
  /**
   * go-to-k/cdkd#4043 (review round 9): this child's parameters the parent row
   * fills from a `NoEcho` source; positioned as `NoEcho` ones, as the deploy's
   * child engine does. Absent at the root.
   */
  inheritedNoEchoParameters?: ReadonlySet<string>;
  /** The same under ANY verdict (go-to-k/cdkd#4723); absent at the root. */
  inheritedNoEchoParametersAnyVerdict?: ReadonlySet<string>;
  /**
   * The run's account flags (go-to-k/cdkd#4159), carried on every
   * malformed-record warning's `cdkd state show` pointer at every node.
   */
  refusalRecovery?: LockRecoveryContext;
  /** go-to-k/cdkd#4852: as `computeStackDiff`'s; absent at the root. */
  inheritedReferenceProvenance?: ReadonlyMap<string, ReferenceProvenance>;
  /** go-to-k/cdkd#4929: as `computeStackDiff`'s; absent at the root. */
  inheritedSecretTokens?: SecretTokensByParameter;
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
    parentUnresolvedParameters,
    canonicalizeProperties,
    ccRouteUnavailableReason,
    assetRedirect,
    cfnFallback,
    producerLookup,
    consumerAccount,
    previewOrphanAdoption,
    attributeHealerFor,
    ancestorTemplatePaths,
    isNestedChild,
    inheritedSecrets,
    inheritedDerivedNames,
    inheritedNoEchoParameters,
    inheritedNoEchoParametersAnyVerdict,
    refusalRecovery,
    inheritedReferenceProvenance,
    inheritedSecretTokens,
  } = args;
  const unboundHealer = attributeHealerFor?.(stackName, region);

  const { state, unreadable, unreadableContainers, deployRefusals, found } = await loadStateOrEmpty(
    stackName,
    region,
    stateBackend,
    refusalRecovery
  );
  // go-to-k/cdkd#3869: `computeStackDiff` binds each heal's printing bag over
  // the records it diffs; this node's child-parameter pass binds its own below.
  const attributeHealer = unboundHealer;
  // Warm the create-only DescribeType cache while the preprocessing below
  // runs, as `cdkd deploy` does (issue #3718). Without it `calculateDiff`
  // resolved each type inline, one resource at a time. Every node of a
  // `--recursive` walk passes through here, so a child's types are warmed when
  // the walk reaches it. Background and capped, never throws, and changes no
  // answer: the diff awaits the same per-type lookup it would otherwise start
  // itself.
  //
  // Only the types of template resources ALREADY IN STATE: create-only paths
  // decide an UPDATE, and only those can be one, so a first diff (all CREATE)
  // issues no call at all. Cancelled once this node's diff is computed —
  // an unneeded background lookup must never hold the command open.
  const createOnlyPrefetch = prefetchCreateOnlyPropertyPaths(
    templateResourceTypes(recordedTemplateResources(template, state))
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
  let stackDiff: StackDiffResult;
  try {
    stackDiff = await computeStackDiff(
      state,
      template,
      region,
      stackName,
      stateBackend,
      diffCalculator,
      {
        ...(parameters && { parameters }),
        ...(parentUnresolvedParameters && { parentUnresolvedParameters }),
        ...(canonicalizeProperties && { canonicalizeProperties }),
        ...(ccRouteUnavailableReason && { ccRouteUnavailableReason }),
        ...(cfnFallback !== undefined && { cfnFallback }),
        ...(producerLookup && { producerLookup }),
        ...(consumerAccount && { consumerAccount }),
        ...(previewOrphanAdoption && { previewOrphanAdoption }),
        ...(inheritedSecrets && { inheritedSecrets }),
        ...(inheritedDerivedNames && { inheritedDerivedNames }),
        ...(inheritedNoEchoParameters && { inheritedNoEchoParameters }),
        ...(inheritedNoEchoParametersAnyVerdict && { inheritedNoEchoParametersAnyVerdict }),
        ...(inheritedReferenceProvenance && { inheritedReferenceProvenance }),
        ...(inheritedSecretTokens && { inheritedSecretTokens }),
        ...(attributeHealer && { attributeHealer }),
        ...(refusalRecovery && { refusalRecovery }),
        // A live template of its own, so this node decides for itself; the
        // inherited flag only matters for the DELETED children below.
        inheritSecretBearingTemplate: false,
        previewMaskedInputs: !isNestedChild,
        nestedTemplates,
      }
    );
  } finally {
    createOnlyPrefetch.cancel();
  }
  const {
    changes,
    securityDiff,
    outputChanges,
    adoptedOrphans,
    adoptedRecords,
    blocking,
    unreadableOrphans,
    deployRefusals: adoptedDeployRefusals,
    effectiveTemplate,
    printingSecrets,
    derivedNames: nodeDerivedNames,
    secretNamedRecords: nodeStateNames,
    namingSecretsFor,
    resolvedParameters,
    conditions,
    knownConditions,
    trust,
  } = stackDiff;
  // The SAME state the diff read. `collectCcApiRoutes` reads `provisionedBy`
  // off each record for the sticky-Cloud-Control annotation, and an adopted
  // `cc-api` record is invisible in the un-spliced bag — the row would print
  // without `[via CC API: ...]` while the deploy routes it that way, which is
  // the inverse-of-truth annotation go-to-k/cdkd#2719 closed.
  const stateAfterAdoption =
    Object.keys(adoptedRecords).length > 0
      ? { ...state, resources: { ...state.resources, ...adoptedRecords } }
      : state;
  const ccApiRoutes = collectCcApiRoutes(
    effectiveTemplate,
    stateAfterAdoption,
    changes,
    ccRouteUnavailableReason ?? (() => undefined)
  );
  const node: DiffTreeNode = {
    stackName,
    displayName,
    region,
    changes,
    securityDiff,
    ccApiRoutes,
    outputChanges,
    adoptedOrphans,
    blocking: isNestedChild ? blocking : [...deployRefusals, ...adoptedDeployRefusals, ...blocking],
    // The load's dropped entries and containers, and the orphan records the
    // adoption preview could not read — each in its own field, so the report
    // says WHICH container is broken without a stand-in string an entry key
    // could spell (go-to-k/cdkd#3339). `--fail` asks one question of all three:
    // did the diff read everything?
    unreadable,
    unreadableContainers,
    unreadableOrphans,
    // The adopted records too, as for the routing annotation above: a removal
    // reads the `DeletionPolicy` the deploy will.
    destructiveChanges: findDestructiveChanges(
      stackName,
      changes.values(),
      stateAfterAdoption.resources,
      effectiveTemplate
    ),
    children: [],
  };
  if (found && !isNestedChild && node.blocking.length === 0) {
    node.refactorSides = hintSidesOf(changes.values(), rollbackOrphanIds(state.orphans));
  }
  if (!recursive) return node;

  // Template-present children, in template order (CREATE / UPDATE / present).
  // A condition-false row is absent here, so a child still in state falls
  // through to the state-only DELETE loop below.
  const templateChildIds = new Set<string>();
  for (const [logicalId, resource] of Object.entries(effectiveTemplate.Resources ?? {})) {
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
    // Keyed on `templateIdentity` — the file's name inside its REAL directory —
    // the key the deploy-side walk uses (go-to-k/cdkd#3450), so the two
    // commands agree about which assemblies are cyclic. A lexical key missed a
    // cycle spelled through a symlinked DIRECTORY (`d -> .`): each level joins
    // one more `d/` onto the same file, so the string never repeats and the
    // walk ran on to S3's key limit. The module's own doc says why the
    // directory is resolved and the file name is not.
    //
    // The MESSAGE keeps the lexical `path.resolve` spelling: it is the path
    // the assembly names, and the one the user can find in `cdk.out`.
    const resolvedChildPath = path.resolve(childTemplatePath);
    const childIdentity = templateIdentity(childTemplatePath);
    if (ancestorTemplatePaths?.has(childIdentity) === true) {
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
    const childAncestorTemplatePaths = new Set(ancestorTemplatePaths ?? []).add(childIdentity);
    const childTemplate = readNestedTemplate(childTemplatePath);
    // Index BEFORE the asset rewrite (go-to-k/cdkd#3450), the order
    // `NestedStackProvider.readChildTemplate` uses: the rewrite walks every
    // string, `Metadata['aws:asset:path']` included, so a path segment
    // spelling a bootstrap bucket name would otherwise send this walk to a
    // different file than the one the deploy follows.
    const grandchildTemplates = indexNestedChildTemplates(childTemplate, childTemplatePath);
    if (assetRedirect) {
      rewriteTemplateAssetReferences(childTemplate, assetRedirect);
    }
    // Resolve the child's input `Parameters` (declared on this parent's
    // `AWS::CloudFormation::Stack` row) against THIS node's deployed state,
    // its BOUND parameters and its condition verdicts (go-to-k/cdkd#4094), so
    // the child's diff resolver can resolve a `Ref` to one of those parameters
    // — mirroring the deploy engine's parent->child
    // `DeployEngineOptions.parameters` forwarding.
    //
    // `stateAfterAdoption`, not `state`: a child parameter whose value is a
    // `Ref` / `Fn::GetAtt` to a resource this node just adopted resolves on
    // the deploy path and would drop here, swallowed by the best-effort catch,
    // leaving the child preview degraded for a reason nothing prints.
    const childUnresolvedParameters = new Set<string>();
    // go-to-k/cdkd#4043 (review round 9): the child parameters this row fills
    // from a `NoEcho` source of THIS node, positioned as `NoEcho` in the child.
    const childNoEchoParameters = noEchoFedChildParameters(
      resource,
      new Set([...noEchoParameterNamesOf(effectiveTemplate), ...(inheritedNoEchoParameters ?? [])]),
      // Only the verdicts this diff knows (review round 10): an `Fn::If` on an
      // unknown one counts both branches, as at every other NoEcho site.
      knownConditions,
      stateAfterAdoption.resources
    );
    // The same under ANY verdict (go-to-k/cdkd#4723), for the child's
    // stale-alias gate only: a row's `Fn::If` today's verdict drops may have
    // fed the value when the child's alias was published.
    const childNoEchoParametersAnyVerdict = noEchoFedChildParameters(
      resource,
      new Set([
        ...noEchoParameterNamesOf(effectiveTemplate),
        ...(inheritedNoEchoParameters ?? []),
        ...(inheritedNoEchoParametersAnyVerdict ?? []),
      ]),
      undefined,
      stateAfterAdoption.resources
    );
    // go-to-k/cdkd#3869: the row's reads of a secret-named resource (a child
    // parameter fed `Fn::GetAtt SecretQueue.Arn`). The child binds that value
    // as its own parameter and prints it on its resolver and provider lines,
    // so its whole walk runs under these needles, and its rows mask with them.
    // Mask-only: never the child's `inheritedSecrets`, as on the deploy path.
    const rowDerivedNames: RecordedSecretValues = new Map();
    // go-to-k/cdkd#4929: the tokens in the child's parameter values that the
    // deploy's parent resolves to plaintext, so the child's `Fn::Split` keeps
    // them whole as the deploy's child keeps the plaintext.
    const childSecretTokens = new Map<string, ReadonlySet<string>>();
    const childParameters = await resolveChildStackParameters(
      resource,
      effectiveTemplate,
      stateAfterAdoption,
      region,
      stackName,
      stateBackend,
      resolvedParameters,
      conditions,
      cfnFallback,
      printingSecrets,
      // Load-bearing (go-to-k/cdkd#3869): the healers share one in-flight read
      // per record, which runs in the context of whichever caller asks FIRST.
      // A nested row the parent's state does not hold yet (a CREATE) has its
      // Parameters resolved here only, so this pass heals first and only this
      // binds the bag.
      // Judged with the node's per-record `NoEcho` bags, as its own heals are.
      attributeHealer &&
        healerUnderRecordPrintingBag(
          attributeHealer,
          () => stateAfterAdoption.resources ?? {},
          namingSecretsFor
        ),
      childUnresolvedParameters,
      trust,
      rowDerivedNames,
      producerLookup,
      consumerAccount,
      { inherited: inheritedSecretTokens, child: childSecretTokens }
    );
    // The parent's own secret-named records too (go-to-k/cdkd#3869): the
    // child's stored values can hold a name a row USED to pass down.
    const childDerivedNames = diffPrintingSecrets([
      inheritedDerivedNames,
      rowDerivedNames,
      nodeStateNames,
    ]);
    // go-to-k/cdkd#4852: the provenance snapshot the deploy's row would hand
    // this child, from this node's records. Only for a row the deploy
    // provisions: a NO_CHANGE row runs no child engine, so nothing promotes it.
    const childReferenceProvenance = inheritedProvenanceForChildDiff({
      row: resource,
      rowRecord: Object.hasOwn(stateAfterAdoption.resources, logicalId)
        ? stateAfterAdoption.resources[logicalId]
        : undefined,
      rowProvisioned: changes.get(logicalId)?.changeType === 'UPDATE',
      parentRecords: stateAfterAdoption.resources,
      parentTemplate: effectiveTemplate,
    });
    const buildChild = (): Promise<DiffTreeNode> =>
      buildDiffTree({
        stackName: childStackName,
        displayName: childStackName,
        region,
        template: childTemplate,
        nestedTemplates: grandchildTemplates,
        recursive: true,
        stateBackend,
        diffCalculator,
        parameters: childParameters,
        parentUnresolvedParameters: childUnresolvedParameters,
        ...(canonicalizeProperties && { canonicalizeProperties }),
        ...(ccRouteUnavailableReason && { ccRouteUnavailableReason }),
        ...(assetRedirect && { assetRedirect }),
        ...(cfnFallback !== undefined && { cfnFallback }),
        ...(producerLookup && { producerLookup }),
        ...(consumerAccount && { consumerAccount }),
        ...(previewOrphanAdoption && { previewOrphanAdoption }),
        ...(attributeHealerFor && { attributeHealerFor }),
        ancestorTemplatePaths: childAncestorTemplatePaths,
        isNestedChild: true,
        parentHasSecretReference: secretBearingAbove,
        inheritedSecrets: printingSecrets,
        ...(hasMaskableValues(childDerivedNames) && { inheritedDerivedNames: childDerivedNames }),
        ...(childNoEchoParameters.size > 0 && {
          inheritedNoEchoParameters: childNoEchoParameters,
        }),
        ...(childNoEchoParametersAnyVerdict.size > 0 && {
          inheritedNoEchoParametersAnyVerdict: childNoEchoParametersAnyVerdict,
        }),
        ...(refusalRecovery && { refusalRecovery }),
        ...(childReferenceProvenance && { inheritedReferenceProvenance: childReferenceProvenance }),
        ...(childSecretTokens.size > 0 && { inheritedSecretTokens: childSecretTokens }),
      });
    node.children.push(
      await (hasMaskableValues(childDerivedNames)
        ? withPrintingSecrets(childDerivedNames, buildChild)
        : buildChild())
    );
  }

  // The walk above follows CONDITION-PRUNED rows, so a cycle closing through a
  // condition-false row never reaches its ancestor check — while `cdkd deploy`
  // walks the RAW rows and refuses it (`refuseMalformedNestedTemplateTrees`).
  // One raw walk from the root keeps the two commands agreeing.
  // After the loop, not before it: an unpruned cycle is still refused by the
  // per-row check above, which names the row the way this command diffs it.
  if (!isNestedChild) {
    const defect = findNestedTemplateTreeDefect(nestedTemplates);
    if (defect) throw new Error(renderNestedTemplateTreeDefect(defect, stackName, 'diff'));
  }

  // State-only children (removed from the template, or condition-false →
  // recursive DELETE).
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
        secretBearingAbove,
        printingSecrets,
        refusalRecovery,
        // A deleted child's stored values can hold a name this node's records
        // spell from a secret even when no live row reads it any more.
        diffPrintingSecrets([nodeDerivedNames, nodeStateNames])
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
  parentHasSecretReference: boolean,
  // The nearest live node's printing corpus (go-to-k/cdkd#4049): a REMOVE
  // row's stored value can hold a `NoEcho` value that node passed down.
  inheritedSecrets: RecordedSecretValues,
  // go-to-k/cdkd#4159: the run's account flags, as at a live node.
  refusalRecovery: LockRecoveryContext | undefined,
  // go-to-k/cdkd#3869: the nearest live node's mask-only derived names. A
  // stored value can hold a secret-derived name a row passed down, and these
  // rows print after any bound bag is gone.
  inheritedDerivedNames: RecordedSecretValues
): Promise<DiffTreeNode> {
  const { state, unreadable, unreadableContainers } = await loadStateOrEmpty(
    stackName,
    region,
    stateBackend,
    refusalRecovery
  );
  // Its own secret-named records too: a nested stack it held may store them.
  const derivedNames = diffPrintingSecrets([
    inheritedDerivedNames,
    stateDerivedNames(state.resources ?? {}),
  ]);
  const { changes, securityDiff, outputChanges } = await computeStackDiff(
    state,
    EMPTY_TEMPLATE,
    region,
    stackName,
    stateBackend,
    diffCalculator,
    {
      inheritSecretBearingTemplate: parentHasSecretReference,
      inheritedSecrets,
      ...(hasMaskableValues(derivedNames) && { inheritedDerivedNames: derivedNames }),
      ...(refusalRecovery && { refusalRecovery }),
    }
  );
  const node: DiffTreeNode = {
    stackName,
    displayName: stackName,
    region,
    changes,
    securityDiff,
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
    unreadableContainers,
    // No adoption preview runs here (see `adoptedOrphans`), so no orphan record
    // is dropped by one.
    unreadableOrphans: [],
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
    // Every row is a DELETE: destroying the child removes each of its
    // resources under its own recorded `DeletionPolicy`.
    destructiveChanges: findDestructiveChanges(stackName, changes.values(), state.resources),
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
        parentHasSecretReference,
        inheritedSecrets,
        refusalRecovery,
        derivedNames
      )
    );
  }
  return node;
}

/**
 * The name needles of every record in `resources` named from a secret
 * (go-to-k/cdkd#3869), as one MASK-ONLY bag of log-only needles, for the
 * stored values of a nested child below (a deleted subtree's rows, a live
 * child's OLD sides): judged from the records alone, since no live row reads
 * them. Over-masking costs nothing here; `cdkd diff` writes nothing.
 */
function stateDerivedNames(resources: Record<string, ResourceState>): RecordedSecretValues {
  return secretNamedRecordNeedles(resources, undefined);
}
