/**
 * Issue [#3283](https://github.com/go-to-k/cdkd/issues/3283) — a
 * `timeout-minutes` must not be too TIGHT.
 *
 * `workflow-job-hardening.test.ts` (go-to-k/cdkd#3272) refuses a bound that is
 * absent, non-integer, below 1, or at or above the Actions default of 360. That
 * is the whole of it, and it leaves the failure mode that actually happened
 * wide open: `hooks.yml` carried `timeout-minutes: 30` against a job observed at
 * 1587 s — **1.1x** — for its entire life. The fence was green throughout,
 * because 30 is an integer, at least 1, and below 360.
 *
 * A TOO-TIGHT BOUND FAILS IN THE DIRECTION THAT HIDES. The job is killed, the
 * run reads as a flake, someone re-runs it, and it passes. Nothing accumulates
 * evidence. That is strictly worse than the absent-bound case the sibling
 * already catches, which at least fails loudly when it fails at all. And it is
 * not hypothetical for this repo: go-to-k/cdkd#3272 itself shipped a revision
 * setting `docs-deploy` / `build` to 15 minutes while a real 902 s build sat in
 * the range its own comment cited.
 *
 * WHY A COMMITTED SNAPSHOT. Answering "too tight for what?" needs observed
 * durations, which live in the Actions API — a network call, per job, in a unit
 * suite that forbids one. So `scripts/gen-workflow-job-durations.ts` captures
 * them into `docs/_generated/workflow-job-durations.json` and this reads that,
 * offline and deterministically: the same shape as every other matrix here (see
 * [.claude/rules/layout-scripts.md](../../../.claude/rules/layout-scripts.md)).
 * Three designs were weighed on the issue and the maintainer chose this one over
 * a scheduled workflow that files issues by itself; the cost is one more
 * generated artifact and a refresh someone must run.
 *
 * THE SNAPSHOT IS A LOWER BOUND, AND THE MULTIPLE IS SIZED FOR THAT. It records
 * the longest JOB seen in a closed range, never a run's wall clock (a run
 * carries queue time and every other job in it, and `timeout-minutes` bounds
 * neither — a 235 s "job" in go-to-k/cdkd#3272 had actually taken 11 s). A
 * longer run may always exist outside the range, so `MIN_HEADROOM` is not a
 * safety margin to be tuned finely: it is the floor below which a bound is
 * indefensible on the evidence in hand.
 *
 * WHY 2, AND WHERE THAT NUMBER COMES FROM. Measured across the bounds in the
 * tree, headroom runs from 2.27x (`hooks.yml` / `hook-suites`, the tightest)
 * to 69.23x (`ci.yml` / `release-pr-not-stale`, the loosest). An earlier
 * revision said "over 100x"; nothing reaches it, in either snapshot revision.
 *
 * THE `>=` IS THE ISSUE'S OWN, AND `k = 2` IS THIS FENCE'S. go-to-k/cdkd#3283
 * writes `bound >= k * max` itself and leaves `k` unfixed, so the inclusive
 * comparison is inherited and the constant is a decision made here.
 *
 * Three revisions of this paragraph said otherwise, and all three claims were
 * false: that the `>=` was owed to go-to-k/cdkd#3282; that #3282 asks for a
 * state sitting exactly ON this floor (it asks for "a max comfortably UNDER 15
 * minutes, at which point the bound goes back to 30", which is above 2x); and
 * that #3283 never mentions `hook-suites` (its Dup-check line does). The
 * corrections landed in the PR body first and not here, which is the same
 * one-place-not-the-other failure this pair has now had in a sanitiser, in a
 * prose claim, and in an assertion. Re-read the source before citing it: a
 * claim about what another document says is the kind this pair gets wrong most
 * often.
 *
 * EVERY UNREADABLE INPUT IS A FINDING, NEVER A SKIP. A snapshot that will not
 * parse, a job in the tree with no entry, and an entry whose job no longer
 * exists each report. The middle one matters most: a missing entry and a job
 * that simply never ran are indistinguishable from the data alone, so jobs known
 * to run rarely are named in `RARELY_RUN` rather than being silently tolerated —
 * a list that must shrink when one of them gains coverage, and that fails when
 * an entry becomes available.
 */

import { describe, expect, it } from 'vite-plus/test';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  displayNameToKey,
  invokedDirectly,
  nextWindow,
  refuseInsideTestRunner,
  resolveJobKey,
  walkMayStop,
} from '../../../scripts/gen-workflow-job-durations.ts';
// The SIBLING's sanitisers, imported rather than re-derived. Every field this
// file renders — a job key, a workflow file name, a snapshot range — is
// fork-controlled on `pull_request`, and go-to-k/cdkd#3272 found that class
// FOUR times, each instance inside the code that fixed the previous one. A
// fifth venue with its own copies of the helpers is how that happens again.
import {
  MAX_FIELD_LENGTH,
  MAX_RENDERED_FINDINGS,
  boundedList,
  flatten,
  quoteClamped,
  safeJobId,
  safeKey,
  safeName,
  safeRange,
  safeText,
  type Safe,
} from '../../../scripts/workflow-log-safety.ts';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const SNAPSHOT_PATH = join(REPO_ROOT, 'docs', '_generated', 'workflow-job-durations.json');

/** A bound must be at least this multiple of the longest job ever observed. */
const MIN_HEADROOM = 2;

/**
 * Magnitudes the inputs must clear, so a snapshot that silently became `{}` or a
 * directory walk that stopped matching fails here rather than making every other
 * case pass by having nothing to check. Pinned from both sides below.
 */
// RATCHETED 18 -> 19 when go-to-k/cdkd#3082 added a 22nd job mid-review. The
// band below is deliberately tight, so adding a job turns this ratchet; the
// comment on the assertion documents the two steps, and this is the first time
// the flow ran for real rather than as prose.
const MIN_DECLARED = 19;
// 18, not 12. At 12 the round-1 defect — four jobs vanishing because the
// generator keyed them by display name — cleared the floor with room to spare,
// so the floor could not have caught the very failure that made this fence
// necessary.
/**
 * The longest job in an honest snapshot, in seconds.
 *
 * A COUNT FLOOR CANNOT SEE A VACUOUS SNAPSHOT. Every other floor here counts
 * entries, and a snapshot whose every `max` is 1 passes all of them while
 * making each `too-tight` comparison meaningless — measured green, 72 of 72.
 *
 * 600, NOT 900, AND THE ARITHMETIC IS THE REASON. The assertion takes the max
 * over ALL jobs, so the value it actually guards is whichever job is longest.
 * `hooks.yml/hook-suites` is 1587 s today; the SECOND longest is
 * `docs-deploy.yml/build` at 902 s. A 900 floor therefore had two seconds of
 * real margin — the moment go-to-k/cdkd#3282 succeeds in taking hook-suites
 * under 15 minutes, the floor is held by an unrelated and variable job, and a
 * docs build peaking at 880 s reds an HONEST snapshot with a message pointing
 * at this constant. An earlier revision of this comment claimed the opposite,
 * that 900 left "room for the suite to get faster" — but 900 s is the 15
 * minutes go-to-k/cdkd#3282 wants hook-suites to come "comfortably under", so
 * a floor there is a floor at the target.
 */
const MIN_LONGEST_MAX = 600;

const MIN_SNAPSHOT = 19;
const MIN_COMPARED = 19;

/**
 * Jobs with no snapshot entry that are EXPECTED to have none.
 *
 * ONE ENTRY, AND THE REASON IS WHAT MATTERS — not the count. The first cut of
 * this file listed five
 * jobs here with reasons like "gated on an issue or comment event" — and every
 * one of those reasons was FALSE. They had no entry because the generator keyed
 * on the Actions API's display name while this fence keys on the YAML job id,
 * so the four jobs that override `name:` vanished; the fifth was dropped by a
 * prune that stopped before it had seen every job. `issue-conventions.yml` is
 * in fact the highest-volume workflow in the repo — 106/71/274/389/496
 * successful runs per day over 2026-09-12..09-16 — the opposite of rare. (Two
 * earlier revisions of that figure were wrong in two different ways: "~885 in a
 * day" was the RANGE total restated as a daily rate, caught independently by
 * two reviewers; and the six-day version ended on 2026-09-17, which was still
 * IN PROGRESS when it was taken — the same in-progress-day defect this PR had
 * already fixed once in the artifact, recurring in the prose that replaced it.)
 *
 * So this list absorbed a generator defect and gave it a plausible story, which
 * is exactly the failure the fence exists to catch, reproduced inside the fence.
 * With both causes fixed the list went EMPTY and the snapshot covered 21 of 21.
 *
 * It holds one entry again, and the difference from the first cut is the only
 * thing this docstring is really about. `hooks.yml/mutation-harness` landed on
 * `main` from go-to-k/cdkd#3082 while this PR was in review; the snapshot now
 * covers 21 of 22, and the reason recorded is "no successful run on main yet",
 * which is CHECKABLE and self-retiring — the `exemption-now-covered` arm fails
 * the moment the job gains data, and `exemption-for-absent-job` fails if it
 * goes away. "Gated on an issue event" was neither: it was a story that would
 * have been true forever. An empty list is a pleasant state, not the invariant;
 * a true, expiring reason is.
 *
 * The mechanism stays because a genuinely never-run job is possible. Adding an
 * entry needs a reason that survives being checked — run
 * `gh run list --workflow=<file> --json databaseId --limit 5` and look before
 * writing one, because "no entry" and "never ran" are indistinguishable from
 * the data alone. Both staleness directions are fenced: an exemption whose job
 * gains data fails, and so does one whose job disappears.
 */
const RARELY_RUN: Readonly<Record<string, string>> = {
  // THE FENCE CAUGHT A REAL JOB THE DAY IT LANDED, which is what it is for, and
  // this entry is the documented second step of adding one. go-to-k/cdkd#3082
  // added `mutation-harness` to `hooks.yml` while this PR was in review; it has
  // no successful run inside the snapshot's range (2026-09-02..09-16) and none
  // since, so it cannot have an entry until the generator is re-run after a
  // green run of it exists.
  //
  // The reason is TRUE, which is the whole requirement this list carries: not
  // "rarely run" but "too new to have data". An entry with a plausible-sounding
  // false reason is the round-1 defect of this very PR, and the arms that
  // refuse a stale exemption are what stop this one outliving its cause — it
  // fails the moment the job gains data or disappears.
  'hooks.yml/mutation-harness': 'added in go-to-k/cdkd#3082; no successful run on main yet',
};

interface JobSample {
  readonly max: number;
  readonly from: string;
  readonly to: string;
}

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * One workflow document's jobs and their bounds.
 *
 * Pure, and separate from the directory walk, so that a NON-NUMERIC bound is
 * reachable from a case. The real tree cannot have one — the sibling fence
 * refuses it — which is exactly why the `typeof` here survived mutation until
 * this function could be called directly.
 */
export const jobsFromWorkflow = (file: string, doc: unknown): Map<string, number | undefined> => {
  const out = new Map<string, number | undefined>();
  if (!isMapping(doc) || !isMapping(doc['jobs'])) return out;
  for (const [job, node] of Object.entries(doc['jobs'])) {
    const bound = isMapping(node) ? node['timeout-minutes'] : undefined;
    // `typeof`, not a cast: a string bound would otherwise be multiplied by 60
    // and compared, silently producing `NaN` headroom, and `NaN < 2` is FALSE —
    // so a malformed bound would PASS this fence rather than failing it.
    out.set(`${file}/${job}`, typeof bound === 'number' ? bound : undefined);
  }
  return out;
};

