import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vite-plus/test';

/**
 * The published Node.js floor is stated in FIVE places that nothing but this
 * file ties together: `package.json` `engines.node` (what npm / pnpm warn on
 * at install, and refuse under `engine-strict`), `vite.config.ts`'s
 * `pack.target` (what syntax tsdown may emit), the `runtime-compat` CI matrix
 * (the only place the built CLI is EXECUTED on the floor — its first row is
 * the exact floor, major.minor, because a bare major resolves to the newest
 * 22.x and proves nothing about 22.12), and the docs / README sentences a
 * user reads before installing. Each moved on its own before issue #3037: the
 * matrix still smoked Node 20 after it went EOL (2026-04-30), and a
 * dependency bump could have raised the effective floor with no line in the
 * diff saying so (`commander@15` declares `>=22.12.0`, which is why 22.12.0
 * is the value chosen — the next commander major cannot move the floor
 * again).
 *
 * `FLOOR` is a LITERAL here on purpose. Deriving it from `package.json` would
 * make every other assertion a tautology against whatever the manifest says;
 * the value has to come from a source the fence does not read, so that
 * changing ONE surface goes red until all of them move together. Everything
 * else is DERIVED from it — the docs spelling, the matrix's first row, the
 * retired spellings the prose must not carry — so the next bump edits this
 * one constant plus every surface, and a docs file that keeps BOTH the old
 * and the new floor goes red on the old one.
 *
 * The workflow is parsed with a real YAML parser and the matrix read by key
 * path, so a renamed job fails as `undefined` rather than matching nothing.
 * The pack target is the one surface read by regex: it is a single quoted
 * literal inside TypeScript, and the assertion fails CLOSED on zero or more
 * than one match rather than trusting the first.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** The published floor. A literal — see the header for why. */
const FLOOR = '22.12.0';
const FLOOR_MAJOR = Number(FLOOR.split('.')[0]);
/**
 * The `major.minor` spelling the docs and the matrix's floor row use — the
 * bare major when the floor is an `.0` minor ("Node.js 24", not "24.0").
 */
function shortOf(floor: string): string {
  const [major, minor] = floor.split('.');
  return minor === '0' ? major! : `${major}.${minor}`;
}
const FLOOR_SHORT = shortOf(FLOOR);
const FLOOR_SHORT_RE = FLOOR_SHORT.replace('.', String.raw`\.`);
/** The full semver, escaped, for the files that state `>= 22.12.0`. */
const FLOOR_RE = FLOOR.replace(/\./g, String.raw`\.`);

/**
 * Spellings that advertised an OLDER floor, generated for every major below
 * the current one back to the oldest this package ever shipped on, as bounded
 * regexes restricted to a FLOOR CLAIM ("or later", "+", ">=", "runtime") so
 * an EOL note such as "Node 20 is past end of life" and a measurement such
 * as "On Node 20 / 22 the runtime swallows it" stay legal — the fence is on
 * the CLAIM of support, not on the number.
 */
const OLDEST_EVER_SHIPPED_MAJOR = 18;
/**
 * The retired-floor patterns for a set of majors. A function rather than a
 * constant so the self-probe below can run it against the CURRENT floor and
 * prove the next bump's fence would catch today's sentences — `major.minor`
 * spellings included (`Node.js 22.12 or later` must be retired by the bump
 * to 24 exactly as `Node.js 20 or later` was by this one).
 *
 * KNOWN BOUND: a matrix ENUMERATION ("smoke-runs on Node 20 / 22 / 24") is
 * not retired, because "On Node 20 / 22 the runtime swallows it" — a
 * measurement in tests/setup.ts, outside the scanned set; the synthetic note
 * below pins the shape — reads the same; such a sentence is caught only when
 * a doc pins it positively (or by the bump's own grep).
 */
function oldFloorSpellings(majors: ReadonlyArray<number>): ReadonlyArray<RegExp> {
  return majors.flatMap((m) => {
    // `\s+` between tokens because the docs hard-wrap mid-sentence.
    // `20`, `v20`, `20.19`, `20.x`, `20 LTS` — a floor is stated at any
    // precision and with the decorations a release note uses.
    const v = String.raw`v?${m}(?:\.\d+)*(?:\.x)?(?:\s+LTS)?`;
    return [
      String.raw`Node(?:\.js)?\s+${v}\s+(?:or|and)\s+(?:later|higher|newer|up)`,
      String.raw`Node(?:\.js)?\s+${v}\+`,
      String.raw`Node\s+${v}\s+runtime`,
      String.raw`Node\s+${v}\s+\(the\s+(?:runtime|exact\s+floor)`,
      // A bare version in the "must report `v20.19.0` or higher" shape.
      String.raw`v${m}(?:\.\d+)*(?:\.x)?\x60?\s+or\s+(?:later|higher|newer|up)`,
      // A range, anchored to a Node / engines mention within the same clause
      // (across a hard wrap) so `Docker >= 20.10` stays legal; `(?!\d)` keeps
      // `>=20` from matching a `>=2026` date or a `>=200` count.
      String.raw`(?:Node(?:\.js)?\**|engines)[\s\S]{0,40}>=\s?${v}(?!\d)`,
    ].map((src) => new RegExp(src));
  });
}
const OLD_FLOOR_SPELLINGS = oldFloorSpellings(
  Array.from(
    { length: FLOOR_MAJOR - OLDEST_EVER_SHIPPED_MAJOR },
    (_, i) => OLDEST_EVER_SHIPPED_MAJOR + i
  )
);

