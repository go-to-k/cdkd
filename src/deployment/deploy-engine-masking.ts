import { DeployEngine, EMPTY_SECRETS } from './deploy-engine.js';
import type { CloudFormationTemplate, ResourceProvider } from '../types/resource.js';
import type { ResourceState } from '../types/state.js';
import {
  ambientCredentialConfig,
  credentialFingerprint,
} from '../utils/ambient-client-defaults.js';
import { safeMsg } from '../utils/display-safe.js';
import { ProvisioningError } from '../utils/error-handler.js';
import type { FreshNoEchoReadback } from './deploy-value-equality.js';
import {
  type RecordedSecretValues,
  type SecretMasker,
  TEMPLATE_SOURCED_RULES,
  carriesFreshNoEchoValue,
  carriesSecretMask,
  createUnionSecretMasker,
  inheritedParameterExpression,
  literalSplitDelimitersOf,
  maskSecretsInError,
  maskSecretsInText,
  mergeResolvedPairs,
  recordLogOnlyParameterValue,
  recordMaskOnlyValuesIn,
  recordRecoverableMaskedOutput,
  redactSecretsForState,
  wholeStringLeavesOf,
} from './secret-redaction.js';

declare module './deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    diffLogMasker: OmitThisParameter<typeof diffLogMasker>;
    /** @internal */
    freshNoEchoParameters: OmitThisParameter<typeof freshNoEchoParameters>;
    /** @internal */
    redactParametersForDiff: OmitThisParameter<typeof redactParametersForDiff>;
    /** @internal */
    rememberRecoverableMaskedOutputs: OmitThisParameter<typeof rememberRecoverableMaskedOutputs>;
    /** @internal */
    absorbOutputsPassSecrets: OmitThisParameter<typeof absorbOutputsPassSecrets>;
    /** @internal */
    redactOutputs: OmitThisParameter<typeof redactOutputs>;
    /** @internal */
    registerNoEchoAttributes: OmitThisParameter<typeof registerNoEchoAttributes>;
    /** @internal */
    refuseRedactedAttributeReads: OmitThisParameter<typeof refuseRedactedAttributeReads>;
    /** @internal */
    allRecordedSecrets: OmitThisParameter<typeof allRecordedSecrets>;
    /** @internal */
    readReaderForFreshNoEchoCeiling: OmitThisParameter<typeof readReaderForFreshNoEchoCeiling>;
    /** @internal */
    maskForResource: OmitThisParameter<typeof maskForResource>;
  }
}

/**
 * The printing masker the diff calculator's log lines take
 * (go-to-k/cdkd#4049): the diff pass's own bag, every `NoEcho` parameter's
 * value, then a nested child's inherited bag. The diff bag is bound by
 * reference, so a needle the pass records after this call is masked too.
 *
 * The parameter values are recorded HERE, up front, into a bag of this
 * masker's own: the diff records a value only when a `Ref` serves it, in
 * template order, so a resource whose property STOPPED reading the
 * parameter would otherwise print its old value from state whenever the
 * parameter's other readers come later in the template, or none remain.
 * Never the diff bag: nothing but this printer reads it.
 *
 * ONE pass over the union (`createUnionSecretMasker`): a pass per bag let
 * one bag's shorter needle cut a longer needle another bag held and print
 * the rest of it.
 */
export function diffLogMasker(
  this: DeployEngine,
  diffSecrets: RecordedSecretValues | undefined,
  template: CloudFormationTemplate,
  parameterValues: Record<string, unknown>
): SecretMasker {
  const inherited = this.options.inheritedSecrets;
  const noEchoValues: RecordedSecretValues = new Map();
  // The pieces of every literal `Fn::Split` over a `NoEcho` value too
  // (go-to-k/cdkd#4049), for a property that stopped reading one.
  const noEchoNames = new Set(
    Object.entries(template.Parameters ?? {})
      .filter(([, definition]) => definition?.NoEcho === true)
      .map(([name]) => name)
  );
  const splitDelimiters = literalSplitDelimitersOf(template, noEchoNames);
  for (const [name, definition] of Object.entries(template.Parameters ?? {})) {
    if (definition?.NoEcho === true && Object.hasOwn(parameterValues, name)) {
      recordLogOnlyParameterValue(noEchoValues, parameterValues[name], splitDelimiters);
    }
  }
  return createUnionSecretMasker([diffSecrets, noEchoValues, inherited]);
}

