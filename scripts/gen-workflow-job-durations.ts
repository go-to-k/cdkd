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
 * (measured 2026-09-18 over 2026-09-10..09-16: 6382 successful runs in a
 * one-week range, and the secondary limit trips well before that — a figure
 * that grows with the repo, so treat it as an order of magnitude).
 *
 * Taking that number cost one more instance of the defect this file exists to
 * document. Summing `gh run list --limit 1000` per workflow gave 5530, and
 * `issue-conventions.yml` returned EXACTLY 1000 — the cap, not a count. Its
 * real week is 1852, taken day by day. An earlier revision of this line said
 * "~3300", which was wrong by roughly a factor of two and carried no date at
 * all. But a job cannot outlast the run that contains it, so a run
 * whose WALL CLOCK is already below the longest job seen for that workflow
 * cannot change any maximum. Runs are therefore walked longest-first and the
 * walk stops when the run duration drops below every current maximum AND every
 * declared job of that workflow has been seen at least once (`walkMayStop`).
 *
 * BOTH CONDITIONS, because the first alone is sound for a MAXIMUM and unsound
 * for COVERAGE: a job not yet seen has no entry in the running maxima, so it was
 * never in the minimum the walk compares against, and a job appearing only in
 * shorter runs was dropped from the snapshot entirely. An earlier revision of
 * this paragraph stated the one-condition rule and said "the reported maxima are
 * exactly the population's", which is the sentence the loop's own comment names
 * as having blurred the two. `--no-prune` re-derives them the slow way to check.
 */

import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
// The SAME sanitisers the two fences use, not a third copy and not nothing.
// This file was the one with nothing: a workflow file name and a YAML or JSON
// parse error are a FORK's bytes on `pull_request`, and eight messages here
// interpolated them raw. This script is not reached from CI today — both locks
// in `main` see to that — so the venue is a maintainer's terminal rather than
// the Actions log, which is why it is closed here rather than argued about.
import { safeKey, safeName, safeText } from './workflow-log-safety.ts';

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
// ANCHORED. A bare `503` substring-matched the COMMAND TEXT: a hard 404 on run
// `35035035035` classified as transient and burned four attempts and 20 s of
// sleeps — the opposite of what the docstring above promises, and ~0.9% of run
// ids contain `503`. `/EOF/i` matched a job named `eof-check` the same way.
// `5\d\d`, not `50[23]`: GitHub returns 504 Gateway Timeout, and a 504 at
// request ~1700 aborts a tens-of-minutes walk that writes nothing — exactly the
// scenario this retry exists for. `TLS handshake timeout` and `connection
// refused` were missing for the same reason.
/**
 * A `gh` failure, with the fork-controlled parts constrained.
 *
 * Node's `execFileSync` message begins `Command failed: gh <argv…>`, and this
 * script's argv carries a WORKFLOW FILE NAME on nearly every call. Git stores a
 * newline in a path, so a fork can ship one.
 */
const ghFailure = (args: readonly string[], error: unknown): string =>
  `gh ${safeText(args.slice(0, 2).join(' '))} failed: ` +
  safeText(String((error as { stderr?: string }).stderr ?? (error as Error)?.message ?? error));

/**
 * The next window to try when a listing came back capped, or `null` to refuse.
 *
 * EXTRACTED BECAUSE TWO OF THIS PR'S BLOCKERS LIVED IN THIS ARITHMETIC, and the
 * file's own doctrine — `walkMayStop` was extracted for exactly this reason —
 * had been applied everywhere except the code that produced them. One round
 * removed a floor and made the loop's exit true on its first iteration, so the
 * halving never ran; the round before it slept on a terminal attempt. Neither
 * was reachable from a case, because the enclosing loop makes network calls.
 *
 * `Number.isInteger` is not defensive dressing: `NaN <= 0` is FALSE and
 * `Math.floor(NaN / 2) >= NaN` is FALSE, so a non-finite span would have spun
 * this loop forever issuing `gh` calls with an `Invalid Date` range. It is
 * unreachable today only because the flag parser validates first — which is a
 * property of the caller, not of this function.
 */
