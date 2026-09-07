/**
 * PR-title prefix/scope check — the CI port of two deleted PreToolUse hooks.
 *
 * REPLACES
 *   .claude/hooks/pr-title-prefix-scope-gate.sh   (+ its .test.sh, 22 cases)
 *   .claude/hooks/commit-prefix-scope-gate.sh     (+ its .test.sh, 34 cases)
 *
 * THE RULE (unchanged from both hooks)
 *   A `feat:` or `fix:` conventional-commit prefix is what makes release-please
 *   cut a version bump AND write a user-facing CHANGELOG line. So a subject
 *   carrying one must be backed by at least one changed file under `src/**`.
 *   Anything else — dev tooling, `.claude/**`, docs, tests, build/CI — is
 *   invisible to someone running the cdkd binary, and a release note for it
 *   reads as a CLI change that does not exist.
 *
 *   Incident that produced the commit-side gate: PR #346 (2026-05-13) committed
 *   a `/review-pr` skill edit as `feat(review-pr): ...` and shipped v0.97.0 whose
 *   CHANGELOG "Features" line described internal agent tooling.
 *   Incident that produced the title-side gate: PR #562 / issue #565
 *   (2026-05-24) — a `.claude/**`-only diff titled
 *   `fix(hooks): make markgate gate hooks cwd-aware (#559)` shipped v0.145.1.
 *   Every local commit was correctly typed `chore:`; only the TITLE was wrong.
 *   A tag and a changelog entry are unrecoverable once published.
 *
 * ── WHY THE TWO HOOKS COLLAPSE INTO ONE CHECK ────────────────────────────────
 *
 * The commit-side gate is genuinely SUBSUMED by the title-side check here, and
 * the subsumption rests on three MEASURED repository settings, not on a habit:
 *
 *     $ gh api repos/go-to-k/cdkd --jq \
 *         '{squash_merge_commit_title, squash_merge_commit_message,
 *           allow_merge_commit, allow_rebase_merge}'
 *     { "squash_merge_commit_title":   "PR_TITLE",
 *       "squash_merge_commit_message": "BLANK",
 *       "allow_merge_commit":  false,
 *       "allow_rebase_merge":  false }          # measured 2026-09-07
 *
 *   1. `allow_merge_commit` / `allow_rebase_merge` are BOTH false, so GitHub
 *      itself permits only squash — a branch commit can never reach `main` as
 *      its own commit object. (CLAUDE.md's "Merge PRs with squash only" is the
 *      same rule stated as policy; this is the server-side enforcement of it.)
 *   2. `squash_merge_commit_title: PR_TITLE` means the squash SUBJECT is the PR
 *      title unconditionally. This is the load-bearing one: under GitHub's other
 *      option, `COMMIT_OR_PR_TITLE`, a single-commit PR takes that COMMIT's
 *      subject and the commit-side check would still be doing real work.
 *   3. `squash_merge_commit_message: BLANK` means the squash BODY is empty. The
 *      default (`COMMIT_MESSAGES`) concatenates the branch commits' messages
 *      into the body, which is the other way a stray `feat:` could reach
 *      release-please's parser (it reads footers such as `BREAKING CHANGE:` out
 *      of the body).
 *
 *   With all three holding, the ONLY conventional-commit subject release-please
 *   ever parses for this repo is the PR title, and every branch commit subject
 *   is discarded at merge. Checking the title is therefore checking the whole
 *   release surface.
 *
 *   WHAT THE SUBSUMPTION DOES NOT COVER, and what this file does about it:
 *
 *   (a) The settings can be flipped in the GitHub UI with nothing in the repo
 *       noticing, and the day one is flipped the deleted commit-side gate
 *       becomes load-bearing again. `checkSquashSubsumption()` below is the
 *       fence for that: the workflow asserts the three settings still hold and
 *       fails with instructions when they do not. A subsumption argument that
 *       nothing re-checks is exactly the silently-vacuous check this port is
 *       supposed to avoid.
 *   (b) LOCALITY. The hook refused at `git commit`; CI answers at PR time. That
 *       is a latency loss, not a coverage loss — but it is recoverable, so
 *       `--git-diff` runs the identical verdict against the working tree
 *       (`git diff --name-only origin/main...HEAD`) for `/verify-pr` or a
 *       pre-push check.
 *
 * ── WHAT CI GAINS OVER THE HOOK ──────────────────────────────────────────────
 *
 *   The hook fired ONCE, at `gh pr create` (and at the `gh api -X PATCH ...
 *   -f title=` edit form). It could not see anything that happened afterwards.
 *   This job is triggered on `synchronize` as well as `opened`/`edited`, so the
 *   sequence the hook was structurally blind to is now caught:
 *
 *       1. open a PR titled `fix(deploy): ...` with `src/deployment/x.ts`
 *          changed  -> hook passes, correctly
 *       2. push a commit reverting that file, leaving a `.claude/**`-only diff
 *          -> hook never runs again; the PR merges and ships a bogus patch
 *             release. CI re-runs on the push and fails.
 *
 *   The `edited` trigger closes the mirror case (diff untouched, title retyped
 *   to `fix:` in the web UI, which never goes through `gh` at all — a shape the
 *   hook could not observe even in principle).
 *
 * ── WHAT WAS DROPPED ─────────────────────────────────────────────────────────
 *
 *   All of it is shell parsing, and it was ~90% of both hooks:
 *     - `lib/command-match.sh` sourcing, the fail-closed API probes, and the
 *       command-position verb matcher (issues #1455 / #2129) that kept
 *       `echo "gh pr create --title fix: ..."` from firing the gate;
 *     - `cd <path>` / `git -C <path>` / `gh -C <path>` target-directory
 *       resolution and its strict refusal on an unexpanded `$VAR` (#2027);
 *     - title extraction from `--title "x"` / `--title 'x'` / `--title=x` and
 *       from `-f|-F|--field|--raw-field title=...` on the `gh api` PATCH form;
 *     - subject extraction from `-m` / `--message=` / `-F <file>` / the
 *       `-F -` heredoc form, plus the `--amend` and bare-`git commit`
 *       pass-throughs;
 *     - the `pulls/[0-9]+` endpoint match, the is-this-a-git-repo probe, and
 *       the `origin/main` fail-open.
 *   A CI job is handed the title and the changed-file list as data, so none of
 *   that has an analogue. Every case in the two deleted suites that existed to
 *   test the PARSER is therefore gone by construction; every case that tested a
 *   VERDICT is ported to tests/unit/scripts/pr-title-prefix-scope.test.ts.
 *
 * ── WHAT WAS PRESERVED, EXACTLY ──────────────────────────────────────────────
 *
 *   - the release-triggering prefix set: `feat` and `fix` ONLY;
 *   - `revert:` passes through (it carries the reverted commit's own prefix in
 *     its body; conventional-commits treats it as its own type);
 *   - every other type (`chore` / `docs` / `test` / `refactor` / `perf` /
 *     `style` / `ci` / `build` / ...) passes regardless of the file mix;
 *   - the grammar `type(scope)?!?:<space>` — lowercase type only, optional
 *     scope, optional breaking `!`, and a REQUIRED space after the colon. A
 *     subject that does not match is not a conventional commit, release-please
 *     ignores it, and so do we;
 *   - "any path under `src/`" as the sole scope test, anchored at the start of
 *     the path (`foo/src/bar.ts` and `srcfoo/x.ts` do not count);
 *   - the suggested-prefix heuristic and its precedence order:
 *       all docs (`docs/**`, `README.md`, `CLAUDE.md`, any nested `README.md`) -> docs
 *       all `tests/**`                                                -> test
 *       all `.claude/**`                                              -> chore
 *       all of {`package.json`, `pnpm-lock.yaml`}                     -> chore(deps)
 *       otherwise                                                     -> chore
 *   - the 3-dot diff (`origin/main...HEAD`): what the branch ADDS on top of the
 *     merge base, which is what GitHub's "Files changed" tab and `gh pr diff`
 *     show and what release-please will ship;
 *   - the empty-diff pass-through (nothing to ship; `gh pr create` has its own
 *     clearer error) and the 20-file truncation in the failure message.
 *
 * ── USAGE ────────────────────────────────────────────────────────────────────
 *
 *   node scripts/check-pr-title-prefix-scope.ts --title "<title>" --files-from <path>
 *   node scripts/check-pr-title-prefix-scope.ts --title "<title>" --files-from -   # stdin
 *   node scripts/check-pr-title-prefix-scope.ts --git-diff        # local, vs origin/main
 *   node scripts/check-pr-title-prefix-scope.ts --check-settings <repo-settings.json>
 *
 *   Exit 0 = allow, 1 = violation. The title may also arrive as $PR_TITLE.
 */

