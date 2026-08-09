/**
 * Captures the AWS CLI's REMOVED-command list into
 * `tests/fixtures/aws-cli-removed-commands.json`, the offline oracle for
 * `scripts/check-integ-aws-commands.ts`.
 *
 * Why a captured fixture rather than shelling out to `aws` at lint time: the
 * lint runs in CI and on machines that may not have the AWS CLI installed, and
 * a checker that silently degrades to "skipped" when its oracle is missing is
 * the vacuous-pass failure mode `.claude/rules/testing.md` forbids. Capturing
 * the list keeps the check deterministic and offline; this script is how it is
 * refreshed when a new AWS CLI version removes more commands.
 *
 * Source of truth: `awscli/customizations/removals.py` in an installed AWS CLI
 * v2. That module registers `building-command-table.<service>` handlers that
 * DELETE commands from the CLI's command table, so a removed verb exists in the
 * botocore service model (and therefore in the AWS SDKs, the API reference, and
 * anything generated from them) while `aws <service> <verb>` rejects it with
 * `Found invalid choice`.
 *
 * Usage:
 *   node scripts/refresh-aws-cli-removals.ts [--aws-root <path>] [--check]
 *
 * `--check` re-captures and diffs against the committed fixture without
 * writing, for a "is our copy stale?" probe.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface RemovedCommandsFixture {
  /** Provenance so a reader knows what produced this and how to refresh it. */
  $source: string;
  /** `aws --version` of the CLI the capture came from. */
  $awsCliVersion: string;
  /** service name (as spelled on the `aws` command line) -> removed verbs. */
  removed: Record<string, string[]>;
}

/**
 * Pure-functional parser for `removals.py` content. Split from the filesystem
 * walk so unit tests can feed source text directly.
 *
 * Recognizes the module's one and only shape:
 *
 *     cmd_remover.remove(
 *         on_event='building-command-table.emr',
 *         remove_commands=['run-job-flow', 'list-instance-groups', ...],
 *     )
 *
 * A `remove()` call whose `on_event` is not a `building-command-table.<svc>`
 * event is ignored — only command-table removals make a verb unavailable.
 */
