// FIRST, ahead of the host import: `DeployEngine` aliases this function as a
// static field (`static maskedRecordRemedyFor = ...`), read when the class is
// defined. When this module is the first one loaded, the host evaluates inside
// that import, so the leaf module must already be evaluated by then.
export { maskedRecordRemedyFor } from './masking/remedy.js';
import { DeployEngine, EMPTY_SECRETS } from '../deploy-engine.js';
import type { ChildTemplateLoader, parameterInputsFor } from '../masked-property-fingerprints.js';
import type { CloudFormationTemplate, ResourceProvider } from '../../types/resource.js';
import type { ResourceState } from '../../types/state.js';
import {
  ambientCredentialConfig,
  credentialFingerprint,
} from '../../utils/ambient-client-defaults.js';
import { safeMsg } from '../../utils/display-safe.js';
import type { FreshNoEchoReadback } from '../deploy-value-equality.js';
import {
  type RecordedSecretValues,
  type SecretMasker,
  carriesFreshNoEchoValue,
  carriesSecretMask,
  createUnionSecretMasker,
  hasMaskableValues,
  isSameGenerationBag,
  literalSplitDelimitersOf,
  maskSecretsInError,
  maskSecretsInText,
  foldRecording,
  type RecordingPolicy,
  recordLogOnlyParameterValue,
  recordLogOnlyValue,
  recordRecoverableMaskedOutput,
  redactInheritedParameterValue,
  redactForState,
  unionOfSecretBags,
  recordedNoEchoValuesOf,
} from '../secret-redaction.js';
import {
  type StateNamingSecrets,
  namingSecretsWithRecordedNoEcho,
  secretNameNeedlesOf,
  secretNamesReadBy,
  storedSecretNameNeedles,
} from '../secret-name-needles.js';
import { declaresNoEcho } from '../noecho-declared.js';
import { maskOutputsByPosition, type NoEchoDeps } from './noecho.js';

// The judge lives in `../secret-name-needles.ts`, shared with the CLI commands
// that resolve against state (go-to-k/cdkd#3869); re-exported for its callers.
export { secretNameNeedlesOf };
export {
  registerNoEchoAttributes,
  refuseRedactedAttributeReads,
} from './masking/noecho-attributes.js';

/**
 * One deploy's secret-masking and masked-property fingerprint state: the
 * per-resource secret bags, their position sources, the derived-name
 * registry, and the stack's `NoEcho` judging inputs. `deploy()` replaces the
 * whole object rather than clearing it in place, so a reused engine never
 * masks, persists or judges with a previous deploy's bags.
 */
export class SecretsRunState {
  /**
   * PER-RESOURCE map of resolved SECRET dynamic-reference values
   * (plaintext -> `{{resolve:...}}` expression) the resolver records for each
   * resource's own resolution (GHSA fix). Keyed by logicalId. Per-resource, NOT
   * session-wide, because a session-wide map cross-contaminates: if resource A
   * resolves a `{{resolve:...:SecretString}}` whole-secret reference to value V,
   * and resource B (e.g. the `AWS::SecretsManager::Secret` that OWNS the secret)
   * carries V as its own LITERAL property, a session-wide value scan would
   * wrongly rewrite B's literal to A's expression — a false positive that shows
   * up as a permanent spurious diff. Redacting each resource only with the
   * secrets substituted during ITS OWN resolution scopes the value match
   * correctly. Kept on the engine (not just the resolver context) so the async
   * observed-property capture — which drains after the context is gone — can
   * still redact an AWS-readback secret (Cognito `client_secret`). Reset per
   * `deploy()`. See `secret-redaction.ts`.
   */
  perResourceSecrets = new Map<string, RecordedSecretValues>();
  /**
   * The deploy-wide DERIVED-NAME registry (go-to-k/cdkd#3869): per logical
   * id, an EMPTY map whose LOG-ONLY needles are what its physical ids print as
   * when its name came from a secret ({@link noteSecretNamedRecord}). The
   * resource's own printed lines mask with it ({@link printingSecretsFor}, and
   * the printing bag `provisionResource` binds), and a resource reading it
   * through `Ref` / `Fn::GetAtt` records its needles, with the value it read,
   * as LOG-ONLY needles of its own bag. Never persisted. Reset per `deploy()`,
   * like `perResourceSecrets`.
   */
  secretNameNeedles = new Map<string, RecordedSecretValues>();
  /**
   * PER-RESOURCE unresolved TEMPLATE properties, keyed by logicalId (issues
   * #1904 / #1900). The redaction choke point uses this as the POSITION source:
   * wherever the template leaf is a `{{resolve:...}}` string, state persists
   * that string verbatim instead of asking the value-keyed map which expression
   * a plaintext came from — a question that map cannot answer when two
   * expressions resolve to the same value. Captured at the same two sites that
   * populate `perResourceSecrets`, where the unresolved bag is already in hand.
   * Reset per `deploy()`.
   */
  perResourceTemplateProps = new Map<string, Record<string, unknown>>();

