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
    expect(md).toContain('[`fa`](../tests/integration/fa/)');
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
    expect(md).toContain('- [`fa`](../tests/integration/fa/)');
  });
});
