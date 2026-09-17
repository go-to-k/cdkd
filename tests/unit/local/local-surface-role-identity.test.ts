import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vite-plus/test';

/**
 * Every AWS client the `cdkd local *` surface builds must DECLARE whose
 * identity it runs as (issue [#3130](https://github.com/go-to-k/cdkd/issues/3130)).
 *
 * `--role-arn` publishes its assumed credentials to `awsClientDefaults()`, so
 * from that point every client under `src/**` runs as the role unless it opts
 * out. That is right for cdkd's own calls and WRONG for this surface's
 * workload-facing ones: whatever these resolve — container credentials, a task
 * role assumed for the container, ECS task-secret plaintext, the
 * `${AWS::AccountId}` substituted into the emulated environment — is handed to
 * the user's locally-running code. A deploy role is normally the more
 * privileged of the two identities in play, so inheriting it there lets local
 * code read what the caller's own principal cannot.
 *
 * Three review rounds each found one more site of exactly that shape, which is
 * why this is a fence rather than a list of fixes: the population is derived
 * from the code, and a site added later fails until someone decides. Neither
 * verdict is the default — a site either opts out or says why it does not.
 *
 * TWO SHAPES REACH `awsClientDefaults`, and counting only the first made this
 * file's headline claim false for the second. A direct `new XxxClient({
 * ...awsClientDefaults(...) })` can pass `ignoreAssumedRole`; a
 * `new AwsClients({...})` bag CANNOT — it spreads the helper internally — so
 * its only available verdict is the annotation. Leaving that shape out of the
 * population meant `local-state-loader.ts`'s three bags carried no verdict at
 * all, which is not the same as carrying the right one.
 *
 * WHAT THIS FENCE STILL CANNOT SEE, recorded rather than implied away: a client
 * CONSTRUCTED ELSEWHERE and injected. `resolveEcsSecrets` accepts
 * `secretsManagerClient` / `ssmClient` for tests, and an injected client's
 * identity was decided at its own construction site — outside this surface, or
 * outside `src/**` entirely. That seam is documented at the option itself as
 * test-only; nothing here can enforce it.
 *
 * The sibling fence for the OTHER channel — the `AWS_*` environment triple
 * `cdkd local *` copies into the container — is
 * `tests/unit/local/local-surface-env-identity.test.ts`. Neither can see the
 * other's population.
 */
const ROOTS = ['src/local', 'src/cli/commands'];

/**
 * One extra file under `src/cli/commands` that no `local-` prefix reaches:
 * the shim re-exporting cdk-local's ECS service emulator, which is what
 * `local start-service` / `local start-alb` run. It builds no client TODAY,
 * which is exactly why it belongs in the population — the fence's job is to
 * make the FIRST one decide.
 */
const EXTRA_SURFACE_FILES = ['src/cli/commands/ecs-service-emulator.ts'];

/**
 * `src/local` is whole; under `src/cli/commands` the surface is the `local-*`
 * files PLUS anything under a `local/` subdirectory. The nested form matters
 * because the original pattern forbade `/` outright, so a future
 * `src/cli/commands/local/foo.ts` would have been silently out of scope — the
 * one direction a fence must never fail in.
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

/**
 * Drop line and block comments from ONE line before classifying it.
 *
 * Load-bearing, not tidiness: the verdict used to be a raw substring test over
 * the whole line, so a trailing `// ignoreAssumedRole: true is not needed here`
 * marked the site decided and the fence inert for it — the opposite of what the
 * comment says. A string literal containing the token is not worth modelling
 * (nothing in the tree has one and a quote-aware scan would be its own source
 * of silent misses); comments are, because they are where an author explains
 * the very decision being asserted.
 */
function stripComments(line: string): string {
  return line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
}

/** A comment line carrying the annotation AND a non-empty reason after it. */
function isAnnotationLine(line: string): boolean {
  const trimmed = line.trim();
  // The marker only counts inside a comment. A bare mention on a code line
  // (a string, an identifier) says nothing about why the site keeps the role.
  if (!trimmed.startsWith('//') && !trimmed.startsWith('*')) return false;
  const marker = trimmed.indexOf('cdkd-local-role-identity:');
  if (marker === -1) return false;
  // "why" is the whole content of the verdict, so an empty one is no verdict.
  return trimmed.slice(marker + 'cdkd-local-role-identity:'.length).trim().length > 0;
}

type SiteKind = 'awsClientDefaults' | 'AwsClients';

interface Site {
  file: string;
  line: number;
  text: string;
  kind: SiteKind;
  optsOut: boolean;
  annotated: boolean;
}

function siteKind(code: string): SiteKind | undefined {
  if (code.includes('awsClientDefaults(')) return 'awsClientDefaults';
  if (code.includes('new AwsClients(')) return 'AwsClients';
  return undefined;
}

