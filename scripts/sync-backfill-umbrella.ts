/**
 * sync-backfill-umbrella — rewrite the backfill campaign's GENERATED CHECKLIST
 * BLOCK inside the umbrella issue's body from `main`'s coverage map.
 *
 * Consumes the JSON plan `diagnose-schema-refresh.mjs --umbrella-types` renders
 * and makes the region between `<!-- backfill-types:start -->` and
 * `<!-- backfill-types:end -->` equal to it — one row per resource type that
 * still has silently-dropped properties:
 *
 *   - [ ] `AWS::RDS::DBInstance` — 62 properties: `AllocatedStorage`, …
 *
 * Everything OUTSIDE those two markers is the campaign's human-written half —
 * the audit provenance, the procedure, which pull request closed which slice —
 * and is carried through byte for byte. Nothing here can recompute it.
 *
 * Run by `.github/workflows/backfill-umbrella-sync.yml`, which fires on a push
 * touching `src/provisioning/property-coverage.generated.ts` and on
 * `workflow_dispatch`.
 *
 * ## WHY ONE BLOCK AND NOT ~44 ISSUES
 *
 * go-to-k/cdkd#2949 minted one GENERATED ISSUE per resource type and linked them
 * as GitHub sub-issues; this file used to create, rewrite, reopen and close that
 * set. Measured afterwards: 44 of the repository's 240 open issues were bot-filed
 * slices of one campaign. In the public open-issue count a generated slice is
 * indistinguishable from a defect nobody has fixed, and no reader of that count
 * can tell the two apart — so the campaign now lives as ONE issue whose body
 * carries the generated rows, and the per-type issues are closed
 * (`--close-legacy`, run once, by hand).
 *
 * What did NOT change is that the rows are GENERATED all the way down. An
 * append-only hand-maintained list cannot express a type that was ticked off and
 * later regained a property: the `[x]` row stays checked and a second row
 * appears for the same type, so the reader sees one entry saying "done" and
 * another saying "not". The coverage map is the campaign's own stated completion
 * criterion, so the block is rendered FROM it every time and a tick is never
 * preserved — what closes a row is the property leaving `silentDrop`, at which
 * point the row disappears on its own.
 *
 * ## NO DEPENDENCIES
 *
 * Only `node:` builtins and the sibling renderer, for the same reason the render
 * mode has none: the workflow runs with `run-install: false`, and
 * go-to-k/cdkd#2858 is the measured cost of an import graph reaching a package
 * that step never installs — the sync failed on every run it had, from the day
 * it landed. The renderer loads its heavy helpers on demand, so importing it
 * reaches only `node:` builtins. Node 24 strips the type annotations, so this
 * runs as `node scripts/sync-backfill-umbrella.ts`.
 *
 * ## WHAT IT REFUSES, AND WHY EACH REFUSAL IS NOT A WARNING
 *
 * Every refusal below exits NON-ZERO and mutates nothing. A green run that
 * changed nothing is not a notification, and here the alternative to refusing is
 * not a stale list but a WRONG one, on the campaign's only public page. The
 * workflow fences this from its side too: nothing after the invocation of this
 * script may swallow its status.
 *
 *   1. **A plan with no types, while the block still holds rows.** "The campaign
 *      is finished" and "the parser stopped recognising `silentDrop`" render
 *      identically as an empty `types` array, and `parseSilentDropByType` throws
 *      only on zero type BOUNDARIES — a drifted inner regex parses 44 types into
 *      0 groups without erroring. Reading that as finished wipes the whole
 *      checklist on a green run. Genuine completion happens once, ever, and
 *      passes `--allow-empty-plan` to say so. (Under #2949 the same refusal
 *      guarded a mass-CLOSE of 44 issues; the shape moved, the trap did not.)
 *   2. **A body with no markers, or with either marker twice.** Without them
 *      there is no region to rewrite, and the alternatives are both destructive:
 *      appending publishes a second, competing list, and guessing a region
 *      overwrites human text. Two starts (or two ends) make the region
 *      ambiguous, and splicing the first pair strands whatever the second pair
 *      holds — an orphan no later run can find, which is the unrecoverable shape
 *      the per-type design's duplicate-marker refusal guarded.
 *   3. **A plan naming one type twice.** Two rows for one type, and nothing can
 *      say which property list is the live one.
 *   4. **A body that would exceed GitHub's limit.** An issue body caps at
 *      {@link MAX_BODY_CHARS} characters; past it the PATCH is rejected, and the
 *      campaign is stuck with whichever half-truth was last written. It replaces
 *      #2949's cap on sub-issues per parent: a documented product limit is a
 *      refusal (the campaign needs a different shape) and never a truncation.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
// The campaign-level sentence and the name renderer, imported rather than
// re-typed. The module they come from loads its heavy helpers on demand
// (go-to-k/cdkd#2858), so this import reaches only `node:` builtins and the
// no-`node_modules` guarantee this script needs survives it.
import { UMBRELLA_EMPTY_SENTINEL, renderName } from './diagnose-schema-refresh.mjs';

/**
 * The markers delimiting the generated region of the umbrella's body.
 *
 * HTML comments, so a reader never sees them, and they are the whole contract
 * between this script and a human editing the same page: text outside them is
 * theirs and is never rewritten. They are not rendered by anything — a body that
 * lost them is REFUSED rather than re-marked, because "where did the generated
 * block use to be" is not a question this script can answer without guessing at
 * a region of someone else's prose.
 */
