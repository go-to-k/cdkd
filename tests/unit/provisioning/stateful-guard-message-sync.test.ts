/**
 * Pins the `backup` integ fixture's needles against the strings cdkd actually
 * emits (issue #2553). The last `describe` does the same for
 * `healthimaging-stateful-update-fallback` (issue #2515).
 *
 * The fixture's Phase 1b measures the stateful guard by GREPPING the deploy's
 * output, which makes it a CONSUMER of wording this very repo changes. When the
 * producer moves, a zero match is indistinguishable from "the condition did not
 * occur" — `.claude/rules/testing.md`, "A fixture that greps cdkd's OWN output
 * must fail loudly when the format drifts". The fixture carries its own
 * sentinels for the runtime half; this file is the compile-time half, and it
 * exists because three review rounds in a row found a defect in a HAND-WRITTEN
 * needle. The instrument changes here: the needles are derived from the source
 * that emits them rather than from a remembered log line.
 *
 * Each case pins BOTH sides — the emitting source still contains the template,
 * and the fixture still greps it — so a reword reds here naming the pair to
 * update, instead of silently blinding the integ. The one exception is the
 * `renderStatefulReason` case: the fixture does not grep the reason text
 * directly, but the refusal INTERPOLATES it between two needles the fixture
 * does grep, so a reword there changes the observed line while the guard is
 * unchanged. That case is deliberately source-only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { CREATE_ONLY_PATHS_SNAPSHOT } from '../../../src/provisioning/create-only-snapshot.generated.js';
import { STATEFUL_TYPES } from '../../../src/provisioning/stateful-types.js';
import { hasNoCloudControlHandlers } from '../../../src/provisioning/unsupported-types.js';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const DEPLOY_ENGINE = readFileSync(join(REPO_ROOT, 'src/deployment/deploy-engine.ts'), 'utf8');
const STATEFUL_TYPES_SRC = readFileSync(
  join(REPO_ROOT, 'src/provisioning/stateful-types.ts'),
  'utf8'
);
const VERIFY_SH = readFileSync(
  join(REPO_ROOT, 'tests/integration/backup/verify.sh'),
  'utf8'
);

describe('the backup fixture greps strings cdkd still emits (#2553)', () => {
  it('the per-resource failure line is still `Failed to <op> <LogicalId>`', () => {
    // The fixture's second sentinel matches `Failed to (update|create|delete)
    // Vault`. That line is built from ONE template covering every change type,
    // so a rename of the template — or moving the logical id off the front of
    // the message — blinds the sentinel.
    expect(
      DEPLOY_ENGINE,
      'deploy-engine.ts no longer builds the per-resource failure line as ' +
        '`Failed to ${change.changeType.toLowerCase()} ${logicalId}` — update the ' +
        "sentinel in tests/integration/backup/verify.sh's Phase 1b"
    ).toContain('`Failed to ${change.changeType.toLowerCase()} ${logicalId}:');
    expect(VERIFY_SH).toContain("grep -qE 'Failed to (update|create|delete) Vault'");
  });

  it('the deploy still announces the stack with `Deploying stack:`', () => {
    // Phase 1b's FIRST sentinel keys on this to tell a failure that never
    // reached the stack from one the guard should have refused. Unpinned it
    // drifts into a permanent false FAIL — the safe direction, but a loud one.
    expect(
      readFileSync(join(REPO_ROOT, 'src/cli/commands/deploy.ts'), 'utf8'),
      "deploy.ts no longer prints `Deploying stack:` — update the first sentinel in " +
        "tests/integration/backup/verify.sh's Phase 1b"
    ).toContain("cyan('Deploying stack:')");
    expect(VERIFY_SH).toContain("grep -q 'Deploying stack:'");
  });

  it('the property-driven guard still says `requires replacement (immutable property changed:`', () => {
    // This is the marker Phase 1b PARSES, and it is deliberately narrower than
    // the phrase the two guard sites share: it belongs to the pre-flight
    // property-driven arm only, so the fixture cannot be satisfied by the
    // update-failure fallback reaching the same refusal.
    expect(
      DEPLOY_ENGINE,
      'the property-driven stateful guard reworded its refusal — update the ' +
        "GUARD_LINE needle in tests/integration/backup/verify.sh's Phase 1b"
    ).toContain('requires replacement (immutable property changed: ');
    expect(VERIFY_SH).toContain("grep -m1 'requires replacement (immutable property changed:'");
  });

  it('both guard sites still share `but it is a stateful resource`', () => {
    // The fixture's drift arm keys on the SHARED phrase: a run where this
    // appears but the narrower marker does not means the wording moved, not
    // that the guard is gone. That distinction only works while both sites
    // carry it.
    const occurrences = DEPLOY_ENGINE.split('but it is a stateful resource').length - 1;
    expect(
      occurrences,
      'the shared stateful-refusal phrase no longer appears at BOTH guard sites; ' +
        "the backup fixture's wording-drift arm keys on it"
    ).toBeGreaterThanOrEqual(2);
    expect(VERIFY_SH).toContain("grep -q 'but it is a stateful resource'");
  });

  it('the refusal still names the opt-in flag the fixture asserts and then uses', () => {
    // Scoped to the property-driven refusal's OWN template. A whole-file
    // `toContain` passes for the wrong reason — the flag is named in five
    // comments in this file, so renaming it inside the message left every case
    // green (measured). The slice runs from the marker the fixture parses to
    // the end of that template literal.
    const marker = 'requires replacement (immutable property changed: ';
    const start = DEPLOY_ENGINE.indexOf(marker);
    expect(start, 'the property-driven refusal template moved').toBeGreaterThan(0);
    // Bounded by the error CODE that closes the same `new CdkdError(...)`
    // rather than by a character count: a magic window leaves a tail the flag
    // name could reappear in, and grows into a false RED if the template does.
    const end = DEPLOY_ENGINE.indexOf("'STATEFUL_REPLACE_BLOCKED'", start);
    expect(end, 'the refusal no longer closes with STATEFUL_REPLACE_BLOCKED').toBeGreaterThan(
      start
    );
    const refusal = DEPLOY_ENGINE.slice(start, end);
    expect(
      refusal,
      'the property-driven refusal no longer names --force-stateful-recreation — the ' +
        'fixture asserts that flag in the refusal AND then passes it in Phase 1c'
    ).toContain('--force-stateful-recreation');
    expect(VERIFY_SH).toContain("'force-stateful-recreation'");
    // Phase 1c actually PASSES the flag — the credit `cli-flag-coverage` gives
    // this fixture must rest on a real invocation, not on the failure message.
    expect(VERIFY_SH).toMatch(/\n\s+--force-stateful-recreation\n/);
  });

  it('the reason text the refusal interpolates is still the `always` one (source side only)', () => {
    // `renderStatefulReason('always')` supplies the tail of the line Phase 1b
    // reads. A reword there changes the fixture's observed output even though
    // the guard is unchanged.
    expect(STATEFUL_TYPES_SRC).toContain("return 'destroy loses all data in the resource';");
  });

  it('the fixture still renames a property the schema marks createOnly', () => {
    // The arm is vacuous if the renamed property stops driving a replacement.
    // `BackupVaultName` is `AWS::Backup::BackupVault`'s createOnly identity
    // property, recorded per candidate in the generated artifact.
    const report = JSON.parse(
      readFileSync(join(REPO_ROOT, 'docs/_generated/stateful-candidates.json'), 'utf8')
    ) as { candidates: Array<{ typeName: string; createOnlyProperties: string[] }> };
    const vault = report.candidates.find((c) => c.typeName === 'AWS::Backup::BackupVault');
    expect(vault?.createOnlyProperties).toContain('/properties/BackupVaultName');
    expect(VERIFY_SH).toContain("'BackupVaultName'");
  });
});

/**
 * The second half of the same problem, and the half nothing watched: a reword
 * that makes a needle LESS SPECIFIC.
 *
 * Issue #2615 hedged `renderStatefulReason('has-objects')` to "S3 bucket is not
 * provably empty", handing the bucket the phrase its log-group sibling had
 * carried alone. `loggroup-never-expire-guard/verify.sh` grepped the bare
 * `not provably empty`, so its sentinel went on MATCHING and stopped
 * DISCRIMINATING — a failure no re-run of the fixture can surface, because
 * every phase stays green. Review caught it; go-to-k/cdkd#2627 re-anchored
 * both fixtures on the full sentence.
 *
 * WHAT THIS FENCE COVERS, stated narrowly on purpose. Three review rounds each
 * found a hole in the previous round's wider version — a population derived by
 * scanning every `verify.sh` looked general and was fail-OPEN (a fixture whose
 * ONLY needle is the blunt phrase quotes no full reason, so it never entered
 * the population and was never scanned: exactly the pre-go-to-k/cdkd#2627
 * state of the fixture this exists for). Three rounds inside one mechanism is
 * the signal to change instrument, not to widen again. So the fixture side is
 * PINNED, and the honest scope is:
 *
 *   covered — a pinned fixture re-anchored onto the wrong reason; a pinned
 *     fixture that ADDS a blunt literal needle beside its good one; a reword
 *     that makes two reasons share a phrase; a reason that stops being
 *     rendered at all;
 *   NOT covered — a NEW fixture nobody adds here, a regex or whitespace-variant
 *     needle (`grep -qE "not provably.*empty"`), and a reason literal extended
 *     so an existing one becomes a strict substring of it. All three measured
 *     green against the wider version too, which is why widening was not the
 *     answer. Tracked as issue go-to-k/cdkd#2643.
 *
 * The REASON side stays derived — the literals and the phrases two of them
 * share are computed from the source, so a third hedged reason is caught
 * without editing this file.
 */