  /**
   * The resource TYPE each logical id was resolved as during THIS deploy
   * (issue #2934), the sibling of {@link perResourceSecrets} and
   * {@link perResourceTemplateProps}.
   *
   * Exists only so the orphan-record redaction can tell "these needles belong
   * to this record" from "a CDK refactor reused this logical id for a different
   * resource". Keying that on `state.resources` instead was tried and is WRONG
   * in the direction that matters: an orphan is by definition NOT in
   * `resources`, so the gate read false for the record being minted, the
   * needles went empty, and the plaintext survived into `state.json`. The
   * real-AWS secret fixture caught it.
   */
  perResourceResolvedType = new Map<string, string>();
  /**
   * The stack's `NoEcho` parameter values, set once parameters resolve
   * (go-to-k/cdkd#4451): a masked property whose template text holds one is
   * refused a fingerprint at the save. Reset per `deploy()`.
   */
  fingerprintNoEchoValues: RecordedSecretValues | undefined = undefined;
  /**
   * The needles of every record named from a secret AS THE DEPLOY FOUND THEM
   * (go-to-k/cdkd#3869), judged once before anything provisions: a nested
   * stack row's registry carries them into the child's deploy, whose stored
   * values can hold a name a parent record replaced earlier in the same run no
   * longer spells. Printing only. Reset per `deploy()`.
   */
  preDeploySecretNamedRecords: RecordedSecretValues | undefined = undefined;
  /**
   * Per record AS THE DEPLOY FOUND IT, what it stores where a `NoEcho`
   * parameter served it (`recordedNoEchoValuesOf`, go-to-k/cdkd#3869), as
   * log-only needles: a name taken from a value since CHANGED, or a short or
   * `Number` one, which `fingerprintNoEchoValues` cannot judge. Read by
   * `namingSecretsFor` alone. Judging and printing only. Reset per `deploy()`.
   */
  storedNoEchoNamingValues: ReadonlyMap<string, RecordedSecretValues> = new Map();
  /**
   * How each template parameter enters a masked property's INPUT fingerprint
   * (go-to-k/cdkd#4543), set once parameters resolve, so the diff pass and the
   * provisioning arms classify every parameter alike. Reset per `deploy()`.
   */
  fingerprintParameters: ReturnType<typeof parameterInputsFor> | undefined = undefined;
  /**
   * The nested-stack templates of the cloud assembly this deploy reads
   * (go-to-k/cdkd#4565), so a masked property reading a clean nested-stack
   * output is resolved alike in the diff pass and the provisioning arms. Set
   * with {@link fingerprintParameters}; reset per `deploy()`.
   */
  fingerprintChildTemplates: ChildTemplateLoader | undefined = undefined;
  /**
   * The input fingerprints (layout 2) each resource's masked properties
   * resolved to when this deploy provisioned it (go-to-k/cdkd#4543): what the
   * save stamps on a record this deploy wrote. Reset per `deploy()`.
   */
  perResourceInputFingerprints = new Map<string, Record<string, string>>();
}

/**
 * What this module's plain functions read from the engine beyond
 * {@link SecretsRunState}, built at each call site as `DeployEngine.maskingDeps()`.
 * `outputsRun` / `noEchoRun` are REASSIGNED by every `deploy()` and
 * `noEchoCeilingReadbackTimeoutMs` is a field a test shortens, so they are
 * live getters; `noEchoDeps` stays bound to the calling engine.
 */
