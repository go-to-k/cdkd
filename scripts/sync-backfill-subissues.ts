/**
 * sync-backfill-subissues — reconcile the backfill campaign's per-resource-type
 * GitHub sub-issues against `main`'s coverage map.
 *
 * Consumes the JSON plan `diagnose-schema-refresh.mjs --umbrella-subissues`
 * renders, and makes the repository's issues equal to it:
 *
 *   - a type with remaining properties and no issue  -> CREATE, label, link to
 *     the parent
 *   - a type whose issue exists but is stale         -> UPDATE its body
 *   - a type whose issue is closed                   -> REOPEN
 *   - an issue whose type is no longer in the plan   -> CLOSE
 *
 * Run by `.github/workflows/backfill-umbrella-sync.yml`, which fires on a push
 * touching `src/provisioning/property-coverage.generated.ts` and on
 * `workflow_dispatch`.
 *
 * ## WHY THIS IS A SCRIPT AND NOT THE WORKFLOW'S SHELL
 *
 * The step it replaces would be ~200 lines of `bash` assembling multi-line issue
 * bodies, and go-to-k/cdkd#2717 already made this move for the retired
 * PreToolUse hooks: a workflow's `run:` block is the one part of this repository
 * no test can read, and the failure mode here is not a wrong verdict but
 * MUTATION of ~44 public issues. The decision half is pure and exported
 * ({@link planReconciliation}); the `gh` half is a thin executor over an
 * injectable runner. `tests/unit/scripts/sync-backfill-subissues.test.ts` drives
 * both.
 *
 * ## NO DEPENDENCIES
 *
 * Only `node:` builtins, for the same reason `--umbrella-subissues` has none:
 * the workflow runs with `run-install: false`, and go-to-k/cdkd#2858 is the
 * measured cost of an import graph reaching a package that step never installs —
 * the sync failed on every run it had, from the day it landed. Node 24 strips
 * the type annotations, so this runs as `node scripts/sync-backfill-subissues.ts`.
 *
 * ## WHAT IT REFUSES, AND WHY EACH REFUSAL IS NOT A WARNING
 *
 * Every refusal below exits NON-ZERO and mutates nothing. A green run that
 * changed nothing is not a notification, and here the alternative to refusing is
 * not a stale list but a wrong one, publicly, at ~44 issues per run. The
 * workflow fences this from its side too: nothing after the invocation of this
 * script may swallow its status.
 *
 *   1. **A plan with no types, while open sub-issues exist.** "The campaign is
 *      finished" and "the parser stopped recognising `silentDrop`" render
 *      identically as an empty `types` array, and `parseSilentDropByType` throws
 *      only on zero type BOUNDARIES — a drifted inner regex parses 44 types into
 *      0 groups without erroring. Reading that as finished mass-closes the whole
 *      campaign on a green run. Genuine completion happens once, ever, and
 *      passes `--allow-empty-plan` to say so.
 *   2. **ANY open labelled issue with no readable marker.** The marker is how a
 *      type finds its issue; if one goes missing, that type looks new and the
 *      run mints a DUPLICATE while the original stays open forever — never
 *      updated, never closed, invisible to every later run, and unreachable by
 *      the self-healing rewrite because nothing can find it. The condition is
 *      per-issue and not "none of them are readable": the all-or-nothing
 *      spelling passes the PARTIAL case, which is the likelier one (one body
 *      hand-edited, not a spelling change across the set) and is equally
 *      unrecoverable. Zero existing issues is the FIRST RUN and is fine; a
 *      CLOSED unmarked issue is inert and ignored.
 *   3. **Two issues carrying the same type marker.** Ambiguous, and guessing
 *      which to update leaves the other to rot.
 *   4. **More types than GitHub will accept as sub-issues of one parent.**
 *      Half-linking is worse than not starting.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The marker halves the renderer writes, imported rather than re-typed. The
// module they come from loads its heavy helpers on demand (go-to-k/cdkd#2858),
// so this import reaches only `node:` builtins and the no-`node_modules`
// guarantee this script needs survives it.
import {
  SUBISSUE_TYPE_MARKER_PREFIX,
  SUBISSUE_TYPE_MARKER_SUFFIX,
} from './diagnose-schema-refresh.mjs';

/**
 * GitHub's cap on sub-issues under one parent.
 *
 * A documented product limit rather than a tuning knob, so exceeding it is a
 * refusal (the campaign would need a different shape) and not a truncation.
 */
