/**
 * The shared `cdkd orphan` refusal shape and its withheld-identity clauses.
 *
 * Part of `src/state/malformed-resources-bag.ts`, which re-exports every public name here.
 */
import { isPasteableIdent } from '../../utils/display-safe.js';
import {
  cdkdRemedy,
  isInertUnquoted,
  pasteableCommand,
  proseQuoted,
  SHELL_ACTIVE_WHY,
} from '../../utils/pasteable-command.js';
import { sanitizeRecoveryValue, shellQuote } from '../lock-contention-message.js';
import type { LockRecoveryContext } from '../lock-contention-message.js';
import { JSON_LISTING_HOLE_VALUE, accountArgs, withheldAccountClause } from './account-args.js';
import {
  dropRecordCommand,
  orphanIdentityVerdict,
  orphanIdentityArgs,
  rendersExactly,
  inspectCommand,
  inspectClause,
} from './inspect-command.js';

/**
 * How a READ-ONLY remedy ends a single-command message: on
 * `Inspect it with: <inspectCommand>` — unless the record is a region-less
 * LEGACY one, which that command cannot read (go-to-k/cdkd#3388). `recovery`
 * qualifies BOTH arms (go-to-k/cdkd#3909): the command through
 * {@link accountArgs}, the legacy object path as before.
 *
 * A KNOWN stack with NO region is what `cdkd orphan` hands for a legacy
 * `<prefix>/<stack>/state.json` listed with no region, and `cdkd state show`
 * refuses such a record with or without `--stack-region`, so ending on it hands
 * the operator a dead end. That arm names the S3 object instead, through
 * {@link orphanInspectClause}, which already owns the shape (the object path
 * gated on the name rendering exactly, the real prefix and bucket when
 * `recovery` carries them, one location per trailing line).
 *
 * Every other identity keeps the command, so a region-keyed record's text is
 * the one-line shape it always was.
 *
 * `legacyLead` replaces the region-less arm's opening sentence for a caller
 * that did not LIST the record — `cdkd export` loads it through the legacy key
 * probe ({@link EXPORT_LEGACY_LEAD}).
 */
export function inspectTail(
  prose: string,
  stackName: string | undefined,
  region: string | undefined,
  recovery?: LockRecoveryContext,
  legacyLead?: string
): string {
  if (stackName === undefined || region !== undefined) {
    return `${prose} ${inspectClause(stackName, region, recovery)}Inspect it with: ${inspectCommand(stackName, region, recovery)}`;
  }
  const legacy = orphanInspectClause(stackName, undefined, recovery, legacyLead);
  return [`${prose} ${legacy.sentence ?? ''}`.trimEnd(), ...(legacy.locations ?? [])].join('\n');
}

/**
 * The third way out every `cdkd orphan` refusal over a `resources` ENTRY
 * offers, conditioned as {@link malformedOrphanResourcePropertiesRefusalMessage}'s
 * note requires. One spelling for the three refusals scoped to the survivors
 * (the entry, its `properties` and its `attributes`), which make the same
 * promise for the same reason: each subtracts the orphan set.
 */
export const SURVIVOR_THIRD_WAY_OUT =
  `A third works only while the CDK app STILL DECLARES the ` +
  `named resource — this refusal covers just the records that would SURVIVE the save, so ` +
  `'cdkd orphan <its construct path>' removes it and repairs the rest; construct paths come ` +
  `from the synthesized template, so a resource the app no longer declares has none and must ` +
  `take one of the first two.`;

/**
 * What every `cdkd orphan` refusal shares after its own diagnosis: the two
 * template-free ways out, the caller's third, and the pasteable lines.
 *
 * `lead` is the diagnosis AND the harm, which is what differs per container —
 * the rule this module follows for every text. The remedy half does not
 * differ, and a second copy of it is what would drift: it carries the
 * substitution gate, the withheld-identity clause and the per-line commands
 * go-to-k/cdkd#3363 settled. `thirdWayOut` is a full sentence; the ones naming
 * a record outside `resources` cannot offer `cdkd orphan <construct path>` and
 * say so instead.
 *
 * Takes identities ALREADY normalised by the exported builder's
 * {@link absentIfEmpty}, which is where that floor lives.
 */
