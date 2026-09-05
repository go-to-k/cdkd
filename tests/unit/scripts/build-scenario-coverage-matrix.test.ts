import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseSidecarContent,
  readFixtureSidecar,
  listFixtures,
  buildReport,
  renderMarkdown,
  KNOWN_SCENARIOS,
} from '../../../scripts/build-scenario-coverage-matrix.js';

describe('parseSidecarContent', () => {
  it('parses a valid sidecar with one tag', () => {
    const result = parseSidecarContent('{"scenarios": ["vpc-lambda-eni-release"]}');
    expect(result).toEqual({
      kind: 'present',
      scenarios: ['vpc-lambda-eni-release'],
    });
  });

  it('parses an empty-scenarios sidecar (opt-out form)', () => {
    expect(parseSidecarContent('{"scenarios": []}')).toEqual({
      kind: 'present',
      scenarios: [],
    });
  });

  it('preserves caller-provided tag order (validator sorts later)', () => {
    const result = parseSidecarContent('{"scenarios": ["z-tag", "a-tag"]}');
    expect(result).toEqual({
      kind: 'present',
      scenarios: ['z-tag', 'a-tag'],
    });
  });

  it('rejects invalid JSON', () => {
    const result = parseSidecarContent('{not json}');
    expect(result.kind).toBe('malformed');
    if (result.kind === 'malformed') {
      expect(result.reason).toContain('invalid JSON');
    }
  });

  it('rejects a top-level array', () => {
    expect(parseSidecarContent('["a", "b"]')).toEqual({
      kind: 'malformed',
      reason: 'top-level value must be an object',
    });
  });

  it('rejects a top-level null', () => {
    expect(parseSidecarContent('null')).toEqual({
      kind: 'malformed',
      reason: 'top-level value must be an object',
    });
  });

  it('rejects missing "scenarios" key', () => {
    expect(parseSidecarContent('{"other": []}')).toEqual({
      kind: 'malformed',
      reason: 'missing required key "scenarios"',
    });
  });

  it('rejects non-array "scenarios"', () => {
    expect(parseSidecarContent('{"scenarios": "not-array"}')).toEqual({
      kind: 'malformed',
      reason: '"scenarios" must be an array',
    });
  });

  it('rejects non-string tag entries', () => {
    expect(parseSidecarContent('{"scenarios": ["ok", 42]}')).toEqual({
      kind: 'malformed',
      reason: '"scenarios[1]" must be a non-empty string',
    });
  });

  it('rejects whitespace-only tag entries', () => {
    expect(parseSidecarContent('{"scenarios": ["   "]}')).toEqual({
      kind: 'malformed',
      reason: '"scenarios[0]" must be a non-empty string',
    });
  });

  it('rejects duplicate tag entries within a single sidecar', () => {
    expect(parseSidecarContent('{"scenarios": ["foo", "foo"]}')).toEqual({
      kind: 'malformed',
      reason: '"scenarios[1]" duplicates an earlier entry "foo"',
    });
  });
});

describe('readFixtureSidecar', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'scenario-cov-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns kind=absent when the sidecar is missing', () => {
    expect(readFixtureSidecar(tmpRoot)).toEqual({ kind: 'absent' });
  });

  it('returns kind=present when the sidecar exists and parses', () => {
    writeFileSync(
      join(tmpRoot, '.scenarios.json'),
      '{"scenarios": ["nat-gateway-cleanup"]}'
    );
    expect(readFixtureSidecar(tmpRoot)).toEqual({
      kind: 'present',
      scenarios: ['nat-gateway-cleanup'],
    });
  });

  it('returns kind=malformed on a JSON parse error', () => {
    writeFileSync(join(tmpRoot, '.scenarios.json'), '{bogus}');
    const result = readFixtureSidecar(tmpRoot);
    expect(result.kind).toBe('malformed');
  });
});

