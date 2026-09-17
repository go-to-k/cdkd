/**
 * Snapshot the observed per-JOB duration of every `.github/workflows/**` job,
 * so `tests/unit/scripts/workflow-timeout-headroom.test.ts` can refuse a
 * `timeout-minutes` that is too TIGHT without making a network call.
 *
 * Issue [#3283](https://github.com/go-to-k/cdkd/issues/3283). The fence added by
 * go-to-k/cdkd#3272 refuses an ABSENT bound, a non-integer one, one below 1 and
 * one at or above the Actions default of 360 — and nothing else. It cannot see a
 * bound that is too small, which is the failure mode that actually occurred:
 * `hooks.yml` carried `timeout-minutes: 30` against a job observed at 1587 s,
 * i.e. 1.1x, for its whole life. A run came within three and a half minutes of
 * being killed and nobody noticed, because a timeout kill reads as a flake, gets
 * re-run, and passes.
 *
 * WHY A COMMITTED SNAPSHOT. Deciding "is this bound too tight" needs observed
 * durations, which live in the Actions API. A unit test may not call it. So the
 * data is captured here, committed, and read offline — the shape every other
 * matrix in this repo uses (see [.claude/rules/layout-scripts.md](../.claude/rules/layout-scripts.md)).
 * The cost is stated rather than hidden: one more generated artifact, and a
 * refresh someone has to run. Three options were weighed on the issue; this one
 * was chosen deliberately over a scheduled workflow that opens issues by itself.
 *
 * NOT part of `gen:all-matrices`, for exactly the reason `audit:coverage:regenerate`
 * and `gen:aws-cli-removals` are not: the aggregate must stay the command that
 * fails on an accidental degradation, and a task needing a network round-trip
 * and a credential cannot be that. It is also not a CI staleness guard — the
 * underlying data changes every time CI runs, so a byte-diff guard would fail
 * constantly and teach everyone to ignore it.
 *
 * TWO MEASUREMENT RULES, both learned the expensive way in go-to-k/cdkd#3272:
 *
 *   1. PER JOB, never per run. A run's wall clock includes queue time and every
 *      other job in it, and `timeout-minutes` bounds neither. Three figures in
 *      that PR were briefly stated from run level; one was a 235 s "job" that
 *      had actually taken 11 s.
 *   2. THE POPULATION OF A CLOSED RANGE, never a capped sample. "The N most
 *      recent runs" is defined by POSITION, so it slides and never reproduces.
 *      And `--limit` silently CAPS: the range used there held 865 `ci.yml` runs
 *      while the sample took 50, which is how a 902 s `docs-deploy` build was
 *      missed and a 15-minute bound shipped BELOW a real run.
 *
 * THE PRUNE IS SOUND, NOT AN APPROXIMATION. Fetching the job breakdown of every
 * run costs one request each and exhausts the hourly budget on this repo
 * (measured: ~3300 runs in a one-week range, and the secondary limit trips well
 * before that). But a job cannot outlast the run that contains it, so a run
 * whose WALL CLOCK is already below the longest job seen for that workflow
 * cannot change any maximum. Runs are therefore walked longest-first and the
 * walk stops when the run duration drops below every current maximum. That
 * prunes by an inequality that always holds, so the reported maxima are exactly
 * the population's — `--no-prune` re-derives them the slow way to check.
 */

import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const REPO = 'go-to-k/cdkd';
const REPO_ROOT = join(import.meta.dirname, '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');
const OUT = join(REPO_ROOT, 'docs', '_generated', 'workflow-job-durations.json');

/**
 * Days of history to ask for first, ending at the last complete UTC day.
 *
 * THE RANGE IS PER WORKFLOW, not global, and that is a correctness decision
 * rather than a convenience. The run LISTING caps at 1000, and volume here
 * spans two orders of magnitude: `ci.yml` ran ~865 times in a measured week
 * while `backfill-umbrella-sync.yml` ran 6. One shared range either TRUNCATES
 * the busy workflows — a truncated population understates a maximum, the exact
 * defect this fence exists to catch — or starves the quiet ones of samples. So
 * each workflow's window is halved until its listing is not capped, and the
 * range it actually used is recorded beside its jobs.
 */