export function orphanRefusal(
  stackName: string | undefined,
  region: string | undefined,
  recovery: LockRecoveryContext | undefined,
  lead: string,
  thirdWayOut: string,
  /**
   * Appended to the drop remedy for the two `orphans` texts: dropping the whole
   * record discards the very list their third way out tells the operator not
   * to delete, so the remedy must say so (review of go-to-k/cdkd#3568).
   */
  dropCaveat = ''
): string {
  const inspect = orphanInspectClause(stackName, region, recovery);
  const listCommand = withheldIdentityListCommand(stackName, region, recovery);
  // Every PASTEABLE command goes LAST and UNWRAPPED, one per line — never inside
  // the prose's `'...'`. A command that itself carries `shellQuote`d values
  // composes with a wrapping quote into its inverse: pasted together with the
  // wrapper, `'cdkd state orphan S --state-bucket 'b; printf X; #''` closes the
  // wrapper at the value's opening quote and RUNS `printf X` (measured, bash).
  // NOT only the bucket: the release before this carried the STACK NAME and
  // the REGION inside the same wrapper, and `displaySafe` keeps `'` and `;` —
  // so a prebuilt-assembly stack name (read unvalidated) or a region planted
  // as a state-key segment broke out on the shipped binary too; the bucket
  // (plantable from a cloned repo's `cdk.json`) is the one this review added.
  // The rule `.claude/rules/lock-contention-message.md` records for the
  // force-unlock hint, applied to the three commands here (go-to-k/cdkd#3363).
  const commands = [
    `Drop the record: ${dropRecordCommand(stackName, region, recovery)}`,
    ...(listCommand === undefined ? [] : [`Find the exact name: ${listCommand}`]),
    ...(inspect.command === undefined ? [] : [`Inspect the record: ${inspect.command}`]),
  ];
  const prose =
    `${lead} No state was written. Two ways out need no CDK app: ` +
    `repair the record by hand, or drop it whole with the 'Drop the record' command below, ` +
    `which leaves the live AWS resources standing${dropCaveat}` +
    `${withheldIdentityClause(stackName, region)}${withheldRecoveryClause(recovery)}. ` +
    thirdWayOut +
    (inspect.sentence === undefined ? '' : ` ${inspect.sentence}`);
  return [prose, ...commands, ...(inspect.locations ?? [])].join('\n');
}

/**
 * The half-sentence that accompanies a TEMPLATE drop remedy when a stack name
 * WAS known but {@link orphanIdentityVerdict} withheld it or the region beside
 * it — for not rendering exactly, for the cap, or for a leading `-`, each with
 * its own sentence below. For an inexact value the prose above prints the
 * sanitized spelling, and an operator filling the template
 * from that spelling would be aiming at the healthy sibling the gate exists to
 * protect (`'prod-api '` renders as `prod-api`; a padded region is the same
 * misdirection one flag over), so the message says where to take them from
 * instead: `cdkd state list --json`, which keeps the padding — `--long`
 * renders through `displayIdent`, which trims, so it would hand back the same
 * spelling. That listing is JSON-encoded, so each value is decoded before it is
 * shell-quoted ({@link JSON_LISTING_HOLE_VALUE}, go-to-k/cdkd#3908). Empty when the command was
 * substituted, and when no name was known at all — that arm's template already
 * reads as a hole to fill.
 */