/**
 * The names of this child's parameters whose value carries a `NoEcho` value
 * the parent supplied in THIS deploy (go-to-k/cdkd#3717), read off the
 * inherited bag's fresh marks. `undefined` outside a nested child, or when
 * none does.
 *
 * A parameter that EMBEDS such a value (`prefix-<token>`) counts too: the
 * containment arm masks that leaf whole (go-to-k/cdkd#2453), and
 * `carriesFreshNoEchoValue` shares its predicate.
 */
export function freshNoEchoParameters(
  this: DeployEngine,
  parameterValues: Record<string, unknown>
): ReadonlySet<string> | undefined {
  const inherited = this.options.inheritedSecrets;
  if (!inherited || inherited.size === 0) return undefined;
  const fresh = new Set<string>();
  for (const [name, value] of Object.entries(parameterValues)) {
    if (carriesFreshNoEchoValue(value, inherited)) fresh.add(name);
  }
  return fresh.size > 0 ? fresh : undefined;
}

/**
 * The parameter bag the DIFF resolver context binds, with any inherited
 * secret plaintext rewritten back to its `{{resolve:...}}` expression (issue
 * #1903).
 *
 * The provisioning pass must keep the REAL values — that is what actually
 * reaches AWS — but the child's persisted state holds the expression, so the
 * comparison side has to hold it too or every deploy of a secret-bearing
 * nested stack reports a spurious UPDATE and re-issues an AWS call that
 * changes nothing. This is the child-stack twin of the
 * `skipDynamicReferences` flag the parent's own diff sets: same goal
 * (expression-vs-expression), reached differently because the child's
 * template carries `{Ref: Param}` rather than a `{{resolve:` string, so
 * there is no reference for that flag to decline to resolve.
 *
 * `redactSecretsForState` rather than a `Map.get` lookup so an EMBEDDED
 * secret — a parameter whose value is `postgres://u:<secret>@host` because
 * the parent built it with `Fn::Sub` — is rewritten the same way the
 * state-save choke point rewrites it, keeping the two sides byte-identical.
 * Identity-returns when nothing was inherited.
 */
export function redactParametersForDiff(
  this: DeployEngine,
  parameterValues: Record<string, unknown>
): Record<string, unknown> {
  const inherited = this.options.inheritedSecrets;
  if (!inherited || inherited.size === 0) return parameterValues;
  // `Object.create(null)` (issue #2802). Since the resolver's parameters bag
  // became null-prototype, a template parameter named `__proto__` is a real
  // OWN key here rather than one already swallowed upstream -- so a plain
  // `{}` accumulator would drop it through the inherited setter and move the
  // very defect the sweep fixed one hop downstream, into a file the checker
  // does not scan.
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of Object.entries(parameterValues)) {
    // Issue #2291: the PER-PARAMETER answer first, because `inherited` is
    // keyed by PLAINTEXT and two parameters resolving to one value have
    // already collapsed there. The persist side positions each child leaf
    // onto its OWN expression; without the same answer here the losing
    // parameter's desired side would carry the SURVIVOR's expression forever
    // and its resource would report a spurious UPDATE on every deploy.
    // `undefined` whenever the parent could not certify one, which falls back
    // to the value scan below — the pre-#2291 behaviour, expression-collapsed
    // but consistent with what a pre-#2291 persist side wrote.
    out[name] =
      inheritedParameterExpression(inherited, name, value) ??
      redactSecretsForState(value, inherited);
  }
  return out;
}

/**
 * Redact resolved secret plaintext out of a bag about to be PERSISTED to
 * state, replacing each secret value with the unresolved `{{resolve:...}}`
 * expression it came from (GHSA fix; see `secret-redaction.ts`). No-op when
 * the deploy recorded no secrets. The bag sent to the AWS API is the
 * un-redacted resolved bag; only the persisted copy is rewritten.
 */
