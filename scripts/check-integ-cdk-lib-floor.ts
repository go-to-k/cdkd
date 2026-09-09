/**
 * Fence for the `/new-integ` scaffold template's `aws-cdk-lib` floor
 * (issue #2839).
 *
 * WHAT IT ENFORCES
 *
 * The floor emitted by `.claude/skills/new-integ/SKILL.md`'s `package.json`
 * template must not be LOWER than the lowest floor present in the integ-fixture
 * corpus (`tests/integration/<fixture>/package.json`).
 *
 * WHY THAT RULE AND NOT "ALL FLOORS ARE EQUAL"
 *
 * Before go-to-k/cdkd#2838 the 292 fixtures carried FOUR different floors
 * (`^2.169.0` x172, `^2.172.0` x91, `^2.176.0` x15, `^2.257.0` x6). The
 * systematic source was this template: it emitted a hardcoded `^2.169.0` for
 * every fixture ever scaffolded, while dependabot moved individual fixtures
 * forward around it.
 *
 * The obvious fence — "every fixture floor is identical" — is WRONG for this
 * repo, and would have been worse than nothing. Dependabot bumps `aws-cdk-lib`
 * ONE DIRECTORY AT A TIME (go-to-k/cdkd#2487, #2488, #2834 are each a single
 * fixture), so the corpus is legitimately non-uniform between such merges, and
 * an equality fence would red-flag every one of those PRs. A fence that fires
 * on correct, routine, bot-authored changes gets disabled, not obeyed.
 *
 * So the subject is the GENERATOR, not the corpus. The corpus is allowed to
 * spread; the template is not allowed to fall behind the back of it.
 *
 * WHAT IT DOES NOT CLAIM
 *
 *  - It does NOT keep the corpus uniform. A fixture hand-authored with an old
 *    floor lowers the minimum and the template still passes. That is the
 *    deliberate cost of being dependabot-safe.
 *  - It says nothing about the RESOLVED version. These are `^` floors and the
 *    fixtures install with `pnpm install --ignore-workspace`, so what actually
 *    resolves depends on the registry and the local store at run time.
 *  - `assets/demo-gif/` is deliberately OUT of scope. It is not an integ
 *    fixture, it has its own TRACKED `pnpm-lock.yaml`, and raising its floor
 *    without regenerating that lockfile recreates the specifier mismatch
 *    go-to-k/cdkd#2838 removed.
 *
 * REFUSALS ARE NOT PASSES
 *
 * Every input this cannot read is a hard failure, never a skip. The fail-open
 * shapes that would otherwise make a broken run look clean:
 *
 *  - The template floor failing to extract (a markdown edit moving the block,
 *    a renamed skill). Reporting `null` as "nothing to compare" would make the
 *    checker permanently, silently green — the exact failure mode it exists to
 *    prevent, one level up.
 *  - A fixture manifest that does not parse, or declares a spec whose floor is
 *    not decidable (`*`, `latest`, a `||` range). Skipping it removes it from
 *    the minimum, which can only ever LOOSEN the verdict.
 *  - A corpus that yielded NO fixture, or no floor at all. `FLOORS` catches
 *    that in `main()`, but the exported function is what a future caller
 *    reaches for, and it used to return a fully clean report for an
 *    existing-but-empty root — so the emptiness is a violation in the LIBRARY,
 *    not only in the CLI.
 *
 * Two skips are deliberate and are NOT refusals, because neither can loosen the
 * verdict by hiding a floor. They are pinned by DIFFERENT instruments, which is
 * worth stating because they look symmetric and are not:
 *
 *  - A directory with no `package.json` (not a fixture) increments NEITHER
 *    counter, so the `fixtures === declaringFixtures` pin cannot see it. A walk
 *    that stopped finding manifests is caught by the `fixtures === 0` violation
 *    below when it stops entirely, and by the test's independent
 *    `fixtures >= 280` assertion when it merely shrinks. `FLOORS.fixtures` is
 *    the CLI's own guard and is never consulted by the library or the suite.
 *  - A manifest declaring no `aws-cdk-lib` (not a member of this population)
 *    increments `fixtures` but not `declaringFixtures`, so it IS visible to
 *    that pin — which is what makes a reader silently losing one dependency
 *    bucket show up as a gap rather than as a smaller minimum.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** Repo-relative path of the scaffold template this fences. */