/** Every `<file>/<job>` the tree declares, with its bound. */
export const declaredJobs = (
  dir: string = WORKFLOW_DIR,
): { jobs: Map<string, number | undefined>; unreadable: Safe[] } => {
  const jobs = new Map<string, number | undefined>();
  // `Safe[]`, NOT `string[]` — the SEVENTH venue for this class, and the first
  // one that is not a rendered line at all. `finding` sanitises the file name
  // on the way to the report, so the report was fine; an ASSERTION over these
  // values is not. `expect(unreadable).toEqual([...])` prints the raw array in
  // its diff, at column 0, with vitest's pretty-format escaping only `"` and
  // `\` — not LF, not U+202E, not U+0085. A fork that names a workflow file
  // `x\n::error::...` forges a line through the FAILURE path of the case that
  // exists to prove the fork cannot forge a line.
  const unreadable: Safe[] = [];
  for (const file of readdirSync(dir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    let doc: unknown;
    try {
      doc = parseYaml(readFileSync(join(dir, file), 'utf8'));
    } catch {
      // The MESSAGE is never rendered. A YAML parse error quotes the offending
      // source, which on `pull_request` is a FORK's bytes — measured carrying a
      // newline, an ANSI escape and a bidi override, printed by vitest at
      // column 0 where the runner interprets `::error::`. That this ran
      // unguarded at module scope, while `FindingKind` already declared
      // `'unreadable-workflow'` and nothing constructed it, is the tell: the
      // arm was designed and never written.
      // Sanitised at the PUSH, not at each reader: a value that leaves this
      // function raw has as many venues as it has consumers. `finding` below
      // sanitises again on the render path — idempotent for a real file name,
      // which cannot contain a byte either helper touches.
      unreadable.push(safeName(file));
      continue;
    }
    for (const [key, bound] of jobsFromWorkflow(file, doc)) jobs.set(key, bound);
  }
  return { jobs, unreadable };
};

/** Parse and VALIDATE snapshot text. Separate from reading it so the refusals are testable. */
export const parseSnapshot = (text: string, where: string): Record<string, JobSample> => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    // Node embeds the offending SOURCE in a JSON parse error, and this file is
    // committed, so a PR edits it freely. A fixed message carries the same
    // information a reader needs — the file is unreadable, regenerate it.
    throw new Error(`${where} is not valid JSON; regenerate it`);
  }
  if (!isMapping(raw) || !isMapping(raw['jobs'])) {
    throw new Error(`${where} has no jobs mapping; regenerate it`);
  }
  // NULL PROTOTYPE, and the reason is stated rather than dramatised: `snapshot`
  // is read with `snapshot[job]`, and on an ordinary object literal a `job` of
  // `constructor` or `toString` answers with an inherited FUNCTION instead of
  // `undefined`. It is not reachable here — every key this fence looks up is a
  // `<file>/<job>` pair and a `/` cannot appear in either of those names — so
  // this closes a SHAPE, not a live hole. It costs one call, and a keyed bag
  // built from parsed JSON is the shape that has bitten this repo before.
  // NOT PINNED, and labelled like the other two: replacing this with `{}` keeps
  // every case green, because the shape it closes is unreachable (see above).
  const jobs: Record<string, JobSample> = Object.create(null) as Record<string, JobSample>;
  for (const [key, value] of Object.entries(raw['jobs'])) {
    if (!isMapping(value) || typeof value['max'] !== 'number') {
      // `safeText(key)`: an object key in this file is arbitrary attacker-chosen
      // text with no length limit — a strictly more capable venue than the job
      // key this file already sanitises, and it was raw.
      // `safeKey`, not `safeText`: this value is a `<file>/<job>` pair, and
      // flattening plus clamping leaves a pure-ASCII key reading as a complete
      // finding about a real job — `x is fine; <path>: ci.yml/check-build-test`
      // was measured doing exactly that. The cases below assert the absence of
      // LF and RLO only, which is why this stayed green.
      throw new Error(`${where}: ${safeKey(key)} has no numeric max in the snapshot; regenerate it`);
    }
    // POSITIVE and finite. A `max` of 0 makes headroom `Infinity`, and
    // `Infinity < MIN_HEADROOM` is false, so every bound on that job would pass
    // silently — the same false-comparison as `NaN < 2`. The generator now
    // floors at 1, so a 0 here means a hand-edited or truncated snapshot.
    if (!Number.isFinite(value['max']) || value['max'] <= 0) {
      throw new Error(
        `${where}: ${safeKey(key)} has a max that is not a positive number; regenerate it`,
      );
    }
    jobs[key] = {
      max: value['max'],
      from: String(value['from'] ?? ''),
      to: String(value['to'] ?? ''),
    };
  }
  return jobs;
};

/**
 * How old the snapshot may be before it is a finding, in days.
 *
 * go-to-k/cdkd#3283 asks for `bound >= k * max` "plus a STALENESS GUARD", and
 * three of its four structural guards were built — a job in the tree but not in
 * the snapshot, an entry whose job is gone, an exemption that is no longer
 * needed — while the one the phrase most plainly means, AGE, was not. The PR
 * body argued only that a CI byte-diff guard is impossible here (it is: the
 * data changes on every run), which answers a different question.
 *
 * What an age guard buys: the maxima only ever grow as jobs get slower, so a
 * snapshot that stopped being refreshed makes every `too-tight` comparison
 * describe a repo that no longer exists — quietly, and in the passing
 * direction. What it costs: a chore. 90 days is chosen so the chore is
 * quarterly rather than constant; the integ gates in this repo use 14, which
 * is right for real-AWS drift and would be noise for a generator nobody can
 * run from CI.
 */
const MAX_SNAPSHOT_AGE_DAYS = 90;

/**
 * The snapshot's own age, as a finding-or-nothing.
 *
 * Pure, and separate from the read, because the real artifact is fresh — the
 * only way to reach any arm here is to call it, which is the same reason
 * `auditHeadroom` is a pure function of its inputs.
 */
export const auditSnapshotAge = (
  generatedAt: unknown,
  now: number,
): 'ok' | 'unreadable' | 'stale' | 'future' => {
  // NOT PINNED, and equivalent rather than missing: every non-string this can
  // receive — `undefined`, a number, an object — reaches `Date.parse`, which
  // answers `NaN`, which the next line already turns into the same verdict.
  // Kept because the answer should not depend on a coercion.
  if (typeof generatedAt !== 'string') return 'unreadable';
  const at = Date.parse(generatedAt);
  if (Number.isNaN(at)) return 'unreadable';
  // A FUTURE stamp is its own arm, not a negative age that reads as fresh: a
  // hand-edited or clock-skewed date is exactly how a stale snapshot would be
  // made to look current, and `age < 90` is true for every future date.
  if (at > now) return 'future';
  return now - at > MAX_SNAPSHOT_AGE_DAYS * 86400000 ? 'stale' : 'ok';
};

/**
 * The OLDEST day any entry's range ends on, or `''` when there are none.
 *
 * THE STAMP IS NOT THE DATA'S AGE, and keying the guard on `generatedAt` alone
 * missed the reading that matters. `generatedAt` is refreshed by EVERY run, so
 * re-deriving the snapshot over its own recorded range — which is exactly how
 * this artifact gets checked — writes a fresh stamp over an arbitrarily old
 * population and the age guard answers `ok`. `main` bounds `--to` from ABOVE
 * (it must be a complete UTC day) and not from below, so nothing stops a walk
 * of a range from last year.
 *
 * THE MINIMUM, AND THE FIRST VERSION'S REASON FOR THE MAXIMUM WAS UNPRODUCIBLE.
 * It said a quiet workflow with an older window must not make the whole
 * snapshot read as stale — but the generator writes the SAME `to` for every
 * workflow (`{ from: usedFrom, to }`: only the start is narrowed), so the
 * committed artifact has exactly one distinct `to` and the two reducers agree
 * on anything this generator produces. They differ only on a snapshot that was
 * PARTIALLY refreshed — hand-edited, or merged from two runs — and there the
 * minimum is the one that notices, which is what a staleness guard is for.
 */
export const oldestRangeEnd = (snapshot: Readonly<Record<string, JobSample>>): string => {
  let oldest = '';
  for (const sample of Object.values(snapshot)) {
    if (oldest === '' || sample.to < oldest) oldest = sample.to;
  }
  return oldest;
};

const loadSnapshot = (): Record<string, JobSample> =>
  parseSnapshot(readFileSync(SNAPSHOT_PATH, 'utf8'), SNAPSHOT_PATH);

const snapshotGeneratedAt = (): unknown => {
  // GUARDED, because a bare `JSON.parse` here is the exact source-echo venue
  // `parseSnapshot` exists to close: Node embeds the offending text in the
  // error, and this file is committed, so a PR edits it freely. It is
  // unreachable today only because `loadSnapshot()` runs first at module scope
  // and throws the sanitised message — a property of statement ORDER, which is
  // one reorder away from not holding.
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch {
    throw new Error(`${SNAPSHOT_PATH} is not valid JSON; regenerate it`);
  }
  return isMapping(raw) ? raw['generatedAt'] : undefined;
};

type FindingKind =
  | 'too-tight'
  | 'not-in-snapshot'
  | 'exemption-now-covered'
  | 'exemption-for-absent-job'
  | 'snapshot-job-not-declared'
  | 'unreadable-workflow';

/**
 * `job` and `range` are ALREADY SANITISED — `finding` below is the only
 * constructor, and it is what sanitises. Numbers cannot carry a payload.
 */
interface Finding {
  readonly kind: FindingKind;
  // `Safe`, not `string`. Typing these `string` shipped the brand's helpers and
  // opted out of the type that makes them unforgettable: dropping BOTH
  // sanitisers from `finding` below produced zero `tsc` errors and left all 42
  // cases green — measured. The whole argument for the brand, in the shared
  // module's own header, is that a forgotten sanitiser becomes a compile error
  // rather than a review finding, and a consumer typing its fields `string`
  // quietly declines that.
  readonly job: Safe;
  readonly bound?: number;
  readonly max?: number;
  readonly headroom?: number;
  readonly range?: Safe;
}

/** The single construction point; see the note on `Finding`. */
const finding = (
  kind: FindingKind,
  job: string,
  // `range` is destructured OUT rather than spread with the rest: spreading it
  // put the raw `string` into the object type ahead of the sanitised override,
  // so the compiler saw `range: string` and the brand could not hold. The
  // unsanitised field must not be spreadable at all.
  { range, ...numbers }: { bound?: number; max?: number; headroom?: number; range?: string } = {},
): Finding => ({
  kind,
  // A job key is `<file>/<job>` and a fork controls BOTH halves, each with its
  // own legal shape — see `safeKey` in the shared module, which splits it and
  // is where the boundary cast lives.
  job: safeKey(job),
  ...numbers,
  // `safeRange`, not `safeText`. The range comes from the committed snapshot
  // with no shape check, a PR may edit that file, and it lands at the END of a
  // `too-tight` line with budget to spare — enough to read as a whole finding
  // about another job. Same argument as `safeJobId`, same fix.
  ...(range === undefined ? {} : { range: safeRange(range) }),
});

/**
 * The whole verdict, as a pure function of its two inputs.
 *
 * EXTRACTED BECAUSE THE FIRST CUT WAS UNFENCEABLE. Written as assertions that
 * read the real tree directly, all thirteen of its arms survived mutation —
 * every one. The reason is structural rather than careless: this fence asserts
 * properties of a tree that SATISFIES them, so a broken check and a working one
 * produce the same empty list. Only the eight probes that broke the real
 * subject on a scratch copy discriminated at all.
 *
 * A pure auditor can be handed a tree that FAILS, so each arm has a case that
 * reds when the arm is deleted. The real-tree assertion below then rides on top
 * of machinery the suite has actually exercised.
 */