const REASON_LITERALS: readonly string[] = (() => {
  const start = STATEFUL_TYPES_SRC.indexOf('export function renderStatefulReason');
  // Bounded by the function's own closing brace rather than by a character
  // window: the file's other `return '...'` literals (the sync predicates')
  // would otherwise join the population and make the counts meaningless.
  const end = STATEFUL_TYPES_SRC.indexOf('\n}', start);
  return [...STATEFUL_TYPES_SRC.slice(start, end).matchAll(/return '([^']*)';/g)].map((m) => m[1]!);
})();

const STOP_WORDS = new Set(['a', 'in', 'is', 'it', 'not', 'of', 'the', 'to']);

/**
 * The blunt-needle population: every fragment of a phrase that two DISTINCT
 * reason literals share SUBSTANTIALLY.
 *
 * Derived per PAIR, which is what makes it usable. Take each pair's longest
 * common word-run; keep the pair only if that run is three words or more; then
 * every sub-gram of it from two words up is a needle that cannot identify one
 * reason. Today: `has-objects` / `has-log-events` share `is not provably
 * empty`, so `provably empty` and `not provably empty` are both in — and
 * `provably empty` is the sharpest of them, the two-word phrase a hand-written
 * sentinel actually reaches for.
 *
 * The three-word gate on the PAIR is the part that had to be measured rather
 * than guessed. `has-retention` / `has-log-events` share only `log group`,
 * which is a noun every log-group fixture writes in prose — admitting it made
 * `loggroup-never-expire-guard` fail on a sentence with no sentinel in it at
 * all. A pair that shares nothing longer than a noun phrase cannot produce a
 * blunt sentinel; a pair sharing a whole predicate can.
 */
