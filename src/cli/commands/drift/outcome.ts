/**
 * `cdkd drift`: the per-resource outcome union, the stack report and the exit-code errors.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import { CdkdError } from '../../../utils/error-handler.js';
import { cdkdRemedy } from '../../../utils/pasteable-command.js';
import type { PropertyDrift } from '../../../analyzer/drift-calculator.js';
import type { ProducerRegionEvidence } from '../../../deployment/producer-regions-scope.js';
import type { RecordedSecretValues } from '../../../deployment/secret-redaction.js';
import type { StackState } from '../../../types/state.js';
import type { SecretPathSet } from './secret-resolution.js';

/**
 * Why cdkd did not compare every property a resource records.
 *
 * Carried by the {@link DriftOutcome} `notCompared` variant, and by a `drifted`
 * outcome whose reported changes are real but are not the whole comparison.
 *
 * ONE ENUMERATION rather than the pre-#2135 pair of booleans
 * (`referencesUnresolved`, the OR of both causes, plus `comparisonRefused` for
 * the first one alone). The two flags answered the same question at two widths,
 * and the width is what the EXIT CODE turns on:
 *
 *   - `refused` — cdkd DELIBERATELY REFUSED to resolve this resource's dynamic
 *     references (issue #2108). True exactly when
 *     `resolveStateSecretExpressions` THREW. This is the population the exit
 *     code is scoped to: it is what this change created, it is actionable (spell
 *     the reference as a full ARN, which names its region), and pre-#2108 the
 *     same resources exited `1` because the wrong-region resolution reported
 *     phantom drift — so a non-zero exit PRESERVES what CI consumers had.
 *   - `unresolvedToken` — a `{{resolve:...}}` token simply survived the pass:
 *     a spelling cdkd resolves for NOBODY. Until issue #2482 that was
 *     `{{resolve:ssm-secure:...}}`, a large PRE-EXISTING population; it now
 *     resolves like `ssm`, so no CloudFormation service lands here and what
 *     remains is text that merely looks like a reference (or a service AWS
 *     adds later). The argument is unchanged: the cause is unrelated to #2108
 *     and permanent by construction, so it can never clear on a re-run.
 *     Driving the exit code off it would make `cdkd drift` exit non-zero
 *     forever, in CI, for every one of those users, over a defect this change
 *     did not introduce — the same "permanently non-zero" hazard
 *     `docs/cli-reference.md` already cites as a reason NOT to report an
 *     absent write-only credential as drift.
 *
 * So the split is: as INFORMATION both causes mean the resource was not fully
 * compared, and the `--json` `notCompared` roll-up / the human `PARTIALLY
 * compared` block cover both unchanged. Only the EXIT CODE — the thing CI keys
 * on — is confined to `refused`.
 *
 *   - `readFailed` — the per-resource READ or COMPARISON threw, so no
 *     comparison happened at all (issues
 *     [#2151](https://github.com/go-to-k/cdkd/issues/2151) and
 *     [#1945](https://github.com/go-to-k/cdkd/issues/1945)). Unlike the two
 *     causes above this one is not about dynamic references: it covers an SDK
 *     or Cloud Control readback that rejected, a provider-authored bag the
 *     normalizers threw on, and a `calculateResourceDrift` that could not walk
 *     the two bags. It joins `refused` on the EXIT CODE side, because the
 *     realistic population is actionable and CLEARABLE — a least-privilege role
 *     missing `cloudcontrol:GetResource`, a throttle, a provider bug — which is
 *     exactly the property `unresolvedToken` lacks. The one population that is
 *     permanent by construction, a type with NO Cloud Control READ handler, is
 *     deliberately NOT routed here: it reports `unsupported`, which is what it
 *     already reported when the same condition arrived as an `undefined` return
 *     instead of a throw. See `isNoReadHandlerError`.
 *
 * A resource hitting BOTH causes is `refused`: that is the wider signal of the
 * two, and it is what the pre-#2135 `comparisonRefused = secretResolutionFailed`
 * said for the same resource. `readFailed` cannot coincide with either: it is
 * raised from a catch that ABANDONS the resource, so no outcome carrying it ever
 * reaches the code that computes the other two.
 */

export type NotComparedCause =
  | 'refused'
  | 'unresolvedToken'
  | 'readFailed'
  /**
   * cdkd never READ this resource: {@link DRIFT_READ_FAILURE_BREAKER_THRESHOLD}
   * reads in a row earlier in the same stack, through the same read path, THREW,
   * so the stack's remaining reads through that path were abandoned
   * (go-to-k/cdkd#2207). A run of consecutive read failures is what expired
   * credentials, a revoked role, a permission all of those reads need, or a
   * burst of throttling looks like, and reading on only paid the SDK's backoff
   * once per resource for the same answer. A re-run clears the throttling case.
   * Exit 2 like `readFailed`: nothing was compared, and a re-run clears it once
   * the condition does.
   */
  | 'readAborted'
  | 'baselineRefused'
  /**
   * The observed baseline holds an issue #2852 fail-closed mask at a position
   * the recording pass could not certify, and the ONLY difference found there
   * is that mask (go-to-k/cdkd#3595). Everything else about the resource was
   * compared. Exit 2 like `refused`, because it is clearable: a deploy that
   * changes the resource re-captures the baseline, and a no-change deploy
   * replaces each such mask its record's own references can certify.
   */
  | 'uncertifiedBaseline'
  /**
   * The record's `noEchoLeaves` (schema v11, go-to-k/cdkd#4043) names a
   * position whose value a `NoEcho` template parameter served, so state holds
   * it only as the mask, and the ONLY difference found there is that mask.
   * Everything else about the resource was compared. Exit 0, like
   * `unresolvedToken`: the position is masked by design, so no re-run can
   * clear it, and gating CI on it would fail every such stack forever.
   */
  | 'noEchoParameter'
  /**
   * The record holds a row nothing can read as a resource (go-to-k/cdkd#3018),
   * or one whose `properties` map is not an object (go-to-k/cdkd#3315) — a
   * baseline read as `{}` walks no keys, so comparing it would report CLEAN.
   *
   * Carried as an OUTCOME rather than left as a warning, because `cdkd drift`
   * is a CI gate: the read-only mode DROPS such a row (or, for a torn
   * `properties` map, repairs it and withholds it from comparison) so the rest of the stack
   * can still be compared, and a dropped row that produced no outcome appeared
   * in no `--json` array and in no count, so the run exited 0 with the only
   * signal on stderr. Before this class was handled at all the same record
   * threw, which is non-zero — turning a loud failure into a silent clean
   * verdict is the one direction a fix here must not take.
   */
  | 'unreadableRecord'
  /**
   * The record's WHOLE `resources` map is not an object, so nothing in it was
   * read or compared. Reported as ONE outcome named
   * `UNREADABLE_RESOURCES_MAP_ROW`, and a cause of its own rather than
   * `unreadableRecord` (go-to-k/cdkd#3339): under that cause the row was
   * identical to a dropped ENTRY whose key is spelled `(resources map)`, and the
   * two differ in remedy — this one means the whole inventory is gone from the
   * record. A consumer detecting that keys on this cause, never on the name.
   * Exit 2, like every cause but `unresolvedToken`.
   */
  | 'unreadableMap';

