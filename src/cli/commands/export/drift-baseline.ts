import {
  cdkdRemedy,
  pasteableCommand,
  type CommandArg,
  type PasteableCommand,
  SHELL_ACTIVE_WHY,
  proseQuoted,
} from '../../../utils/pasteable-command.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  hasReadableResources,
  isReadableResourceEntry,
  malformedResourcesWarning,
  displayLogicalId,
  JSON_LISTING_HOLE_VALUE,
  SHORT_NAME_MAX_CODE_POINTS,
  accountArgs,
  withheldAccountClause,
} from '../../../state/malformed-resources-bag.js';
import { getLogger } from '../../../utils/logger.js';
import { refusedBaselineRemedy } from '../refused-baseline-remedy.js';
import { resourcesNamingDeclaredParameter } from '../../../analyzer/parameter-dependence.js';
import { type LockRecoveryContext } from '../../../state/lock-contention-message.js';
import {
  hasUnverifiableParameterRefusal,
  type ResourceState,
  type StackState,
} from '../../../types/state.js';

/**
 * How many logical ids each of this advice's three lists names before it stops
 * and counts the rest.
 *
 * ONE constant for all three because they are one decision — how long a warning
 * block may get before it stops being read — and three hand-spelled `10`s are
 * how two of them end up disagreeing after a later edit. Its siblings are
 * `UNREADABLE_PREVIEW_NAMES` in `diff-recursive.ts` (the `cdkd diff` preview)
 * and `NAMED_UNREADABLE_ENTRIES` in the shared module (the refusal texts);
 * deliberately not shared with either, since a list inside one warning line and
 * a block of indented rows do not have the same budget.
 */
const NAMED_BASELINE_IDS = 10;

/**
 * The sentence `reportDriftBaselineGaps` prints in place of a withheld
 * `cdkd state refresh-observed`, rendered from the gate's REASON so the prose
 * and the hole cannot disagree (M3 of the go-to-k/cdkd#3764 review). Keyed on
 * the FIRST value the gate refused — the stack name before the region, the
 * gate's own order — and named as that value, and exhaustive over
 * `WithholdReason` so a new reason is a compile error here rather than a
 * silently borrowed sentence. Not `withheldTargetClause`: that sentence is
 * about a record's NAME alone and points at `cdkd state list --long`, and this
 * one has to speak of the region too.
 */
function refreshWithheldReason(built: PasteableCommand): string {
  const first = built.withheld[0];
  // `exact` is false with nothing refused only when a caller asked for a bare
  // hole, which the report never does; the exactness sentence is the
  // conservative one should a future caller do so.
  const what = first?.hole === 'region' ? "this stack's region" : "this stack's name";
  const reason = first?.reason;
  switch (reason) {
    case 'option-shaped':
      // Only the stack name is a positional Commander could read as the
      // option; the region is `--stack-region`'s value, taken as given, so its
      // sentence says only that cdkd refuses it (go-to-k/cdkd#4036).
      return first?.hole === 'region'
        ? `${what} starts with '-', which no AWS region does, so cdkd does not put it in a ` +
            `command that rewrites a record.`
        : `${what} starts with '-', which cdkd refuses rather than risk the CLI reading it as ` +
            `an option however it is quoted ('--all' would rewrite every record in the region ` +
            `rather than this one).`;
    case 'not-plain':
      return (
        `${what} is not a plain identifier (a letter or digit, then letters, digits, '~', ` +
        `'_', '.' or '-'), the only shape named in a command here, since a name outside it ` +
        `can run as shell or read as a line of this message once the terminal wraps.`
      );
    // Unreachable: `refArgs` passes `plainIdent`, which answers `not-plain` for
    // every value this arm would take; answered on purpose, as `pattern-shaped`
    // is below.
    case 'shell-active':
      return `${what} ${SHELL_ACTIVE_WHY}.`;
    case 'pattern-shaped':
      // Unreachable — `refArgs` passes no `patternMatched`, since this
      // command resolves by exact name — and answered on purpose, because the
      // reason is the gate's and a caller passing that option would otherwise
      // borrow a sentence that is false of it.
      return `${what} carries a '*' or '/', which cdkd refuses as a pattern character.`;
    case 'altered':
    case 'empty':
    case 'too-long':
    case undefined:
      return (
        `${what} as cdkd loaded it cannot be rendered exactly, and a near-match could ` +
        `rewrite a different stack's baseline.`
      );
    default: {
      const _exhaustive: never = reason;
      throw new Error(`refreshWithheldReason: unhandled WithholdReason ${String(_exhaustive)}`);
    }
  }
}