const SHARED_PHRASES: readonly string[] = (() => {
  const runs = (lit: string, n: number): Set<string> => {
    const words = lit.split(' ');
    const out = new Set<string>();
    for (let i = 0; i + n <= words.length; i += 1) out.add(words.slice(i, i + n).join(' '));
    return out;
  };
  const longestShared = (a: string, b: string): string => {
    const max = Math.min(a.split(' ').length, b.split(' ').length);
    for (let n = max; n >= 1; n -= 1) {
      const inB = runs(b, n);
      for (const g of runs(a, n)) if (inB.has(g)) return g;
    }
    return '';
  };
  const out = new Set<string>();
  for (let i = 0; i < REASON_LITERALS.length; i += 1) {
    for (let j = i + 1; j < REASON_LITERALS.length; j += 1) {
      const longest = longestShared(REASON_LITERALS[i]!, REASON_LITERALS[j]!);
      const words = longest.split(' ');
      if (words.length < 3) continue;
      for (let n = 2; n <= words.length; n += 1) for (const g of runs(longest, n)) out.add(g);
    }
  }
  // Stop-word-only fragments (`is not`) are noise from inside an otherwise
  // dangerous phrase; everything else stays, maximal and sub-gram alike.
  return [...out].filter((g) => !g.split(' ').every((w) => STOP_WORDS.has(w)));
})();

