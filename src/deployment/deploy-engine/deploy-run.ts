import type { DeployEngine } from '../deploy-engine.js';
import { withStackScopeBeforeStateRead } from '../../provisioning/resource-name.js';
import {
  ledgerForStack,
  withCreateTokenLedger,
} from '../../provisioning/providers/create-token-ledger.js';
import { ReplacementRunState } from './replacement.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import {
  prefetchCreateOnlyPropertyPaths,
  templateResourceTypes,
} from '../../provisioning/create-only-properties.js';
import { hasNoRegistrySchema } from '../../provisioning/describe-type.js';
import type { DeployResult } from './options.js';
import { OutputsRunState } from './outputs.js';
import { SecretsRunState } from './masking.js';
import { doDeployWithPrefetch } from './deploy-flow.js';
import { NoEchoRunState } from './noecho.js';

export function deploy(
  this: DeployEngine,
  stackName: string,
  template: CloudFormationTemplate
): Promise<DeployResult> {
  // Reset per-session state. `recordedImports` is the bag the
  // resolver pushes Fn::ImportValue resolutions into; it lands in
  // `state.imports` at deploy save time. `recordedOutputReads`
  // is the v8 sibling for Fn::GetStackOutput, landing in
  // `state.outputReads`.
  this.recordedImports = [];
  this.recordedOutputReads = [];
  // Replaces all ten secret-masking / fingerprint fields at once
  // (`SecretsRunState`). `perResourceResolvedType` is reset with its
  // siblings (issue #2934). Inert today — a stale TRUE pairs with cleared
  // needle maps and reduces to the identity fallback — but that map's whole
  // job is to answer "do those needles describe THIS record", and a reused
  // engine carrying last deploy's answer is the #2516 class.
  this.secretsRun = new SecretsRunState();
  // Replaces all ten `NoEcho` positional-arm fields at once (`NoEchoRunState`).
  this.noEchoRun = new NoEchoRunState();
  // Replaces all ten replacement-bookkeeping fields at once
  // (`ReplacementRunState`). Issue #2603: an engine can be reused across
  // deploys, and a STALE `true` in `retainedOldOnReplacement` would tell the
  // next run's rollback to re-adopt an id this run deleted. Reset in the
  // same block as the other per-run bags.
  this.replacementRun = new ReplacementRunState();
  // Issue #2516: reset with the other per-deploy maps. A reused engine
  // whose next deploy fails before its own attempted bag is recorded would
  // otherwise journal the PREVIOUS run's bag against today's template and
  // pairs — and now mark it as today's.
  this.attemptedResolvedProps = new Map();
  this.unsettledMarks = new Map();
  this.unsettledItemMarks = new Map();
  this.resumedCreates = new Map();
  this.generatedNameGuard = undefined;
  this.liveTaskLabels = new Map();
  // Replaces all ten Outputs-pass fields at once (`OutputsRunState`): the
  // per-deploy reset. `resolvedExportNames` and `carriedExportAliasRefusal`
  // are ALSO reset per PASS at the top of `resolveOutputs`, since they
  // describe the last pass, not the deploy. In
  // particular `skippedOutputs` (issue #2740, same reuse hazard as
  // `replacementRun.retainedOldOnReplacement` above: `resolveOutputs` recomputes it at the
  // END of a pass but early-returns for a template with no `Outputs`
  // without touching it) and `outputsTemplateSource` (issue #1943's class /
  // #2740's `__proto__` case: null-prototype, keyed by TEMPLATE-CONTROLLED
  // output names, same as the bag it positions).
  this.outputsRun = new OutputsRunState();
  this.provenanceBaseline = undefined;
  this.provenanceCapture = this.freshProvenanceCapture();
  this.observedCapture = this.freshObservedCapture();
  // Issue #1852: per-deploy, like every bag above — a reused engine must not
  // serve last deploy's read, nor persist it against today's records.
  this.rebaseline({});
  this.runProducerRegionEvidence = undefined;
  this.deployChanges = new Map();
  this.deployStateResources = {};
  this.inlinePolicyWriters = new Map();
  // Per-deploy-run counter: the resolver instance is engine-scoped and an
  // engine can be reused across deploys, so reset here (not in the
  // resolver constructor) to keep the deploy-summary count per run.
  this.resolver.resetPhysicalIdFallbackCount();
  // Scope `stackName` to this deploy's async chain so concurrent
  // deploys (--stack-concurrency > 1) don't see each other's value.
  // See `src/provisioning/resource-name.ts` for the AsyncLocalStorage
  // background. go-to-k/cdkd#5064: the stack's instance id is in its state
  // record, which `doDeployWithPrefetch` reads under the lock and then opens
  // the id-bearing `withStackScope` for everything that names a resource;
  // until then a generated name is refused rather than derived without it.
  // go-to-k/cdkd#4438: the stack's create-token ledger, which the EFS, FSx
  // and CloudFront OAI providers fold into their lifetime-bound create
  // tokens (`src/provisioning/providers/create-token-ledger.ts`).
  const ledger = ledgerForStack(this.stateBackend, stackName, this.stackRegion);
  return withStackScopeBeforeStateRead(stackName, () =>
    this.options.dryRun
      ? this.doDeploy(stackName, template)
      : withCreateTokenLedger(ledger, () => this.doDeploy(stackName, template))
  );
}

