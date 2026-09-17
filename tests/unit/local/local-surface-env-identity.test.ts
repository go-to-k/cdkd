import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

/**
 * The SIBLING fence to `local-surface-role-identity.test.ts`, guarding the
 * channel that one cannot see (issue
 * [#3130](https://github.com/go-to-k/cdkd/issues/3130)).
 *
 * That fence derives its population from `awsClientDefaults(` call sites, i.e.
 * from the AWS SDK clients this surface builds. But an emulated Lambda / ECS /
 * AgentCore container does not receive an SDK client — it receives three
 * ENVIRONMENT VARIABLES. `applyRoleArnIfSet` overwrites those with a
 * `--role-arn` assumed role's credentials, and every `cdkd local *` command
 * copies them into the container, so the whole class was reachable through a
 * channel that sat entirely outside the fence claiming to close it: a client
 * could opt out with `ignoreAssumedRole`, and the env copy beside it still
 * handed the workload cdkd's deploy role.
 *
 * So this fence derives its population from the env channel itself — every
 * non-comment mention of the credential key `AWS_ACCESS_KEY_ID` on the surface,
 * plus every read of the caller's identity through
 * `src/utils/caller-credentials.ts` — and requires each one to declare a
 * verdict. Neither verdict is the default:
 *
 *   - RESTORES — the site copies `process.env` and its enclosing function calls
 *     `applyCallerIdentityCredentials`, which puts the caller's own identity
 *     back over the role's (or strips the triple when there was none).
 *   - READS-CALLER — the site takes the identity from `callerEnvCredentials()`,
 *     which never returns the role.
 *   - ANNOTATED — a `cdkd-local-env-identity: <reason>` comment above the site
 *     saying why whatever it writes there is already the right identity.
 */
const ROOTS = ['src/local', 'src/cli/commands'];

const EXTRA_SURFACE_FILES = ['src/cli/commands/ecs-service-emulator.ts'];

/**
 * Kept deliberately IDENTICAL to the sibling fence's predicate
 * (`local-surface-role-identity.test.ts`), which spells out why each arm is
 * there: `src/local` is whole; under `src/cli/commands` the surface is the
 * `local-*` files PLUS anything under a `local/` subdirectory; backslashes are
 * normalised. The two fences watch DIFFERENT channels — SDK clients there, the
 * process env here — but they answer the same question about WHICH files are
 * workload-facing, and a file that is in surface for one is in surface for the
 * other. An earlier revision of this one carried the narrower pattern with no
 * stated reason, so the two disagreed about scope: a future
 * `src/cli/commands/local/*.ts` copying the credential triple into a container
 * would have been judged by the sibling and invisible here, which is the one
 * direction a fence must never fail in.
 */