/**
 * The fixtures whose sentinels quote a reason, and the reason each is ABOUT.
 *
 * PINNED rather than discovered, per the scope note above. The cost is that a
 * new fixture must be added here; the benefit is that the scan below has a
 * population it cannot silently fail to include, and that re-anchoring reds
 * naming the pair to update.
 */
const PINNED_FIXTURES: ReadonlyArray<readonly [string, string]> = [
  ['loggroup-never-expire-guard', 'log group is not provably empty'],
  ['recreate-via-cc-api', 'S3 bucket is not provably empty'],
];

const fixtureText = (name: string): string => {
  const path = join(REPO_ROOT, 'tests/integration', name, 'verify.sh');
  // A RENAMED fixture would otherwise fail with a bare ENOENT, while a
  // RE-ANCHORED one gets the crafted "update PINNED_FIXTURES" message below.
  // Same remedy, so say the same thing.
  if (!existsSync(path)) {
    throw new Error(
      `tests/integration/${name}/verify.sh does not exist. If the fixture was renamed or ` +
        `removed, update PINNED_FIXTURES; if its sentinel moved, update the needle beside it.`
    );
  }
  return readFileSync(path, 'utf8');
};

describe('a fixture sentinel still DISCRIMINATES one stateful reason (#2615)', () => {
  it('found every reason literal (floor, so every check below is non-vacuous)', () => {
    // Five arms: always / has-objects / has-retention / has-log-events / null.
    // An empty or truncated slice reds here first, before it can make the
    // scans below hold trivially.
    expect(REASON_LITERALS).toHaveLength(5);
  });

  it('two reasons DO share phrases, so the scan below has something to catch', () => {
    // Guard-the-guard. Both spellings are pinned deliberately: the maximal
    // gram and the two-word one an n >= 3 floor used to drop. De-hedging
    // either reason empties this set and reds here.
    expect(SHARED_PHRASES).toContain('is not provably empty');
    expect(SHARED_PHRASES).toContain('not provably empty');
    expect(SHARED_PHRASES).toContain('provably empty');
  });

  it('pinned every fixture the two it.each blocks walk (floor, for the same reason)', () => {
    // The sibling floor above exists because an empty slice makes its scans
    // hold trivially. The same hazard is worse here and was open until the
    // review round measured it: `it.each` is `cases.forEach(...)`, so an
    // EMPTY array registers zero tests and the two blocks below vanish with
    // no failure — 13 tests silently become 11 when one entry is deleted.
    // Per-entry resolution is already checked (a renamed fixture reds on
    // `readFileSync`); this closes the cardinality half.
    expect(PINNED_FIXTURES).toHaveLength(2);
  });

  it.each(PINNED_FIXTURES)('%s greps the reason it is about, and only that one', (name, needle) => {
    const text = fixtureText(name);
    expect(
      text,
      `tests/integration/${name}/verify.sh no longer greps "${needle}". Either it was ` +
        're-anchored (update PINNED_FIXTURES) or its sentinel now asserts a sentence cdkd ' +
        'never emits on that path.'
    ).toContain(needle);
    const carriers = REASON_LITERALS.filter((lit) => lit.includes(needle));
    expect(
      carriers.length,
      `"${needle}" is contained in ${carriers.length} of renderStatefulReason's returned ` +
        `strings (${carriers.join(' | ')}). At 0 the fixture greps a sentence cdkd no longer ` +
        'emits; at 2+ its sentinel matches either reason and has stopped discriminating.'
    ).toBe(1);
  });

  it.each(PINNED_FIXTURES)('%s carries no BLUNT phrase outside a full reason', (name) => {
    // Delete every full reason first, then look for a leftover shared phrase.
    // What survives matches two reasons at once — the #2615 regression — and
    // would leave the fixture green while proving nothing.
    let residue = fixtureText(name);
    for (const lit of REASON_LITERALS) residue = residue.split(lit).join('\u0000');
    // Longest first, so the report names the whole blunt needle rather than
    // whichever fragment of it is enumerated first.
    const found = SHARED_PHRASES.filter((phrase) => residue.includes(phrase)).sort(
      (a, b) => b.length - a.length
    );
    expect(
      found,
      found.length === 0
        ? ''
        : `tests/integration/${name}/verify.sh keys on "${found[0]}", which ${REASON_LITERALS.filter(
            (l) => l.includes(found[0]!)
          ).length} of renderStatefulReason's returned strings contain. The sentinel still ` +
          'MATCHES and has stopped DISCRIMINATING, so every phase stays green while it proves ' +
          'nothing. Re-anchor it on the full sentence for the reason it means.'
    ).toEqual([]);
  });
});

