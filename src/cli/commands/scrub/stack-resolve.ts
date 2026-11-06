import { nullPrototypeRecord } from '../../../utils/own-keys.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { withSharedDrainBudget } from '../../../deployment/drain-budget.js';
import type { AbandonedResolution } from '../../../deployment/intrinsic-function-resolver.js';
import {
  shareLogOnlyValues,
  maskSecretsInText,
  recordNestedStackParameterExpressions,
  readsNoEchoSource,
  type RecordedSecretValues,
} from '../../../deployment/secret-redaction.js';
import {
  recordedOutputReferenceRegions,
  recordedReferenceRegions,
} from '../../../deployment/reference-provenance-record.js';
import { isUnresolvedValue, templateUsesSub } from '../../../analyzer/outputs-diff.js';
import {
  carriedExportAliasExposure,
  isExportAliasCollision,
} from '../../../deployment/outputs-export-alias.js';
import { isReadableBag } from '../../../state/malformed-resources-bag.js';
import { NESTED_STACK_TYPE } from './nested.js';
import { knownExportNamesOf } from './outputs.js';
import { pinCrossRegionSecrets } from './cross-region.js';
import { isOutputSuppressed, RESOLVER_DISPATCH_KEYS } from './cross-stack-refusals.js';
import {
  isRegionAmbiguousRefusal,
  isNamelessDynamicReferenceFailure,
  maskedIdent,
  crossStackReadOrigin,
  abandonedScanWarning,
  abandonedScanStackNote,
  abandonedScanVerdict,
  foldAbandonedUnitVerdict,
} from './abandoned-scan.js';
import { SharedEntriesSecrets } from './shared-entries-secrets.js';
import type { ScrubStackResolveInput, ScrubStackResolveOutput } from './stack.js';

/**
 * {@link scrubStack}'s resolve pass, moved verbatim (go-to-k/cdkd#5835): every
 * resource's properties, every rollback-orphan record and every template
 * Output re-resolved under ONE shared drain budget, filling the needle maps it
 * is handed. Called inside `scrubStack`'s `try`, so that function's `catch`
 * and `finally` still apply. The abandoned-scan counters live here because
 * only this pass increments them.
 */