/**
 * The schema version at which `ResourceState.observedBaselineRefused` arrived.
 * A record BELOW it could not carry a refusal, which is what
 * {@link warnIfPreV10BaselineGap} keys on (issue
 * [#3011](https://github.com/go-to-k/cdkd/issues/3011)).
 *
 * A literal rather than `STATE_SCHEMA_VERSION_CURRENT`: this is a FIXED
 * historical boundary, and binding it to "current" would silently stop warning
 * about v10 records on the next bump — the population it names does not move.
 */
export const PRE_V10_BASELINE_WARNING_FLOOR = 10;

/**
 * Per-resource drift outcome surfaced by the drift command.
 *
 * The terminal states are:
 *   - `drifted` — at least one property differs between state and AWS.
 *   - `clean` — every state-recorded property was compared against AWS and
 *     matched. This variant carries NO completeness flag, by construction: a
 *     resource cdkd did not fully compare is a `notCompared` outcome, never a
 *     `clean` one, so "clean" cannot mean anything but "compared and matched".
 *   - `notCompared` — nothing drifted, but cdkd did not compare every property
 *     the resource records, so "no drift" is not a clean bill of health.
 *   - `unsupported` — the provider does not implement `readCurrentState`
 *     yet (the optional method returned `undefined`). Reported separately
 *     so users see what's still uncovered.
 *   - `skipped` — drift detection is not conceptually applicable (see the
 *     member's own note).
 *
 * Issue [#2135](https://github.com/go-to-k/cdkd/issues/2135) is why
 * `notCompared` is a MEMBER rather than a `clean` carrying a boolean rider.
 * Under the flag shape every consumer had to REMEMBER to consult the flag, and
 * the default behaviour of forgetting was to report a resource cdkd never
 * checked as one with no drift. That happened twice on the #2108 lane in
 * successive review rounds — round 1: `--json` reported such a resource as plain
 * `clean`; round 2: the exit code read the refusal as a pass — and the third
 * consumer would have been whichever one got written next. As a MEMBER, a
 * consumer that does not name it does not COMPILE: every consumer routes its
 * outcomes through {@link matchOutcome}, whose handler record is a mapped type
 * over `DriftOutcome['kind']`.
 */