export const TEMPLATE_REL = join('.claude', 'skills', 'new-integ', 'SKILL.md');

/** Repo-relative root of the integ-fixture corpus. */
export const INTEG_ROOT_REL = join('tests', 'integration');

/**
 * Collapse floors. Every one of these is satisfiable by a run that inspected
 * NOTHING, which is why they exist and why the unit test pins them to literals
 * AND separately asserts the real magnitudes against independent literals — an
 * assertion of the form `report.fixtures > FLOORS.fixtures` is circular and
 * stays green with every floor zeroed.
 *
 * Measured 2026-09-09, immediately after go-to-k/cdkd#2838: 292 fixture
 * directories, 292 declaring `aws-cdk-lib`, 1 distinct floor.
 */
export const FLOORS = {
  /** Fixture directories with a readable `package.json`. */
  fixtures: 250,
  /** Of those, ones declaring `aws-cdk-lib`. */
  declaringFixtures: 250,
} as const;

export type FloorOperator = '^' | '~' | '=';

export interface ParsedFloor {
  operator: FloorOperator;
  major: number;
  minor: number;
  patch: number;
  /** The spec exactly as written in the manifest. */
  raw: string;
}

export interface FixtureFloor {
  fixture: string;
  spec: string;
  floor: ParsedFloor;
}

export interface Refusal {
  /** Repo-relative path, or the fixture name for a corpus refusal. */
  where: string;
  reason: string;
}

export interface FloorReport {
  /** Fixture dirs carrying a readable `package.json`. */
  fixtures: number;
  /** Fixtures declaring `aws-cdk-lib` with a decidable floor. */
  declaringFixtures: number;
  /** Every distinct floor spec in the corpus, ascending. */
  distinctFloors: string[];
  /** The lowest corpus floor, or null when the corpus yielded none. */
  minFloor: ParsedFloor | null;
  /** The floor the scaffold template emits, or null when it did not extract. */
  templateFloor: ParsedFloor | null;
  /**
   * Inputs that could not be read or decided. NON-EMPTY IS A FAILURE — see the
   * header. Kept as a list rather than a count so the message names the file.
   */
  refusals: Refusal[];
  /** Human-readable failures. Empty means the check passed. */
  violations: string[];
}

/**
 * Parse a dependency spec into the lowest version it admits.
 *
 * Accepts only the three shapes whose floor is decidable from the spec alone:
 * `^X.Y.Z`, `~X.Y.Z` and a bare `X.Y.Z`. Everything else returns null and
 * becomes a REFUSAL at the call site, never a skip: `*` / `latest` / `>=X` /
 * an `||` union either have no floor or have one that a future registry state
 * can change, and a spec this cannot decide must not be silently dropped out
 * of the minimum.
 *
 * A prerelease or build suffix is refused too. None exist in the corpus, and
 * accepting one would require prerelease ordering rules that buy nothing here.
 */
export function parseFloor(spec: string): ParsedFloor | null {
  const m = /^([\^~]?)(\d+)\.(\d+)\.(\d+)$/.exec(spec.trim());
  if (!m) return null;
  return {
    operator: (m[1] || '=') as FloorOperator,
    major: Number(m[2]),
    minor: Number(m[3]),
    patch: Number(m[4]),
    raw: spec.trim(),
  };
}

/** Negative when `a` is lower than `b`. Compares the FLOOR, not the range. */
export function compareFloors(a: ParsedFloor, b: ParsedFloor): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Extract the `aws-cdk-lib` floor the scaffold template emits.
 *
 * Deliberately NOT a JSON parse: the template lives inside a fenced block in
 * prose, indented, and is not a standalone document. It is matched by the
 * quoted key so a reworded surrounding sentence cannot move it, and the whole
 * file is searched rather than a located fence — the fence's language tag and
 * indentation have both changed in this file's history.
 *
 * Returns null when the key is absent OR appears more than once. Two
 * occurrences mean the template grew a second manifest (or an example of the
 * wrong thing), and picking the first would silently fence whichever one
 * happened to come first in the file.
 */
export function extractTemplateFloor(markdown: string): ParsedFloor | null {
  return extractTemplateFloorDetailed(markdown).floor;
}