function withheldIdentityClause(stackName: string | undefined, region: string | undefined): string {
  const verdict = withheldVerdict(stackName, region);
  if (stackName === undefined || verdict === undefined) return '';
  // A name beginning with `-` must NOT be filled back in: quoted or not,
  // Commander could read it in the positional as the option, so the fill-in
  // instruction below would rebuild the command the gate refused. Keyed on the
  // RAW `-`, not on the reason, because the gate reports `altered` /
  // `too-long` first (go-to-k/cdkd#3436).
  //
  // Spliced right after the sentence offering the drop as the SECOND way out,
  // so it says that way is not available for this record rather than leaving
  // it offered beside a hole that must not be filled; and it says REPAIR, not
  // "remove", because the `orphans` refusals' third way out forbids deleting
  // the record (review of go-to-k/cdkd#3973, R3). One drop command, so
  // "command", singular.
  if (stackName.startsWith('-')) {
    return (
      ` — but the stack name above begins with a '-', which 'cdkd state orphan' could parse ` +
      `as an option, so that second way is not available for this record: repair it by hand, ` +
      `and do NOT fill the 'Drop the record' command's stack hole with that name` +
      (verdict.region === undefined
        ? ''
        : `; its region is a hole too, to be taken from the 'Find the exact name' command ` +
          `below, replacing its quoted hole, quotes included, with ${JSON_LISTING_HOLE_VALUE}`)
    );
  }
  // A region beginning with `-` is `--stack-region`'s VALUE, which Commander
  // takes as given; the gate refuses it conservatively, so the sentence claims
  // only that, and filling its hole is safe.
  const reasons = [verdict.stack, verdict.region];
  // Past the cap with nothing ALTERED: the prose may well show it whole (a
  // name of 1152 characters followed by `...` is its own truncation), so "did
  // not render exactly" would be false of it.
  if (!reasons.includes('altered') && reasons.includes('too-long')) {
    return (
      ` — the stack name or region above is too long to name in a command, so take them from ` +
      `the 'Find the exact name' command below — replace each quoted hole, quotes included, ` +
      `with ${JSON_LISTING_HOLE_VALUE} — rather than from this message`
    );
  }
  if (verdict.stack === undefined && verdict.region === 'option-shaped') {
    return (
      ` — the region above begins with a '-', which cdkd refuses to print as an argument, so ` +
      `take the stack name and region from the 'Find the exact name' command below — replace ` +
      `each quoted hole, quotes included, with ${JSON_LISTING_HOLE_VALUE} — rather than from ` +
      `this message`
    );
  }
  // Rendered exactly but not inert unquoted (go-to-k/cdkd#4205): "did not
  // render exactly" would be false of `It's Legacy`, which the head shows whole.
  if (!reasons.includes('altered') && reasons.includes('shell-active')) {
    return (
      ` — the stack name or region above ${SHELL_ACTIVE_WHY}, so take them from the ` +
      `'Find the exact name' command below — replace each quoted hole, quotes included, with ` +
      `the shell-quoted value — rather than from this message`
    );
  }
  return (
    ` — the stack name or region above did not render exactly, so take them from the ` +
    `'Find the exact name' command below — replace each quoted hole, quotes included, with ` +
    `${JSON_LISTING_HOLE_VALUE} — rather than from this message`
  );
}

/**
 * The half-sentence for the OTHER thing that can print as a hole: one of the
 * account fragments {@link accountArgs} appends, named by flag and by the
 * gate's reason, never by value (go-to-k/cdkd#3909).
 *
 * Separate from {@link withheldIdentityClause} rather than folded into it,
 * because the two holes have different SOURCES and therefore different remedies.
 * An identity hole is filled from `cdkd state list --json`, which is why that
 * clause points at a command; an account fragment came from the operator's own
 * argv, so they already hold it and no listing would help. Conflating them would
 * send someone to a listing that does not carry their `--profile`.
 *
 * Without this, a run whose PREFIX or BUCKET was the inexact value printed
 * `--state-prefix '<prefix>'` with nothing in the message saying the hole was a
 * hole: `withheldVerdict` reads the stack name and the region only, and the
 * object-path note is suppressed whenever a prefix WAS supplied. That is
 * {@link withheldIdentityClause}'s own defect class, one fragment over.
 */
function withheldRecoveryClause(recovery?: LockRecoveryContext): string {
  const clause = withheldAccountClause(recovery, 'the command lines below print').trimEnd();
  if (clause === '') return '';
  // Spliced mid-sentence as a dash clause, so lower-cased and without its stop.
  return ` — ${clause.charAt(0).toLowerCase()}${clause.slice(1, -1)}`;
}

/**
 * The listing {@link withheldIdentityClause} points at, printed as its own
 * trailing command line. Qualified like the remedy it stands in for: a bare
 * listing after `cdkd orphan --profile prod ...` would read the DEFAULT
 * profile's bucket, and the name it hands back would then be a different
 * bucket's.
 */
