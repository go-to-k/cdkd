import { getLogger } from '../../../utils/logger.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { S3StateBackend } from '../../../state/s3-state-backend.js';
import { stackIdTailOf } from '../../../state/stack-id-tail.js';
import {
  IntrinsicFunctionResolver,
  isUnboundTemplateParameter,
} from '../../../deployment/intrinsic-function-resolver.js';
import { maskSecretsInText, redactForState } from '../../../deployment/secret-redaction.js';
import { divergentParameterNames, type DeployedParameters } from '../import-deployed-parameters.js';
import {
  computeParameterTaint,
  reachableDivergentParameters,
  type ParameterTaint,
} from '../../../analyzer/parameter-dependence.js';
import { displayIdent, displayStackName } from '../../../utils/display-safe.js';
import { plainOrDescribed } from '../../../utils/pasteable-command.js';
import { logicalIdShown, resourceTypeShown } from '../../../provisioning/composite-id.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { StackState } from '../../../types/state.js';
import { stateSecretNameNeedles } from '../../../deployment/secret-name-needles.js';
import {
  countDynamicReferenceOpeners,
  resolveDiscardsNonInertSubtree,
} from './discarded-subtree.js';
import { positionImportedNoEcho } from './noecho-position.js';
import type { NoEchoImportInput } from './noecho-position.js';
import { ObservedBaselineRefusals } from './types.js';

/**
 * The same template with its `Parameters` section narrowed to the entries that
 * carry a `Default`, for the `resolveParameters` retry in
 * {@link resolveImportedProperties} (issue
 * [#2321](https://github.com/go-to-k/cdkd/issues/2321)).
 *
 * Presence is tested with `'Default' in definition`, NOT `Default !== undefined`,
 * because that is the test both `resolveParameters` and
 * `isUnboundTemplateParameter` use: a key present with an `undefined` value is
 * a binding to `undefined` for them, and a filter that disagreed would hand the
 * retry a parameter it would then throw on.
 *
 * Everything OUTSIDE `Parameters` is carried through untouched — `Resources` in
 * particular, because `resolveParameters` walks it to decide which SSM-typed
 * defaults are actually referenced and worth a `GetParameter` call.
 */
function defaultOnlyParameterTemplate(template: CloudFormationTemplate): CloudFormationTemplate {
  const declared = template.Parameters;
  if (declared === undefined || declared === null || typeof declared !== 'object') {
    return template;
  }
  const defaulted = Object.fromEntries(
    Object.entries(declared).filter(
      ([, definition]) =>
        definition !== null && typeof definition === 'object' && 'Default' in definition
    )
  );
  return { ...template, Parameters: defaulted };
}

