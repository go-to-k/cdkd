/**
 * Fence for the tier-2 stateful-candidate derivation (issue #2553).
 *
 * `STATEFUL_TYPES` had two mechanical lower bounds before this one, and both
 * are derived from `src/provisioning/providers/**` — so both are structurally
 * blind to the tier-2 population, the types with no SDK provider whose
 * replacement routes through Cloud Control API. That population is 1371 types
 * against tier 1's 134, and it is the one issue #2514 was filed about.
 *
 * `scripts/audit-stateful-candidates.ts` proposes candidates out of it. This
 * file is what makes the proposal binding: every candidate must be either in
 * `STATEFUL_TYPES` or dispositioned in the script's `NOT_GUARDED` map, so a
 * tier-2 type that becomes a candidate in a future AWS schema revision reds
 * here instead of shipping unguarded.
 *
 * The suite reads the COMMITTED artifact rather than calling AWS: regeneration
 * issues a `DescribeType` per tier-2 type (see the script header), the same
 * reason `audit:coverage:regenerate` is not a CI step. What the suite adds over
 * the script's own `--check` is the checks a `--check` run cannot make about
 * ITSELF — that the self-probe corpus still discriminates, that each pure
 * function fails when it should, and that the task wiring exists.
 *
 * **Every `toEqual([])` here carries a companion case that makes the same
 * function return NON-empty.** Without one, `return []` is a surviving mutant
 * for the whole assertion — measured on this file's first revision, where
 * `floorViolations` and `staleNotGuardedEntries` could both be stubbed out with
 * the suite green.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';
import {
  FLOORS,
  NOT_GUARDED,
  SELF_PROBE_CASES,
  SIGNAL_BOUNDS,
  STATEFUL_SIGNALS,
  classifyCandidate,
  coerceRegistrySchema,
  deriveReport,
  describeSchemaWithRetry,
  floorViolations,
  lastTypeSegment,
  loadCachedReport,
  loadTier2,
  renderMarkdown,
  runSelfProbe,
  schemaCachePath,
  signalsFor,
  staleNotGuardedEntries,
  undispositioned,
  validateArgs,
  type RegistrySchema,
  type StatefulCandidateReport,
} from '../../../scripts/audit-stateful-candidates.ts';
import { STATEFUL_TYPES } from '../../../src/provisioning/stateful-types.js';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const REPORT_JSON = join(REPO_ROOT, 'docs/_generated/stateful-candidates.json');
const REPORT_MD = join(REPO_ROOT, 'docs/_generated/stateful-candidates.md');
const COVERAGE_JSON = join(REPO_ROOT, 'docs/_generated/provider-coverage.json');
const VITE_CONFIG = join(REPO_ROOT, 'vite.config.ts');
const CI_YML = join(REPO_ROOT, '.github/workflows/ci.yml');

const report: StatefulCandidateReport = loadCachedReport(REPORT_JSON);

/** A report clone with `mutate` applied — for the guard-the-guard cases. */
function mutated(mutate: (r: StatefulCandidateReport) => StatefulCandidateReport) {
  return mutate(JSON.parse(JSON.stringify(report)) as StatefulCandidateReport);
}

