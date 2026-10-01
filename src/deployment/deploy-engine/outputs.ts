import { collectSkippedOutputs } from '../../analyzer/skipped-outputs.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import type { ResourceState } from '../../types/state.js';
import { DeployEngine, EMPTY_SECRETS } from '../deploy-engine.js';
import {
  collectPublishedOutputNames,
  exportAliasCollisionWarning,
  exportNameSecretExposure,
  isExportAliasCollision,
  isOutputSuppressedByCondition,
  secretBearingExportNameWarning,
} from '../outputs-export-alias.js';
import { markNonRetryable } from '../retryable-errors.js';
import {
  markSameGenerationBag,
  maskSecretsInError,
  maskSecretsInText,
  shareLogOnlyValues,
  unionOfSecretBags,
  type RecordedSecretValues,
} from '../secret-redaction.js';

/** See `deploy-engine.ts`: an inline type-only alias, for the `vi.mock` reason stated there. */
type RedactedAttributeRead = import('../intrinsic-function-resolver.js').RedactedAttributeRead;

declare module '../deploy-engine.js' {
  interface DeployEngine {
    /** @internal */
    handleOutputResolutionFailure: OmitThisParameter<typeof handleOutputResolutionFailure>;
    /** @internal */
    resolveOutputs: OmitThisParameter<typeof resolveOutputs>;
    /** @internal */
    buildDisplayOutputs: OmitThisParameter<typeof buildDisplayOutputs>;
  }
}

/**
 * A secrets map that keeps its OWN entries and also writes each one through
 * to `target` the moment it is recorded (issue
 * [#2814](https://github.com/go-to-k/cdkd/issues/2814)).
 *
 * The outputs pass resolves each intrinsic `Export.Name` through one of these.
 * Its own entries are what `exportNameSecretExposure` reads as "substituted
 * into THIS name", which must stay exact -- a view of the whole pass map
 * (`cdkd scrub`'s `SharedEntriesSecrets`) would report every secret the pass
 * has recorded as one the name holds, and refuse every alias. The write-through
 * is what a copy could not give: a part the drain cap stopped waiting for
 * records AFTER the name's block has ended, and when this was a local copied
 * into the pass map in a `finally`, such a record reached nothing.
 *
 * Only `set` writes through: it is the one operation the resolver performs on
 * a recording map (grepped -- no resolver path calls `delete` or `clear` on
 * one). `cdkd scrub`'s `SharedEntriesSecrets` overrides those too, and the
 * asymmetry is deliberate: that one is a VIEW holding no entries of its own,
 * while a `delete` here would leave the pass map carrying an entry this map
 * dropped -- one needle too many, which over-redacts rather than leaks.
 * The ENTRIES only, never the resolved pairs beside them
 * (issue #2485): those are keyed by map INSTANCE (`recordResolvedPair`), so
 * they stay on this one. A name never positions a leaf, and a value re-using
 * the same token records its own pair at the seam, so carrying them could add
 * nothing -- what it COULD do is mark a pair conflicting (an `ssm` reference
 * whose `Type` came back unclassifiable is never cached, so a name resolving
 * it re-asks AWS and can see a value that moved since the value pass) and
 * destroy the positioning the value pass had earned.
 */
class ForwardingSecrets extends Map<string, string> {
  private readonly target: RecordedSecretValues | undefined;

  constructor(target: RecordedSecretValues | undefined) {
    super();
    this.target = target;
  }

  override set(plaintext: string, expression: string): this {
    super.set(plaintext, expression);
    this.target?.set(plaintext, expression);
    return this;
  }
}

