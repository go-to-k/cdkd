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
 * WHY 2, AND THE ONE JOB THAT MAKES IT UNCOMFORTABLE. Measured across the
 * sixteen bounds, headroom runs from 2.27x to over 100x, and the tightest is
 * `hooks.yml` / `hook-suites`. go-to-k/cdkd#3282 proposes bringing that job back
 * to a 30-minute bound once its suite runs in under 15 minutes — which would be
 * exactly 2x, sitting ON this floor rather than above it. `>=` is therefore the
 * deliberate comparison: a job landing exactly on the floor passes, because the
 * alternative is a fence that refuses the very state a sibling issue is working
 * towards.
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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

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
const MIN_SNAPSHOT = 12;
const MIN_COMPARED = 12;

/**
 * Jobs with no snapshot entry that are EXPECTED to have none, each because it is
 * gated on something that rarely happens.
 *
 * Named rather than inferred: "no entry" and "this job never runs" look
 * identical in the data, so tolerating the shape wholesale would let a real
 * coverage loss pass as normal. An entry appearing for one of these is itself a
 * finding — it means the job now has data and the exemption is stale.
 */
const RARELY_RUN: Readonly<Record<string, string>> = {
  'issue-conventions.yml/english-issue': 'gated on an issue or comment event',
  'issue-conventions.yml/english-pr': 'gated on an issue or comment event',
  'issue-conventions.yml/classification-labels': 'gated on an issue event',
  'issue-conventions.yml/dup-check': 'gated on an issue event',
  'release.yml/publish': 'gated on a release actually being created',
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
const declaredJobs = (): Map<string, number | undefined> => {
  const out = new Map<string, number | undefined>();
  for (const file of readdirSync(WORKFLOW_DIR).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const doc: unknown = parseYaml(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
    for (const [key, bound] of jobsFromWorkflow(file, doc)) out.set(key, bound);
  }
  return out;
};

/** Parse and VALIDATE snapshot text. Separate from reading it so the refusals are testable. */
export const parseSnapshot = (text: string, where: string): Record<string, JobSample> => {
  const raw: unknown = JSON.parse(text);
  if (!isMapping(raw) || !isMapping(raw['jobs'])) {
    throw new Error(`${where} has no jobs mapping; regenerate it`);
  }
  const jobs: Record<string, JobSample> = {};
  for (const [key, value] of Object.entries(raw['jobs'])) {
    if (!isMapping(value) || typeof value['max'] !== 'number') {
      throw new Error(`${where}: ${key} has no numeric max in the snapshot; regenerate it`);
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

type Finding =
  | { kind: 'too-tight'; job: string; bound: number; max: number; headroom: number; range: string }
  | { kind: 'not-in-snapshot'; job: string }
  | { kind: 'exemption-now-covered'; job: string }
  | { kind: 'exemption-for-absent-job'; job: string }
  | { kind: 'snapshot-job-not-declared'; job: string };

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
): Finding[] => {
  const findings: Finding[] = [];

  for (const [job, bound] of declared) {
    const sample = snapshot[job];
    if (sample === undefined) {
      // An absent entry and a job that simply never ran are indistinguishable
      // from the data, so the exemption list is what tells them apart.
      if (!(job in exempt)) findings.push({ kind: 'not-in-snapshot', job });
      continue;
    }
    // An absent bound is the SIBLING fence's finding, not this one's. Two
    // fences reporting one defect makes a single edit red both, and neither
    // message is then the useful one.
    if (bound === undefined) continue;
    const headroom = (bound * 60) / sample.max;
    if (headroom < MIN_HEADROOM) {
      findings.push({
        kind: 'too-tight',
        job,
        bound,
        max: sample.max,
        headroom,
        range: `${sample.from}..${sample.to}`,
      });
    }
  }

  for (const job of Object.keys(exempt)) {
    if (snapshot[job] !== undefined) findings.push({ kind: 'exemption-now-covered', job });
    else if (!declared.has(job)) findings.push({ kind: 'exemption-for-absent-job', job });
  }

  for (const job of Object.keys(snapshot)) {
    if (!declared.has(job)) findings.push({ kind: 'snapshot-job-not-declared', job });
  }

  return findings;
};

const render = (findings: readonly Finding[]): string[] =>
  findings.map((f) =>
    f.kind === 'too-tight'
      ? `${f.job}: ${f.bound} min against ${f.max} s observed (${f.headroom.toFixed(2)}x, ` +
        `floor ${MIN_HEADROOM}x) in ${f.range}`
      : `${f.job}: ${f.kind}`,
  );

const DECLARED = declaredJobs();
const SNAPSHOT = loadSnapshot();

/** A one-job tree, for the arms the real tree cannot exhibit. */
const tree = (bound: number | undefined) => new Map([['w.yml/j', bound]]);
const snap = (max: number) => ({ 'w.yml/j': { max, from: 'a', to: 'b' } });

describe('no workflow job is bounded too tightly to survive its own longest run', () => {
  it('the real tree reports nothing', () => {
    expect(render(auditHeadroom(DECLARED, SNAPSHOT, RARELY_RUN))).toEqual([]);
  });

  it('the inputs it attests to are actually there', () => {
    // Floors: a snapshot that silently became `{}`, or a walk that stopped
    // matching, would make every case above pass by having nothing to check.
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
    expect(MIN_SNAPSHOT * 2).toBeGreaterThanOrEqual(Object.keys(SNAPSHOT).length);
    expect(MIN_COMPARED * 2).toBeGreaterThanOrEqual(compared.length);
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

  it('a numeric bound survives the same path', () => {
    expect(jobsFromWorkflow('w.yml', { jobs: { j: { 'timeout-minutes': 30 } } }).get('w.yml/j')).toBe(30);
  });

  it('the rendered line carries the numbers a reader needs to act', () => {
    // A bare "too tight" would send the reader back to the API. The line has to
    // say what the bound is, what it is up against, and over which range — the
    // three things that decide whether to raise the bound or shorten the job.
    const line = render(auditHeadroom(tree(60), snap(3600), {}))[0] ?? '';
    expect(line).toContain('60 min');
    expect(line).toContain('3600 s');
    expect(line).toContain('1.00x');
    expect(line).toContain('a..b');
  });
});

describe('the snapshot is refused rather than half-read', () => {
  it.each([
    ['no jobs mapping', '{"generatedAt":"x"}'],
    ['jobs is not a mapping', '{"jobs":[]}'],
    ['an entry with no numeric max', '{"jobs":{"a/b":{"from":"x","to":"y"}}}'],
    ['an entry that is not a mapping', '{"jobs":{"a/b":7}}'],
  ])('%s is a refusal', (_what, body) => {
    expect(() => parseSnapshot(body, '<probe>')).toThrow();
  });

  it('a well-formed snapshot parses', () => {
    expect(parseSnapshot('{"jobs":{"a/b":{"max":5,"from":"x","to":"y"}}}', '<probe>')).toEqual({
      'a/b': { max: 5, from: 'x', to: 'y' },
    });
  });
});
