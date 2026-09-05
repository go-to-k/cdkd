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

import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
 * provably empty", handing the bucket the phrase its log-group sibling had
 * carried alone. `loggroup-never-expire-guard/verify.sh` grepped the bare
 * `not provably empty`, so its sentinel went on MATCHING and stopped
 * DISCRIMINATING — a failure no re-run of the fixture can surface, because
 * every phase stays green. Review caught it; go-to-k/cdkd#2627 re-anchored
 * both fixtures on the full sentence.
 *
 * The population is DERIVED on both sides, because a hand-written pair table
 * fences the two known instances and not the RULE: with one, appending a bare
 * `grep -q "not provably empty"` beside the good needle left the block green
 * (measured). So the SHARED phrases are computed from the reason literals
 * themselves — every word-n-gram two distinct reasons have in common — and the
 * fixture side is every `verify.sh` that quotes a reason at all. A third
 * hedged reason, or a new fixture, is covered without editing this file.
 *
 * Residual, stated rather than hidden: the fixture side reads whole files, so
 * it pins that a blunt phrase does not APPEAR, not that a `grep` is the thing
 * using it. Parsing shell for grep arguments is the fragile half; a bare
 * occurrence anywhere in a `verify.sh` is already the thing worth refusing.
 */
const REASON_LITERALS: readonly string[] = (() => {
  const start = STATEFUL_TYPES_SRC.indexOf('export function renderStatefulReason');
  // Bounded by the function's own closing brace rather than by a character
  // window: the file's other `return '...'` literals (the sync predicates')
  // would otherwise join the population and make the counts meaningless.
  const end = STATEFUL_TYPES_SRC.indexOf('\n}', start);
  return [...STATEFUL_TYPES_SRC.slice(start, end).matchAll(/return '([^']*)';/g)].map((m) => m[1]!);
})();

/**
 * Every word-n-gram (n >= 3) that two DISTINCT reason literals share.
 *
 * This is the blunt-sentinel population: a fixture keying on one of these
 * cannot tell the two reasons apart. Three words rather than two because the
 * reasons share ordinary connectives ("is not", "in the") that no fixture
 * would key on and that would drown the signal.
 */
const SHARED_PHRASES: readonly string[] = (() => {
  const grams = (lit: string): Set<string> => {
    const words = lit.split(' ');
    const out = new Set<string>();
    for (let n = 3; n <= words.length; n += 1) {
      for (let i = 0; i + n <= words.length; i += 1) out.add(words.slice(i, i + n).join(' '));
    }
    return out;
  };
  const shared = new Set<string>();
  for (let i = 0; i < REASON_LITERALS.length; i += 1) {
    for (let j = i + 1; j < REASON_LITERALS.length; j += 1) {
      const b = grams(REASON_LITERALS[j]!);
      for (const g of grams(REASON_LITERALS[i]!)) if (b.has(g)) shared.add(g);
    }
  }
  // EVERY shared gram, not just the maximal ones. Filtering to the maximal
  // reads tidier and silently reopens the hole: the maximal phrase here is
  // `is not provably empty`, so a fixture keying on the three-word
  // `not provably empty` — the exact needle go-to-k/cdkd#2615 blunted — would
  // match no entry and pass. Short grams are the ones a hand-written sentinel
  // actually uses.
  return [...shared];
})();

const INTEG_DIR = join(REPO_ROOT, 'tests/integration');

/** Every fixture `verify.sh` quoting a reason verbatim, with its text. */
const FIXTURES_QUOTING_A_REASON: ReadonlyArray<{ name: string; text: string }> = readdirSync(
  INTEG_DIR,
  { withFileTypes: true }
)
  .filter((e) => e.isDirectory())
  .map((e) => ({ name: e.name, path: join(INTEG_DIR, e.name, 'verify.sh') }))
  .filter((f) => existsSync(f.path))
  .map((f) => ({ name: f.name, text: readFileSync(f.path, 'utf8') }))
  .filter((f) => REASON_LITERALS.some((lit) => f.text.includes(lit)));

describe('a fixture sentinel still DISCRIMINATES one stateful reason (#2615)', () => {
  it('found every reason literal (floor, so every check below is non-vacuous)', () => {
    // Five arms: always / has-objects / has-retention / has-log-events / null.
    // A slice that captured nothing would make each scan below hold trivially,
    // and every rename / truncation probe dies here first.
    expect(REASON_LITERALS).toHaveLength(5);
  });

  it('two reasons DO share a phrase, so the scan below has something to catch', () => {
    // Guard-the-guard. `>= 1` and not an exact count: a third legitimately
    // hedged reason grows this set, and that is the case the scan exists for,
    // not a reason to red here.
    expect(SHARED_PHRASES.length).toBeGreaterThanOrEqual(1);
    // Both the maximal shared gram and the shorter one #2615's fixture
    // actually keyed on — pinning both is what proves the set was not
    // narrowed to the tidy-looking maximal form.
    expect(SHARED_PHRASES).toContain('is not provably empty');
    expect(SHARED_PHRASES).toContain('not provably empty');
  });

  it('at least two fixtures quote a reason (floor for the derived population)', () => {
    // Without this, a fixture tree that stopped quoting reasons at all — or a
    // `readdirSync` that stopped seeing it — would make the scan below pass by
    // scanning nothing.
    expect(FIXTURES_QUOTING_A_REASON.map((f) => f.name).sort()).toEqual([
      'loggroup-never-expire-guard',
      'recreate-via-cc-api',
    ]);
  });

  it.each(FIXTURES_QUOTING_A_REASON.map((f) => [f.name, f.text] as const))(
    '%s carries no BLUNT reason phrase outside a full reason sentence',
    (name, text) => {
      // Delete every full reason first, then look for a leftover shared
      // phrase. What survives is a needle that matches either reason — the
      // #2615 regression — rather than one that identifies its producer.
      let residue = text;
      for (const lit of REASON_LITERALS) residue = residue.split(lit).join('\u0000');
      // Longest first, so the report names the whole blunt needle rather than
      // whichever three-word fragment of it happens to be enumerated first.
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
            'MATCHES and has stopped DISCRIMINATING, so every phase of the fixture stays green ' +
            'while it proves nothing — exactly what #2615 did to the log-group arm by hedging ' +
            'the bucket one. Re-anchor it on the full sentence for the reason it means.'
      ).toEqual([]);
    }
  );
});