/**
 * The `healthimaging-stateful-update-fallback` fixture (issue #2515) greps
 * cdkd's output for six strings, and it reaches the update-failure arm only
 * while three facts about `AWS::HealthImaging::Datastore` hold. Both halves are
 * pinned here, so a reword or a premise change reds at unit time instead of
 * surfacing as a failed real-AWS run.
 *
 * The emitting templates are split across `+`-joined literals, so each is
 * compared after JOINING its fragments, bounded by the throw or call it
 * belongs to.
 */
describe('the healthimaging-stateful-update-fallback fixture greps strings cdkd still emits (#2515)', () => {
  const FIXTURE = 'tests/integration/healthimaging-stateful-update-fallback/verify.sh';
  const TYPE = 'AWS::HealthImaging::Datastore';
  const verify = (): string => readFileSync(join(REPO_ROOT, FIXTURE), 'utf8');
  const CREATE_ONLY_SRC = readFileSync(
    join(REPO_ROOT, 'src/provisioning/create-only-properties.ts'),
    'utf8'
  );
  /** `src.slice(from, to)` with every `` ` + ` `` seam between literals removed. */
  const joined = (src: string, from: string, to: string): string => {
    const start = src.indexOf(from);
    expect(start, `"${from}" moved`).toBeGreaterThan(0);
    const end = src.indexOf(to, start);
    expect(end, `"${to}" no longer follows "${from}"`).toBeGreaterThan(start);
    return src.slice(start, end).replace(/`\s*\+\s*`/g, '');
  };

  it('the update-failure refusal still carries ARM_MARKER and names the consent flag', () => {
    const refusal = joined(
      DEPLOY_ENGINE,
      'cannot be updated in place by the ',
      "'STATEFUL_REPLACE_BLOCKED'"
    );
    expect(
      refusal,
      `the update-failure stateful refusal was reworded — update ARM_MARKER in ${FIXTURE}`
    ).toContain('cannot be updated in place by the provisioning layer it routes through');
    expect(refusal).toContain('but it is a stateful resource');
    expect(refusal).toContain('--force-stateful-recreation');
    const text = verify();
    expect(text).toContain(
      "ARM_MARKER='cannot be updated in place by the provisioning layer it routes through'"
    );
    expect(text).toContain("SHARED_MARKER='but it is a stateful resource'");
  });

  it('the property-driven refusal still starts PROPERTY_MARKER with the changed property', () => {
    const refusal = joined(
      DEPLOY_ENGINE,
      'requires replacement (immutable property changed: ',
      "'STATEFUL_REPLACE_BLOCKED'"
    );
    expect(refusal).toContain('requires replacement (immutable property changed: ${immutableProps}');
    expect(refusal).toContain('but it is a stateful resource');
    expect(verify()).toContain(
      "PROPERTY_MARKER='requires replacement (immutable property changed: Tags'"
    );
  });

  it('a failed create-only lookup with no snapshot still logs LOOKUP_MARKER + REGISTRY_ONLY_MARKER', () => {
    // The report() AFTER the snapshot arm's `return snapshot;` is the
    // no-snapshot one, the only one this fixture can see.
    const snapshotArm = CREATE_ONLY_SRC.indexOf('return snapshot;');
    expect(snapshotArm, 'the snapshot arm moved').toBeGreaterThan(0);
    const noSnapshot = CREATE_ONLY_SRC.indexOf('report(', snapshotArm);
    expect(noSnapshot, 'the no-snapshot report() moved').toBeGreaterThan(snapshotArm);
    const line = CREATE_ONLY_SRC.slice(noSnapshot, CREATE_ONLY_SRC.indexOf(');', noSnapshot)).replace(
      /`\s*\+\s*`/g,
      ''
    );
    expect(line).toContain(
      'Failed to resolve create-only properties for ${resourceType} via cloudformation:DescribeType'
    );
    expect(line).toContain('Falling back to the registry-only replacement classification');
    const text = verify();
    expect(text).toContain(
      'LOOKUP_MARKER="Failed to resolve create-only properties for ${TYPE} via cloudformation:DescribeType"'
    );
    expect(text).toContain(
      "REGISTRY_ONLY_MARKER='Falling back to the registry-only replacement classification'"
    );
  });

  it('the fallback replacement still logs REPLACING_MARKER', () => {
    expect(DEPLOY_ENGINE).toContain(
      '`UPDATE not supported for ${logicalId} (${resourceType}), replacing (DELETE → CREATE)`'
    );
    expect(verify()).toContain(
      'REPLACING_MARKER="UPDATE not supported for Datastore (${TYPE}), replacing"'
    );
    // `Datastore` in the needle is the logical id, i.e. the stack's construct id.
    expect(
      readFileSync(
        join(
          REPO_ROOT,
          'tests/integration/healthimaging-stateful-update-fallback/lib/healthimaging-stateful-update-fallback-stack.ts'
        ),
        'utf8'
      )
    ).toContain("new healthimaging.CfnDatastore(this, 'Datastore', {");
  });

  it('the subject still reaches the update-failure arm when DescribeType is denied', () => {
    // No committed snapshot entry: with one, the denied lookup would still
    // classify Tags as create-only and the fixture would retake the
    // property-driven arm.
    expect(CREATE_ONLY_PATHS_SNAPSHOT.has(TYPE)).toBe(false);
    // No hand-authored rule for Tags, which would decide before the schema.
    expect(new ReplacementRulesRegistry().isClassified(TYPE, 'Tags')).toBe(false);
    // Routed to Cloud Control: no SDK provider, and Cloud Control has handlers.
    expect(
      readFileSync(join(REPO_ROOT, 'src/provisioning/register-providers.ts'), 'utf8')
    ).not.toContain(`'${TYPE}'`);
    expect(hasNoCloudControlHandlers(TYPE)).toBe(false);
    // Stateful, so the arm refuses rather than replacing.
    expect(STATEFUL_TYPES.has(TYPE)).toBe(true);
    // And the live schema DOES list Tags as create-only, which the control
    // phase relies on.
    const report = JSON.parse(
      readFileSync(join(REPO_ROOT, 'docs/_generated/stateful-candidates.json'), 'utf8')
    ) as { candidates: Array<{ typeName: string; createOnlyProperties: string[] }> };
    expect(report.candidates.find((c) => c.typeName === TYPE)?.createOnlyProperties).toContain(
      '/properties/Tags'
    );
  });
});