export const MAX_SUB_ISSUES = 100;

/** The label marking a generated per-type backfill issue. */
export const SUBISSUE_LABEL = 'backfill-type';

/**
 * The marker halves a sub-issue is keyed by — ALIASED from the renderer that
 * writes them, never re-typed.
 *
 * One side writes the marker and the other reads it, and a drift between the two
 * spellings is silent: every type looks new, and the run mints a second full set
 * of duplicates beside the originals. Two literals is exactly how that drift
 * happens, so there is one.
 */
export const MARKER_PREFIX = SUBISSUE_TYPE_MARKER_PREFIX;

/** The closing half of {@link MARKER_PREFIX}. */
export const MARKER_SUFFIX = SUBISSUE_TYPE_MARKER_SUFFIX;

/** One entry of the `--umbrella-subissues` plan. */
export interface PlannedType {
  type: string;
  count: number;
  title: string;
  body: string;
}

/** The whole plan document. */
export interface Plan {
  types: PlannedType[];
}

/** An issue already carrying {@link SUBISSUE_LABEL}. */
export interface ExistingIssue {
  number: number;
  state: 'OPEN' | 'CLOSED';
  title: string;
  body: string;
}

/** One mutation the reconciliation asks for. */
export type Action =
  | { kind: 'create'; type: string; title: string; body: string }
  | { kind: 'update'; number: number; type: string; title: string; body: string }
  | { kind: 'reopen'; number: number; type: string }
  | { kind: 'close'; number: number; type: string };

/**
 * Read the resource type an issue body declares, or `undefined`.
 *
 * Three tests, each catching something the others do not — measured one clause
 * at a time, because a first reading of this guard got the division of labour
 * wrong in both directions:
 *
 *   - **The TYPE CLASS** is what rejects a marker QUOTED inside prose (this
 *     file's own documentation, a comment explaining the mechanism, a review
 *     quoting a body back). The type is sliced at a FIXED offset, so any text
 *     before the marker shifts the slice and it returns a tail of
 *     `backfill-type: ` or of the prose. Relaxing `startsWith` to `includes` is
 *     therefore an EQUIVALENT mutation, and an assertion "fencing the anchor"
 *     would be claiming something it does not have.
 *   - **`startsWith`** is NOT equivalent to deleting it, though the input that
 *     shows it is not the obvious one. Prose followed by a REAL marker does not
 *     discriminate — that shifts the slice into `backfill-type: `, which the
 *     class rejects anyway. What discriminates is a line carrying no marker at
 *     all whose bytes line up: any text ending in ` -->` with a class-valid
 *     substring at offset `MARKER_PREFIX.length`, e.g.
 *     `"Mentioned in review AWS::S3::Bucket -->"`. Without the anchor that
 *     binds a live issue to a type it never mentioned.
 *   - **`endsWith`** is the one whose absence is worst, and its failure is
 *     silent rather than loud. The slice ends at `length - MARKER_SUFFIX.length`
 *     unconditionally, so for a line `PREFIX + type + tail` where `tail` is a
 *     MANGLED suffix, a reader without this test returns `type + tail` with its
 *     last four characters removed. With a short tail that eats into the type:
 *     `<!-- backfill-type: AWS::S3::BucketX` yields `AWS::S3::Buc` — a perfectly
 *     class-valid string that no plan can ever match, so that issue is never
 *     updated and never closed while the real type looks new and gets a
 *     duplicate. Refusal 2's exact outcome, reached PAST refusal 2, which only
 *     sees types it could not read at all.
 *
 *     A tail of exactly four characters is the trap inside the trap: it chops to
 *     the CORRECT type, so a worked example built on one shows no defect at all.
 *     An earlier revision of this very paragraph used `…BucketXXXX` and was
 *     wrong for that reason.
 *
 * So delete none of the three on the theory that another covers it. Same
 * reasoning as the dup-check marker's line anchor.
 *
 * `\r` is stripped first. A body edited in the GitHub WEB UI is stored with
 * CRLF, so the marker line ends `-->\r` and a suffix test against `' -->'`
 * fails — which reads as "this issue has no marker" and, through refusal 2,
 * either stops the run or (with other issues matching) mints a duplicate for
 * that one type. Measured on this repository: 3 of the 100 most recent issue
 * comments carry CR.
 */