/**
 * Walk every resource in `stackState.resources` and overwrite its
 * `properties` with the result of running the synth template's raw
 * Properties through `IntrinsicFunctionResolver` against the assembled
 * state map.
 *
 * Closes issue #328. `cdkd deploy` runs the resolver against each
 * resource's Properties before calling `provider.create()` and stores
 * the resolved shape in state — this brings `cdkd import` in line so
 * the v3 schema's `properties` field consistently holds "resolved
 * template intent" (post-intrinsic substitution) across both write
 * paths. Without this, sub-resource types whose `delete()` reads
 * properties at delete time (e.g. `AWS::Lambda::Permission` whose
 * `FunctionName` is `{Fn::GetAtt: [..., 'Arn']}`) get raw intrinsic
 * objects passed to the AWS SDK and fail validation.
 *
 * The resolver is run AFTER all `provider.import()` calls finish, so by
 * the time it walks each resource every logicalId in the importable set
 * has a known `physicalId` in `stackState.resources` for Ref / GetAtt
 * to bind against.
 *
 * Edge cases:
 *   - Parameters / Conditions are resolved from the template up front
 *     (same shape the deploy engine builds for its CREATE / UPDATE
 *     intrinsic context). A parameter-resolution failure means the
 *     template declares a parameter with no `Default`, which an import
 *     cannot bind; it logs and RETRIES over the `Default`-carrying
 *     parameters alone (issue #2321) so one unbindable parameter does
 *     not discard the defaults its siblings declare. The resolver
 *     itself tolerates missing parameter / condition entries.
 *   - Per-resource try/catch: if a Properties tree references a
 *     resource not in the importable set (custom resource that wasn't
 *     adopted, out-of-scope sibling in selective mode), the resolver
 *     throws `Ref <X> not found` / `Resource <X> not found for
 *     Fn::GetAtt`. We log the failure and leave the resource's
 *     original properties intact. The eventual `cdkd destroy` failure
 *     on the un-resolved props is a narrower problem than aborting the
 *     whole adoption flow.
 *
 * `existingState`'s `resources` survive the walk only when they
 * weren't re-imported in this run — selective merge preserves them as
 * already-stored, which on the v3 baseline is already resolved-shape
 * from a prior import / deploy, so re-resolving is a no-op.
 *
 * RETURNS the logical ids for which an `observedProperties` baseline must NOT
 * be captured, because this walk cannot vouch that the persisted `properties`
 * still SPELL the dynamic reference the template had.
 * `captureObservedForImportedResources` refuses to write a baseline for those
 * (issue [#2828](https://github.com/go-to-k/cdkd/issues/2828) review); the
 * redaction it performs is POSITION-based, so a bag that no longer spells the
 * reference gives it no evidence and the DECRYPTED readback is persisted in
 * the clear.
 *
 * The predicate is deliberately CONSERVATIVE — it over-refuses — and that is a
 * decision a review round paid for. Four arms:
 *
 *  - **Resolution THREW** — refuse, unconditionally. A throw means the
 *    resolver could not finish, so nothing about the persisted bag is
 *    trustworthy evidence. This is BEHAVIOURALLY IDENTICAL to the arm this PR
 *    first shipped: two attempts to sharpen it in between each shipped a leak
 *    (the wrapped-complete-token shape, then the
 *    reference-sourced-from-outside-the-bag shape), and saying so is the
 *    strongest available form of "every sharpening leaked". The arm's own
 *    comment carries both measurements.
 *  - **Resolution SUCCEEDED but LOST an opener.** An `Fn::If` whose condition
 *    was DOWNGRADED resolves without throwing and selects the branch AWS did
 *    not take, so `properties` hold the false-branch literal and no reference
 *    at all. The downgrade needs a parameter with NO `Default` — `cdkd import`
 *    accepts no parameter VALUES from the user, but a `Default`-carrying
 *    parameter IS bound (issue #2321's retry), so only an unbindable one leaves
 *    `evaluateConditions` catching per condition and recording `false`.
 *
 *    ARM 2 IS KNOWN OVER-BROAD for a PUBLIC `{{resolve:ssm:...}}` reference: a
 *    `String` / `StringList` parameter is stored RESOLVED (issue #1901), so its
 *    opener disappears across the resolve and the resource is refused although
 *    nothing was ever secret, costing it a drift baseline on a common config
 *    pattern. Threading the resolve's own `recordedSecretValues` into the
 *    capture corrects it -- measured on issue
 *    [#2852](https://github.com/go-to-k/cdkd/issues/2852), which carries that
 *    remedy -- because a populated map makes absence from it real evidence of
 *    a public parameter, exactly as the deploy path already relies on.
 *
 *  - **Resolution SUCCEEDED but DISCARDED a subtree that is not provably
 *    inert** (issue [#2850](https://github.com/go-to-k/cdkd/issues/2850)).
 *    The count in arm 2 sees only what the raw bag SPELLS, and that issue
 *    measured two ways past it: a downgraded `Fn::If` dropping one reference
 *    while a parameter-sourced reference is ADDED elsewhere (the totals
 *    balance), and a reference sourced ENTIRELY from a parameter `Default` or
 *    a `Mappings` entry then dropped (both counts read zero, and nothing
 *    warns). {@link resolveDiscardsNonInertSubtree} carries the discard-event
 *    enumeration and the fail-closed rules; "inert" is
 *    {@link isInertDiscardedSubtree}'s definition — pure literals with no
 *    opener text and no intrinsic anywhere, because every way a discarded
 *    subtree could have SOURCED a reference is an intrinsic.
 *
 *  - **An UNVERIFIABLE INPUT** (ARM 4, issue
 *    [#2854](https://github.com/go-to-k/cdkd/issues/2854)). The raw bag
 *    depends on a template parameter whose DEPLOYED value — read from the
 *    backing CloudFormation stack's `DescribeStacks`, root and every nested
 *    child alike — is not provably the `Default` this import bound. Runs only
 *    when `deployedParameters` is supplied; the comparison, the dependence
 *    walk and the comparison-only rule for the deployed values live in
 *    `import-deployed-parameters.ts`.
 *
 * The cost of a false refusal is one resource's drift baseline until its next
 * deploy; the cost of a false pass is a plaintext secret in `state.json`. So an
 * unmeasurable bag refuses too.
 *
 * WHAT CAN STILL GO WRONG. No claim is made here about what this closes, and
 * that is deliberate: successive review rounds falsified a closure claim, then
 * a closed-set list, then a "reduces" claim -- the mechanism survived every
 * round of measurement and the SENTENCES about it did not. What follows states only
 * the DANGER direction, which can become false only once the residue is gone.
 *
 * PLAINTEXT CAN STILL BE PERSISTED by this capture. Known ways, each with its
 * issue and none of them proven to be all of them:
 *
 *  - a parameter binds to a placeholder `Default` while the DEPLOYED value was
 *    the reference, so no opener exists in any template this walk is handed
 *    ([#2854](https://github.com/go-to-k/cdkd/issues/2854)). ARM 4 below
 *    refuses this when a CloudFormation stack backs the import (its
 *    `DescribeStacks` parameters are the comparison); what REMAINS is an
 *    import with NO CloudFormation stack, where no deployed-parameter source
 *    exists, taint across the nested-stack `Outputs` boundary
 *    (`import-deployed-parameters.ts` states it). The NEXT DEPLOY and a
 *    source-less RE-IMPORT used to be on this list
 *    ([#3462](https://github.com/go-to-k/cdkd/issues/3462)): both bind the
 *    same placeholder `Default`, so both now honour
 *    `ResourceState.observedBaselineRefusalReason`, which this arm's verdict
 *    is recorded as. A binary older than that field still clears the marker on
 *    any UPDATE. A pre-#2854 import's plaintext baseline on a record a
 *    selective merge PRESERVES stays in `state.json` until an import refuses
 *    that record, which DROPS it
 *    ([#2872](https://github.com/go-to-k/cdkd/issues/2872));
 *  - `redactSecretsForState` cannot PAIR the readback against the source at a
 *    position the source carries NO leaf for -- an observed KEY beside a paired
 *    one -- so there is nothing to refuse from and the value scan has no needle
 *    naming it. The row `refuseUncertifiedReadbackPositions`' own table marks
 *    deliberately open, with the cost argument for leaving it that way. It is
 *    by design and documented
 *    ([#2868](https://github.com/go-to-k/cdkd/issues/2868), closed as
 *    won't-fix): a value with no source leaf is recorded as AWS returned it.
 *    The OTHER pairing failures this bullet used to list -- a reshaped
 *    container, an identity key AWS normalised, an array whose anchors do not
 *    corroborate -- no longer persist the plaintext: since
 *    [#2885](https://github.com/go-to-k/cdkd/issues/2885) this capture declares
 *    its bag a drift baseline, so an uncertified position is masked. They are
 *    rows of `tests/unit/cli/import-observed-baseline-refusal-matrix.test.ts`
 *    rather than entries here;
 *  - the readback holds a secret with NO counterpart in the source at all, set
 *    out of band. By design, not a defect in this mechanism: the baseline
 *    records what AWS holds, and a value the template never references has no
 *    expression to redact onto. Decided and documented in `docs/import.md`
 *    ([#2868](https://github.com/go-to-k/cdkd/issues/2868), closed as
 *    won't-fix), so `state.json` is sensitive by construction.
 *
 * WHY NO EXHAUSTIVE LIST IS OFFERED, as mechanism rather than framing: this
 * redaction's only evidence is a POST-HOC comparison between the persisted bag
 * and the readback, so anything that comparison cannot see is trusted.
 * Establishing more needs PROVENANCE carried out of the resolver or the
 * deployer, which is where the structural remedy for all of the above lives.
 *
 * The set is returned rather than recorded on the state, because it describes
 * THIS run's resolution; `captureObservedForImportedResources` turns it into
 * the two record fields that DO outlive the run.
 *
 * Exported for unit testing — internal to the command flow otherwise. The
 * masking this walk applies (issue #2803) is only provable against the REAL
 * resolver, since the plaintext reaches the message through the resolver's
 * own throw rather than through anything this function writes.
 */
