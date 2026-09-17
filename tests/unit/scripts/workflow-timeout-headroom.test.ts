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
 * The `>=` is owed to go-to-k/cdkd#3282, NOT to this fence's own issue. #3282
 * proposes bringing `hook-suites` back to a 30-minute bound once its suite runs
 * in under 15 minutes — "the 2x+ headroom", i.e. exactly 2.00x, sitting ON this
 * floor rather than above it. A fence that refused the very state a sibling
 * issue is working towards would be disabled rather than obeyed.
 *
 * An earlier revision of this paragraph attributed that warning to
 * go-to-k/cdkd#3283, which says no such thing: it writes `bound >= k * max`
 * with `k` unfixed and never mentions `hook-suites` or #3282. Re-read before
 * citing — a claim about what another document says is the kind this pair of
 * fences has got wrong most often.
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
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  displayNameToKey,
  resolveJobKey,
  walkMayStop,
} from '../../../scripts/gen-workflow-job-durations.ts';
// The SIBLING's sanitisers, imported rather than re-derived. Every field this
// file renders — a job key, a workflow file name, a snapshot range — is
// fork-controlled on `pull_request`, and go-to-k/cdkd#3272 found that class
// FOUR times, each instance inside the code that fixed the previous one. A
// fifth venue with its own copies of the helpers is how that happens again.
import { safeName, safeText, type Safe } from './workflow-log-safety.js';

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
const MIN_DECLARED = 18;
// 18, not 12. At 12 the round-1 defect — four jobs vanishing because the
// generator keyed them by display name — cleared the floor with room to spare,
// so the floor could not have caught the very failure that made this fence
// necessary.
const MIN_SNAPSHOT = 18;
const MIN_COMPARED = 18;

/**
 * Jobs with no snapshot entry that are EXPECTED to have none.
 *
 * EMPTY, and the emptiness is the point. The first cut of this file listed five
 * jobs here with reasons like "gated on an issue or comment event" — and every
 * one of those reasons was FALSE. They had no entry because the generator keyed
 * on the Actions API's display name while this fence keys on the YAML job id,
 * so the four jobs that override `name:` vanished; the fifth was dropped by a
 * prune that stopped before it had seen every job. `issue-conventions.yml` is
 * in fact the highest-volume workflow in the repo — 106/71/274/389/496/356
 * successful runs per day over 2026-09-12..09-17 — the opposite of rare. (An
 * earlier revision said "~885 in a day": that was the RANGE total restated as
 * a daily rate, and two reviewers caught it independently.)
 *
 * So this list absorbed a generator defect and gave it a plausible story, which
 * is exactly the failure the fence exists to catch, reproduced inside the fence.
 * With both causes fixed the snapshot covers 21 of 21 jobs and nothing needs
 * exempting.
 *
 * The mechanism stays because a genuinely never-run job is possible. Adding an
 * entry needs a reason that survives being checked — run
 * `gh run list --workflow=<file> --json databaseId --limit 5` and look before
 * writing one, because "no entry" and "never ran" are indistinguishable from
 * the data alone. Both staleness directions are fenced: an exemption whose job
 * gains data fails, and so does one whose job disappears.
 */