import { foldAnnotationText } from './annotation-text.ts';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

/**
 * The ONLY prefixes release-please turns into a version bump + a user-facing
 * CHANGELOG entry, and therefore the only ones that require `src/**`.
 * `feat` -> minor (this repo maps breaking to minor via `bump-minor-pre-major`),
 * `fix`  -> patch. Everything else is silent to release-please.
 */
export const RELEASE_TRIGGERING_PREFIXES = ['feat', 'fix'] as const;

/**
 * Conventional-commit header grammar, ported verbatim from the bash
 * `^([a-z]+)(\([^\)]+\))?!?:[[:space:]]`.
 *
 * Three properties are deliberate, and each one is a pass (not a block) when it
 * fails to match — release-please ignores a non-conforming subject, so blocking
 * on one would be inventing a rule the release flow does not have:
 *   - the type is LOWERCASE ASCII letters only: `Fix: x` and `feat2: x` are not
 *     conventional commits;
 *   - the space after the colon is REQUIRED: `fix:x` does not match;
 *   - the scope body is any non-`)` text, and the breaking `!` is optional and
 *     sits after the scope.
 */
const CONVENTIONAL_HEADER = /^([a-z]+)(\([^)]+\))?!?: /;

/** Path predicates, each anchored the way the hooks' `case ... in` patterns were. */
const IS_SRC = (f: string) => f.startsWith('src/');
const IS_DOCS = (f: string) =>
  f.startsWith('docs/') || f === 'README.md' || f === 'CLAUDE.md' || f.endsWith('/README.md');