export interface TemplateExtraction {
  floor: ParsedFloor | null;
  /** How many `"aws-cdk-lib": "..."` declarations the template carries. */
  matches: number;
  /** The single matched spec, when there was exactly one. */
  spec: string | null;
}

/**
 * The counting form. `extractTemplateFloor` collapses all three failures to
 * null, which made one refusal message cover "found none", "found several" and
 * "found one I cannot decide" — so the day someone adds a second example
 * manifest to the skill, the error did not say it had found two.
 */
export function extractTemplateFloorDetailed(markdown: string): TemplateExtraction {
  const matches = [...markdown.matchAll(/"aws-cdk-lib"\s*:\s*"([^"]+)"/g)];
  if (matches.length !== 1) return { floor: null, matches: matches.length, spec: null };
  const spec = matches[0][1];
  return { floor: parseFloor(spec), matches: 1, spec };
}

/** Read `aws-cdk-lib` out of a manifest's dependencies or devDependencies. */
function declaredSpec(manifest: unknown): string | null {
  if (typeof manifest !== 'object' || manifest === null) return null;
  const m = manifest as Record<string, unknown>;
  for (const bucket of ['dependencies', 'devDependencies']) {
    const deps = m[bucket];
    if (typeof deps !== 'object' || deps === null) continue;
    const spec = (deps as Record<string, unknown>)['aws-cdk-lib'];
    if (typeof spec === 'string') return spec;
  }
  return null;
}

export interface CheckOptions {
  /** Absolute path to the integ-fixture root. */
  integRoot: string;
  /** Absolute path to the scaffold template markdown. */
  templatePath: string;
}