export const nextWindow = (days: number): number | null => {
  if (!Number.isInteger(days) || days <= 0) return null;
  const next = Math.floor(days / 2);
  return next < MIN_WINDOW_DAYS ? null : next;
};

/** Attempts per `gh` call, including the first. See the loop below. */
const ATTEMPTS = 3;

const TRANSIENT =
  /dial tcp|operation timed out|connection re(set|fused)|TLS handshake timeout|\bEOF\b|\bHTTP 5\d\d\b|timeout awaiting/;

const gh = (args: readonly string[]): unknown => {
  let lastError: unknown;
  // ONE constant, because encoding "three attempts" in three places produced
  // two measured bugs in two rounds: `attempt < 4` printed "retry 4/3" and
  // slept 8 s before rethrowing, and after that was corrected the TERMINAL
  // attempt still printed "retry 3/2" and slept six seconds before rethrowing.
  // Both were the same wait that bought nothing, surviving at a smaller number.
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    let out: string;
    try {
      out = execFileSync('gh', [...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch (error) {
      lastError = error;
      // `error.stderr` ALONE, never `String(error)`. Node's message for a
      // failed `execFileSync` is `Command failed: gh run list --workflow <f>`
      // followed by the stderr — so `String(error)` both duplicates the stderr
      // and drags the COMMAND TEXT, which carries a fork-controlled workflow
      // file name, into the classifier. Measured: a workflow named `EOF.yml`
      // made every hard failure on it match `\bEOF\b`, turning a 404 into
      // three attempts and six seconds of sleeps.
      const text = String((error as { stderr?: string }).stderr ?? '');
      // RETHROWN SANITISED, not raw. Excluding the command text from the
      // CLASSIFIER was only half of it: `main` catches nothing, so the original
      // error reaches the terminal with its `Command failed: gh run list …
      // --workflow <name>` prefix intact — and a workflow file name may carry a
      // newline, which puts `::error::` at column 0.
      if (!TRANSIENT.test(text)) throw new Error(ghFailure(args, error));
      // Linear, not exponential: the failures this retries are single dropped
      // connections rather than a server asking us to slow down, and a long
      // backoff on a thousands-of-requests walk costs more than it saves.
      if (attempt === ATTEMPTS - 1) break;
      const waitMs = 2000 * (attempt + 1);
      process.stderr.write(
        `  transient gh failure, retry ${attempt + 1}/${ATTEMPTS - 1} after ${waitMs}ms\n`,
      );
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs);
      continue;
    }
    // OUTSIDE the retried block: a malformed response is not transient, and
    // retrying it only repeats the same bytes. It also stopped a parse error
    // whose text happened to contain a transient-looking word from retrying.
    return JSON.parse(out) as unknown;
  }
  throw new Error(ghFailure(args, lastError));
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
 * highest-volume one in the repo: 106/71/274/389/496 successful runs per day
 * over 2026-09-12..09-16, not a rare one. (Two earlier revisions of this figure
 * were wrong in two different ways: "~885 in a day" was the RANGE total
 * restated as a daily rate, and the six-day version ended on 2026-09-17, a day
 * still in progress when it was taken — the same in-progress-day defect this
 * PR had already fixed once, recurring inside the prose that replaced it.) An exemption list absorbing a generator defect is the exact failure this
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
    // A NON-STRING `name:` is refused rather than silently falling back to the
    // job id. YAML makes `name: 123` a number, the API then sends `"123"`, and
    // the fallback would key the job by its id — producing a job with no
    // snapshot entry, which is the exact state that used to be papered over by
    // an exemption. `String(...)` matches what the API will send.
    const raw = isMapping(node) ? node['name'] : undefined;
    const display =
      raw === undefined || raw === null
        ? job
        : typeof raw === 'string'
          ? raw
          : String(raw);
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
    } catch {
      // NO BINDING, because the error must not be rendered: it QUOTES the
      // offending source, which on `pull_request` is a fork's own bytes. A
      // bound name is an invitation to interpolate it in the next edit.
      throw new Error(
        `${safeName(file)} does not parse, so its jobs cannot be enumerated; fix the workflow`,
      );
    }
    if (!isMapping(doc) || !isMapping(doc['jobs']) || Object.keys(doc['jobs']).length === 0) {
      throw new Error(
        `${safeName(file)} declares no jobs mapping; refusing to write a partial snapshot`,
      );
    }
    for (const job of Object.keys(doc['jobs'])) keys.push(`${file}/${job}`);
  }
  return keys;
};