export const BLOCK_START = '<!-- backfill-types:start -->';

/** The closing half of {@link BLOCK_START}. */
export const BLOCK_END = '<!-- backfill-types:end -->';

/**
 * The label on the RETIRED per-type issues, read only by `--close-legacy`.
 *
 * Kept rather than deleted: the closed issues carry it, and it is how the
 * one-shot migration finds the ones still open. Nothing GENERATES it any more.
 */
export const LEGACY_SUBISSUE_LABEL = 'backfill-type';

/**
 * GitHub's cap on an issue body, in characters.
 *
 * A documented product limit rather than a tuning knob, so exceeding it is a
 * refusal and not a truncation: a truncated body publishes a list that silently
 * stops partway, and the rows that fall off look FINISHED.
 */
export const MAX_BODY_CHARS = 65_536;

/** One entry of the `--umbrella-types` plan. */
export interface PlannedType {
  type: string;
  properties: string[];
}

/** The whole plan document. */
export interface Plan {
  types: PlannedType[];
}

/** A refusal: the run must stop having mutated nothing. */
export class ReconcileRefusal extends Error {}

/**
 * Check a parsed plan is the document this script thinks it is.
 *
 * Separate from the JSON parse because the failure it catches is not a syntax
 * error: a plan rendered by a drifted parser is valid JSON with the wrong shape,
 * and every field below reaches a PUBLIC page. A missing `properties` array
 * would render `undefined` into the campaign's checklist rather than throwing.
 */
export function validatePlan(plan: unknown): Plan {
  if (typeof plan !== 'object' || plan === null || !Array.isArray((plan as Plan).types)) {
    // The `types` wrapper exists for exactly this: a bare array could not tell
    // "empty campaign" from "not the document we asked for".
    throw new ReconcileRefusal("this is not a rendered plan: it has no 'types' array.");
  }
  const types = (plan as Plan).types;
  for (const entry of types) {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof entry.type !== 'string' ||
      !Array.isArray(entry.properties) ||
      entry.properties.some((p) => typeof p !== 'string')
    ) {
      throw new ReconcileRefusal(
        `plan entry ${JSON.stringify(entry)} is not a {type, properties} pair. Refusing to ` +
          'publish a checklist rendered from a document this script cannot read.'
      );
    }
  }
  return { types };
}

/**
 * The generated block's CONTENT — the rows, or the finished-campaign sentence.
 *
 * Sorted by type rather than left in the coverage map's order, so a row moving
 * inside the generated file does not reorder a public list and make every
 * reader's diff meaningless.
 *
 * Every name reaches the page through `renderName`. Type names come from a
 * boundary pattern that admits only `[A-Z][\w:]+`, but property names are
 * captured as `[^']+` and are NOT so constrained — one carrying a backtick or a
 * newline would otherwise end a row, or the block, early.
 *
 * The sentence for an empty campaign is IMPORTED, not re-typed: an empty block
 * renders as a blank stretch of page, which reads as a broken job rather than a
 * finished campaign.
 */