export function checkIntegCdkLibFloor(options: CheckOptions): FloorReport {
  const { integRoot, templatePath } = options;
  const refusals: Refusal[] = [];
  const floors: FixtureFloor[] = [];
  let fixtures = 0;

  let entries: string[];
  try {
    entries = readdirSync(integRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch (error) {
    // An unreadable corpus root is the loudest possible collapse: every count
    // is zero and every floor is trivially satisfied.
    return {
      fixtures: 0,
      declaringFixtures: 0,
      distinctFloors: [],
      minFloor: null,
      templateFloor: null,
      refusals: [{ where: integRoot, reason: `integ root unreadable: ${String(error)}` }],
      violations: [`integ root unreadable: ${integRoot}`],
    };
  }

  for (const fixture of entries) {
    const manifestPath = join(integRoot, fixture, 'package.json');
    if (!existsSync(manifestPath)) continue;
    fixtures += 1;

    let manifest: unknown;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      refusals.push({
        where: join(integRoot, fixture, 'package.json'),
        reason: `manifest does not parse: ${String(error)}`,
      });
      continue;
    }

    const spec = declaredSpec(manifest);
    // A fixture that declares no aws-cdk-lib at all is not a refusal — it is
    // simply not a member of this population.
    if (spec === null) continue;

    const floor = parseFloor(spec);
    if (floor === null) {
      refusals.push({
        where: join(integRoot, fixture, 'package.json'),
        reason: `aws-cdk-lib spec "${spec}" has no decidable floor (accepted: ^X.Y.Z, ~X.Y.Z, X.Y.Z)`,
      });
      continue;
    }
    floors.push({ fixture, spec, floor });
  }

  let templateFloor: ParsedFloor | null = null;
  try {
    const extraction = extractTemplateFloorDetailed(readFileSync(templatePath, 'utf8'));
    templateFloor = extraction.floor;
    if (templateFloor === null) {
      // Name WHICH of the three failures happened. One string for all three
      // left "someone added a second example manifest" reading as "the key is
      // gone", which points the fix at the wrong edit.
      const reason =
        extraction.matches === 0
          ? 'found no `"aws-cdk-lib": "<spec>"` declaration in the scaffold template'
          : extraction.matches > 1
            ? `found ${extraction.matches} \`"aws-cdk-lib": "<spec>"\` declarations in the scaffold template; expected exactly 1 (which one is the template?)`
            : `scaffold template spec "${extraction.spec}" has no decidable floor (accepted: ^X.Y.Z, ~X.Y.Z, X.Y.Z)`;
      refusals.push({ where: TEMPLATE_REL, reason });
    }
  } catch (error) {
    refusals.push({ where: TEMPLATE_REL, reason: `template unreadable: ${String(error)}` });
  }

  const sorted = [...floors].sort((a, b) => compareFloors(a.floor, b.floor));
  const minFloor = sorted.length > 0 ? sorted[0].floor : null;
  const distinctFloors = [...new Set(sorted.map((f) => f.spec))];

  const violations: string[] = [];
  for (const refusal of refusals) {
    violations.push(`${refusal.where}: ${refusal.reason}`);
  }
  // Emptiness is a LIBRARY-level violation, not only a CLI floor: an
  // existing-but-empty root previously produced a fully clean report, and a
  // caller reaching for the exported function gets no `FLOORS` check.
  if (fixtures === 0) {
    // `integRoot`, not INTEG_ROOT_REL: under the `--integ-root=` seam the
    // hardcoded label pointed the reader at a directory that was never read.
    violations.push(`${integRoot}: no fixture manifest found — the corpus was not read`);
  } else if (minFloor === null) {
    // Deliberately states only what it KNOWS, and infers no cause.
    //
    // Two rounds of review were spent on a conditional here that tried to say
    // WHY no floor was found -- "none of them parsed" versus "none declared
    // one". Every version was wrong for some input, because the counts it
    // branched on (`refusals.length` against `fixtures`) are different
    // populations: `refusals` also holds the TEMPLATE refusal and
    // undecidable-spec failures, neither of which is an unreadable manifest.
    // The per-file truth is already in `refusals`, and every refusal is
    // already emitted as its own violation above. So the summary reports the
    // fact and points at them, rather than re-deriving a cause it cannot see.
    violations.push(
      `${integRoot}: ${fixtures} fixture manifests read, none yielded a decidable ` +
        `aws-cdk-lib floor` +
        (refusals.length > 0 ? ` (see the ${refusals.length} refusal(s) above for why)` : ''),
    );
  }
  if (minFloor !== null && templateFloor !== null && compareFloors(templateFloor, minFloor) < 0) {
    const lowest = sorted[0];
    violations.push(
      `${TEMPLATE_REL} emits aws-cdk-lib "${templateFloor.raw}", below the lowest floor in the ` +
        `fixture corpus ("${lowest.spec}", ${join(integRoot, lowest.fixture)}). A new fixture ` +
        `scaffolded from this template would start behind the corpus — raise the template.`,
    );
  }

  return {
    fixtures,
    declaringFixtures: floors.length,
    distinctFloors,
    minFloor,
    templateFloor,
    refusals,
    violations,
  };
}

/**
 * Fixed inputs with known verdicts, analyzed BEFORE the real tree is read.
 *
 * The floors above catch a run that collapsed toward zero. These catch the
 * opposite and more dangerous collapse: a predicate that stopped discriminating
 * leaves every count byte-identical, so nothing else in this file would notice.
 * The set is majority-NEGATIVE for that reason, and each REFUSAL case names a
 * substring of its own arm — a bare "refused" verdict cannot tell the arms
 * apart.
 */
export const SELF_PROBE_CASES: ReadonlyArray<{
  label: string;
  spec: string;
  expected: 'parsed' | 'refused';
  floor?: [number, number, number];
}> = [
  { label: 'caret', spec: '^2.260.0', expected: 'parsed', floor: [2, 260, 0] },
  { label: 'tilde', spec: '~2.257.0', expected: 'parsed', floor: [2, 257, 0] },
  { label: 'exact', spec: '2.169.0', expected: 'parsed', floor: [2, 169, 0] },
  { label: 'padded', spec: '  ^2.260.0  ', expected: 'parsed', floor: [2, 260, 0] },
  { label: 'wildcard', spec: '*', expected: 'refused' },
  { label: 'latest', spec: 'latest', expected: 'refused' },
  { label: 'x-range', spec: '^2.x', expected: 'refused' },
  { label: 'gte-range', spec: '>=2.260.0', expected: 'refused' },
  { label: 'union-range', spec: '^2.260.0 || ^3.0.0', expected: 'refused' },
  { label: 'prerelease', spec: '^2.260.0-alpha.0', expected: 'refused' },
  { label: 'two-segment', spec: '^2.260', expected: 'refused' },
  { label: 'empty', spec: '', expected: 'refused' },
];

export interface SelfProbeFailure {
  label: string;
  detail: string;
}

/** Run `SELF_PROBE_CASES`; a non-empty result must abort the run. */
export function runSelfProbe(): SelfProbeFailure[] {
  const failures: SelfProbeFailure[] = [];
  // Test seam: proves the SPAWNED binary still consults the probe. Without it,
  // `main()` dropping the `runSelfProbe()` call is unobservable from outside.
  if (process.env['CDKD_SELF_PROBE_FORCE_FAIL'] === '1') {
    return [{ label: 'forced', detail: 'CDKD_SELF_PROBE_FORCE_FAIL=1' }];
  }
  for (const testCase of SELF_PROBE_CASES) {
    const got = parseFloor(testCase.spec);
    if (testCase.expected === 'refused') {
      if (got !== null) {
        failures.push({ label: testCase.label, detail: `expected refusal, parsed ${got.raw}` });
      }
      continue;
    }
    if (got === null) {
      failures.push({ label: testCase.label, detail: 'expected a parse, got a refusal' });
      continue;
    }
    const [major, minor, patch] = testCase.floor ?? [-1, -1, -1];
    if (got.major !== major || got.minor !== minor || got.patch !== patch) {
      failures.push({
        label: testCase.label,
        detail: `expected ${major}.${minor}.${patch}, got ${got.major}.${got.minor}.${got.patch}`,
      });
    }
  }
  return failures;
}

function parseArgs(argv: string[]): { repoRoot: string; integRoot?: string; template?: string; json: boolean } {
  let repoRoot = join(import.meta.dirname, '..');
  let integRoot: string | undefined;
  let template: string | undefined;
  let json = false;
  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--integ-root=')) {
      const value = arg.slice('--integ-root='.length);
      // An EMPTY value is refused rather than defaulted: `--integ-root=$DIR`
      // with DIR unset would report a green for a corpus nobody named.
      if (!value) throw new Error('--integ-root= requires a non-empty value');
      integRoot = value;
    } else if (arg.startsWith('--template=')) {
      const value = arg.slice('--template='.length);
      if (!value) throw new Error('--template= requires a non-empty value');
      template = value;
    } else if (arg.startsWith('--repo-root=')) {
      const value = arg.slice('--repo-root='.length);
      if (!value) throw new Error('--repo-root= requires a non-empty value');
      repoRoot = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { repoRoot, integRoot, template, json };
}

function main(): void {
  const { repoRoot, integRoot, template, json } = parseArgs(process.argv.slice(2));

  const probeFailures = runSelfProbe();
  if (probeFailures.length > 0) {
    console.error('check-integ-cdk-lib-floor: SELF-PROBE FAILED — the classifier is broken:');
    for (const f of probeFailures) console.error(`  ${f.label}: ${f.detail}`);
    process.exit(1);
  }

  const report = checkIntegCdkLibFloor({
    integRoot: integRoot ?? join(repoRoot, INTEG_ROOT_REL),
    templatePath: template ?? join(repoRoot, TEMPLATE_REL),
  });

  if (json) {
    // stdout is a DATA channel under --json; the human summary goes to stderr.
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }

  const floorViolations: string[] = [];
  if (report.fixtures < FLOORS.fixtures) {
    floorViolations.push(`only ${report.fixtures} fixtures read (floor ${FLOORS.fixtures})`);
  }
  if (report.declaringFixtures < FLOORS.declaringFixtures) {
    floorViolations.push(
      `only ${report.declaringFixtures} fixtures declared aws-cdk-lib (floor ${FLOORS.declaringFixtures})`,
    );
  }

  const all = [...floorViolations, ...report.violations];
  if (all.length > 0) {
    console.error('check-integ-cdk-lib-floor: FAILED');
    for (const v of all) console.error(`  ${v}`);
    process.exit(1);
  }

  console.error(
    `check-integ-cdk-lib-floor: OK — template ${report.templateFloor?.raw}, ` +
      `${report.declaringFixtures}/${report.fixtures} fixtures, ` +
      `lowest corpus floor ${report.minFloor?.raw}, ${report.distinctFloors.length} distinct.`,
  );
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  main();
}