describe('listFixtures', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'scenario-cov-list-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns an empty list when the directory does not exist', () => {
    expect(listFixtures(join(tmpRoot, 'nope'))).toEqual([]);
  });

  it('lists immediate-child directories only, sorted', () => {
    mkdirSync(join(tmpRoot, 'b-fixture'));
    mkdirSync(join(tmpRoot, 'a-fixture'));
    writeFileSync(join(tmpRoot, 'not-a-dir.txt'), '');
    expect(listFixtures(tmpRoot)).toEqual(['a-fixture', 'b-fixture']);
  });

  it('skips hidden directories (`.foo/`, `.scratch/`)', () => {
    mkdirSync(join(tmpRoot, 'a-fixture'));
    mkdirSync(join(tmpRoot, '.hidden'));
    mkdirSync(join(tmpRoot, '.scratch'));
    expect(listFixtures(tmpRoot)).toEqual(['a-fixture']);
  });
});

describe('buildReport', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'scenario-cov-report-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const writeFixture = (name: string, scenarios: string[] | undefined): void => {
    const dir = join(tmpRoot, name);
    mkdirSync(dir, { recursive: true });
    if (scenarios !== undefined) {
      writeFileSync(
        join(dir, '.scenarios.json'),
        JSON.stringify({ scenarios }, null, 2)
      );
    }
  };

  it('reports every fixture as un-annotated when no sidecars exist', () => {
    writeFixture('fa', undefined);
    writeFixture('fb', undefined);
    const r = buildReport(tmpRoot);
    expect(r.fixtures.map((f) => f.name)).toEqual(['fa', 'fb']);
    expect(r.unannotatedFixtures).toEqual(['fa', 'fb']);
    expect(r.fixtures.every((f) => !f.annotated)).toBe(true);
  });

  it('treats empty-scenarios sidecar as annotated (intentional opt-out)', () => {
    writeFixture('smoke', []);
    const r = buildReport(tmpRoot);
    expect(r.fixtures[0]).toEqual({ name: 'smoke', annotated: true, scenarios: [] });
    expect(r.unannotatedFixtures).toEqual([]);
  });

  it('maps tagged fixtures into perScenarioCoverage', () => {
    writeFixture('fa', ['vpc-lambda-eni-release']);
    writeFixture('fb', ['vpc-lambda-eni-release', 'nat-gateway-cleanup']);
    const r = buildReport(tmpRoot);
    const eni = r.perScenarioCoverage.find((e) => e.scenario === 'vpc-lambda-eni-release');
    expect(eni?.fixtures).toEqual(['fa', 'fb']);
    const nat = r.perScenarioCoverage.find((e) => e.scenario === 'nat-gateway-cleanup');
    expect(nat?.fixtures).toEqual(['fb']);
  });

  it('lists scenarios with no fixture coverage as orphans', () => {
    writeFixture('fa', ['vpc-lambda-eni-release']);
    const r = buildReport(tmpRoot);
    expect(r.orphanScenarios).toContain('nat-gateway-cleanup');
    expect(r.orphanScenarios).not.toContain('vpc-lambda-eni-release');
  });

  it('captures unknown tags as invalidTagSites (does not include them in coverage)', () => {
    writeFixture('fa', ['not-a-real-tag', 'vpc-lambda-eni-release']);
    const r = buildReport(tmpRoot);
    expect(r.invalidTagSites).toEqual([{ fixture: 'fa', tag: 'not-a-real-tag' }]);
    expect(r.fixtures[0].scenarios).toEqual(['vpc-lambda-eni-release']);
  });

  it('throws when a sidecar is malformed JSON', () => {
    const dir = join(tmpRoot, 'fa');
    mkdirSync(dir);
    writeFileSync(join(dir, '.scenarios.json'), '{not-json}');
    expect(() => buildReport(tmpRoot)).toThrow(/malformed sidecar/);
  });

  it('sorts per-fixture scenarios alphabetically for stable diff', () => {
    writeFixture('fa', ['nat-gateway-cleanup', 'vpc-lambda-eni-release']);
    const r = buildReport(tmpRoot);
    expect(r.fixtures[0].scenarios).toEqual([
      'nat-gateway-cleanup',
      'vpc-lambda-eni-release',
    ]);
  });
});