/**
 * Every prose file that states the floor to a reader, each with the exact
 * phrase it uses — pinned positively so the file cannot satisfy the fence
 * with a `22.12` that is a date or another product's version.
 */
const DOCS_STATING_THE_FLOOR: ReadonlyArray<readonly [file: string, statement: RegExp]> = [
  ['README.md', new RegExp(String.raw`Node\.js\s+${FLOOR_SHORT_RE}\s+or\s+later`)],
  ['AGENTS.md', new RegExp(String.raw`Node\.js\s+>=\s+${FLOOR_RE}\s+\(the\s+lower\s+bound`)],
  ['CONTRIBUTING.md', new RegExp(String.raw`users\s+on\s+Node\.js\s+${FLOOR_SHORT_RE}\s+and\s+later`)],
  [
    'docs/contributing.md',
    new RegExp(String.raw`users\s+on\s+Node\.js\s+${FLOOR_SHORT_RE}\s+and\s+later`),
  ],
  ['docs/getting-started.md', new RegExp(String.raw`\*\*Node\.js\*\*\s+>=\s+${FLOOR_RE}`)],
  ['docs/testing.md', new RegExp(String.raw`Node\.js\s+${FLOOR_SHORT_RE}\s+or\s+higher`)],
  ['tests/benchmark/README.md', new RegExp(String.raw`Node\.js\s+>=\s+${FLOOR_RE}`)],
  [
    'plugins/cdkd-skills/skills/cdkd/SKILL.md',
    new RegExp(String.raw`requires\s+Node\.js\s+${FLOOR_SHORT_RE}\s+or\s+later`),
  ],
];

interface CiWorkflow {
  jobs: Record<
    string,
    {
      strategy?: { matrix?: { 'node-version'?: unknown } };
    }
  >;
}