describe('the derivation still discriminates (self-probe)', () => {
  // The floors below catch a derivation that collapses toward ZERO. Nothing
  // there can catch one that collapses toward GREEN — a `classifyCandidate`
  // returning a candidate for every input produces LARGER counts, clearing
  // every floor. These cases are the only defence in that direction, which is
  // why the negatives outnumber the positives.
  it('every self-probe case gets its expected verdict', () => {
    expect(runSelfProbe()).toEqual([]);
  });

  it('the probe corpus carries both polarities, so it cannot pass vacuously', () => {
    const positives = SELF_PROBE_CASES.filter((c) => c.expected !== null);
    const negatives = SELF_PROBE_CASES.filter((c) => c.expected === null);
    // A corpus of positives alone is satisfied by `classifyCandidate` returning
    // a candidate unconditionally — the exact collapse it exists to catch.
    expect(negatives.length).toBeGreaterThanOrEqual(8);
    expect(positives.length).toBeGreaterThanOrEqual(6);
  });

  it('every signal has a positive probe case, so none can rot unnoticed', () => {
    // Without this, a signal whose pattern stopped matching anything would be
    // caught only by the real-corpus floor — which moves whenever AWS ships new
    // types, and is therefore the wrong instrument for "this rule is dead".
    const covered = new Set(SELF_PROBE_CASES.flatMap((c) => c.expected ?? []));
    expect([...STATEFUL_SIGNALS.map((s) => s.key)].filter((k) => !covered.has(k))).toEqual([]);
  });

  it('the corpus fences the ANCHORS, not just the alternatives', () => {
    // Measured on the first revision: stripping `^`/`$` from all six patterns
    // flipped ZERO of the then-13 verdicts, while the header called anchoring
    // load-bearing. These are the two shapes that make the claim falsifiable —
    // a property name CONTAINING a signal word, and a type name carrying a
    // store noun before its last segment. Asserted directly rather than left
    // to the corpus so a future edit cannot quietly drop them.
    expect(
      signalsFor('AWS::Probe::Widget', { properties: { MySnapshotWindowOverride: {} } })
    ).toEqual([]);
    expect(signalsFor('AWS::Probe::Widget', { properties: { SnapshotWindow: {} } })).toEqual([
      'snapshot-or-backup',
    ]);
    expect(signalsFor('AWS::Probe::TableViewer', {})).toEqual([]);
    expect(signalsFor('AWS::Probe::ThingTable', {})).toEqual(['data-store-noun']);
  });

  it('signalsFor reports EVERY firing signal, sorted', () => {
    // `.slice(0, 1)` and a dropped `.sort()` both survive a corpus of
    // single-signal cases; the real corpus has multi-signal candidates and
    // nothing else recomputes them.
    const many = signalsFor('AWS::Probe::ThingCluster', {
      properties: { SnapshotWindow: {}, AllocatedStorage: {}, RetentionPeriod: {} },
    });
    expect(many).toEqual([
      'data-store-noun',
      'retention-window',
      'snapshot-or-backup',
      'storage-capacity',
    ]);
    expect([...many]).toEqual([...many].sort());
  });

  it('the real corpus contains multi-signal candidates, so the sort is exercised there too', () => {
    expect(report.candidates.filter((c) => c.signals.length > 1).length).toBeGreaterThanOrEqual(10);
    for (const c of report.candidates) {
      expect(c.signals, `${c.typeName} signals are not sorted`).toEqual([...c.signals].sort());
    }
  });

  it('the two candidacy conditions are BOTH required — neither alone proposes', () => {
    // Stated as its own case rather than left to the corpus, because this is
    // the derivation's whole claim: a createOnly property without a signal is
    // not a candidate, and a signal without a createOnly property is not one
    // either. Dropping either half of the `&&` passes every other test here.
    const withSignalOnly = classifyCandidate(
      'AWS::Probe::Widget',
      { properties: { RetentionPeriod: {} } },
      new Set()
    );
    const withCreateOnlyOnly = classifyCandidate(
      'AWS::Probe::Widget',
      { createOnlyProperties: ['/properties/Name'], properties: { Name: {} } },
      new Set()
    );
    const withBoth = classifyCandidate(
      'AWS::Probe::Widget',
      { createOnlyProperties: ['/properties/Name'], properties: { RetentionPeriod: {} } },
      new Set()
    );
    expect(withSignalOnly).toBeUndefined();
    expect(withCreateOnlyOnly).toBeUndefined();
    expect(withBoth?.signals).toEqual(['retention-window']);
  });

  it('classifyCandidate reports the guard membership it was given', () => {
    // `guarded: false` is a surviving mutant against the committed report
    // alone, since nothing there recomputes it. Both polarities, so neither a
    // hardcoded `true` nor a hardcoded `false` passes.
    const schema: RegistrySchema = {
      createOnlyProperties: ['/properties/Name'],
      properties: { RetentionPeriod: {} },
    };
    expect(classifyCandidate('AWS::Probe::Widget', schema, new Set())?.guarded).toBe(false);
    expect(
      classifyCandidate('AWS::Probe::Widget', schema, new Set(['AWS::Probe::Widget']))?.guarded
    ).toBe(true);
  });

  it('signals bind to the LOOKUP name, never to the schema document', () => {
    // The type name the guard list would have to contain is the one the tier-2
    // walk looked the schema up BY. A cache entry whose own `typeName` says
    // otherwise must not be able to move a name-scoped signal onto a different
    // type — and it is a shape a hand-edited or half-written cache produces.
    expect(signalsFor('AWS::Probe::Thing', { typeName: 'AWS::Probe::ThingVault' })).toEqual([]);
    expect(signalsFor('AWS::Probe::ThingVault', { typeName: 'AWS::Probe::Thing' })).toEqual([
      'data-store-noun',
    ]);
    expect(lastTypeSegment('AWS::Probe::ThingVault')).toBe('ThingVault');
    expect(lastTypeSegment('NoSeparators')).toBe('NoSeparators');
  });
});