export function readMarkerType(body: string): string | undefined {
  for (const line of body.replace(/\r/g, '').split('\n')) {
    if (!line.startsWith(MARKER_PREFIX) || !line.endsWith(MARKER_SUFFIX)) continue;
    const type = line.slice(MARKER_PREFIX.length, line.length - MARKER_SUFFIX.length);
    // The renderer's own type class: letters, digits, `_` and `:`. A name
    // outside it cannot have come from the coverage map's boundary pattern, so
    // it is text that merely LOOKS like a marker.
    if (!/^[A-Z][\w:]+$/.test(type)) continue;
    return type;
  }
  return undefined;
}

/** A refusal: the run must stop having mutated nothing. */
export class ReconcileRefusal extends Error {}

/**
 * The mutations that make `existing` equal `plan` — pure, and the half worth
 * testing.
 *
 * Ordering is deliberate: closes come LAST. A run that fails partway through has
 * then created and updated the issues that gained work before removing any that
 * lost it, which is the direction that loses no information — the opposite order
 * can close a type's issue and die before the replacement exists.
 *
 * @param plan the rendered plan
 * @param existing every issue carrying {@link SUBISSUE_LABEL}, open and closed
 * @param allowEmptyPlan the operator's one-time confirmation that the campaign
 *   really is finished (refusal 1)
 */
export function planReconciliation(
  plan: Plan,
  existing: ExistingIssue[],
  allowEmptyPlan = false
): Action[] {
  if (plan.types.length > MAX_SUB_ISSUES) {
    throw new ReconcileRefusal(
      `the plan carries ${plan.types.length} resource types, past GitHub's limit of ` +
        `${MAX_SUB_ISSUES} sub-issues under one parent. Refusing to link a partial set.`
    );
  }

  const byType = new Map<string, ExistingIssue>();
  const unmarked: number[] = [];
  for (const issue of existing) {
    const type = readMarkerType(issue.body);
    if (type === undefined) {
      // OPEN only. A CLOSED labelled issue with no marker is inert — nothing
      // reads it and nothing would act on it — while an OPEN one is a live
      // issue this run cannot match to a type, which is the dangerous half.
      if (issue.state === 'OPEN') unmarked.push(issue.number);
      continue;
    }
    const seen = byType.get(type);
    if (seen !== undefined) {
      throw new ReconcileRefusal(
        `issues #${seen.number} and #${issue.number} both carry the marker for ${type}. ` +
          'Refusing to guess which one is the live sub-issue — close or unlabel one and re-run.'
      );
    }
    byType.set(type, issue);
  }

  if (unmarked.length > 0) {
    throw new ReconcileRefusal(
      `open issue(s) #${unmarked.join(', #')} carry the '${SUBISSUE_LABEL}' label with no ` +
        `readable '${MARKER_PREFIX.trim()}' marker. Each is a live sub-issue this run cannot ` +
        'match to a resource type, so the type would look new and get a DUPLICATE while the ' +
        'original stayed open forever. Restore the marker, or remove the label from an issue ' +
        'that is not a generated sub-issue, then re-run.'
    );
  }

  const openCount = existing.filter((i) => i.state === 'OPEN').length;
  if (plan.types.length === 0 && openCount > 0 && !allowEmptyPlan) {
    throw new ReconcileRefusal(
      `the plan carries no resource types while ${openCount} sub-issue(s) are open. That is ` +
        'either a finished campaign or a coverage-map parse that stopped recognising ' +
        'silentDrop, and the two are indistinguishable from here. Re-run with ' +
        '--allow-empty-plan to confirm the campaign is genuinely complete.'
    );
  }

  const actions: Action[] = [];
  const planned = new Set<string>();
  for (const entry of plan.types) {
    planned.add(entry.type);
    const issue = byType.get(entry.type);
    if (issue === undefined) {
      actions.push({ kind: 'create', type: entry.type, title: entry.title, body: entry.body });
      continue;
    }
    if (issue.state === 'CLOSED') {
      actions.push({ kind: 'reopen', number: issue.number, type: entry.type });
    }
    // Compared after the same CR strip `readMarkerType` applies, so a body a
    // human opened in the web UI does not report as changed on every run
    // forever — an idempotent run must make NO write, or the issue's timeline
    // fills with edits that changed nothing and the `updated_at` ordering
    // every triage query relies on becomes noise.
    if (issue.body.replace(/\r/g, '') !== entry.body || issue.title !== entry.title) {
      actions.push({
        kind: 'update',
        number: issue.number,
        type: entry.type,
        title: entry.title,
        body: entry.body,
      });
    }
  }

  for (const [type, issue] of byType) {
    if (planned.has(type)) continue;
    if (issue.state === 'CLOSED') continue;
    actions.push({ kind: 'close', number: issue.number, type });
  }

  return actions;
}

