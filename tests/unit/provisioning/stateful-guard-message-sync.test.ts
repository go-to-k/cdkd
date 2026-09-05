/**
 * Pins the `backup` integ fixture's needles against the strings cdkd actually
 * emits (issue #2553).
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

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';

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
 * provably empty", which handed the bucket the phrase its log-group sibling had
 * carried alone. `tests/integration/loggroup-never-expire-guard/verify.sh`
 * grepped the bare `not provably empty`, so its sentinel went on MATCHING and
 * stopped DISCRIMINATING — a failure no re-run of the fixture can surface,
 * because every phase stays green. Review caught it; the fix round re-anchored
 * both fixtures on the full sentence.
 *
 * So these cases pin the DISCRIMINATION, not just the presence: each fixture's
 * needle must be contained in EXACTLY ONE of `renderStatefulReason`'s returned
 * strings. Hedging a third reason into a shared phrase reds here, naming the
 * fixture whose sentinel it just blunted.
 */
const REASON_LITERALS: readonly string[] = (() => {
  const start = STATEFUL_TYPES_SRC.indexOf('export function renderStatefulReason');
  // Bounded by the function's own opening rather than by a character window:
  // the file's other `return '...'` literals (the sync predicates') would
  // otherwise join the population and make the uniqueness count meaningless.
  const end = STATEFUL_TYPES_SRC.indexOf('\n}', start);
  return [...STATEFUL_TYPES_SRC.slice(start, end).matchAll(/return '([^']*)';/g)].map((m) => m[1]!);
})();

describe('a fixture sentinel still DISCRIMINATES one stateful reason (#2615)', () => {
  it('found every reason literal (floor, so the counts below cannot pass vacuously)', () => {
    // Five arms: always / has-objects / has-retention / has-log-events / null.
    // A slice that captured nothing would make every `toBe(1)` below hold at 0.
    expect(REASON_LITERALS).toHaveLength(5);
  });

  it.each([
    ['loggroup-never-expire-guard', 'log group is not provably empty'],
    ['recreate-via-cc-api', 'S3 bucket is not provably empty'],
  ])('%s greps a needle unique to one reason', (fixture, needle) => {
    const verifySh = readFileSync(
      join(REPO_ROOT, 'tests/integration', fixture, 'verify.sh'),
      'utf8'
    );
    expect(
      verifySh,
      `tests/integration/${fixture}/verify.sh no longer greps "${needle}" — either ` +
        'the fixture was re-anchored (update this pair) or its sentinel is now blind'
    ).toContain(needle);
    const matches = REASON_LITERALS.filter((lit) => lit.includes(needle));
    expect(
      matches.length,
      `"${needle}" is contained in ${matches.length} of renderStatefulReason's returned ` +
        `strings (${matches.join(' | ')}). At 0 the fixture greps a sentence cdkd no longer ` +
        `emits; at 2+ its sentinel matches either reason and has stopped discriminating, ` +
        'which is exactly what #2615 did to the log-group arm by hedging the bucket one. ' +
        `Re-anchor tests/integration/${fixture}/verify.sh on the part still unique to its reason.`
    ).toBe(1);
  });

  it('the bare hedge is SHARED, so the discrimination above is not free', () => {
    // Guard-the-guard: if no two reasons shared a phrase, the `toBe(1)` cases
    // would hold for any needle and attest to nothing. They are meaningful
    // precisely because `not provably empty` matches two arms today.
    expect(REASON_LITERALS.filter((lit) => lit.includes('not provably empty'))).toHaveLength(2);
  });
});