export function parseRemovalsSource(source: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  // Non-greedy up to the closing `)` of the remove(...) call. `[\s\S]` because
  // the call is always spread across lines by the formatter.
  const callRe =
    /on_event\s*=\s*['"]building-command-table\.([a-z0-9-]+)['"]\s*,\s*remove_commands\s*=\s*\[([\s\S]*?)\]/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(source)) !== null) {
    const service = m[1]!;
    const verbs = [...m[2]!.matchAll(/['"]([a-z0-9][a-z0-9-]*)['"]/g)].map((v) => v[1]!);
    if (verbs.length === 0) continue;
    const set = out.get(service) ?? new Set<string>();
    for (const v of verbs) set.add(v);
    out.set(service, set);
  }
  return out;
}

/** Locates the `awscli` package directory of the installed AWS CLI v2. */
export function findAwsCliPackageRoot(explicitRoot?: string): string {
  if (explicitRoot) {
    if (!existsSync(join(explicitRoot, 'customizations', 'removals.py'))) {
      throw new Error(`--aws-root ${explicitRoot} has no customizations/removals.py`);
    }
    return explicitRoot;
  }

  // `command -v` EXITS 1 when the binary is absent, so execFileSync throws
  // before any empty-string check could run — catch it and surface the
  // actionable message instead of a raw `Command failed: sh -c command -v aws`.
  let awsBin = '';
  try {
    awsBin = execFileSync('sh', ['-c', 'command -v aws'], { encoding: 'utf8' }).trim();
  } catch {
    awsBin = '';
  }
  if (!awsBin) throw new Error('aws CLI not found on PATH — pass --aws-root <awscli package dir>');
  // `aws` is usually a symlink into the versioned install; resolve it, then walk
  // up looking for the packaged `awscli` directory.
  // A dangling symlink makes realpathSync throw — right after the careful
  // try/catch above, which would be an odd place to lose the actionable error.
  let real: string;
  try {
    real = realpathSync(awsBin);
  } catch {
    real = awsBin;
  }
  let dir = dirname(real);
  for (let i = 0; i < 8; i++) {
    const candidates = [
      join(dir, 'awscli'),
      join(dir, 'lib', 'awscli'),
      ...pythonSitePackages(dir),
    ];
    for (const c of candidates) {
      if (existsSync(join(c, 'customizations', 'removals.py'))) return c;
    }
    dir = dirname(dir);
  }
  throw new Error(
    `could not locate the awscli package from ${real} — pass --aws-root <awscli package dir>`
  );
}

/** `<dir>/lib/python3.X/site-packages/awscli` candidates under a venv root. */
function pythonSitePackages(dir: string): string[] {
  const libDir = join(dir, 'lib');
  if (!existsSync(libDir)) return [];
  try {
    return readdirSync(libDir)
      .filter((e) => e.startsWith('python'))
      .map((e) => join(libDir, e, 'site-packages', 'awscli'));
  } catch {
    return [];
  }
}

export function buildFixture(pkgRoot: string): RemovedCommandsFixture {
  const source = readFileSync(join(pkgRoot, 'customizations', 'removals.py'), 'utf8');
  const parsed = parseRemovalsSource(source);
  // Reconcile against an INDEPENDENT count of the events in the file. The
  // regex requires `on_event` to be immediately followed by `remove_commands`,
  // so a reordered or interleaved `remove()` call would drop that service
  // SILENTLY; a bare `size === 0` guard only catches total failure, which is
  // the vacuous-pass shape `.claude/rules/testing.md` warns about.
  // Scoped to lines that actually pass the event to `remove(...)`: a future
  // DOC mention of `building-command-table.x` in a comment or docstring would
  // otherwise throw a misleading "parser is stale" and block the refresh.
  const declaredEvents = new Set(
    source
      .split('\n')
      .filter((l) => l.includes('on_event') && !l.trimStart().startsWith('#'))
      .flatMap((l) => [...l.matchAll(/building-command-table\.([a-z0-9-]+)/g)].map((m) => m[1]!))
  );
  if (parsed.size === 0) {
    throw new Error(`parsed 0 removals from ${pkgRoot}/customizations/removals.py — parser is stale`);
  }
  const missed = [...declaredEvents].filter((s) => !parsed.has(s));
  if (missed.length > 0) {
    throw new Error(
      `parser missed ${missed.length} command-table removal event(s) (${missed.join(', ')}) in ` +
        `${pkgRoot}/customizations/removals.py — the AWS CLI changed the call shape, update parseRemovalsSource`
    );
  }
  let version = 'unknown';
  try {
    version = execFileSync('aws', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    /* provenance only */
  }
  const removed: Record<string, string[]> = {};
  for (const service of [...parsed.keys()].sort()) {
    removed[service] = [...parsed.get(service)!].sort();
  }
  return {
    $source:
      'Captured from awscli/customizations/removals.py by scripts/refresh-aws-cli-removals.ts. These verbs exist in the AWS API / SDK models but are DELETED from the AWS CLI command table, so `aws <service> <verb>` fails with "Found invalid choice". Refresh with: node scripts/refresh-aws-cli-removals.ts',
    $awsCliVersion: version,
    removed,
  };
}

const FIXTURE_PATH = join(import.meta.dirname, '../tests/fixtures/aws-cli-removed-commands.json');

function main(): void {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  // Accept BOTH `--aws-root <path>` and `--aws-root=<path>`; recognising only
  // the bare flag meant the `=` form fell through to the PATH lookup, silently
  // defeating the validation below.
  const inlineRoot = argv.find((a) => a.startsWith('--aws-root='));
  const rootIdx = argv.indexOf('--aws-root');
  const rootValue = inlineRoot
    ? inlineRoot.slice('--aws-root='.length)
    : rootIdx >= 0
      ? argv[rootIdx + 1]
      : undefined;
  // `--aws-root` with no value (or followed by another flag) must ERROR, not
  // silently fall back to PATH — or worse, take `--check` as the root path.
  if ((rootIdx >= 0 || inlineRoot) && (!rootValue || rootValue.startsWith('-'))) {
    console.error('--aws-root requires a path argument (the awscli package directory)');
    process.exit(1);
  }
  const explicitRoot = rootValue;

  const fixture = buildFixture(findAwsCliPackageRoot(explicitRoot));
  const serialized = `${JSON.stringify(fixture, null, 2)}\n`;

  if (check) {
    const current = existsSync(FIXTURE_PATH) ? readFileSync(FIXTURE_PATH, 'utf8') : '';
    // Compare the removal DATA only: the captured `aws --version` differs per
    // machine and must not make a same-data capture read as drift. A corrupt
    // or missing fixture reports STALE (the actionable verdict) rather than
    // throwing a parse error at the user.
    let currentRemoved: unknown;
    try {
      currentRemoved = current === '' ? undefined : (JSON.parse(current) as RemovedCommandsFixture).removed;
    } catch {
      currentRemoved = undefined;
    }
    const sameData =
      currentRemoved !== undefined &&
      JSON.stringify(currentRemoved) === JSON.stringify(fixture.removed);
    if (!sameData) {
      console.error(
        `aws-cli-removed-commands.json is stale vs ${fixture.$awsCliVersion} — re-run: node scripts/refresh-aws-cli-removals.ts`
      );
      process.exit(1);
    }
    console.log(`aws-cli-removed-commands.json matches ${fixture.$awsCliVersion}.`);
    return;
  }

  writeFileSync(FIXTURE_PATH, serialized);
  const count = Object.values(fixture.removed).reduce((n, v) => n + v.length, 0);
  console.log(
    `refresh-aws-cli-removals: wrote ${count} removed command(s) across ${
      Object.keys(fixture.removed).length
    } service(s) from ${fixture.$awsCliVersion}`
  );
}

if (process.argv[1] && import.meta.filename === realpathSync(process.argv[1])) {
  main();
}