const IS_TESTS = (f: string) => f.startsWith('tests/');
const IS_CLAUDE = (f: string) => f.startsWith('.claude/');
const IS_DEPS = (f: string) => f === 'package.json' || f === 'pnpm-lock.yaml';

/** Why a verdict came out the way it did. Every arm of the hooks' flow has one. */
export type VerdictReason =
  /** No title at all — `gh pr create` with no `--title` opened an editor; a PR always has one by the time CI runs. */
  | 'no-title'
  /** Subject is not `type(scope)?!?: ...` — release-please skips it, so we do too. */
  | 'not-conventional'
  /** `revert:` carries the reverted commit's prefix; conventional-commits passes it through. */
  | 'revert'
  /** `chore` / `docs` / `test` / `refactor` / ... — no version bump, no CHANGELOG entry. */
  | 'non-release-prefix'
  /** `feat:`/`fix:` backed by at least one `src/**` path. The allowed case. */
  | 'src-present'
  /** Branch adds nothing over the merge base. Nothing to ship, nothing to mislabel. */
  | 'no-diff'
  /** THE VIOLATION: `feat:`/`fix:` with no `src/**` in the 3-dot diff. */
  | 'no-src';

export interface PrefixScopeVerdict {
  /** false ONLY for reason `no-src`. */
  ok: boolean;
  /** The conventional-commit type, or null when the title is not conventional / absent. */
  prefix: string | null;
  reason: VerdictReason;
  /** Present only on a violation: what the title should have said instead. */
  suggestedPrefix?: string;
  /** The changed-file list the verdict was computed against. */
  files: string[];
}