export type DriftOutcome =
  | {
      kind: 'drifted';
      logicalId: string;
      resourceType: string;
      changes: PropertyDrift[];
      /**
       * Snapshot of AWS-current properties returned by the provider's
       * `readCurrentState`. Captured here so `--revert` can pass it to
       * `provider.update` as the `previousProperties` argument without
       * re-issuing the read.
       *
       * Deliberately UNREDACTED (issue #1914): this bag is handed to
       * `provider.update` as the AWS-current side, so a `{{resolve:...}}`
       * expression written over a secret leaf would tell the provider AWS
       * currently holds the literal token.
       *
       * So it must not be printed or persisted RAW, which is not the same as
       * never reaching either. It reaches state on one path — `--revert` sends
       * `buildRevertNewProperties`'s merge of it with the desired subtrees, and
       * the provider's echo of that becomes the #1644 narrowing delta — and
       * that path redacts it before the write. It reaches stdout on one path
       * too: the revert PLAN derives tag / untemplated-key PATH names from it,
       * and those are masked where they are PRINTED — the lists themselves stay
       * unmasked because their callers use them as KEY SETS. Everything else reads
       * `changes`, which is redacted as the outcome is constructed.
       */
      awsProperties: Record<string, unknown>;
      /**
       * `plaintext -> {{resolve:...}}` for every SECRET dynamic reference the
       * drift comparison re-resolved out of this resource's baseline and its
       * `properties` (issue #1914). Empty for the overwhelming majority of
       * resources, which carry no dynamic reference at all.
       *
       * Read by `runAccept`, which redacts the baseline it is about to persist
       * with the same map the comparison built — the `--accept` write is fed by
       * a live AWS readback and is therefore a disclosure surface of its own.
       * `runRevert` deliberately does NOT read it: a revert needs the
       * resolution direction (expression -> today's plaintext) against AWS as
       * it is NOW, so it re-derives its own map rather than inverting this one.
       */
      secrets: RecordedSecretValues;
      /**
       * go-to-k/cdkd#3869: the resource's PRINTING bag (its own derived-name
       * spellings and those of each secret-named record it holds) plus every
       * secret-named record's spellings in the stack, which every
       * RENDERING of `changes` masks with (`displayDriftValue`). Display only:
       * `changes` stays raw, since `--accept` writes `awsValue` into state.
       */
      printingNeedles?: RecordedSecretValues;
      /**
       * The `changes[].path` values whose reported value cdkd could not
       * identify — a masked VALUE at a known-secret path, or a masked PATH
       * (issue #1914).
       *
       * Carried rather than re-derived by comparing against `SECRET_MASK`,
       * which would false-refuse a property whose real value is the string
       * `***` and cannot see a masked path at all. Read by
       * `acceptRefusalReason` (shared by the `--accept` write and its plan) and
       * by `runRevert`, which cannot overlay a subtree whose TOP-LEVEL segment
       * it can no longer name.
       */
      maskedPaths: SecretPathSet;
      /**
       * The comparator paths split off as uncertified-baseline positions
       * (issue [#3595](https://github.com/go-to-k/cdkd/issues/3595)): the
       * baseline holds a #2852 fail-closed mask there and that mask is the
       * ONLY difference from AWS. Never in `changes`, so nothing prints or
       * accepts them. Read by `runRevert` alone, which sends the LIVE subtree
       * at each one: `buildRevertNewProperties` overlays whole TOP-LEVEL keys,
       * so a real change beside the position would otherwise carry the mask
       * into the send bag. Paths only — no value — so the field discloses
       * nothing.
       */
      uncertifiedPaths: string[];
      /**
       * The comparator paths split off as `NoEcho` parameter positions
       * (go-to-k/cdkd#4043): the record's `noEchoLeaves` names them and the
       * mask is the ONLY difference from AWS. Never in `changes`. `runRevert`
       * sends the LIVE subtree at each, as for `uncertifiedPaths`, so the mask
       * never reaches AWS. Paths only. Optional: absent means none.
       */
      noEchoParameterPaths?: string[];
      /**
       * Can `secrets` NOT name every value this resource's positions hold? True
       * when resolution was refused or a token survived it — the two cases
       * where a live value cdkd never resolved can sit at a secret position.
       * Carried as its own FACT rather than read off `notComparedCause`, which
       * holds one cause: an `uncertifiedBaseline` outranks a surviving token
       * there (issue #3595), and the map is still incomplete. Read by the
       * revert plan, which withholds live-derived key lists it could not mask.
       */
      secretsIncomplete: boolean;
      /**
       * Why this resource's comparison was INCOMPLETE, or `undefined` when
       * every property was compared (issues #1914 / #2108 / #2135).
       *
       * A drifted resource can also be a partially compared one: the changes it
       * DOES report are real, but they are not the whole comparison, so it is
       * rolled up under `notCompared` alongside the variant of that name. The
       * EXIT CODE does not read this field — a `drifted` outcome already exits
       * `1`, which outranks the refusal signal.
       *
       * Also read by `printRevertPlan`, which derives its tag / untemplated-key
       * lists from the deliberately-unredacted `awsProperties` and masks them
       * with `secrets`. `secrets.size === 0` is NOT the same question: a
       * resource with one resolvable `secretsmanager` reference AND one
       * look-alike survivor has a non-empty map that still cannot mask what
       * the survivor's position holds.
       *
       * Required rather than optional so the construction site must SAY which
       * of the three states applies; `undefined` is the fully-compared one.
       */
      notComparedCause: NotComparedCause | undefined;
    }
  /**
   * Every state-recorded property was compared against AWS and matched.
   *
   * Carries no completeness marker on purpose (issue #2135): the refusal path
   * does NOT end here. A resource whose dynamic references cdkd could not — or
   * refused to — resolve falls back to the unresolved baseline,
   * `calculateResourceDrift` SKIPS every leaf still holding a `{{resolve:...}}`
   * string, and the change list comes back empty; that resource is pushed as
   * `notCompared`, so it can never be mistaken here for one that was compared
   * and matched. Pre-#2108 it reported (wrongly, but visibly) as drifted, so
   * silently folding it into `clean` would be a regression #2108 introduced.
   */
  | { kind: 'clean'; logicalId: string; resourceType: string }
  /**
   * No drift was REPORTED — which is not the same as "every property was
   * compared", and issue #2108 is what made the difference matter.
   *
   * A CI consumer gating on `drifted.length === 0` reads a SKIPPED comparison
   * as a passing one unless this is a state of its own, which is exactly what
   * issue #2135 makes it. `notComparedCause` decides the run's EXIT CODE; see
   * {@link NotComparedCause}.
   */
  | {
      kind: 'notCompared';
      logicalId: string;
      resourceType: string;
      notComparedCause: NotComparedCause;
    }
  | { kind: 'unsupported'; logicalId: string; resourceType: string }
  /**
   * AWS reports the resource does NOT EXIST — it was deleted outside cdkd
   * (go-to-k/cdkd#4283). The provider's read returned `RESOURCE_NOT_FOUND`.
   *
   * Its own member rather than `unsupported`, which it was folded into before:
   * that one is a coverage limit and exits `0`, while a missing resource is the
   * most important drift there is, so this one exits `1` like `drifted`. It
   * carries no `awsProperties` — there is nothing to read — so `--accept` and
   * `--revert` cannot act on it and REFUSE it by name: neither can recreate a
   * resource (and nor does a deploy that leaves its template unchanged).
   */
  | {
      kind: 'deleted';
      logicalId: string;
      resourceType: string;
      /**
       * go-to-k/cdkd#4533: set on a nested `AWS::CloudFormation::Stack` row
       * whose own `<parent>~<child>` record is gone from state. No AWS read
       * stands behind it, so the report must not say AWS answered.
       */
      nestedStackRecordMissing?: true;
    }
  /**
   * `skipped` is reserved for resource types where drift detection is not
   * conceptually applicable (`Custom::*`), and for a nested stack's row whose
   * own record this run compares in its own block (go-to-k/cdkd#4533). Unlike `unsupported`
   * (= "provider does not YET implement drift detection — user might want
   * to know"), `skipped` is silent in the human report so it doesn't
   * generate noise on every drift run for stacks that contain Custom
   * Resources (the CDK-built-in `Custom::S3AutoDeleteObjects` helper is
   * by far the most common case).
   */
  | { kind: 'skipped'; logicalId: string; resourceType: string };