/**
 * Redact the resolved stack OUTPUTS bag, positioned by the unresolved
 * template `Outputs` values (issue #1910).
 *
 * A single entry point because SEVEN call sites redact this same bag — the
 * state-persist choke point, the no-change re-check, that path's exports
 * index and deploy summary, the changes path's index and summary, and the
 * outputs pass itself. THREE of those are the ones issue #1910 unified —
 * the persist choke point, the re-check, and the outputs pass, which the
 * list above ends on rather than opens with: before it they each spelled
 * the value-only redaction separately, and two outputs resolving one secret
 * collapsed onto whichever expression was recorded last at all three. The
 * other FOUR are issue #2814's, both paths' index and summary: each read
 * the bag unredacted until then, and now redacts at the moment it reads.
 */
/**
 * Record the plaintext behind every output {@link redactOutputs} just masked,
 * for the duration of THIS PROCESS (issue #2274).
 *
 * Per KEY, comparing the two bags rather than re-deriving from the secrets
 * map: what matters is whether the persisted value at this key IS a mask that
 * the resolved value was not, which is exactly "this key's plaintext is about
 * to become unreadable". A key already carrying `***` before redaction — a
 * value read back out of a previous run's state — is skipped, because there
 * is no plaintext behind it to remember.
 *
 * Called only from the REAL-DEPLOY outputs pass. Of the six other
 * `redactOutputs` callers, three CAN hand it a bag from a previous
 * generation — the persist walk always may, and the no-change path's
 * exports index and summary do on the arms where that path keeps the
 * previous bag — and there a mask is already unrecoverable, so pretending
 * otherwise would
 * serve a stale value. The other three are not this pass either: the
 * no-change path performs the FIRST redaction of its own resolution there,
 * and the changes path's index and summary re-redact the bag this pass
 * already produced. (The "other two" this replaces counted the base's three
 * callers correctly; what was wrong was calling both of the others
 * previous-generation, when only the persist walk was one.)
 */
export function rememberRecoverableMaskedOutputs(
  this: DeployEngine,
  stackName: string,
  resolved: Record<string, unknown>,
  redacted: Record<string, unknown>
): void {
  if (resolved === redacted) return;
  // Recorded UNDER the identity that produced it (go-to-k/cdkd#3691): the
  // readers compute the same fingerprint from the clients they resolve with,
  // so another identity's same-named stack in this process misses.
  const identity = credentialFingerprint(ambientCredentialConfig());
  for (const [key, redactedValue] of Object.entries(redacted)) {
    if (!carriesSecretMask(redactedValue)) continue;
    const plaintext = resolved[key];
    if (plaintext === undefined || carriesSecretMask(plaintext)) continue;
    recordRecoverableMaskedOutput(identity, stackName, this.stackRegion, key, plaintext);
  }
}

/**
 * Fold every outputs-pass recording map into `outputSecrets` — the entries,
 * and the uncollapsed evidence beside them (issue #2485: without it a
 * literal Output embedding one of two same-plaintext references would lose
 * its span positioning and persist the sibling's expression). Only what the
 * outputs pass itself resolved, so the outputs redaction (GHSA fix) uses
 * only outputs-substituted references: a literal output equal to a secret
 * nothing resolved is not recorded, and is not touched.
 *
 * Run by every {@link redactOutputs}, AND by
 * {@link crossStackReadKeyNormalizer} (issue
 * [#3289](https://github.com/go-to-k/cdkd/issues/3289)), which needs the
 * same bag and runs BEFORE the persist walk. Calling it twice in one save
 * is safe and MEASURED rather than assumed: the entry fold re-sets equal
 * values, and `recordResolvedPair` leaves a pair alone when the plaintext
 * is unchanged, so no CONFLICTING marker is invented. (issue
 * [#2814](https://github.com/go-to-k/cdkd/issues/2814)), because a part the
 * drain cap stopped waiting for records into its pass map LATE: a secret
 * that arrives between the pass and the final save is then still a needle
 * for the save, the exports index and the deploy summary. Repeating it is
 * safe for the ENTRIES — re-setting one the bag holds changes nothing, and
 * `Map.set` on an existing key keeps its insertion order, so last-wins
 * cannot be reordered by a refold.
 *
 * The PAIRS are where repeating is not merely a no-op, stated because the
 * end-of-pass copy could not see it: a part the cap stopped waiting for can
 * record a pair LATE, and a second value for one expression marks it
 * `CONFLICTING_PLAINTEXT` (a non-cacheable `{{resolve:ssm:X}}` re-resolved
 * to a moved value). A later refold then carries that conflict into
 * `outputSecrets`, the leaf loses its positioning and falls to the value
 * scan, which can persist a sibling's expression (the issue #2485 class).
 * The plaintext stays MASKED either way, so the cost is which expression
 * is stored, not a disclosure — and the alternative, dropping the late
 * pair, would keep a positioning the pass itself no longer vouches for.
 */