/** How a command is run — injectable so the tests never reach GitHub. */
export type Runner = (args: string[]) => string;

const ghRunner: Runner = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/**
 * Read every issue carrying {@link SUBISSUE_LABEL}, open and closed.
 *
 * `--state all` because a finished type's issue is CLOSED and must still be
 * found: without it, a type that regains a property looks new and a SECOND issue
 * is minted beside the closed original.
 */
export function fetchExisting(run: Runner, repo: string): ExistingIssue[] {
  const limit = MAX_SUB_ISSUES * 2;
  const raw = run([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'all',
    '--label',
    SUBISSUE_LABEL,
    '--limit',
    String(limit),
    '--json',
    'number,state,title,body',
  ]);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new ReconcileRefusal(`gh issue list returned ${typeof parsed}, not an array.`);
  }
  if (parsed.length === limit) {
    // A FULL page is indistinguishable from a truncated one, and truncation here
    // is not a cosmetic loss: `gh` returns newest-first, so the issues that fall
    // off are the OLDEST — which then look new and get duplicated, the same
    // unrecoverable outcome refusal 2 guards. The limit is twice the sub-issue
    // cap, so reaching it means something else is wearing the label.
    throw new ReconcileRefusal(
      `gh issue list returned exactly ${limit} issues, the requested limit — the result may be ` +
        'truncated, and a dropped issue looks new and gets duplicated. Refusing to reconcile ' +
        'against a listing that may be partial.'
    );
  }
  return parsed as ExistingIssue[];
}

/**
 * Apply one action, returning the issue number it touched.
 *
 * Bodies travel by `--body-file`, never as an argument: an issue body is
 * multi-line generated text, and the argv path keeps it out of any shell and out
 * of the process listing.
 *
 * EVERY call passes `--repo`, including the ones `gh` could resolve from the git
 * remote. Two resolution rules in one script is a way for the read half and the
 * write half to disagree about which repository they are reconciling — the
 * checkout's remote and `GITHUB_REPOSITORY` are the same thing in this workflow
 * and need not be anywhere else.
 */
export function applyAction(run: Runner, repo: string, action: Action, scratch: string): number {
  switch (action.kind) {
    case 'create': {
      const file = join(scratch, 'body.md');
      writeFileSync(file, action.body);
      const url = run([
        'issue',
        'create',
        '--repo',
        repo,
        '--title',
        action.title,
        '--body-file',
        file,
        '--label',
        SUBISSUE_LABEL,
      ]).trim();
      const number = Number(url.split('/').pop());
      if (!Number.isInteger(number) || number <= 0) {
        throw new ReconcileRefusal(
          `gh issue create returned ${JSON.stringify(url)}, which carries no issue number. ` +
            'Refusing to continue without knowing what was just created.'
        );
      }
      return number;
    }
    case 'update': {
      const file = join(scratch, 'body.md');
      writeFileSync(file, action.body);
      run([
        'issue',
        'edit',
        String(action.number),
        '--repo',
        repo,
        '--title',
        action.title,
        '--body-file',
        file,
      ]);
      return action.number;
    }
    case 'reopen':
      run(['issue', 'reopen', String(action.number), '--repo', repo]);
      return action.number;
    case 'close':
      run([
        'issue',
        'close',
        String(action.number),
        '--repo',
        repo,
        '--reason',
        'completed',
        '--comment',
        'Every property of this type is now wired into its provider — the coverage map reports ' +
          'no remaining silent drops. Reopened automatically if the type regains one.',
      ]);
      return action.number;
  }
}