/**
 * What a failed Output resolution does, shared by both passes of
 * {@link resolveOutputs} so they cannot drift — the alias pass reports the
 * SAME failure for a name it could not resolve as the value pass does for a
 * value, which is what the single-pass shape did when both lived in one
 * `try`.
 *
 * Issue #1111 item 2: under `--strict-getatt` an unresolvable Output fails
 * the deploy instead of silently publishing nothing (which breaks downstream
 * `Fn::ImportValue` consumers with "export not found" long after this deploy
 * exits 0).
 *
 * The error is masked on both arms (issue
 * [#2728](https://github.com/go-to-k/cdkd/issues/2728)). The resolver's own
 * failures echo the offending reference token, a secret id / JSON key, or
 * an SSM parameter name, and `resolveSub` / `resolveJoin` re-enter
 * `resolveDynamicReferences` with the ASSEMBLED string — so a reference
 * built out of a value this same pass resolved from a secret puts that
 * plaintext into the echoed field (a JSON key assembled from the resolved
 * password says `key '<password>' not found`).
 *
 * TWO bags, the inherited one first, the same pair the resolver's
 * `maskSecretsForLog` masks against and for the same reason (issue #1903
 * round 2): on a nested-stack child the parent-decrypted parameter
 * plaintext is in `inheritedSecrets` and not in the pass map until a
 * `{Ref: <Param>}` resolution copies it across. No shape reaching this
 * handler before that copy has been constructed (every `${Param}` route
 * goes through `resolveRef`, which records), so the inherited bag is
 * defense in depth here — but two masking sites in one flow must not argue
 * opposite sides of the same question. `secrets` is the outputs pass's own
 * map: everything recorded before this handler runs, an `Export.Name`
 * resolution's entries included (its map writes each one through to the
 * pass map as the resolver records it, so they are here before the `catch`
 * is; issue #2814 replaced the `finally` that copied them at the end of
 * the block). Since issue #2563 a still-pending concurrent part
 * is in the PASS bag before this handler runs: the resolver drains every
 * part it started before a rejection reaches a caller. Not
 * unconditionally, and the weaker claim is the true one -- the drain is
 * bounded, and since the outputs pass wraps BOTH its loops in one budget
 * the bound spans the whole pass rather than one resolution: an early
 * failing output can leave a later `Export.Name` drain with no wait at all,
 * so a late record needs only a leg that had not finished recording by
 * then rather than one that outlived a full cap. (`inheritedSecrets` is the parent's, and no
 * resolution writes to it.)
 *
 * The strict arm's `cause` is masked as an OBJECT, through
 * `maskSecretsInError` — a clone of each `Error` link `errorCauseChain`
 * reaches (`ERROR_CAUSE_MASK_MAX_DEPTH` links, a cycle stops it; a
 * non-`Error` cause is kept verbatim), symbols included, so
 * `isMarkedNonRetryable`'s non-enumerable marker survives (the same reason
 * `provisionResource` uses it). No sink on the deploy path renders past
 * one level today (`formatError` prints `Caused by:` for a `CdkdError`'s
 * direct cause only), but that is a property of reachability, not of the
 * sinks: `cdkd scrub`'s `describeFailure` renders a chain, and is safe
 * because its boundary masks with this same helper and it walks the same
 * bounded `errorCauseChain`. Masking here gives a renderer within that
 * bound nothing to leak. A thrown STRING is masked as text; any other
 * non-`Error` value is not threaded as a cause at all (it would travel
 * unmasked, and `markNonRetryable` cannot have marked it).
 */
export function handleOutputResolutionFailure(
  this: DeployEngine,
  error: unknown,
  outputKey: string,
  outputs: Record<string, unknown>,
  secrets: RecordedSecretValues,
  inheritedSecrets: RecordedSecretValues
): void {
  // `error.message || error.name`, not `String(error)`: the latter prefixes
  // the class name, which usually said nothing the message did not, and
  // masking one text keeps the two arms reporting the same thing. The name
  // is kept as the fallback because it is the strictly-better half of the
  // prefix: `new Error()` has an empty message, and an AWS SDK error often
  // carries its code in the NAME over a generic message.
  // ONE pass over both bags (go-to-k/cdkd#4049): masked bag by bag, one
  // bag's shorter needle cut a longer needle the other held, and the rest
  // of it printed.
  const union = unionOfSecretBags([inheritedSecrets, secrets]);
  const detail = maskSecretsInText(
    error instanceof Error ? error.message || error.name : String(error),
    union
  );
  if (this.options.strictGetAtt) {
    // The cause is masked on THIS arm only: `maskSecretsInError` clones the
    // whole chain and reads each link's `stack` accessor (a V8 trace
    // materialization per link), and the warn arm below never uses it.
    const cause: unknown =
      typeof error === 'string'
        ? maskSecretsInText(error, union)
        : maskSecretsInError(error, union);
    // `cause` is load-bearing, not decoration (issue #1874 review). The
    // non-retryable marker is a NON-ENUMERABLE symbol on the original error,
    // so re-wrapping without a cause DROPS it — while inlining the refusal's
    // full text, which for a resolver refusal includes template-controlled
    // identifiers. A logical id like `MyDependencyViolationHandler` then puts
    // `DependencyViolation` (a whitespace-free entry in the substring
    // table — the only one until issue #2116 added the name-cooldown error
    // codes) into this message, and the classifier reads it as transient.
    // That is reachable: this throw leaves `executeDeployment`, leaves the
    // child `deploy()`, passes through `NestedStackProvider.create`, and
    // lands in the PARENT's `withRetry` — so a nested stack would re-run a
    // whole child deploy plus rollback per retry on a path that can never
    // succeed. `isMarkedNonRetryable` walks the `.cause` chain, and the
    // masked clone carries the marker (see the doc comment), so threading
    // the cause preserves it. A thrown value that is neither an `Error`
    // nor a string is NOT threaded: `maskSecretsInError` hands it back by
    // identity, unmasked, and `markNonRetryable` marks `Error` instances
    // only, so such a value carries no marker this code could have put on
    // it — threading it would buy nothing and could carry plaintext.
    throw new Error(
      `Failed to resolve output ${outputKey}: ${detail} ` +
        `(--strict-getatt promotes output resolution failures to deploy errors; ` +
        `drop the flag to skip the output instead)`,
      cause instanceof Error || typeof cause === 'string' ? { cause } : {}
    );
  }
  this.logger.warn(`Failed to resolve output ${outputKey}: ${detail}`);
  outputs[outputKey] = undefined;
}