export function absorbOutputsPassSecrets(this: DeployEngine): void {
  for (const passSecrets of this.outputsPassSecretMaps) {
    for (const [value, expr] of passSecrets) {
      this.outputSecrets.set(value, expr);
    }
    mergeResolvedPairs(passSecrets, this.outputSecrets);
  }
}

/**
 * Redact the outputs bag. NOT a pure transform: it folds the outputs pass
 * map into `outputSecrets` first (issue #2814), so every call can grow that
 * bag. Its KEY set only grows, and the bag has no other reader, which is
 * what makes calling this on every save, index write and summary safe. The
 * resolved PAIRS beside those keys are not equally free to refold — see
 * {@link absorbOutputsPassSecrets}, which states what a late one costs.
 */
export function redactOutputs(
  this: DeployEngine,
  outputs: Record<string, unknown>
): Record<string, unknown> {
  // First, and before the empty-bag return: a late recording (issue #2814)
  // may be the only needle there is.
  this.absorbOutputsPassSecrets();
  if (this.outputSecrets.size === 0) return outputs;
  // TEMPLATE_SOURCED and not the DEFAULT template-DERIVED rules (issue
  // [#1943](https://github.com/go-to-k/cdkd/issues/1943)). `descendArrays` is
  // the only flag the two differ on, and it claims "this bag was PRODUCED by
  // resolving this source" — which several of its callers cannot say:
  // `redactStateForPersist`, the no-change path's exports index and summary,
  // and that path's save-time mixed-generation check over a MERGED bag (issue
  // #2771). (Issue #2814 took the callers from three to seven, and the "two" was already
  // wrong before it — of the base's three sites only the persist walk took
  // a foreign bag.) `redactStateForPersist` walks whatever `state.outputs`
  // holds, and on
  // the no-change path that is `persistedOutputs`, the PREVIOUS deploy's bag,
  // while `outputsTemplateSource` is TODAY's template. Positional descent
  // there does not merely mis-redact: `redactByPath` returns a known-secret
  // SOURCE leaf verbatim, so a previous generation's ordinary literal at
  // index `i` is rewritten to today's expression at index `i` — a value the
  // stack never held, persisted into `state.outputs`, which the exports index
  // re-applies to consumer stacks.
  //
  // Reachable rather than theoretical, though narrowly: `TemplateOutput.Value`
  // is `unknown` and cdkd does not enforce CloudFormation's "Value must be a
  // String", so a list-valued output (an escape hatch, an imported template)
  // gives the array arm an array on BOTH sides and `state.outputs` is
  // explicitly not string-coerced. Every CDK-synthesized template lands on a
  // string or an intrinsic OBJECT, so for those the swap is inert.
  //
  // `sourceIsSameGeneration` is already false in both constants, so the
  // token-shaped-leaf hazard (issue #1917) was never the gap here. The
  // sibling `cdkd scrub` outputs call still passes the default and records
  // the inertness measurement for its own bag; converging the two is issue
  // [#2099](https://github.com/go-to-k/cdkd/issues/2099).
  return redactSecretsForState(
    outputs,
    this.outputSecrets,
    this.outputsSourceUsable ? this.outputsTemplateSource : undefined,
    TEMPLATE_SOURCED_RULES
  );
}