export function renderChecklistBlock(plan: Plan): string {
  if (plan.types.length === 0) return UMBRELLA_EMPTY_SENTINEL;
  const sorted = [...plan.types].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
  return sorted
    .map(({ type, properties }) => {
      const count = properties.length;
      const names = properties.map((p) => renderName(p)).join(', ');
      return `- [ ] ${renderName(type)} — ${count} ${count === 1 ? 'property' : 'properties'}: ${names}`;
    })
    .join('\n');
}

/** Where a marker sits in a body, having refused every ambiguous answer. */
function locateBlock(body: string): { start: number; end: number } {
  const present = (marker: string) => body.split(marker).length - 1;
  for (const marker of [BLOCK_START, BLOCK_END]) {
    const seen = present(marker);
    if (seen === 0) {
      throw new ReconcileRefusal(
        `the umbrella issue's body carries no '${marker}' marker. The generated checklist is ` +
          'written BETWEEN the two markers and nowhere else, so there is no region to rewrite. ' +
          'Add both marker lines where the block belongs and re-run; appending would publish a ' +
          'second, competing list.'
      );
    }
    if (seen > 1) {
      throw new ReconcileRefusal(
        `the umbrella issue's body carries '${marker}' ${seen} times. Refusing to guess which ` +
          'pair delimits the generated block — splicing one pair leaves whatever the other holds ' +
          'stranded on the page, and no later run can find it. Leave exactly one of each.'
      );
    }
  }
  const start = body.indexOf(BLOCK_START);
  const end = body.indexOf(BLOCK_END);
  if (end < start) {
    throw new ReconcileRefusal(
      `the umbrella issue's body carries '${BLOCK_END}' BEFORE '${BLOCK_START}'. The region ` +
        'between them is not a block, and rewriting it would delete the text that sits between ' +
        'the markers in the wrong order.'
    );
  }
  return { start, end };
}

/**
 * The body this run would publish, and whether that is a change at all.
 *
 * The pure half, and the one worth testing. `changed === false` must mean NO
 * write: this job fires on every coverage-map push and most pushes move one
 * type, so a run that rewrote the body regardless would fill the campaign's
 * timeline with edits that changed nothing and bury the `updated_at` ordering
 * every triage query relies on.
 *
 * The splice is INDEX-based over the stored bytes rather than a regex replace,
 * which is what makes "hand-written text is preserved" true for a body a human
 * opened in the GitHub WEB UI: that stores CRLF, and a rewrite that normalised
 * the whole page would report a diff on every line the first time and — worse —
 * count as a change forever if anything re-introduced CR. Only the region
 * between the markers is authored here; both halves outside it are copied.
 *
 * @param body the umbrella issue's current body, as stored
 * @param plan the rendered plan
 * @param allowEmptyPlan the operator's one-time confirmation that the campaign
 *   really is finished (refusal 1)
 */
export function planBodyRewrite(
  body: string,
  plan: Plan,
  allowEmptyPlan = false
): { body: string; changed: boolean } {
  const seen = new Set<string>();
  for (const entry of plan.types) {
    if (seen.has(entry.type)) {
      throw new ReconcileRefusal(
        `the plan names ${entry.type} twice. Refusing to publish two rows for one type — ` +
          'nothing here can say which property list is the live one.'
      );
    }
    seen.add(entry.type);
  }

  const { start, end } = locateBlock(body);
  const current = body.slice(start + BLOCK_START.length, end);

  if (plan.types.length === 0 && !allowEmptyPlan) {
    // Read off the block that is actually published, not off a count kept
    // elsewhere: what an empty plan would DESTROY is these rows.
    const rows = current.split('\n').filter((line) => line.trimStart().startsWith('- [ ] ')).length;
    if (rows > 0) {
      throw new ReconcileRefusal(
        `the plan carries no resource types while the umbrella's checklist holds ${rows} row(s). ` +
          'That is either a finished campaign or a coverage-map parse that stopped recognising ' +
          'silentDrop, and the two are indistinguishable from here. Re-run with ' +
          '--allow-empty-plan to confirm the campaign is genuinely complete.'
      );
    }
  }

  const next = `${body.slice(0, start)}${BLOCK_START}\n${renderChecklistBlock(plan)}\n${body.slice(end)}`;
  if (next.length > MAX_BODY_CHARS) {
    throw new ReconcileRefusal(
      `the rewritten body would be ${next.length} characters, past GitHub's limit of ` +
        `${MAX_BODY_CHARS}. The edit would be rejected outright, so the campaign would keep ` +
        'whatever it says today. This shape has been outgrown — split the campaign rather than ' +
        'truncating the list, because a list that stops partway reads as finished.'
    );
  }
  return { body: next, changed: next !== body };
}