describe('the published Node.js floor is one value across every surface (#3037)', () => {
  it('the derived spellings are non-vacuous', () => {
    expect(Number.isInteger(FLOOR_MAJOR)).toBe(true);
    expect(FLOOR_MAJOR).toBeGreaterThan(OLDEST_EVER_SHIPPED_MAJOR);
    expect(OLD_FLOOR_SPELLINGS.length).toBeGreaterThan(0);
    // Both arms of the `.0`-minor rule, on values the fence does not read.
    expect(shortOf('22.12.0')).toBe('22.12');
    expect(shortOf('24.0.0')).toBe('24');
    // The prose table is pinned by NAME: `it.each([])` registers nothing and
    // the self-probe loop runs zero times, so an emptied or shortened table
    // would otherwise pass in silence.
    expect(DOCS_STATING_THE_FLOOR.map(([file]) => file)).toEqual([
      'README.md',
      'AGENTS.md',
      'CONTRIBUTING.md',
      'docs/contributing.md',
      'docs/getting-started.md',
      'docs/testing.md',
      'tests/benchmark/README.md',
      'plugins/cdkd-skills/skills/cdkd/SKILL.md',
    ]);
  });

  it('the retired-spelling generator fires on floor claims and not on notes about a version', () => {
    const patterns = oldFloorSpellings([20]);
    const fires = (text: string): boolean => patterns.some((p) => p.test(text));
    // Claims of support, in the shapes a README or a release note uses.
    for (const claim of [
      'Node.js 20 or later',
      'Node 20+',
      'Node.js 20.19 and later',
      'Node.js 20.x or later',
      'Node.js v20 or later',
      'Node v20+',
      'Node 20 LTS or later',
      'Node.js 20 or newer',
      'Node 20 or up',
      'Node.js 20+',
      'runs on v20.x or later',
      'must report `v20.19.0` or higher',
      'with a Node 20 runtime target',
      'on Node 20.19 (the exact floor) and 24',
      'Node 20 (the runtime cdkd ships to users)',
      'engines >= 20.0.0',
      'engines\n  declares `>=20`',
    ]) {
      expect(fires(claim), `"${claim}" is a floor claim and must fire`).toBe(true);
    }
    // Mentions of the number that claim nothing about support.
    for (const note of [
      'Node.js 20 is past end of life',
      'Node 20 or earlier is past end of life and no longer supported',
      'On Node 20 / 22 the runtime swallows it silently',
      'measured >= 2026-09-14',
      'across >= 200 fixtures',
      'the nodejs20.x Lambda runtime',
      'Docker >= 20.10 for --add-host',
    ]) {
      expect(fires(note), `"${note}" claims no floor and must not fire`).toBe(false);
    }
  });

  it.each(DOCS_STATING_THE_FLOOR)(
    '%s: the retired-spelling generator would catch its CURRENT floor sentence at the next bump',
    (doc, statement) => {
      // Run the generator as the NEXT bump will, with today's floor as the old
      // one, against the sentence the doc carries today: it must be retired,
      // or the fence's "keeps both floors goes red" promise is only true for a
      // floor whose minor happens to be 0.
      const sentence = read(doc).match(statement)?.[0] ?? '';
      expect(sentence, `${doc} has no floor sentence to probe`).not.toBe('');
      expect(
        oldFloorSpellings([FLOOR_MAJOR]).some((p) => p.test(sentence)),
        `${doc}: "${sentence}" would survive the next bump`
      ).toBe(true);
    }
  );

  it('package.json engines.node is exactly the floor as a >= range', () => {
    const pkg = JSON.parse(read('package.json')) as { engines?: { node?: string } };
    expect(pkg.engines?.node).toBe(`>=${FLOOR}`);
  });

  it('vite.config.ts packs for the floor major, stated exactly once', () => {
    const matches = [...read('vite.config.ts').matchAll(/target:\s*'node(\d+)'/g)];
    // Fail closed: zero matches means the target moved somewhere this fence
    // does not read; two means a second pack block could disagree with the
    // first while the first one alone keeps this green.
    expect(matches.map((m) => m[0])).toEqual([`target: 'node${FLOOR_MAJOR}'`]);
  });

  it('the runtime-compat matrix smokes the EXACT floor first, the dev pin too, and nothing below the floor', () => {
    const ci = parseYaml(read('.github/workflows/ci.yml')) as CiWorkflow;
    const rows = ci.jobs['runtime-compat']?.strategy?.matrix?.['node-version'];
    expect(Array.isArray(rows)).toBe(true);
    // Rows are quoted strings so YAML cannot reshape them (an unquoted 22.10
    // parses as the float 22.1); refuse anything else rather than coerce it.
    for (const row of rows as unknown[]) {
      expect(typeof row, `non-string matrix row ${String(row)}`).toBe('string');
      expect(row as string).toMatch(/^\d+(\.\d+)?$/);
    }
    const versions = rows as string[];
    // The FIRST row is the floor itself, major.minor, so the smoke executes
    // the bundle on the promised minimum.
    expect(versions[0]).toBe(FLOOR_SHORT);
    const majors = versions.map((v) => Number(v.split('.')[0]));
    expect(Math.min(...majors)).toBe(FLOOR_MAJOR);
    // The CLI is executed on every entry, so an entry below the floor is a
    // claim of support the engines range denies.
    expect(majors.every((m) => m >= FLOOR_MAJOR)).toBe(true);
    // The dev / CI pin (`.node-version`) is the runtime the suite itself runs
    // on; the built CLI must be smoked there too, or the matrix can quietly
    // drop the version every contributor actually uses.
    const devPinMajor = Number(read('.node-version').trim().split('.')[0]);
    expect(majors).toContain(devPinMajor);
  });

  it("ci.yml's required-check comment names the floor row as its expanded-name example", () => {
    const ci = read('.github/workflows/ci.yml');
    expect(ci).toContain(`runtime-compat (${FLOOR_SHORT})`);
    // Any OTHER expanded name in the file is a stale example from a row
    // that no longer exists (a bare `(22)` and the retired `(20)` included).
    expect(ci).not.toMatch(
      new RegExp(String.raw`runtime-compat \((?!${FLOOR_SHORT_RE}\))[\d.]+\)`)
    );
  });

  it.each(DOCS_STATING_THE_FLOOR)('%s states the floor and no older one', (rel, statement) => {
    const text = read(rel);
    expect(text, `${rel} no longer carries its floor statement ${statement}`).toMatch(statement);
    for (const old of OLD_FLOOR_SPELLINGS) {
      expect(text, `${rel} still says ${old}`).not.toMatch(old);
    }
  });
});