export async function doDeploy(
  this: DeployEngine,
  stackName: string,
  template: CloudFormationTemplate
): Promise<DeployResult> {
  // Warm the create-only DescribeType cache in parallel with the lock + state
  // read below. calculateDiff (further down) resolves each UPDATE resource's
  // create-only property paths via cloudformation:DescribeType (~0.8s cold per
  // type, cached per-type for the deploy lifetime). Kicking those lookups off
  // here for the template's distinct resource types — fire-and-forget — lets
  // the diff's awaits hit a warm cache instead of paying the round-trip inline
  // on the critical path. prefetchCreateOnlyPropertyPaths is idempotent
  // (per-type module cache) and never throws, and the diff awaits the same
  // per-type lookups, so this is pure latency-hiding with no correctness
  // impact. Custom types short-
  // circuit without an API call; on a pure-CREATE (first) deploy the diff makes
  // no create-only lookups at all, so the prefetched entries simply go unused
  // that run — bounded, deduped, non-blocking waste, never a correctness issue.
  // Part of #1180.
  //
  // Schema-less types are filtered out: `AWS::CDK::Metadata` (the CDK
  // construct-tree sentinel every synthesized template carries) and custom
  // resources have no CloudFormation registry entry, so DescribeType can
  // only fail for them. Before the filter, every single deploy burned one
  // guaranteed-to-fail API call on the metadata sentinel AND printed a
  // "Grant cloudformation:DescribeType ..." warning naming a pseudo-resource
  // the user cannot act on. The diff / type-validation / property-validation
  // passes below already exclude `AWS::CDK::Metadata`; this makes the
  // prefetch consistent with them. `hasNoRegistrySchema` short-circuits
  // inside the resolver too, so this filter is the cheap outer guard.
  //
  // The prefetch runs as BACKGROUND DescribeType calls under the shared
  // concurrency cap (issue #3718): an unbounded 134-type burst throttled
  // almost half its calls, and a lookup whose retries ran out lost the
  // live schema. The diff's own awaited lookups queue ahead of it.
  //
  // Cancelled when the deploy finishes, on every path (issue #3718): the
  // prefetch is opportunistic, and an unfinished background lookup must not
  // keep a finished deploy's process alive. The handle is this engine's own,
  // so a nested child engine finishing cannot withdraw its parent's calls.
  const createOnlyPrefetch = prefetchCreateOnlyPropertyPaths(
    templateResourceTypes(template.Resources).filter((type) => !hasNoRegistrySchema(type))
  );
  try {
    return await doDeployWithPrefetch(this, stackName, template, createOnlyPrefetch);
  } finally {
    createOnlyPrefetch.cancel();
  }
}
