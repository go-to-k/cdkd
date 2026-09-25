import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The SCOPE and the line-classification rules the two `cdkd local` identity
 * fences share (issue
 * [#3130](https://github.com/go-to-k/cdkd/issues/3130), residual
 * [#3250](https://github.com/go-to-k/cdkd/issues/3250)).
 *
 * `local-surface-role-identity.test.ts` watches the SDK-client channel and
 * `local-surface-env-identity.test.ts` the process-environment one. They ask
 * DIFFERENT questions about a site and the same question about a FILE: is this
 * file workload-facing? Both also have to decide "is this line code or prose"
 * and "does an annotation govern this line", and both got that wrong in the
 * same way at different times.
 *
 * Each of those rules lived twice, and the env copy shipped NARROWER than the
 * role copy every time. So the two disagreed about scope while the env fence's
 * own header asserted they could not, and the assertion was prose: a future
 * `src/cli/commands/local/*.ts` copying the credential triple into a container
 * would have been judged by one fence and invisible to the other. Spelling the
 * rules ONCE makes the claim structural — a weakening reds BOTH fences, and
 * each keeps its own unit cases over these predicates so it reds on its own
 * terms rather than only through its sibling.
 *
 * What is deliberately NOT here: the per-site VERDICT logic. That is the part
 * the two fences genuinely do differently, and merging it would leave one
 * mechanism where the whole point is two independent ones.
 */

/** Walked whole. `src/local` is the emulator; `src/cli/commands` is filtered. */
export const ROOTS = ['src/local', 'src/cli/commands'];

/**
 * One extra file under `src/cli/commands` that no `local-` prefix reaches: the
 * shim re-exporting cdk-local's ECS service emulator, which is what
 * `local start-service` / `local start-alb` run. It builds no client and writes
 * no credential TODAY, which is exactly why it belongs in the population — both
 * fences exist to make the FIRST one decide. `.claude/rules/local-caller-identity.md`
 * names it as a candidate fix site for issue
 * [#3240](https://github.com/go-to-k/cdkd/issues/3240).
 */
export const EXTRA_SURFACE_FILES = ['src/cli/commands/ecs-service-emulator.ts'];

/**
 * `src/local` is whole; under `src/cli/commands` the surface is the `local-*`
 * files PLUS anything under a `local/` subdirectory. The nested arm matters
 * because the original pattern forbade `/` outright, so a future
 * `src/cli/commands/local/foo.ts` would have been silently out of scope — the
 * one direction a fence must never fail in. Backslashes are normalised first so
 * a Windows-shaped path is judged by the same rule.
 */
export function isInSurface(relPath: string): boolean {
  const path = relPath.split('\\').join('/');
  if (!path.endsWith('.ts')) return false;
  if (path.startsWith('src/local/')) return true;
  if (EXTRA_SURFACE_FILES.includes(path)) return true;
  return /^src\/cli\/commands\/local(-[A-Za-z0-9_-]*|\/.+)\.ts$/.test(path);
}

/**
 * Paths come back with FORWARD slashes on every platform, matching the spelling
 * `EXTRA_SURFACE_FILES` and every unit case use. `isInSurface` normalises its
 * own input, but the COLLECTORS did not: on Windows the walk would seed
 * `src\cli\commands\ecs-service-emulator.ts` beside the literal and the Set
 * would hold the file twice, which also makes the env fence's
 * `clientFiles.has(file)` compare across separators.
 */
export function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full.split('\\').join('/'));
  }
  return out;
}

/**
 * Seeded from the ROOTS walk PLUS `EXTRA_SURFACE_FILES`. `isInSurface`
 * accepting a path is not enough on its own: the walk only ever offers it files
 * under a ROOT, so an extra entry living outside them would be accepted by the
 * predicate and never presented to it.
 */
export function surfaceFiles(): string[] {
  const files = new Set<string>();
  for (const root of ROOTS) for (const file of walk(root)) files.add(file);
  for (const extra of EXTRA_SURFACE_FILES) if (existsSync(extra)) files.add(extra);
  return [...files].sort();
}