/**
 * Extract the conventional-commit type from a subject line.
 * Only the FIRST line is considered: a PR title is single-line, but a pasted
 * multi-line body must not let line 2 supply the prefix.
 */
export function parseConventionalPrefix(title: string): string | null {
  const subject = title.split('\n', 1)[0] ?? '';
  const m = CONVENTIONAL_HEADER.exec(subject);
  return m ? (m[1] as string) : null;
}

/** True when any changed path lives under `src/`. */
export function hasSrcFile(files: readonly string[]): boolean {
  return files.some(IS_SRC);
}

/**
 * The hooks' suggested-prefix heuristic, precedence order preserved.
 *
 * Each arm is "ALL files are X **and** there is at least one file" — the second
 * half matters: with an empty list every `all_*` flag is vacuously true, and the
 * bash used the paired `has_*` flag to fall through to `chore` instead of
 * claiming a docs-only change.
 */
export function suggestPrefix(files: readonly string[]): string {
  const all = (p: (f: string) => boolean) => files.length > 0 && files.every(p);
  if (all(IS_DOCS)) return 'docs';
  if (all(IS_TESTS)) return 'test';
  if (all(IS_CLAUDE)) return 'chore';
  if (all(IS_DEPS)) return 'chore(deps)';
  return 'chore';
}

/**
 * The whole check, as a pure function of the two inputs CI is handed directly.
 *
 * `files` is the 3-dot diff (`origin/main...HEAD`) — what the branch ADDS over
 * the merge base, i.e. what `gh pr diff` and the "Files changed" tab show, and
 * what the squash commit will ship.
 */
export function checkPrTitlePrefixScope(
  title: string,
  files: readonly string[],
): PrefixScopeVerdict {
  const list = files.filter((f) => f.trim().length > 0);

  if (!title.trim()) return { ok: true, prefix: null, reason: 'no-title', files: list };

  const prefix = parseConventionalPrefix(title);
  if (prefix === null) {
    return { ok: true, prefix: null, reason: 'not-conventional', files: list };
  }
  if (prefix === 'revert') {
    return { ok: true, prefix, reason: 'revert', files: list };
  }
  if (!(RELEASE_TRIGGERING_PREFIXES as readonly string[]).includes(prefix)) {
    return { ok: true, prefix, reason: 'non-release-prefix', files: list };
  }

  // From here the prefix WILL cut a release, so the diff decides.
  if (list.length === 0) {
    return { ok: true, prefix, reason: 'no-diff', files: list };
  }
  if (hasSrcFile(list)) {
    return { ok: true, prefix, reason: 'src-present', files: list };
  }
  return {
    ok: false,
    prefix,
    reason: 'no-src',
    suggestedPrefix: suggestPrefix(list),
    files: list,
  };
}

/** How many changed files the failure message lists before truncating (ported from the hook). */
export const MAX_LISTED_FILES = 20;

/** The human-facing failure text. Ported from the hooks' block message. */
export function formatFailure(v: PrefixScopeVerdict): string {
  // The PATHS are fork-controlled: git permits a carriage return in a filename,
  // and this string is written to stderr as a `::error::` annotation, where the
  // Actions runner parses any line whose trimmed form starts with `::` as a
  // workflow command. A path `x<CR>::stop-commands::y` would escape the `  - `
  // prefix and start one. Found by `annotation-text.test.ts`'s derived fence on
  // its first run -- this checker was the FOURTH emitter, and the one nobody
  // had thought of (go-to-k/cdkd#2736).
  const shown = v.files.slice(0, MAX_LISTED_FILES).map((f) => `  - ${foldAnnotationText(f)}`);
  if (v.files.length > MAX_LISTED_FILES) {
    shown.push(`  ...truncated (>${MAX_LISTED_FILES} files)`);
  }
  return [
    `PR title prefix '${v.prefix}:' feeds a release-please version bump AND`,
    `lands in the user-facing CHANGELOG, but the branch diff against origin/main`,
    `contains no file under src/**. The change is internal (dev tooling / docs /`,
    `tests / build), not a cdkd CLI behavior change, and would mislead users`,
    `reading the release notes.`,
    ``,
    `Branch diff files (none in src/**):`,
    ...shown,
    ``,
    `Suggested title prefix: ${v.suggestedPrefix}:`,
    ``,
    `Mapping:`,
    `  src/**                                 -> feat: or fix:`,
    `  docs/** / README.md / CLAUDE.md        -> docs:`,
    `  tests/** only                          -> test:`,
    `  .claude/** (hook / skill / agent)      -> chore:`,
    `  package.json + pnpm-lock.yaml only     -> chore(deps):`,
    `  build / CI / .gitignore / config       -> chore:`,
    ``,
    `Retitle the PR (the web UI, or:`,
    `  gh api -X PATCH repos/<owner>/<repo>/pulls/<N> -f title="${v.suggestedPrefix}: ...")`,
    `and this check re-runs on the 'edited' event.`,
  ].join('\n');
}