/** How a command is run — injectable so the tests never reach GitHub. */
export type Runner = (args: string[]) => string;

const ghRunner: Runner = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

/**
 * Read the umbrella issue's body.
 *
 * `--jq .body` rather than parsing the JSON here: the body is the only field
 * this script reads, and a body containing a lone `\r` or a stray backslash is
 * text either way.
 *
 * EVERY call passes `--repo`, including the ones `gh` could resolve from the git
 * remote. Two resolution rules in one script is a way for the read half and the
 * write half to disagree about which repository they are reconciling — the
 * checkout's remote and `GITHUB_REPOSITORY` are the same thing in this workflow
 * and need not be anywhere else.
 */
export function fetchUmbrellaBody(run: Runner, repo: string, parent: number): string {
  const raw = run(['issue', 'view', String(parent), '--repo', repo, '--json', 'body', '--jq', '.body']);
  if (raw === '') {
    throw new ReconcileRefusal(
      `issue #${parent} reported an EMPTY body. An empty answer and a failed read are the same ` +
        'string here, and rewriting from either one would publish a page with nothing but the ' +
        'generated block on it.'
    );
  }
  // `gh --jq` terminates its output with a newline that is not part of the
  // field. Left on, it would sit inside the body on every write — appending one
  // blank line per run, forever, and reporting `changed` each time.
  return raw.endsWith('\n') ? raw.slice(0, -1) : raw;
}

/**
 * Publish a rewritten body.
 *
 * By `--body-file`, never as an argument: an issue body is multi-line generated
 * text wrapped around human prose, and the argv path keeps it out of any shell
 * and out of the process listing.
 */
export function writeUmbrellaBody(
  run: Runner,
  repo: string,
  parent: number,
  body: string,
  scratch: string
): void {
  const file = join(scratch, 'umbrella-body.md');
  writeFileSync(file, body);
  run(['issue', 'edit', String(parent), '--repo', repo, '--body-file', file]);
}

/** One issue the retired per-type set left open. */
export interface LegacyIssue {
  number: number;
  title: string;
}

/**
 * The comment every retired per-type issue is closed with.
 *
 * It names the label rather than an issue number: the umbrella moves by
 * `gh issue edit --add-label`, and a number written into forty-odd closing
 * comments could not follow it.
 */
export const LEGACY_CLOSE_COMMENT =
  'Folded into the checklist in the umbrella issue (backfill-umbrella label); this per-type ' +
  'issue is no longer generated.';

/** How many legacy issues one `--close-legacy` pass asks for. */
export const LEGACY_LIST_LIMIT = 200;

/** Every OPEN issue still carrying {@link LEGACY_SUBISSUE_LABEL}. */
export function fetchLegacyIssues(run: Runner, repo: string): LegacyIssue[] {
  const raw = run([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--label',
    LEGACY_SUBISSUE_LABEL,
    '--limit',
    String(LEGACY_LIST_LIMIT),
    '--json',
    'number,title',
  ]);
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    // An empty result and a malformed one both reach the caller as "nothing to
    // close", and here that difference is the whole outcome of the migration.
    throw new ReconcileRefusal(`gh issue list returned ${typeof parsed}, not an array.`);
  }
  return parsed as LegacyIssue[];
}

/**
 * Close one retired per-type issue.
 *
 * `not planned` rather than `completed`: the type's properties are still
 * unwired. What ended is the ISSUE, not the work, and a `completed` close would
 * tell every later reader — and every "what did we finish" query — the opposite.
 */
