import { freshNoEchoParametersWithDeclared, noEchoDiffComparison } from '../noecho.js';
import { diffLogMasker, redactParametersForDiff } from '../masking.js';
import { makeCanonicalizePropertiesFn } from '../../../provisioning/canonicalize-properties.js';
import { recreateTargetIdsFor } from '../../recreate-target-promotion.js';
import { crossStackOutputProvenanceSource } from '../../read-provenance-sources.js';
import type { CrossStackRead } from '../../intrinsic-resolver/context.js';
import { buildResolverContext, maskedInputSources } from '../resolver-context.js';
import type { DeployEngine } from '../../deploy-engine.js';
import type { StackState } from '../../../types/state.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { PhaseClock } from '../../../utils/phase-timings.js';

/**
 * Step 5 of a deploy: the diff, with the resolver context it ran on (moved
 * from `deploy-flow.ts`).
 */
export async function calculateDeployDiff(
  engine: DeployEngine,
  {
    stackName,
    currentState,
    effectiveTemplate,
    parameterValues,
    conditions,
    clock,
    forcedNestedChildRuns,
  }: {
    stackName: string;
    currentState: StackState;
    effectiveTemplate: CloudFormationTemplate;
    parameterValues: Record<string, unknown>;
    conditions: Record<string, boolean>;
    clock: PhaseClock;
    /** go-to-k/cdkd#6282: see `DiffCalculator.calculateDiff`'s parameter. */
    forcedNestedChildRuns?: ReadonlySet<string> | undefined;
  }
) {
  // 5. Calculate diff
  // Pass a best-effort resolver so that changes hidden inside intrinsics (e.g.
  // `Fn::Join` literal args like "-value" -> "-value2") are detected against
  // the already-resolved values stored in state.
  const diffResolverContext = buildResolverContext(
    engine.resolverContextDeps(),
    {
      template: effectiveTemplate,
      resources: currentState.resources,
      // The DIFF side binds the REDACTED parameter bag on a nested-stack
      // child (issue #1903). The provisioning contexts below deliberately
      // keep `parameterValues` — the real values are what reach AWS — and
      // so does the condition evaluation above, where substituting an
      // expression would flip an `Fn::Equals` over a parameter. See
      // `redactParametersForDiff`.
      parameters: redactParametersForDiff(engine.maskingDeps(), parameterValues),
      conditions,
    },
    stackName
  );
  // The diff-phase resolution is best-effort (the calculator catches
  // failures and keeps the raw intrinsic): a Ref to a resource this
  // same deploy will CREATE is the expected case, so the resolver logs
  // it at debug, not warn (issue #1017). The provisioning-phase
  // resolver contexts do NOT set this — there, an unresolvable Ref is
  // a genuine error signal.
  diffResolverContext.bestEffort = true;
  // Leave SECRET `{{resolve:...}}` dynamic references UNRESOLVED for the
  // diff (GHSA fix): state now stores the unresolved expression, so
  // comparing the desired side as its expression too avoids a spurious
  // perpetual UPDATE on every deploy of a secret-bearing resource, and
  // fetches no secret value at plan time. `cdkd diff --recursive` sets the
  // same flag when it resolves a nested child's input `Parameters`
  // (`resolveChildStackParameters`) — as of issue #1903, together with the
  // child-state half that makes the comparison self-consistent; setting it
  // there alone would have compared an expression against a child state
  // still holding plaintext. A changed expression still diffs.
  // An `ssm` reference is classified by the parameter's TYPE rather than by
  // its spelling (issue #1901), so unlike the secretsmanager case the diff
  // DOES issue one `GetParameter` per not-yet-classified reference — with
  // `WithDecryption: false`, so a `SecureString` never yields plaintext
  // here, while a `String` / `StringList` keeps resolving as the public
  // config state stores resolved.
  diffResolverContext.skipDynamicReferences = true;
  // go-to-k/cdkd#4852: which producer output each cross-stack read of the
  // diff pass read, for the read-provenance arm below.
  const crossStackReads = new Map<string, CrossStackRead>();
  diffResolverContext.crossStackReads = crossStackReads;
  const diffResolveFn = (value: unknown) => engine.resolver.resolve(value, diffResolverContext);
  const maskedInputSourcesForDiff = maskedInputSources(
    engine.resolverContextDeps(),
    effectiveTemplate,
    currentState.resources,
    conditions,
    stackName
  );
  const maskedInputs = maskedInputSourcesForDiff && {
    sources: maskedInputSourcesForDiff,
    rebaselined: new Map<string, Record<string, string>>(),
  };
  clock.lap('journal, parameters, conditions, DAG build');
  const changes = await engine.diffCalculator.calculateDiff(
    currentState,
    effectiveTemplate,
    diffResolveFn,
    // Shared with `cdkd diff` (issue #1591): a preview that narrows
    // differently from the apply forecasts a change the deploy will never
    // make, which is this issue's own bug class moved one command over.
    makeCanonicalizePropertiesFn(engine.providerRegistry),
    // Issue #2750: the drops THIS deploy opted into via
    // `--allow-unsupported-properties` are not written, so comparing them
    // would report a change the SDK route will never make. `cdkd diff`
    // passes nothing here and that is correct — it registers no such flag,
    // so its preview is of a FLAG-LESS deploy, which is the one that
    // auto-routes and does write the property.
    //
    // Optional call for the TEST DOUBLES only. Many unit files hand-build
    // a registry object literal and cast it in; an unconditional call
    // failed 39 test FILES / 270 cases across `tests/unit/{deployment,cli}`
    // when measured, which is a count of what BROKE, not a survey of the
    // doubles. The sibling `makeCanonicalizePropertiesFn` survives them
    // only because it defers its registry reads into a closure the mocked
    // DiffCalculator never invokes. `undefined` degrades to "no flag",
    // which is what every one of those doubles means. The real class
    // always has the method — `providerRegistry` is typed as the concrete
    // class, so the `undefined` branch is unreachable in production, and
    // the method's existence is pinned directly on `ProviderRegistry` by
    // `provider-registry-report-sdk-unwired.test.ts`, since a mocked
    // registry cannot witness the real one losing it.
    engine.providerRegistry.getAllowedUnsupportedProperties?.(),
    // go-to-k/cdkd#3717: a nested child's parameters carrying a `NoEcho`
    // value the parent supplied in THIS deploy. The diff side binds the
    // redacted bag above, where such a value is `***` like its record, so
    // the calculator promotes each reader instead.
    // go-to-k/cdkd#4043: and EVERY `NoEcho: true` parameter of this
    // template, at every level. Its readers persist `***`, so the diff
    // cannot see a changed value; each is promoted and the engine decides
    // with the value in hand (a readback, or the migration witness).
    // Review round 9: a nested child's parameters its parent fills from a
    // `NoEcho` source too (`inheritedNoEchoParameters`, set above).
    freshNoEchoParametersWithDeclared(
      engine.noEchoRun.inheritedNoEchoParameters,
      effectiveTemplate
    ),
    // go-to-k/cdkd#4049: the diff pass resolves a `Ref` to a `NoEcho`
    // parameter to its plaintext and records it as a log-only needle of
    // THIS context's bag, so the calculator's replacement line masks with
    // it (and with a nested child's inherited bag). Printing only: the
    // changes it returns are unmasked.
    // go-to-k/cdkd#3869: and the name spellings of each record named from
    // a secret, for an OLD side no read of the diff pass names.
    diffLogMasker(
      engine.secretsRun,
      engine.maskingDeps(),
      diffResolverContext.recordedSecretValues,
      effectiveTemplate,
      parameterValues,
      currentState.resources
    ),
    // go-to-k/cdkd#4383: a recreate target is destroyed and re-created, so
    // its same-stack readers are promoted as for a property-driven
    // replacement, before anything below counts the changes. This stack's
    // targets only, never a nested child's or another stack's.
    recreateTargetIdsFor(engine.options.recreateTargets, stackName),
    // go-to-k/cdkd#4543: a masked property's resolved inputs, so a changed
    // parameter or flipped condition behind unchanged template text diffs.
    // A layout-1 fingerprint whose text still matches is re-baselined to
    // layout 2 from these same inputs, stamped below without sending.
    maskedInputs,
    // go-to-k/cdkd#4159: the account flags the load's refusals above carry.
    engine.options.refusalRecovery,
    // go-to-k/cdkd#4043: compare what the persist side writes for a value
    // a `NoEcho` source served, and read a pre-v11 record's plaintext as
    // the migration witness.
    noEchoDiffComparison(
      engine.noEchoRun,
      engine.noEchoDeps(),
      currentState.resources,
      effectiveTemplate,
      conditions,
      parameterValues,
      stackName
    ),
    // State schema v12 (go-to-k/cdkd#4852): the read-provenance arm's
    // members outside this stack's records. A nested child's inherited
    // snapshot, and each producer output a consumer read, through the run's
    // producer-state cache (the consumer's provisioning reuses the read).
    {
      ...(engine.options.inheritedReferenceProvenance && {
        inherited: engine.options.inheritedReferenceProvenance,
      }),
      crossStackOutputs: crossStackOutputProvenanceSource(
        crossStackReads,
        engine.recordedImports,
        engine.stateBackend
      ),
    },
    forcedNestedChildRuns
  );
  return { diffResolverContext, maskedInputs, changes };
}