export const auditHeadroom = (
  declared: ReadonlyMap<string, number | undefined>,
  snapshot: Readonly<Record<string, JobSample>>,
  exempt: Readonly<Record<string, string>>,
  unreadable: readonly Safe[] = [],
): Finding[] => {
  const findings: Finding[] = [];

  for (const [job, bound] of declared) {
    const sample = snapshot[job];
    if (sample === undefined) {
      // An absent entry and a job that simply never ran are indistinguishable
      // from the data, so the exemption list is what tells them apart.
      if (!Object.hasOwn(exempt, job)) findings.push(finding('not-in-snapshot', job));
      continue;
    }
    // An absent bound is the SIBLING fence's finding, not this one's. Two
    // fences reporting one defect makes a single edit red both, and neither
    // message is then the useful one.
    if (bound === undefined) continue;
    const headroom = (bound * 60) / sample.max;
    // `Number.isFinite`, and it is load-bearing twice over. A `max` of 0 makes
    // headroom `Infinity`, and `Infinity < MIN_HEADROOM` is FALSE — so every
    // bound on that job passed silently. The same false-comparison hides a
    // `NaN` from a non-numeric bound, which is why deleting the `undefined`
    // guard above was UNKILLABLE until this line existed: the fallthrough
    // produced `NaN` and the case asserting `[]` got `[]` either way.
    if (!Number.isFinite(headroom) || headroom < MIN_HEADROOM) {
      findings.push(
        finding('too-tight', job, {
          bound,
          max: sample.max,
          headroom,
          range: `${sample.from}..${sample.to}`,
        }),
      );
    }
  }

  for (const job of Object.keys(exempt)) {
    if (snapshot[job] !== undefined) findings.push(finding('exemption-now-covered', job));
    else if (!declared.has(job)) findings.push(finding('exemption-for-absent-job', job));
  }

  for (const job of Object.keys(snapshot)) {
    if (!declared.has(job)) findings.push(finding('snapshot-job-not-declared', job));
  }

  for (const file of unreadable) findings.push(finding('unreadable-workflow', `${file}/`));

  return findings;
};

const render = (findings: readonly Finding[]): string[] =>
  // THROUGH `boundedList`, not a bare `.map`. Per-field clamping bounds a LINE;
  // nothing in `auditHeadroom` bounds the COUNT, and a fork may add keys to the
  // committed snapshot freely — 5,000 of them yield 5,000
  // `snapshot-job-not-declared` lines, each individually safe, burying the one
  // `too-tight` finding a reader needs. The sibling fence learned this in its
  // round 2 and this file shipped without the half, because the extraction that
  // shared the sanitisers left the list cap behind.
  //
  // Interpolation is unguarded BY CONTRACT: `finding` sanitised every string
  // field, and the rest are numbers.
  boundedList(
    // `too-tight` FIRST: BURIAL-PREVENTION, and also ordering.
    //
    // A previous revision of this comment demoted it to ordering alone, on the
    // ground that the round-robin cap holds a place for every file whatever the
    // order. That holds only while the groups FIT: a fork controls the number
    // of files, and with more groups than the cap one loses its line entirely,
    // decided by order. Measured — 20 fork files with one finding each plus a
    // genuine `too-tight`, unsorted: the genuine line is dropped. The demotion
    // came from generalising a narrower measurement (20 findings inside ONE
    // file, a single group, genuinely unaffected).
    //
    // The retraction reached the two case comments a round before it reached
    // THIS line, which is the site a future editor reads before deleting the
    // sort — so the correction is here now, at the definition.
    [...findings]
      .sort((a, b) => Number(b.kind === 'too-tight') - Number(a.kind === 'too-tight'))
      .map(
      (f) =>
        (f.kind === 'too-tight'
          ? `${f.job}: ${f.bound} min against ${f.max} s observed ` +
            `(${(f.headroom ?? Number.NaN).toFixed(2)}x, floor ${MIN_HEADROOM}x) in ${f.range}`
          : `${f.job}: ${f.kind}`) as Safe,
      ),
  );

const { jobs: DECLARED, unreadable: UNREADABLE } = declaredJobs();
const SNAPSHOT = loadSnapshot();

/** A one-job tree, for the arms the real tree cannot exhibit. */
const tree = (bound: number | undefined) => new Map([['w.yml/j', bound]]);
const snap = (max: number) => ({ 'w.yml/j': { max, from: 'a', to: 'b' } });

describe('no workflow job is bounded too tightly to survive its own longest run', () => {
  it('the committed snapshot is not stale', () => {
    // THE ACCEPTANCE ITEM THIS FENCE SHIPPED WITHOUT. go-to-k/cdkd#3283 asks
    // for the ratio assertion "plus a staleness guard", and the three
    // STRUCTURAL guards were built while the one the phrase most plainly
    // means — age — was not. Maxima only grow as jobs get slower, so a snapshot
    // nobody refreshes fails in the passing direction.
    expect(auditSnapshotAge(snapshotGeneratedAt(), Date.now())).toBe('ok');
    // AND the DATA's age, not just the stamp's. These are different questions
    // and only the second one is about the population the verdicts rest on —
    // see `oldestRangeEnd`. `to` is `YYYY-MM-DD`, which `Date.parse` reads as
    // UTC midnight, so the same guard answers both.
    expect(auditSnapshotAge(oldestRangeEnd(SNAPSHOT), Date.now())).toBe('ok');
  });

  it('the real tree reports nothing', () => {
    expect(render(auditHeadroom(DECLARED, SNAPSHOT, RARELY_RUN, UNREADABLE))).toEqual([]);
  });

  it('the inputs it attests to are actually there', () => {
    // Floors: a snapshot that silently became `{}`, or a walk that stopped
    // matching, would make every case above pass by having nothing to check.
    // Both halves are here for shape, and NEITHER is fenced: with every job
    // carrying both a bound and an entry, `compared` was identically `DECLARED`
    // until a job arrived without an entry (21 against 22 today)
    // and `MIN_COMPARED` duplicates `MIN_DECLARED`. An earlier revision claimed
    // the synthetic cases pinned them; they do not. It is kept because the day
    // a job loses its entry, this is the count that notices.
    const compared = [...DECLARED].filter(([k, b]) => b !== undefined && SNAPSHOT[k] !== undefined);
    expect(DECLARED.size).toBeGreaterThanOrEqual(MIN_DECLARED);
    expect(Object.keys(SNAPSHOT).length).toBeGreaterThanOrEqual(MIN_SNAPSHOT);
    expect(compared.length).toBeGreaterThanOrEqual(MIN_COMPARED);
    // The floors must also be CLOSE to the real magnitudes. `X >= 0` is true
    // whatever X is, so a floor set to zero is not a floor — measured: all three
    // survived being neutralised until these three lines existed. Proportional
    // rather than a fixed margin, so that adding a workflow does not red an
    // unrelated PR.
    expect(MIN_DECLARED * 2).toBeGreaterThanOrEqual(DECLARED.size);
    // And a TIGHT lower bound, because `* 2` is not one: lowering all three
    // floors together to 14, or to 11, left every case here green — so the band
    // permitted exactly the round-1 defect it was added to catch. Four jobs is
    // the measured size of that defect; the floor may not sit further than that
    // below the real count, and may never exceed it.
    //
    // THIS IS A RATCHET, and a PR that ADDS A JOB has to turn it: at 22 jobs
    // `MIN_DECLARED` must rise to at least 19. That is deliberate rather than
    // an oversight of the "proportional band" an earlier revision of this
    // comment claimed — a proportional band cannot tell 12 from 18, which is
    // how the round-1 defect cleared it. Adding a job needs two steps and the
    // second is the one that surprises: the new job has no successful run on
    // `main` yet, so it has no snapshot entry and reports `not-in-snapshot`
    // until the generator is re-run after the merge. Until then it belongs in
    // `RARELY_RUN` with THAT as its reason — "added in #N, no successful run on
    // main yet" is a true reason, and a true reason is the whole requirement
    // the list's own note makes.
    expect(MIN_DECLARED).toBeGreaterThan(DECLARED.size - 4);
    expect(MIN_DECLARED).toBeLessThanOrEqual(DECLARED.size);
    // MAGNITUDE, not just COUNT. Every floor above counts ENTRIES, and setting
    // every `max` in the snapshot to 1 left all 72 cases green — a snapshot
    // regenerated over a quiet window, or by a walk that stopped early, makes
    // every `too-tight` verdict vacuous while passing every count. The longest
    // job in the tree is the one figure that cannot be small in an honest
    // snapshot: `hooks.yml/hook-suites` was measured at 1587 s, and that is the
    // job the whole fence was written for.
    const longest = Math.max(...Object.values(SNAPSHOT).map((s) => s.max));
    expect(longest).toBeGreaterThanOrEqual(MIN_LONGEST_MAX);
    // Banded from the other side for the same reason as the counts: `X >= 0`
    // is not a floor, so a `MIN_LONGEST_MAX` neutralised to zero must red here.
    expect(MIN_LONGEST_MAX * 4).toBeGreaterThanOrEqual(longest);
    // AND BELOW THE SECOND-LONGEST JOB, which is the band that actually binds.
    // `* 4` let the floor be raised to 1000 with every case still green, and a
    // floor above the second-longest (`docs-deploy.yml/build`, 902 s) is one
    // that reds an HONEST snapshot the moment go-to-k/cdkd#3282 takes
    // `hook-suites` under its target — the failure mode that made 900 wrong.
    const [, second] = Object.values(SNAPSHOT)
      .map((s) => s.max)
      .sort((a, b) => b - a);
    expect(MIN_LONGEST_MAX).toBeLessThan(second ?? 0);
    // The snapshot floors are PINNED TO `MIN_DECLARED`, not banded separately.
    // A proportional band cannot tell 12 from 18 — both clear a 21-entry
    // snapshot — so at 12 the round-1 defect, four jobs vanishing, passed the
    // floor that exists to catch exactly that. Every declared job must have an
    // entry (the `not-in-snapshot` arm enforces it), so the three floors are
    // one number by construction and moving one alone is the error.
    expect(MIN_SNAPSHOT).toBe(MIN_DECLARED);
    expect(MIN_COMPARED).toBe(MIN_DECLARED);
  });
});