/**
 * Pre-flight check for missing drift baselines (`observedProperties`)
 * in the exporting stack's state. cdkd state schema v3 captures
 * `observedProperties` on every successful create / update / import so
 * `cdkd drift` has a reliable AWS-current baseline. Resources written
 * by an older binary OR by providers that do not implement
 * `readCurrentState` lack the field, and `cdkd drift` falls back to
 * comparing against the user's template intent (weaker signal).
 *
 * If we are about to migrate to CFn, the user has no way to roll back
 * post-migration — any drift between cdkd state and AWS reality would
 * surface as spurious changes on the first post-export `cdk deploy`.
 * Warn loudly so the user can run `cdkd state refresh-observed` and
 * `cdkd drift` first if they care. Non-blocking by design — exit is the
 * user's call, not the tool's.
 *
 * Exported for unit testing.
 */
export function reportDriftBaselineGaps(
  state: StackState,
  logger: ReturnType<typeof getLogger>,
  /**
   * The stack and region export actually LOADED — the S3 key, not the record
   * body. Every command this report suggests is built from it: `stackName` and
   * `region` inside the body are hand-editable fields of a record this report
   * may already be calling broken, and `cdkd state refresh-observed` WRITES,
   * so a body saying `"stackName": "OtherStack"` must not send the user to
   * rewrite a different record. The REGION half is belt-and-braces on the
   * region-scoped read since go-to-k/cdkd#3369, whose `adoptKeyRegion` replaces
   * a divergent body region with the key's before any caller sees it — the
   * stack NAME is not normalised there, and a legacy record bypasses it
   * entirely. Optional only so the unit cases can omit it; both command call
   * sites pass it, and without it the body is the fallback.
   */
  loaded?: { stackName: string; region: string | undefined },
  /**
   * The template the CDK app synthesized, which the next deploy reads too —
   * never a `--template` file. It classifies a REASON-LESS refused baseline
   * exactly (issue #3465); without it that class keeps the hedged remedy.
   */
  template?: Record<string, unknown>,
  /**
   * The run's account flags, carried on every command this report prints: the
   * unreadable-bag warning's `cdkd state show` pointer (go-to-k/cdkd#4159) and
   * the baseline-gap `cdkd state show` / `cdkd state refresh-observed` commands
   * (go-to-k/cdkd#4648) — the latter WRITES, so a paste must reach this bucket.
   */
  recovery?: LockRecoveryContext
): void {
  const stackName = loaded?.stackName ?? state.stackName;
  // A region is only a region if it is a NON-EMPTY string, and the guard is
  // kept although no read path delivers either shape today: `adoptKeyRegion`
  // (go-to-k/cdkd#3369) replaces a divergent body region with the key's and
  // `tryGetLegacy` drops a non-string one, while both call sites pass
  // `undefined` rather than `''` for a legacy record (`migrationPending`). What
  // it costs is one comparison; what it buys is that a caller passing the body,
  // or a fourth call site forgetting the legacy arm, renders no
  // `--stack-region` that selects no record — `''` sanitizes to the
  // `<unrenderable>` stand-in.
  const rawRegion: unknown = loaded ? loaded.region : state.region;
  const region = typeof rawRegion === 'string' && rawRegion !== '' ? rawRegion : undefined;
  // The BAG first, and ahead of the empty-record return below. `Object.entries`
  // of a string yields one pair per CHARACTER, so enumerating entries without
  // asking whether the bag IS one would report rows named `0`, `1`, `2` — the
  // fabrication class go-to-k/cdkd#3172 and go-to-k/cdkd#3187 closed elsewhere,
  // re-opened inside a message whose whole job is to name real rows. And it has
  // to precede that return rather than follow it: `null`, a number, a boolean,
  // an empty string and an empty list all enumerate to NO entries, so a guard
  // placed after `entries.length === 0` is reached only by a non-empty string or
  // a populated list, and every other unreadable bag passes in silence.
  // `unreadableResourceEntries` refuses a non-object bag for the same reason;
  // this site partitions rather than delegating, so it makes the same test
  // itself.
  if (!hasReadableResources(state)) {
    logger.warn(malformedResourcesWarning(stackName, region, recovery));
    return;
  }
  const entries = Object.entries(state.resources);
  if (entries.length === 0) return;

  // Every command BUILT HERE names the stack AND its region, and is emitted
  // LAST and UNWRAPPED — the shape `src/state/lock-contention-message.ts`
  // requires of anything a user is meant to paste: `shellQuote` does its own
  // quoting, so an outer `'...'` composes into something unpastable for exactly
  // the names that need quoting. The region is what makes the command address
  // THIS record when the same stack name holds state in several regions. With
  // no region to name (a pre-v2 record, or a body whose `region` is not a
  // string) the flag is left out rather than filled with a placeholder, which
  // every one of these commands would reject. The BAG
  // warning above is the exception to "last": its text comes from the shared
  // module, which appends a sentence after the command, and follows the same
  // no-region rule there.
  // Built by the SHARED gate since go-to-k/cdkd#3436's fold-in, ONE argument
  // list for the two commands rendered here, so they cannot disagree about a
  // name. Both values are held to `plainIdent`: the `cdkd state show` line
  // sits beside prose, the shape `.claude/rules/state-malformed-containers.md`
  // governs, and exactness alone admits a name with interior padding that
  // spells a labelled line once the terminal wraps (`Prod<60 spaces>Migrate
  // with: cdkd destroy --all --force #`) — the wrap-forge the option exists
  // for, closed here at its one-flag place (M2 of the go-to-k/cdkd#3764
  // review). Real CDK names pass `isPasteableIdent`. The region keeps its own
  // cap through `maxCodePoints`: a region is displayed at 128 (`safeRegion`)
  // everywhere cdkd shows one, and the gate's default is the 1152 stack-name
  // cap, so without it this report would NAME a 200-character region in full
  // in a command while every display of it is cut (the rule file's "borrowing
  // a gate UPWARD").
  const refArgs: readonly CommandArg[] =
    region === undefined
      ? [{ value: stackName, hole: 'stack', opts: { plainIdent: true } }]
      : [
          { value: stackName, hole: 'stack', opts: { plainIdent: true } },
          {
            flag: '--stack-region',
            value: region,
            hole: 'region',
            opts: { plainIdent: true, maxCodePoints: SHORT_NAME_MAX_CODE_POINTS },
          },
        ];

  // The one command here that WRITES prints ONLY when the gate named both
  // values — keyed on the gate's own verdict, not on a local re-spelling of
  // it (M3 of the go-to-k/cdkd#3764 review: a re-spelling let the region's
  // `maxCodePoints` hole print as `--stack-region '<region>'` with no sentence
  // saying why). `cdkd state show` only reads, so it is printed for every name
  // the gate can render, with a hole where it could not: a near-miss there at
  // worst DISPLAYS another stack's record, which the reader can see. `cdkd
  // state refresh-observed` locks a record and rewrites its
  // `observedProperties`, so a name that sanitizing CHANGED — a non-breaking
  // space where the real stack has an ordinary one, a control byte, a cut at
  // the cap — can resolve to a DIFFERENT stack that exists and rewrite that
  // stack's baseline. The same reasoning `buildForceUnlockCommand` applies to
  // a lock it would delete: when any value is withheld, the command is
  // withheld and the advice names the command in prose instead, with the
  // sentence rendered from the gate's REASON so the two cannot disagree.
  //
  // The option-shaped reason is the second half of the rule the legacy
  // refusal in `state.ts` states: shell quoting does not stop Commander from
  // parsing `'--all'` as the `--all` FLAG, and on this command that flag targets
  // every record in the region — so a stack named `--all` would print a command
  // that rewrites every baseline instead of the one the sentence names. A name
  // a prebuilt cloud assembly supplies is unvalidated (`extractStackInfo` takes
  // `props?.stackName || artifactId`), so this is reachable, not theoretical;
  // the region is read raw off the state body, so `--stack-region --all` is
  // too. Only the LEADING `-` half of that sibling's test applies here, and the
  // difference is the command, not the caution: `cdkd deploy` reads its
  // argument as a PATTERN, while `cdkd state refresh-observed` resolves it by
  // exact name equality (`r.stackName === stackName`), so a `*` or `/` selects
  // at most the one record literally named that — it cannot widen the target
  // the way a pattern does, and `patternMatched` is deliberately NOT passed.
  //
  // A record with NO region is withheld too, for a different reason:
  // `cdkd state refresh-observed` refuses a legacy region-less record outright,
  // so a command for one could only fail. The advice says to migrate first.
  // The IDENTITY verdict decides whether a command is offered; the run's
  // account flags then ride on it (go-to-k/cdkd#4648), so the pasted WRITE
  // reaches the bucket this export read. An account hole is explained by its
  // own sentence, never by the identity one.
  const account = accountArgs(recovery);
  const accountNote = (where: string): string => withheldAccountClause(recovery, where);
  const refresh = pasteableCommand('cdkd state refresh-observed', refArgs);
  const refreshCommand =
    region !== undefined && refresh.exact
      ? pasteableCommand('cdkd state refresh-observed', [...refArgs, ...account]).command
      : undefined;
  const refreshNote =
    refreshCommand === undefined ? '' : accountNote('the command at the end of this line prints');
  const refreshWithheld =
    region === undefined
      ? `'cdkd state refresh-observed' for this stack once it is migrated: this record has ` +
        `no region, the legacy layout that command refuses, so migrate it first with any cdkd ` +
        `write, such as a deploy.`
      : `'cdkd state refresh-observed' for this stack. The command is not printed: ` +
        `${refreshWithheldReason(refresh)}`;

  // go-to-k/cdkd#3018. An ENTRY that is not a readable object is a different
  // shape from the unreadable BAG tested above, and `r.observedProperties` on
  // one threw a bare `TypeError` naming no stack, no key and no remedy.
  //
  // Several shapes reach here, and none is the obvious one. `buildImportPlan`
  // runs first and blocks a TEMPLATE row whose `state.resources[logicalId]` is
  // falsy or carries no physical id, so an ordinary templated resource with a
  // `null` entry aborts the export earlier with that far better message. What
  // survives is a templated OBJECT row that has a physical id but no resource
  // type (planned from the template's type, and still named here — except an
  // `AWS::CloudFormation::Stack` row, whose branch requires the recorded type
  // and blocks it), plus every row that
  // loop `continue`s BEFORE it reads the state entry, plus every row it never
  // visits: an entry the template does not declare at all (a stale row from a
  // rename or a hand edit), an `AWS::CDK::Metadata` row (short-circuited at the
  // top of the loop), and a `Custom::*` or `AWS::CloudFormation::CustomResource`
  // row (routed to `phase2Creates`). The list is derived from that loop's own
  // `continue`s rather than enumerated by hand — a type added to it later joins
  // this set silently.
  //
  // TOLERATED rather than refused, the opposite call from `cdkd state
  // refresh-observed`'s on the same shape, decided by what refusing would COST
  // here: this function is a non-blocking pre-flight WARNING (its own doc says
  // exit is the user's call), and a throw would replace the export flow's own,
  // better-worded refusals with a message about a baseline report. It does NOT
  // follow that something else refuses these shapes — nothing does for an entry
  // the template never declares, since `walkCdkdStateStackTree` skips a
  // non-nested entry with `entry?.` and its bag guard returns rather than throws.
  // Naming them is therefore the only signal the record is broken, which is why
  // the warning names ids rather than counting them.
  const readable = entries.filter((entry): entry is [string, ResourceState] =>
    isReadableResourceEntry(entry[1])
  );
  const unreadableCount = entries.length - readable.length;
  if (unreadableCount > 0) {
    const inspect = pasteableCommand('cdkd state show', refArgs);
    const inspectCommand = pasteableCommand('cdkd state show', [
      ...refArgs,
      { literal: '--json' },
      ...account,
    ]).command;
    const unreadable = entries
      .filter(([, r]) => !isReadableResourceEntry(r))
      .map(([logicalId]) => logicalId);
    logger.warn(
      `${unreadable.length} of ${entries.length} resource(s) in cdkd state have a record that is ` +
        `not readable as a resource — not an object, or carrying no resource type — so their ` +
        `drift baseline cannot be reported on. The state record is malformed or truncated. ` +
        // A hole in a READ command still needs saying, and it is said BEFORE
        // the command so the command stays last and pasteable: an operator
        // handed `'<region>'` with no reason fills it from whatever is
        // nearest, and prose after the command is what a paste picks up.
        // A stack name beginning with `-` is never to be filled back in, keyed
        // on the RAW `-` as `inspectClause` in malformed-resources-bag.ts is:
        // the gate may report `altered` / `too-long` first, and Commander
        // reads a shell-quoted `'--all'` in `cdkd state show`'s positional as
        // the option (go-to-k/cdkd#4036). A region hole stays fillable — it is
        // `--stack-region`'s value, which Commander takes as given.
        (inspect.exact
          ? ''
          : `A quoted '<...>' hole in the command after the list below stands for a value cdkd could not ` +
            (stackName.startsWith('-')
              ? `print safely. This stack name begins with '-', which the CLI could read as an ` +
                `option however it is quoted, so do not fill the stack hole with it: repair or ` +
                `remove the record by hand. `
              : `print safely; fill it from 'cdkd state list --json'` +
                // The listing reads this run's bucket only with the same flags
                // (go-to-k/cdkd#4648 review).
                (account.length > 0
                  ? ` run with the same account flags as the command after the list below`
                  : '') +
                `, replacing the hole, quotes included, with ${JSON_LISTING_HOLE_VALUE}. `)) +
        // Not "cannot be migrated": a TEMPLATED row that is an object with a
        // physical id but no resource type clears `buildImportPlan`'s
        // `!stateEntry.physicalId` block and is planned from the template's own
        // type, so that claim would contradict the plan printed beside it.
        accountNote('the command after the list below prints') +
        `Inspect it with the command after the list below.`
    );
    for (const logicalId of unreadable.slice(0, NAMED_BASELINE_IDS)) {
      logger.warn(`  ${displayLogicalId(logicalId)}`);
    }
    if (unreadable.length > NAMED_BASELINE_IDS) {
      logger.warn(`  ... and ${unreadable.length - NAMED_BASELINE_IDS} more`);
    }
    // On a labelled line of its OWN — its own `warn`, so no message carries a
    // newline for a value to imitate — rather than ending the prose line (the
    // go-to-k/cdkd#3764 follow-up recorded on go-to-k/cdkd#3436): last on that
    // line it was inert, but a shell-quoted value sharing a line with prose is
    // the shape an apostrophe earlier on that line turns inside out. AFTER the
    // id rows, so they do not read as hanging off the command (m2 of the
    // go-to-k/cdkd#4011 review).
    logger.warn(safeMsg`Inspect it with: ${inspectCommand}`);
  }

  const missing = readable.filter(([, r]) => r.observedProperties === undefined);
  if (missing.length === 0) return;
  if (state.version !== undefined && state.version < 3) {
    logger.warn(
      `cdkd state schema is v${state.version} (pre-observedProperties). cdkd drift ` +
        `cannot reliably compare against AWS for this stack; the next 'cdk deploy' ` +
        `after migration may surface spurious changes if AWS has drifted from the ` +
        // Same conditional as the v3+ branch below, and for the same reason: a
        // pre-v3 record can hold an unreadable entry too, and
        // `cdkd state refresh-observed` refuses the WHOLE record over one. An
        // earlier cut applied the condition to one branch only, so the legacy
        // half kept recommending a command that declines.
        (unreadableCount > 0
          ? `template. Repair the ${unreadableCount} unreadable record(s) named above first — ` +
            `'cdkd state refresh-observed' refuses a record that holds one — then capture an ` +
            `AWS-current baseline before export.`
          : `template. ${refreshNote}Capture an AWS-current baseline before export — any redeploy does ` +
            (refreshCommand !== undefined
              ? `it, or run: ${refreshCommand}`
              : `it, or run ${refreshWithheld}`))
    );
    return;
  }
  // Schema v10+ (issue #2944): a REFUSED record also has no
  // `observedProperties`, but `cdkd state refresh-observed` will decline it —
  // so tallying it with the rest would send the user to a command that cannot
  // help and then leave them unable to tell why it did nothing. Split so the
  // advice is true for each half.
  const refused = missing.filter(([, r]) => r.observedBaselineRefused === true);
  const refreshable = missing.filter(([, r]) => r.observedBaselineRefused !== true);

  if (refreshable.length > 0) {
    logger.warn(
      `${refreshable.length} of ${entries.length} resource(s) in cdkd state lack an ` +
        `AWS-current baseline (observedProperties). cdkd drift may produce false positives ` +
        `for them; the next 'cdk deploy' after migration may surface unexpected changes. ` +
        // The advice is CONDITIONAL on the record being readable, because since
        // go-to-k/cdkd#3018 `cdkd state refresh-observed` REFUSES a record that
        // holds an unreadable entry — the whole record, not just that row. Sending
        // the user to a command that will decline is the defect this issue opened
        // with, one command over, so when the warning above fired the remedy is
        // repair first.
        (unreadableCount > 0
          ? `Repair the ${unreadableCount} unreadable record(s) named above first — ` +
            `'cdkd state refresh-observed' refuses a record that holds one. Then capture a ` +
            `baseline and run ${proseQuoted(cdkdRemedy('cdkd drift'))} to verify the stack matches AWS.`
          : refreshCommand !== undefined
            ? `${refreshNote}Capture a baseline before export, then run ${proseQuoted(cdkdRemedy('cdkd drift'))} to verify the stack ` +
              `matches AWS, with: ${refreshCommand}`
            : `Capture a baseline before export with ${refreshWithheld} Then run ` +
              `${proseQuoted(cdkdRemedy('cdkd drift'))} to verify the stack matches AWS.`)
    );
    for (const [logicalId] of refreshable.slice(0, NAMED_BASELINE_IDS)) {
      // Sanitized like the unreadable-entry list above, and for the same
      // reason: these ids come from the same hand-editable record. The two
      // pre-existing loops here were unsanitized before go-to-k/cdkd#3018 —
      // adding a third in that shape beside them would have been the
      // "converging on mechanism, not on coverage" defect `display-safe.ts`
      // was created over, so all three take the helper.
      logger.warn(`  ${displayLogicalId(logicalId)}`);
    }
    if (refreshable.length > NAMED_BASELINE_IDS) {
      logger.warn(`  ... and ${refreshable.length - NAMED_BASELINE_IDS} more`);
    }
  }

  if (refused.length > 0) {
    // "Deploy a change" is the remedy for one refusal class only (issue
    // #3465): an unverifiable-parameter refusal survives every in-place
    // update. A REASON-LESS one (an older cdkd's) survives it exactly when the
    // template names a declared parameter at that resource — the
    // `resourcesNamingDeclaredParameter` reading the next deploy applies at its
    // start (`stampReasonlessParameterRefusals`) to the template the CDK app
    // synthesizes. So given THAT template (export passes it only when it
    // synthesized the app, never a `--template` file, which the next deploy
    // does not read) a reason-less record is classified exactly, failing
    // closed into the sticky class like the deploy does. A row the template no
    // longer defines is one the deploy would DELETE, so no deploy remedy is
    // true of it, and it keeps the hedged remedy, as does every reason-less
    // record when no template is given. The list is grouped by class in a
    // FIXED order — deploy-clearable, unverifiable-parameter, reason-less —
    // each id under the remedy true for it.
    const stickyRemedy = refusedBaselineRemedy({
      observedBaselineRefused: true,
      observedBaselineRefusalReason: 'unverifiable-parameter',
    });
    const hedgedRemedy = refusedBaselineRemedy({ observedBaselineRefused: true });
    const byClass: Array<[remedy: string | undefined, ids: string[]]> = [
      [undefined, []],
      [stickyRemedy, []],
      [hedgedRemedy, []],
    ];
    let namesParameter: ((logicalId: string) => boolean) | undefined;
    for (const [logicalId, record] of refused) {
      let slot: 0 | 1 | 2;
      if (refusedBaselineRemedy(record) === undefined) slot = 0;
      else if (hasUnverifiableParameterRefusal(record)) slot = 1;
      else if (template === undefined || !definesResource(template, logicalId)) slot = 2;
      else {
        namesParameter ??= resourcesNamingDeclaredParameter(
          template as unknown as Parameters<typeof resourcesNamingDeclaredParameter>[0]
        );
        slot = namesParameter(logicalId) ? 1 : 0;
      }
      byClass[slot]![1].push(logicalId);
    }
    const ordered = byClass.filter(([, ids]) => ids.length > 0);
    const deployRemedy = 'Deploy a change to each one to restore its baseline.';
    const head =
      `${refused.length} of ${entries.length} resource(s) had their baseline REFUSED by a ` +
      `\`cdkd import\` run, because their recorded properties can no longer position the ` +
      `secret redaction. \`cdkd state refresh-observed\` will decline them too — capturing ` +
      `a readback against those properties could persist a resolved secret into state.json ` +
      `in plaintext.`;
    const listIds = (ids: string[]): void => {
      for (const logicalId of ids.slice(0, NAMED_BASELINE_IDS)) {
        logger.warn(`  ${displayLogicalId(logicalId)}`);
      }
      if (ids.length > NAMED_BASELINE_IDS) {
        logger.warn(`  ... and ${ids.length - NAMED_BASELINE_IDS} more`);
      }
    };
    if (ordered.length === 1) {
      const [remedy, ids] = ordered[0]!;
      logger.warn(
        safeMsg`${head} ${remedy === undefined ? deployRemedy : `For each one: ${remedy}`}`
      );
      listIds(ids);
    } else {
      logger.warn(`${head} The remedy depends on why each one was refused.`);
      for (const [remedy, ids] of ordered) {
        logger.warn(
          remedy === undefined
            ? safeMsg`${ids.length} of them — deploy a change to each one to restore its baseline.`
            : safeMsg`${ids.length} of them — for each one: ${remedy}`
        );
        listIds(ids);
      }
    }
  }
}

/** Whether `template` has its own `Resources` entry for `logicalId`. */
function definesResource(template: Record<string, unknown>, logicalId: string): boolean {
  const resources = template['Resources'];
  // An unreadable `Resources` answers TRUE, so the predicate's fail-closed
  // reading (every id names a parameter) decides, as at deploy.
  if (resources === null || typeof resources !== 'object' || Array.isArray(resources)) return true;
  return Object.prototype.hasOwnProperty.call(resources, logicalId);
}