export async function resolveImportedProperties(
  stackState: StackState,
  template: CloudFormationTemplate,
  region: string,
  stateBackend: S3StateBackend,
  logger: ReturnType<typeof getLogger>,
  /**
   * What the SOURCE CloudFormation stack was deployed with (ARM 4, issue
   * #2854). `undefined` when no CloudFormation stack backs this import — there
   * is then no deployed-parameter source at all, and the arm does not run.
   * COMPARISON-ONLY: never bound into the resolve below.
   */
  deployedParameters?: DeployedParameters
): Promise<ObservedBaselineRefusals> {
  const unsafeObservedBaselineLogicalIds = new ObservedBaselineRefusals();
  unsafeObservedBaselineLogicalIds.hadDeployedParameterSource = deployedParameters !== undefined;
  const entries = Object.entries(stackState.resources ?? {});
  if (entries.length === 0) return unsafeObservedBaselineLogicalIds;

  const resolver = new IntrinsicFunctionResolver(region);

  // Build Parameters / Conditions the same way the deploy engine does
  // (best-effort: a failure here means the template references a
  // parameter without a default and no user value was supplied, which
  // would have rejected at deploy time too — log + skip the resolution
  // pass rather than blow up the import that already succeeded against
  // AWS).
  let parameters: Record<string, unknown> = {};
  let conditions: Record<string, boolean> = {};
  try {
    parameters = await resolver.resolveParameters(template);
  } catch (err) {
    // `resolveParameters` is ALL-OR-NOTHING: it throws on the FIRST parameter
    // that is declared with no `Default` and no supplied value (`cdkd import`
    // supplies none, and has no flag that could), so a single required
    // parameter used to discard the bag WHOLESALE — including the `Default`
    // values the template itself declares for its OTHER parameters. A
    // `Fn::Sub` built from one of those was then persisted verbatim into the
    // imported resource's properties, which issue #2285's refusal cannot
    // close: a `Default`-carrying parameter is correctly OUT of the unbound
    // population, so the placeholder is kept rather than refused (issue
    // [#2321](https://github.com/go-to-k/cdkd/issues/2321)).
    //
    // Those defaults are information this caller already holds, and they are
    // independent of the parameters it could not bind — so retry over a
    // `Default`-only VIEW of the Parameters section. The retry cannot hit the
    // same throw by construction (`isUnboundTemplateParameter` is false for
    // every parameter carrying a `Default`, which is exactly the population
    // that survives the filter), and re-entering the SAME method rather than
    // hand-binding each `Default` keeps the SSM-typed
    // (`AWS::SSM::Parameter::Value<...>`) lookup and its
    // unreferenced-parameter skip identical to the happy path instead of a
    // paraphrase that can drift from it.
    //
    // Issue #2285's refusal is UNAFFECTED in both directions:
    // `isUnboundTemplateParameter` answers `false` for a `Default`-carrying
    // parameter BEFORE it consults the bound bag, so binding those defaults
    // cannot move a parameter into or out of the unbound population. A
    // `${VpcId}` is still refused and still named by `unboundParameterNames`
    // below; a `${Stage}` now resolves to its declared default.
    logger.debug(
      `Template parameter resolution failed during import-time property resolution: ${describeAwsFailure(err).detail} — retrying with the template's 'Default'-carrying parameters only; resources referencing an unbindable parameter will still be skipped per-resource.`
    );
    try {
      parameters = await resolver.resolveParameters(defaultOnlyParameterTemplate(template));
    } catch (defaultsErr) {
      // A `Default`-only retry can still fail on its own terms — an SSM-typed
      // default whose `GetParameter` is rejected is the reachable case. Fall
      // back to the pre-#2321 empty bag rather than aborting an import that
      // already succeeded against AWS; the resources are on the AWS side
      // whatever happens here, so a throw would lose the state write for work
      // that cannot be undone.
      //
      // KNOWN RESIDUAL, deliberately not fixed here: this fallback is COARSER
      // than it needs to be. One unresolvable SSM-typed default discards the
      // PLAIN `Default` values too, so #2321's defect returns for that
      // template — `${Stage}` is written verbatim again. A third pass over the
      // non-SSM defaults would close it. It is left because this arm is the
      // one place the resolver's `isUnboundTemplateParameter` exclusion is
      // still load-bearing (see the note on that predicate, which cites this
      // arm as its live producer), so the two must be changed together and
      // reasoned about as one. `tests/unit/cli/import.test.ts` PINS the
      // residual — the case asserting a verbatim `app-${Stage}-topic` after a
      // rejected `GetParameter` — so it cannot widen silently, and so the
      // resolver's claim about this arm cannot go stale unnoticed.
      parameters = {};
      logger.debug(
        `'Default'-only template parameter resolution also failed during import-time property resolution: ${describeAwsFailure(defaultsErr).detail} — continuing without parameters; resources referencing them will be skipped per-resource.`
      );
    }
  }
  // The three `logger.debug` catches in this preamble — this one and the two
  // `resolveParameters` arms above — interpolate the resolver's error text
  // UNMASKED, and that is deliberate rather than the issue #2803 defect
  // repeated. There is no bag to mask against here: the
  // per-resource `recordedSecretValues` is created inside the walk below, and
  // these three calls thread no `recordedSecretValues` of their own, so nothing
  // can have been recorded when they fail. Passing a freshly-made empty map
  // would be ceremony — `maskSecretsInText` is the identity on one — and would
  // read as a guard where there is nothing to guard. If a future change threads
  // a bag into any of these calls, mask that one THEN.
  try {
    conditions = await resolver.evaluateConditions({
      template,
      resources: stackState.resources,
      parameters,
    });
  } catch (err) {
    logger.debug(
      `Template condition evaluation failed during import-time property resolution: ${describeAwsFailure(err).detail} — continuing without conditions.`
    );
  }

  // The parameters this import could NOT bind, decided by the SAME predicate
  // the resolver refuses on (issue #2285) rather than by re-reading the error
  // text below. `cdkd import` accepts no parameter values at all, so when this
  // list is non-empty the sibling-shaped remedies in the per-resource warning
  // cannot apply to the failure and the message has to say so.
  const unboundParameterNames = Object.keys(
    (template.Parameters ?? {}) as Record<string, unknown>
  ).filter((name) => isUnboundTemplateParameter(name, template, parameters));

  // ARM 4 (issue #2854) — the parameters whose DEPLOYED value is not provably
  // the value bound above, narrowed to the ones anything in the template can
  // reach. Computed once per stack; the per-resource test sits right after the
  // resolve, ahead of ARM 1. A throw here must not abort an import that
  // already succeeded against AWS, so an unreadable `Parameters` section fails
  // closed to "every declared parameter is divergent".
  let divergentParameters: Set<string> | undefined;
  if (deployedParameters !== undefined) {
    try {
      divergentParameters = reachableDivergentParameters(
        template,
        divergentParameterNames(template, parameters, deployedParameters),
        entries.map(([, resource]) => resource.properties)
      );
    } catch {
      // A BACKSTOP, and deliberately unfenced: `reachableDivergentParameters`
      // catches its own walk and `divergentParameterNames` throws only if the
      // shared coercion does, so no input reaches this arm today. The same is
      // true of the `catch` around `computeParameterTaint` below, which
      // catches per resource. Both fail closed.
      divergentParameters = new Set(Object.keys((template.Parameters ?? {}) as object));
    }
  }
  // The per-stack verdict, judged on the TEMPLATE definition of every resource
  // as well as on the state bags (see `computeParameterTaint` for why a
  // preserved record's resolved bag cannot be the only evidence).
  let parameterTaint: ParameterTaint | undefined;
  if (divergentParameters !== undefined && divergentParameters.size > 0) {
    try {
      parameterTaint = computeParameterTaint(
        template,
        new Map(entries.map(([logicalId, resource]) => [logicalId, resource.properties])),
        divergentParameters
      );
    } catch (err) {
      logger.debug(
        `observed-baseline parameter-dependence walk failed for ${displayStackName(stackState.stackName)}: ${err instanceof Error ? err.name : typeof err} — refusing every baseline in the stack fail-closed.`
      );
      const all = new Set(entries.map(([logicalId]) => logicalId));
      parameterTaint = { refused: all, unclassifiable: all, parametersHit: new Set() };
    }
  }

  const baseContext = {
    template,
    resources: stackState.resources,
    // go-to-k/cdkd#3869: a read of a resource NAMED from a secret is masked on
    // the resolver's lines through a print-only sink, never this import's
    // per-resource bag, which decides what is persisted.
    secretNameNeedles: stateSecretNameNeedles(stackState.resources),
    secretNameSink: new Map<string, string>(),
    ...(Object.keys(parameters).length > 0 && { parameters }),
    ...(Object.keys(conditions).length > 0 && { conditions }),
    stateBackend,
    stackName: stackState.stackName,
    // go-to-k/cdkd#6170: the tail the stack's deploys resolve `AWS::StackId`
    // with, so an imported record holds the value the next deploy compares.
    stackIdTail: () => stackIdTailOf(stackState, stackState.stackName),
  };

  // What the NoEcho positional pass after the loop reads, per record
  // (go-to-k/cdkd#4043 Phase C): the template bag, its resolution, and the
  // attributes as imported, before any redaction.
  const noEchoInputs = new Map<string, NoEchoImportInput>();

  for (const [logicalId, resource] of entries) {
    // Fresh PER-RESOURCE secrets map so the imported state persists the
    // `{{resolve:...}}` expression, not the plaintext (GHSA fix), while a
    // whole-secret value from one resource cannot rewrite another's literal
    // (see the `SecretsRunState.perResourceSecrets` doc (`deploy-engine/masking.ts`) for the rationale).
    //
    // HOISTED above the `try` (issue #2803), and that is load-bearing rather
    // than style: the resolver records `plaintext -> expression` into this map
    // AS IT GOES, so a resolution that records one reference and then throws on
    // the next has already put a plaintext here — and the `catch` below prints
    // the resolver's error text at DEFAULT verbosity. Declared inside the
    // `try`, the bag was out of scope exactly where it was needed as a needle
    // set. `rollback-executor.ts` and `drift.ts` hoist for the same reason and
    // say so at their own declarations.
    const recordedSecretValues = new Map<string, string>();
    // Captured BEFORE the resolve + reassignment below: this unresolved bag is
    // the POSITION source (#1910), and `resource.properties` is overwritten
    // with the resolved one inside the `try`.
    //
    // HOISTED above the `try` for the same reason the map above is, and for one
    // more: the refusal decision AFTER the try/catch reads it on BOTH arms.
    const unresolvedProperties = resource.properties ?? {};
    let threw = false;
    try {
      const resolved = (await resolver.resolve(unresolvedProperties, {
        ...baseContext,
        recordedSecretValues,
      })) as Record<string, unknown>;
      // CLAIMED same-generation (issue #2745): a 1-3 character secret embedded
      // in a leaf sits below the value scan's needle floor, and the span arms
      // write it as its token only on a bag whose provenance is proven. This
      // bag is import's own resolution of `unresolvedProperties` by the
      // resolver that recorded the pairs in `recordedSecretValues` — the same
      // evidence the deploy engine's create arm has — so the claim (see
      // `markSameGenerationBag`) holds here. It is stated to the walk through
      // the context and marks nothing (go-to-k/cdkd#5047); the record holds
      // the redacted copy.
      resource.properties =
        recordedSecretValues.size > 0
          ? redactForState(resolved, {
              provenance: 'template-derived',
              secrets: recordedSecretValues,
              source: unresolvedProperties,
              generation: 'same-generation',
            })
          : resolved;
      // Positioned after the loop, once every record's echoed attributes are
      // known (go-to-k/cdkd#4043 Phase C): a `Fn::GetAtt` consumer resolved
      // before its producer must still see the producer's declaration.
      noEchoInputs.set(logicalId, {
        template: unresolvedProperties,
        resolved,
        attributes: resource.attributes,
      });
    } catch (err) {
      // Intrinsic referenced a resource not in the importable set
      // (e.g. custom resource that wasn't adopted) or a parameter
      // without a value. Leave the raw intrinsic in place — the
      // resource is already imported on the AWS side, and the user
      // can either re-import the missing sibling or surgically fix
      // state via `cdkd state orphan` + redeploy.
      //
      // BOTH causes reach this catch, and the remedies differ. The
      // sibling-shaped ones stay as written; the parameter-shaped clause is
      // appended only when this template actually has an unbindable parameter
      // (issue #2285 routed that failure here), because re-importing a sibling
      // cannot fix it and `cdkd import` has no flag to bind one with.
      //
      // MASKED (issue #2803). `cdkd import` sets no `skipDynamicReferences`, so
      // the resolve above really does DECRYPT — that is what makes any error
      // out of it a candidate for carrying a plaintext, and it is unchanged.
      // This warn prints at default verbosity, in the command whose stated
      // contract is to persist the `{{resolve:...}}` expression and never the
      // value.
      //
      // SINCE ISSUE #2827 THE RESOLVER MASKS ITS OWN THROWS, so the paragraph
      // that used to sit here — "the resolver's throws interpolate what it was
      // handed, so this boundary is the only mask" — no longer describes the
      // code. What this mask still OWNS is the population the resolver never
      // built: an SDK rejection raised inside `client.send` and propagated
      // through `resolveDynamicReferences` untouched, which is exactly the
      // shape that carries a plaintext (an IAM AccessDenied names the RESOURCE
      // it refused, and for an id an `Fn::Sub` assembled that is the decrypted
      // value). Masking twice is idempotent, so nothing is lost on the errors
      // the resolver already masked. `import-resolver-error-masking.test.ts`
      // pins both halves and says which case discriminates which.
      //
      // THE MASK IS STILL BOUNDED, and this comment deliberately does NOT
      // enumerate how. `maskSecretsInText` matches a needle LITERALLY, so a
      // plaintext that reaches the message re-encoded is not masked here, and
      // neither is one below `MIN_NEEDLE_LENGTH` (4) unless it is the ENTIRE
      // string. (Embedding on its own is NOT a limit — the substring arm masks
      // `key '<plaintext>' not found` fine; an earlier revision of this line
      // said otherwise.) The enumeration lives where it is ACTED ON and kept
      // true — `intrinsic-resolver/masking-display.ts`'s `maskValueLeaves` and the
      // residual note above `maskingContext` in `evaluateConditions` — because
      // five review rounds on this PR each rewrote a taxonomy in THIS spot and
      // each was wrong in a NEW way (`no mask can fix it`, then `a raw-value
      // mask closes it`, both refuted by measurement); nothing here re-checks a
      // claim about the masker's semantics.
      //
      // What this site owns, and what the test file pins: the bag is hoisted
      // so the `catch` can name it, and the message is masked against it.
      //
      // UNCHANGED by issue #2563, which added the drain: a needle missed
      // because a drain released on a spent budget under-redacts here, and
      // that is not a regression -- the merge base has no drain at all, so
      // its grace is zero unconditionally. Do not re-derive it as one.
      //
      // A line that displays template text carries no command to paste
      // (go-to-k/cdkd#3950's S1 rule, go-to-k/cdkd#4226): the logical id and
      // type are shown only when plain, and the resolver's message, which can
      // quote any template value, ends its own line, so the remedies naming
      // `cdkd destroy` / `cdkd orphan` / `cdkd import` start the next one. The
      // parameter names on that line are shown only when plain too.
      logger.warn(
        `Failed to resolve intrinsics in Properties for imported resource ${logicalIdShown(logicalId)} (${resourceTypeShown(resource.resourceType)}): ${maskSecretsInText(describeAwsFailure(err).detail, recordedSecretValues)}.\n` +
          `State will be written with the raw intrinsic shape, which may cause 'cdkd destroy' to fail on this resource — re-import once every referenced sibling is in state, or remove this resource from state with 'cdkd orphan <StackPath>/<Path/To/Resource>'.` +
          (unboundParameterNames.length > 0
            ? ` This template also declares parameter(s) with no 'Default' that an import cannot bind (${unboundParameterNames.map((name) => plainOrDescribed(name, 'parameter name')).join(', ')}), and 'cdkd import' accepts no parameter values — if this property was built from one of those, re-importing a sibling will not change it: give the parameter a 'Default' in the template and re-import, or correct the recorded properties before the next 'cdkd deploy'.`
            : '')
      );
      threw = true;
    }

    // THE `attributes` CHOKE POINT (issue
    // [#2847](https://github.com/go-to-k/cdkd/issues/2847)). `attributes` is
    // the third bag on this record and, until this line, the only one no
    // redactor on the import path ever touched: `properties` has been redacted
    // since the original GHSA fix (just above) and `observedProperties` since
    // issue #2828. The deploy path has no such gap — every `saveState` goes
    // through `scrubResourceRecord`, which walks all THREE fields uniformly —
    // so this is import catching up to the choke point deploy already has,
    // not a new mechanism.
    //
    // WHY THE VALUE SCAN AND NO POSITION SOURCE. `redactSecretsForState`'s
    // source argument positions a bag against the TEMPLATE SHAPE it was
    // resolved from. `attributes` is an AWS READBACK with its own key set — it
    // is not the resolved form of `unresolvedProperties` and does not
    // correspond to it positionally, so handing that bag over as a source
    // would be a claim this site cannot make. `scrubResourceRecord` redacts
    // `attributes` with NO source for exactly this reason (the #1900
    // fallback), and this site takes the same shape deliberately rather than
    // inventing a fourth positioning rule.
    //
    // WHY IT RUNS ON THE THROW ARM TOO, and why it is placed ABOVE the refusal
    // below rather than after it. The resolver records `plaintext ->
    // expression` into `recordedSecretValues` AS IT GOES, so a resolve that
    // decrypted one reference and then threw on the next has ALREADY put a
    // needle in the bag — that is the same property the hoist above the `try`
    // exists for, and the `catch`'s own mask relies on it. Skipping the throw
    // arm would leave the readback unredacted in exactly the runs where the
    // needles are known to exist. The refusal below `continue`s, so anything
    // written after it would never reach a throwing resource.
    //
    // THE MAP CAN BE EMPTY, and then this is an identity return — the guard is
    // the same one the `properties` line above uses. That is the ordinary case
    // and it is NOT a gap this line could close: with no needles there is
    // nothing to scan for. What survives an empty map, and what survives a
    // NON-empty one, is the AWS-GENERATED secret — a credential AWS minted
    // that no template ever spelled, so no expression exists to rewrite it to.
    // `CloudControlProvider.import` addresses its own half of that class
    // structurally (see `maskUncertifiedModelValues`); the residue is recorded
    // on the issue rather than claimed closed here.
    if (recordedSecretValues.size > 0 && resource.attributes !== undefined) {
      resource.attributes = redactForState(resource.attributes, {
        provenance: 'value-scan',
        secrets: recordedSecretValues,
      });
    }

    // THE REFUSAL (see this function's doc block for the arms and why the
    // predicate is deliberately CONSERVATIVE rather than precise).
    // ARM 1 -- the resolve THREW. Refuse, FULL STOP: no inspection of the bag at
    // all, and tested FIRST so the two `JSON.stringify` passes below are not
    // computed on the arm that ignores them. Two review rounds tried to be
    // cleverer here and both leaked -- refusing only when an opener is not
    // already a COMPLETE token admitted a complete token wrapped in a
    // single-element `Fn::Join` / `Fn::Sub` / `Fn::If`; refusing only when the
    // raw bag CARRIES an opener admitted a reference sourced from OUTSIDE the
    // bag. A throw means the resolver could not finish, so nothing about the
    // bag is trustworthy evidence.
    // ARM 4 (issue #2854) — an UNVERIFIABLE INPUT: the resource depends,
    // directly or through another resource's attributes, on a parameter whose
    // deployed value is not provably the `Default` bound above, so the
    // persisted `properties` hold a placeholder where AWS holds whatever the
    // deployed value produced (a decrypted secret, in the shape the issue
    // measured) and NO template this walk was handed spells a reference for
    // the redaction to position. Decided per STACK above; it reads only raw
    // bags, so it applies on the throw arm too.
    const dependsOnDivergent = parameterTaint?.refused.has(logicalId) === true;
    // Recorded whenever ARM 4 named the resource, INDEPENDENTLY of `threw`
    // (issue #3462): the reason decides whether a later UPDATE may clear the
    // refusal, and a resource that also tripped another arm is no more
    // dischargeable by a deploy than one that tripped this arm alone.
    if (dependsOnDivergent) unsafeObservedBaselineLogicalIds.unverifiableParameter.add(logicalId);
    if (threw || dependsOnDivergent) {
      unsafeObservedBaselineLogicalIds.add(logicalId);
      continue;
    }
    const rawOpeners = countDynamicReferenceOpeners(unresolvedProperties);
    const persistedOpeners = countDynamicReferenceOpeners(resource.properties);
    // ARM 3 (issue #2850) — the resolve SUCCEEDED but DISCARDED a subtree it
    // cannot vouch is inert. The count arm below sees only what the raw bag
    // SPELLS, so it misses a drop the bag never spelled (a reference sourced
    // from a parameter `Default` or a `Mappings` entry: both counts read
    // zero) and a drop BALANCED by an addition elsewhere. The predicate's
    // own doc block carries the discard-event enumeration and the fail-closed
    // rules.
    //
    // EVALUATED IN ITS OWN try, FAIL-CLOSED (independent parent-review
    // blocker): the walk recurses SYNCHRONOUSLY, so a bag nested deeper than
    // the sync call stack — but still shallow enough for JSON.stringify's
    // lighter frames, so the two counts above compute normally and nothing
    // short-circuits — raises `RangeError` here, and no enclosing catch
    // exists: the per-resource try wraps only the resolve, and a throw out of
    // this function aborts the import AFTER the AWS-side import already
    // succeeded — exactly what the parameter fallback above refuses to allow,
    // in its own words ("a throw would lose the state write for work that
    // cannot be undone"). A bag the walk cannot traverse is a bag it cannot
    // vouch for: refuse, the same direction as
    // `countDynamicReferenceOpeners`' serialization guard. Pinned by the
    // deep-bag case in the refusal-matrix suite, which BISECTS to the minimal
    // refusing depth rather than guessing one, because every limit here moves
    // with the ambient stack.
    //
    // THE TRADE THE CATCH MAKES, stated because the comment above names only
    // the safe half: it swallows EVERY throw, so a future shape bug in the
    // walk (a `TypeError`, not just the overflow) reads as "discards" and
    // costs baselines silently instead of failing a test loudly. That is the
    // right direction for a security refusal, and the debug line below is
    // the compensation — name and shape only, like the capture's own catch,
    // never the message (which could carry template text).
    let discardsNonInertSubtree: boolean;
    try {
      discardsNonInertSubtree = resolveDiscardsNonInertSubtree(
        unresolvedProperties,
        conditions,
        template.Mappings
      );
    } catch (err) {
      logger.debug(
        `observed-baseline discard walk failed for imported ${logicalId} (${resource.resourceType}): ${err instanceof Error ? err.name : typeof err} — refusing the baseline fail-closed.`
      );
      discardsNonInertSubtree = true;
    }
    if (
      rawOpeners === undefined ||
      persistedOpeners === undefined ||
      // ARM 2 — the resolve SUCCEEDED but LOST an opener, which a downgraded
      // `Fn::If` does routinely.
      persistedOpeners < rawOpeners ||
      discardsNonInertSubtree
    ) {
      unsafeObservedBaselineLogicalIds.add(logicalId);
    }
  }

  // ONE line per stack, and the signal issue #2854 found missing entirely.
  // Parameter NAMES and counts only — never a bound or a deployed VALUE.
  // Counted over the records this walk holds: the verdict also judges template
  // resources that are not in state, which have no baseline to lose.
  if (parameterTaint !== undefined) {
    const inState = new Set(entries.map(([logicalId]) => logicalId));
    const refusedHere = [...parameterTaint.refused].filter((id) => inState.has(id));
    const unreadable = refusedHere.filter((id) => parameterTaint.unclassifiable.has(id));
    if (refusedHere.length > 0) {
      const named = [...parameterTaint.parametersHit].sort().map((name) => displayIdent(name));
      logger.warn(
        `${refusedHere.length} resource(s) in ${displayStackName(stackState.stackName)} depend, directly or through another resource's attributes, on template parameter(s) ` +
          `whose deployed CloudFormation value could not be proven equal to the template 'Default' 'cdkd import' binds` +
          (named.length > 0 ? ` (${named.join(', ')})` : '') +
          (unreadable.length > 0
            ? ` — ${unreadable.length} of them because their properties could not be checked for such a dependence`
            : '') +
          `. Their recorded properties hold the 'Default', NOT the deployed value, and no observed drift baseline was captured for them by this import ` +
          `(the live value may be a secret this import cannot position a redaction for). Review 'cdkd diff' before the next 'cdkd deploy'.`
      );
    }
  }

  positionImportedNoEcho(
    stackState,
    noEchoInputs,
    template,
    conditions,
    unsafeObservedBaselineLogicalIds,
    logger
  );
  return unsafeObservedBaselineLogicalIds;
}