function withheldIdentityListCommand(
  stackName: string | undefined,
  region: string | undefined,
  recovery?: LockRecoveryContext
): string | undefined {
  const verdict = withheldVerdict(stackName, region);
  if (stackName === undefined || verdict === undefined) return undefined;
  // Not for a `-`-leading name whose region was named: the clause sends the
  // operator to fix that record by hand, and a listing would only hand back
  // the name they must not paste.
  if (stackName.startsWith('-') && verdict.region === undefined) return undefined;
  return pasteableCommand('cdkd state list', [{ literal: '--json' }, ...accountArgs(recovery)])
    .command;
}

/**
 * The shared gate's verdict when a name WAS known and the gate withheld it or
 * the region beside it; `undefined` otherwise. Each of the clause and the
 * listing takes the verdict from this one call instead of computing it a
 * second time (review of go-to-k/cdkd#3973, o2).
 */
function withheldVerdict(
  stackName: string | undefined,
  region: string | undefined
): ReturnType<typeof orphanIdentityVerdict> | undefined {
  // `''` is no identity either, as in {@link dropRecordCommand}: otherwise a
  // later direct caller gets the withheld clause while the drop command beside
  // it takes the no-identity arm.
  if (stackName === undefined || stackName === '') return undefined;
  // The same `''` floor {@link dropRecordCommand} carries, so the two agree on
  // whether a region was supplied at all. Unreachable through the one builder
  // that calls this (it normalises `''` at entry) and kept for the reason
  // `dropRecordCommand` gives: a later caller inherits the floor.
  const known = region === '' ? undefined : region;
  const verdict = orphanIdentityVerdict(stackName, known);
  return verdict.stack !== undefined || verdict.region !== undefined ? verdict : undefined;
}

/**
 * The `cdkd state show` command on the orphan properties refusal's trailing
 * `Inspect the record:` line, for a record listed WITH a region — gated and
 * qualified exactly as the drop command on the line above it is, because it is
 * the same identity in the same message.
 * Gating only the drop command left the message contradicting itself: it said
 * the name did not render exactly, pointed at `cdkd state list --json`, and then
 * printed `cdkd state show prod-api ...` with the trimmed spelling of
 * `'prod-api '`, naming the healthy sibling (the M2 finding of the
 * go-to-k/cdkd#3363 review). Holes follow {@link dropRecordCommand}'s rule,
 * through {@link orphanIdentityArgs}: a WITHHELD region makes both a hole, a
 * withheld name only the name.
 *
 * Built here rather than by widening {@link inspectCommand}, which serves four
 * other builders whose identities come from different sources (and this one no
 * longer calls it at all).
 */
function orphanInspectCommand(
  stackName: string,
  region: string,
  recovery?: LockRecoveryContext
): string {
  return pasteableCommand('cdkd state show', [
    ...orphanIdentityArgs(stackName, region),
    { literal: '--json' },
    ...accountArgs(recovery),
  ]).command;
}

/**
 * {@link orphanInspectClause}'s default region-less opening, for a record a
 * caller found by LISTING — `cdkd orphan`. `cdkd export` loads its record
 * instead and opens with {@link EXPORT_LEGACY_LEAD}.
 */
const LISTED_LEGACY_LEAD =
  `The record is listed with no region — a legacy 'state.json' whose body names none, or ` +
  `one the listing could not read — which 'cdkd state show' cannot read and a 'cdkd deploy' ` +
  `will not migrate while it is torn, so inspect the object directly`;