/**
 * Redact resolved secret plaintext out of rollback-journal operations (GHSA
 * fix). Each op may carry resolved `properties` / `attemptedProperties` and a
 * `previousState` snapshot (whose `properties` / `attributes` /
 * `observedProperties` also hold resolved values). Each op is redacted with
 * the secrets recorded for ITS OWN resource (`perResourceSecrets`), so a
 * whole-secret value from one resource cannot rewrite another's literal.
 * Preserves ops that carry none of those fields, or whose resource recorded
 * no secret.
 *
 * The POSITION source matters MORE here than anywhere else (issue #1910).
 * This journal is not just persisted, it is REPLAYED to AWS by the rollback
 * executor's `resolveReplayProps`, so a leaf redacted onto a SIBLING's
 * expression — which is what the value-keyed map does when two expressions
 * resolve to one value — re-resolves at replay time to the wrong reference.
 * For two `:AWSCURRENT` / `:AWSPREVIOUS` stages of one secret that is the
 * wrong VERSION shipped to the live resource the moment the two diverge.
 *
 * The two SIDES take different sources, and conflating them would be a fresh
 * defect rather than a simplification: `properties` / `attemptedProperties`
 * are this deploy's DESIRED bags, produced by resolving the CURRENT template,
 * so the template bag positions them. `previousState` is a record read back
 * from STATE, whose leaves already hold expressions from whenever it was
 * written — the current template is not its source and may not even have the
 * same shape — so it is redacted against ITSELF via `scrubResourceRecord`,
 * the same #1900 fallback an UNCHANGED resource takes.
 */
/**
 * Take a provider's `noEchoAttributes` declaration and turn it into REDACTION
 * (issue [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
 *
 * TWO registrations, and both are needed because `perResourceSecrets` is
 * keyed by LOGICAL ID:
 *
 * - the values go into the PRODUCER's own bag, which is what
 *   `scrubResourceRecord` redacts this record's `attributes` with;
 * - the logical id goes into {@link noEchoAttributeResources}, which every
 *   later resolution consults, so a DEPENDENT that resolves an `Fn::GetAtt`
 *   here records the same plaintext into ITS bag and its resolved
 *   `properties` are masked too. Without the second half the custom resource's
 *   record would be clean while the SSM parameter that consumed it still held
 *   the plaintext — a line that cannot be explained to someone who set
 *   `NoEcho` expecting "not in state".
 *
 * Called AFTER the provider returns and BEFORE the state record is built, so
 * the needles exist by the time anything is persisted. Nothing is masked in
 * memory: `stateResources[logicalId].attributes` keeps the REAL value, which
 * is what the resolver serves to dependents in this same run.
 *
 * `ownProperties` is the resource's OWN resolved template bag, and passing it
 * is what stops a handler from masking cdkd's inputs back at it (issue #2274
 * review). Its whole string leaves are EXCLUDED from the needles: a handler
 * echoing `event.ResourceProperties` into its `Data` — the shape the CDK
 * `Provider` samples encourage — makes `Data.X` equal the resource's own
 * `ServiceToken`, and registering that rewrites `properties.ServiceToken` to
 * `***` in the record `CustomResourceProvider.delete` reads it back from,
 * which can then no longer address the handler and skips the delete
 * (go-to-k/cdkd#3938).
 * A value already present in the template is not handler-GENERATED, so
 * excluding it gives up no secrecy — and where the template value IS a
 * resolved secret it already carries a real EXPRESSION needle, which
 * `recordMaskOnlyValue` would refuse to demote anyway.
 */
export function registerNoEchoAttributes(
  this: DeployEngine,
  logicalId: string,
  result: {
    attributes?: Record<string, unknown>;
    noEchoAttributes?: boolean;
    noEchoAttributeNames?: readonly string[];
  },
  secrets: RecordedSecretValues,
  ownProperties?: Record<string, unknown>
): void {
  const attributes = result.attributes;
  if (attributes === undefined) return;
  const excluded = ownProperties === undefined ? undefined : wholeStringLeavesOf(ownProperties);
  if (result.noEchoAttributes === true) {
    this.noEchoAttributeResources.set(logicalId, true);
    recordMaskOnlyValuesIn(attributes, secrets, excluded);
    return;
  }
  // The PER-ATTRIBUTE arm. Filtered against the bag actually returned, so a
  // name the provider declared but did not deliver registers nothing — the
  // declaration is evidence about a VALUE, and with no value there is no
  // needle to record.
  const names = (result.noEchoAttributeNames ?? []).filter((name) => name in attributes);
  if (names.length === 0) return;
  this.noEchoAttributeResources.set(logicalId, new Set(names));
  for (const name of names) recordMaskOnlyValuesIn(attributes[name], secrets, excluded);
}

