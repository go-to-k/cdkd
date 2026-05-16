#!/usr/bin/env node
/**
 * scripts/build-cli-flag-coverage-matrix.ts
 *
 * Builds a `(CLI flag) -> (integ fixture verify.sh that exercises it)`
 * coverage map by:
 *
 *   1. Parsing src/cli/options.ts for declared Commander Option flags
 *      (both `new Option('--foo')` and `new Option('-f, --foo')` shapes,
 *      single-line AND multi-line constructor calls).
 *   2. Grepping every tests/integration/<fixture>/verify.sh for
 *      `cdkd <subcmd> ... --<flag-name> ...` invocations.
 *   3. Diffing — flags WITH at least one verify.sh hit are covered;
 *      flags WITHOUT any are listed in the "no integ-level test"
 *      section.
 *
 * Why this is a VISIBILITY report, not a CI gate (this is a deliberate
 * design choice, NOT a Phase-2-to-do):
 *
 *   - Many cdkd flags are tested at the UNIT-test level rather than via
 *     an integ verify.sh — `--dry-run`, `--verbose`, `--profile`,
 *     etc. all have unit-test coverage but no integ shell invocation.
 *   - Flagging those as "no integ-level test" would be 50%+ false-
 *     positive, defeating the gate's signal-to-noise.
 *   - The provider-coverage matrix could be a CI gate because every
 *     registered provider IS expected to have integ coverage (real-AWS
 *     verification is the whole point of integ). Flags are not in
 *     symmetric position — many are pure-logic flags whose unit-test
 *     coverage is sufficient.
 *   - The right consumer of this report is the contributor reviewing
 *     "did I add a flag that genuinely needs real-AWS verification?" —
 *     a question only the contributor can answer per-flag.
 *
 * Closes Phase 2A of go-to-k/cdkd#392. Phase 2B (scenario tags) is
 * filed separately as go-to-k/cdkd#423.
 *
 * Outputs:
 *   - docs/_generated/cli-flag-coverage.json: machine-readable matrix.
 *   - docs/cli-flag-coverage.md:               markdown report.
 *
 * Run from the repo root:
 *   node --experimental-strip-types scripts/build-cli-flag-coverage-matrix.ts
 *   (or: vp run cli-flag-coverage)
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const OPTIONS_FILE = join(REPO_ROOT, 'src/cli/options.ts');
const INTEG_DIR = join(REPO_ROOT, 'tests/integration');
const OUTPUT_JSON = join(REPO_ROOT, 'docs/_generated/cli-flag-coverage.json');
const OUTPUT_MD = join(REPO_ROOT, 'docs/cli-flag-coverage.md');

/**
 * Parse the Commander `Option(...)` argument string into a normalized
 * flag set. Examples:
 *
 *   '--verbose'                       -> { long: ['--verbose'], short: [] }
 *   '-f, --force'                     -> { long: ['--force'], short: ['-f'] }
 *   '--profile <profile>'             -> { long: ['--profile'], short: [] }
 *   '--no-rollback'                   -> { long: ['--no-rollback'], short: [] }
 *   '-c, --context <key=value...>'    -> { long: ['--context'], short: ['-c'] }
 *
 * `<...>` placeholder text (argument hints) is stripped. The leading
 * comma-separated tokens are split and classified by whether they start
 * with `--` (long) or `-` (short).
 */
export interface ParsedFlag {
  long: string[];
  short: string[];
  raw: string;
}