/** A `drifted` outcome — the one variant `--accept` / `--revert` act on. */
export type DriftedOutcome = Extract<DriftOutcome, { kind: 'drifted' }>;

/** Every outcome that reports a resource as NOT fully compared. */
type NotComparedOutcome = Extract<DriftOutcome, { kind: 'drifted' | 'notCompared' }>;

/**
 * Route one outcome to the handler for its variant.
 *
 * The mechanism issue [#2135](https://github.com/go-to-k/cdkd/issues/2135) asks
 * for, and the reason every consumer in this file goes through it rather than
 * filtering on `o.kind === '...'`: `handlers` is a MAPPED TYPE over
 * `DriftOutcome['kind']`, so it must name EVERY variant. Adding a member to the
 * union turns every call site that has not been updated into a compile error
 * ("property '<kind>' is missing"), instead of leaving it to fall through to
 * whatever it happened to do before. A `.filter()` predicate cannot do that —
 * it keeps compiling and silently stops matching the new state.
 *
 * A handler that deliberately does nothing with a variant still has to be
 * written out, which is the point: the author of the next variant has to decide,
 * per consumer, what it means there.
 *
 * Exported, with {@link DriftOutcome} and {@link NotComparedCause}, so
 * `tests/unit/cli/drift-outcome.test-d.ts` can fence the mapped type itself:
 * relaxing it to a `Partial` record would silently un-fence every consumer in
 * this file while changing no runtime behaviour, so no runtime test can see it.
 */
export function matchOutcome<T>(
  outcome: DriftOutcome,
  handlers: { [K in DriftOutcome['kind']]: (outcome: Extract<DriftOutcome, { kind: K }>) => T }
): T {
  // The one cast, confined to this line: TypeScript cannot correlate the
  // handler picked out of the record with the outcome that picked it, even
  // though `kind` decides both. Every call site above is fully checked.
  return (handlers[outcome.kind] as (o: DriftOutcome) => T)(outcome);
}

/**
 * Aggregated drift report for one stack — what gets printed (or emitted as
 * JSON) for that stack. Aggregation across multiple stacks happens in the
 * top-level command driver.
 *
 * `state` and `etag` are kept on the report so the resolution paths
 * (`--accept`, `--revert`) can reuse the already-loaded state without
 * re-reading from S3 — and `etag` is required for the optimistic-lock
 * `IfMatch` write on `--accept`.
 */
export interface StackDriftReport {
  stackName: string;
  region: string;
  outcomes: DriftOutcome[];
  /** State that drift was computed against. Populated on every report. */
  state: StackState;
  /** S3 ETag of the state read; needed for `--accept`'s conditional write. */
  etag: string;
  /** When the state was loaded from the legacy v1 key — forwarded to saveState. */
  migrationPending: boolean;
  /**
   * Stack-level advisories this run produced, verbatim (issue
   * [#3011](https://github.com/go-to-k/cdkd/issues/3011)). Carried on the
   * report so `--json` can surface them: `logger.warn` goes to STDERR while the
   * payload goes to STDOUT, and a consumer that captures only stdout — the
   * CI-in-a-pipeline shape, and the one at most risk from the disclosure these
   * advise about — would otherwise never see them.
   *
   * Non-sensitive by construction: every producer interpolates stack / region /
   * logical ids and counts, never a property value or a readback. A producer
   * that cannot promise that must not push here.
   */
  warnings: string[];
  /**
   * The producer-region evidence detection classified this stack's secret
   * references with, reused by `--revert` (go-to-k/cdkd#4213). Region names
   * and a flag only; never printed.
   */
  producerRegions: ProducerRegionEvidence;
}

/**
 * Distinguish "drift detected" (exit 1) from "command crashed" (exit 1
 * via the default handler) so the drift command can fail fast and the
 * top-level handler doesn't add a stack trace for the expected case.
 *
 * Carries no message of its own — the command body printed the report
 * before throwing, so the handler suppresses the duplicate `error()`.
 */
export class DriftDetectedError extends CdkdError {
  readonly silent: boolean = true;

  constructor() {
    super('drift detected', 'DRIFT_DETECTED');
    this.name = 'DriftDetectedError';
    Object.setPrototypeOf(this, DriftDetectedError.prototype);
  }
}