/**
 * Refuse to provision a resource whose resolution served a REDACTED attribute
 * out of a previous deploy's state (issue #2274).
 *
 * The unavoidable cost of masking a `NoEcho` custom resource's `Data`: state
 * then holds `***`, and cdkd cannot get the value back without re-invoking
 * the handler, which is a SIDE-EFFECTING operation it must not perform just
 * to fill in a property. Since `ResourceState` carries no durable `NoEcho`
 * flag (issue #2449), there is not even a way to tell the user which
 * attribute it was without this record.
 *
 * REFUSING IS THE SAFE DIRECTION and the alternative is not "it works": the
 * literal `***` would be written to the live resource by any provider that
 * sends its desired bag wholesale (`PutParameter` and every
 * `Put*Configuration`), which is the issue #1498 / #1501 data-corruption
 * class. A loud failure naming the remedy is strictly better than a silent
 * wrong write.
 *
 * NARROW BY CONSTRUCTION. The bag is only non-empty when a resolution
 * actually served a masked value during THIS resource's resolution, so a
 * resource whose properties merely happen to contain the string `***` is
 * untouched — which is why the check is not "does `resolvedProps` hold the
 * mask". And the diff pass does not consult the bag at all, so an untouched
 * stack still reports NO_CHANGE and deploys.
 *
 * "A resolution", not "an `Fn::GetAtt`": the pushers are
 * `noteAttributeSecrecy`, `reresolveCrossStackValue` and — since the issue
 * #2847 review — `noteRefStateMask`, the `Ref` branch that reads a recovery
 * key out of the same persisted bags. {@link maskedRecordRemedyFor} is the
 * authority on the full shape list.
 *
 * This block sits DIRECTLY above its subject, and the previous revision's did
 * not: `maskedRecordRemedyFor` was inserted between the two, so JavaScript's
 * "only the LAST of two consecutive block comments attaches" rule (the same
 * one `cloud-control-provider.ts`'s `import()` doc warns about) silently
 * re-pointed 25 lines of doc at the wrong function and left this one with
 * none. Keep a new helper OUT of the gap.
 */