export interface MaskingDeps {
  options: Pick<DeployEngine['options'], 'inheritedSecrets'>;
  stackRegion: DeployEngine['stackRegion'];
  logger: Pick<DeployEngine['logger'], 'debug'>;
  providerRegistry: Pick<DeployEngine['providerRegistry'], 'getProviderFor'>;
  outputsRun: () => DeployEngine['outputsRun'];
  noEchoRun: () => DeployEngine['noEchoRun'];
  noEchoDeps: () => NoEchoDeps;
  noEchoCeilingReadbackTimeoutMs: () => number;
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
  run: SecretsRunState,
  deps: MaskingDeps,
  diffSecrets: RecordedSecretValues | undefined,
  template: CloudFormationTemplate,
  parameterValues: Record<string, unknown>,
  /**
   * The state records the diff compares against (go-to-k/cdkd#3869): a
   * create-only property that stopped reading a resource NAMED from a secret
   * prints the record's copy of that name as its OLD side, and no resolution
   * of the diff pass reads it (`storedSecretNameNeedles`). Judged on the
   * masker's FIRST call, so a deploy that prints no such line pays nothing.
   */
  resources: Readonly<Record<string, ResourceState>>
): SecretMasker {
  const inherited = deps.options.inheritedSecrets;
  const noEchoValues: RecordedSecretValues = new Map();
  // The pieces of every literal `Fn::Split` over a `NoEcho` value too
  // (go-to-k/cdkd#4049), for a property that stopped reading one.
  const noEchoNames = new Set(
    Object.entries(template.Parameters ?? {})
      .filter(([, definition]) => declaresNoEcho(definition))
      .map(([name]) => name)
  );
  const splitDelimiters = literalSplitDelimitersOf(template, noEchoNames);
  for (const [name, definition] of Object.entries(template.Parameters ?? {})) {
    if (declaresNoEcho(definition) && Object.hasOwn(parameterValues, name)) {
      recordLogOnlyParameterValue(noEchoValues, parameterValues[name], splitDelimiters);
    }
  }
  const stateNames: RecordedSecretValues = new Map();
  const union = createUnionSecretMasker([diffSecrets, noEchoValues, stateNames, inherited]);
  let judged = false;
  return (text) => {
    if (!judged) {
      judged = true;
      // Judged with the stack's `NoEcho` values as every other deploy judge
      // is (`fingerprintNoEchoValues`, set before the diff pass): whole values
      // only, never a `Fn::Split` piece an ordinary name can hold nor a value
      // that IS a `{{resolve:` token, and a nested child's parent-passed ones
      // too. Records still spelling a reference or the mask need none.
      // go-to-k/cdkd#3869: per record, plus what each stored where a
      // `NoEcho` parameter served it (a value since changed).
      storedSecretNameNeedles(resources, stateNamingSecrets(run), stateNames);
    }
    return union(text);
  };
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
  deps: MaskingDeps,
  parameterValues: Record<string, unknown>
): ReadonlySet<string> | undefined {
  const inherited = deps.options.inheritedSecrets;
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
  deps: MaskingDeps,
  parameterValues: Record<string, unknown>
): Record<string, unknown> {
  const inherited = deps.options.inheritedSecrets;
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
    // An uncertified value falls back to a value scan of the PARENT bag
    // inside `redactInheritedParameterValue`, the ONE function the persist
    // side's `{Ref: <Param>}` arm also calls (issue #2349), so the two sides
    // cannot scan different bags.
    out[name] = redactInheritedParameterValue(inherited, name, value);
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
  deps: MaskingDeps,
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
    recordRecoverableMaskedOutput(identity, stackName, deps.stackRegion, key, plaintext);
  }
}