/**
 * The three GitHub repository settings the squash-subsumption argument in this
 * file's header depends on. Shape matches `gh api repos/{owner}/{repo}`.
 */
export interface RepoMergeSettings {
  squash_merge_commit_title?: string;
  squash_merge_commit_message?: string;
  allow_merge_commit?: boolean;
  allow_rebase_merge?: boolean;
  /**
   * Fetched, deliberately never asserted on. GitHub refuses to disable every
   * merge method, so `allow_squash_merge: false` forces one of the other two
   * ON -- which the `allow_merge_commit` / `allow_rebase_merge` clause below
   * already raises a violation for. Kept in the shape so a reader can see the
   * field was considered rather than missed.
   */
  allow_squash_merge?: boolean;
}

/**
 * Re-check the premise that let `commit-prefix-scope-gate.sh` be deleted.
 *
 * Deleting a per-commit check because "only the PR title reaches main" is sound
 * exactly while the repo is configured that way. These settings live in the
 * GitHub UI, outside the repo, and flipping one is invisible to every reviewer.
 * So the argument is asserted, not assumed — an unasserted subsumption argument
 * is how a check goes silently vacuous.
 */
export function checkSquashSubsumption(s: RepoMergeSettings): {
  ok: boolean;
  violations: string[];
  /** True when the caller's token cannot SEE the merge settings at all. */
  unreadable?: boolean;
} {
  // ABSENT IS NOT WRONG. GitHub returns `squash_merge_commit_title` /
  // `_message` only to a token with admin on the repository; a workflow's
  // `GITHUB_TOKEN` gets `null` for both however the repo is configured.
  // Measured on this repo 2026-09-07: a personal token reads PR_TITLE / BLANK,
  // and the CI job reading the same endpoint got null / null and reported the
  // premise BROKEN -- a check that cannot see its input reporting on it.
  //
  // So an absent pair is "could not evaluate", reported by the caller as a
  // WARNING, and never a violation. The audit still does its job wherever a
  // token can see the fields (a maintainer's `/verify-pr`, a PAT-carrying
  // workflow); what it must not do is red every PR on a permission boundary.
  // READABILITY IS ALL-OR-NOTHING, and the previous revision got this wrong in
  // the direction that looks green. It skipped only the two title/message
  // fields, on the stated premise that "the merge-method booleans ARE readable
  // by any token". MEASURED 2026-09-07, that premise is FALSE: GitHub nulls
  // ALL FIVE fields for a token without admin.
  //
  //   gh api repos/aws/aws-cdk   -> every field null      (no admin)
  //   gh api repos/go-to-k/cdkd  -> false/false/PR_TITLE  (admin)
  //
  // So in CI `allow_merge_commit === true` was never true, no violation could
  // ever be raised, and the job printed "merge methods are squash-only" -- an
  // UNEARNED PASS. That is strictly worse than the failure it replaced: the
  // first bug red a PR wrongly and was noticed in minutes; this one would have
  // reported a premise as holding forever without ever testing it.
  //
  // A field is EVIDENCE only when it arrives as the type it should be. Anything
  // else -- null, undefined, absent -- means the token could not see it, and a
  // check that cannot see its input reports that, never a verdict.
  const seen =
    typeof s.allow_merge_commit === 'boolean' &&
    typeof s.allow_rebase_merge === 'boolean' &&
    s.squash_merge_commit_title != null &&
    s.squash_merge_commit_message != null;
  const unreadable = !seen;
  const violations: string[] = [];
  if (seen && s.squash_merge_commit_title !== 'PR_TITLE') {
    violations.push(
      `squash_merge_commit_title is '${s.squash_merge_commit_title}', expected 'PR_TITLE'. ` +
        `Under COMMIT_OR_PR_TITLE a single-commit PR squashes under that COMMIT's subject, ` +
        `so a mislabelled commit reaches release-please without passing through the PR title.`,
    );
  }
  if (seen && s.squash_merge_commit_message !== 'BLANK') {
    violations.push(
      `squash_merge_commit_message is '${s.squash_merge_commit_message}', expected 'BLANK'. ` +
        `COMMIT_MESSAGES concatenates every branch commit message into the squash body, ` +
        `which release-please also parses (BREAKING CHANGE / footers).`,
    );
  }
  if (seen && (s.allow_merge_commit === true || s.allow_rebase_merge === true)) {
    violations.push(
      `allow_merge_commit=${s.allow_merge_commit} allow_rebase_merge=${s.allow_rebase_merge}: ` +
        `a non-squash merge lands each branch commit on main under its OWN subject, ` +
        `which this title-only check never sees.`,
    );
  }
  return { ok: violations.length === 0, violations, unreadable };
}