export function refuseRedactedAttributeReads(
  this: DeployEngine,
  logicalId: string,
  resourceType: string,
  context: import('./intrinsic-function-resolver.js').ResolverContext
): void {
  const reads = context.redactedAttributeReads;
  if (reads === undefined || reads.length === 0) return;
  // TWO POPULATIONS REACH THIS REFUSAL, and naming only the first was a
  // measured defect (issue
  // [#2847](https://github.com/go-to-k/cdkd/issues/2847) review): since
  // `CloudControlProvider.import` masks the model keys it cannot certify as
  // attributes, a Cloud-Control-IMPORTED resource trips this too — and every
  // remedy below is custom-resource-only, so the user was handed three
  // instructions that cannot apply and none that can. The record carries no
  // durable marker saying WHICH population a mask came from (issue #2449 is
  // that gap), so the message names both rather than guessing.
  //
  // ARM (2) NAMES ONE ACTION AND DOES NOT ENUMERATE CAUSES, and that shape is
  // the point rather than brevity. Successive review rounds each rewrote this
  // arm as a cause list with a remedy per cause, and each list was wrong in a
  // NEW way — a remedy that could not apply, then a cause that cannot produce
  // this refusal, then a remedy necessary but not sufficient. Do not re-expand
  // it into a list: the causes are not enumerable from here —
  // `getTopLevelReadOnlyProperties` answers `undefined` for any failure at
  // all — so any list written here is a claim the code cannot support.
  //
  // THE TARGET IDS ARE COMPUTED, NOT DESCRIBED, and that is the fix for a
  // defect class rather than for one sentence. This method's `logicalId` is
  // the resource being PROVISIONED — the consumer that read the attribute —
  // while the masked record belongs to the READ's target. Successive rounds
  // tried to convey that in prose and each attempt was wrong for a `reads`
  // shape it had not considered: interpolating `logicalId` named the consumer
  // and told the user to `--force`-overwrite the wrong row; "the name to the
  // left of the dot" reads as `Outputs` for `nested stack Child Outputs.Foo`,
  // as `Cr.Endpoint` for a dotted attribute path like `Cr.Endpoint.Password`,
  // and has no referent at all for the `Fn::ImportValue` /
  // `Fn::GetStackOutput` forms. The population is heterogeneous, so no single
  // instruction describes it — `maskedRecordRemedyFor` PARTITIONS it instead,
  // and each arm says only what is true of its own shape. Adding a `reads`
  // shape means extending that helper, not this prose.
  //
  // THE COMMAND IS SELECTIVE AND CARRIES `--force`, and both halves were
  // traced through `cdkd import` rather than reasoned about. A BARE re-run is
  // actively destructive here: `CloudControlProvider.import` is
  // explicit-override-only, so with no `--resource` the resource resolves to
  // `skipped-not-found`, and auto mode rebuilds the resource map from
  // `{}` — the row is DROPPED from state and the next deploy tries to CREATE
  // a live resource. (Auto mode refuses without `--force` at all, so the user
  // would hit that wall first.) Selective mode merges onto the existing map,
  // and `--force` is required because the listed id already HAS a state entry
  // — the one holding the mask. `import.ts`'s own two refusals are the
  // authority for both clauses. A test pins this string per `reads` shape;
  // the rewrite history above is why it is pinned rather than trusted.
  //
  // ONE CASE THE COMMAND DOES NOT HEAL, narrow but real: if the re-import's
  // `GetResource` again yields no usable model, `import()` returns
  // `attributes: {}`, and `buildStackState`'s same-physical-id carry-over
  // keeps the PREVIOUS masked bag rather than replacing it — so the refusal
  // repeats. Deliberately: dropping the mask would make the read resolve to
  // the physical id instead. The import warns naming each kept key (issue
  // [#2927](https://github.com/go-to-k/cdkd/issues/2927)).
  throw new ProvisioningError(
    `Cannot resolve ${reads.map((read) => read.display).join(', ')} for ${logicalId}: cdkd's recorded state holds only the ` +
      `redaction mask there, and the value is not recoverable from state. There are two ways a ` +
      `record comes to hold the mask. (1) A custom resource handler declared its response ` +
      `NoEcho: true — the value is generated by the handler, so cdkd has nothing to re-derive ` +
      `it from and must not write the literal mask to AWS. Remedies: force that custom resource ` +
      `to update (change one of its properties, e.g. a nonce / version property) so its handler ` +
      `runs again and supplies the value in this same run; or stop setting NoEcho on that ` +
      `response. If the value comes from ANOTHER stack, the producer and this stack must deploy ` +
      `in ONE run (cdkd deploy --all) with the producer's custom resource actually running — ` +
      `re-deploying the producer by itself does not help, because it re-masks the value on the ` +
      `way into its own state. (2) The resource was adopted by 'cdkd import' through the Cloud ` +
      `Control fallback, which records only the attributes the type's CloudFormation schema ` +
      `declares read-only and masks the rest. Either the attribute named above is not one of ` +
      `them — CloudFormation would reject an Fn::GetAtt naming it too, so stop reading it — or ` +
      `cdkd could not read that schema and masked the whole model, which the import warned about ` +
      `when it happened. If that warning named a missing ` +
      `cloudformation:DescribeType permission, grant it first. ` +
      `See https://github.com/go-to-k/cdkd/issues/2449. ` +
      // LAST: the remedy ends in labelled command lines, and prose after them
      // lands on the final command's line (go-to-k/cdkd#3436).
      `${DeployEngine.maskedRecordRemedyFor(reads, context.resources)}`,
    resourceType,
    logicalId
  );
}

/**
 * Every secret this deploy resolved, in one bag.
 *
 * `perResourceSecrets` is keyed by logical id and `outputSecrets` holds the
 * outputs pass, which is the right scoping for a RECORD (a resource's own
 * secrets redact that resource). A cross-stack read entry carries no logical
 * id, so it has nothing to be scoped BY — the reference may have sat in any
 * resource's property or in an Output.
 *
 * Over-redaction here is the safe direction and is bounded the same way the
 * value scan always is: `MIN_NEEDLE_LENGTH` keeps a short plaintext from
 * matching a substring, and an export name that genuinely equals another
 * resource's secret is a name that should not be persisted either.
 */