/**
 * How {@link malformedOrphanResourcePropertiesRefusalMessage} tells the operator
 * to inspect the record: a `command` it prints on its trailing
 * `Inspect the record:` line, or — for the legacy region-less shape, where no
 * command can serve — a prose `sentence` naming the S3 object.
 *
 * A KNOWN stack with NO region is a legacy record (`<prefix>/<stack>/state.json`)
 * that `listStacks` lists with no region — `cdkd orphan` hands this module the
 * region the record is LISTED under since go-to-k/cdkd#3359, and that is
 * `undefined` only for such a ref (its body names no region, or the probe that
 * reads it could not). `cdkd state show` refuses such a record with or without
 * `--stack-region` ("has only a legacy state record without a region"), and the
 * migration it suggests is a `cdkd deploy`, which refuses this very record
 * (go-to-k/cdkd#3191). So ending on `cdkd state show` would hand the operator a
 * command that cannot serve them; the line names the S3 object instead. Teaching
 * `state show` to read a legacy record was the alternative, declined as a wider
 * change to a command that is not the one refusing.
 *
 * The object path is printed only when the stack name {@link rendersExactly}: a
 * path with a sanitized or truncated segment names an object that does not
 * exist. The name comes from the assembly, and `cdkd orphan` accepts a PREBUILT
 * one whose manifest nothing validates, which is what makes an inexact name
 * reachable at all (go-to-k/cdkd#3360); an S3 key's `Parent~Child` name, the
 * case the destroy refusal's gate was written for, cannot appear here.
 *
 * With `recovery` the path carries the REAL prefix and names the bucket, the
 * way the drop remedy above it is qualified; without it the prefix is a
 * placeholder and the sentence says how to fill it.
 *
 * Its region-less arm is also {@link inspectTail}'s, for the state and outputs
 * refusals `cdkd orphan` raises over the same legacy record (go-to-k/cdkd#3388).
 */