const DEFAULT_WINDOW_DAYS = 14;
/** Below this the sample is too small to be worth quoting, so the walk refuses. */
const MIN_WINDOW_DAYS = 1;

/**
 * ONLY the maximum, deliberately.
 *
 * The prune is sound for a MAXIMUM and for nothing else: it stops walking once
 * no remaining run could contain a longer job, which leaves `n` and any
 * percentile computed over an arbitrary prefix of the population rather than
 * the population. Recording them anyway would publish a figure that looks like
 * a population statistic and is not — the precise shape of defect this fence
 * exists to catch, and one go-to-k/cdkd#3272 shipped four times before it
 * stopped quoting sample sizes at all. `max` is what a bound must clear; it is
 * the only number here that is both load-bearing and true.
 */
interface JobSample {
  readonly max: number;
  /** The closed range this job's sample was taken over — per workflow; see above. */
  readonly from: string;
  readonly to: string;
}

interface Snapshot {
  readonly generatedAt: string;
  readonly repo: string;
  readonly requestedRange: { readonly from: string; readonly to: string };
  readonly note: string;
  readonly jobs: Record<string, JobSample>;
}

/**
 * One `gh` call, retried on a TRANSIENT failure.
 *
 * The walk makes thousands of requests over tens of minutes, and a single
 * dropped connection used to throw away all of it — measured: a `dial tcp ...
 * operation timed out` on request ~1700 killed a run that had nothing else
 * wrong with it, and the snapshot was never written. Retrying only helps a
 * failure that is actually transient, so the classification is explicit and
 * anything else rethrows immediately: a rate limit, a 404, a bad flag and a
 * parse error are all states where trying again is just slower.
 */
const TRANSIENT = /dial tcp|operation timed out|connection reset|EOF|502 Bad Gateway|503|timeout awaiting/i;

const gh = (args: readonly string[]): unknown => {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const out = execFileSync('gh', [...args], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      return JSON.parse(out) as unknown;
    } catch (error) {
      lastError = error;
      const text = `${String((error as { stderr?: string }).stderr ?? '')}${String(error)}`;
      if (!TRANSIENT.test(text)) throw error;
      // Linear, not exponential: the failures this retries are single dropped
      // connections rather than a server asking us to slow down, and a long
      // backoff on a thousands-of-requests walk costs more than it saves.
      const waitMs = 2000 * (attempt + 1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
      process.stderr.write(`  transient gh failure, retry ${attempt + 1}/3 after ${waitMs}ms\n`);
    }
  }
  throw lastError;
};

const isMapping = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Workflow file names, in the same shape the fence walks. */
const workflowFiles = (): string[] =>
  readdirSync(WORKFLOW_DIR)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();

/**
 * Display name -> job KEY, for one workflow.
 *
 * THE ACTIONS API RETURNS THE DISPLAY NAME, not the YAML job id, and a job may
 * override it with `name:`. Keying on the name dropped every such job silently:
 * the four `issue-conventions.yml` jobs are the only ones in this tree that
 * override, and all four vanished from the snapshot — then got written into the
 * fence's exemption list with reasons that were FALSE. That workflow is the
 * highest-volume one in the repo (~885 successful runs in a day), not a rare
 * one. An exemption list absorbing a generator defect is the exact failure this
 * fence exists to catch, reproduced inside it.
 *
 * Matrix legs arrive as `<display name> (leg)`. The suffix is stripped ONLY
 * when the remainder resolves to a declared job, because two jobs here differ
 * solely by a parenthesised tail — `English-only (pull request)` and
 * `English-only (issue / comment)` — and blind stripping pooled them into one.
 */
export const displayNameToKey = (file: string, doc: unknown): Map<string, string> => {
  const out = new Map<string, string>();
  if (!isMapping(doc) || !isMapping(doc['jobs'])) return out;
  for (const [job, node] of Object.entries(doc['jobs'])) {
    const display = isMapping(node) && typeof node['name'] === 'string' ? node['name'] : job;
    out.set(display, `${file}/${job}`);
  }
  return out;
};