export function allRecordedSecrets(this: DeployEngine): RecordedSecretValues {
  const all: RecordedSecretValues = new Map();
  for (const bag of this.perResourceSecrets.values()) {
    for (const [plaintext, expression] of bag) all.set(plaintext, expression);
  }
  for (const [plaintext, expression] of this.outputSecrets) all.set(plaintext, expression);
  return all;
}

/**
 * Read a reader back from AWS to decide the replacement ceiling of a
 * create-only property that carries a `NoEcho` value supplied in THIS deploy
 * (go-to-k/cdkd#3729). The record holds only `***` there, so it cannot say
 * whether the value moved; AWS can.
 *
 * What makes it safe:
 *  - It hands the provider the RECORD's `properties`, where the value is
 *    `***`, never the resolved bag. A provider that echoes its `properties`
 *    argument for a field AWS does not return therefore reports `***`, which
 *    never equals the value. The deploy-time observed capture passes the
 *    resolved bag; this read must not take that call shape.
 *  - The provider is routed by the RECORD (its type and `provisionedBy`), as
 *    the deploy-start refresh does: the question is what the EXISTING
 *    resource holds. A `cc-api` record reads through Cloud Control.
 *  - The readback stays in this call. It is never installed as
 *    `observedProperties`, never joins `observedCaptureTasks`, and is dropped
 *    once compared. It is not gated on `--no-capture-observed-state`, which
 *    is about the persisted drift baseline, and this read persists nothing.
 *  - A throw of any kind, or a read outliving its cap, is `read-failed`. The
 *    error is masked with the resource's bag, and only its `name` is logged,
 *    never its message, which could echo the value.
 */
export async function readReaderForFreshNoEchoCeiling(
  this: DeployEngine,
  logicalId: string,
  currentResource: ResourceState,
  secrets: RecordedSecretValues
): Promise<FreshNoEchoReadback> {
  let provider: ResourceProvider;
  try {
    provider = this.providerRegistry.getProviderFor({
      resourceType: currentResource.resourceType,
      provisionedBy: currentResource.provisionedBy,
    }).provider;
  } catch {
    return { failure: 'not-readable' };
  }
  const readCurrentState = provider.readCurrentState?.bind(provider);
  if (readCurrentState === undefined) return { failure: 'not-readable' };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const live = await Promise.race([
      Promise.resolve().then(() =>
        readCurrentState(
          currentResource.physicalId,
          logicalId,
          currentResource.resourceType,
          currentResource.properties
        )
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('readback timed out')),
          this.noEchoCeilingReadbackTimeoutMs
        );
      }),
    ]);
    if (live === undefined || live === null || typeof live !== 'object') {
      return { failure: 'not-readable' };
    }
    return { live };
  } catch (error: unknown) {
    // `maskSecretsInError` masks `message` / `stack` / `cause`, not `name`:
    // only an identifier-shaped name is printed. Guarded, so an error whose
    // getters throw still reads as `read-failed` rather than escaping.
    let errorClass = 'Error';
    try {
      const masked = maskSecretsInError(error, secrets);
      const name = masked instanceof Error ? masked.name : typeof masked;
      if (typeof name === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(name)) errorClass = name;
    } catch {
      // keep 'Error'
    }
    this.logger.debug(
      safeMsg`Readback of ${logicalId} for a NoEcho value's replacement check failed (${errorClass}).`
    );
    return { failure: 'read-failed' };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Mask one line of engine-authored text with a resource's OWN recorded
 * secrets (issue [#2038](https://github.com/go-to-k/cdkd/issues/2038)).
 *
 * Per-resource, never session-wide — see the `perResourceSecrets` field doc
 * for why one resource's secret must not rewrite another's literal. A
 * `logicalId` with no entry (or an empty bag) forwards verbatim, so every
 * non-secret resource is byte-identical to before.
 */
export function maskForResource(this: DeployEngine, logicalId: string, text: string): string {
  return maskSecretsInText(text, this.perResourceSecrets.get(logicalId) ?? EMPTY_SECRETS);
}