describe('KNOWN_SCENARIOS taxonomy', () => {
  it('has only lowercase-hyphenated keys', () => {
    for (const key of Object.keys(KNOWN_SCENARIOS)) {
      expect(key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it('has a non-empty description for every entry', () => {
    for (const [key, desc] of Object.entries(KNOWN_SCENARIOS)) {
      expect(desc.trim()).not.toBe('');
      expect(desc.length).toBeGreaterThan(20);
      // Each description is intended to be one line; check no embedded newlines.
      expect(desc).not.toContain('\n');
      // Reference the key so we know which entry failed.
      expect(key).toBeTruthy();
    }
  });
});

describe('renderMarkdown', () => {
  it('renders an empty report shape without throwing', () => {
    const md = renderMarkdown({
      knownScenarios: [],
      fixtures: [],
      perScenarioCoverage: [],
      orphanScenarios: [],
      unannotatedFixtures: [],
      invalidTagSites: [],
    });
    expect(md).toContain('# Scenario Coverage Matrix');
    expect(md).toContain('Run `vp run scenario-coverage`');
    expect(md).toContain('_None._');
  });

  it('renders orphan scenarios in a table', () => {
    const md = renderMarkdown({
      knownScenarios: [{ tag: 'foo', description: 'fooz' }],
      fixtures: [],
      perScenarioCoverage: [{ scenario: 'foo', description: 'fooz', fixtures: [] }],
      orphanScenarios: ['foo'],
      unannotatedFixtures: [],
      invalidTagSites: [],
    });
    expect(md).toContain('Orphan scenarios (1)');
    expect(md).toContain('| `foo` |');
  });

  it('renders covered fixtures with backtick-quoted links', () => {
    const md = renderMarkdown({
      knownScenarios: [{ tag: 'foo', description: 'fooz' }],
      fixtures: [{ name: 'fa', annotated: true, scenarios: ['foo'] }],
      perScenarioCoverage: [{ scenario: 'foo', description: 'fooz', fixtures: ['fa'] }],
      orphanScenarios: [],
      unannotatedFixtures: [],
      invalidTagSites: [],
    });
    expect(md).toContain('[`fa`](https://github.com/go-to-k/cdkd/tree/main/tests/integration/fa/)');
  });

  it('renders un-annotated fixtures as a bullet list', () => {
    const md = renderMarkdown({
      knownScenarios: [],
      fixtures: [{ name: 'fa', annotated: false, scenarios: [] }],
      perScenarioCoverage: [],
      orphanScenarios: [],
      unannotatedFixtures: ['fa'],
      invalidTagSites: [],
    });
    expect(md).toContain('Un-annotated fixtures (1)');
    expect(md).toContain('- [`fa`](https://github.com/go-to-k/cdkd/tree/main/tests/integration/fa/)');
  });
});

/**
 * Issue #2545: a description containing `|` was interpolated into a table row
 * unescaped, so six rows of `docs/scenario-coverage.md` rendered with more
 * columns than the header names and every fixture link landed under a heading
 * that did not describe it.
 *
 * A `|` is a cell delimiter in GitHub-flavoured Markdown even inside an inline
 * code span — the row is split into cells before inline parsing — so the
 * backticks the descriptions already carry protect nothing.
 *
 * The assertion is on the emitted row's CELL COUNT against its header's, with
 * escaped pipes discounted, rather than on the presence of a `\|` substring:
 * the count is the property the reader actually experiences, and it fails for
 * an escape applied to the wrong field just as it does for no escape at all.
 */
describe('renderMarkdown escapes pipes in table cells (#2545)', () => {
  /**
   * Cell count of one table row, escaped pipes neutralised first. Same rule as
   * `tests/unit/scripts/docs-table-shape.test.ts`, deliberately re-spelled
   * here: that fence measures the CHECKED-IN file, this measures the
   * generator's output before it is written, and coupling them would make a
   * generator regression invisible until the matrix was regenerated.
   */
  const cellCount = (row: string): number =>
    row.trim().replace(/^\||\|$/g, '').replace(/\\\|/g, ' ').split('|').length;

  /** Every `|`-delimited line of the section introduced by `heading`. */
  const tableUnder = (md: string, heading: string): string[] => {
    const lines = md.split('\n');
    const start = lines.findIndex((l) => l.startsWith(heading));
    expect(start, `no section heading starting "${heading}"`).toBeGreaterThanOrEqual(0);
    const rows: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (/^\s*\|.*\|\s*$/.test(line)) rows.push(line);
      else if (rows.length > 0) break;
    }
    expect(rows.length, `no table under "${heading}"`).toBeGreaterThan(1);
    return rows;
  };

  /** Header count, then every non-separator row's count. */
  const shapeOf = (md: string, heading: string): { header: number; rows: number[] } => {
    const [header, ...rest] = tableUnder(md, heading);
    return {
      header: cellCount(header),
      rows: rest.filter((r) => !/^\s*\|[\s:|-]+\|\s*$/.test(r)).map(cellCount),
    };
  };

  it('counts a hand-built ragged row as ragged — the measure discriminates', () => {
    // Guard-the-guard. Without this, a `cellCount` that always returned the
    // header's value would make every case below pass on the pre-fix generator.
    const ragged = '# H\n\n| a | b | c |\n|---|---|---|\n| 1 | 2 | 3 | 4 |\n';
    expect(shapeOf(ragged, '# H')).toEqual({ header: 3, rows: [4] });
  });

  it('keeps a piped description inside ONE cell of the per-scenario table', () => {
    const description = '`cdkd local invoke|start-api|run-task` substitutes env|secret refs.';
    const md = renderMarkdown({
      knownScenarios: [{ tag: 'piped', description }],
      fixtures: [{ name: 'fa', annotated: true, scenarios: ['piped'] }],
      perScenarioCoverage: [{ scenario: 'piped', description, fixtures: ['fa'] }],
      orphanScenarios: [],
      unannotatedFixtures: [],
      invalidTagSites: [],
    });
    const { header, rows } = shapeOf(md, '## Per-scenario coverage');
    expect(header).toBe(3);
    expect(rows).toEqual([3]);
    // The pipes must be ESCAPED, not dropped: a `replace(/\|/g, '')` would
    // satisfy the cell count above while silently corrupting the text.
    expect(md).toContain('`cdkd local invoke\\|start-api\\|run-task`');
  });

  it('keeps a piped description inside ONE cell of the orphan table', () => {
    // The orphan table reads `KNOWN_SCENARIOS` directly rather than the
    // report's `description`, so it is a SEPARATE emit site — the first cut of
    // this fix escaped only the per-scenario one and this case is what would
    // have caught it. The tag is a real taxonomy entry whose real description
    // contains `invoke|start-api|run-task`.
    const tag = 'local-from-cfn-stack-substitution';
    expect(KNOWN_SCENARIOS[tag], `${tag} no longer carries a pipe — pick another`).toContain('|');
    const md = renderMarkdown({
      knownScenarios: [{ tag, description: KNOWN_SCENARIOS[tag] }],
      fixtures: [],
      perScenarioCoverage: [{ scenario: tag, description: KNOWN_SCENARIOS[tag], fixtures: [] }],
      orphanScenarios: [tag],
      unannotatedFixtures: [],
      invalidTagSites: [],
    });
    const { header, rows } = shapeOf(md, '## Orphan scenarios');
    expect(header).toBe(2);
    expect(rows).toEqual([2]);
  });

  it('leaves a pipe-free description untouched — no stray backslashes', () => {
    const md = renderMarkdown({
      knownScenarios: [{ tag: 'plain', description: 'No pipes here at all.' }],
      fixtures: [],
      perScenarioCoverage: [{ scenario: 'plain', description: 'No pipes here at all.', fixtures: [] }],
      orphanScenarios: [],
      unannotatedFixtures: [],
      invalidTagSites: [],
    });
    expect(md).toContain('| `plain` | No pipes here at all. | _(orphan)_ |');
    expect(md).not.toContain('\\|');
  });

  it('emits every checked-in taxonomy description as a well-shaped row', () => {
    // The population, not a sample: six of these carry a pipe today and the
    // count is not pinned here, so a seventh added later is covered for free.
    const tags = Object.keys(KNOWN_SCENARIOS).sort();
    expect(tags.length).toBeGreaterThan(20);
    const md = renderMarkdown({
      knownScenarios: tags.map((tag) => ({ tag, description: KNOWN_SCENARIOS[tag] })),
      fixtures: [],
      perScenarioCoverage: tags.map((tag) => ({
        scenario: tag,
        description: KNOWN_SCENARIOS[tag],
        fixtures: [],
      })),
      orphanScenarios: tags,
      unannotatedFixtures: [],
      invalidTagSites: [],
    });
    for (const heading of ['## Orphan scenarios', '## Per-scenario coverage']) {
      const { header, rows } = shapeOf(md, heading);
      expect(rows.filter((n) => n !== header), `${heading} emitted a ragged row`).toEqual([]);
      expect(rows).toHaveLength(tags.length);
    }
  });
});