/** A line that is ENTIRELY prose: `//`, a block opener, or a JSDoc continuation. */
export function isCommentLine(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * Drop line and block comments from ONE line before classifying it.
 *
 * Load-bearing, not tidiness. Every classifier below used to be a raw substring
 * test over the whole line, so a TRAILING comment decided the verdict: in the
 * role fence a `// ignoreAssumedRole: true is not needed here` marked the site
 * opted out, and in the env fence a
 * `// applyCallerIdentityCredentials(env) not needed` marked every credential
 * write above it in the same function as restoring — both the exact opposite of
 * what the comment says.
 *
 * A string literal containing one of the tokens is deliberately not modelled:
 * nothing in the tree has one, and a quote-aware scan would be its own source of
 * silent misses. Comments ARE modelled, because they are where an author
 * explains the very decision being asserted.
 */
export function stripComments(line: string): string {
  return line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
}

/**
 * Is `line` a COMMENT carrying `marker` AND a non-empty reason after it?
 *
 * Both halves are guards a fence lost once. The comment requirement keeps a
 * bare mention on a code line — a string, an identifier — from reading as a
 * verdict. The non-empty reason is the verdict's whole content, so
 * `// cdkd-local-env-identity:` with nothing after it is not one.
 */
export function isAnnotationCommentLine(line: string, marker: string): boolean {
  const trimmed = line.trim();
  if (!isCommentLine(trimmed)) return false;
  const at = trimmed.indexOf(marker);
  if (at === -1) return false;
  return trimmed.slice(at + marker.length).trim().length > 0;
}

/**
 * Does an annotation carrying `marker` govern the line at `index`?
 *
 * NOT a line budget. Walking up while the lines are comments, blank, or OPEN an
 * expression the site sits inside (`{` `[` `(` or a trailing comma), and
 * stopping at the first line that CLOSES a statement, reaches every real
 * annotation without a span to tune. That shape is what the sites need: the
 * annotation describes the enclosing STATEMENT, and code sits in between --
 * `if (!spec.env['AWS_ACCESS_KEY_ID']) {` on one, `new Set([` on another.
 *
 * Two fixed spans were tried first and both are worse, which is why the ROLE
 * fence adopted this shape too (issue #3250 item 6). At six, lengthening one
 * annotation pushed its marker out and reclassified a DECIDED site; at four,
 * FOUR of the role fence's sites sat EXACTLY on the boundary, so one rewrapped
 * word would drop each to undecided. A CONTIGUOUS-comment walk is the third
 * shape and also worse: it stops at the intervening code above and reclassified
 * two annotated env sites.
 *
 * The direction of the trade is worth stating exactly, because an earlier
 * revision of this comment had it backwards. A too-small span does NOT fail
 * silently -- the site becomes undecided and the suite REDS naming its file and
 * line. A too-large one DOES: the site reads as decided and nothing looks again.
 * So widening trades a loud false positive for a quiet false negative, which is
 * the wrong direction, and saying otherwise is what invites the next widening.
 * This walk is not a wider span; it is a different STOP CONDITION, one derived
 * from the code's own structure rather than from a number.
 */
export function hasAnnotationAbove(lines: string[], index: number, marker: string): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (isCommentLine(line)) {
      if (isAnnotationCommentLine(line, marker)) return true;
      continue;
    }
    const trimmed = line.trim();
    // Blank, or a line that OPENS the construct the site sits in. Anything else
    // closes a statement, and the annotation above it governs that one.
    if (trimmed === '' || /[{[(,]$/.test(trimmed)) continue;
    return false;
  }
  return false;
}

/**
 * The SDK-client channel's site shapes, i.e. the population
 * `local-surface-role-identity.test.ts` guards.
 *
 * Exported so the env fence's disjointness case can re-derive the SIBLING's
 * population rather than a narrower guess at it. That case used to scan for
 * `awsClientDefaults(` alone, which is 21 of the sibling's 24 sites: it made
 * the "these two fences are not subsets" claim easier to satisfy than the claim
 * it printed, so it could not detect the subsetting it exists to detect.
 *
 * THREE shapes reach `awsClientDefaults`, and counting only the first made the
 * role fence's headline claim false for the others. A direct
 * `new XxxClient({ ...awsClientDefaults(...) })` can pass `ignoreAssumedRole`;
 * a `new AwsClients({...})` bag CANNOT — it spreads the helper internally — and
 * neither can a spread of `ambientClientDefaults()` / `clientDefaultsFor(...)`
 * (go-to-k/cdkd#3588), which calls it with the profile alone. Those two shapes'
 * only available verdict is the annotation.
 */
export type ClientSiteKind = 'awsClientDefaults' | 'AwsClients' | 'ambientClientDefaults';

export function clientSiteKind(code: string): ClientSiteKind | undefined {
  if (code.includes('awsClientDefaults(')) return 'awsClientDefaults';
  if (code.includes('new AwsClients(')) return 'AwsClients';
  if (code.includes('ambientClientDefaults(') || code.includes('clientDefaultsFor(')) {
    return 'ambientClientDefaults';
  }
  return undefined;
}

/** Every surface file holding at least one SDK-client site, comments stripped. */
export function clientChannelFiles(): Set<string> {
  const files = new Set<string>();
  for (const file of surfaceFiles()) {
    if (!isInSurface(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const line of lines) {
      if (isCommentLine(line)) continue;
      if (clientSiteKind(stripComments(line)) !== undefined) {
        files.add(file);
        break;
      }
    }
  }
  return files;
}