/** Resolve one API job name to a declared key, or `undefined` if it matches none. */
export const resolveJobKey = (
  apiName: string,
  byDisplay: ReadonlyMap<string, string>,
): string | undefined => {
  const exact = byDisplay.get(apiName);
  if (exact !== undefined) return exact;
  const stripped = apiName.replace(/\s*\([^()]*\)$/, '');
  return stripped === apiName ? undefined : byDisplay.get(stripped);
};

/**
 * Every job key the tree declares, as `<file>/<job>`.
 *
 * REFUSED rather than skipped when a workflow will not parse or declares no
 * jobs: a snapshot missing a job looks identical to a job with no runs, and the
 * fence treats the second as a finding. Producing that state silently would
 * hand the fence a false negative it cannot distinguish.
 */
const declaredJobKeys = (): string[] => {
  const keys: string[] = [];
  for (const file of workflowFiles()) {
    let doc: unknown;
    try {
      doc = parseYaml(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
    } catch (error) {
      throw new Error(`${file} does not parse, so its jobs cannot be enumerated: ${String(error)}`);
    }
    if (!isMapping(doc) || !isMapping(doc['jobs']) || Object.keys(doc['jobs']).length === 0) {
      throw new Error(`${file} declares no jobs mapping; refusing to write a partial snapshot`);
    }
    for (const job of Object.keys(doc['jobs'])) keys.push(`${file}/${job}`);
  }
  return keys;
};

interface RunRow {
  readonly id: number;
  readonly seconds: number;
}

/** Successful runs of one workflow inside the closed range, longest wall clock first. */
const runsInRange = (file: string, from: string, to: string): RunRow[] | null => {
  const raw = gh([
    'run',
    'list',
    '--repo',
    REPO,
    '--workflow',
    file,
    '--status',
    'success',
    '--created',
    `${from}..${to}`,
    // 1000 is the API's own ceiling; a workflow exceeding it in a two-week
    // window would need a narrower range, and the caller is told rather than
    // silently handed a truncated population.
    '--limit',
    '1000',
    '--json',
    'databaseId,startedAt,updatedAt',
  ]);
  if (!Array.isArray(raw)) throw new Error(`unreadable run list for ${file}`);
  // The caller decides what to do about a capped listing; `null` says "capped",
  // never a truncated array, so a truncated population cannot be mistaken for a
  // complete one further down.
  if (raw.length >= 1000) return null;
  return raw
    .map((row) => {
      if (!isMapping(row)) throw new Error(`unreadable run row for ${file}`);
      const started = Date.parse(String(row['startedAt']));
      const updated = Date.parse(String(row['updatedAt']));
      if (!Number.isFinite(started) || !Number.isFinite(updated)) {
        throw new Error(`run ${String(row['databaseId'])} of ${file} has unreadable timestamps`);
      }
      return { id: Number(row['databaseId']), seconds: (updated - started) / 1000 };
    })
    .sort((a, b) => b.seconds - a.seconds);
};

/**
 * Per-job durations of one run, keyed by DECLARED JOB KEY.
 *
 * `skipped` is excluded — it never ran. `failure` and `cancelled` are INCLUDED,
 * which is the safety-relevant direction: a job killed at its own bound is the
 * strongest evidence a bound is too tight, and filtering to successes alone
 * excluded exactly that, understating the maximum in the hiding direction.
 */
const jobDurations = (
  runId: number,
  byDisplay: ReadonlyMap<string, string>,
): Map<string, number[]> => {
  const raw = gh(['api', `repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`, '--paginate']);
  const out = new Map<string, number[]>();
  const pages = Array.isArray(raw) ? raw : [raw];
  for (const page of pages) {
    if (!isMapping(page) || !Array.isArray(page['jobs'])) continue;
    for (const job of page['jobs']) {
      if (!isMapping(job)) continue;
      const conclusion = job['conclusion'];
      if (conclusion !== 'success' && conclusion !== 'failure' && conclusion !== 'cancelled') {
        continue;
      }
      const started = Date.parse(String(job['started_at']));
      const completed = Date.parse(String(job['completed_at']));
      if (!Number.isFinite(started) || !Number.isFinite(completed)) continue;
      const key = resolveJobKey(String(job['name']), byDisplay);
      if (key === undefined) continue;
      const list = out.get(key) ?? [];
      list.push((completed - started) / 1000);
      out.set(key, list);
    }
  }
  return out;
};

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

const main = (): void => {
  const argv = process.argv.slice(2);
  const prune = !argv.includes('--no-prune');
  const flag = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`${name}=`));
    return hit?.slice(name.length + 1);
  };
  const USAGE =
    'gen-workflow-job-durations — snapshot the longest observed duration of every workflow job\n' +
    '\n' +
    '  --from=YYYY-MM-DD  start of the closed range (default: --to minus 14 days)\n' +
    '  --to=YYYY-MM-DD    end of the closed range (default: the last complete UTC day)\n' +
    '  --no-prune         walk every run instead of stopping once no run can raise a max.\n' +
    '                     Slow and rate-limit-hungry; use it to CHECK the prune, which is\n' +
    '                     sound by the inequality job <= run but is worth re-deriving.\n' +
    '  --help             this text\n';
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return;
  }
  // An unrecognised flag is REFUSED, never ignored: a typo'd `--form=` would
  // otherwise fall through to the default range and write a snapshot the caller
  // did not ask for, which is the `refresh-cfn-schemas.mjs` trap (a `--chekc`
  // typo once fell through to the writer path and rewrote a committed matrix at
  // exit 0).
  for (const a of argv) {
    if (a !== '--no-prune' && !a.startsWith('--from=') && !a.startsWith('--to=')) {
      throw new Error(`unknown argument ${a}\n${USAGE}`);
    }
  }

  const today = new Date();
  const to = flag('--to') ?? isoDay(new Date(today.getTime() - 24 * 3600 * 1000));
  const explicitFrom = flag('--from');
  const windowDays = explicitFrom
    ? Math.max(
        MIN_WINDOW_DAYS,
        Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${explicitFrom}T00:00:00Z`)) / 86400000),
      )
    : DEFAULT_WINDOW_DAYS;
  const from = explicitFrom ?? isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - windowDays * 86400000));

  const declared = new Set(declaredJobKeys());
  const samples = new Map<string, number[]>();
  const ranges = new Map<string, { from: string; to: string }>();
  let runsFetched = 0;

  for (const file of workflowFiles()) {
    // Halve the window until the listing is not capped. Recorded per workflow,
    // because a range that differs between workflows and is NOT written down is
    // the "which sample is this?" confusion that produced four wrong figures in
    // go-to-k/cdkd#3272.
    let days = windowDays;
    let runs: RunRow[] | null = null;
    let usedFrom = from;
    while (runs === null) {
      usedFrom = isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - days * 24 * 3600 * 1000));
      runs = runsInRange(file, usedFrom, to);
      if (runs === null) {
        if (days <= MIN_WINDOW_DAYS) {
          throw new Error(
            `${file} has >= 1000 successful runs even in a ${MIN_WINDOW_DAYS}-day window ` +
              `(${usedFrom}..${to}); the listing cannot be read without truncation.`,
          );
        }
        days = Math.max(MIN_WINDOW_DAYS, Math.floor(days / 2));
      }
    }
    ranges.set(file, { from: usedFrom, to });
    const doc: unknown = parseYaml(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
    const byDisplay = displayNameToKey(file, doc);
    const declaredHere = [...declared].filter((k) => k.startsWith(`${file}/`));
    const maxima = new Map<string, number>();
    for (const run of runs) {
      // THE PRUNE IS SOUND FOR A MAXIMUM AND WAS UNSOUND FOR COVERAGE, which
      // is a distinction an earlier revision of this comment blurred by saying
      // "the reported maxima are exactly the population's" and letting the
      // reader infer the rest. A job cannot outlast its run, so once the run's
      // wall clock is at or below every maximum SEEN SO FAR, no later run can
      // raise one of those. But a job not yet seen has no entry in `maxima` at
      // all, so it was never in that minimum — and a job that only ever appears
      // in shorter runs was dropped from the snapshot entirely.
      //
      // Measured in production, not hypothetically: `release.yml/publish` has
      // 387 successful runs, the longest of which contains only
      // `release-please` at 118 s. `min(maxima)` was therefore 118, the second
      // run (116 s) broke the walk, and ONE run of 387 was fetched — in which
      // `publish` happened to be skipped. It then entered the fence's exemption
      // list as "rarely run". A reviewer's brute force over 4000 synthetic
      // populations found 0 understated maxima and 28 whole-job omissions,
      // which is exactly this shape.
      //
      // So the walk may only prune once every declared job of this workflow has
      // been seen at least once.
      const allSeen = declaredHere.every((key) => maxima.has(key));
      if (prune && allSeen && run.seconds <= Math.min(...maxima.values())) break;
      runsFetched += 1;
      for (const [key, seconds] of jobDurations(run.id, byDisplay)) {
        if (!declared.has(key)) continue;
        const list = samples.get(key) ?? [];
        list.push(...seconds);
        samples.set(key, list);
        maxima.set(key, Math.max(maxima.get(key) ?? 0, ...seconds));
      }
    }
  }

  const jobs: Record<string, JobSample> = {};
  for (const key of [...declared].sort()) {
    const list = (samples.get(key) ?? []).slice().sort((a, b) => a - b);
    if (list.length === 0) continue; // no successful run in range; the fence reports it
    const file = key.slice(0, key.indexOf('/'));
    const used = ranges.get(file);
    jobs[key] = {
      // At least 1. `Math.round` turned any sub-500 ms job into 0, and a 0 max
      // makes the fence's headroom `Infinity` — and `Infinity < 2` is FALSE, so
      // every bound on that job would have passed silently. Flooring at one
      // second overstates such a job by under a second and keeps the ratio
      // finite, which is the safe direction.
      max: Math.max(1, Math.round(list[list.length - 1] ?? 0)),
      from: used?.from ?? from,
      to: used?.to ?? to,
    };
  }

  const snapshot: Snapshot = {
    generatedAt: new Date().toISOString(),
    repo: REPO,
    requestedRange: { from, to },
    note:
      'Longest observed duration of each JOB (never a run: a run includes queue ' +
      'time and every other job in it, and timeout-minutes bounds neither). The ' +
      'range is per workflow and recorded per job, because run volume here spans ' +
      'two orders of magnitude and one shared range would either truncate the ' +
      'busy workflows or starve the quiet ones. Only `max` is recorded: the walk ' +
      'prunes runs that cannot contain a longer job, which is sound for a maximum ' +
      'and would make any count or percentile a statistic of an arbitrary prefix. ' +
      'Generated by scripts/gen-workflow-job-durations.ts; read offline by ' +
      'tests/unit/scripts/workflow-timeout-headroom.test.ts.',
    jobs,
  };

  mkdirSync(join(REPO_ROOT, 'docs', '_generated'), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(snapshot, null, 2)}\n`);
  process.stdout.write(
    `wrote ${OUT}\n  range ${from}..${to}, ${Object.keys(jobs).length} of ${declared.size} ` +
      `declared jobs, ${runsFetched} run(s) fetched${prune ? ' (pruned)' : ' (--no-prune)'}\n`,
  );
  const missing = [...declared].filter((k) => !(k in jobs));
  if (missing.length > 0) {
    process.stdout.write(`  no successful run in range: ${missing.join(', ')}\n`);
  }
};

/**
 * Only when RUN, never when imported.
 *
 * Without this guard, importing the module for its pure helpers starts the
 * whole network walk — measured: pinning `resolveJobKey` in a unit test hung
 * the suite while the generator fetched runs in the background. A script whose
 * pure parts cannot be imported is one whose pure parts cannot be fenced, which
 * is how the name-mapping defect this file now guards against survived in the
 * first place.
 */
if (process.argv[1] !== undefined && import.meta.filename === realpathSync(process.argv[1])) {
  main();
}