/**
 * Link an issue to the parent as a sub-issue, if it is not already linked.
 *
 * The REST sub-issues endpoint takes the issue's database `id`, not its number,
 * so each link costs a lookup. Already-linked numbers are filtered by the caller
 * rather than by catching the endpoint's error: an error string is a far less
 * stable thing to branch on than a list this code already has.
 */
export function linkSubIssue(run: Runner, repo: string, parent: number, child: number): void {
  const id = run(['api', `repos/${repo}/issues/${child}`, '--jq', '.id']).trim();
  if (!/^\d+$/.test(id)) {
    throw new ReconcileRefusal(
      `issue #${child} reported id ${JSON.stringify(id)}; refusing to POST a sub-issue link ` +
        'with a value that is not an id.'
    );
  }
  run([
    'api',
    '--method',
    'POST',
    `repos/${repo}/issues/${parent}/sub_issues`,
    '-F',
    `sub_issue_id=${id}`,
    '--silent',
  ]);
}

/** The numbers already linked under the parent. */
export function fetchLinked(run: Runner, repo: string, parent: number): Set<number> {
  const raw = run([
    'api',
    '--paginate',
    `repos/${repo}/issues/${parent}/sub_issues`,
    '--jq',
    '.[].number',
  ]);
  return new Set(
    raw
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
  );
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

/**
 * The CLI, as a function rather than a top-level block.
 *
 * Named `main`, not `run`: every helper in this file takes a parameter named
 * `run` (the injected {@link Runner}), so a `run()` at module scope is a name a
 * future edit inside one of them could reach — calling the Runner with no
 * arguments instead of the CLI, silently.
 *
 * `process.exit()` is deliberately absent from every path. On POSIX a `stderr`
 * connected to a PIPE — which is what a GitHub Actions runner gives it — is
 * ASYNCHRONOUS, and `process.exit` drops whatever has not flushed. The line it
 * would drop is the only thing naming WHICH of the refusals fired, and the
 * runbook's recovery keys on that exact sentence; a refusal that exits 1 with no
 * message is a red run nobody can act on. Setting `exitCode` and returning lets
 * Node drain first.
 */
function main(): void {
  const args = process.argv.slice(2);
  const planPath = args.find((a) => !a.startsWith('-'));
  const allowEmptyPlan = args.includes('--allow-empty-plan');
  const dryRun = args.includes('--dry-run');
  const repo = process.env['REPO'];
  const parent = Number(process.env['PARENT']);

  if (!planPath || !repo || !Number.isInteger(parent) || parent <= 0) {
    console.error(
      'usage: REPO=<owner/repo> PARENT=<n> ' +
        'sync-backfill-subissues.ts <plan.json> [--dry-run] [--allow-empty-plan]'
    );
    process.exitCode = 2;
    return;
  }

  try {
    const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Plan;
    if (!Array.isArray(plan.types)) {
      // The `types` wrapper exists for exactly this: a bare array could not tell
      // "empty campaign" from "not the document we asked for".
      throw new ReconcileRefusal(`${planPath} has no 'types' array; this is not a rendered plan.`);
    }
    const existing = fetchExisting(ghRunner, repo);
    const actions = planReconciliation(plan, existing, allowEmptyPlan);

    const numbers = new Map<string, number>();
    for (const issue of existing) {
      const type = readMarkerType(issue.body);
      if (type !== undefined) numbers.set(type, issue.number);
    }

    for (const action of actions) {
      console.log(`${dryRun ? '[dry-run] ' : ''}${action.kind} ${action.type}`);
    }
    if (dryRun) {
      console.log(`${actions.length} action(s) planned; nothing written.`);
      return;
    }

    const scratch = mkdtempSync(join(tmpdir(), 'backfill-subissues-'));
    for (const action of actions) {
      numbers.set(action.type, applyAction(ghRunner, repo, action, scratch));
    }

    // After the mutations, so a freshly created issue is linked in the same run.
    const linked = fetchLinked(ghRunner, repo, parent);
    for (const entry of plan.types) {
      const number = numbers.get(entry.type);
      if (number === undefined || linked.has(number)) continue;
      linkSubIssue(ghRunner, repo, parent, number);
      console.log(`link ${entry.type} (#${number})`);
    }

    console.log(`sync-backfill-subissues: ${actions.length} action(s) applied.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`sync-backfill-subissues: ${message}`);
    process.exitCode = err instanceof ReconcileRefusal ? 1 : 2;
  }
}

if (isMain()) main();