/**
 * Fold every outputs-pass recording map into `outputSecrets` — the entries,
 * and the uncollapsed evidence beside them (issue #2485: without it a
 * literal Output embedding one of two same-plaintext references would lose
 * its span positioning and persist the sibling's expression). A nested
 * child's parameter reads are not folded here: `resolveOutputs` mirrors them
 * onto `outputSecrets` as they are recorded (`mirrorInheritedParameterReads`,
 * issue [#4913](https://github.com/go-to-k/cdkd/issues/4913)). Only what the
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
export function absorbOutputsPassSecrets(deps: MaskingDeps): void {
  const outputsRun = deps.outputsRun();
  for (const passSecrets of outputsRun.outputsPassSecretMaps) {
    foldRecording(passSecrets, outputsRun.outputSecrets, OUTPUTS_PASS_FOLD);
  }
}

/**
 * What {@link absorbOutputsPassSecrets} folds from each outputs-pass map into
 * the outputs bag, every recording kind named (go-to-k/cdkd#5048).
 *
 * - `pairs`, `mask-only-marks`: the evidence the outputs bag's persist walk
 *   positions and masks with (issue #2485, #2453).
 * - `reference-provenance` (state schema v12): carried as `mergeResolvedPairs`
 *   carried it before #5048. Nothing reads it off this bag today: an output's
 *   persisted provenance comes from its own per-output sink
 *   (`reference-provenance-record.ts`).
 * - `physical-name-copies` (go-to-k/cdkd#4849): the physical ids the pass read
 *   stay copies of an id in the outputs bag too (an `!Ref Topic` output, its
 *   export), or a resource NAMED from a `NoEcho` value stores its ARN output
 *   as `***`.
 * - `log-only` is withheld: the outputs bag is read only to PERSIST (this
 *   module's outputs redaction, the cross-stack key normalizer, the
 *   all-secrets union, which copies entries), and every line of the outputs
 *   pass masks with the pass map itself.
 * - `public-proofs` is withheld, as before #5048: carried, they would change
 *   which mixed leaves the outputs walk keeps (`provenPublicValue`), a
 *   behavior change this fold does not make.
 *
 * Exported for its test (`secret-redaction-recording-5048.test.ts`).
 */
export const OUTPUTS_PASS_FOLD: RecordingPolicy = {
  pairs: 'carry',
  'log-only': 'withhold',
  'mask-only-marks': 'carry',
  'reference-provenance': 'carry',
  'physical-name-copies': 'carry',
  'public-proofs': 'withhold',
};

/**
 * Redact the outputs bag. NOT a pure transform: it folds the outputs pass
 * map into `outputSecrets` first (issue #2814), so every call can grow that
 * bag. Its KEY set only grows, and the bag has no other reader, which is
 * what makes calling this on every save, index write and summary safe. The
 * resolved PAIRS beside those keys are not equally free to refold — see
 * {@link absorbOutputsPassSecrets}, which states what a late one costs.
 */
export function redactOutputs(
  deps: MaskingDeps,
  outputs: Record<string, unknown>
): Record<string, unknown> {
  const redacted = redactOutputsBag(deps, outputs);
  // State schema v12: a redacted copy of a bag this deploy resolved is still
  // that bag, for the persist writer's provenance (`outputsResolvedThisRun`).
  if (deps.outputsRun().outputsResolvedThisRun.has(outputs)) {
    deps.outputsRun().outputsResolvedThisRun.add(redacted);
  }
  return redacted;
}