/**
 * Detection found NO drift, but at least one resource's comparison did not
 * happen for a reason the user can ACT ON: cdkd deliberately refused to resolve
 * its secret-bearing properties (issue #2108), or the read / comparison itself
 * threw (issues [#2151](https://github.com/go-to-k/cdkd/issues/2151) /
 * [#1945](https://github.com/go-to-k/cdkd/issues/1945)).
 *
 * The class was `DriftComparisonRefusedError` while `refused` was the only
 * clearable cause. `readFailed` joins it on exactly the property the scoping
 * argument below turns on -- actionable and clearable on a re-run -- so it takes
 * the same exit code rather than a fourth one, and the name now states the
 * CONDITION rather than one of its causes.
 *
 * SCOPED TO THE CLEARABLE CAUSES, not to everything the report calls
 * `notCompared`. The roll-up also contains resources whose only problem is a
 * surviving `{{resolve:...}}` token cdkd resolves for nobody — a look-alike
 * spelling, since issue #2482 moved `ssm-secure` onto the `ssm` path — which
 * can never clear on a re-run, and which this change did not create. Exiting
 * non-zero for them would break `cdkd drift` in CI forever over an unrelated
 * defect, so the exit reads `refused` and `readFailed` while the report covers
 * all three. See `NotComparedCause` and `outcomeExitSignal`.
 *
 * WHY A NON-ZERO EXIT, and why it is a PRESERVATION rather than a new signal.
 * Pre-#2108 that population resolved the reference in the WRONG region, the
 * baseline could never equal what AWS held, and the resource was reported
 * `drifted` -- so `cdkd drift` exited 1 and every CI gate keyed on the exit code
 * fired. #2108 correctly stopped comparing against a foreign region's plaintext,
 * which made the same population report `notCompared`; without this the
 * command would exit 0 and print `no drift detected` for a stack whose
 * secret-bearing properties were never looked at. Round 1 of that change
 * surfaced the refusal in `--json` (`notCompared`) and in the human report,
 * but the exit code -- the
 * signal most CI gates actually read -- still said "pass".
 *
 * WHY EXIT 2 RATHER THAN 1. `2` is this repo's established "work completed but
 * something was SKIPPED" code (`cdkd destroy` / `cdkd deploy` / `cdkd rollback`,
 * and this command's own `--revert` partial failure), and the three outcomes are
 * genuinely distinct: nothing drifted and everything was compared (0), drift was
 * detected (1), nothing drifted but the comparison was incomplete (2). Drift
 * WINS when both hold -- a drifted resource is the stronger, actionable signal
 * and keeps exiting 1 exactly as it does today.
 *
 * SCOPE: detection-only mode. `--accept` / `--revert` keep their documented exit
 * codes (an `--accept` that refuses a secret-bearing property still exits 0, and
 * a partially-failed `--revert` still exits 2 through `PartialFailureError`) --
 * those modes report per-resource refusals on their own paths, and changing them
 * would alter what a remediation run means, which is not what this closes.
 * Issue [#2208](https://github.com/go-to-k/cdkd/issues/2208) re-examined that
 * scoping and KEPT it: what those modes owed was not this exit code but an
 * honest SENTENCE, since their no-drift line claimed a clean bill of health for
 * a stack they had not read. See {@link incompleteRemediationMessage}.
 *
 * WHAT DOES NOT TRIGGER IT: a stack whose properties carry a `{{resolve:...}}`
 * spelling cdkd resolves for nobody still exits 0. Those properties genuinely
 * are not compared and the report says so, but nothing REFUSED them — cdkd has
 * never resolved that spelling — so the condition is permanent, unclearable by
 * any action the user can take, and predates this change. It is reported as
 * information and kept out of the exit code. (`ssm-secure` was that spelling
 * when this was written; since issue #2482 it resolves like `ssm`, and a
 * lookup that fails for it lands with the other resolution failures, not
 * here.)
 *
 * Carries no message of its own for the same reason {@link DriftDetectedError}
 * does -- the report was already printed.
 */
export class DriftComparisonIncompleteError extends CdkdError {
  readonly silent: boolean = true;
  readonly exitCode: number = 2;

  constructor() {
    super('drift comparison incomplete', 'DRIFT_COMPARISON_INCOMPLETE');
    this.name = 'DriftComparisonIncompleteError';
    Object.setPrototypeOf(this, DriftComparisonIncompleteError.prototype);
  }
}

/**
 * Every outcome on one report that cdkd did not FULLY compare -- the
 * `notCompared` variant, plus a `drifted` one whose `notComparedCause` is set
 * (issues #2108 / #2135).
 *
 * ONE spelling, because TWO renderings must agree about the same run: the
 * `--json` `notCompared` roll-up and the human report's `PARTIALLY compared`
 * block (whose count is also what the `N of M fully checked` line subtracts).
 * A roll-up spelled per reader is how the payload and the human summary come to
 * disagree.
 *
 * Since issues #2151 / #1945 the roll-up is NOT all "partially" compared: a
 * `readFailed` member had nothing compared at all. Both renderings say so per
 * entry via {@link notComparedReason}; this predicate stays the single spelling
 * of "was the comparison complete", which is the question both still ask.
 *
 * The EXIT CODE deliberately does NOT read this — see {@link outcomeExitSignal}
 * and {@link NotComparedCause} for why it is scoped to the clearable causes.
 *
 * Returns the CAUSE beside each outcome rather than leaving readers to re-derive
 * it. This function is where the invariant is established — a `drifted` outcome
 * is admitted only when its optional `notComparedCause` is set — and at the type
 * level that field stays optional on the variant, so every reader that wants the
 * cause otherwise needs a `?? <something>` fallback for a case this filter has
 * already excluded. One such fallback is one unreachable default that is wrong
 * if it is ever reached; issues #2151 / #1945 added a reader that needs the
 * cause (the `--json` entry), so the invariant is carried instead of restated.
 */
export function notComparedOutcomes(
  report: StackDriftReport
): Array<{ outcome: NotComparedOutcome; cause: NotComparedCause }> {
  return report.outcomes.flatMap((o) =>
    matchOutcome<Array<{ outcome: NotComparedOutcome; cause: NotComparedCause }>>(o, {
      // The changes a drifted resource reports are real, but when a cause is set
      // they are not the WHOLE comparison, so it belongs in the roll-up too.
      drifted: (d) =>
        d.notComparedCause === undefined ? [] : [{ outcome: d, cause: d.notComparedCause }],
      notCompared: (n) => [{ outcome: n, cause: n.notComparedCause }],
      // `clean` means compared-and-matched and nothing else — that is the
      // guarantee #2135 bought by making `notCompared` a variant.
      clean: () => [],
      // Never compared either, but for a reason that has nothing to do with a
      // dynamic reference: reported under their own headings so the
      // `PARTIALLY compared` block stays about references.
      unsupported: () => [],
      skipped: () => [],
      // AWS ANSWERED for a deleted resource — it said the resource is gone —
      // so it was compared, and it is reported as drift (go-to-k/cdkd#4283).
      deleted: () => [],
    })
  );
}