export async function scrubStackResolvePass({
  stack,
  region,
  logger,
  newBag,
  perResourceSecrets,
  outputSecrets,
  orphanSecrets,
  state,
  perResourceTemplateProps,
  outputsTemplateSource,
  resolvers,
  resolver,
  producerRegions,
  conditions,
  resolverContext,
  resolveCrossStackReads,
  templateResources,
  templateOutputs,
  declaredOutputNames,
  accountedOutputKeys,
  ambiguousKeys,
  collisions,
  noEchoNameParameters,
  declaredAliasOf,
  noEchoNameSeed,
}: ScrubStackResolveInput): Promise<ScrubStackResolveOutput> {
  /**
   * Leaves whose dynamic-reference scan was ABANDONED mid-token (issue
   * go-to-k/cdkd#3160). A counted finding, not a refusal — see
   * `abandonedScanVerdict` for why these cannot refuse.
   */
  let unverifiableLeaves = 0;
  // Not a result field: the `warn` arm gates nothing, so nothing outside this
  // function reads it. It exists so the per-stack note below can say how many
  // records it is explaining.
  let ungateableAbandonedScans = 0;

  /**
   * Report ONE bag of abandoned units: fold to the most severe verdict, count
   * it, warn once, then debug one line per entry.
   *
   * ONE helper shared by all THREE opted-in passes (resource properties,
   * orphan records, output values). They began as three hand-inlined copies of
   * the same eight lines, which is the shape that drifts: a round-3 review
   * measured that removing BOTH the orphan and output opt-ins reddened zero of
   * 4,180 tests, so nothing would have caught two of the three copies diverging
   * either. The passes differ only in the subject string and which needle map
   * their lines mask through, so both are parameters.
   *
   * Renders `entry.message`, never `entry.error`: the interface documents
   * `error` as classification-only, and `message` carries a twin-derived
   * redaction the needle mask alone cannot reproduce for a sub-floor plaintext.
   */
  const reportAbandonedBag = (
    entries: readonly AbandonedResolution[],
    subject: string,
    /** The needle map this pass populated — `outputSecrets` for the Outputs pass. */
    secrets: RecordedSecretValues,
    /** How the per-entry debug line names what was being resolved. */
    debugSubject: string
  ): void => {
    if (entries.length === 0) return;
    const worst = foldAbandonedUnitVerdict(entries);
    if (worst !== 'silent') {
      if (worst === 'count') unverifiableLeaves++;
      else ungateableAbandonedScans++;
      logger.warn(maskSecretsInText(abandonedScanWarning(subject, worst), secrets));
    }
    for (const entry of entries) {
      logger.debug(
        maskSecretsInText(
          `Resolution of ${debugSubject} during scrub was partial: ${entry.message} ` +
            `(abandoned one ${entry.unit})`,
          secrets
        )
      );
    }
  };
  /**
   * ONE note per stack per arm. The per-record lines are deliberately short
   * (see `abandonedScanWarning`), so this is where the explanation lives, and
   * emitting it after the loops rather than at the first occurrence is what
   * lets it say HOW MANY records it is explaining.
   *
   * A CLOSURE called at BOTH returns, not a block at the late one. The early
   * `totalSecrets === 0` return is the DOMINANT path for an abandoned scan --
   * an abandoned scan records no needle, which is the whole defect -- so a
   * single late emission left the note unreachable for exactly the case it
   * exists to explain. `emitted` because the two call sites are exclusive
   * today and a third would not be.
   */
  let notesEmitted = false;
  const emitAbandonedScanNotes = (): void => {
    if (notesEmitted) return;
    notesEmitted = true;
    if (unverifiableLeaves > 0) logger.warn(abandonedScanStackNote('count', unverifiableLeaves));
    if (ungateableAbandonedScans > 0) {
      logger.warn(abandonedScanStackNote('warn', ungateableAbandonedScans));
    }
  };
  let outputsSourceUntrusted = false;
  // Whether every `Export.Name` today's template declares resolved to a key
  // the record HOLDS (go-to-k/cdkd#4120) — the proof that every live export
  // alias is accounted, which `planUnnamedOutputDrop` needs before it drops
  // an unaccounted key that may be an alias.
  let everyExportAliasReproduced = true;
  // Declared above the wrap because the block below it reads some of them.

  // ONE drain budget for the resolve LOOPS between here and the
  // `saveState` below (issue #2563): the resources loop, both output
  // loops, and `resolveCrossStackReads`, itself a per-leaf resolve loop
  // that all three invoke. Each `resolver.resolve` in them can WAIT on a
  // rejection and unwrapped would open its own budget, so the aggregate
  // drain WAIT would be at most
  // `(#top-level-properties + 2 x #outputs) x (1 + #cross-stack-leaves) x` the cap.
  // An UPPER bound: an iteration that resolves nothing -- a resource with
  // no `Properties`, an absent or literal export name -- costs nothing.
  // And it bounds that WAIT, not the pass, which ordinary resolution time
  // extends without any limit from here. CloudFormation allows 500
  // resources against 200 outputs.
  //
  // NOT the condition evaluation above it, which keeps a budget per
  // condition: a failed condition is downgraded and evaluation continues,
  // so one condition's slow parts must not spend the next one's, and that
  // reasoning does not change under a lock.
  /**
   * Each nested-stack row's RESOLVED `Parameters`, and whether the resolution
   * was complete (go-to-k/cdkd#2252) — what the row's child is scrubbed with.
   * A unit the resolver abandoned is left in place as its unresolved input,
   * so an incomplete value is never handed to a child: see
   * `nestedChildRefusal`.
   */
  const nestedRowParameters = new Map<string, { value: unknown; complete: boolean }>();
  await withSharedDrainBudget(async () => {
    for (const logicalId of Object.keys(state.resources ?? {})) {
      const templateResource = templateResources[logicalId];
      if (!templateResource?.Properties) continue;
      const recordedSecretValues = newBag();
      // REGISTERED BEFORE the pin and the pre-pass, not after them (issue #2133
      // review). The map is filled IN PLACE, so registering it early changes
      // nothing about what the loop below reads — but `maskSecretsInError` at
      // the bottom of this function masks against
      // `allRecordedSecrets(outputSecrets, perResourceSecrets, orphanSecrets)`, and both
      // `pinCrossRegionSecrets` and the cross-stack pre-pass can THROW after
      // recording a foreign plaintext into this map. Registering afterwards
      // left exactly that window unmasked: the escaping error, and every link
      // of its cause chain that `formatError` / `util.inspect` walks, could
      // carry a plaintext the boundary had no needle for.
      //
      // Unconditional, where the old registration was gated on
      // `size > 0`. An empty map is what every reader already substitutes for a
      // missing entry (`secrets ?? new Map()`), and `allRecordedSecrets`
      // filters by needle length, so an empty entry contributes nothing.
      perResourceSecrets.set(logicalId, recordedSecretValues);
      // Issue #2109: resolve any FOREIGN-region reference in its own region
      // first, and REFUSE one whose region cannot be established. Deliberately
      // OUTSIDE the best-effort catch below — a refusal that a `logger.debug`
      // swallowed would leave the command reporting success over a state file
      // it never scrubbed, which is the one outcome the issue says must not
      // survive.
      const resolveInput = await pinCrossRegionSecrets(
        templateResource.Properties,
        stack.stackName,
        {
          stackRegion: region,
          producerRegions,
          resolvers,
          recordedSecretValues,
          origin: `resource ${maskedIdent(logicalId, recordedSecretValues)}`,
          recordedRegions: recordedReferenceRegions(state.resources?.[logicalId]),
        }
      );
      const resourceContext = resolverContext(recordedSecretValues);
      // Issue #2133, and OUTSIDE the best-effort catch below for the same reason
      // the pin above is: a cross-stack read that failed silently would leave
      // scrub with no needle for whatever that reference carries, and the
      // command would report success over a state file it could not examine.
      // REFUSAL ARMED here, unlike the two OUTPUT sites below, and the
      // asymmetry is the point: this loop iterates `state.resources`, so the
      // record EXISTS — the deploy created it and may have persisted the
      // imported plaintext into it. A suppressed OUTPUT was never written at
      // all, so a read it needs is one the deploy never made.
      await resolveCrossStackReads(
        resolveInput,
        resourceContext,
        crossStackReadOrigin('resource', 'logical id', logicalId, recordedSecretValues)
      );
      // PER TOP-LEVEL PROPERTY, not per bag (issue go-to-k/cdkd#3196).
      // `resolver.resolve` walks whatever it is handed and ONE throw aborts
      // the rest of it, so handing it the whole `Properties` bag meant an
      // unresolvable `Ref` in property A abandoned the `{{resolve:...}}` in
      // property B — B recorded no needle, its legacy plaintext was never
      // rewritten, and the stack could still print `No plaintext secrets
      // found` at exit 0. Reachable by accident (every `{Ref: <param>}` to a
      // `Default`-less parameter throws, since scrub takes no `--parameters`)
      // and, on a repo whose CI runs `--dry-run --fail`, defeatable on purpose by
      // putting one dangling `Ref` ahead of the secret.
      //
      // BOUNDED TO THE TOP LEVEL, and the residual is real: `resolveValue`'s
      // own object walk is a sequential `for await` over `Object.entries`
      // with no per-key `try`, so inside ONE property's value a failing key
      // still abandons the keys after it — `Environment.Variables.A` taking
      // out `Environment.Variables.B` is the same defeat recipe one level
      // down, and the dominant secret-bearing Lambda shape. Arrays are safe
      // (`allSettledKeepingFirstRejection` settles every element first);
      // objects are not. go-to-k/cdkd#3218 tracks it, and it belongs in the
      // resolver rather than here.
      //
      // Scoping the resolve costs nothing this loop needs. The context is
      // per-RESOURCE, not per-bag, so every property still accumulates into
      // the SAME `recordedSecretValues`; `pinCrossRegionSecrets` already
      // walked per-leaf and returned a bag of the same shape, so the pin is
      // undisturbed; and a CloudFormation intrinsic references other
      // RESOURCES, never a sibling property, so there is no cross-property
      // context to lose.
      //
      // `resolveCrossStackReads` above stays whole-bag: its refusals are
      // per-stack and arming them per property would change which of them
      // wins, not whether one fires.
      // A plain object is the ONLY shape with top-level properties to scope
      // by. Anything else (an array, a bare value, `null`) is resolved whole,
      // under the empty property name, so the scoping can never DROP a unit.
      //
      // ...and an INTRINSIC-SHAPED bag is resolved whole too, which is not a
      // tidiness case but a correctness one. `Properties: { 'Fn::If': [...] }`
      // is legal CloudFormation — `CfnInclude` and a raw `addOverride` both
      // produce it — and `resolveValue` dispatches on `'Fn::If' in obj` by
      // PRESENCE, not as a sole key (`property-coverage.ts` records the same
      // fact for the same reason). Splitting such a bag hands the resolver the
      // raw `[cond, then, else]` ARRAY, which resolves BOTH branches instead
      // of the taken one: a `{{resolve:...}}` in the untaken branch would be
      // fetched and recorded as a needle, so the rewrite could put a leaf onto
      // an expression the stack never deployed (the #1917 wrong-generation
      // class), and an unfetchable reference there would red `--dry-run
      // --fail` on a healthy stack — the unclearable gate go-to-k/cdkd#3160
      // exists to refuse. `resolveCrossStackReads` above still walks `Fn::If`
      // selected-branch-only, so splitting would also make the two passes
      // over one resource disagree about which branch is live.
      const bagKeys =
        resolveInput !== null && typeof resolveInput === 'object' && !Array.isArray(resolveInput)
          ? Object.keys(resolveInput as Record<string, unknown>)
          : undefined;
      // The HANDLED dispatch names only, never a bare `Fn::` prefix. An
      // earlier cut used the prefix on the argument that over-matching just
      // falls back to the whole-bag walk, i.e. pre-PR behaviour — but pre-PR
      // behaviour IS the bug this PR fixes, so over-matching re-opens it with
      // the key renamed. `resolveValue` dispatches only on the names below,
      // and `detectUnknownIntrinsicKey` is SOLE-KEY-guarded, so a bag like
      // `{ 'Fn::Meta': { Ref: 'Env' }, Password: '{{resolve:...}}' }` is
      // dispatched by nothing: it falls into the un-tried object walk, the
      // `Ref` throws, and `Password` is never fetched. Routing that whole
      // would restore exactly the defeat recipe go-to-k/cdkd#3196 closes.
      //
      // A SOLE unhandled `Fn::X` key splits into one unit carrying the key's
      // VALUE, not the node — so `Properties: { 'Fn::ToJsonString': ... }` no
      // longer reaches `buildUnknownIntrinsicError` here; scrub walks the
      // argument instead. The direction is safe (more references fetched, no
      // new silence) and the shape is invalid CloudFormation anyway, but it
      // is a real delta rather than the no-op an earlier revision of this
      // comment claimed.
      //
      // One rescue is LOST with the narrowing, and it was incidental rather
      // than designed: asking the verdict about the BAG meant a bag-mate's
      // literal `{{resolve:` could earn a warning for a property whose own
      // reference is ASSEMBLED (its opening contributed by `Ref` / `Fn::Join`,
      // which `carriesDynamicReference` cannot see). That class is already
      // recorded below as the original bug surviving in a narrower
      // population; this removes an accidental sibling rescue for it, and the
      // net is still strictly less surviving plaintext.
      //
      // BOUND, stated because it is easy to over-read this as "no untaken
      // branch is ever fetched": it holds for the RESOLVE passes. The pin
      // above (`pinCrossRegionSecrets`) walks both `Fn::If` branches, so a
      // foreign-region token in an untaken branch is still fetched and
      // recorded there. Pre-existing and not introduced here.
      const intrinsicShapedBag = bagKeys?.some((k) => RESOLVER_DISPATCH_KEYS.has(k)) ?? false;
      const resolveUnits: Array<readonly [string, unknown]> =
        bagKeys && !intrinsicShapedBag
          ? Object.entries(resolveInput as Record<string, unknown>)
          : [['', resolveInput]];
      // A nested-stack row's `Parameters` are captured from the unit that
      // resolves them (go-to-k/cdkd#2252). A bag resolved WHOLE (the `''`
      // unit) is not taken apart for them: that shape is an intrinsic-shaped
      // `Properties`, which no `cdk.NestedStack` synthesizes, and the child
      // is refused rather than handed a guess.
      const isNestedRow = templateResource.Type === NESTED_STACK_TYPE;
      // The row's resolved properties, whole, for the recorder below — which
      // the deploy engine hands the full resolved bag, not only `Parameters`.
      const resolvedRowProps: Record<string, unknown> = nullPrototypeRecord();
      if (isNestedRow) {
        // FAIL-CLOSED default (review of go-to-k/cdkd#3958): complete only
        // when there is no `Parameters` unit at all, so any path that skips
        // both writes below refuses the child instead of handing it `{}`.
        nestedRowParameters.set(logicalId, {
          value: undefined,
          complete: resolveUnits.every(([name]) => name !== '' && name !== 'Parameters'),
        });
      }

      for (const [propertyName, propertyValue] of resolveUnits) {
        // OPT IN to per-unit recovery (issues go-to-k/cdkd#3181 /
        // go-to-k/cdkd#3218). This is the consumer that makes the recovery
        // reach a user: scrub's whole job is to learn every needle the
        // template can produce, and before this a single unfetchable
        // reference — or a single unresolvable KEY beside one — abandoned
        // every later reference in the same property and recorded no needle
        // for it, so its plaintext survived the scrub that reported success.
        //
        // Safe HERE specifically because scrub DISCARDS the resolved value
        // and keeps only `recordedSecretValues`; a caller that sends its
        // resolved value to AWS must not opt in without failing on a
        // non-empty bag (see the field's doc).
        const abandoned: AbandonedResolution[] = [];
        try {
          const resolvedUnit = await resolver.resolve(propertyValue, {
            ...resourceContext,
            abandonedResolutions: abandoned,
          });
          if (isNestedRow && propertyName !== '') resolvedRowProps[propertyName] = resolvedUnit;
          if (isNestedRow && propertyName === 'Parameters') {
            nestedRowParameters.set(logicalId, {
              value: resolvedUnit,
              complete: abandoned.length === 0,
            });
          }
          // Recovery means the resolve no longer THROWS for these, so the
          // verdict has to be reached from the bag instead — PER ENTRY, and
          // folded to the most severe.
          //
          // An earlier cut judged `abandoned[0]` against the whole property
          // and called that "the count is unchanged". It was the defect. The
          // verdict turns on `isTemplateShapeResolutionFailure`, and that
          // class fires EN MASSE on healthy stacks — every `{Ref: <param>}`
          // to a `Default`-less parameter throws — so entry 0 is
          // routinely a `warn`, which gates nothing. Recovery then reaches a
          // genuinely unfetched reference later in the same property, and
          // judging only entry 0 discarded exactly the finding this PR
          // exists to produce: `--dry-run --fail` printed `No plaintext
          // secrets found` and exited 0 over a surviving plaintext.
          //
          // Per ENTRY and not per property for the opposite error: an
          // abandoned KEY can be a bare `{"Ref": ...}` carrying no reference
          // at all (go-to-k/cdkd#3218's repro), and nothing about that is
          // unverifiable — judged against the enclosing property it would
          // inherit a sibling's reference and count.
          reportAbandonedBag(
            abandoned,
            propertyName
              ? `resource ${maskedIdent(logicalId, recordedSecretValues)} property ${maskedIdent(propertyName, recordedSecretValues)}`
              : `resource ${maskedIdent(logicalId, recordedSecretValues)}`,
            recordedSecretValues,
            `${maskedIdent(logicalId, recordedSecretValues)}${propertyName ? `.${maskedIdent(propertyName, recordedSecretValues)}` : ''}`
          );
        } catch (err) {
          // A region-AMBIGUOUS refusal is not best-effort -- see
          // `isRegionAmbiguousRefusal`.
          if (isRegionAmbiguousRefusal(err) || isNamelessDynamicReferenceFailure(err)) throw err;
          if (isNestedRow && propertyName === 'Parameters') {
            nestedRowParameters.set(logicalId, { value: undefined, complete: false });
          }
          // The THROW path, which cannot use `reportAbandonedBag`: it holds
          // only an error, so it must ask `abandonedScanVerdict` about the
          // whole property. Reached when the resolve failed for a reason the
          // recovery does not catch — a refusal is re-raised above, so this
          // is a failure with no bag-eligible unit under it.
          const leafVerdict = abandonedScanVerdict(propertyValue, err);
          if (leafVerdict !== 'silent') {
            if (leafVerdict === 'count') unverifiableLeaves++;
            else ungateableAbandonedScans++;
            logger.warn(
              maskSecretsInText(
                abandonedScanWarning(
                  propertyName
                    ? `resource ${maskedIdent(logicalId, recordedSecretValues)} property ${maskedIdent(propertyName, recordedSecretValues)}`
                    : `resource ${maskedIdent(logicalId, recordedSecretValues)}`,
                  leafVerdict
                ),
                recordedSecretValues
              )
            );
          }
          // MASKED for the reason `unresolvableForeignScrubSecretError`
          // states: `resolveInput` is a bag `pinCrossRegionSecrets` may
          // already have SUBSTITUTED a foreign plaintext into, so a resolver
          // error that echoes what it was handed can carry one.
          logger.debug(
            maskSecretsInText(
              `Resolution of ${maskedIdent(logicalId, recordedSecretValues)}` +
                `${propertyName ? `.${maskedIdent(propertyName, recordedSecretValues)}` : ''} during scrub was ` +
                `partial: ${describeAwsFailure(err).detail}`,
              recordedSecretValues
            )
          );
        }
      }
      // The unresolved template bag is this record's POSITION source (#1910).
      // Captured for EVERY templated resource, not only the secret-bearing ones,
      // because `scrubResourceRecord` uses it for the `observedProperties` walk
      // too — and unlike the deploy engine, `cdkd scrub` re-resolves the whole
      // template every run, so a resource with no recorded secret still has a
      // usable source in hand.
      perResourceTemplateProps.set(logicalId, templateResource.Properties);
      // Issue #2291 / #3062, the deploy engine's CREATE / UPDATE step for this
      // row: remember which `{{resolve:...}}` expression each child parameter
      // was resolved FROM, keyed by parameter NAME, on this row's own bag —
      // the bag the child is handed as `inheritedSecrets`, whose
      // `inheritNestedStackParameterAssociations` reads the table back. Also
      // the frame carry for an OBJECT-spelled parameter (`port:{{resolve:..}}`
      // assembled by `Fn::Join`), which the child's needles need and which,
      // on a record older than that carry, only this run can supply.
      const nestedParameters = nestedRowParameters.get(logicalId);
      if (isNestedRow && nestedParameters?.complete === true) {
        recordNestedStackParameterExpressions(
          recordedSecretValues,
          NESTED_STACK_TYPE,
          resolvedRowProps,
          templateResource.Properties
        );
      }
    }

    // Rollback-orphan records (issue go-to-k/cdkd#2943). `orphans[*].state`
    // is a whole `ResourceState` — `properties` and `attributes` — and until
    // this loop `scrub` walked past it, so its verdict line was silent about
    // a field that can carry a secret.
    //
    // Needles come from the RECORD, not the template, and that is the whole
    // difference from the loop above. An orphan's logical id may be gone
    // from the template — a user who removed the failing resource from their
    // CDK app is the ordinary way to reach this state — and then there is
    // nothing to re-resolve for it. Deriving from the record keeps that case
    // covered instead of silently dropping it.
    //
    // `resolveCrossStackReads` is NOT armed here, unlike the resource loop.
    // A persisted bag is post-resolution: an `Fn::ImportValue` node became a
    // value before it was ever written, and the only unresolved leaves in it
    // are the dynamic references redaction put back, which the resolve below
    // handles. If that is ever wrong the cost is a missed needle, not a
    // wrong rewrite, and the union in the rewrite pass is the backstop.
    // `entries()` for the INDEX, which is the key `orphanSecrets` is declared
    // with — its doc comment carries why an id key lost a row's needles.
    for (const [orphanIndex, record] of (state.orphans ?? []).entries()) {
      const recordedSecretValues = newBag();
      // Registered before the pin for the same reason the resource loop
      // registers early: `pinCrossRegionSecrets` can throw AFTER recording a
      // foreign plaintext, and the error boundary at the bottom of this
      // function masks against `allRecordedSecrets(..., orphanSecrets)` —
      // which reads this map. Registering after the pin would leave that
      // throw with no needle for what it had already recorded.
      orphanSecrets.set(String(orphanIndex), recordedSecretValues);
      const resolveInput = await pinCrossRegionSecrets(
        {
          properties: record.state.properties,
          attributes: record.state.attributes ?? {},
          // The THIRD bag, because `scrubResourceRecord` scrubs it too. A
          // service-echoed secret can live only here — redacted at write
          // time by another resource's needle — and omitting it would leave
          // that leaf with no needle of its own.
          observedProperties: record.state.observedProperties ?? {},
        },
        stack.stackName,
        {
          stackRegion: region,
          producerRegions,
          resolvers,
          recordedSecretValues,
          origin: `orphan record ${maskedIdent(record.logicalId, recordedSecretValues)}`,
          recordedRegions: recordedReferenceRegions(record.state),
        }
      );
      // PER SUB-BAG, for the same reason the resource loop resolves per
      // property (issue go-to-k/cdkd#3196): one throw aborts the walk, so a
      // failure in `properties` abandoned `attributes` and
      // `observedProperties` — both of which carry references of their own,
      // and `scrubResourceRecord` scrubs all three.
      //
      // Splitting is unconditionally safe HERE, unlike the resource loop: this
      // wrapper is one WE construct with three known keys, so it can never be
      // an intrinsic-shaped bag the resolver would dispatch on.
      const orphanContext = resolverContext(recordedSecretValues);
      for (const [bagName, bagValue] of Object.entries(resolveInput)) {
        // Opts in like the resource loop (issues go-to-k/cdkd#3181 /
        // go-to-k/cdkd#3218): the resolved value is DISCARDED here too, so
        // the consumer obligation is met, and an orphan record's bag is
        // exactly as able to hold a dead reference beside a live one.
        const abandoned: AbandonedResolution[] = [];
        try {
          await resolver.resolve(bagValue, {
            ...orphanContext,
            abandonedResolutions: abandoned,
          });
          reportAbandonedBag(
            abandoned,
            `orphan record ${maskedIdent(record.logicalId, recordedSecretValues)} ${bagName}`,
            recordedSecretValues,
            `orphan record ${maskedIdent(record.logicalId, recordedSecretValues)} ${bagName}`
          );
        } catch (err) {
          // A region-AMBIGUOUS refusal is not best-effort -- see
          // `isRegionAmbiguousRefusal`.
          if (isRegionAmbiguousRefusal(err) || isNamelessDynamicReferenceFailure(err)) throw err;
          const leafVerdict = abandonedScanVerdict(bagValue, err);
          if (leafVerdict !== 'silent') {
            if (leafVerdict === 'count') unverifiableLeaves++;
            else ungateableAbandonedScans++;
            logger.warn(
              maskSecretsInText(
                abandonedScanWarning(
                  `orphan record ${maskedIdent(record.logicalId, recordedSecretValues)} ${bagName}`,
                  leafVerdict
                ),
                recordedSecretValues
              )
            );
          }
          logger.debug(
            maskSecretsInText(
              `Resolution of orphan record ${maskedIdent(record.logicalId, recordedSecretValues)} ${bagName} during ` +
                `scrub was partial: ${describeAwsFailure(err).detail}`,
              recordedSecretValues
            )
          );
        }
      }
    }

    // Outputs are secret-bearing too (a CfnOutput resolving a secret reference),
    // so re-resolve the template Outputs to record any secret they carry.
    // The SAME key-space rules the deploy engine applies when it builds this bag
    // (issue #1919) — shared rather than re-spelled, because this bag only works
    // if it reproduces the deploy engine's key ownership. Without a guard here
    // `cdkd scrub` was the WORSE half of that defect: its bag is legacy state
    // holding plaintext, and the alias write below runs AFTER the owning
    // output's write in this single loop (the opposite winner from the deploy
    // engine, where the post-loop pass wins), so a colliding export name
    // positioned a CORRECT public output by the exporting output's secret
    // expression and rewrote it into a reference naming a DIFFERENT output's
    // secret — in the command that exists to remediate the advisory, and
    // republished from there into the exports index.
    //
    // Three rules differ from the engine's on purpose, and all follow from what
    // scrub can KNOW about state some earlier binary wrote:
    //
    // 1. A colliding key gets NO source at all, rather than the owning output's.
    //    The engine just resolved that key's value and knows whose it is; scrub
    //    does not, and in the corrupted-legacy case — the case it exists for —
    //    the alias may well have WON the key. So the key falls to the VALUE
    //    scan, which reads the plaintext actually stored and maps it back to
    //    the expression that produced it — as far as a value scan can, which is
    //    exactly: a WHOLE-value match always, and an EMBEDDED one only for
    //    secrets at or above `secret-redaction`'s minimum needle length. A
    //    short secret embedded in a longer stored value therefore survives this
    //    fallback, and the stack is reported clean; that bound is the value
    //    scan's, not this rule's, but this rule is what exposes the key to it.
    //    That is the pre-#1910 behavior, which
    //    for this key is what the issue calls "weaker but not wrong: it
    //    returned an expression that at least resolved to the value it
    //    replaced". The residual it accepts is stated exactly, because an
    //    earlier revision understated it: when two DISTINCT secrets happen to
    //    resolve to one plaintext, the value map keeps one of them, so the
    //    ambiguous key can be persisted holding a reference naming the OTHER
    //    secret — not merely a lost precision bound. Neither rule dominates
    //    (position can name the wrong secret on this key too, from the other
    //    direction), and the test file pins both sides of the trade.
    //
    // 2. Collisions are tested against every DECLARED output name, conditions
    //    ignored, and an INTRINSIC `Export.Name` is best-effort resolved for
    //    that test alone — see `collectDeclaredOutputNames` for why scrub must
    //    over-approximate here, and note the legacy population is exactly the
    //    binaries that DID resolve intrinsic export names into state keys, so a
    //    literal-only test leaves the original corruption reachable. The
    //    resolved name is never written as a source key: it is only compared.
    //
    // 3. If an intrinsic `Export.Name` cannot be resolved at all, the WHOLE
    //    outputs source bag is dropped and every output key falls to the value
    //    scan. The deploy keyed state under a name scrub then cannot reproduce,
    //    and that name could be ANY output's — so there is no key to mark
    //    ambiguous and no honest way to keep positioning the rest. A residual
    //    remains and is documented rather than hidden: a name that resolves
    //    SUCCESSFULLY but differently from what the deploy resolved (a
    //    parameterized prefix, since scrub has only template defaults) is
    //    undetectable from here.
    // Which `state.outputs` KEYS today's template can account for (issue #2005).
    // Every declared output name, plus every `Export.Name` this run could
    // FULLY compute — the literal ones AND the intrinsic ones whose best-effort
    // resolution actually landed. That is still wider than the set that gets a
    // position source below (only a LITERAL export name may be written under),
    // but NOT wider than what the template can name: a name that did not fully
    // resolve is excluded, because over-approximating there SUPPRESSES the
    // repair rather than merely widening it (see the per-name comment below).
    // The widened outputs pass at the end of this function fires ONLY on keys
    // that are in NEITHER set.
    for (const [name, output] of Object.entries(templateOutputs)) {
      // The declared type says `string`, but templates carry intrinsics here and
      // the pre-fix binary resolved them into state keys.
      const declaredExportName = (output as { Export?: { Name?: unknown } }).Export?.Name;
      let exportName: unknown = declaredExportName;
      if (declaredExportName !== undefined && typeof declaredExportName !== 'string') {
        // Resolved through a VIEW of the pass map (issue #2531): the entries
        // are the pass map's, live, but the resolved PAIRS the resolver
        // records beside them hang off this instance and die with it — see
        // `SharedEntriesSecrets` for why both halves matter. This loop runs
        // FIRST and re-asks AWS for a reference the resolver never caches (an
        // unclassifiable-`Type` `ssm` parameter), so a value that moves
        // between this resolution and the value loop's would, recorded
        // straight into the pass map, conflict the pair a literal Output
        // embedding the token needs. (An earlier comment here grounded the
        // shared map on the cache-hit arm re-recording "only what it can
        // still prove is secret"; since issue #1933 the cache carries the
        // verdict beside the value, so the hit arm re-records a cached secret
        // too, and the never-cached reference above re-asks AWS regardless.
        // The entries are shared either way, without leaning on that.)
        const nameSecrets: RecordedSecretValues = new SharedEntriesSecrets(outputSecrets);
        // The LOG-ONLY needles (go-to-k/cdkd#1998) are keyed by the map
        // INSTANCE, so the view SHARES `outputSecrets`' set: a needle recorded
        // through it — by the pin, the cross-stack reads, or a resolution
        // that throws — is visible to every later print that masks with
        // `outputSecrets`, the error boundary included.
        shareLogOnlyValues(nameSecrets, outputSecrets);
        // Whether the name's resolution threw (a swallowed, best-effort
        // failure). A boolean rather than the error's presence: `undefined`
        // is a legal thrown value, and the old catch warned for it too.
        let nameFailed = false;
        let nameError: unknown;
        // Issue #2109, same treatment as the resource bag above and outside
        // the catch for the same reason. An `Export.Name` is rarely
        // secret-bearing, but the region question is the expression's, not
        // the position's — and this resolution's RESULT becomes a state key,
        // so a wrong-region answer here mis-keys the whole positioned outputs
        // pass.
        const nameSource = await pinCrossRegionSecrets(declaredExportName, stack.stackName, {
          stackRegion: region,
          producerRegions,
          resolvers,
          recordedSecretValues: nameSecrets,
          origin: `Export.Name of output ${maskedIdent(name, nameSecrets)}`,
        });
        const nameContext = resolverContext(nameSecrets);
        // Issue #2133, same treatment and same placement as the resource bag
        // above: a name assembled from a cross-stack read that scrub cannot
        // perform is a name it cannot reproduce, and swallowing that is how
        // the whole outputs pass came to be positioned against a key the
        // deploy never wrote.
        await resolveCrossStackReads(
          nameSource,
          nameContext,
          crossStackReadOrigin('Export.Name of output', 'output name', name, nameSecrets),
          {
            canRefuse: !isOutputSuppressed(name, output, conditions, state.outputs ?? {}),
          }
        );
        try {
          exportName = await resolver.resolve(nameSource, nameContext);
        } catch (err) {
          // A region-AMBIGUOUS refusal is not best-effort -- see
          // `isRegionAmbiguousRefusal`.
          if (isRegionAmbiguousRefusal(err) || isNamelessDynamicReferenceFailure(err)) throw err;
          const leafVerdict = abandonedScanVerdict(nameSource, err);
          if (leafVerdict !== 'silent') {
            if (leafVerdict === 'count') unverifiableLeaves++;
            else ungateableAbandonedScans++;
            logger.warn(
              maskSecretsInText(
                abandonedScanWarning(
                  `the Export.Name of output ${maskedIdent(name, outputSecrets)}`,
                  leafVerdict
                ),
                outputSecrets
              )
            );
          }
          nameFailed = true;
          nameError = err;
        }
        if (nameFailed) {
          // No key to mark ambiguous — the name the deploy used is unknown and
          // could be any output's — so the whole source bag becomes untrusted.
          outputsSourceUntrusted = true;
          // MASKED, and this is the one of the three that prints at DEFAULT
          // verbosity. UNCHANGED by issue #2563: a needle missed because a
          // drain released on a spent budget under-redacts here, and that
          // is not a regression -- the merge base has no drain at all, so
          // its grace is zero unconditionally. Do not re-derive it as one.
          // Full context: `nameSource` is a bag `pinCrossRegionSecrets` may
          // already have substituted a foreign plaintext into, so a resolver
          // error echoing its input reaches the terminal of a command whose
          // entire subject is removing that plaintext. `outputSecrets` holds
          // everything the pin and the resolution recorded (the view writes
          // through), so it is the right needle set.
          logger.warn(
            `Export.Name of output ${maskedIdent(name, outputSecrets)} could not be resolved during scrub ` +
              `(${maskSecretsInText(describeAwsFailure(nameError).detail, outputSecrets)}) — ` +
              `redacting this stack's outputs by value match instead of by template position, since state may be keyed under a name this run cannot reproduce.`
          );
        }
      }
      if (declaredExportName !== undefined && typeof exportName !== 'string') {
        // Same reasoning as the catch: a name that resolved to a non-string is
        // a name scrub cannot reproduce.
        outputsSourceUntrusted = true;
      }
      // A resolution that came BACK is not the same as one that SUCCEEDED:
      // `resolveSub` does not throw on an unresolvable placeholder, it warns and
      // keeps `${Foo}` in the string. Scrub takes no `--parameters`, so that is
      // the COMMON shape for a parameterized export name — and trusting it would
      // run the collision test against a name scrub provably could not
      // reproduce, re-enabling the wrong-secret rewrite in the remediation
      // command. Same rule the diff twin applies, imported rather than
      // re-spelled.
      const exportNameUnresolved =
        declaredExportName !== undefined &&
        typeof exportName === 'string' &&
        isUnresolvedValue(exportName, templateUsesSub(declaredExportName));
      // ACCOUNTED regardless of what the collision check below decides about
      // trusting it as a position SOURCE (issue #2005): the question here is
      // only "could today's template have produced this state key", and a name
      // that FULLY resolved is a name the deploy could have keyed under.
      //
      // A name that did NOT fully resolve is deliberately NOT added, and the
      // first cut of this got it backwards on a premise that is false: it added
      // the literal `${Foo}` too, calling it inert because "that is not a key
      // any deploy wrote". It can be — `deploy-engine.ts`'s alias write guards
      // only on `typeof exportName !== 'string'`, with no `isUnresolvedValue`
      // test, so a deploy whose `Fn::Sub` warn-and-KEPT `${Foo}` writes that
      // literal into `state.outputs` as a key. Marking it accounted then
      // EXCLUDES it from the widened pass while the positioned pass runs
      // source-less against `outputSecrets` alone — so a secret living only in
      // `perResourceSecrets`, which is exactly issue #2005's population, is
      // never repaired and `--dry-run --fail` exits clean over surviving
      // plaintext. Not adding it is strictly narrowing: the key it could not
      // compute was already unaccounted, and now the literal one is too.
      if (typeof exportName === 'string' && !exportNameUnresolved) {
        accountedOutputKeys.add(exportName);
      }
      // REPRODUCED means more than accounted: the key must be in the record,
      // or this run computed a name the deploy did not write (a parameter
      // override, a suppressed or skipped output) and the deploy's real alias
      // is one of the unaccounted keys.
      //
      // A LITERAL name colliding with ANOTHER declared output is exempt: the
      // deploy never publishes that alias, and a literal is the name it
      // computed too. An intrinsic one is not, since template defaults may
      // not be what the deploy resolved. And a name that is also a declared
      // Output name proves nothing on a record with no export set: the key
      // it matched may be that plain Output.
      const literalCollision =
        typeof declaredExportName === 'string' &&
        isExportAliasCollision(declaredExportName, name, declaredOutputNames);
      // go-to-k/cdkd#4043 Phase C: a name the deploy's export-name verdict
      // REFUSES (it holds or reads a `NoEcho` value) is never published, so
      // its alias key is absent by design and does not make the stored
      // aliases unaccountable. A key an older binary published under it is
      // then an unnamed key the drop plan decides like any other: reported
      // when its name renders a secret (and then kept, since a key cannot
      // be rewritten), dropped otherwise.
      // Not through an `Fn::If`, on either arm: the deploy reads only the
      // branch its condition selects, which scrub's default-bound verdicts
      // may not reproduce, so a conditional name stays a possible live alias.
      const refusedForNoEcho =
        declaredExportName !== undefined &&
        !JSON.stringify(declaredExportName).includes('"Fn::If"') &&
        ((typeof exportName === 'string' &&
          !exportNameUnresolved &&
          carriedExportAliasExposure(exportName, outputSecrets, noEchoNameSeed) !== undefined) ||
          readsNoEchoSource(declaredExportName, { parameters: noEchoNameParameters }));
      // The alias key a declared output publishes, for the NoEcho output
      // mask: only a served output's OWN alias is masked by name.
      if (typeof exportName === 'string' && !exportNameUnresolved) {
        declaredAliasOf.set(name, exportName);
      }
      if (
        declaredExportName !== undefined &&
        !literalCollision &&
        !refusedForNoEcho &&
        !(
          typeof exportName === 'string' &&
          !exportNameUnresolved &&
          isReadableBag(state.outputs) &&
          Object.hasOwn(state.outputs, exportName) &&
          // A key the record's own export set does not list is a plain
          // Output of the same name, not this alias.
          (knownExportNamesOf(state.exportNames)?.has(exportName) ??
            (typeof declaredExportName === 'string' || !declaredOutputNames.has(exportName)))
        )
      ) {
        everyExportAliasReproduced = false;
      }
      if (exportNameUnresolved) {
        outputsSourceUntrusted = true;
        logger.warn(
          `Export.Name of output ${maskedIdent(name, outputSecrets)} did not fully resolve during scrub — ` +
            `redacting this stack's outputs by value match instead of by template position, since state may be keyed under a name this run cannot reproduce.`
        );
      } else if (
        typeof exportName === 'string' &&
        isExportAliasCollision(exportName, name, declaredOutputNames)
      ) {
        ambiguousKeys.add(exportName);
        // The WARNING is deferred to after the value loop below, for the same
        // reason the deploy engine decides aliases in a second pass: this loop
        // runs first, so `outputSecrets` is not yet complete, and the message
        // masks its name against that map. Warning here would print a resolved
        // name whose plaintext had not been recorded yet.
        collisions.push([name, exportName]);
      }
    }
    for (const [name, output] of Object.entries(templateOutputs)) {
      const value = output.Value;
      if (value === undefined) continue;
      // The unresolved output value is its POSITION source (#1910).
      if (!ambiguousKeys.has(name)) outputsTemplateSource[name] = value;
      // `state.outputs` ALSO carries an export-name ALIAS for the same value
      // (the deploy engine writes one so `Fn::ImportValue` can find it), and
      // that second key needs the same source or it falls to the value scan and
      // collapses onto a sibling's expression. Only a LITERAL export name gets a
      // source: the resolved form of an intrinsic one is trusted for the
      // collision TEST above but not as a key to write under, since a
      // best-effort resolution with template-default parameters can differ from
      // what the deploy resolved. (Nor can scrub meet the secret-bearing-name
      // case the deploy engine refuses: it never writes a resolved name.)
      const exportName = (output as { Export?: { Name?: unknown } }).Export?.Name;
      if (typeof exportName === 'string' && !ambiguousKeys.has(exportName)) {
        outputsTemplateSource[exportName] = value;
      }
      // NOT gated on the suppression rules the deploy engine applies, and this
      // is load-bearing rather than an omission: skipping the iteration would
      // skip the resolve below, so a secret this output carries would never be
      // RECORDED, and a stack whose only secret sits in a
      // (possibly-spuriously) suppressed output would be reported CLEAN by the
      // command whose job is to find it. The write above is the only thing a
      // suppressed output could get wrong, and the ambiguity set already covers
      // that.
      //
      // BOTH HALVES, because the first cut stated only this one and then let it
      // carry more weight than it can (issue #2133 review). "Resolve a
      // suppressed output for its needles" does NOT imply "refuse the stack
      // when that resolution fails": a suppressed output wrote no
      // `state.outputs` key, so there is no stored plaintext behind it to
      // protect, while refusing would make a prod-only
      // `Fn::ImportValue` unscrubbable in dev — every OTHER secret in the stack
      // stranded over a reference the deploy never read. Hence the
      // `canRefuse` flag on the pre-pass call below; see
      // {@link isOutputSuppressed}.
      // Issue #2109, same treatment and same placement as the two above. The
      // POSITION source written just above is the ORIGINAL `value`, never this
      // copy: `redactSecretsForState` reads UNRESOLVED expressions off it.
      const valueSource = await pinCrossRegionSecrets(value, stack.stackName, {
        stackRegion: region,
        producerRegions,
        resolvers,
        recordedSecretValues: outputSecrets,
        origin: `output ${maskedIdent(name, outputSecrets)}`,
        recordedRegions: recordedOutputReferenceRegions(state, name),
      });
      const valueContext = resolverContext(outputSecrets);
      // Issue #2133, same treatment and same placement as the two above. An
      // output that re-publishes an imported value is the ordinary shape here,
      // and its plaintext becomes a needle only if the read succeeds.
      await resolveCrossStackReads(
        valueSource,
        valueContext,
        crossStackReadOrigin('output', 'output name', name, outputSecrets),
        {
          canRefuse: !isOutputSuppressed(name, output, conditions, state.outputs ?? {}),
        }
      );
      // Opts in for the same reason as the resource and orphan loops: the
      // resolved value is discarded, only the needles matter, and an output
      // Value is a common place for `postgres://u:{{resolve:A}}@h/{{resolve:B}}`
      // — exactly the shape where abandoning at the first reference left the
      // second one's plaintext un-needled (go-to-k/cdkd#3181).
      const abandonedOutput: AbandonedResolution[] = [];
      try {
        await resolver.resolve(valueSource, {
          ...valueContext,
          abandonedResolutions: abandonedOutput,
        });
        reportAbandonedBag(
          abandonedOutput,
          `output ${maskedIdent(name, outputSecrets)}`,
          outputSecrets,
          `output ${maskedIdent(name, outputSecrets)}`
        );
      } catch (err) {
        // A region-AMBIGUOUS refusal is not best-effort -- see
        // `isRegionAmbiguousRefusal`.
        if (isRegionAmbiguousRefusal(err) || isNamelessDynamicReferenceFailure(err)) throw err;
        const leafVerdict = abandonedScanVerdict(valueSource, err);
        if (leafVerdict !== 'silent') {
          if (leafVerdict === 'count') unverifiableLeaves++;
          else ungateableAbandonedScans++;
          logger.warn(
            maskSecretsInText(
              abandonedScanWarning(`output ${maskedIdent(name, outputSecrets)}`, leafVerdict),
              outputSecrets
            )
          );
        }
        // MASKED for the same reason as the two above — `valueSource` is a
        // post-pin bag. Verbose-only.
        logger.debug(
          `Resolution of output ${maskedIdent(name, outputSecrets)} during scrub was partial: ` +
            `${maskSecretsInText(describeAwsFailure(err).detail, outputSecrets)}`
        );
      }
    }
  });
  return {
    unverifiableLeaves,
    emitAbandonedScanNotes,
    outputsSourceUntrusted,
    everyExportAliasReproduced,
    nestedRowParameters,
  };
}