function redactOutputsBag(
  deps: MaskingDeps,
  outputs: Record<string, unknown>
): Record<string, unknown> {
  // First, and before the empty-bag return: a late recording (issue #2814)
  // may be the only needle there is.
  absorbOutputsPassSecrets(deps);
  // go-to-k/cdkd#4043: the positional `NoEcho` arm runs on every call, after
  // the dynamic-reference redaction, so an output a `NoEcho` parameter served
  // persists `***` whatever its type or length.
  if (deps.outputsRun().outputSecrets.size === 0) {
    return maskOutputsByPosition(deps.noEchoRun(), deps.noEchoDeps(), outputs);
  }
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
  const outputsRun = deps.outputsRun();
  return maskOutputsByPosition(
    deps.noEchoRun(),
    deps.noEchoDeps(),
    redactForState(
      outputs,
      outputsRun.outputsSourceUsable
        ? {
            provenance: 'template-sourced',
            secrets: outputsRun.outputSecrets,
            source: outputsRun.outputsTemplateSource,
            // `resolveOutputs` marks the bag it resolved this pass (issue
            // #2516); the claim that mark carries is stated here
            // (go-to-k/cdkd#5047). A previous deploy's bag is unmarked.
            generation: isSameGenerationBag(outputs) ? 'same-generation' : 'unproven',
          }
        : { provenance: 'value-scan', secrets: outputsRun.outputSecrets }
    )
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
export function allRecordedSecrets(run: SecretsRunState, deps: MaskingDeps): RecordedSecretValues {
  const all: RecordedSecretValues = new Map();
  for (const bag of run.perResourceSecrets.values()) {
    for (const [plaintext, expression] of bag) all.set(plaintext, expression);
  }
  for (const [plaintext, expression] of deps.outputsRun().outputSecrets)
    all.set(plaintext, expression);
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
  deps: MaskingDeps,
  logicalId: string,
  currentResource: ResourceState,
  secrets: RecordedSecretValues
): Promise<FreshNoEchoReadback> {
  let provider: ResourceProvider;
  try {
    provider = deps.providerRegistry.getProviderFor({
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
          deps.noEchoCeilingReadbackTimeoutMs()
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
    deps.logger.debug(
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
export function maskForResource(run: SecretsRunState, logicalId: string, text: string): string {
  return maskSecretsInText(text, printingSecretsFor(run, logicalId) ?? EMPTY_SECRETS);
}

/**
 * The derived-name REGISTRY bag of `logicalId` (go-to-k/cdkd#3869): an EMPTY
 * map whose LOG-ONLY needles are the physical-id needles of every record of it
 * this deploy judged named from a secret, and, for a nested-stack row, the
 * needles its reads of a secret-named resource record, with their `Fn::Base64`
 * / `Fn::Split` derivatives (`printNestedStackReadsOnly` makes it the row's
 * print-only bag). Created on first ask, so a binder
 * can hold it by reference before anything is registered: `provisionResource`
 * binds it as a PRINTING bag around the resource's whole body, so every line
 * logged there masks a needle registered mid-body too.
 */
export function secretNameBagFor(run: SecretsRunState, logicalId: string): RecordedSecretValues {
  let bag = run.secretNameNeedles.get(logicalId);
  if (bag === undefined) {
    bag = new Map();
    run.secretNameNeedles.set(logicalId, bag);
  }
  return bag;
}

/**
 * Register `record` of `logicalId` in this deploy's derived-name registry
 * when it is named from a secret (go-to-k/cdkd#3869), and return its needles.
 * A name is judged with `namingSecretsFor` (the resource's own bag plus the
 * stack's `NoEcho` values), an embedded plaintext with the resource's own bag
 * alone, so call it after the resource resolved to see a name this deploy
 * resolved. The registry only GROWS within a
 * deploy: a replaced resource keeps its old id's needles, which the lines
 * naming the old resource still print.
 */
export function noteSecretNamedRecord(
  run: SecretsRunState,
  logicalId: string,
  record: Parameters<typeof secretNameNeedlesOf>[1]
): ReadonlySet<string> | undefined {
  const needles = secretNameNeedlesOf(logicalId, record, namingSecretsFor(run, logicalId), {
    embedded: run.perResourceSecrets.get(logicalId),
  });
  if (needles === undefined) return undefined;
  const registry = secretNameBagFor(run, logicalId);
  for (const needle of needles) recordLogOnlyValue(registry, needle);
  return needles;
}

/**
 * The bag a name of `logicalId` is judged secret-derived with: its own
 * resolution's secrets, plus every `NoEcho` parameter value of the stack
 * (go-to-k/cdkd#3869 security review), since a name taken from one is stored
 * in plaintext and no resource's bag holds it unless that resource resolved
 * this deploy. Judging only: never persisted or masked with as such.
 */
export function namingSecretsFor(
  run: SecretsRunState,
  logicalId: string
): RecordedSecretValues | undefined {
  const own = run.perResourceSecrets.get(logicalId);
  const noEcho = run.fingerprintNoEchoValues;
  // go-to-k/cdkd#3869: what the record stored where a `NoEcho` parameter
  // served it, for a name taken from a value since changed.
  const stored = run.storedNoEchoNamingValues.get(logicalId);
  if (!hasMaskableValues(noEcho) && !hasMaskableValues(stored)) return own;
  return unionOfSecretBags([own, noEcho, stored]);
}

/**
 * The per-record judging bag a deploy's STATE judges take
 * (go-to-k/cdkd#3869): the stack's `NoEcho` values plus what each record
 * stored where a `NoEcho` parameter served it (`storedNoEchoNamingValues`).
 */
export function stateNamingSecrets(run: SecretsRunState): StateNamingSecrets {
  const base = run.fingerprintNoEchoValues;
  const stored = run.storedNoEchoNamingValues;
  if (stored.size === 0) return base;
  // The same bag while its inputs hold, so a caller memoizing on it (the
  // heal's judge) judges each record once; both inputs are replaced, never
  // mutated, per deploy.
  const hit = namingSecretsMemo.get(stored);
  if (hit !== undefined && hit.base === base) return hit.secrets;
  const secrets = namingSecretsWithRecordedNoEcho(base, (logicalId) => stored.get(logicalId));
  namingSecretsMemo.set(stored, { base, secrets });
  return secrets;
}

const namingSecretsMemo = new WeakMap<
  ReadonlyMap<string, RecordedSecretValues>,
  { base: RecordedSecretValues | undefined; secrets: StateNamingSecrets }
>();

/**
 * Record, for each record of `resources` as the deploy found it, what it
 * stores where a `NoEcho` parameter served it (go-to-k/cdkd#3869): positioned
 * by `template` (the condition-pruned one, read with `conditions`) where it
 * still declares the resource as the record's type, and by the record's own
 * `noEchoLeaves`. The parameters are the template's declared `NoEcho` ones
 * plus a nested child's `inheritedNoEchoParameters`. Printing and judging
 * only; no AWS call.
 */
export function captureStoredNoEchoNamingValues(
  run: SecretsRunState,
  deps: MaskingDeps,
  resources: Readonly<Record<string, ResourceState>>,
  template: CloudFormationTemplate,
  conditions: Readonly<Record<string, boolean>>
): void {
  const names = new Set(deps.noEchoRun().inheritedNoEchoParameters);
  for (const [name, definition] of Object.entries(template.Parameters ?? {})) {
    if (declaresNoEcho(definition)) names.add(name);
  }
  const templateResources = (template.Resources ?? {}) as Record<
    string,
    { Type?: unknown; Properties?: unknown } | undefined
  >;
  const captured = new Map<string, RecordedSecretValues>();
  for (const [logicalId, record] of Object.entries(resources)) {
    const templateResource = Object.hasOwn(templateResources, logicalId)
      ? templateResources[logicalId]
      : undefined;
    const bag = recordedNoEchoValuesOf(
      templateResource?.Type === record?.resourceType ? templateResource?.Properties : undefined,
      record,
      names,
      conditions
    );
    if (hasMaskableValues(bag)) captured.set(logicalId, bag);
  }
  run.storedNoEchoNamingValues = captured;
}

/**
 * Register into `logicalId`'s registry the needles of every OTHER resource
 * named from a secret that `record` embeds in a property leaf
 * (go-to-k/cdkd#3869 spec review). For a resource that resolves nothing this
 * deploy (a template DELETE): its record holds what it once read from a
 * secret-named resource (an instance profile's `Roles`), and its provider's
 * lines print it. A reader that resolves records the same needles itself.
 */
export function noteSecretNamedReads(
  run: SecretsRunState,
  logicalId: string,
  record: { properties?: unknown } | undefined,
  resources: Record<string, ResourceState>
): void {
  const read = secretNamesReadBy(logicalId, record, resources, (otherId: string) => ({
    secrets: namingSecretsFor(run, otherId),
    embedded: run.perResourceSecrets.get(otherId),
  }));
  if (read.size === 0) return;
  const registry = secretNameBagFor(run, logicalId);
  for (const needle of read) recordLogOnlyValue(registry, needle);
}

/**
 * The bag a PRINTED line about `logicalId` masks with: its own recorded
 * secrets plus its derived-name registry (go-to-k/cdkd#3869). The resource's
 * own bag by identity when the registry holds nothing, so every other
 * resource masks exactly as before. A NEW bag otherwise: never hand it to
 * anything that persists, positions or decides.
 */
export function printingSecretsFor(
  run: SecretsRunState,
  logicalId: string
): RecordedSecretValues | undefined {
  const secrets = run.perResourceSecrets.get(logicalId);
  const registry = run.secretNameNeedles.get(logicalId);
  if (!hasMaskableValues(registry)) return secrets;
  return unionOfSecretBags([secrets, registry]);
}