const RARELY_RUN: Readonly<Record<string, string>> = {};

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
): { jobs: Map<string, number | undefined>; unreadable: string[] } => {
  const jobs = new Map<string, number | undefined>();
  const unreadable: string[] = [];
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
      unreadable.push(file);
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
  const jobs: Record<string, JobSample> = {};
  for (const [key, value] of Object.entries(raw['jobs'])) {
    if (!isMapping(value) || typeof value['max'] !== 'number') {
      // `safeText(key)`: an object key in this file is arbitrary attacker-chosen
      // text with no length limit — a strictly more capable venue than the job
      // key this file already sanitises, and it was raw.
      throw new Error(`${where}: ${safeText(key)} has no numeric max in the snapshot; regenerate it`);
    }
    // POSITIVE and finite. A `max` of 0 makes headroom `Infinity`, and
    // `Infinity < MIN_HEADROOM` is false, so every bound on that job would pass
    // silently — the same false-comparison as `NaN < 2`. The generator now
    // floors at 1, so a 0 here means a hand-edited or truncated snapshot.
    if (!Number.isFinite(value['max']) || value['max'] <= 0) {
      throw new Error(
        `${where}: ${safeText(key)} has a max that is not a positive number; regenerate it`,
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

const loadSnapshot = (): Record<string, JobSample> =>
  parseSnapshot(readFileSync(SNAPSHOT_PATH, 'utf8'), SNAPSHOT_PATH);

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
  // A job key is `<file>/<job>`: the file half is CONSTRAINED by `safeName`
  // (a name can read as a whole finding about another file without carrying a
  // single control byte), the job half flattened and clamped. A fork controls
  // both halves. The cast is the one boundary on this path — a template
  // literal is `string` however safe its parts — and it is why the field type
  // above is `Safe`: without it, dropping either call compiles cleanly.
  job: `${safeName(job.slice(0, job.indexOf('/')))}/${safeText(
    job.slice(job.indexOf('/') + 1),
  )}` as Safe,
  ...numbers,
  ...(range === undefined ? {} : { range: safeText(range) }),
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
  unreadable: readonly string[] = [],
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
  // Interpolation here is unguarded BY CONTRACT: `finding` sanitised every
  // string field, and the rest are numbers.
  findings.map((f) =>
    f.kind === 'too-tight'
      ? `${f.job}: ${f.bound} min against ${f.max} s observed ` +
        `(${(f.headroom ?? Number.NaN).toFixed(2)}x, floor ${MIN_HEADROOM}x) in ${f.range}`
      : `${f.job}: ${f.kind}`,
  );

const { jobs: DECLARED, unreadable: UNREADABLE } = declaredJobs();
const SNAPSHOT = loadSnapshot();

/** A one-job tree, for the arms the real tree cannot exhibit. */
const tree = (bound: number | undefined) => new Map([['w.yml/j', bound]]);
const snap = (max: number) => ({ 'w.yml/j': { max, from: 'a', to: 'b' } });

describe('no workflow job is bounded too tightly to survive its own longest run', () => {
  it('the real tree reports nothing', () => {
    expect(render(auditHeadroom(DECLARED, SNAPSHOT, RARELY_RUN, UNREADABLE))).toEqual([]);
  });

  it('the inputs it attests to are actually there', () => {
    // Floors: a snapshot that silently became `{}`, or a walk that stopped
    // matching, would make every case above pass by having nothing to check.
    // Both halves are here for shape, and NEITHER is fenced: with every job
    // carrying both a bound and an entry, `compared` is identically `DECLARED`
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
    // `>=`, deliberately: go-to-k/cdkd#3282 proposes returning `hook-suites` to
    // a bound that would sit exactly on this floor, and a fence refusing the
    // state a sibling issue is working towards is a fence that gets disabled.
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

  it('an unreadable workflow is a finding, and its message is never rendered', () => {
    // The arm `FindingKind` declared and nothing constructed. A YAML parse error
    // quotes the fork's own source; only the FILE is named.
    const found = auditHeadroom(new Map(), {}, {}, ['evil.yml']);
    expect(found.map((f) => f.kind)).toEqual(['unreadable-workflow']);
    expect(render(found)).toEqual(['evil.yml/: unreadable-workflow']);
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
    ['a document that is not a mapping', 7],
    ['a document with no jobs key', { name: 'x' }],
    ['a jobs node that is not a mapping', { jobs: 'x' }],
    ['a job node that is not a mapping', { jobs: { j: 'x' } }],
  ])('%s yields no declared jobs rather than throwing', (_what, doc) => {
    // Both halves of `jobsFromWorkflow`'s guard and its `isMapping(node)`
    // ternary. Without them these THROW, and a throw at module scope takes the
    // whole file's collection down rather than reporting a finding.
    const got = jobsFromWorkflow('w.yml', doc);
    expect([...got]).toEqual(_what === 'a job node that is not a mapping' ? [['w.yml/j', undefined]] : []);
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
    const hostile = `x${String.fromCodePoint(0x0a)}  ci.yml / check-build-test: FORGED${String.fromCodePoint(0x202e)}`;
    const lines = render(build(hostile));
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain(String.fromCodePoint(0x0a));
    expect(lines[0]).not.toContain(String.fromCodePoint(0x202e));
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
  ])('%s yields an empty map rather than throwing', (_what, bad) => {
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

describe('the snapshot is refused rather than half-read', () => {
  it.each([
    ['no jobs mapping', '{"generatedAt":"x"}', /has no jobs mapping/],
    ['jobs is not a mapping', '{"jobs":[]}', /has no jobs mapping/],
    ['an entry with no numeric max', '{"jobs":{"a/b":{"from":"x","to":"y"}}}', /no numeric max/],
    ['an entry that is not a mapping', '{"jobs":{"a/b":7}}', /no numeric max/],
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
    // on purpose: no JSON value can reach the `!isMapping` clause without also
    // failing the `max` clause, so the two are one refusal and the case is
    // named for the input rather than for a branch it cannot isolate.
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