describe('the pure derivation functions', () => {
  // The whole derivation path (`deriveReport`, `renderMarkdown`, `loadTier2`,
  // the retry) was unexecuted by CI on the first revision — `.cache/` is
  // gitignored, so only the committed OUTPUT was read. These drive the code.
  const schemas: Record<string, RegistrySchema> = {
    'AWS::Probe::AlphaCluster': {
      createOnlyProperties: ['/properties/Name'],
      properties: { Name: {}, AllocatedStorage: {} },
    },
    'AWS::Probe::Widget': { createOnlyProperties: ['/properties/Name'], properties: { Name: {} } },
    'AWS::Probe::Bare': { properties: { RetentionPeriod: {} } },
  };
  const read = (t: string): RegistrySchema | undefined => schemas[t];
  const tier2 = ['AWS::Probe::AlphaCluster', 'AWS::Probe::Widget', 'AWS::Probe::Bare', 'AWS::Probe::Missing'];

  it('deriveReport counts read / unreadable / createOnly / candidates separately', () => {
    const r = deriveReport(tier2, read, new Set(['AWS::Probe::AlphaCluster']));
    expect(r.summary.tier2Count).toBe(4);
    expect(r.summary.schemasRead).toBe(3);
    expect(r.unreadable).toEqual(['AWS::Probe::Missing']);
    expect(r.summary.withCreateOnly).toBe(2);
    expect(r.summary.candidateCount).toBe(1);
    expect(r.summary.guardedCount).toBe(1);
    expect(r.summary.unguardedCount).toBe(0);
    expect(r.candidates.map((c) => c.typeName)).toEqual(['AWS::Probe::AlphaCluster']);
    expect(r.summary.signalCounts['storage-capacity']).toBe(1);
    expect(r.summary.signalCounts['retention-window']).toBe(0);
  });

  it('deriveReport keeps an UNREAD schema out of every verdict, not in the cleared pile', () => {
    // A `DescribeType` that never answered has not cleared the type. The two
    // are only distinguishable because `unreadable` is its own list.
    const r = deriveReport(['AWS::Probe::Missing'], () => undefined);
    expect(r.summary.schemasRead).toBe(0);
    expect(r.summary.candidateCount).toBe(0);
    expect(r.unreadable).toEqual(['AWS::Probe::Missing']);
    expect(floorViolations(r).length).toBeGreaterThan(0);
  });

  it('deriveReport counts a schema that parses but declares nothing', () => {
    // The shape a truncated cache file takes: it parses, so it is READ, and it
    // proposes nothing — indistinguishable from an honest clear without this
    // counter. Its ceiling is 0.
    const r = deriveReport(['AWS::Probe::Empty'], () => ({}));
    expect(r.summary.schemasRead).toBe(1);
    expect(r.summary.schemasWithNoProperties).toBe(1);
    expect(floorViolations(r).some((v) => v.includes('no top-level properties'))).toBe(true);
  });

  it('deriveReport sorts candidates and unreadable for a diff-stable artifact', () => {
    const r = deriveReport(
      ['AWS::Probe::ZuluCluster', 'AWS::Probe::AlphaCluster', 'AWS::Zzz::Gone', 'AWS::Aaa::Gone'],
      (t) =>
        t.endsWith('Cluster')
          ? { createOnlyProperties: ['/properties/Name'], properties: { AllocatedStorage: {} } }
          : undefined
    );
    expect(r.candidates.map((c) => c.typeName)).toEqual([
      'AWS::Probe::AlphaCluster',
      'AWS::Probe::ZuluCluster',
    ]);
    expect(r.unreadable).toEqual(['AWS::Aaa::Gone', 'AWS::Zzz::Gone']);
  });

  it('coerceRegistrySchema refuses the shapes that would manufacture a candidate', () => {
    // A cached `createOnlyProperties` that is a STRING spreads character by
    // character, producing a non-empty createOnly list out of a malformed
    // document. Each refusal is paired with the accepted twin, so a
    // `return undefined` stub fails too.
    expect(coerceRegistrySchema({ createOnlyProperties: '/properties/Name' })).toBeUndefined();
    expect(coerceRegistrySchema({ createOnlyProperties: [1, 2] })).toBeUndefined();
    expect(coerceRegistrySchema({ properties: ['Name'] })).toBeUndefined();
    expect(coerceRegistrySchema({ typeName: 42 })).toBeUndefined();
    expect(coerceRegistrySchema([])).toBeUndefined();
    expect(coerceRegistrySchema(null)).toBeUndefined();
    expect(coerceRegistrySchema('{}')).toBeUndefined();
    expect(coerceRegistrySchema({})).toEqual({});
    expect(
      coerceRegistrySchema({ typeName: 'AWS::Probe::Widget', createOnlyProperties: ['/x'], properties: { A: {} } })
    ).toEqual({ typeName: 'AWS::Probe::Widget', createOnlyProperties: ['/x'], properties: { A: {} } });
  });

  it('loadTier2 dedupes and refuses an empty list', () => {
    // The dedupe is not hygiene: `provider-coverage.json` carries
    // `AWS::Logs::LogStream` twice (issue #2571), so without it that type would
    // be described twice and counted twice.
    const real = loadTier2(COVERAGE_JSON);
    expect(real.length).toBe(new Set(real).size);
    expect(real).toContain('AWS::Logs::LogStream');
    const raw = JSON.parse(readFileSync(COVERAGE_JSON, 'utf8')) as { tier2: string[] };
    expect(raw.tier2.length).toBeGreaterThan(real.length);
    expect(() => loadTier2(REPORT_JSON)).toThrow(/No tier2 entries/);
  });

  it('loadCachedReport refuses a schemaVersion it does not understand', () => {
    // The guard exists so an OLD cdkd cannot read a NEWER report's fields as
    // if they meant what they used to. Written to a temp file rather than a
    // committed fixture: the only thing under test is the version compare.
    const dir = mkdtempSync(join(tmpdir(), 'stateful-candidates-'));
    const future = join(dir, 'future.json');
    writeFileSync(future, JSON.stringify({ ...report, schemaVersion: 99 }));
    expect(() => loadCachedReport(future)).toThrow(/schema version 99/);
    const current = join(dir, 'current.json');
    writeFileSync(current, JSON.stringify(report));
    expect(loadCachedReport(current).summary.candidateCount).toBe(report.summary.candidateCount);
  });

  it('schemaCachePath is filename-safe and matches the fetcher', () => {
    expect(schemaCachePath('AWS::Backup::BackupVault', '/tmp/x')).toBe(
      '/tmp/x/AWS-Backup-BackupVault.json'
    );
  });

  it('describeSchemaWithRetry retries throttles and rethrows everything else', async () => {
    const slept: number[] = [];
    let calls = 0;
    const throttling = Object.assign(new Error('slow down'), { name: 'ThrottlingException' });
    const client = {
      send: async () => {
        calls++;
        if (calls < 3) throw throttling;
        return { Schema: '{"typeName":"AWS::Probe::Widget"}' };
      },
    };
    const schema = await describeSchemaWithRetry(client, 'AWS::Probe::Widget', {
      retryDelaysMs: [1, 2, 3],
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(schema).toBe('{"typeName":"AWS::Probe::Widget"}');
    expect(slept).toEqual([1, 2]);

    const denied = Object.assign(new Error('AccessDenied'), { name: 'AccessDeniedException' });
    await expect(
      describeSchemaWithRetry(
        { send: async () => { throw denied; } },
        'AWS::Probe::Widget',
        { retryDelaysMs: [1], sleep: async () => {} }
      )
    ).rejects.toThrow('AccessDenied');
  });

  it('renderMarkdown carries the summary, the signals and every candidate', () => {
    const r = deriveReport(tier2, read, new Set(['AWS::Probe::AlphaCluster']));
    const md = renderMarkdown(r);
    expect(md).toContain('| Tier-2 types considered | 4 |');
    expect(md).toContain('| Schemas unreadable (excluded, NOT cleared) | 1 |');
    expect(md).toContain('`AWS::Probe::AlphaCluster`');
    expect(md).toContain('`AWS::Probe::Missing`');
    for (const signal of STATEFUL_SIGNALS) {
      expect(md).toContain(`\`${signal.key}\``);
    }
  });

  it('validateArgs refuses a typo, two modes, and a dangling --refetch', () => {
    // The defect this closes: a `--chekc` typo in the vite task or the ci.yml
    // step fell through to the SUMMARY path and exited 0, making the critic a
    // no-op that reports success — measured, and the same shape the sibling
    // critics were hardened against.
    expect(validateArgs(['--chekc'])).toMatch(/unknown argument/);
    expect(validateArgs(['--check', 'stateful'])).toMatch(/unknown argument/);
    expect(validateArgs(['--check', '--rederive'])).toMatch(/at most one mode/);
    expect(validateArgs(['--refetch'])).toMatch(/only meaningful with --regenerate/);
    expect(validateArgs([])).toBeUndefined();
    expect(validateArgs(['--check'])).toBeUndefined();
    expect(validateArgs(['--regenerate', '--refetch'])).toBeUndefined();
    expect(validateArgs(['--help'])).toBeUndefined();
  });
});

describe('the committed artifact is a real derivation', () => {
  it('clears every floor and signal bound', () => {
    expect(floorViolations(report)).toEqual([]);
  });

  it('floorViolations actually reports — each arm fails on its own mutation', () => {
    // Guard-the-guard. `toEqual([])` above is satisfied by `return []`, and on
    // this file's first revision every one of these arms could be deleted
    // independently with the suite green.
    const cases: Array<[string, (r: StatefulCandidateReport) => StatefulCandidateReport, RegExp]> = [
      [
        'a truncated candidates array with the summary left alone',
        (r) => ({ ...r, candidates: r.candidates.slice(0, 5) }),
        /disagrees with the 5 candidate\(s\)/,
      ],
      [
        'a guarded/unguarded split that disagrees with the flags',
        (r) => ({ ...r, summary: { ...r.summary, guardedCount: 0, unguardedCount: r.candidates.length } }),
        /disagrees with the candidates' own flags/,
      ],
      [
        'a type neither read nor listed unreadable',
        (r) => ({ ...r, summary: { ...r.summary, schemasRead: r.summary.schemasRead - 3 } }),
        /has been dropped silently/,
      ],
      [
        'a tier2 count under the floor',
        (r) => ({ ...r, summary: { ...r.summary, tier2Count: 10, schemasRead: 10 } }),
        /tier2Count 10 is below the floor/,
      ],
      [
        'a schema that parsed but declares nothing',
        (r) => ({ ...r, summary: { ...r.summary, schemasWithNoProperties: 4 } }),
        /no top-level properties/,
      ],
      [
        'a signal that fires on nothing',
        (r) => ({
          ...r,
          summary: { ...r.summary, signalCounts: { ...r.summary.signalCounts, 'retention-window': 0 } },
        }),
        /disposes of nothing and is inert/,
      ],
      [
        'a signal that fires on everything',
        (r) => ({
          ...r,
          summary: {
            ...r.summary,
            signalCounts: { ...r.summary.signalCounts, 'data-store-noun': r.summary.withCreateOnly },
          },
        }),
        /over the ceiling/,
      ],
    ];
    for (const [label, mutate, needle] of cases) {
      const violations = floorViolations(mutated(mutate));
      expect(violations.join('\n'), `no violation reported for: ${label}`).toMatch(needle);
    }
  });

  it('the floors and bounds are the measured literals', () => {
    // Pinned so a future edit that lowers a floor to make a broken run pass is
    // a visible diff here rather than a silent one in the script.
    expect(FLOORS).toEqual({
      tier2: 1000,
      schemasRead: 1000,
      withCreateOnly: 700,
      candidates: 30,
      maxSchemasWithNoProperties: 0,
    });
    expect(SIGNAL_BOUNDS).toEqual({ minCandidatesPerSignal: 1, maxShareOfCreateOnlyTypes: 0.15 });
  });

  it('the REAL magnitudes are pinned, not only the slack floors', () => {
    // The floors carry deliberate slack (1000 against 1371), so a
    // `provider-coverage.json` that lost 300 tier-2 types clears them. These
    // bands are narrow enough to notice that and wide enough to survive AWS
    // shipping new types between regenerations — the same split the sibling
    // critic `check-local-reachability.ts` uses.
    expect(report.summary.tier2Count).toBeGreaterThanOrEqual(1300);
    expect(report.summary.tier2Count).toBeLessThanOrEqual(1500);
    expect(report.summary.withCreateOnly).toBeGreaterThanOrEqual(1100);
    expect(report.summary.candidateCount).toBeGreaterThanOrEqual(85);
    expect(report.summary.candidateCount).toBeLessThanOrEqual(140);
    // Per signal, so one signal collapsing cannot hide behind the others.
    expect(report.summary.signalCounts['data-store-noun']).toBeGreaterThanOrEqual(50);
    expect(report.summary.signalCounts['snapshot-or-backup']).toBeGreaterThanOrEqual(6);
    expect(report.summary.signalCounts['retention-window']).toBeGreaterThanOrEqual(6);
    expect(report.summary.signalCounts['storage-capacity']).toBeGreaterThanOrEqual(9);
    expect(report.summary.signalCounts['deletion-protection']).toBeGreaterThanOrEqual(7);
    expect(report.summary.signalCounts['encryption-at-rest']).toBeGreaterThanOrEqual(9);
  });

  it('every tier-2 schema was read — an unread schema is not a cleared one', () => {
    expect(report.unreadable).toEqual([]);
    expect(report.summary.schemasRead).toBe(report.summary.tier2Count);
    expect(report.summary.schemasWithNoProperties).toBe(0);
  });

  it('the derivation covered the tier-2 list the coverage cache actually holds', () => {
    // `schemasRead === tier2Count` above is same-run confluence: both come from
    // the walk. This is the independent anchor — the report must describe the
    // CURRENT `provider-coverage.json`, so a regeneration of that file without
    // one of this artifact is visible.
    expect(report.summary.tier2Count).toBe(loadTier2(COVERAGE_JSON).length);
    const tier2 = new Set(loadTier2(COVERAGE_JSON));
    expect(report.candidates.filter((c) => !tier2.has(c.typeName)).map((c) => c.typeName)).toEqual(
      []
    );
  });

  it('the markdown review queue agrees with the json in every published field', () => {
    // Containment alone let a stale `.md` pass with extra rows, a wrong
    // guarded column and five of the seven summary rows disagreeing.
    const md = readFileSync(REPORT_MD, 'utf8');
    const s = report.summary;
    for (const row of [
      `| Tier-2 types considered | ${s.tier2Count} |`,
      `| Registry schemas read | ${s.schemasRead} |`,
      `| ...of which declare a createOnly property | ${s.withCreateOnly} |`,
      `| Schemas declaring no top-level properties | ${s.schemasWithNoProperties} |`,
      `| ...and fire a data-bearing signal (**candidates**) | ${s.candidateCount} |`,
      `| Candidates already guarded | ${s.guardedCount} |`,
      `| Candidates not guarded | ${s.unguardedCount} |`,
      `| Schemas unreadable (excluded, NOT cleared) | ${report.unreadable.length} |`,
    ]) {
      expect(md, `stale docs/_generated/stateful-candidates.md — missing row: ${row}`).toContain(
        row
      );
    }
    // Row-for-row equality, both directions, INCLUDING the guarded column.
    const mdRows = [...md.matchAll(/^\| `(AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)` \| (yes|\*\*no\*\*) \|/gm)];
    expect(mdRows.map((m) => m[1]).sort()).toEqual(
      report.candidates.map((c) => c.typeName).sort()
    );
    for (const m of mdRows) {
      const candidate = report.candidates.find((c) => c.typeName === m[1]);
      expect(m[2], `${m[1]} guarded column disagrees with the json`).toBe(
        candidate?.guarded ? 'yes' : '**no**'
      );
    }
  });
});

describe('every candidate is dispositioned', () => {
  it('none is both unguarded and unexplained', () => {
    const missing = undispositioned(report, STATEFUL_TYPES, NOT_GUARDED);
    expect(
      missing,
      'a tier-2 type the derivation proposes must be added to STATEFUL_TYPES or given a ' +
        "reason in the script's NOT_GUARDED map — a rename of one of these destroys data on a " +
        'plain `cdkd deploy`, with no flag and no prompt'
    ).toEqual([]);
  });

  it('no NOT_GUARDED entry has gone inert', () => {
    // The other direction, and the one nothing else watches: an entry whose
    // type stopped being proposed disposes of nothing, and would silently
    // absorb a future type of the same name.
    expect(staleNotGuardedEntries(report, NOT_GUARDED)).toEqual([]);
  });

  it('staleNotGuardedEntries actually reports — the empty result is not a stub', () => {
    // Companion to the `toEqual([])` above, which `return []` satisfies.
    const withBogus = new Map([...NOT_GUARDED, ['AWS::Probe::NeverProposed', 'x'.repeat(50)]]);
    expect(staleNotGuardedEntries(report, withBogus)).toEqual(['AWS::Probe::NeverProposed']);
    // ...and an entry that IS proposed is not reported, so it is not a
    // constant-true either.
    const guardedOne = report.candidates[0]!.typeName;
    expect(staleNotGuardedEntries(report, new Map([[guardedOne, 'x'.repeat(50)]]))).toEqual([]);
  });

  it('the disposition check discriminates — it is not passing on an empty candidate set', () => {
    // Guard-the-guard. `undispositioned` returning [] holds trivially against a
    // report with no candidates or a guard list containing everything.
    const guarded = report.candidates.filter((c) => c.guarded);
    expect(guarded.length).toBeGreaterThan(0);
    const victim = guarded[0]!.typeName;
    const withoutVictim = new Set([...STATEFUL_TYPES].filter((t) => t !== victim));
    expect(undispositioned(report, withoutVictim, NOT_GUARDED)).toEqual([victim]);
  });

  it("the report's guarded flags agree with the guard list as it stands now", () => {
    // Independent recompute: the committed flags come from the regeneration, so
    // a guard entry added or removed WITHOUT a re-derive is invisible to every
    // other assertion here.
    const flagged = report.candidates.filter((c) => c.guarded).map((c) => c.typeName);
    const actual = report.candidates
      .map((c) => c.typeName)
      .filter((t) => STATEFUL_TYPES.has(t));
    expect(flagged.sort()).toEqual(actual.sort());
  });

  it('every NOT_GUARDED reason is a real argument, not a marker', () => {
    // The escape hatch is a decision, so it carries the argument the same way a
    // STATEFUL_TYPES entry does. A bare or one-word reason is a suppression
    // wearing a disposition's clothes.
    expect(NOT_GUARDED.size).toBeGreaterThanOrEqual(20);
    for (const [type, reason] of NOT_GUARDED) {
      expect(reason.length, `NOT_GUARDED entry for ${type} needs a real reason`).toBeGreaterThan(
        40
      );
      // Each reason must name which of the three write-off arms it rests on,
      // so an entry cannot be prose that decides nothing.
      expect(reason, `NOT_GUARDED entry for ${type} names no write-off arm`).toMatch(
        /^\((a|b|c)\)/
      );
    }
  });
});

describe('the types issue #2553 names are guarded', () => {
  // The issue's own sample, asserted by name. The derivation is the deliverable
  // and these are its acceptance: each holds user data a DELETE + CREATE does
  // not migrate, none has an SDK provider, and each is reachable by a plain
  // `cdkd deploy` rename through `create-only-properties.ts`'s schema fallback.
  const NAMED = [
    'AWS::MemoryDB::Cluster',
    'AWS::MSK::Cluster',
    'AWS::Timestream::Database',
    'AWS::Timestream::Table',
    'AWS::Backup::BackupVault',
    'AWS::DocDBElastic::Cluster',
    'AWS::OpenSearchServerless::Collection',
  ] as const;

  it.each(NAMED)('%s is on the guard list', (type) => {
    expect(STATEFUL_TYPES.has(type)).toBe(true);
  });

  it.each(NAMED)('%s is proposed by the derivation, not only hand-added', (type) => {
    // Membership alone would also hold for a type someone typed in. What makes
    // the widening checkable is that the derivation independently reaches each
    // of them from the registry schema.
    const candidate = report.candidates.find((c) => c.typeName === type);
    expect(candidate, `${type} is not in the derived candidate set`).toBeDefined();
    expect(candidate!.signals.length).toBeGreaterThan(0);
    expect(candidate!.createOnlyProperties.length).toBeGreaterThan(0);
  });

  it('AWS::Backup::BackupVault is reached ONLY by the name-scoped signal', () => {
    // The measured blind spot that justifies `data-store-noun` existing: every
    // property on the vault is a pointer or a setting, and the recovery points
    // appear nowhere in the schema. If a property signal ever starts firing on
    // it, the justification in the script header needs rewriting.
    const vault = report.candidates.find((c) => c.typeName === 'AWS::Backup::BackupVault');
    expect(vault?.signals).toEqual(['data-store-noun']);
  });
});

describe('the derivation is wired into the toolchain', () => {
  it('vite.config.ts declares the four tasks with the right command', () => {
    const config = readFileSync(VITE_CONFIG, 'utf8');
    // The COMMAND, not just the key: a task named `:check` whose command lost
    // the `--check` flag would run the summary reader and exit 0.
    for (const [task, flag] of [
      ['audit:stateful-candidates', ''],
      ['audit:stateful-candidates:regenerate', ' --regenerate'],
      ['audit:stateful-candidates:rederive', ' --rederive'],
      ['audit:stateful-candidates:check', ' --check'],
    ] as const) {
      const block = new RegExp(
        `'${task.replace(/:/g, ':')}': \\{\\s*\\n\\s*command: 'node scripts/audit-stateful-candidates\\.ts${flag}',`
      );
      expect(config, `vite.config.ts must declare \`${task}\` running \`...${flag}\``).toMatch(
        block
      );
    }
  });

  it('ci.yml runs the offline check', () => {
    // Without this the fence is a unit test only, and the failure it exists to
    // produce arrives one layer further from the person who caused it.
    expect(readFileSync(CI_YML, 'utf8')).toContain('vp run audit:stateful-candidates:check');
  });

  it('the regeneration is NOT in gen:all-matrices', () => {
    // It needs AWS credentials and issues a DescribeType per tier-2 type, so
    // pulling it into the aggregate would make the pre-push step unrunnable —
    // the same reason `audit:coverage:regenerate` is excluded. Asserted rather
    // than left to convention because `matrix-regen-coverage.test.ts` pushes in
    // the opposite direction for anything CI diffs.
    const config = readFileSync(VITE_CONFIG, 'utf8');
    const block = /'gen:all-matrices':\s*\{[\s\S]*?\n {6}\},/.exec(config);
    expect(block).not.toBeNull();
    expect(block![0]).not.toContain('stateful-candidates');
  });
});