function orphanInspectClause(
  stackName: string | undefined,
  region: string | undefined,
  recovery?: LockRecoveryContext,
  /** The region-less arm's opening sentence; see {@link inspectTail}. */
  legacyLead: string = LISTED_LEGACY_LEAD
): { command?: string; sentence?: string; locations?: string[] } {
  // `''` is no identity either, the floor {@link dropRecordCommand} and
  // {@link withheldVerdict} both carry. Without it a direct caller passing
  // `''` got an inspect COMMAND here while the drop line beside it took its
  // no-identity arm — the disagreement one shared verdict
  // ({@link orphanIdentityVerdict}) exists to rule out. Unreachable through the one builder that calls
  // this (it normalises `''` at entry), which is the condition the other two
  // floors are under as well.
  if (stackName === undefined || stackName === '') {
    // The same template the shared `inspectCommand` gives for no identity, but
    // qualified: the identity is the hole, not the account.
    return { command: inspectCommand(undefined, undefined, recovery) };
  }
  if (region !== undefined) {
    return { command: orphanInspectCommand(stackName, region, recovery) };
  }
  const lead = legacyLead;
  // The bucket and prefix are printed only when they render EXACTLY
  // (go-to-k/cdkd#3377): an altered one would name a different bucket or key
  // space. Otherwise the sentence falls back to the placeholder forms. The
  // BUCKET is also held to `isPasteableIdent`, the gate {@link accountArgs}
  // holds it to on the command lines above, so a bucket those lines print as a
  // hole is not echoed on this one (go-to-k/cdkd#3909); the PREFIX is gated
  // per `/`-separated segment below.
  const exactOrUndefined = (v: string | undefined): string | undefined =>
    v !== undefined && sanitizeRecoveryValue(v).exact ? v : undefined;
  // `|| undefined` floors `''` as well, and the asymmetry with the PREFIX two
  // lines down is the point: a bucket NAME cannot be empty, and
  // {@link accountArgs} emits no `--state-bucket` for `''` — so a
  // `State bucket: ''` line would name nothing while this sentence promised it
  // named the bucket, and the same value would be described by two rules. An
  // empty PREFIX is a real key space (`/<stack>/state.json`), which is why it
  // keeps its own arm and why the flag emits `--state-prefix ''`.
  const exactBucket = exactOrUndefined(recovery?.stateBucket) || undefined;
  const bucket =
    exactBucket !== undefined && isPasteableIdent(exactBucket) ? exactBucket : undefined;
  // The object's LOCATION is printed on labelled trailing lines, one value per
  // line, never inside this sentence — B1 of go-to-k/cdkd#3363's fourth review.
  // A shell-quoted value is only safe while the quotes before it BALANCE, and
  // English prose does not keep that promise: an apostrophe in `stack's` opened
  // a quote that closed at the bucket's own opening quote, and pasting the
  // sentence ran a `cdk.json`-planted bucket (`'evil; touch OWNED; #'`) as shell.
  // The same LAST-and-UNWRAPPED rule the commands above follow.
  const locations = bucket === undefined ? [] : [`State bucket: ${shellQuote(bucket)}`];
  // `'cdkd state info'` QUOTED, like every other fixed command name in this
  // module's prose. Unquoted it is not merely inconsistent: a reader selecting
  // the parenthetical and pasting it INVOKES the real CLI with argv
  // `["state","info","names","it"]`, where the quoted form is inert. No value is
  // interpolated, so it is not injection — but inert is strictly better, and the
  // rule that makes it inert is the one the six quoted siblings follow.
  const where =
    bucket === undefined
      ? `, in the state bucket ('cdkd state info' names it)`
      : `, in the bucket on the 'State bucket' line below`;
  if (!rendersExactly(stackName)) {
    return {
      sentence:
        `${lead}: it is the legacy 'state.json' under this stack name, which did not render ` +
        `exactly${where}.`,
      locations,
    };
  }
  // Every `/`-separated SEGMENT held to `isPasteableIdent`: a slash prefix
  // (`org/cdkd`) is an ordinary key, but a segment the command lines above
  // print as a hole is not echoed on this line either (go-to-k/cdkd#3909
  // review). An empty prefix keeps its own arm: it is a real key space.
  const exactPrefix = exactOrUndefined(recovery?.statePrefix);
  const prefix =
    exactPrefix === undefined ||
    (exactPrefix !== '' && !exactPrefix.split('/').every((seg) => isPasteableIdent(seg)))
      ? undefined
      : exactPrefix;
  // The stack SEGMENT is held to `isInertUnquoted` as a command value is
  // (go-to-k/cdkd#4205): the key is `shellQuote`d, which a flipped quote parity
  // above this line turns inside out. A segment that is not inert becomes the
  // `<stack>` hole, filled from the listing.
  const stackShown = isInertUnquoted(stackName);
  const key = shellQuote(
    `${prefix ?? '<prefix>'}/${stackShown ? stackName : '<stack>'}/state.json`
  );
  const stackFill = stackShown
    ? ''
    : ` The stack name ${SHELL_ACTIVE_WHY}, so the key shows the hole '<stack>' in its place; ` +
      `take the name from ${proseQuoted(cdkdRemedy('cdkd state list', '--json'))} and put it there, inside the outer quotes.`;
  // The fill-in note only when no prefix was SUPPLIED: one that was supplied but
  // did not render exactly is not the default, so the note would mislead.
  // Its OWN sentence rather than a second parenthetical: appended to `where`'s
  // it rendered `... (cdkd state info names it) (its prefix is ...)`, two
  // bracketed asides in a row that read as one nested aside. The flag name is
  // quoted for the reason `where`'s is.
  // THREE arms, not two. The middle one is the object key's own hole, which
  // `withheldRecoveryClause` does not cover and must not claim to: that clause
  // is about the COMMAND lines, where a hole is quoted and replaced whole,
  // while `<prefix>` here sits INSIDE the single quotes wrapping the whole key,
  // so "quotes included" would have an operator build `''custom''/S/state.json'`
  // (go-to-k/cdkd#3439 review). Said here, where the hole actually is.
  const fill =
    recovery?.statePrefix === undefined
      ? ` Its prefix is 'cdkd' unless '--state-prefix' was given.`
      : prefix === undefined
        ? // QUOTED, even though this is prose and not a command. A bare
          // `<prefix>` is two shell redirections, and prose is pasteable --
          // measured on the first cut of this very sentence: selected and
          // pasted in a directory holding a file named `prefix`, `<prefix`
          // read it and `>` then truncated a file named `where`. The rule
          // `commandHole` exists for does not stop at the command lines
          // (go-to-k/cdkd#3440 review, the third round of this class).
          ` The prefix you passed is not shown here, because it did not render exactly or ` +
          `one of its '/'-separated parts is not a plain identifier, so the key shows the hole ` +
          `'<prefix>' where it belongs; put your own value there, inside the outer quotes.`
        : '';
  return {
    sentence: `${lead}: the 'Object key' line below names it${where}.${fill}${stackFill}`,
    locations: [`Object key: ${key}`, ...locations],
  };
}