interface RunRow {
  readonly id: number;
  readonly seconds: number;
}

/**
 * May the descending walk stop before this run?
 *
 * Extracted as a pure predicate so it can be FENCED. It lived inside `main()`
 * with the network calls, which meant the one line carrying the whole
 * snapshot's coverage guarantee — `allSeen` — could be deleted without a single
 * case reddening. A reviewer's 200,000 invariant-respecting populations confirm
 * it is correct; being correct and being pinned are different properties, and
 * only the second survives an edit.
 *
 * Two conditions, and the first is the one the earlier revision lacked: every
 * declared job must have been SEEN, because a job with no entry in `maxima` was
 * never in the minimum and a job appearing only in shorter runs was dropped
 * from the snapshot entirely. The second is the original inequality — a job
 * cannot outlast its run, so once the wall clock is at or below every maximum
 * so far, no later run can raise one.
 */
export const walkMayStop = (
  declaredHere: readonly string[],
  maxima: ReadonlyMap<string, number>,
  runSeconds: number,
): boolean => {
  if (!declaredHere.every((key) => maxima.has(key))) return false;
  // NOT DEAD FROM THIS FUNCTION'S SIDE, though it is unreachable from its only
  // production caller: `declaredJobKeys` throws on a jobless workflow, so
  // `declaredHere` is never empty there and the line above already returned.
  // It stays because the guard belongs to the ARITHMETIC — `Math.min()` of
  // nothing is `Infinity`, which would make every run prunable — and this is an
  // exported function with cases of its own that reach it directly.
  if (maxima.size === 0) return false;
  return runSeconds <= Math.min(...maxima.values());
};

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
  if (!Array.isArray(raw)) throw new Error(`unreadable run list for ${safeName(file)}`);
  // The caller decides what to do about a capped listing; `null` says "capped",
  // never a truncated array, so a truncated population cannot be mistaken for a
  // complete one further down.
  if (raw.length >= 1000) return null;
  return raw
    .map((row) => {
      if (!isMapping(row)) throw new Error(`unreadable run row for ${safeName(file)}`);
      const started = Date.parse(String(row['startedAt']));
      const updated = Date.parse(String(row['updatedAt']));
      if (!Number.isFinite(started) || !Number.isFinite(updated)) {
        throw new Error(
          `run ${safeText(String(row['databaseId']))} of ${safeName(file)} has unreadable timestamps`,
        );
      }
      return { id: Number(row['databaseId']), seconds: (updated - started) / 1000 };
    })
    .sort((a, b) => b.seconds - a.seconds);
};

/**
 * Per-job durations of one run, keyed by DECLARED JOB KEY.
 *
 * Only `success` is reachable here, and that is a STATED LIMIT rather than a
 * choice. `failure` and `cancelled` are accepted below, but `runsInRange`
 * filters `--status success` at the RUN level and no workflow here uses
 * `continue-on-error`, so such a job never arrives — measured 0 of 6,746 job
 * records at the time, and 0 of the committed artifact's 4,590. An earlier revision of this comment claimed the opposite, that
 * including them captured "a job killed at its own bound"; it captures nothing.
 *
 * The consequence is worth stating plainly because it bounds what this fence
 * can ever prove: a job that is KILLED at its bound never completes, so the
 * snapshot cannot contain the one observation that would most clearly show a
 * bound is too tight. The fence reasons from how long jobs take when they
 * succeed, and a bound below that is the defect it can see.
 */