export function parseFlagSpec(spec: string): ParsedFlag {
  // Strip Commander's `<arg>` and `[arg]` placeholder syntax. Strip
  // `<...>` first so that a nested `[<arn>]` collapses to `[]` which
  // the `[...]` pass then removes. The earlier `[<\[][^>\]]*[>\]]`
  // single-pass regex left an orphan `]` on the nested case.
  const cleaned = spec
    .replace(/<[^>]*>/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+\.\.\./g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const tokens = cleaned.split(/\s*,\s*/).filter((t) => t.length > 0);
  const long: string[] = [];
  const short: string[] = [];
  for (const t of tokens) {
    const trimmed = t.trim();
    if (trimmed.startsWith('--')) long.push(trimmed);
    else if (trimmed.startsWith('-')) short.push(trimmed);
  }
  return { long, short, raw: spec.trim() };
}

/**
 * Extract every `new Option('<spec>', ...)` first-argument string from
 * the source file. Handles single-line and multi-line constructor
 * calls; the regex uses a dotall match so a constructor split across
 * lines is captured whole.
 *
 * Returns the list of raw flag-spec strings (e.g. `'-f, --force'`,
 * `'--verbose'`, `'--concurrency <number>'`) in source order.
 */
export function parseOptionSpecsFromSource(content: string): string[] {
  const out: string[] = [];
  // `new Option(` followed by optional whitespace (including newlines),
  // then a single-quoted or double-quoted string literal.
  const re = /new\s+Option\(\s*(['"])((?:\\.|(?!\1).)*?)\1/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.push(m[2]);
  }
  return out;
}

/**
 * Enumerate the long-form flag names (e.g. `--verbose`, `--force`,
 * `--no-rollback`) declared in src/cli/options.ts. De-duplicated and
 * sorted. Short-form aliases (`-f`, `-y`, etc.) are omitted from the
 * coverage axis since integ verify.sh scripts overwhelmingly use the
 * long form; surfacing both would double-count.
 */
export function parseDeclaredFlags(content: string): string[] {
  const specs = parseOptionSpecsFromSource(content);
  const longs = new Set<string>();
  for (const spec of specs) {
    const parsed = parseFlagSpec(spec);
    for (const l of parsed.long) longs.add(l);
  }
  return Array.from(longs).sort();
}

function listFixtures(): string[] {
  if (!existsSync(INTEG_DIR)) return [];
  return readdirSync(INTEG_DIR)
    .filter((name) => {
      const p = join(INTEG_DIR, name);
      return statSync(p).isDirectory();
    })
    .sort();
}

function listVerifyShFiles(fixtureDir: string): string[] {
  const out: string[] = [];
  // verify.sh is the canonical name; also accept *.sh under the fixture
  // root in case future fixtures use a split-script layout.
  const direct = join(fixtureDir, 'verify.sh');
  if (existsSync(direct) && statSync(direct).isFile()) out.push(direct);
  for (const entry of readdirSync(fixtureDir)) {
    if (!entry.endsWith('.sh')) continue;
    if (entry === 'verify.sh') continue; // already added
    const full = join(fixtureDir, entry);
    if (statSync(full).isFile()) out.push(full);
  }
  return out;
}

/**
 * Detect every long-form flag (`--<name>`) referenced in a shell script
 * body. The match is anchored on the `--` prefix and stops at the next
 * non-flag-name character (space / equals / pipe / etc.). Short-form
 * (`-f`) is NOT detected — the declared-flags axis omits short forms to
 * avoid double-counting, so detection must follow the same axis.
 *
 * A flag is counted as "used" if it appears anywhere in the script
 * body, even inside a quoted string or a comment. False-positive risk
 * is low because shell scripts rarely mention CLI flag names outside
 * of actual invocation contexts.
 */
export function scanFlagsInShellScript(content: string): Set<string> {
  const out = new Set<string>();
  const re = /(--[a-zA-Z][a-zA-Z0-9-]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    out.add(m[1]);
  }
  return out;
}

export interface FlagCoverageEntry {
  flag: string;
  integs: string[];
}

export interface FlagCoverageReport {
  declaredFlags: string[];
  covered: FlagCoverageEntry[];
  uncovered: string[];
  unknownFlagsInIntegs: string[];
}

function buildReport(): FlagCoverageReport {
  const optionsSrc = readFileSync(OPTIONS_FILE, 'utf8');
  const declaredFlags = parseDeclaredFlags(optionsSrc);
  const declaredSet = new Set(declaredFlags);

  const perFlag = new Map<string, Set<string>>();
  for (const f of declaredFlags) perFlag.set(f, new Set());
  const unknownFlags = new Set<string>();

  for (const fixture of listFixtures()) {
    const fixtureDir = join(INTEG_DIR, fixture);
    const shFiles = listVerifyShFiles(fixtureDir);
    if (shFiles.length === 0) continue;
    for (const sh of shFiles) {
      const content = readFileSync(sh, 'utf8');
      const flags = scanFlagsInShellScript(content);
      for (const f of flags) {
        if (declaredSet.has(f)) {
          perFlag.get(f)!.add(fixture);
        } else {
          // Common shell flags (`--quiet`, `--silent`, `--filter`, etc.)
          // overwhelmingly dominate this set — surfaced for visibility
          // only so a contributor adding a new cdkd flag with a typo
          // can spot it.
          unknownFlags.add(f);
        }
      }
    }
  }

  const covered: FlagCoverageEntry[] = [];
  const uncovered: string[] = [];
  for (const flag of declaredFlags) {
    const integs = Array.from(perFlag.get(flag)!).sort();
    if (integs.length === 0) {
      uncovered.push(flag);
    } else {
      covered.push({ flag, integs });
    }
  }

  return {
    declaredFlags,
    covered,
    uncovered,
    unknownFlagsInIntegs: Array.from(unknownFlags).sort(),
  };
}

function renderMarkdown(report: FlagCoverageReport): string {
  const lines: string[] = [];
  lines.push('# CLI Flag Coverage Matrix');
  lines.push('');
  lines.push(
    '<!-- AUTO-GENERATED by scripts/build-cli-flag-coverage-matrix.ts. Do not hand-edit. -->'
  );
  lines.push('');
  lines.push('Run `vp run cli-flag-coverage` to regenerate.');
  lines.push('');
  lines.push(
    `**${report.covered.length} / ${report.declaredFlags.length} declared CLI flags** appear in at least one \`tests/integration/<name>/verify.sh\` script. ${report.uncovered.length} flags are not exercised by any integ verify.sh.`
  );
  lines.push('');
  lines.push('## Important: this is a VISIBILITY report, not a CI gate');
  lines.push('');
  lines.push(
    'Many cdkd flags are tested at the **unit-test level** rather than via an integ `verify.sh` (`--dry-run`, `--verbose`, `--profile`, etc.) — flagging those as "uncovered" would produce 50%+ false-positive noise, defeating any gate. The "uncovered flags" section below lists flags that no integ shell script mentions; treat it as a question ("does THIS flag warrant a real-AWS test?"), not an answer ("this is a gap").'
  );
  lines.push('');
  lines.push(
    'See the script docstring for the design rationale; this matrix is intentionally not wired to CI hard-fail (contrast with the provider-coverage matrix in [docs/integ-coverage.md](integ-coverage.md), where the CI gate IS appropriate because every registered provider is expected to have real-AWS verification).'
  );
  lines.push('');
  if (report.uncovered.length > 0) {
    lines.push(`## Flags with no integ verify.sh mention (${report.uncovered.length})`);
    lines.push('');
    lines.push(
      'Reviewer judgment required per flag — many of these are pure-logic flags adequately tested at the unit level.'
    );
    lines.push('');
    for (const f of report.uncovered) {
      lines.push(`- \`${f}\``);
    }
    lines.push('');
  } else {
    lines.push('## Flags with no integ verify.sh mention');
    lines.push('');
    lines.push('_None._ Every declared flag is mentioned in at least one integ verify.sh.');
    lines.push('');
  }

  lines.push(`## Flags exercised by integ verify.sh (${report.covered.length})`);
  lines.push('');
  lines.push('| Flag | Integ Fixture(s) |');
  lines.push('|---|---|');
  for (const entry of report.covered) {
    const fixtures = entry.integs
      .map((f) => `[\`${f}\`](../tests/integration/${f}/)`)
      .join('<br>');
    lines.push(`| \`${entry.flag}\` | ${fixtures} |`);
  }
  lines.push('');

  if (report.unknownFlagsInIntegs.length > 0) {
    lines.push(
      `## Long-form flags referenced in integs but NOT declared in src/cli/options.ts (${report.unknownFlagsInIntegs.length})`
    );
    lines.push('');
    lines.push(
      'These are mostly third-party CLI flags (`--query` for `aws` / `--region` for `aws s3 ls` / `--no-paginate` / etc.) OR typos of cdkd flag names. Listed here for visibility — review only if a row matches a cdkd flag with a misspelling.'
    );
    lines.push('');
    // The list can be very long; cap to first 200 entries to keep the
    // markdown report tractable. Full list lives in the JSON output.
    const cap = Math.min(200, report.unknownFlagsInIntegs.length);
    for (const f of report.unknownFlagsInIntegs.slice(0, cap)) {
      lines.push(`- \`${f}\``);
    }
    if (report.unknownFlagsInIntegs.length > cap) {
      lines.push('');
      lines.push(
        `_(${report.unknownFlagsInIntegs.length - cap} more entries truncated — see \`docs/_generated/cli-flag-coverage.json\` for the full list.)_`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === __filename;
};

function main(): void {
  const report = buildReport();
  mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
  writeFileSync(OUTPUT_JSON, JSON.stringify(report, null, 2) + '\n', 'utf8');
  writeFileSync(OUTPUT_MD, renderMarkdown(report), 'utf8');
  const covered = report.covered.length;
  const total = report.declaredFlags.length;
  const uncovered = report.uncovered.length;
  process.stderr.write(
    `cli-flag-coverage: wrote ${basename(OUTPUT_MD)} and ${basename(OUTPUT_JSON)} — ${covered}/${total} flags exercised in integ verify.sh, ${uncovered} not covered\n`
  );
}

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(
      `cli-flag-coverage: failed — ${(err as Error).message}\n`
    );
    process.exit(1);
  }
}
