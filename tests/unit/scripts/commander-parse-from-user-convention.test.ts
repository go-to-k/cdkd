import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * A `parse(argv, { from: 'user' })` call must not carry an argv[0]/argv[1]
 * prefix.
 *
 * `from: 'user'` tells Commander the array is USER arguments — everything
 * after the script name. Handing it an argv-shaped array makes the leading
 * `node` / `cdkd` OPERANDS. Measured on commander 12.1.0 against a command
 * declaring `<target>`:
 *
 *     parse(['node', 'cdkd', 'My/Dist', '--tls'], { from: 'user' })
 *       -> processedArgs = ["node"]        args = ["node","cdkd","My/Dist"]
 *     parse(['My/Dist', '--tls'], { from: 'user' })
 *       -> processedArgs = ["My/Dist"]     args = ["My/Dist"]
 *
 * So the case believed it was targeting `My/Dist` while the command received
 * `node`. Every such site asserted only `opts()`, which parses identically
 * either way, so the whole family passed while exercising a target no user
 * would ever type.
 *
 * The second cost is forward-looking: a command declaring no `.argument()`
 * tolerated the excess operands on commander 12 but ERRORS from 14 on
 * ("too many arguments"). Under `tests/setup.ts`, whose stream fence drops a
 * passing test's stderr, that arrives as a silent `error()` — 19 such sites
 * were found this way while evaluating the bump (go-to-k/cdkd#2533), each in
 * a test reporting green.
 *
 * Both failure modes are invisible from reading the assertion, which is why
 * this is a source-shape lint rather than a runtime one.
 *
 * Out of scope by construction: a call with NO `from` option (or
 * `from: 'node'`) is argv-shaped BY DEFINITION and must keep its prefix —
 * `program.parseAsync(['node', 'cdkd', 'deploy'])` is correct and common.
 *
 * Per "a checker must prove it sees its input" (.claude/rules/testing.md),
 * the scan carries a file-count floor and a floor on the number of
 * `from: 'user'` sites it actually recognized, so a walker or matcher
 * regression cannot pass vacuously.
 */

const TESTS_ROOT = join(import.meta.dirname, '..', '..');

/**
 * One `parse(...)` / `parseAsync(...)` call, matched across line breaks:
 * the sites in this repo wrap in three different shapes (all on one line,
 * array on its own line, options object on its own line), and a line-anchored
 * needle silently misses the wrapped ones — which is exactly how the first
 * sweep of this family left 7 sites behind.
 */
const PARSE_CALL_RE = /\.parse(?:Async)?\s*\(\s*(\[[\s\S]*?\])\s*,\s*(\{[\s\S]*?\})\s*,?\s*\)/g;

/** An argv[0]/argv[1] prefix: a runtime, then this repo's binary names. */
const ARGV_PREFIX_RE = /^\[\s*(['"])(?:node|npx|tsx)\1\s*,\s*(['"])(?:cdkd|cdkl|cdk)\2/;

const FROM_USER_RE = /\bfrom\s*:\s*(['"])user\1/;

/**
 * Blank out comments, preserving offsets and line structure.
 *
 * Not optional hygiene — measured. `local-start-cloudfront.test.ts:23` carries
 * the prose ``// `cmd.parse([...])` runs the registered `.action(handler)`
 * body``, and {@link PARSE_CALL_RE}'s non-greedy array ran from that `[` to
 * the first `]` SIXTY-THREE lines later, swallowing the real violating call at
 * line 86 inside one match. The scan reported six sites and zero violations
 * for a file that had one, and only a real-code probe (re-introducing the
 * prefix and watching the lint stay green) exposed it.
 *
 * Quote-aware, because blanking `//` inside a string would corrupt any URL a
 * fixture carries and shift the very offsets this exists to keep honest.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out += ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < source.length) {
        out += source[i];
        if (source[i] === '\\') {
          i++;
          if (i < source.length) out += source[i];
          i++;
          continue;
        }
        if (source[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function walkTestFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'cdk.out') continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walkTestFiles(full, out);
    } else if (
      entry.endsWith('.test.ts') &&
      // Skip this lint itself — its doc comment spells the banned shape out
      // as prose, which would self-match.
      entry !== 'commander-parse-from-user-convention.test.ts'
    ) {
      out.push(full);
    }
  }
}

interface Site {
  readonly file: string;
  readonly array: string;
}

function collectFromUserSites(files: string[]): { sites: Site[]; violations: Site[] } {
  const sites: Site[] = [];
  const violations: Site[] = [];
  for (const file of files) {
    const source = stripComments(readFileSync(file, 'utf8'));
    for (const match of source.matchAll(PARSE_CALL_RE)) {
      const [, array, options] = match as unknown as [string, string, string];
      if (!FROM_USER_RE.test(options)) continue;
      const site: Site = { file: file.replace(`${TESTS_ROOT}/`, 'tests/'), array };
      sites.push(site);
      if (ARGV_PREFIX_RE.test(array)) violations.push(site);
    }
  }
  return { sites, violations };
}

describe("commander parse(argv, { from: 'user' }) must not carry an argv prefix", () => {
  const files: string[] = [];
  walkTestFiles(TESTS_ROOT, files);
  const { sites, violations } = collectFromUserSites(files);

  it('scans a plausible number of test files (walker coverage floor)', () => {
    expect(files.length).toBeGreaterThan(400);
  });

  it("recognizes the repo's from: 'user' parse sites (matcher coverage floor)", () => {
    // ~50 such calls at the time of writing, across the local-* CLI suites.
    // A matcher that stops recognizing the wrapped call shapes drops well
    // below this, which is the regression that would make the check vacuous.
    expect(sites.length).toBeGreaterThan(30);
  });

  it('matches the wrapped call shapes, not just the single-line one', () => {
    // The single-line and array-on-its-own-line spellings both occur in this
    // repo. Deriving the check from a synthetic pair keeps it honest about
    // the multi-line half even if every real site were reformatted.
    const probe = [
      "cmd.parse(['--flag'], { from: 'user' });",
      "cmd.parse(\n  ['node', 'cdkd', 'Target', '--flag'],\n  { from: 'user' }\n);",
    ].join('\n');
    const matches = [...probe.matchAll(PARSE_CALL_RE)].filter((m) =>
      FROM_USER_RE.test(m[2] as string)
    );
    expect(matches).toHaveLength(2);
    expect(ARGV_PREFIX_RE.test(matches[0]![1] as string)).toBe(false);
    expect(ARGV_PREFIX_RE.test(matches[1]![1] as string)).toBe(true);
  });

  it('a commented-out parse call cannot swallow the real one after it', () => {
    // The exact shape that defeated the first cut of this check, reduced:
    // prose whose `[` opens 60-odd lines before the first `]`. Without
    // `stripComments` the two calls below collapse into ONE match whose array
    // starts in the comment, so the violation goes unseen.
    const probe = [
      "// `cmd.parse([...])` runs the registered `.action(handler)` body.",
      "cmd.parse(['node', 'cdkd', 'My/Dist', '--tls'], { from: 'user' });",
    ].join('\n');

    const rawViolations = [...probe.matchAll(PARSE_CALL_RE)].filter(
      (m) => FROM_USER_RE.test(m[2] as string) && ARGV_PREFIX_RE.test(m[1] as string)
    );
    expect(rawViolations, 'unstripped: the comment hides it — this is the defect').toHaveLength(0);

    const strippedViolations = [...stripComments(probe).matchAll(PARSE_CALL_RE)].filter(
      (m) => FROM_USER_RE.test(m[2] as string) && ARGV_PREFIX_RE.test(m[1] as string)
    );
    expect(strippedViolations, 'stripped: the real call is visible').toHaveLength(1);
  });

  it('blanks comments without touching a // inside a string literal', () => {
    const probe = `const url = 'https://example.com/x'; // trailing\ncmd.parse(['a'], { from: 'user' });`;
    const stripped = stripComments(probe);
    expect(stripped).toContain("'https://example.com/x'");
    expect(stripped).not.toContain('trailing');
    // Offsets are preserved, so a reported position still points at the source.
    expect(stripped).toHaveLength(probe.length);
  });

  it("no from: 'user' parse passes an argv[0]/argv[1] prefix", () => {
    expect(
      violations.map((v) => `${v.file}: ${v.array.replace(/\s+/g, ' ').slice(0, 80)}`),
      "`from: 'user'` means the array is USER arguments — drop the leading runtime/binary names, or remove the `from` option if the array really is argv"
    ).toEqual([]);
  });
});