function isInSurface(relPath: string): boolean {
  const path = relPath.split('\\').join('/');
  if (!path.endsWith('.ts')) return false;
  if (path.startsWith('src/local/')) return true;
  if (EXTRA_SURFACE_FILES.includes(path)) return true;
  return /^src\/cli\/commands\/local(-[A-Za-z0-9_-]*|\/.+)\.ts$/.test(path);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

type Verdict = 'restores' | 'reads-caller' | 'annotated' | 'undeclared';

interface Site {
  file: string;
  line: number;
  text: string;
  verdict: Verdict;
}

/**
 * The QUOTED key only: `'AWS_ACCESS_KEY_ID'` is how the code names the variable
 * (an index, an array entry), while a bare mention inside a template literal is
 * an error message telling the user which variable to set. A message delivers no
 * identity, so requiring a verdict on one would be noise the next author learns
 * to paste past.
 */
const CREDENTIAL_KEY_SITE = /'AWS_ACCESS_KEY_ID'/;
const CALLER_READ_SITE = /\bcallerEnvCredentials\s*\(/;
const RESTORE_CALL = /\bapplyCallerIdentityCredentials\s*\(/;
const ANNOTATION = 'cdkd-local-env-identity:';
/** See `hasAnnotationAbove` for why this is generous rather than tight. */
const ANNOTATION_SPAN = 12;

function isComment(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * Does the block CONTAINING this line restore the caller's identity?
 *
 * Scanning forward to the next module-level `}` bounds the search to the
 * enclosing top-level function, which is how every forwarding site here is
 * written. Deliberately not a fixed line window: the restore sits after the
 * whole pass-through loop, far below the key it corrects, and a window wide
 * enough to reach it would also reach into the NEXT function and credit a site
 * that restores nothing.
 */
function enclosingBlockRestores(lines: string[], index: number): boolean {
  for (let i = index; i < lines.length; i++) {
    if (RESTORE_CALL.test(lines[i] ?? '') && !isComment(lines[i] ?? '')) return true;
    if (i > index && /^\}/.test(lines[i] ?? '')) return false;
  }
  return false;
}

/**
 * Seeded from the ROOTS walk PLUS `EXTRA_SURFACE_FILES`, matching the sibling
 * fence. `isInSurface` accepting a path is not enough on its own: the walk only
 * ever offers it files under a ROOT, so an extra entry living outside them
 * would be accepted by the predicate and never presented to it.
 */
function surfaceFiles(): string[] {
  const files = new Set<string>();
  for (const root of ROOTS) for (const file of walk(root)) files.add(file);
  for (const extra of EXTRA_SURFACE_FILES) if (existsSync(extra)) files.add(extra);
  return [...files].sort();
}

/**
 * Is the `cdkd-local-env-identity:` marker present above `index`?
 *
 * NOT a line budget. Walking up while the lines are comments, blank, or OPEN
 * an expression the site sits inside (`{` `[` `(` or a trailing comma), and
 * stopping at the first line that CLOSES a statement, reaches every real
 * annotation without a span to tune. That shape is what the sites need: the
 * annotation describes the enclosing STATEMENT, and code sits in between --
 * `if (!spec.env['AWS_ACCESS_KEY_ID']) {` on one, `new Set([` on another.
 *
 * Two spans were tried first and both are worse. A CONTIGUOUS-comment walk
 * stops at that intervening code and reclassified two annotated sites. A fixed
 * window is a number someone must keep raising: at six, lengthening one
 * annotation pushed its marker out and reclassified a DECIDED site; at twelve,
 * a credential write inserted below `docker-runner.ts`'s marker would inherit
 * a reason that is false for it.
 *
 * The direction of that trade is worth stating exactly, because an earlier
 * revision of this comment had it backwards. A too-small span does NOT fail
 * silently -- the site becomes `undeclared` and the suite REDS naming its file
 * and line. A too-large one DOES: the site reads as decided and nothing looks
 * again. So widening trades a loud false positive for a quiet false negative,
 * which is the wrong direction, and saying otherwise is what invites the next
 * widening.
 *
 * The marker must still sit on a COMMENT line, so a match inside a string
 * literal or a rendered message does not count. That guard is DEFENSIVE and
 * currently unexercised -- dropping it leaves every case green, because no
 * site today spells the marker outside a comment. Stated rather than claimed
 * as proven.
 */
function hasAnnotationAbove(lines: string[], index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (isComment(line)) {
      if (line.includes(ANNOTATION)) return true;
      continue;
    }
    const trimmed = line.trim();
    // Blank, or a line that OPENS the construct the site sits in. Anything
    // else closes a statement, and the annotation above it governs that one.
    if (trimmed === '' || /[{[(,]$/.test(trimmed)) continue;
    return false;
  }
  return false;
}

function collectSites(): Site[] {
  const sites: Site[] = [];
  for (const file of surfaceFiles()) {
    if (!isInSurface(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      if (isComment(text)) return;
      const isKeySite = CREDENTIAL_KEY_SITE.test(text);
      const isReadSite = CALLER_READ_SITE.test(text);
      if (!isKeySite && !isReadSite) return;
      const annotated = hasAnnotationAbove(lines, i);
      let verdict: Verdict;
      if (isReadSite) verdict = 'reads-caller';
      else if (enclosingBlockRestores(lines, i)) verdict = 'restores';
      else if (annotated) verdict = 'annotated';
      else verdict = 'undeclared';
      sites.push({ file, line: i + 1, text: text.trim(), verdict });
    });
  }
  return sites;
}

function countOf(sites: Site[], verdict: Verdict): number {
  return sites.filter((s) => s.verdict === verdict).length;
}

describe('every identity reaching an emulated workload through process env declares a verdict', () => {
  const sites = collectSites();

  it('sees the population it claims to guard, per shape', () => {
    // Floors, so a broken walk, a renamed helper or a regex that stopped
    // matching reports a failure rather than a vacuous pass. Measured at the
    // time of writing: 13 sites across 5 files — 3 `restores`, 1 `reads-caller`,
    // 9 `annotated`. The floors sit below that so ordinary deletions do not trip
    // them, but every shape carries its OWN floor: a whole-population floor
    // stays green while one arm silently empties, and the `restores` arm is the
    // one that actually delivers container credentials.
    expect(sites.length, 'total env-channel sites').toBeGreaterThanOrEqual(11);
    expect(new Set(sites.map((s) => s.file)).size, 'files with a site').toBeGreaterThanOrEqual(4);
    expect(countOf(sites, 'restores'), '`restores` sites').toBeGreaterThanOrEqual(3);
    expect(countOf(sites, 'reads-caller'), '`reads-caller` sites').toBeGreaterThanOrEqual(1);
    expect(countOf(sites, 'annotated'), '`annotated` sites').toBeGreaterThanOrEqual(7);
  });

  it('has no site that leaves the question open', () => {
    const undeclared = sites
      .filter((s) => s.verdict === 'undeclared')
      .map((s) => `${s.file}:${s.line}  ${s.text}`);

    expect(
      undeclared,
      'This writes or reads an AWS credential on the `cdkd local` surface, and the process ' +
        'environment it copies from may hold a `--role-arn` assumed role rather than the ' +
        "caller's identity. If the value comes from `process.env`, call " +
        '`applyCallerIdentityCredentials(env)` in the same function (see ' +
        '`src/utils/caller-credentials.ts`). If it comes from the caller, take it from ' +
        '`callerEnvCredentials()`. If neither applies — the identity was chosen by ' +
        '`--assume-role` / `--assume-task-role` / `--profile`, or the value is a ' +
        'placeholder — write a `cdkd-local-env-identity: <reason>` comment above it.'
    ).toEqual([]);
  });

  it('keeps the two fences pointed at different channels', () => {
    // The sibling fence derives from `awsClientDefaults(` and this one from the
    // env channel. If a future refactor made one a subset of the other, the
    // narrower one would be dead weight that still reads as coverage.
    const envChannelFiles = new Set(sites.map((s) => s.file));
    const clientChannelFiles = new Set<string>();
    for (const file of surfaceFiles()) {
      if (!isInSurface(file)) continue;
      const lines = readFileSync(file, 'utf8').split('\n');
      if (lines.some((l) => l.includes('awsClientDefaults(') && !isComment(l))) {
        clientChannelFiles.add(file);
      }
    }
    const envOnly = [...envChannelFiles].filter((f) => !clientChannelFiles.has(f));
    expect(envOnly.length, 'files this fence covers that the client fence cannot').toBeGreaterThan(
      0
    );
  });

  it('keeps a nested `src/cli/commands/local/**` file and the emulator shim in scope', () => {
    // The twin of the sibling fence's own predicate case, and it is here for a
    // measured reason rather than for symmetry: this fence shipped with the
    // NARROW pattern, and reverting to it reds no other case in this file --
    // every floor, the `undeclared` assertion and the disjointness case are
    // byte-identical either way, because no file exercising the difference
    // exists yet. So the widening was unfenced, which is the shape where a
    // later "simplification" silently takes the surface back.
    expect(isInSurface('src/cli/commands/local/foo.ts')).toBe(true);
    expect(isInSurface('src/cli/commands/local-invoke.ts')).toBe(true);
    expect(isInSurface('src/cli/commands/ecs-service-emulator.ts')).toBe(true);
    expect(isInSurface('src/local/nested/deep/thing.ts')).toBe(true);
    expect(isInSurface('src\\local\\nested\\thing.ts')).toBe(true);
    // Still NOT the whole command tree.
    expect(isInSurface('src/cli/commands/deploy.ts')).toBe(false);
    expect(isInSurface('src/cli/commands/localish.ts')).toBe(false);
    expect(isInSurface('src/local/notes.md')).toBe(false);
  });

  it('presents an EXTRA_SURFACE_FILES entry to the predicate even from outside a ROOT', () => {
    // `isInSurface` accepting a path buys nothing if the walk never offers it.
    // Both collectors go through `surfaceFiles()` for that reason; this pins
    // the seeding, which is invisible while every extra entry happens to live
    // under a ROOT -- as today's single entry does.
    expect(surfaceFiles()).toContain('src/cli/commands/ecs-service-emulator.ts');
    for (const extra of EXTRA_SURFACE_FILES) {
      expect(isInSurface(extra), `${extra} must be in surface`).toBe(true);
    }
  });
});
