import type { NestedStackProvider } from '../nested-stack-provider.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import { DeployEngine } from '../../../deployment/deploy-engine.js';
import { getCurrentResourceSecrets } from '../../../deployment/resource-secrets-scope.js';
import { snapshotPassProvenance } from '../../../deployment/secret-redaction/reference-provenance.js';
import { passedParameterClassesOf } from '../../../deployment/masked-property-fingerprints.js';
import { getCurrentProducerRegions } from '../../../deployment/producer-regions-scope.js';
import {
  withNestedStackContext,
  type NestedStackProviderContext,
} from '../../nested-stack-context.js';
import {
  hasMaskableValues,
  passedNoEchoParametersOf,
  physicalNameCopiesOf,
} from '../../../deployment/secret-redaction.js';

export async function runChildDeploy(
  this: NestedStackProvider,
  parentCtx: NestedStackProviderContext,
  logicalId: string,
  childStackName: string,
  childRegion: string,
  childTemplate: CloudFormationTemplate,
  childParameters: Record<string, string>,
  grandchildTemplates: Record<string, string>
): Promise<number> {
  // Issue #1903. The parent resolved this row's `Parameters` block before
  // calling us, so `childParameters` above holds PLAINTEXT for any parameter
  // fed by a `{{resolve:secretsmanager:...}}` / SecureString `{{resolve:ssm:...}}`
  // reference — and the child's template spells the consumption as
  // `{Ref: <ParamName>}`, an intrinsic OBJECT, so nothing in the child's own
  // resolution can ever record the plaintext -> expression pair its state-save
  // choke point redacts from. The parent's bag for THIS resource is exactly
  // that set of pairs; hand it down as the child engine's seed.
  //
  // TWO binders, not one (issue
  // [#2086](https://github.com/go-to-k/cdkd/issues/2086)): the deploy engine
  // around its provider CREATE / UPDATE sites, and `rollback-executor.ts`
  // around its own, where `resolveReplayProps` has just re-resolved the
  // journal's `{{resolve:...}}` back to plaintext. A rollback reaches this
  // method only through `create()` — a reverse-replacement replay re-creating
  // this row — since a revert of the row passes `UpdateContext.replayingState`
  // and `update()` returns through the journal-replay arm (issue #3754).
  //
  // `undefined` whenever no binder is on the stack (tests, and any future
  // non-deploy driver), which the child engine reads as "nothing to inherit"
  // — the pre-#1903 behaviour. Of the rollback drivers, only the in-process
  // auto-rollback's own rows get here, in its deploy-mode context. Standalone `cdkd rollback`
  // and a nested child's journal replay (`nested-child-journal.ts`) never
  // do: both contexts carry no templates, so a re-create throws at
  // `requireDeployContext`.
  //
  // SCOPED PER RESOURCE, not per stack. What the child engine does with this
  // map is record a pair into a resource's own bag at the moment that
  // resource's `{Ref: <Param>}` resolves to a value carrying the plaintext —
  // NOT pre-seed every resource's bag, which is what the first cut did and
  // what issue [#2087](https://github.com/go-to-k/cdkd/issues/2087) is about.
  //
  // Never enumerate or log this map's KEYS: they are secret plaintext. It is
  // passed on and nothing else.
  const inheritedSecrets = getCurrentResourceSecrets();
  const passedClasses = passedParameterClassesOf(inheritedSecrets);
  const childEngine = new DeployEngine(
    parentCtx.stateBackend,
    parentCtx.lockManager,
    parentCtx.dagBuilder!,
    parentCtx.diffCalculator!,
    parentCtx.providerRegistry,
    {
      // THIS SPREAD IS THE PARENT→CHILD OPTION BOUNDARY. Anything the parent
      // validated against ITS OWN template / state / live AWS arrives here
      // unvalidated for the child, so an option carrying user-named
      // identifiers must be scoped to the stack it was validated against
      // rather than re-matched blind (issue
      // [#2567](https://github.com/go-to-k/cdkd/issues/2567), where
      // `--recreate-via-*` targets were a bare id set and matched a child
      // resource that merely SHARED a logical id, skipping the child's
      // stateful guard).
      //
      // Which `DeployEngineOptions` members name a stack, or a resource in
      // one, is a judgment recorded HERE; what
      // `tests/unit/provisioning/nested-stack-option-boundary-audit.test.ts`
      // does is refuse to let a member reach this spread without that
      // judgment having been made — it is a membership fence and cannot
      // decide scoping for you. No count is written in this paragraph,
      // because a count is the part that rots.
      //
      // `recreateTargets`, `pinCcApi`, `onCurrentStateLoaded` and
      // `onFirstDeployLeftNoRecord` (go-to-k/cdkd#4705) SELF-SCOPE,
      // so inheriting them is inert: the first two match only while deploying
      // their own `stackName` (`pinCcApi` gained that shape in issue #2719
      // for exactly this reason -- it started as a bare logical-id Set), the
      // third (the prefix-migration gate) and the fourth (the registry
      // release) return early on a stack-name mismatch. The child deploys as `<parent>~<logicalId>`
      // and CDK's stack-name rule bars `~`, so neither can match in a
      // descendant. `parentStackInfo` and `eventRecorder` are stack-named but
      // are not decisions ABOUT a stack: the first is overwritten a few lines
      // below (it must describe THIS child), and the second carries the
      // top-level run's stack name because a nested child's resource events
      // belong to the parent's run by design.
      //
      // Two more things cross this boundary deliberately unscoped, and this
      // comment is not a claim that they are scoped. Neither picks out a
      // particular resource, which is why neither appears in the paragraph
      // above — whose subject is an option naming a specific stack, or one
      // resource in one. The consent flags name no resource at all:
      // `forceStatefulRecreation` (documented in `docs/cli-deploy-safety.md`
      // as clearing the guard for every target in the RUN), `replace`
      // (documented there as a STACK-WIDE opt-in that fires wherever an
      // update hard-rejects), and `skipFinalSnapshot` (`docs/cli-destroy.md`).
      // And `parentCtx.providerRegistry`, one argument above this bag,
      // carries the `--allow-unsupported-types` /
      // `--allow-unsupported-properties` allow-lists, keyed by resource TYPE
      // and `Type:Property` -- a per-type opt-in whose meaning does not
      // change between stacks. What #2567 was about is a per-STACK identifier
      // deciding an action, and there are now two: `recreateTargets` (a
      // destructive one) and `pinCcApi` (issue #2719 -- a routing one, which
      // is quieter and therefore easier to get wrong: a pin that matches in
      // the wrong stack produces no output at all).
      ...(parentCtx.options ?? {}),
      // Always overwrite (never spread-inherit) parameters: the parent's
      // `--parameters Foo=Bar` CLI option lives in `parentCtx.options.parameters`,
      // and inheriting it would silently leak into the child if the child
      // template happens to declare a same-named parameter the user did
      // not intend to set. The child's own parameters come from
      // `properties.Parameters` on its `AWS::CloudFormation::Stack`
      // resource — that's the authoritative source.
      parameters: childParameters,
      // go-to-k/cdkd#4705: the cross-prefix destructive-plan check is the
      // TOP-LEVEL stack's, taken before the parent's first provider call
      // (a nested-stack row added or updated in the parent's plan triggers
      // it). A child running it mid-parent-deploy would refuse after the
      // parent changed things.
      onDestructivePlan: undefined,
      // `crossPrefixHolder` IS inherited (go-to-k/cdkd#4705 review R6-2): a
      // child's creates can be handed resources its twin under another
      // prefix records (`Parent~Child`), and the child's AUTOMATIC rollback
      // asks it, by the child's own name, before deleting one. A child never
      // settles a journal, so that is its only use there.
      // `hasMaskableValues`, not `size` (go-to-k/cdkd#1998): a bag holding
      // only LOG-ONLY needles (a `NoEcho` parameter's value) still masks the
      // child's lines and is carried into its consuming resources' bags.
      ...(inheritedSecrets && hasMaskableValues(inheritedSecrets) && { inheritedSecrets }),
      // go-to-k/cdkd#4819: the physical ids the row read, ungated: a row
      // passing only `Ref Queue` records a copy and no maskable value, and
      // a child resource spelling the secret itself must still keep it.
      // Always set, so a grandchild never inherits its grandparent's.
      inheritedPhysicalNameCopies: inheritedPhysicalNameCopiesOf(inheritedSecrets),
      // State schema v12 (go-to-k/cdkd#4852): the provenance the row's
      // resolution recorded, frozen now. Always set, so a grandchild never
      // inherits its grandparent's.
      inheritedReferenceProvenance: snapshotPassProvenance(inheritedSecrets),
      // go-to-k/cdkd#4543: how the parent classified each value it passes
      // (recorded on the same bag), so the child hashes a clean one into a
      // masked property's input fingerprint and keeps the rest as written.
      ...(passedClasses && { passedParameterClasses: passedClasses }),
      // go-to-k/cdkd#4043 (review round 10): which child parameters the row
      // fills from a `NoEcho` source, read off the same bag but NOT gated
      // on `hasMaskableValues`: a short value or a Number leaves the bag
      // otherwise empty. Always set, so a grandchild never inherits it.
      passedNoEchoParameters: passedNoEchoParametersOf(inheritedSecrets),
      // go-to-k/cdkd#4174: the parent engine's producer regions, for the
      // child's own in-process rollback. Always overwritten: none bound
      // (no parent engine on the stack) reads as incomplete in the child.
      inheritedProducerRegions: getCurrentProducerRegions(),
      parentStackInfo: {
        parentStack: parentCtx.parentStackName,
        parentLogicalId: logicalId,
        parentRegion: parentCtx.parentRegion,
      },
    },
    childRegion,
    parentCtx.exportIndexStore
  );

  const childCtx: NestedStackProviderContext = {
    ...parentCtx,
    parentStackName: childStackName,
    parentRegion: childRegion,
    nestedTemplates: grandchildTemplates,
    // The PARENT row's slot never reaches the child: the child engine binds
    // its own per row, and a grandchild writing straight into this one would
    // be counted again through the child's `DeployResult` below.
    childUnaddressed: undefined,
  };

  const childResult = await withNestedStackContext(childCtx, () =>
    childEngine.deploy(childStackName, childTemplate)
  );
  // Issue #1989: hand what the child left unaddressed to the parent engine,
  // which adds it to this run's counters -- the summary rows, `RunCounts`
  // and the exit code. `childResult` already carries the grandchildren's.
  // Should one row ever run the child twice (this provider sets
  // `disableOuterRetry`, so today it does not), the two counters differ: a
  // skipped DELETE keeps its record and is counted again by the re-run, so
  // the LAST report holds it; an orphaned predecessor is untracked, so the
  // re-run diffs that row NO_CHANGE and reports 0 -- it must ADD, or the
  // survivor drops out of the exit code.
  const slot = parentCtx.childUnaddressed;
  if (slot) {
    slot.last = {
      deleteSkipped: childResult.deleteSkipped,
      updatePartial: (slot.last?.updatePartial ?? 0) + childResult.updatePartial,
    };
  }
  // Issue #4453: the skipped DELETEs (this child's and every descendant's)
  // that the next deploy must re-attempt. See `PENDING_CHILD_DELETES_KEY`.
  return childResult.deleteSkipped;
}

/**
 * The `inheritedPhysicalNameCopies` option for a child engine: a snapshot of
 * the physical ids the parent row's resolution read (go-to-k/cdkd#4810), or
 * `undefined` when it read none (go-to-k/cdkd#4819).
 */
function inheritedPhysicalNameCopiesOf(
  bag: ReturnType<typeof getCurrentResourceSecrets>
): ReadonlySet<string> | undefined {
  const copies = bag === undefined ? undefined : physicalNameCopiesOf.get(bag);
  return copies === undefined || copies.size === 0 ? undefined : new Set(copies);
}