function collectSites(): Site[] {
  const sites: Site[] = [];
  const files = new Set<string>();
  for (const root of ROOTS) for (const file of walk(root)) files.add(file);
  for (const extra of EXTRA_SURFACE_FILES) if (existsSync(extra)) files.add(extra);

  for (const file of [...files].sort()) {
    if (!isInSurface(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((text, i) => {
      const code = stripComments(text);
      const kind = siteKind(code);
      if (kind === undefined) return;
      // The annotation may sit on any of the four lines above the call, which
      // is as far as the explanations here run.
      const above = lines.slice(Math.max(0, i - 4), i);
      sites.push({
        file,
        line: i + 1,
        text: text.trim(),
        kind,
        optsOut: code.includes('ignoreAssumedRole: true'),
        annotated: above.some(isAnnotationLine),
      });
    });
  }
  return sites;
}

describe('every AWS client on the `cdkd local` surface declares whose identity it uses', () => {
  const sites = collectSites();

  it('sees the population it claims to guard', () => {
    // Floors, so a broken walk or a renamed helper reports a failure rather
    // than a vacuous pass. Measured 2026-09-16: 24 sites across 8 files — 21
    // `awsClientDefaults(` and 3 `new AwsClients(`. The floors sit below that
    // so ordinary deletions do not trip them, and each SHAPE carries its own:
    // an aggregate floor stays green while one shape stops being matched at
    // all, which is how the `new AwsClients(` shape went unseen.
    expect(sites.length).toBeGreaterThanOrEqual(18);
    expect(new Set(sites.map((s) => s.file)).size).toBeGreaterThanOrEqual(5);
    expect(sites.filter((s) => s.kind === 'awsClientDefaults').length).toBeGreaterThanOrEqual(15);
    expect(sites.filter((s) => s.kind === 'AwsClients').length).toBeGreaterThanOrEqual(3);
  });

  it('has every site either opting out or saying why it keeps the role', () => {
    const undecided = sites
      .filter((s) => !s.optsOut && !s.annotated)
      .map((s) => `${s.file}:${s.line}  ${s.text}`);

    expect(
      undecided,
      'A client here inherits a `--role-arn` assumed for cdkd\'s own calls unless it says ' +
        'otherwise. If what it resolves reaches the user\'s emulated code — credentials, a ' +
        'role it assumes for the container, secret values, an account id substituted into ' +
        'the environment — pass `awsClientDefaults({ ignoreAssumedRole: true })`. If it is ' +
        'genuinely cdkd calling AWS as itself, write a ' +
        '`cdkd-local-role-identity: <reason>` comment above it. A `new AwsClients({...})` ' +
        'bag has no opt-out to pass and therefore takes the comment.'
    ).toEqual([]);
  });

  it('carries BOTH verdicts, so neither arm is vacuous', () => {
    // A population that had drifted to all-one-kind would make the fence above
    // unfalsifiable in one direction.
    expect(sites.some((s) => s.optsOut)).toBe(true);
    expect(sites.some((s) => s.annotated && !s.optsOut)).toBe(true);
  });

  it('refuses a trailing comment as a verdict, and an empty reason as an annotation', () => {
    // Guard-the-guard: both classifiers were substring tests over the whole
    // line, so a site could be marked decided by prose ABOUT the rule. These
    // are the exact shapes that used to pass.
    expect(stripComments('...awsClientDefaults(), // ignoreAssumedRole: true not needed')).not.toContain(
      'ignoreAssumedRole: true'
    );
    expect(stripComments('...awsClientDefaults({ ignoreAssumedRole: true }),')).toContain(
      'ignoreAssumedRole: true'
    );
    expect(isAnnotationLine('  // cdkd-local-role-identity:')).toBe(false);
    expect(isAnnotationLine("  const tag = 'cdkd-local-role-identity: x';")).toBe(false);
    expect(isAnnotationLine('  // cdkd-local-role-identity: cdkd calls AWS as itself here')).toBe(
      true
    );
  });

  it('keeps a nested `src/cli/commands/local/**` file and the emulator shim in scope', () => {
    // The previous pattern rejected `/` outright, so a file moved into a
    // subdirectory would have left the population silently — and the ECS
    // service emulator shim is workload-facing with no `local-` prefix.
    expect(isInSurface('src/cli/commands/local/foo.ts')).toBe(true);
    expect(isInSurface('src/cli/commands/local-invoke.ts')).toBe(true);
    expect(isInSurface('src/cli/commands/ecs-service-emulator.ts')).toBe(true);
    expect(isInSurface('src/local/nested/deep/thing.ts')).toBe(true);
    // Still NOT the whole command tree.
    expect(isInSurface('src/cli/commands/deploy.ts')).toBe(false);
    expect(isInSurface('src/cli/commands/localish.ts')).toBe(false);
  });
});