const jobDurations = (
  runId: number,
  byDisplay: ReadonlyMap<string, string>,
): Map<string, number[]> => {
  // `--slurp`, because `--paginate` on an OBJECT response concatenates one JSON
  // document per page and `JSON.parse` then throws — measured at position 7384
  // on a run with more than 100 jobs. Without it the `Array.isArray` branch
  // below was dead and such a run aborted the whole walk non-transiently.
  const raw = gh([
    'api',
    `repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`,
    '--paginate',
    '--slurp',
  ]);
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

/**
 * THE SECOND LOCK, and the one that decides the COLOUR of a regression.
 *
 * The entry-point guard below is not enough on its own, and a reviewer measured
 * exactly how it fails: with `invokedDirectly` broken, importing this module
 * for its pure helpers runs the whole walk, OVERWRITES
 * `docs/_generated/workflow-job-durations.json` in place, and the fence then
 * passes — against a snapshot it had just manufactured from live data. The one
 * case that validates the committed artifact (`the real tree reports nothing`)
 * becomes self-referential, which is the defect class this pair of files exists
 * to catch, reproduced in the tool that feeds it.
 *
 * So `main` refuses before it can reach `writeFileSync`, on a signal that is
 * INDEPENDENT of the guard: the test runner's own environment. Break the guard
 * now and the import throws at collection — a loud red naming this function —
 * rather than a green suite and a rewritten input. A silent green is the worst
 * colour a regression can have; this converts it.
 */
export const refuseInsideTestRunner = (env: Record<string, string | undefined>): void => {
  // `VITEST_WORKER_ID` as well as `VITEST`: a forked worker is where an import
  // of this module actually happens, and only the worker is guaranteed to carry
  // the second one.
  if (env['VITEST'] !== undefined || env['VITEST_WORKER_ID'] !== undefined) {
    throw new Error(
      'gen-workflow-job-durations: refusing to run inside the test runner. ' +
        'This script performs a network walk and REWRITES the committed snapshot ' +
        'the fence reads, which would make that fence assert against its own output. ' +
        'Run it from a shell instead: `vp run gen:workflow-durations`.',
    );
  }
};

const main = (): void => {
  refuseInsideTestRunner(process.env);
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
      throw new Error(`unknown argument ${safeText(a)}\n${USAGE}`);
    }
  }
  // A REPEATED flag is refused, because `flag` takes the FIRST match: a
  // `--to=2026-09-16 --to=2026-09-02` reads as the first and walks a range the
  // caller did not ask for, which is the same silent-wrong-population failure
  // as the inverted range below.
  for (const name of ['--from', '--to'] as const) {
    if (argv.filter((a) => a.startsWith(`${name}=`)).length > 1) {
      throw new Error(`${name} given more than once; only one range is walked`);
    }
  }

  const DAY = /^\d{4}-\d{2}-\d{2}$/;
  for (const name of ['--from', '--to'] as const) {
    const value = flag(name);
    if (value !== undefined && (!DAY.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))) {
      // Otherwise `--to=2026-9-17` reaches `Date.parse` and dies with a bare
      // `RangeError: Invalid time value` that names neither the flag nor the
      // value.
      throw new Error(`${name}=${safeText(value)} is not a YYYY-MM-DD date`);
    }
  }
  // An INVERTED range is silent, not empty-with-an-error: `gh run list
  // --created 2026-09-16..2026-09-02` returns zero rows and exits 0, the
  // `capped` check below sees 0 < 1000 and passes, and the generator writes a
  // snapshot of nothing but the jobs it could not find — i.e. exactly the
  // "no entry" state the fence cannot distinguish from "never ran". The
  // `Math.max(MIN_WINDOW_DAYS, ...)` below hides it further by clamping the
  // negative span to a positive one while `from` keeps the inverted value.
  const today = new Date();
  const lastComplete = isoDay(new Date(today.getTime() - 24 * 3600 * 1000));
  // A `--to` ON OR AFTER today is refused rather than accepted and silently
  // recorded as a closed range. An IN-PROGRESS UTC day is the defect that has
  // now reached this PR twice — once in the committed artifact, whose own
  // "closed range population" note it falsified, and once in the prose that
  // replaced the first. Nothing but this line stops it arriving a third time.
  const requestedTo = flag('--to');
  if (requestedTo !== undefined && requestedTo > lastComplete) {
    throw new Error(
      `--to=${safeText(requestedTo)} is not a complete UTC day (the last one is ${lastComplete}); ` +
        'a range ending inside a day in progress is not the closed population this snapshot claims',
    );
  }
  // AND FROM BELOW. Bounding `--to` only from above let a walk of a range from
  // last year write a snapshot with a fresh `generatedAt` — the stamp every run
  // refreshes — over an arbitrarily old population. The fence catches that now
  // (it reads the newest `to`, not the stamp), but a refusal here names the
  // cause at the moment it is caused rather than in a CI failure three steps
  // later. Half the fence's window, so regenerating never lands on the boundary.
  if (requestedTo !== undefined && Date.parse(`${requestedTo}T00:00:00Z`) < Date.now() - 45 * 86400000) {
    throw new Error(
      `--to=${safeText(requestedTo)} is more than 45 days ago; the fence that reads this ` +
        'snapshot refuses a population that old, so writing one only defers the failure',
    );
  }
  const to = requestedTo ?? lastComplete;
  const explicitFrom = flag('--from');
  // NO `Math.max` FLOOR on an explicit span. Clamping it to `MIN_WINDOW_DAYS`
  // widened `--from=X --to=X` into a two-day walk while `requestedRange.from`
  // went on recording X — the artifact describing a narrower population than
  // the one that produced it. The floor belongs to the HALVING loop below,
  // which is where a window can legitimately shrink.
  const windowDays = explicitFrom
    ? Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${explicitFrom}T00:00:00Z`)) / 86400000)
    : DEFAULT_WINDOW_DAYS;
  // THE COMPUTED SPAN, not the raw flag pair. Guarding `rawFrom > rawTo` only
  // fired when BOTH were given, so a lone `--from=<date after the default --to>`
  // walked an inverted range: `gh run list --created 2026-09-30..2026-09-17`
  // returns zero rows at exit 0 for every workflow, the capped check sees
  // 0 < 1000 and passes, and the snapshot is overwritten with `"jobs": {}` —
  // the exact outcome the guard was added to prevent, reached around it.
  if (!Number.isInteger(windowDays) || windowDays <= 0) {
    throw new Error(
      `--from=${safeText(explicitFrom ?? '')} is not before --to=${to}; ` +
        'a range must cover at least one whole day',
    );
  }
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
        // The arithmetic is in `nextWindow`, where a case can reach it.
        const next = nextWindow(days);
        if (next === null) {
          throw new Error(
            `${safeName(file)} has >= 1000 successful runs even in a ${days}-day window ` +
              `(${usedFrom}..${to}); the listing cannot be read without truncation.`,
          );
        }
        days = next;
      }
    }
    ranges.set(file, { from: usedFrom, to });
    // GUARDED, not relying on `declaredJobKeys` having parsed the same file
    // earlier: that is a property of statement ORDER, which is exactly what the
    // fence's own `snapshotGeneratedAt` refuses to rely on. The message names
    // the file and never the parse error, which quotes the fork's source.
    //
    // NOT PINNED, like everything else inside `main`: reaching it needs the
    // network walk this file deliberately leaves untested. The pure parts are
    // extracted precisely so the untested remainder is small and boring.
    let doc: unknown;
    try {
      doc = parseYaml(readFileSync(join(WORKFLOW_DIR, file), 'utf8'));
    } catch {
      throw new Error(`${safeName(file)} stopped parsing mid-walk; fix the workflow and re-run`);
    }
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
      // Measured in production, not hypothetically: `release.yml` has 387
      // successful RUNS, in 45 of which `publish` itself succeeded (299 skipped)
      // — a run total is not a job total, which is measurement rule 1 above and
      // an earlier revision of this very sentence broke it. The longest run
      // contains only
      // `release-please` at 118 s. `min(maxima)` was therefore 118, the second
      // run (116 s) broke the walk, and ONE run of 387 was fetched — in which
      // `publish` happened to be skipped. It then entered the fence's exemption
      // list as "rarely run". A reviewer's brute force over 4000 synthetic
      // populations found 0 understated maxima and 28 whole-job omissions,
      // which is exactly this shape.
      //
      // So the walk may only prune once every declared job of this workflow has
      // been seen at least once.
      if (prune && walkMayStop(declaredHere, maxima, run.seconds)) break;
      runsFetched += 1;
      for (const [key, seconds] of jobDurations(run.id, byDisplay)) {
        if (!declared.has(key)) continue;
        // The prune's soundness rests on `job <= run wall clock`, computed from
        // two different pairs of timestamps and never checked until now. A
        // reviewer measured that 9,526 of 50,000 populations VIOLATING it give
        // a wrong result, so a violation is worth reporting: it means the prune
        // may have stopped early and the run should be re-taken with
        // `--no-prune`.
        //
        // It is a TRIPWIRE, NOT A PROOF, and the difference is the whole point
        // of the prune: this loop only ever sees runs that were FETCHED, and a
        // run pruned away is never fetched, so the one place a violation would
        // do damage is the one place this cannot look. An earlier revision of
        // this comment called the assumption "self-checking", which claims the
        // coverage the prune exists to avoid paying for.
        for (const s of seconds) {
          if (s > run.seconds + 1) {
            process.stderr.write(
              `  WARNING ${safeKey(key)} ran ${Math.round(s)}s inside a ${Math.round(run.seconds)}s run; ` +
                'the prune assumes job <= run. Re-run with --no-prune.\n',
            );
          }
        }
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
    process.stdout.write(`  no successful run in range: ${missing.map(safeKey).join(', ')}\n`);
  }
};

/**
 * Only when RUN, never when imported.
 *
 * Without this guard, importing the module for its pure helpers starts the
 * whole network walk. A script whose pure parts cannot be imported is one whose
 * pure parts cannot be fenced, which is how the name-mapping defect this file
 * now guards against survived in the first place.
 *
 * EXPORTED AND PARAMETERISED BECAUSE BREAKING IT DOES NOT GO RED — and the
 * colour is worse than it first looked. An early probe reported that the
 * mutation HUNG the suite, from a run that hit a 45-second cap; run to
 * completion it is SILENT GREEN: the import performs the whole walk, rewrites
 * `docs/_generated/workflow-job-durations.json`, and the fence then passes
 * 57 of 57 against a snapshot the same run had just manufactured. A hang is
 * loud. This is the fence validating its own output and saying nothing, which
 * is why `main` also refuses to run inside a test runner — see
 * `refuseInsideTestRunner`, whose note is the authority on this and which an
 * earlier revision of THIS paragraph contradicted from 287 lines away, in the
 * same commit.
 *
 * So the predicate takes its two inputs as arguments and is pinned by cases
 * that never touch `process.argv` and never reach `main`.
 */
export const invokedDirectly = (entry: string | undefined, self: string): boolean => {
  // BELT AND BRACES, not a load-bearing arm: deleting this line is an
  // EQUIVALENT mutation, because `realpathSync(undefined)` throws and the
  // `catch` below already answers `false`. It is kept because the answer should
  // not depend on a throw, and it is labelled because an earlier revision of
  // this comment claimed the opposite — that without it the module-scope call
  // dies with a stack — which the probe refuted.
  if (entry === undefined) return false;
  try {
    // `realpathSync` THROWS on a path that is not real, and this runs at module
    // scope of a file the fence imports — an ENOENT here would kill the whole
    // suite's collection with a stack rather than a finding.
    return self === realpathSync(entry);
  } catch {
    return false;
  }
};

if (invokedDirectly(process.argv[1], import.meta.filename)) {
  main();
}