/**
 * What one outcome contributes to the run's EXIT CODE (issues #2108 / #2135).
 *
 * The exit-code CONSUMER, kept as an exhaustive `matchOutcome` so a new outcome
 * variant cannot inherit `none` by omission — reporting a resource cdkd never
 * compared as a pass is precisely the round-2 defect #2135 exists to make
 * impossible.
 *
 * `incomplete` is a STRICT SUBSET of what {@link notComparedOutcomes} rolls up,
 * and the asymmetry is the point: the REPORT covers everything that was not
 * compared, because as information every cause matters equally, while the exit
 * code covers only the CLEARABLE ones — `refused` (the population #2108 created)
 * and `readFailed` (issues #2151 / #1945). Exiting non-zero on
 * `unresolvedToken` would break `cdkd drift` in CI forever for every stack
 * holding such a spelling — permanent, unclearable, and unrelated. See
 * {@link NotComparedCause}.
 *
 * A `drifted` outcome reports `drifted` even when its own comparison was
 * refused: drift is the stronger, actionable signal and the caller ranks it
 * first, so a consumer gating on `1` loses nothing it gets today.
 */
export function outcomeExitSignal(outcome: DriftOutcome): 'drifted' | 'incomplete' | 'none' {
  return matchOutcome<'drifted' | 'incomplete' | 'none'>(outcome, {
    drifted: () => 'drifted',
    // Issues #2151 / #1945: `readFailed` joins `refused` here, and the switch is
    // written as an EXCLUSION of the one permanent cause rather than an
    // inclusion list, so a cause added later defaults to the non-zero side. The
    // default that #2135 made impossible for a VARIANT was still reachable for a
    // CAUSE: an inclusion list would have let `readFailed` inherit `none` by
    // omission, which is the "report a resource cdkd never compared as a pass"
    // failure one level down.
    notCompared: (n) =>
      n.notComparedCause === 'unresolvedToken' || n.notComparedCause === 'noEchoParameter'
        ? 'none'
        : 'incomplete',
    clean: () => 'none',
    // A provider that cannot read a resource back, and a type drift does not
    // apply to, are both pre-existing and permanent — same "unclearable in CI"
    // argument as `unresolvedToken`, and both predate #2108 entirely.
    unsupported: () => 'none',
    skipped: () => 'none',
    // go-to-k/cdkd#4283: a resource deleted outside cdkd is drift — the most
    // important kind — and exits 1 like any other. It used to be folded into
    // `unsupported` above, which is how a CI gate stayed green over it.
    deleted: () => 'drifted',
  });
}

/**
 * Every reason one resource can end a run UNCOMPARED, as a closed set.
 *
 * A superset of {@link NotComparedCause} by exactly the two variants that are
 * not compared for a reason unrelated to a dynamic reference: `unsupported`
 * (no provider implements `readCurrentState` for the type) and `skipped` (drift
 * is not conceptually applicable to the type -- `Custom::*`). The cause type has
 * no member for either because neither is a not-compared CAUSE in the report's
 * sense; they are their own outcome VARIANTS, rendered -- or not -- on their own
 * terms. `unsupported` gets its own `drift unknown` heading; `skipped` gets NO
 * human-report output at all, deliberately (issue
 * [#323](https://github.com/go-to-k/cdkd/issues/323): `Custom::S3AutoDeleteObjects`
 * rides along in most CDK stacks, and a per-run line about it would be noise).
 * It surfaces only inside the #2154 `NOTHING was compared` parenthetical and in
 * `--json`'s `skipped[]`.
 *
 * WHY #323's SILENCE IS DELIBERATELY NOT HONOURED BY
 * {@link incompleteRemediationMessage}, since the next reader will otherwise
 * take that line for a regression of it: #323 is about the DETECTION report,
 * which is a per-resource listing, and there a `Custom::*` entry every run is
 * pure noise. The remediation line is not a listing -- it is a single sentence
 * saying why a command that was asked to CHANGE something changed nothing, and
 * a sentence of that kind has to account for the whole stack or it is back to
 * being quietly reassuring. So `skipped` is COUNTED there, and #323's substance
 * is preserved a different way: it is reported under a heading that makes no
 * uncertainty claim about it (see {@link UNCOMPARED_REASONS}), because "cdkd
 * never drift-checks this type" is a fact about cdkd, not a doubt about the
 * resource. Nothing about the detection report changes.
 */
export type UncomparedReason = NotComparedCause | 'unsupported' | 'skipped';

/**
 * Which of the two claims the line may make about a reason.
 *
 *   - `unknown` -- cdkd TRIED, or would have, and cannot say. The user can act:
 *     grant the permission, respell the ARN, re-run past the throttle.
 *   - `byDesign` -- cdkd was never going to look. There is nothing to act on and
 *     nothing uncertain about it; the resource simply is not in the drift
 *     command's remit.
 */
type UncomparedKind = 'unknown' | 'byDesign';

/**
 * What {@link incompleteRemediationMessage} says about each reason, and WHICH
 * CLAIM it is allowed to make about it.
 *
 * An exhaustive `Record`, for the same reason {@link notComparedReason} is one:
 * adding a cause must be a COMPILE ERROR here rather than falling into an
 * `else` that describes it as something it is not. The first cut of this
 * function had that `else`, and it was worse than a wrong default -- it
 * described any unknown cause as a dynamic-reference problem, while
 * {@link outcomeExitSignal} deliberately routes every NEW cause to the
 * incomplete side. The two together meant the next cause added would be
 * reported, at once, to the widest audience and under the wrong name. Carrying
 * `kind` in the SAME record rather than a second one beside it means a new
 * reason cannot be given a phrase while quietly inheriting a claim.
 *
 * `kind` exists because one blanket tail overclaimed. The line used to end
 * `..., so cdkd does not know whether they drifted`, which is true of a
 * throttled read and FALSE of a `Custom::*` resource -- for that one, issue
 * [#323](https://github.com/go-to-k/cdkd/issues/323)'s position is that drift is
 * not APPLICABLE, not that cdkd is uncertain. A stack with one throttle and five
 * `Custom::S3AutoDeleteObjects` would have claimed uncertainty about all six.
 *
 * The insertion ORDER is the order the phrases are emitted in, so the line is
 * deterministic without a second list to keep in sync: "not compared at all"
 * first, then the partial ones, then the two structural reasons.
 *
 * The wording splits on "was ANY of it compared", which is the same split the
 * human report's `NOT fully compared` heading makes -- a `readFailed` resource
 * is not "partially" anything.
 */