export function closeLegacyIssue(run: Runner, repo: string, number: number): void {
  run([
    'issue',
    'close',
    String(number),
    '--repo',
    repo,
    '--reason',
    'not planned',
    '--comment',
    LEGACY_CLOSE_COMMENT,
  ]);
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

const USAGE =
  'usage: REPO=<owner/repo> PARENT=<n> sync-backfill-umbrella.ts <plan.json> ' +
  '[--dry-run] [--allow-empty-plan]\n' +
  '       sync-backfill-umbrella.ts <plan.json> --render-block\n' +
  '       REPO=<owner/repo> sync-backfill-umbrella.ts --close-legacy [--dry-run]';

/** Read and validate the plan a positional argument names. */
function readPlan(planPath: string): Plan {
  const parsed: unknown = JSON.parse(readFileSync(planPath, 'utf8'));
  try {
    return validatePlan(parsed);
  } catch (err) {
    throw err instanceof ReconcileRefusal
      ? new ReconcileRefusal(`${planPath}: ${err.message}`)
      : err;
  }
}

/** The one-shot migration: close what the retired per-type design left open. */
function closeLegacy(repo: string, dryRun: boolean): void {
  const issues = fetchLegacyIssues(ghRunner, repo);
  for (const issue of issues) {
    console.log(`${dryRun ? '[dry-run] ' : ''}close #${issue.number} ${issue.title}`);
    if (!dryRun) closeLegacyIssue(ghRunner, repo, issue.number);
  }
  if (issues.length === LEGACY_LIST_LIMIT) {
    // Not a refusal: closing is idempotent and additive, so a truncated page
    // costs a second pass rather than a wrong answer — unlike the per-type
    // design's listing, where a dropped issue looked NEW and got duplicated.
    console.log(
      `the listing came back at its limit of ${LEGACY_LIST_LIMIT} — re-run to close the rest.`
    );
  }
  console.log(
    `sync-backfill-umbrella: ${issues.length} legacy issue(s) ${dryRun ? 'would be ' : ''}closed.`
  );
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
  const renderOnly = args.includes('--render-block');
  const legacy = args.includes('--close-legacy');
  const repo = process.env['REPO'];
  const parent = Number(process.env['PARENT']);

  try {
    // Renders the block and exits, reaching neither GitHub nor a token. This is
    // how the two markers get their first content — a body that has never been
    // synced is refused, deliberately, so the operator pastes the block in once
    // and every run after that is a rewrite.
    if (renderOnly) {
      if (!planPath) {
        console.error(USAGE);
        process.exitCode = 2;
        return;
      }
      console.log(`${BLOCK_START}\n${renderChecklistBlock(readPlan(planPath))}\n${BLOCK_END}`);
      return;
    }

    if (legacy) {
      if (!repo) {
        console.error(USAGE);
        process.exitCode = 2;
        return;
      }
      closeLegacy(repo, dryRun);
      return;
    }

    if (!planPath || !repo || !Number.isInteger(parent) || parent <= 0) {
      console.error(USAGE);
      process.exitCode = 2;
      return;
    }

    const plan = readPlan(planPath);
    const body = fetchUmbrellaBody(ghRunner, repo, parent);
    const rewrite = planBodyRewrite(body, plan, allowEmptyPlan);

    console.log(
      `${dryRun ? '[dry-run] ' : ''}${plan.types.length} type(s) in the plan; the umbrella's ` +
        `block ${rewrite.changed ? 'CHANGES' : 'is already current'}.`
    );
    if (dryRun) {
      console.log(`${BLOCK_START}\n${renderChecklistBlock(plan)}\n${BLOCK_END}`);
      console.log('nothing written.');
      return;
    }
    if (!rewrite.changed) {
      console.log('sync-backfill-umbrella: no write.');
      return;
    }

    const scratch = mkdtempSync(join(tmpdir(), 'backfill-umbrella-'));
    writeUmbrellaBody(ghRunner, repo, parent, rewrite.body, scratch);
    console.log(`sync-backfill-umbrella: rewrote the generated block of #${parent}.`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`sync-backfill-umbrella: ${message}`);
    process.exitCode = err instanceof ReconcileRefusal ? 1 : 2;
  }
}

if (isMain()) main();