/** The message printed when the subsumption premise no longer holds. */
export function formatSubsumptionFailure(violations: readonly string[]): string {
  return [
    `The squash-only premise that lets ONE title check stand in for the deleted`,
    `per-commit check no longer holds:`,
    ``,
    ...violations.map((v) => `  - ${v}`),
    ``,
    `Either restore the settings, or re-introduce a per-commit prefix/scope check`,
    `(git log origin/main..HEAD, each commit's subject against its own`,
    `git show --name-only) alongside this one. See the header of`,
    `scripts/check-pr-title-prefix-scope.ts.`,
  ].join('\n');
}

/** Split a newline-delimited file list, tolerating CRLF and blank lines. */
export function parseFileList(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.replace(/\r$/, '').trim())
    .filter((l) => l.length > 0);
}

/**
 * The local (`--git-diff`) file list. `core.quotePath=false` keeps a non-ASCII
 * path from arriving as a `"src/\303\251.ts"` C-quoted string, which would fail
 * the `src/` prefix test and silently excuse the PR.
 */
function gitDiffFiles(): string[] {
  const out = execFileSync(
    'git',
    ['-c', 'core.quotePath=false', 'diff', '--name-only', 'origin/main...HEAD'],
    { encoding: 'utf8' },
  );
  return parseFileList(out);
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : undefined;
}