export const UNCOMPARED_REASONS: Record<
  UncomparedReason,
  { kind: UncomparedKind; phrase: string }
> = {
  readFailed: {
    kind: 'unknown',
    phrase: 'not compared AT ALL: the read or comparison failed',
  },
  // Beside `readFailed`, for the reason that one is `unknown`: nothing was read.
  readAborted: {
    kind: 'unknown',
    phrase:
      'not compared AT ALL: never read, because the reads before them in the same stack ' +
      'kept failing',
  },
  // Rendered in two places. The detection report's `NOT fully compared`
  // heading reads it (minus its `not compared AT ALL: ` lead) for every cause
  // that compared nothing. `incompleteRemediationMessage` would too, but under
  // `--accept` / `--revert` a record holding an unreadable entry is REFUSED
  // before any outcome exists (go-to-k/cdkd#3018), so that path never tallies
  // this cause.
  unreadableRecord: {
    kind: 'unknown',
    phrase: 'not compared AT ALL: their state record is not readable as a resource',
  },
  // Beside `unreadableRecord`, for the same reason that one says nothing here.
  unreadableMap: {
    kind: 'unknown',
    phrase: "not compared AT ALL: the record's whole 'resources' map is not readable",
  },
  // `unknown`, beside `readFailed`, because NONE of the resource's properties
  // were compared — it is not "partially" anything (issue #2952).
  baselineRefused: {
    kind: 'unknown',
    phrase: 'not compared AT ALL: a `cdkd import` run refused to capture their observed baseline',
  },
  refused: {
    kind: 'unknown',
    phrase:
      'only PARTIALLY compared: cdkd refused to resolve a dynamic reference their state records',
  },
  uncertifiedBaseline: {
    kind: 'unknown',
    phrase:
      'only PARTIALLY compared: their recorded baseline holds the redaction mask where cdkd ' +
      'could not tell which live value a secret reference became',
  },
  unresolvedToken: {
    kind: 'unknown',
    phrase:
      'only PARTIALLY compared: their state records a `{{resolve:...}}` spelling cdkd resolves ' +
      'for nobody, which no re-run can clear',
  },
  noEchoParameter: {
    kind: 'unknown',
    phrase:
      'only PARTIALLY compared: their state holds a NoEcho parameter value only as the ' +
      'redaction mask, which no re-run can clear',
  },
  unsupported: {
    kind: 'byDesign',
    phrase: 'not compared AT ALL: their provider does not support drift detection yet',
  },
  skipped: {
    kind: 'byDesign',
    phrase: 'not compared AT ALL: cdkd does not drift-check the type',
  },
};

/**
 * Was ANY of the resource's properties compared?
 *
 * A THIRD exhaustive record beside {@link notComparedReason}'s and
 * {@link UNCOMPARED_REASONS}, and it exists because this question was answered
 * THREE times by a hand-written `readFailed` / `baselineRefused` cause list —
 * the summary parenthetical and the block heading, and `--json`'s
 * `referencesUnresolved`. Hand lists of one growing union are how a new cause
 * comes to be described as something it is not, which is exactly what those
 * sites' own comments say happened when `baselineRefused` was added.
 * go-to-k/cdkd#3018 added a further cause and every list was silently wrong
 * again, reporting an unreadable record as "only PARTIALLY compared" and as
 * `referencesUnresolved: true` — understating it in the reassuring direction,
 * the one failure mode the comments name. All three readers take this record.
 *
 * `false` means none of it was compared. It is a SEPARATE axis from
 * {@link UncomparedKind}, which asks whether cdkd is uncertain or simply does
 * not cover the type; a `skipped` resource is `byDesign` and also had nothing
 * compared, and collapsing the two would make one of the answers wrong.
 */
export const ANY_OF_IT_COMPARED: Record<NotComparedCause, boolean> = {
  refused: true,
  unresolvedToken: true,
  uncertifiedBaseline: true,
  noEchoParameter: true,
  readFailed: false,
  readAborted: false,
  baselineRefused: false,
  unreadableRecord: false,
  unreadableMap: false,
};

/**
 * The sentence lead each {@link UncomparedKind} group is reported under.
 *
 * Exhaustive for the same reason `UNCOMPARED_REASONS` is, and SEPARATE from it
 * because the lead is per GROUP while the phrase is per reason: writing the
 * claim into each phrase would put five copies of two sentences in the file,
 * and five copies is how two of them come to disagree.
 *
 * Insertion order is emit order, and `unknown` comes first deliberately: it is
 * the half the user can do something about.
 */
const UNCOMPARED_KIND_LEADS: Record<UncomparedKind, string> = {
  unknown: 'cdkd does not know whether these drifted',
  byDesign: 'Not drift-checked by cdkd at all, which is a coverage limit rather than uncertainty',
};

/**
 * How many resources across every report ended UNCOMPARED, per reason.
 *
 * The `notCompared` population is read through {@link notComparedOutcomes} --
 * the single spelling both renderings already share -- and the other two come
 * from an exhaustive `matchOutcome`, so a new outcome variant cannot join the
 * "nothing to say about it" side by omission. That is the same guarantee
 * {@link outcomeExitSignal} carries at the exit code, applied to the count.
 */