/**
 * Resolve stack outputs from template and resource attributes.
 *
 * Uses `IntrinsicFunctionResolver` for full CloudFormation intrinsic function
 * support, and runs in TWO passes — every value, then every export alias —
 * so an alias decision sees the complete set of secrets this pass resolved
 * rather than whatever the declaration order happened to have recorded by
 * then (issue #1919).
 */
export async function resolveOutputs(
  this: DeployEngine,
  template: CloudFormationTemplate,
  resources: Record<string, ResourceState>,
  stackName: string,
  /**
   * The pre-resolution snapshot the skipped-outputs digests are taken from
   * (issue #2740) — `doDeploy` deep-copies it before parameter binding,
   * condition evaluation and every resolution, so that no resolution can be
   * visible to the digest however those steps are implemented (the
   * invariant, and why it does not rest on any one resolver's in-place
   * behaviour, is in `src/analyzer/skipped-outputs.ts`). Never `template`
   * itself: by the time this method runs that object is the one every step
   * above was free to rewrite.
   */
  digestSource: CloudFormationTemplate,
  parameterValues?: Record<string, unknown>,
  conditions?: Record<string, boolean>
): Promise<Record<string, unknown>> {
  // Reset BEFORE the early return: a template with no Outputs exports
  // nothing, and that is a known `[]`, not a stale set from a prior pass.
  // `skippedOutputs` is NOT reset here: `deploy()` clears it with the other
  // per-run bags, which covers this early return and every path that never
  // reaches this method. A second reset here would MASK that one — either
  // could then be deleted with no test going red — so there is exactly one.
  this.resolvedExportNames = [];
  if (!template.Outputs) {
    return {};
  }

  // `Object.create(null)`, not `{}` (the issue #1943 class, and the twin of
  // `resolveTemplateOutputs`' own bag): a template may declare an Output
  // named `__proto__`, and on a plain object the failure handler's
  // `outputs[outputKey] = undefined` would hit the prototype SETTER — the
  // key would be swallowed, so `collectSkippedOutputs` could never record
  // it while `canonicalJson` goes to real trouble for exactly that name.
  const outputs: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const context = this.buildResolverContext(
    {
      template,
      resources,
      ...(parameterValues && { parameters: parameterValues }),
      ...(conditions && { conditions }),
    },
    stackName
  );

  /**
   * Fail an output whose resolution served a value out of a MASKED state
   * record, instead of publishing what the fall-through produced (issue
   * [#2847](https://github.com/go-to-k/cdkd/issues/2847), independent
   * round-2 review — the BLOCKER).
   *
   * `refuseRedactedAttributeReads` is called at exactly TWO sites, both
   * per-resource CREATE / UPDATE. `resolveOutputs` builds its own context
   * and consulted nothing, so the note this pass records was written and
   * never read — and once `refStateLookupFromResource` learned to refuse a
   * masked leaf, "never read" stopped being harmless. A `{"Ref": <record
   * whose TableName / SelectionId / RepositoryId / AppSync ARN is masked>}`
   * in `Outputs` publishes the RAW PHYSICAL ID: for a Cloud-Control-routed
   * `AWS::S3Tables::Table`, a UUID-tailed ARN where the table NAME belongs.
   *
   * THE ASYMMETRY IS WHY THIS IS A REFUSAL RATHER THAN A WARNING. Before the
   * refusal existed this published `'***'`, which the CONSUMER stack rejects
   * — `reresolveCrossStackValue` tests `carriesSecretMask` and refuses. An
   * ARN passes that test, so the consumer resolves its `Fn::ImportValue` to
   * a wrong value and sends it to AWS, with both deploys green. Publishing
   * nothing is the only outcome that keeps the consumer's guard meaningful.
   *
   * PER-OUTPUT BY ITS OWN BAG, and a length DELTA over the shared one is
   * what this replaced (issue #2847 round-3 review, and the reason it is a
   * bag rather than a `slice`). All three pushers are IDEMPOTENT — each
   * guards with `if (!reads.includes(read))` — and `resolveOutputs` shares
   * ONE context across every output, unlike the CREATE / UPDATE arms which
   * build a fresh context per resource. So a second output reading the SAME
   * masked record produced an EMPTY delta and was PUBLISHED:
   *
   *     Outputs:
   *       TableRef:  { Value: { Ref: Tbl } }   # refused
   *       TableRef2: { Value: { Ref: Tbl } }   # published the raw ARN
   *
   * `resolveRef` memoizes nothing, so the second resolution really does
   * re-enter `noteRefStateMask` and really is refused a push. Giving each
   * output its own array and MERGING the entries back afterwards keeps both
   * properties: the guard sees exactly this output's reads, and the shared
   * bag still accumulates for anything reading it later.
   *
   * SCOPED TO THE `ref-state-key` KIND, and that is a narrowing rather than
   * an oversight. The refusal exists because of the FALL-THROUGH: when the
   * lookup skips a masked leaf, `cfnRefValueFromPhysicalId` emits the raw
   * physical id, which no downstream reader recognises. Every OTHER pusher —
   * `noteAttributeSecrecy`'s `Fn::GetAtt`, `reresolveCrossStackValue`'s
   * `Fn::ImportValue` / `Fn::GetStackOutput` / nested-stack forms — serves
   * the MASK itself as the value, which `reresolveCrossStackValue` and the
   * export blocker DO recognise. Firing there would silently change the
   * pre-existing issue #2274 behaviour (an output that published `'***'`
   * would vanish) for no safety gain, and would render this message's
   * "would publish a value cdkd cannot confirm" over a read for which
   * there is no physical-id fall-through — the wrong-advice class this PR
   * has spent three rounds removing.
   *
   * **SELECTED BY THE `kind` FIELD, NEVER BY A PATTERN OVER `display`**
   * (round-4 review, BLOCKER). The previous revision filtered with the same
   * regex `maskedRecordRemedyFor` used, whose id class was `[A-Za-z0-9]+` —
   * so for `{"Ref": "My-Table"}` (an `overrideLogicalId`, or a migrated
   * template; cdkd validates no logical-id charset and never hands the
   * template to CloudFormation) the filter matched NOTHING, this function
   * returned, and the output published the raw physical id. That is an
   * earlier round's blocker reopened through a CHARSET. Falling out of the
   * pattern is the SAFE direction at the remedy — a vaguer message — and the
   * INVERTED one here, where it is the refusal itself; one rendering cannot
   * serve two consumers whose safe directions are opposite, so the structure
   * moved into the entry and both consumers now ask a field.
   *
   * It routes through {@link handleOutputResolutionFailure} rather than
   * throwing its own way out, so it inherits that method's whole contract:
   * warn-and-skip by default, promoted to a deploy error under
   * `--strict-getatt`, and masked against both secret bags on the way.
   */
  const refuseMaskedOutputReads = (
    outputKey: string,
    ownReads: readonly RedactedAttributeRead[]
  ): void => {
    const added = ownReads.filter((read) => read.kind === 'ref-state-key');
    if (added.length === 0) return;
    // `markNonRetryable` for the same reason the sibling refusals carry it:
    // under `--strict-getatt` this leaves the engine as a thrown error, and
    // on a nested-stack child it lands in the PARENT's `withRetry`, whose
    // classifier matches substrings of template-controlled identifiers. No
    // retry can clear a mask in state.
    throw markNonRetryable(
      new Error(
        `Cannot resolve ${added.map((read) => read.display).join(', ')} for output ${outputKey}: cdkd's recorded state ` +
          `holds only the redaction mask there, so this output would publish a value cdkd ` +
          `cannot confirm (for most such types the resource's raw physical id) instead of the ` +
          `value CloudFormation's Ref returns — a possibly wrong value ` +
          `that a consuming stack's Fn::ImportValue would accept and send to AWS. The output ` +
          `is not published. ${DeployEngine.maskedRecordRemedyFor(added, context.resources)}`
      )
    );
  };

  // NO PASS-WIDE BAG, and no merge back into one (issue #2847 round-4
  // review, found independently by two reviewers). A previous revision kept
  // `context.redactedAttributeReads` alongside the per-output bags and folded
  // each output's reads back into it from a `finally`. Nothing read it:
  // `context` is a local of this method, its only later uses are `.resources`
  // and `.recordedSecretValues`, and the one consumer of the shared bag —
  // `refuseRedactedAttributeReads` — runs on the per-RESOURCE contexts the
  // provisioning arms build. Making the merge a no-op was measured GREEN
  // across the suite, and its docstring named a reader that does not exist.
  // Both resolutions below supply their own bag by spread, so the guard is
  // unaffected; what is gone is an accumulator with no consumer.

  // The two bags the failure sites below mask against (issue #2728).
  // `buildResolverContext` always sets `recordedSecretValues`, so that `??`
  // is for the TYPE (which leaves it optional) and is never taken; the
  // inherited bag is set on a nested-stack child engine only, so that one
  // IS taken on every top-level stack.
  const outputsPassSecrets = context.recordedSecretValues ?? EMPTY_SECRETS;
  const outputsPassInherited = context.inheritedSecrets ?? EMPTY_SECRETS;
  // Kept for every later redaction of the outputs bag (issue #2814); see
  // `absorbOutputsPassSecrets`, which only reads it. The GUARD rather than
  // `outputsPassSecrets`: that `??` fallback is `EMPTY_SECRETS`, a
  // process-wide singleton, and a per-deploy needle list is no place for a
  // cross-deploy object — inert today (nothing writes it), wrong the moment
  // anything does.
  if (context.recordedSecretValues) {
    this.outputsPassSecretMaps.push(context.recordedSecretValues);
  }

  // The names this deploy PUBLISHES. Owns keys in both this bag and the
  // position-source bag below, and is the set an export alias must not land
  // on (issue #1919).
  const publishedOutputNames = collectPublishedOutputNames(template.Outputs, conditions);

  let outputsPassCompleted = false;
  try {
    // TWO passes, and the split is the fix for an ORDER dependence rather
    // than tidiness (issue #1919 round-6 review). The alias decision consults
    // the secrets this pass has recorded so far; deciding inside the value
    // loop meant an output declared BEFORE the secret-bearing one was judged
    // against an empty map, so the SAME template published a plaintext state
    // KEY or refused it depending on declaration order — the very
    // order-dependence class this issue's addendum flagged for the original
    // defect. Values first, aliases second: every alias then sees the
    // complete map, and the split costs no extra AWS calls because the loop
    // already resolved every value.

    // PASS 1 — values.
    for (const [outputKey, output] of Object.entries(template.Outputs)) {
      // CFn semantics: an output whose `Condition` evaluates false is simply
      // not created — skip it silently instead of attempting resolution
      // (which would warn on a Ref to a condition-pruned resource and could
      // even publish an output/export CFn would omit). Mirrors the resource
      // side's `filterResourcesByCondition` (issue #1028; unknown condition
      // names are kept, matching that helper's semantics).
      if (isOutputSuppressedByCondition(output, conditions)) {
        this.logger.debug(`Skipping output ${outputKey} — condition ${output.Condition} is false`);
        continue;
      }
      // THIS OUTPUT'S OWN BAG, and the isolation is what makes the guard
      // fire at all: every pusher de-dupes, so with one bag shared across the
      // pass a SECOND output reading the same masked record would see nothing
      // added and be published. See `refuseMaskedOutputReads`.
      const ownReads: RedactedAttributeRead[] = [];
      try {
        const resolved = await this.resolver.resolve(output.Value, {
          ...context,
          redactedAttributeReads: ownReads,
        });
        refuseMaskedOutputReads(outputKey, ownReads);
        // A resolution that RETURNS `undefined` is as unresolved as one that
        // throws, so under `--strict-getatt` it takes the same failure arm
        // (issue #3168). No `Fn::GetAtt` arm answers `undefined` any more —
        // each refuses instead (issue #4077) — so this is the backstop for a
        // malformed value such as a two-argument `Fn::If`. Marked
        // non-retryable: the error carries no AWS text, only the
        // template-controlled output key, which a substring classifier
        // can misread as transient — a key containing `AlreadyExists` in a
        // nested child being replaced would re-run the whole child deploy
        // (the #1874 hazard). `handleOutputResolutionFailure` threads this
        // as the `cause`, so the marker survives its re-wrap.
        if (resolved === undefined && this.options.strictGetAtt) {
          throw markNonRetryable(new Error('the value resolved to nothing'));
        }
        outputs[outputKey] = resolved;
      } catch (error) {
        this.handleOutputResolutionFailure(
          error,
          outputKey,
          outputs,
          outputsPassSecrets,
          outputsPassInherited
        );
      }
    }

    // PASS 2 — export aliases, decided against the COMPLETE secrets map.
    for (const [outputKey, output] of Object.entries(template.Outputs)) {
      if (isOutputSuppressedByCondition(output, conditions)) continue;
      if (!output.Export?.Name) continue;
      const value = outputs[outputKey];
      // An output whose value did not resolve publishes nothing, so it
      // publishes no alias either — matching the single-pass shape, where the
      // failure jumped past the alias block.
      if (value === undefined) continue;

      // Resolved with its OWN `recordedSecretValues` map, not the pass's:
      // `Fn::Sub` / `Fn::Join` substitute dynamic references, so the map
      // tells us EXACTLY whether a secret went into THIS name — no length
      // threshold, and no coincidental match against a sibling's secret.
      //
      // The isolation is for the DECISION only, and the RECORDING side
      // effect is written through to the pass map — do not re-isolate it.
      // Every plaintext
      // this resolution records must stay a needle of the PASS map: for the
      // exposure refusal masked right below, and for every later consumer
      // that never resolves the reference itself (a value re-using the
      // same token records its own entry; one that does not, does not). An
      // earlier version of this comment grounded the merge on the cache-hit
      // arm re-recording "only what it can still prove is secret" for an
      // unpinned `ssm` reference (issue #1901); since issue #1933 the cache
      // carries the verdict beside the value, so a hit re-records a cached
      // secret, and an unclassifiable-`Type` reference is never cached at
      // all (`cacheable = false`) — it re-asks AWS and records again.
      //
      // WRITTEN THROUGH, not copied back (issue #2814). Since issue #2563
      // the resolver DRAINS every part it started before a rejection
      // reaches a caller (`allSettledKeepingFirstRejection`), but the drain
      // is BOUNDED so a hung part cannot hold a deploy's state save, and
      // its budget is shared across this whole outputs pass -- so a part
      // can record after this block has ended, and that does not take a
      // part that outlived a full cap: an earlier failing output can leave
      // this drain with no wait at all. This map used to be a per-iteration
      // local copied into the pass map in a `finally`, so such a record was
      // DROPPED. A `ForwardingSecrets` keeps its own entries (the exact set
      // `exportNameSecretExposure` reads) and writes each through to the
      // pass map when the resolver records it, late or not -- including a
      // plaintext recorded just before this resolution throws, which the
      // failure's own message below masks against. `cdkd scrub`'s sibling
      // loop resolves the name through a VIEW of its pass map instead
      // (issue #2531); a view holds no entries of its own, which is why it
      // does not fit here.
      const nameSecrets: RecordedSecretValues = new ForwardingSecrets(context.recordedSecretValues);
      // The LOG-ONLY needles (go-to-k/cdkd#1998) are keyed by the map
      // INSTANCE and do not write through with the entries, so the name map
      // SHARES the pass map's set: a record at any time, a late one or one on
      // a throwing path included, is visible to every print of this pass.
      if (context.recordedSecretValues) {
        shareLogOnlyValues(nameSecrets, context.recordedSecretValues);
      }
      // The alias NAME can carry the same masked `Ref` the value can — an
      // `Fn::Sub` over one is ordinary. Guarded for the same reason as the
      // value: an export whose NAME is built from a raw physical id binds
      // consumers to a name that is not the one the template describes.
      //
      // ITS OWN BAG, exactly like pass 1 and for exactly the same reason: the
      // pushers dedup, so a name sharing a bag with any earlier output's
      // reads could see nothing added and be published.
      const nameReads: RedactedAttributeRead[] = [];
      let exportName: unknown;
      try {
        exportName =
          typeof output.Export.Name === 'string'
            ? output.Export.Name
            : await this.resolver.resolve(output.Export.Name, {
                ...context,
                recordedSecretValues: nameSecrets,
                redactedAttributeReads: nameReads,
              });
        refuseMaskedOutputReads(outputKey, nameReads);
      } catch (error) {
        // The pass map, which already holds every entry the failed name
        // resolution recorded (`nameSecrets` writes through) — the needle
        // for a plaintext that resolution itself recorded; its LOG-ONLY
        // needles are shared with it (above).
        this.handleOutputResolutionFailure(
          error,
          outputKey,
          outputs,
          outputsPassSecrets,
          outputsPassInherited
        );
        continue;
      }
      if (typeof exportName !== 'string') continue;

      // TWO refusals guard this alias, and both are about the same thing:
      // this bag's KEYS (issue #1919).
      //
      // 1. SECRET-BEARING NAME. `Export.Name` may be an intrinsic, and
      //    `Fn::Sub` / `Fn::Join` substitute dynamic references — so the
      //    resolved name can contain secret PLAINTEXT. It would become a
      //    key in `state.json` and in the exports index, and every
      //    redaction pass walks VALUES only, so nothing downstream would
      //    ever scrub it. Refuse rather than publish. Detected from the
      //    name's OWN resolution map (above), so the answer is exact
      //    rather than a containment guess; the warning masks every
      //    occurrence and omits the name outright if it cannot, since
      //    stderr is a reader too.
      //
      // 2. COLLISION with a published output NAME. Two writers key this
      //    one bag: this alias, and the post-loop pass below that writes
      //    the redaction POSITION source for every published output NAME.
      //    On a collision they disagree — the alias puts THIS output's
      //    resolved value under key `A` while the post-loop pass puts
      //    output `A`'s UNRESOLVED value there — and `redactByPath`'s
      //    expression arm then returns the source leaf verbatim,
      //    persisting A's `{{resolve:...}}` expression as THIS output's
      //    value into state and the exports index. That is the
      //    wrong-reference class issue #1910 exists to remove, one layer
      //    up. It WAS order-dependent — the corruption needed the exporting
      //    output iterated AFTER the colliding-name output, or the latter's
      //    own write reclaimed the key and only the alias was lost — and the
      //    value/alias pass split has made it UNCONDITIONAL: every alias now
      //    runs after every value write, so without this guard the alias
      //    always wins the key while the post-loop pass always writes the
      //    owner's source. The test file still pins both declaration orders,
      //    which now assert the same thing rather than two different ones.
      //
      //    Of the issue's two directions this takes SKIP-AND-WARN rather
      //    than re-keying the source pass by the alias rule. Matching the
      //    source pass to the alias's write order would keep the two bags
      //    consistent, but it would leave `outputs[A]` holding a DIFFERENT
      //    output's value — order-dependently — which is corruption of the
      //    output named `A` even once its expression is right. Skipping
      //    instead partitions the key space by construction: published
      //    output NAMES belong to the post-loop pass, export aliases to
      //    this one, and no key is in both.
      //
      //    This IS a behavior change with a consumer-visible edge, stated
      //    plainly because the warning fires on the PRODUCER's deploy
      //    while the effect lands on the CONSUMER's: where the alias
      //    previously won the key, an `Fn::ImportValue` on that name now
      //    resolves to the colliding output's value instead. CFn would
      //    publish both (its export namespace is separate from its output
      //    names), so this is a deliberate parity divergence — cdkd's
      //    exports index is derived from the outputs bag and cannot hold
      //    two values under one key. Fail-closed and warned beats a
      //    silently wrong reference.
      //
      // The collision set is the PUBLISHED names, not the declared ones.
      // A condition-suppressed output writes neither a value nor a source
      // (see the post-loop pass), so its name is free — reserving it would
      // drop a working export because an unrelated condition went false.
      const exposure = exportNameSecretExposure(
        exportName,
        nameSecrets,
        context.recordedSecretValues
      );
      if (exposure) {
        // `exposure` stays the authoritative force-mask set; the recorded
        // map is the containment corpus the printed text is tested against
        // (issue #2874) — the warning used to decide from `exportName` and
        // print a sanitised form of it.
        this.logger.warn(
          secretBearingExportNameWarning(
            outputKey,
            exportName,
            exposure,
            context.recordedSecretValues
          )
        );
      } else if (isExportAliasCollision(exportName, outputKey, publishedOutputNames)) {
        // The corpus is threaded so this message tests the name itself
        // rather than trusting the refusal above -- this arm is reached
        // exactly when that refusal did NOT fire (issue #2874).
        // `outputsPassSecrets` rather than a third spelling of the same
        // fallback: this method already computed it, and the note at its
        // declaration records that its `??` is never taken.
        this.logger.warn(exportAliasCollisionWarning(outputKey, exportName, outputsPassSecrets));
      } else {
        outputs[exportName] = value;
        // A SET: two outputs declaring one Export.Name (which CloudFormation
        // rejects) alias the same key twice, and the second write wins the
        // value; the name must not be persisted twice.
        if (!this.resolvedExportNames.includes(exportName)) {
          this.resolvedExportNames.push(exportName);
        }
        // The alias is a SECOND key holding the same value, so it needs the
        // same POSITION source or it falls to the value scan and collapses
        // onto a sibling's expression (issue #1910 review). This bag feeds
        // `updateForStack`, so a collapsed alias hands a downstream
        // `Fn::ImportValue` consumer the WRONG reference.
        this.outputsTemplateSource[exportName] = output.Value;
      }
    }
    outputsPassCompleted = true;
  } finally {
    // No copy of this pass's secrets into `outputSecrets` here any more
    // (issue #2814): `redactOutputs` folds the pass map in every time it
    // runs (`absorbOutputsPassSecrets`), because a part the drain cap
    // stopped waiting for can record after this pass has ended. That covers
    // the `--strict-getatt` throw path as well, which DOES reach
    // `redactOutputs` — through `persistStateAfterOutputFailure` ->
    // `withParentInfo` -> `redactStateForPersist`, redacting
    // `currentState.outputs`, the PREVIOUS deploy's bag — and the map was
    // registered before the loop began, so whatever it recorded before the
    // throw is folded in there.
    //
    // The POSITION source must GO on that path, because it reaches the
    // redaction. The post-loop pass below never ran, so this bag holds only the alias
    // keys written before the throw: a PARTIAL source, built from THIS
    // template, about to position the PREVIOUS deploy's bag. That is the
    // bag/source provenance mismatch `secret-redaction` calls unsound —
    // `redactByPath` returns a known-secret source leaf VERBATIM, so a
    // coinciding key persists an expression that need not name the value it
    // replaced. Dropping it degrades those keys to the value scan, which reads
    // what is actually stored. Same call the scrub twin makes through
    // `outputsSourceUntrusted`, for the same reason.
    if (!outputsPassCompleted) this.outputsSourceUsable = false;
  }
  // ...and the UNRESOLVED values beside them, as the POSITION source (#1910).
  // Keyed by output NAME so the walk lines up with the resolved `outputs` bag
  // this method returns.
  //
  // PUBLISHED names only. A condition-suppressed output contributed no value
  // above, so a source under its name can never position anything — it can
  // only CLOBBER an export alias that legitimately took the free name, which
  // is the #1919 corruption arriving from the other side. Restricting the
  // pass is what lets the alias guard key on the published set and keep such
  // an export working.
  //
  // An earlier revision of this comment claimed the writes had to accumulate
  // because `resolveOutputs` runs more than once per deploy. That is wrong,
  // and it was load-bearing for the wrong decision, so it is corrected rather
  // than deleted: there are exactly two call sites (the no-change branch and
  // the post-provisioning one) and they are MUTUALLY EXCLUSIVE — the
  // no-change branch returns before `executeDeployment` — while `deploy()`
  // resets this bag. So at most one call runs per deploy, and skipping a
  // suppressed output here cannot drop a source some other pass wrote.
  // `tests/unit/deployment/deploy-engine-outputs-export-name-collision.test.ts`
  // pins that single-call property, since this decision now rests on it.
  for (const [outputKey, output] of Object.entries(template.Outputs)) {
    if (!publishedOutputNames.has(outputKey)) continue;
    this.outputsTemplateSource[outputKey] = output.Value;
  }

  // What this pass skipped, for the saves that persist this bag (issue
  // #2740). Computed here rather than in the failure handler so the record
  // is derived from the same bag the saves write: a key is skipped exactly
  // when its value is `undefined`, on either pass.
  this.skippedOutputs = collectSkippedOutputs(digestSource, outputs);

  // Issue #2516: this bag is THIS pass's own resolution of today's
  // `Outputs`, so it is marked same-generation for `redactOutputs` — a
  // literal `CfnOutput` embedding a token whose value is 1-3 characters is
  // the same leaf shape as a resource property and takes the same arm.
  // Marked here, at the one producer, rather than at the two callers. The
  // THROWING failure path (`--strict-getatt`) never reaches this line and
  // walks `currentState.outputs`, the previous deploy's bag, which stays
  // unmarked. A per-output failure caught inside the loop above DOES reach
  // it: the partial bag it marks is still this pass's own resolution, and
  // the no-change caller then either copies its redacted values into a
  // fresh, unmarked merge (issue #2771) or keeps `persistedOutputs` — the
  // previous deploy's bag, unmarked — so nothing this pass did not produce
  // ever carries the mark. `cdkd scrub`'s outputs walk never calls this
  // method at all.
  return markSameGenerationBag(outputs);
}

export function buildDisplayOutputs(
  this: DeployEngine,
  template: CloudFormationTemplate,
  resolvedOutputs: Record<string, unknown>
): Record<string, unknown> {
  const display: Record<string, unknown> = {};
  if (!template.Outputs) return display;
  for (const key of Object.keys(template.Outputs)) {
    const v = resolvedOutputs[key];
    if (v !== undefined) display[key] = v;
  }
  return display;
}