describe('the auditor reports what it claims to', () => {
  it.each([
    ['just under the floor', 1801],
    ['well under the floor', 3000],
    ['a job longer than its own bound', 5400],
  ])('a bound %s is reported', (_what, max) => {
    // 60 min = 3600 s, so a max ABOVE 1800 puts headroom below 2x. The
    // direction is worth stating because it is easy to invert: a LARGER
    // observed max means LESS headroom, and the first cut of this table used
    // small maxima and asserted they were too tight.
    expect(auditHeadroom(tree(60), snap(max), {}).map((f) => f.kind)).toEqual(['too-tight']);
  });

  it('a generous bound is not reported', () => {
    expect(auditHeadroom(tree(60), snap(100), {})).toEqual([]);
  });

  it('a bound EXACTLY on the floor passes', () => {
    // `>=` because go-to-k/cdkd#3283 writes `>=`. An earlier revision of this
    // comment justified it from go-to-k/cdkd#3282 instead, claiming that issue
    // targets a bound sitting exactly on this floor; it targets one above it.
    // The behaviour is unchanged and the reason is now the real one.
    expect(auditHeadroom(tree(60), snap(1800), {})).toEqual([]);
    expect(auditHeadroom(tree(60), snap(1801), {}).map((f) => f.kind)).toEqual(['too-tight']);
  });

  it('a job with no bound is left to the sibling fence', () => {
    expect(auditHeadroom(tree(undefined), snap(100000), {})).toEqual([]);
  });

  it('a job missing from the snapshot is reported unless exempt', () => {
    expect(auditHeadroom(tree(60), {}, {}).map((f) => f.kind)).toEqual(['not-in-snapshot']);
    expect(auditHeadroom(tree(60), {}, { 'w.yml/j': 'gated on a release' })).toEqual([]);
  });

  it('an exemption that is no longer needed is reported', () => {
    expect(
      auditHeadroom(tree(60), snap(10), { 'w.yml/j': 'stale' }).map((f) => f.kind),
    ).toEqual(['exemption-now-covered']);
  });

  it('an exemption for a job the tree no longer has is reported', () => {
    expect(auditHeadroom(new Map(), {}, { 'gone.yml/j': 'stale' }).map((f) => f.kind)).toEqual([
      'exemption-for-absent-job',
    ]);
  });

  it('a real unparseable workflow is reported by FILE, never by its content', () => {
    // Through `declaredJobs` against a scratch copy, not a hand-built list:
    // the `catch` is what must not carry the fork's YAML, and pushing anything
    // other than the bare file name survived every other case.
    const marker = 'FORGED-YAML-ECHO';
    const scratch = mkdtempSync(join(tmpdir(), 'cdkd-headroom-'));
    try {
      cpSync(WORKFLOW_DIR, scratch, { recursive: true });
      writeFileSync(join(scratch, 'zz-evil.yml'), `jobs:\n  a: [\n  ${marker}\n`);
      const { unreadable } = declaredJobs(scratch);
      expect(unreadable).toEqual(['zz-evil.yml']);
      expect(render(auditHeadroom(new Map(), {}, {}, unreadable))).toEqual([
        'zz-evil.yml/: unreadable-workflow',
      ]);
      expect(JSON.stringify(unreadable)).not.toContain(marker);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('only YAML files in the directory are read', () => {
    // The `.ya?ml$` filter. Without it `declaredJobs` hands a README, an
    // editor's `.yml.bak`, or a stray script to `parseYaml`, and each lands in
    // `unreadable` as a finding naming a file nobody can fix — indistinguishable
    // in the rendered line from a genuinely broken workflow. `.yaml` must still
    // be read: nothing stops a workflow using it. The `$` is load-bearing on
    // its own — `c.yml.bak` is what catches its loss.
    //
    // The `.sort()` beside the filter is NOT pinned, and no honest case is
    // available: `readdirSync` returned already-sorted names in every probe on
    // this host (40 of 40 with random names, macOS/APFS), so a case would pass
    // with the call deleted. It stays for determinism on a filesystem that does
    // not, and this note is what a reader gets instead of a green case proving
    // nothing.
    const scratch = mkdtempSync(join(tmpdir(), 'cdkd-headroom-ext-'));
    try {
      writeFileSync(join(scratch, 'a.yml'), 'jobs:\n  one: {}\n');
      writeFileSync(join(scratch, 'b.yaml'), 'jobs:\n  two: {}\n');
      writeFileSync(join(scratch, 'README.md'), '# not a workflow\n');
      writeFileSync(join(scratch, 'c.yml.bak'), 'jobs:\n  [\n');
      const { jobs, unreadable } = declaredJobs(scratch);
      expect([...jobs.keys()]).toEqual(['a.yml/one', 'b.yaml/two']);
      expect(unreadable).toEqual([]);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('a hostile workflow FILE NAME is sanitised at the push, not at the reader', () => {
    // THE SEVENTH VENUE, and the first that is not a rendered line: the
    // ASSERTION path. `expect(unreadable).toEqual([...])` prints this array in
    // vitest's failure diff at column 0, and pretty-format escapes `"` and `\`
    // and nothing else — not LF, not U+202E, not U+0085. Pushing the raw name
    // kept every other case green, because the only name they use is benign
    // and `safeName` is the identity on it.
    //
    // A real file name CAN carry a newline on both macOS and Linux, so this is
    // a fork's actual capability, not a synthetic one.
    const scratch = mkdtempSync(join(tmpdir(), 'cdkd-headroom-name-'));
    try {
      const hostile = 'zz\n::error::forged.yml';
      writeFileSync(join(scratch, hostile), 'jobs:\n  a: [\n');
      const { unreadable } = declaredJobs(scratch);
      expect(unreadable).toHaveLength(1);
      // TWO transformations, and the case names both because the first alone
      // is not enough. `safeName` FLATTENS the newline to a space — so no byte
      // of it can start a line, in the diff or in a rendered finding — and then
      // QUOTES the result, which is what stops a name that carries no control
      // byte at all from reading as a complete finding about another workflow.
      expect(unreadable[0]).not.toContain('\n');
      expect(unreadable[0]).toBe('"zz ::error::forged.yml"');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('an unreadable workflow is a finding, and its message is never rendered', () => {
    // The arm `FindingKind` declared and nothing constructed. A YAML parse error
    // quotes the fork's own source; only the FILE is named.
    //
    // `safeName`, not a bare literal: typing the parameter `Safe` made this
    // line a TYPE ERROR, which is the brand working — a caller can no longer
    // hand the auditor an unsanitised file name, in a case or in production.
    const found = auditHeadroom(new Map(), {}, {}, [safeName('evil.yml')]);
    expect(found.map((f) => f.kind)).toEqual(['unreadable-workflow']);
    expect(render(found)).toEqual(['evil.yml/: unreadable-workflow']);
  });

  it.each([
    ['a hostile JOB half is quoted', 'a.yml/j: not-in-snapshot - and ci', true],
    ['an ordinary job id is not', 'a.yml/check-build-test', false],
    ['an EMPTY job half is not', 'a.yml/', false],
  ])('%s', (_what, key, quoted) => {
    // THE JOB HALF IS AS FORK-CONTROLLED AS THE FILE HALF and was getting only
    // `safeText`, which flattens and clamps — neither of which touches the
    // threat: the string below is pure ASCII and reads as a complete finding
    // about another job. Quoting is what separates them, and the two negative
    // rows are what stops a fix that simply quotes everything: the ordinary
    // case must stay readable, and an empty half must not render as `""`.
    const line = render(auditHeadroom(new Map([[key, 60]]), {}, {}))[0] ?? '';
    const job = line.slice(line.indexOf('/') + 1, line.indexOf(':', line.indexOf('/')));
    expect(job.startsWith('"')).toBe(quoted);
  });

  it('a key with no separator is rendered as one name, not split in two', () => {
    // `indexOf` returns -1 for a key a fork put in the snapshot without a `/`,
    // and the inline version this replaced then did `slice(0, -1)` — DROPPING
    // THE LAST CHARACTER — and `slice(0)`, re-emitting the whole key as the job
    // half. Measured: `evil` rendered as `"evi"/evil`.
    const line = render(auditHeadroom(new Map(), { evil: { max: 1, from: 'a', to: 'b' } }, {}))[0] ?? '';
    expect(line).toBe('"evil": snapshot-job-not-declared');
  });

  it('a flood of findings is capped, not printed in full', () => {
    // PER-FIELD CLAMPING BOUNDS A LINE; NOTHING BOUNDED THE COUNT. The snapshot
    // is a committed file a PR may edit, so a fork can add as many keys as it
    // likes and each becomes a `snapshot-job-not-declared` finding. None of
    // them forges a line — they are all sanitised — but 5,000 of them bury the
    // one `too-tight` finding the reader has to act on, which is the same harm
    // one layer up. The sibling fence capped this in ITS round 2; the
    // extraction that shared the sanitisers left the cap behind.
    const flood: Record<string, JobSample> = {};
    for (let i = 0; i < 5000; i += 1) flood[`x.yml/j${i}`] = { max: 1, from: 'a', to: 'b' };
    const lines = render(auditHeadroom(new Map(), flood, {}));
    expect(lines).toHaveLength(21);
    expect(lines.at(-1)).toMatch(/^… and 4980 more( \(not all shown for: |$)/);
  });

  it('the actionable kind is rendered first', () => {
    // ORDER, which is one of the two things the sort buys. The other is
    // burial-prevention once the groups outnumber the cap — see the case below,
    // and the note at the sort itself, which now carries the retraction of a
    // revision that demoted it to this half alone.
    const declared = new Map<string, number | undefined>([
      ['aaa.yml/absent', 60],
      ['zzz.yml/tight', 60],
    ]);
    const lines = render(auditHeadroom(declared, { 'zzz.yml/tight': { max: 3600, from: 'a', to: 'b' } }, {}));
    expect(lines[0]).toContain('zzz.yml/tight');
    expect(lines[0]).toContain('min against');
  });

  it('a starved workflow is NAMED FIRST, even when its line is crowded out', () => {
    // ROUND-ROBIN HOLDS A PLACE FOR EVERY GROUP ONLY WHILE THE GROUPS FIT. A
    // fork controls the number of FILES, so 21 groups against a cap of 20 means
    // one gets nothing — and it is chosen by insertion order, which is
    // directory order, which the fork also picks. No fixed budget can promise a
    // particular LINE survives that. What it can promise is that the starved
    // workflow is NAMED, and that is what this pins: `incomplete` is ranked by
    // kept-count ascending, so the group that got nothing leads the list.
    //
    // An earlier revision of this case put the fork's jobs in the SNAPSHOT,
    // where `auditHeadroom` emits them after the declared loop, so the genuine
    // finding was always first and nothing was ever buried — it asserted a
    // property its own fixture could not exhibit, and the comment claimed a
    // measurement that could not hold. The fork's jobs are declared here.
    const declared = new Map<string, number | undefined>();
    for (let i = 0; i < 20; i += 1) declared.set(`aaa${String(i).padStart(2, '0')}.yml/j`, 60);
    declared.set('zzz.yml/real', 60);
    const snapshot: Record<string, JobSample> = {};
    for (const key of declared.keys()) snapshot[key] = { max: 3600, from: 'a', to: 'b' };
    const summary = render(auditHeadroom(declared, snapshot, {})).at(-1) ?? '';
    expect(summary).toContain('not all shown for: zzz.yml');
  });

  it('a real finding survives a flood designed to bury it', () => {
    // BURIAL-PREVENTION, AND ALSO ORDERING. A previous revision of this comment
    // demoted it to ordering alone, on the ground that round-robin holds a
    // place for every file whatever the order. That is true only while the
    // groups FIT: a fork controls the number of files, and with 21 groups
    // against a cap of 20 one group loses its line entirely — which one is
    // decided by order. Measured: 20 fork files with one finding each plus a
    // genuine `too-tight`, unsorted, drops the genuine one and does not even
    // name it among the five in the summary.
    //
    // The demotion came from generalising a narrower measurement (20 findings
    // inside ONE file, which is a single group and genuinely unaffected).
    const declared = new Map<string, number | undefined>();
    for (let i = 0; i < 40; i += 1) declared.set(`aaa.yml/j${i}`, 60);
    declared.set('zzz.yml/real', 60);
    const snapshot = { 'zzz.yml/real': { max: 3600, from: 'a', to: 'b' } };
    const lines = render(auditHeadroom(declared, snapshot, {}));
    expect(lines).toHaveLength(21);
    expect(lines[0]).toContain('zzz.yml/real');
    expect(lines[0]).toContain('min against');
  });

  it('a snapshot entry for a job the tree does not declare is reported', () => {
    expect(auditHeadroom(new Map(), snap(10), {}).map((f) => f.kind)).toEqual([
      'snapshot-job-not-declared',
    ]);
  });

  it.each([
    ['a quoted number', '5'],
    ['a mapping', { a: 1 }],
    ['null', null],
  ])('a bound that is %s reads as ABSENT, not as a number', (_what, bound) => {
    // `NaN < 2` is FALSE, so a bound that survived as a non-number would make
    // this fence PASS a job it cannot evaluate. Reading it as absent hands the
    // job to the sibling fence, which is the one that refuses the shape.
    const doc = { jobs: { j: { 'timeout-minutes': bound } } };
    expect(jobsFromWorkflow('w.yml', doc).get('w.yml/j')).toBeUndefined();
    expect(auditHeadroom(jobsFromWorkflow('w.yml', doc), snap(100000), {})).toEqual([]);
  });

  it.each([
    // `null` FIRST, because it is the reachable one: `parseYaml` answers null
    // for an empty or comment-only workflow, `typeof null === 'object'` slips
    // past a bare `typeof`, and `declaredJobs()` runs at MODULE SCOPE — so a
    // missing `isMapping(doc)` takes this file's whole collection down with a
    // TypeError instead of reporting anything. The parallel `displayNameToKey`
    // table has had this row since round 1; this one did not.
    ['a null document', null, []],
    ['a document that is not a mapping', 7, []],
    ['a document with no jobs key', { name: 'x' }, []],
    ['a jobs node that is not a mapping', { jobs: 'x' }, []],
    ['a jobs node that is a NON-EMPTY array', { jobs: ['x'] }, []],
    // A job node that EXISTS is still declared — with no bound, which hands it
    // to the sibling fence. `null` is the reachable one: `jobs:\n  j:\n` is
    // legal YAML and `parseYaml` gives a null node, `typeof null === 'object'`
    // slips past a bare `typeof` check, and `declaredJobs()` runs at MODULE
    // SCOPE — so a missing `isMapping(node)` takes this file's whole collection
    // down with a TypeError, which is the outcome this table exists to prevent.
    // Deleting that guard was green until this row existed.
    ['a job node that is not a mapping', { jobs: { j: 'x' } }, [['w.yml/j', undefined]]],
    ['a null job node', { jobs: { j: null } }, [['w.yml/j', undefined]]],
  ])('%s yields no declared jobs rather than throwing', (_what, doc, expected) => {
    // The expectation is a COLUMN, not a comparison against the case label: an
    // `it.each` body that branches on its own `_what` string asserts whatever
    // the label says, so a mislabelled row checks the wrong thing silently.
    expect([...jobsFromWorkflow('w.yml', doc)]).toEqual(expected);
  });

  it('a numeric bound survives the same path', () => {
    expect(jobsFromWorkflow('w.yml', { jobs: { j: { 'timeout-minutes': 30 } } }).get('w.yml/j')).toBe(30);
  });

  it('a max of zero is reported, not treated as infinite headroom', () => {
    // `parseSnapshot` refuses this, so the only way in is a direct call — which
    // is exactly why the guard survived mutation until this case existed. The
    // arithmetic is the trap: 3600/0 is `Infinity`, and `Infinity < 2` is
    // FALSE, so without the finite check every bound on that job passes.
    const found = auditHeadroom(tree(60), { 'w.yml/j': { max: 0, from: 'a', to: 'b' } }, {});
    expect(found.map((f) => f.kind)).toEqual(['too-tight']);
  });

  it.each([
    ['the job key', (hostile: string) => auditHeadroom(new Map([[`w.yml/${hostile}`, 60]]), { [`w.yml/${hostile}`]: { max: 3600, from: 'a', to: 'b' } }, {})],
    ['the range', (hostile: string) => auditHeadroom(tree(60), { 'w.yml/j': { max: 3600, from: hostile, to: 'b' } }, {})],
  ])('a hostile %s cannot forge a second line', (_what, build) => {
    // Both are fork-controlled on `pull_request`: a job key comes from a
    // workflow file, and a range from the committed snapshot, which a PR can
    // edit. go-to-k/cdkd#3272 found this class FOUR times, each inside the fix
    // for the previous one, so a fifth venue is the default assumption.
    //
    // WHAT THIS CASE PINS IS FLATTENING, NOT QUOTING. Both assertions below are
    // satisfied by `flatten` alone, and the forgery the title names needs
    // neither byte — a pure-ASCII payload reads as a second finding with every
    // control character removed. The quoting halves are pinned by the hostile
    // FILE-half and hostile-range cases nearby, so this is redundant rather
    // than false; the note is here because a comment claiming more than its
    // assertions check is how three defects in this PR stayed green.
    const hostile = `x${String.fromCodePoint(0x0a)}  ci.yml / check-build-test: FORGED${String.fromCodePoint(0x202e)}`;
    const lines = render(build(hostile));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(String.fromCodePoint(0x0a));
    expect(lines[0]).not.toContain(String.fromCodePoint(0x202e));
    // And the quoting, so the title is not a claim this case declines to make.
    expect(lines[0]).toContain('"');
  });

  it.each([
    ['a hostile range is quoted', 'a..b 1 min against 9 s observed (0.01x, floor 2x', true],
    ['a real range is not', '2026-09-02..2026-09-16', false],
  ])('%s', (_what, range, quoted) => {
    // THE RANGE IS FORK-EDITABLE AND SITS AT THE END OF THE LINE, which is the
    // easiest place to append a second finding: `parseSnapshot` takes it with
    // `String(value['from'] ?? '')` and no shape check, the snapshot is a
    // committed file a PR may edit, and 120 characters is ample. `safeText`
    // flattens and clamps, neither of which touches pure ASCII — swapping
    // `safeRange` for it left every case green, and so did widening the range
    // pattern to match anything.
    // `finding` receives the range already joined, so the halves are split here
    // only to feed `JobSample`; a hostile value goes in whole as `from`.
    const dots = range.indexOf('..');
    const snapshot = {
      'w.yml/j': { max: 3600, from: range.slice(0, dots), to: range.slice(dots + 2) },
    };
    const line = render(auditHeadroom(tree(60), snapshot, {}))[0] ?? '';
    const rendered = line.slice(line.lastIndexOf(' in ') + 4);
    expect(rendered.startsWith('"')).toBe(quoted);
  });

  it('the rendered line carries the numbers a reader needs to act', () => {
    // A bare "too tight" would send the reader back to the API. The line has to
    // say what the bound is, what it is up against, and over which range — the
    // three things that decide whether to raise the bound or shorten the job.
    const line = render(auditHeadroom(tree(60), snap(3600), {}))[0] ?? '';
    // The `too-tight` line renders its NUMBERS rather than its kind — they are
    // what a reader acts on. The kind is load-bearing on the other branch,
    // asserted in the unreadable-workflow case above, where there are no
    // numbers and the kind is the entire message.
    expect(line).toContain('60 min');
    expect(line).toContain('3600 s');
    expect(line).toContain('1.00x');
    expect(line).toContain('a..b');
    // The FLOOR too: without this, `floor ${MIN_HEADROOM}x` could render any
    // number and every case stayed green. It is half of what the reader acts
    // on — 1.00x means nothing without the 2x it is short of.
    expect(line).toContain('floor 2x');
  });
});

describe('the generator resolves an API job name to a declared key', () => {
  // `resolveJobKey` and `displayNameToKey` are the two pure halves of the
  // defect that made five jobs vanish. They live in the generator, which is a
  // manual network tool with no suite of its own, so they are pinned here: the
  // network calls, the halving loop and the flag refusals can stay untested,
  // but the NAME MAPPING cannot — it is what silently emptied the snapshot.
  const doc = {
    jobs: {
      plain: { 'runs-on': 'x' },
      renamed: { name: 'English-only (pull request)' },
      sibling: { name: 'English-only (issue / comment)' },
    },
  };
  const map = displayNameToKey('w.yml', doc);

  it('maps a job with no name: by its key', () => {
    expect(resolveJobKey('plain', map)).toBe('w.yml/plain');
  });

  it('maps a job with a name: by that name, not its key', () => {
    expect(resolveJobKey('English-only (pull request)', map)).toBe('w.yml/renamed');
    // And the KEY must not resolve — the API never sends it for a renamed job,
    // so accepting it would only mask a mapping that had stopped working.
    expect(resolveJobKey('renamed', map)).toBeUndefined();
  });

  it('does not pool two jobs whose names differ only by a parenthesised tail', () => {
    // The original bug: stripping ` (...)` unconditionally turned both of these
    // into `English-only` and merged two distinct jobs into one key.
    expect(resolveJobKey('English-only (pull request)', map)).toBe('w.yml/renamed');
    expect(resolveJobKey('English-only (issue / comment)', map)).toBe('w.yml/sibling');
  });

  it('strips a matrix leg only when the remainder resolves', () => {
    const legs = displayNameToKey('w.yml', { jobs: { compat: { 'runs-on': 'x' } } });
    expect(resolveJobKey('compat (22.12)', legs)).toBe('w.yml/compat');
    expect(resolveJobKey('compat (22.12) (extra)', legs)).toBeUndefined();
  });

  it('strips the LAST parenthesised group, not the first', () => {
    // THE `$` ANCHOR, and nothing else discriminated it: dropping it left the
    // `(extra)` row above answering `undefined` either way. A renamed job that
    // also has a matrix leg is the shape that separates them — the API sends
    // `English-only (pull request) (22.12)`, the anchored pattern removes the
    // LEG and resolves, the unanchored one removes the job's own parenthesised
    // tail and yields `English-only (22.12)`, which resolves to nothing. That
    // is the round-1 defect exactly: a real job VANISHING from the snapshot,
    // and the four jobs that override `name:` are the four this would hit.
    expect(resolveJobKey('English-only (pull request) (22.12)', map)).toBe('w.yml/renamed');
  });

  it('returns undefined for a name no job declares, rather than inventing a key', () => {
    expect(resolveJobKey('not a job', map)).toBeUndefined();
    expect(resolveJobKey('', map)).toBeUndefined();
  });

  it.each([
    ['a document that is not a mapping', 7],
    ['a document with no jobs', { name: 'x' }],
    ['a jobs node that is not a mapping', { jobs: 7 }],
    ['a null document', null],
    ['a null jobs node', { jobs: null }],
    ['a jobs node that is a NON-EMPTY array', { jobs: ['plain'] }],
  ])('%s yields an empty map rather than throwing', (_what, bad) => {
    // The array case pins `isMapping`'s THIRD clause, and only a non-empty one
    // does: `typeof [] === 'object'` and `[] !== null`, so without
    // `!Array.isArray` a `jobs:` written as a YAML sequence reaches
    // `Object.entries`, which hands back INDICES — a `w.yml/0` no workflow
    // declares. An empty array yields no entries either way, discriminating
    // nothing.
    // `null` is reachable and was unpinned in every one of these guards:
    // `parseYaml('')` returns null, and a bodiless `jobs:` gives a null node.
    // `typeof null === 'object'`, so only the explicit null test rejects them.
    expect([...displayNameToKey('w.yml', bad)]).toEqual([]);
  });

  it.each([
    ['a numeric name', 123, '123'],
    ['a boolean name', true, 'true'],
  ])('%s is keyed by what the API will actually send', (_what, name, sent) => {
    // Falling back to the job id here manufactures a job with no snapshot
    // entry — the state an exemption used to hide.
    const map = displayNameToKey('w.yml', { jobs: { j: { name } } });
    expect(resolveJobKey(sent, map)).toBe('w.yml/j');
    expect(resolveJobKey('j', map)).toBeUndefined();
  });

  it.each([
    ['a null node', { jobs: { j: null } }],
    ['a name that is null', { jobs: { j: { name: null } } }],
  ])('%s falls back to the job id', (_what, doc) => {
    expect(resolveJobKey('j', displayNameToKey('w.yml', doc))).toBe('w.yml/j');
  });
});

describe('the walk stops only when it can no longer learn anything', () => {
  // `walkMayStop` carries the snapshot's whole coverage guarantee, and until it
  // was extracted from `main()` the line that fixed it could be deleted without
  // a single case reddening.
  const seen = (entries: readonly [string, number][]) => new Map(entries);

  it('never stops before every declared job has been seen', () => {
    // THE ROUND-1 DEFECT. `b` has no entry, so its maximum is unknown and no
    // run can be ruled out yet — however short this one is. Production case:
    // `release.yml/publish` appeared in none of the runs the walk had fetched,
    // and the walk stopped after one of 387.
    expect(walkMayStop(['w/a', 'w/b'], seen([['w/a', 100]]), 1)).toBe(false);
  });

  it('stops once every job is seen and no later run can beat a maximum', () => {
    expect(walkMayStop(['w/a', 'w/b'], seen([['w/a', 100], ['w/b', 50]]), 50)).toBe(true);
    expect(walkMayStop(['w/a', 'w/b'], seen([['w/a', 100], ['w/b', 50]]), 49)).toBe(true);
  });

  it('keeps walking while a run could still contain a longer job', () => {
    // 51 > min(50), so a job in this run could still raise `b`'s maximum.
    expect(walkMayStop(['w/a', 'w/b'], seen([['w/a', 100], ['w/b', 50]]), 51)).toBe(false);
  });

  it('never stops on an empty maxima map', () => {
    // With nothing declared, `every` is vacuously true and `Math.min()` of
    // nothing is `Infinity` — which would make every run prunable.
    expect(walkMayStop([], seen([]), 1)).toBe(false);
  });
});

describe('the shared sanitisers constrain the shapes this fence renders', () => {
  it.each([
    // THE CANONICAL MEMBERS, which the first version of this class omitted
    // while reaching for the exotic ones a review had just named.
    ['U+206A INHIBIT SYMMETRIC SWAPPING (range start)', '\u206a'],
    ['U+206F NOMINAL DIGIT SHAPES (range end)', '\u206f'],
    ['U+E0100 VARIATION SELECTOR-17 (range start)', '\u{e0100}'],
    ['U+E01EF VARIATION SELECTOR-256 (range end)', '\u{e01ef}'],
    ['U+200B ZERO WIDTH SPACE (range start)', '\u200b'],
    ['U+200C ZERO WIDTH NON-JOINER (interior)', '\u200c'],
    ['U+200D ZERO WIDTH JOINER (range end)', '\u200d'],
    ['U+2060 WORD JOINER (range start)', '\u2060'],
    ['U+2062 INVISIBLE TIMES (interior)', '\u2062'],
    ['U+2064 INVISIBLE PLUS (range end)', '\u2064'],
    ['U+2800 BRAILLE PATTERN BLANK', '\u2800'],
    ['U+3164 HANGUL FILLER', '\u3164'],
    ['U+115F HANGUL CHOSEONG FILLER', '\u115f'],
    ['U+1160 HANGUL JUNGSEONG FILLER', '\u1160'],
    ['U+17B4 KHMER VOWEL INHERENT AQ', '\u17b4'],
    ['U+17B5 KHMER VOWEL INHERENT AA', '\u17b5'],
    ['U+180E MONGOLIAN VOWEL SEPARATOR', '\u180e'],
    ['U+FFA0 HALFWIDTH HANGUL FILLER', '\uffa0'],
    // BOTH ENDS OF EVERY RANGE, plus an interior point — the doctrine the
    // sibling fence adopted in its own round 3 and applied to its four ranges.
    // The two ranges ADDED here were not covered by it, so each could be
    // deleted outright or shrunk to a single code point with every case green:
    // the one-place-not-the-other shape, this time between an old rule and the
    // new code it should have governed.
    ['U+FFF9 INTERLINEAR ANNOTATION ANCHOR (range start)', '\ufff9'],
    ['U+FFFA INTERLINEAR ANNOTATION SEPARATOR (interior)', '\ufffa'],
    ['U+FFFB INTERLINEAR ANNOTATION TERMINATOR (range end)', '\ufffb'],
    ['U+E0000 (tag range start)', '\u{e0000}'],
    ['U+E0040 (tag range interior)', '\u{e0040}'],
    ['U+E007F CANCEL TAG (range end)', '\u{e007f}'],
  ])('%s renders blank but is not whitespace, so it is flattened', (_what, ch) => {
    // BLANK IS NOT THE SAME AS WHITESPACE, and `/\s/` matches none of these.
    // Each one RENDERS as a space, so a fork pads a forged finding with them
    // and the line reads as ordinary text while carrying no byte any earlier
    // check looked for. Measured on U+2800 in a real YAML parse error, which
    // is how the tenth venue was found; the rest of the class is here because
    // enumerating bad shapes one at a time is what produced ten venues.
    expect(flatten(`a${ch}b`)).toBe('a b');
  });

  it.each([
    ['a real range', '2026-09-02..2026-09-16', false],
    ['a range with a forged PREFIX', 'x: too-tight 2026-09-02..2026-09-16', true],
    ['a range with a forged SUFFIX', '2026-09-02..2026-09-16 and ci.yml: x', true],
  ])('%s', (_what, range, quoted) => {
    // BOTH ANCHORS. `^` and `$` were each droppable with every case green,
    // because the only range any case used was a well-formed one — and either
    // drop lets a forged finding ride along unquoted at the end of the line.
    expect(safeRange(range).startsWith('"')).toBe(quoted);
  });

  it('a clipped field CARRIES the clip marker, so it cannot read as whole', () => {
    // Deleting the `…` from `quoteClamped` left every case green, while
    // `safeText`'s identical marker has been pinned since its own round. A
    // field that was cut and does not say so is a field a reader trusts as
    // complete — the same failure as a dropped closing quote, one step milder.
    const clipped = quoteClamped(`x${'y'.repeat(500)}`);
    expect(clipped.endsWith('…"')).toBe(true);
    expect(() => JSON.parse(clipped) as unknown).not.toThrow();
  });

  it('a value whose QUOTED form is exactly the cap is not clipped', () => {
    // The `<=` boundary. With `<` a field that fits exactly is clipped anyway,
    // losing two characters and gaining a marker that says it was cut when it
    // was not — measured on 118 characters, whose quoted form is exactly 120.
    const exact = quoteClamped('x'.repeat(MAX_FIELD_LENGTH - 2));
    expect(exact).toHaveLength(MAX_FIELD_LENGTH);
    expect(exact).not.toContain('…');
  });

  it('a workflow that kept a line but LOST one is still named', () => {
    // NAMING ONLY THE ENTIRELY-SILENT GROUPS MISSES THE NEXT MOVE: leave a
    // workflow one line and push the interesting one out of its own group. A
    // fork controls both — it adds files, and the snapshot keys under a real
    // workflow are fork-editable. Measured before the fix: `hooks.yml` kept a
    // line, so it was not named, and a reader could not learn that one of its
    // findings had been dropped.
    const lines = boundedList([
      'hooks.yml/a: too-tight' as Safe,
      'hooks.yml/b: too-tight' as Safe,
      ...Array.from({ length: 19 }, (_, i) => `w${String(i).padStart(2, '0')}.yml/j: too-tight` as Safe),
    ]);
    expect(lines).toContain('hooks.yml/a: too-tight');
    expect(lines.at(-1)).toContain('hooks.yml');
  });

  it('the crowded-out list is itself capped, with a count for the rest', () => {
    // THE BURIAL ONE LAYER UP. A fork controls the number of groups, so an
    // uncapped name list puts thousands of names on a single log line — which
    // is the harm `boundedList` exists to prevent, reproduced inside its own
    // summary. Neither the five-name cap nor the `and N more` tail was pinned:
    // widening the slice, deleting the tail, and doing both were all green.
    const lines = boundedList(
      Array.from({ length: 27 }, (_, i) => `w${String(i).padStart(2, '0')}.yml/j: too-tight` as Safe),
    );
    const summary = lines.at(-1) ?? '';
    expect(summary).toContain('… and 7 more');
    expect(summary).toContain('and 2 more)');
    // EXACTLY FIVE names must NOT carry the tail: `>` -> `>=` renders
    // ", and 0 more", which reads as information and is noise.
    const atFive = boundedList(
      Array.from({ length: 25 }, (_, i) => `x${String(i).padStart(2, '0')}.yml/j: too-tight` as Safe),
    ).at(-1) ?? '';
    expect(atFive).not.toContain('and 0 more');
    // Five names, not twenty-seven.
    expect(summary.split(', ').filter((part) => part.includes('.yml')).length).toBe(5);
  });

  it('a long but legal job id is still clamped', () => {
    // `safeJobId`'s PASSING branch returned the raw id, so 5,000 legal
    // characters reached the line unclamped — the bound `MAX_FIELD_LENGTH`
    // exists to hold. `safeName` has this case from its own round-2 defect;
    // this helper was written from `safeName` and inherited the shape without
    // the case.
    expect(safeJobId('a'.repeat(5000)).length).toBeLessThanOrEqual(MAX_FIELD_LENGTH + 1);
  });

  it('a key is split at the FIRST slash, so the whole file name is the file half', () => {
    // `lastIndexOf` survived every case: a workflow file name cannot contain a
    // slash and a job id can, so only the first split puts the whole file name
    // in the half `safeName` constrains. With `lastIndexOf`, part of a
    // fork-chosen job id is handed to `safeName` instead.
    expect(safeKey('a.yml/deep/er')).toBe('a.yml/"deep/er"');
  });

  it('two IDENTICAL lines in a group are counted separately', () => {
    // A `Set` of strings cannot tell two identical lines apart, so a group with
    // a kept line and a dropped TWIN of it read as complete and went unnamed.
    // Reachable without an adversary: two job ids long enough to clamp render
    // the same text. The groups hold INDICES for this reason.
    const flood = Array.from(
      { length: 20 },
      (_, i) => `f${String(i).padStart(2, '0')}.yml/j: too-tight` as Safe,
    );
    const twin = 'dup.yml/j: too-tight' as Safe;
    const summary = boundedList([twin, twin, ...flood]).at(-1) ?? '';
    expect(summary).toContain('dup.yml');
  });

  it('a workflow that lost EVERY line outranks one that lost some', () => {
    // The ranking, which the widened filter silently demoted. `incomplete` is
    // built in insertion order — the same order the round-robin serves — so a
    // starved group is naturally LAST and is pushed out of the five names by
    // groups that merely lost a line. Measured before the ranking: a real
    // workflow's only finding was dropped from the log AND unnamed.
    // TWENTY fork files plus the genuine one is 21 groups against a cap of 20,
    // so exactly one group is starved. At 19 every group fits and nothing is
    // crowded out — a fixture that cannot exhibit the property it asserts.
    const flood: Safe[] = [];
    for (let i = 0; i < 20; i += 1) {
      flood.push(`f${String(i).padStart(2, '0')}.yml/a: too-tight` as Safe);
      flood.push(`f${String(i).padStart(2, '0')}.yml/b: too-tight` as Safe);
    }
    const summary = boundedList([...flood, 'zzz.yml/only: too-tight' as Safe]).at(-1) ?? '';
    expect(summary).toContain('not all shown for: zzz.yml');
  });

  it('a workflow crowded out entirely is NAMED, not silently absent', () => {
    // ROUND-ROBIN GIVES EVERY GROUP A SHARE ONLY WHILE THE GROUPS FIT. A fork
    // controls the NUMBER of files, so 21 of them with one finding each leave
    // one workflow with no line at all — and a reader cannot tell a workflow
    // that had nothing to report from one whose report was crowded out. Naming
    // them costs nothing: the keys are prefixes of lines already sanitised.
    const lines = boundedList(
      Array.from({ length: 21 }, (_, i) => `w${String(i).padStart(2, '0')}.yml/j: too-tight` as Safe),
    );
    expect(lines).toHaveLength(MAX_RENDERED_FINDINGS + 1);
    expect(lines.at(-1)).toContain('not all shown for: w20.yml');
  });

  it('a QUOTED workflow name is one group, however many spaces it carries', () => {
    // The SPACE member of the grouping class, which the `:` and `/` cases do
    // not reach. A quoted name renders as `"a.yml x" / j: …`, so without the
    // space two names that differ only after their first space fall into
    // different groups and one fork file takes many shares.
    const quoted = Array.from(
      { length: 10 },
      (_, i) => `"zz alpha${i}.yml" / j: too-tight` as Safe,
    );
    const lines = boundedList([
      ...quoted,
      ...Array.from({ length: 19 }, (_, i) => `w${String(i).padStart(2, '0')}.yml/j: too-tight` as Safe),
    ]);
    // ALL TEN survive. Cutting at the first space collapses them into one group
    // keyed `"zz`, which takes ONE share between them — nine real workflows
    // silently lose their line to a shared prefix a fork chooses.
    for (const line of quoted) expect(lines).toContain(line);
  });

  it.each([
    ['a quoted name containing an escaped quote', 'ev"'],
    ['a quoted name containing a backslash', 'ev\\'],
  ])('%s is one whole group', (_what, raw) => {
    // THE ESCAPE SCAN. Deleting it — searching for the next `"` — stops at the
    // ESCAPED one, so 22 files named `ev"N.yml` collapse under a single
    // unterminated token `"ev\`. And `slice(0, i + 1)` must include the closing
    // quote: at `slice(0, i)` every group name in the summary loses it, which
    // breaks the quoting invariant the summary's own values maintain.
    const names = Array.from({ length: 22 }, (_, i) => safeName(`${raw}${i}.yml`));
    const lines = names.map((n) => `${n}/j: too-tight` as Safe);
    const summary = boundedList(lines).at(-1) ?? '';
    // Each named group is a COMPLETE JSON string, not a prefix of one.
    for (const part of summary.slice(summary.indexOf(': ') + 2, -1).split(', ')) {
      if (!part.startsWith('"')) continue;
      expect(() => JSON.parse(part) as unknown).not.toThrow();
    }
    // And distinct files stay distinct: a single collapsed token would name one.
    expect(summary).toMatch(/and \d+ more/);
  });

  it('the SIBLING renderer\'s two shapes are one group', () => {
    // THE SPACE MEMBER, which a "NOT PINNED / equivalent" label wrongly
    // dismissed. This fence renders `a.yml/j: kind`; the SIBLING renders
    // `a.yml / j: kind` WITH SPACES and `a.yml: kind`. Without the space in the
    // separator class the first cuts at the `/` and yields `a.yml ` — with a
    // trailing space, a partial token — while the second yields `a.yml`: one
    // workflow, two groups, two shares, and a real workflow loses its line.
    // No case mixed the two sibling shapes, which is why the label survived a
    // mutation probe.
    const lines = boundedList([
      ...Array.from({ length: 5 }, (_, i) => `a.yml / j${i}: no-timeout` as Safe),
      ...Array.from({ length: 5 }, () => 'a.yml: no-top-level-permissions' as Safe),
      ...Array.from({ length: 19 }, (_, i) => `w${String(i).padStart(2, '0')}.yml/j: too-tight` as Safe),
    ]);
    expect(lines.some((l) => l.startsWith('w18.yml'))).toBe(true);
  });

  it('one workflow cannot take two shares of the cap', () => {
    // The two renderers emit `a.yml / j: kind` and `a.yml: kind`, which a
    // separator class of `[ /]` alone splits into `a.yml` and `a.yml:` — two
    // groups for one file, so a fork that produces both shapes gets twice the
    // share every other workflow gets.
    // Sized so the two spellings are the ONLY thing that decides whether every
    // workflow fits: 19 other files plus `a.yml` is 20 groups and the cap is
    // 20, so nothing is crowded out — unless `a.yml` counts twice, at which
    // point it is 21 and a real workflow loses its line.
    const lines = boundedList([
      ...Array.from({ length: 5 }, (_, i) => `a.yml/j${i}: too-tight` as Safe),
      ...Array.from({ length: 5 }, () => 'a.yml: no-jobs' as Safe),
      ...Array.from({ length: 19 }, (_, i) => `w${String(i).padStart(2, '0')}.yml/j: too-tight` as Safe),
    ]);
    // 20 groups against a cap of 20: every workflow keeps a line, so the last
    // one is present. Without the colon `a.yml` counts twice, making 21 groups,
    // and the last workflow loses its line.
    expect(lines.some((l) => l.startsWith('w18.yml'))).toBe(true);
  });

  it('a flood from one workflow cannot take the whole cap', () => {
    // SORTING IS NOT ENOUGH, which round 5 assumed. A fork controls how many
    // findings ITS file produces, so 25 findings of the WINNING kind fill the
    // cap from one file and the genuine line is gone. `boundedList` shares the
    // cap round-robin by workflow, so every file that has a finding gets a
    // line before any file gets a second.
    const many = Array.from({ length: 25 }, (_, i) => `aaa.yml/j${i}: too-tight` as Safe);
    const real = 'hooks.yml/hook-suites: too-tight' as Safe;
    const out = boundedList([...many, real]);
    expect(out).toContain(real);
    expect(out).toHaveLength(MAX_RENDERED_FINDINGS + 1);
  });
});

describe('the snapshot is refused when it is too old to describe this tree', () => {
  it.each([
    // The oldest is NOT first: with it at position 0 a "take the first entry"
    // mutant is indistinguishable from the minimum, and it survived.
    ['the oldest end wins', { a: 2, b: 2, c: 2 }, ['2026-09-16', '2026-01-01', '2026-05-05'], '2026-01-01'],
    ['a single entry', { a: 2 }, ['2026-03-03'], '2026-03-03'],
  ])('oldestRangeEnd: %s', (_what, shape, ends, expected) => {
    // A MINIMUM: on a partially refreshed snapshot the oldest entry is the one
    // that says how old the population really is. Both the maximum and the
    // first entry survived until these rows existed — and the first-entry
    // mutant kept surviving after them, because the row put the oldest value at
    // position 0, where the two answers coincide.
    const snapshot = Object.fromEntries(
      Object.keys(shape).map((k, i) => [`w.yml/${k}`, { max: 1, from: 'a', to: ends[i] ?? '' }]),
    );
    expect(oldestRangeEnd(snapshot)).toBe(expected);
  });

  it('oldestRangeEnd: an empty snapshot has no end, and that is not a fresh one', () => {
    // `''` parses to NaN, which `auditSnapshotAge` reports as `unreadable` —
    // never as `ok`. A guard that answered "fresh" for "no data" would be the
    // `NaN < 2` shape again.
    expect(oldestRangeEnd({})).toBe('');
    expect(auditSnapshotAge(oldestRangeEnd({}), Date.now())).toBe('unreadable');
  });

  it('a fresh STAMP over an ancient POPULATION is still stale', () => {
    // THE READING THE FIRST VERSION OF THIS GUARD MISSED. Re-deriving the
    // snapshot over its own recorded range refreshes `generatedAt` and changes
    // nothing about how old the runs are — and that is the normal way this
    // artifact gets re-checked, not an adversarial case.
    const now = Date.parse('2026-09-18T00:00:00Z');
    const ancient = { 'w.yml/j': { max: 1, from: '2024-01-01', to: '2024-01-14' } };
    expect(auditSnapshotAge(new Date(now - 1000).toISOString(), now)).toBe('ok');
    expect(auditSnapshotAge(oldestRangeEnd(ancient), now)).toBe('stale');
  });

  const at = (iso: string) => Date.parse(iso);
  const now = at('2026-09-18T00:00:00Z');

  it.each([
    ['fresh', '2026-09-17T00:00:00Z', 'ok'],
    ['one day inside the window', '2026-06-21T00:00:00Z', 'ok'],
    // EXACTLY 90 days. Without this row the comparison could be `>=` and the
    // constant could be 89, both with every case green — the rows sat at 89 and
    // 91 while the comment claimed "both sides of the boundary".
    ['exactly at the window', '2026-06-20T00:00:00Z', 'ok'],
    ['one day outside it', '2026-06-19T00:00:00Z', 'stale'],
    ['ancient', '2024-01-01T00:00:00Z', 'stale'],
  ])('a snapshot generated %s reads as %s', (_what, stamp, verdict) => {
    // Both sides of the boundary, because a guard pinned only from the passing
    // side is satisfied by a constant of any size.
    expect(auditSnapshotAge(stamp, now)).toBe(verdict);
  });

  it('a stamp in the FUTURE is its own verdict, not a negative age', () => {
    // `now - at > 90 days` is false for every future date, so a clock-skewed or
    // hand-edited stamp would read as the freshest possible snapshot — which is
    // precisely how a stale one would be made to pass this guard.
    expect(auditSnapshotAge('2027-01-01T00:00:00Z', now)).toBe('future');
    // ONE MILLISECOND is the case that matters: the threat named above is clock
    // SKEW, not a hand-typed year, and `at > now + 86_400_000` passed the
    // three-month probe while letting a day of skew read as fresh.
    expect(auditSnapshotAge(new Date(now + 1).toISOString(), now)).toBe('future');
  });

  it.each([
    ['absent', undefined],
    ['a number', 1_700_000_000_000],
    ['an object', { at: 'x' }],
    ['unparseable text', 'last Tuesday'],
    ['an empty string', ''],
  ])('a generatedAt that is %s is unreadable, not fresh', (_what, stamp) => {
    // `Date.parse` returns NaN for these and EVERY comparison against NaN is
    // false — so without the explicit arm they would all report `ok`, which is
    // the `NaN < 2` shape this whole fence exists because of.
    expect(auditSnapshotAge(stamp, now)).toBe('unreadable');
  });
});

describe('the window halves until the listing is not capped, then refuses', () => {
  // TWO OF THIS PR'S BLOCKERS LIVED IN THIS ARITHMETIC and neither was
  // reachable from a case, because the loop around it makes network calls. One
  // round removed a floor and made the exit true on its first iteration, so the
  // halving never ran and the generator could not reproduce the snapshot it
  // ships; the round before that slept on a terminal attempt. The file's own
  // doctrine — `walkMayStop` is extracted for exactly this reason — had been
  // applied everywhere except the code that produced the blockers.

  it('walks the default window down to the floor', () => {
    // The real sequence, which the fake-`gh` probe also shows end to end.
    const seen: number[] = [];
    for (let d: number | null = 14; d !== null; d = nextWindow(d)) seen.push(d);
    expect(seen).toEqual([14, 7, 3, 1]);
  });

  it('refuses at the floor rather than proposing a zero-day window', () => {
    expect(nextWindow(1)).toBeNull();
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 2.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('a %s span is refused, never halved', (_what, days) => {
    // `NaN` is the one that mattered: `NaN <= 0` is FALSE and
    // `Math.floor(NaN / 2) >= NaN` is FALSE, so before `Number.isInteger` a
    // non-finite span spun the enclosing loop forever, issuing `gh` calls with
    // an `Invalid Date` range. Unreachable today only because the flag parser
    // validates first — a property of the caller, not of this function.
    expect(nextWindow(days)).toBeNull();
  });

  it('always makes progress, so the loop terminates', () => {
    // The property the loop depends on, asserted rather than assumed: every
    // answer is strictly smaller than its input and at least the floor.
    for (let d = 1; d <= 400; d += 1) {
      const next = nextWindow(d);
      if (next === null) continue;
      expect(next).toBeLessThan(d);
      expect(next).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('the generator runs only when it is the entry point', () => {
  // THIS ARM FAILED IN THE ONE COLOUR NOTHING ELSE HERE CAN, and it was
  // MEASURED rather than reasoned about. With `invokedDirectly` broken, the
  // import at the top of this file ran the whole network walk, OVERWROTE
  // `docs/_generated/workflow-job-durations.json` in place, and the suite then
  // passed 57 of 57 — `the real tree reports nothing` asserting against a
  // snapshot the run had just manufactured from live data. Green, silent, and
  // self-referential: the defect class this pair of files exists to catch,
  // reproduced by its own tooling.
  //
  // Two locks answer it. The predicate below takes its inputs as ARGUMENTS, so
  // every arm is decided without touching `process.argv` and without reaching
  // `main`; and `main` itself refuses inside a test runner, on a signal
  // independent of the predicate, so no mutation of either one can reach
  // `writeFileSync` from here.
  const self = realpathSync(
    join(import.meta.dirname, '../../../scripts/gen-workflow-job-durations.ts'),
  );

  it('runs when argv[1] is this module', () => {
    expect(invokedDirectly(self, self)).toBe(true);
  });

  it('does not run when argv[1] is another file', () => {
    // What the vitest worker actually passes: its own runner entry.
    expect(invokedDirectly(process.argv[1], self)).toBe(false);
  });

  it('does not run when there is no argv[1]', () => {
    // `node --eval` and an embedded runtime both leave it undefined. The
    // explicit guard for this is an EQUIVALENT arm — deleting it keeps every
    // case green, because `realpathSync(undefined)` throws into the `catch`,
    // which answers the same `false`. Measured, and recorded rather than
    // dressed up: this case pins the ANSWER, not that line.
    expect(invokedDirectly(undefined, self)).toBe(false);
  });

  it('does not run, rather than throwing, when argv[1] does not exist', () => {
    // `realpathSync` throws ENOENT on a path that is not real, at MODULE SCOPE
    // of a file this fence imports — which would take the whole collection down
    // with a stack instead of reporting anything.
    expect(invokedDirectly(join(self, 'no-such-entry.ts'), self)).toBe(false);
  });

  it('compares REAL paths, so a symlinked entry still counts as direct', () => {
    // `node scripts/gen-workflow-job-durations.ts` reached through a symlinked
    // path gives an argv[1] that is not byte-equal to `import.meta.filename`; a
    // `===` on the raw strings would silently decline to run and print nothing.
    const scratch = mkdtempSync(join(tmpdir(), 'cdkd-entry-'));
    try {
      const link = join(scratch, 'link.ts');
      symlinkSync(self, link);
      expect(invokedDirectly(link, self)).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it.each([
    ['VITEST', { VITEST: 'true' }],
    ['VITEST_WORKER_ID', { VITEST_WORKER_ID: '1' }],
  ])('%s makes the generator refuse to run at all', (_what, env) => {
    // The second lock. It is keyed on the RUNNER, not on the entry point, so it
    // holds however the first lock breaks.
    expect(() => refuseInsideTestRunner(env)).toThrow(/refusing to run inside the test runner/);
  });

  it('a shell with no test-runner variable is allowed through', () => {
    // The other half: a lock that refused unconditionally would be one that
    // never lets the generator run, and nothing else in this suite would say so.
    expect(() => refuseInsideTestRunner({})).not.toThrow();
    expect(() => refuseInsideTestRunner({ CI: 'true', HOME: '/root' })).not.toThrow();
  });

  it('the lock is WIRED INTO `main`, not merely defined beside it', () => {
    // REGISTRATION IS NOT EXECUTION. Deleting the `refuseInsideTestRunner`
    // call from `main` left every case above green — necessarily so, since a
    // working entry-point guard means `main` is never reached from here. The
    // lock existed and nothing proved it was called.
    //
    // A SUBPROCESS answers it, and the argument is what makes that safe: with
    // the lock in place the run dies on the lock; with the lock deleted it dies
    // one line later on the unknown flag. Neither path reaches the network or
    // the writer, so this case cannot do what it exists to prevent. Asserting
    // the MESSAGE is what discriminates them — both exit non-zero.
    const r = spawnSync(process.execPath, [self, '--bogus'], {
      // A MINIMAL environment, not an inherited one. The child's `main` would
      // perform a credentialed `gh` walk and overwrite a committed file, and
      // the only thing keeping it from doing so is the two-deep behavioural
      // argument above. Handing it the whole environment adds nothing to the
      // case and makes that argument the ONLY thing standing between a future
      // edit and a real walk. (`ci.yml`'s unit job carries no secret today —
      // this is hygiene, and hygiene is what the argument should not depend on.)
      env: { VITEST: '1', PATH: process.env['PATH'] ?? '' },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/refusing to run inside the test runner/);
    expect(r.stderr).not.toMatch(/unknown argument/);
  });

  it('this suite really is inside the runner the lock keys on', () => {
    // Without this, the two cases above are assertions about a hand-built
    // object and say nothing about the venue they protect. If vitest ever stops
    // exporting these variables the lock is inert, and this is the case that
    // notices.
    expect(process.env['VITEST'] ?? process.env['VITEST_WORKER_ID']).toBeDefined();
    expect(() => refuseInsideTestRunner(process.env)).toThrow();
  });
});

describe('the snapshot is refused rather than half-read', () => {
  it.each([
    ['no jobs mapping', '{"generatedAt":"x"}', /has no jobs mapping/],
    ['jobs is not a mapping', '{"jobs":[]}', /has no jobs mapping/],
    ['an entry with no numeric max', '{"jobs":{"a/b":{"from":"x","to":"y"}}}', /no numeric max/],
    ['an entry that is not a mapping', '{"jobs":{"a/b":7}}', /no numeric max/],
    // `null` is the row that pins the `isMapping(value)` clause: on `null`,
    // `value['max']` THROWS rather than answering `undefined`, so deleting the
    // clause turns a refusal into a crash. `7` cannot show that — a number
    // answers `undefined` for any property.
    ['a null entry', '{"jobs":{"a/b":null}}', /no numeric max/],
    ['a max of zero', '{"jobs":{"a/b":{"max":0,"from":"x","to":"y"}}}', /positive/],
    ['a negative max', '{"jobs":{"a/b":{"max":-1,"from":"x","to":"y"}}}', /positive/],
    // `1e999` parses to `Infinity`, which is a NUMBER and is not `<= 0`, so the
    // `Number.isFinite` half of that guard was dead as tested until this row.
    ['an infinite max', '{"jobs":{"a/b":{"max":1e999,"from":"x","to":"y"}}}', /positive/],
  ])('%s is a refusal', (_what, body, pattern) => {
    // The PATTERN, not a bare `.toThrow()`. Gutting either message to "x" left
    // all four of these green, so the wording — which is what tells a reader to
    // regenerate rather than to go hunting — was pinned by nothing.
    //
    // `an entry that is not a mapping` shares its message with the numeric case
    // because every value that reaches one reaches the other — but the CLAUSE
    // is still load-bearing, and an earlier revision of this comment called it
    // unreachable. It is not, for `null`: `value['max']` on `null` THROWS
    // rather than answering `undefined`, so without `isMapping(value)` a
    // snapshot entry of `null` crashes the read instead of being refused.
    expect(() => parseSnapshot(body, '<probe>')).toThrow(pattern);
  });

  it.each([
    ['a top-level array', '[]'],
    ['a top-level number', '7'],
    ['top-level null', 'null'],
  ])('%s is a refusal', (_what, body) => {
    // `isMapping`'s `typeof` and `null` clauses: `typeof null === "object"` and
    // an array is an object too, so neither is reachable from the mapping cases
    // above and both survived deletion.
    expect(() => parseSnapshot(body, '<probe>')).toThrow(/has no jobs mapping/);
  });

  it('a hostile FILE half is quoted, which only `safeName` does', () => {
    // THE BRAND CANNOT CATCH THE WRONG SANITISER, only a missing one: swapping
    // `safeName` for `safeText` typechecks, because both return `Safe`, and it
    // left every other case green. `safeText` is exactly the helper that fails
    // this threat — the name below is pure ASCII with no control byte, so the
    // flattening is a no-op and it reads as a complete finding about a
    // different workflow. Only the quoting tells the two apart.
    //
    // No `/` in the forged name: a real file name cannot contain one, and
    // `finding` splits the key at the FIRST `/` to separate the halves.
    const forged = 'ci.yml_ check-build-test: no-timeout - and also.yml';
    const line = render(auditHeadroom(new Map([[`${forged}/j`, 60]]), {}, {}))[0] ?? '';
    expect(line.startsWith('"')).toBe(true);
    expect(JSON.parse(line.slice(0, line.indexOf('"', 1) + 1))).toBe(forged);
  });

  it('a hostile snapshot key cannot forge a line through the refusal', () => {
    // An object key here is arbitrary attacker-chosen text with no length
    // limit — a strictly more capable venue than the job key this file already
    // fences, and it reached the message raw.
    const hostile = `a/b${String.fromCodePoint(0x0a)}  ci.yml / x: FORGED${String.fromCodePoint(0x202e)}`;
    const body = JSON.stringify({ jobs: { [hostile]: { from: 'x', to: 'y' } } });
    let message = '';
    try {
      parseSnapshot(body, '<probe>');
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain('no numeric max');
    expect(message).not.toContain(String.fromCodePoint(0x0a));
    expect(message).not.toContain(String.fromCodePoint(0x202e));
    // QUOTED, which is the half `safeText` does not do: asserting the absence
    // of LF and RLO left `safeKey` -> `safeText` green, and a key of pure ASCII
    // like `x is fine; <path>: ci.yml/check-build-test` needs neither byte to
    // read as a finding about a real job.
    expect(message).toContain('<probe>: "');
  });

  it('a hostile snapshot key cannot forge a line through the SECOND refusal', () => {
    // TWO refusals interpolate the key, and only one of them was pinned:
    // dropping `safeText` from the non-positive-max message left all 72 cases
    // green, because the case above supplies no `max` at all and never reaches
    // it. `max: 0` is what routes the same hostile key to the sibling message —
    // and 0 is the value that motivated that refusal in the first place, since
    // it makes headroom `Infinity` and `Infinity < 2` is false.
    const hostile = `a/b${String.fromCodePoint(0x0a)}  ci.yml / x: FORGED${String.fromCodePoint(0x202e)}`;
    const body = JSON.stringify({ jobs: { [hostile]: { max: 0, from: 'x', to: 'y' } } });
    let message = '';
    try {
      parseSnapshot(body, '<probe>');
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain('not a positive number');
    expect(message).not.toContain(String.fromCodePoint(0x0a));
    expect(message).not.toContain(String.fromCodePoint(0x202e));
    // QUOTED — and without this the case passed for exactly the wrong reason.
    // `safeText` FLATTENS, which removes the LF and the RLO the two lines above
    // look for, so `safeKey` -> `safeText` survived here with all 186 cases
    // green while rendering
    //   <probe>: x is fine; regenerate it <probe>: ci.yml/check-build-test has …
    // Its twin got this assertion last round and this one did not: the same
    // one-place-not-the-other shape, in the adjacent case.
    expect(message).toContain('<probe>: "');
  });

  it('malformed JSON is refused without echoing the source', () => {
    // Node embeds the offending source in a JSON parse error, and this file is
    // committed, so a PR edits it freely.
    const marker = 'FORGED-SOURCE-ECHO';
    let message = '';
    try {
      parseSnapshot(`{"a":\nzzz${marker}}`, '<probe>');
    } catch (error) {
      message = String((error as Error).message);
    }
    expect(message).toContain('not valid JSON');
    expect(message).not.toContain(marker);
  });

  it('a well-formed snapshot parses', () => {
    expect(parseSnapshot('{"jobs":{"a/b":{"max":5,"from":"x","to":"y"}}}', '<probe>')).toEqual({
      'a/b': { max: 5, from: 'x', to: 'y' },
    });
  });
});