export function main(argv: readonly string[]): number {
  const settingsPath = argValue(argv, '--check-settings');
  if (settingsPath !== undefined) {
    let settings: RepoMergeSettings;
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as RepoMergeSettings;
    } catch (err) {
      // 2, not 1. An unreadable or malformed settings file means the audit COULD
      // NOT RUN, and exiting 1 makes that indistinguishable in CI from a real
      // settings violation -- two states with opposite remedies. Uncaught, it
      // was an ENOENT stack trace at exit 1 (go-to-k/cdkd#2717 fix-delta review).
      process.stderr.write(
        `::error::cannot read the repository settings file: ${(err as Error).message}\n`,
      );
      return 2;
    }
    const r = checkSquashSubsumption(settings);
    if (r.unreadable) {
      process.stdout.write(
        '::warning::squash-subsumption NOT VERIFIED: this token cannot read the ' +
          'repository merge settings (GitHub returns ALL of them only to an admin ' +
          'token), so this step checked nothing. It is a reminder, not enforcement. ' +
          'The audit runs for real in `/verify-pr`.\n',
      );
    }
    if (!r.ok) {
      process.stderr.write(`::error::${formatSubsumptionFailure(r.violations)}\n`);
      return 1;
    }
    process.stdout.write(
      r.unreadable
        ? 'squash-subsumption: NOT VERIFIED. This token cannot read the merge ' +
          'settings (GitHub returns them only to an admin token), so NOTHING ' +
          'about the premise was checked here. The audit that does check it runs ' +
          'in `/verify-pr`, with a token that can see them.\n'
        : 'squash-subsumption premise holds (PR_TITLE / BLANK / squash-only).\n',
    );
    return 0;
  }

  const title = argValue(argv, '--title') ?? process.env.PR_TITLE ?? '';

  let files: string[];
  if (argv.includes('--git-diff')) {
    files = gitDiffFiles();
  } else {
    const from = argValue(argv, '--files-from');
    // THE FILE SOURCE MUST BE NAMED. Reading stdin whenever `--files-from` is
    // absent means a bare invocation blocks forever on whatever stdin it
    // inherited -- measured 2026-09-07, `node scripts/check-pr-title-prefix-scope.ts`
    // from an agent shell hung until a 2-minute timeout killed it. A check that
    // HANGS is worse than one that fails: in CI it burns the job timeout and is
    // then KILLED, and a killed step reports no verdict at all -- the same
    // reason a PreToolUse hook must not outlive its budget
    // (`.claude/rules/hooks.md`).
    //
    // `process.stdin.isTTY` is the WRONG guard and was the first attempt: CI has
    // no TTY either, so it would never fire in the place that matters while
    // looking like it had closed the hole. The stdin form is spelled
    // `--files-from -` instead, the conventional marker, which makes "no source
    // named" unambiguous and answerable with usage.
    if (from === undefined) {
      process.stderr.write(
        'usage: check-pr-title-prefix-scope.ts --title "<title>" ' +
          '(--files-from <path> | --files-from - | --git-diff)\n' +
          '       check-pr-title-prefix-scope.ts --check-settings <repo-settings.json>\n',
      );
      return 2;
    }
    files = parseFileList(from === '-' ? readFileSync(0, 'utf8') : readFileSync(from, 'utf8'));
  }

  // The file list is printed HERE rather than by a `cat` in the workflow.
  //
  // These paths are fork-controlled and arrive JSON-DECODED from
  // `gh api .../files --jq .filename` -- unlike `git diff --name-only`, which
  // C-quotes control bytes whatever `core.quotePath` says. A `cat` put them at
  // COLUMN 0, so `docs/a<CR>::stop-commands::x.md` forged a workflow command on
  // every run. Doing it in shell needs a portable control-character class and
  // there is not one: a first attempt with BSD `sed` mangled every `o` and left
  // the carriage return intact (measured on macOS). Node has the shared fold,
  // so the printing moved to where the fold already is.
  //
  // Bracketed so an empty or whitespace-only path is still visible.
  process.stdout.write(`Changed files (${files.length}):\n`);
  for (const f of files) process.stdout.write(`  [${foldAnnotationText(f)}]\n`);

  const v = checkPrTitlePrefixScope(title, files);
  if (v.ok) {
    process.stdout.write(
      `PR title prefix check passed (${v.reason}; ` +
        `prefix=${v.prefix ?? 'none'}, ${v.files.length} changed file(s)).\n`,
    );
    return 0;
  }
  process.stderr.write(`::error::${formatFailure(v)}\n`);
  return 1;
}

/**
 * `import.meta.url === \`file://${process.argv[1]}\`` is WRONG in two ways that
 * both end in the script exiting 0 having done nothing. Node resolves the main
 * module to its REALPATH while `argv[1]` keeps the symlink, and a path needing
 * percent-encoding (a space, a `#`) never string-matches its file URL.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  process.exitCode = main(process.argv.slice(2));
}