function uncomparedTally(reports: StackDriftReport[]): Map<UncomparedReason, number> {
  const tally = new Map<UncomparedReason, number>();
  const bump = (reason: UncomparedReason): void => {
    tally.set(reason, (tally.get(reason) ?? 0) + 1);
  };
  for (const report of reports) {
    for (const { cause } of notComparedOutcomes(report)) {
      bump(cause);
    }
    for (const outcome of report.outcomes) {
      matchOutcome<void>(outcome, {
        drifted: () => {},
        clean: () => {},
        // Counted above, through the shared spelling rather than a second one.
        notCompared: () => {},
        unsupported: () => bump('unsupported'),
        skipped: () => bump('skipped'),
        // Compared — AWS answered that it is gone — so not an uncompared reason.
        deleted: () => {},
      });
    }
  }
  return tally;
}

/**
 * The lines `--accept` / `--revert` print INSTEAD of `No drift detected --
 * nothing to accept.` when the run found no drift but did not manage to compare
 * everything ([issue #2208](https://github.com/go-to-k/cdkd/issues/2208)).
 *
 * MESSAGE-ONLY, and the EXIT CODE deliberately stays `0`. The remediation
 * modes' exit codes are a documented user contract -- #2108 scoped its `2` to
 * detection-only mode on purpose, and {@link DriftComparisonIncompleteError}'s
 * note says why: "changing them would alter what a remediation run means".
 * Nothing about that reasoning expired. The defect this closes is entirely in
 * what the run REPORTS: `--accept` / `--revert` already correctly leave an
 * uncompared resource alone (both iterate the drifted outcomes only, asserted
 * in `tests/unit/cli/drift-per-resource-failure.test.ts`), so the state and AWS
 * are right and only the sentence is wrong. Making the remediation path exit
 * non-zero would break the CI of everyone running `cdkd drift --accept` over a
 * stack that hits a throttle, to fix a wording problem.
 *
 * What the lines have to carry, since the exit code will not carry it: that the
 * comparison was INCOMPLETE (never that no drift was detected), HOW MANY
 * resources were not compared and WHY, WHICH of those cdkd is actually
 * uncertain about, and the pointer to the detection-only run, which is the mode
 * whose exit code does report it (`2`).
 *
 * THE TRIGGER AND THE COUNT ARE DIFFERENT POPULATIONS, deliberately, and
 * collapsing them is the defect review round 1 found here.
 *
 *   - The TRIGGER is `anyIncomplete`, i.e. {@link outcomeExitSignal}'s
 *     `incomplete`. It is narrow on purpose: a stack whose ONLY uncompared
 *     resource holds a `{{resolve:...}}` token cdkd resolves for nobody must
 *     not start shouting on every run about a comparison no action of the
 *     user's can ever complete -- the same CI-forever hazard that cause is
 *     kept out of the exit code on.
 *   - The COUNT and the LABELS, once the line is triggered, cover EVERY
 *     uncompared resource, each named by its own reason (see
 *     {@link uncomparedTally}). A resource that was not compared was not
 *     compared, whatever the reason, and counting only the clearable ones
 *     printed `1 of 3` on a stack the report a few lines above called
 *     `2 resource(s) NOT fully compared` -- two lines disagreeing about one
 *     run, with the newer and quieter one being the one written to stop a
 *     command from being quietly reassuring.
 *
 * WHAT `N` AND `M` ARE, stated because the alternatives are all defensible and
 * silence about the choice is what made the first cut wrong. `M` is the total
 * number of resource outcomes, and `N` is every one of them that was not
 * compared -- so `unsupported` and `skipped` land in `N`, WITH their own
 * phrase, rather than sitting only in the denominator where they would inflate
 * `M` and go unnamed. On a remediation path, erring LOUD is the correct
 * direction. Note this makes `N` deliberately WIDER than the report's
 * `NOT fully compared` heading, which counts the reference / read population
 * only and reports `drift unknown` separately: the question this line answers
 * is #2154's, "was everything actually compared", not "how many entries are in
 * that block". What being in `N` does NOT buy is a uniform claim about the
 * resource -- see {@link UNCOMPARED_REASONS}'s `kind`, and see
 * {@link UncomparedReason} for why counting a `skipped` resource here is not a
 * reversal of #323's silence.
 */
export function incompleteRemediationMessage(
  reports: StackDriftReport[],
  mode: 'accept' | 'revert'
): string[] {
  const tally = uncomparedTally(reports);
  const total = reports.reduce((n, report) => n + report.outcomes.length, 0);
  const uncompared = [...tally.values()].reduce((a, b) => a + b, 0);
  // Both loops iterate their record's own keys, so emit order is fixed and a
  // new reason or kind cannot be left out of the rendering by a list nobody
  // updated.
  const kinds = Object.keys(UNCOMPARED_KIND_LEADS) as UncomparedKind[];
  const reasons = Object.keys(UNCOMPARED_REASONS) as UncomparedReason[];
  const groups = kinds.flatMap((kind) => {
    const parts = reasons
      .filter((reason) => UNCOMPARED_REASONS[reason].kind === kind && (tally.get(reason) ?? 0) > 0)
      .map((reason) => `${tally.get(reason)} ${UNCOMPARED_REASONS[reason].phrase}`);
    return parts.length === 0 ? [] : [`${UNCOMPARED_KIND_LEADS[kind]} — ${parts.join('; ')}.`];
  });
  return [
    `Comparison INCOMPLETE — nothing to ${mode}, and that is NOT a clean bill of health: ` +
      `${uncompared} of ${total} resource(s) could not be compared.`,
    ...groups,
    `Re-run '${cdkdRemedy('cdkd drift')}' without --${mode} to see which resources and why — a detection-only ` +
      `run exits 2 while a comparison is incomplete.`,
  ];
}
