import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectModeGates,
  parseDeploySteps,
  evaluateCond,
  tokensOf,
  lintFixture,
  lintFixtureTree,
  fixtureStackFiles,
  formatViolation,
  type Cond,
} from '../../../scripts/check-integ-mode-gated-resources.js';

/**
 * Regression guard for issue #1543 — the integ-fixture mode-gating trap. See
 * `scripts/check-integ-mode-gated-resources.ts` for why gating a NEW resource
 * on a NEW token is wrong whenever a later deploy's mode list omits it.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');

// ---------------------------------------------------------------------------
// verify.sh parsing
// ---------------------------------------------------------------------------

const CLI_HEADER = 'CLI="node ../../dist/cli.js"\n';

describe('parseDeploySteps', () => {
  it('reads the inline env prefix, in order', () => {
    const steps = parseDeploySteps(
      `${CLI_HEADER}` +
        `CDKD_TEST_UPDATE=a \${CLI} deploy S\n` +
        `CDKD_TEST_UPDATE=a,b \${CLI} deploy S\n`,
    );
    expect(steps.map((s) => s.modes)).toEqual([['a'], ['a', 'b']]);
  });

  it('reads an INDENTED invocation inside an if block', () => {
    // The bug this pins was live in the first draft of the classifier: an
    // anchor demanding column 0 read every `if`-nested deploy as unmoded, which
    // muted the opt-in multi-region block where the real finding lives.
    const steps = parseDeploySteps(
      `${CLI_HEADER}if [ "\${X:-0}" = "1" ]; then\n` +
        `  CDKD_TEST_UPDATE=cross-region \${CLI} deploy S\n` +
        `  CDKD_TEST_UPDATE=base \${CLI} deploy S\n` +
        `fi\n`,
    );
    expect(steps.map((s) => s.modes)).toEqual([['cross-region'], ['base']]);
  });

  it('treats an unprefixed deploy as carrying the AMBIENT value', () => {
    const steps = parseDeploySteps(
      `${CLI_HEADER}export CDKD_TEST_UPDATE=a,b\n\${CLI} deploy S\nunset CDKD_TEST_UPDATE\n\${CLI} deploy S\n`,
    );
    expect(steps.map((s) => s.modes)).toEqual([
      ['a', 'b'],
      [],
    ]);
  });

  it('defaults to an empty mode list before any assignment', () => {
    expect(parseDeploySteps(`${CLI_HEADER}\${CLI} deploy S\n`)[0]?.modes).toEqual([]);
  });

  it('reports a shell-variable mode list as unresolvable rather than empty', () => {
    const steps = parseDeploySteps(`${CLI_HEADER}CDKD_TEST_UPDATE="\${MODES}" \${CLI} deploy S\n`);
    expect(steps[0]?.modes).toBeNull();
  });

  it('resolves the monotonic-suffix idiom in source order', () => {
    // The idiom `.claude/rules/testing.md` prescribes: seeded empty, set once
    // the resource exists, appended to every later mode list.
    const steps = parseDeploySteps(
      `${CLI_HEADER}SUF=""\n` +
        `CDKD_TEST_UPDATE=ttl,tags\${SUF} \${CLI} deploy S\n` +
        `SUF=",extra"\n` +
        `CDKD_TEST_UPDATE=ttl,tags\${SUF} \${CLI} deploy S\n`,
    );
    expect(steps.map((x) => x.modes)).toEqual([
      ['ttl', 'tags'],
      ['ttl', 'tags', 'extra'],
    ]);
  });

  it('reports a `${VAR:-default}` form as unresolvable, not as a literal token', () => {
    // Leaving `alpha${SUF:-}` in the string makes token `alpha` read ABSENT and
    // produces a FALSE blocking finding on a correct fixture — and `:-` is one
    // keystroke from the prescribed suffix idiom.
    expect(
      parseDeploySteps(`${CLI_HEADER}CDKD_TEST_UPDATE=alpha\${SUF:-} \${CLI} deploy S\n`)[0]?.modes,
    ).toBeNull();
  });

  it('invalidates a variable assigned from a command substitution', () => {
    const steps = parseDeploySteps(
      `${CLI_HEADER}SUF=",a"\nSUF=$(echo ,beta)\nCDKD_TEST_UPDATE=ttl\${SUF} \${CLI} deploy S\n`,
    );
    expect(steps[0]?.modes, 'a stale value must not survive an unresolvable RHS').toBeNull();
  });

  it('reads the mode list when it is NOT the first env assignment', () => {
    // Both shapes already exist in the tree. An anchored match read them as
    // unmoded, which is a CI-BLOCKING false positive, not a miss.
    expect(
      parseDeploySteps(
        `${CLI_HEADER}CDKD_TEST_REMOVAL=true CDKD_TEST_UPDATE=alpha \${CLI} deploy S\n`,
      )[0]?.modes,
    ).toEqual(['alpha']);
    expect(
      parseDeploySteps(`${CLI_HEADER}env -u OTHER CDKD_TEST_UPDATE=alpha \${CLI} deploy S\n`)[0]
        ?.modes,
    ).toEqual(['alpha']);
  });

  it('ignores a mode assignment inside a heredoc body', () => {
    const steps = parseDeploySteps(
      `${CLI_HEADER}cat <<EOF\nCDKD_TEST_UPDATE=ghost\nEOF\n\${CLI} deploy S\n`,
    );
    expect(steps.map((x) => x.modes)).toEqual([[]]);
  });

  it('ignores non-deploy invocations', () => {
    const steps = parseDeploySteps(
      `${CLI_HEADER}CDKD_TEST_UPDATE=a \${CLI} destroy S --force\nCDKD_TEST_UPDATE=b \${CLI} deploy S\n`,
    );
    expect(steps.map((s) => s.modes)).toEqual([['b']]);
  });

  it('does not read a mode list out of a comment', () => {
    const steps = parseDeploySteps(
      `${CLI_HEADER}# CDKD_TEST_UPDATE=ghost \${CLI} deploy S\nCDKD_TEST_UPDATE=real \${CLI} deploy S\n`,
    );
    expect(steps.map((s) => s.modes)).toEqual([['real']]);
  });

  it('handles a `\\`-continued invocation', () => {
    const steps = parseDeploySteps(
      `${CLI_HEADER}CDKD_TEST_UPDATE=a,b \${CLI} deploy S \\\n  --state-bucket B --verbose\n`,
    );
    expect(steps.map((s) => s.modes)).toEqual([['a', 'b']]);
  });
});

// ---------------------------------------------------------------------------
// Stack parsing
// ---------------------------------------------------------------------------

const STACK_HEADER = `const updateMode = (process.env.CDKD_TEST_UPDATE ?? '').split(',').map((s) => s.trim());\n`;

const gatesOf = (body: string) => collectModeGates(STACK_HEADER + body, 'stack.ts');

describe('collectModeGates', () => {
  it('records a spread-gated property', () => {
    const gates = gatesOf(`const p = { ...(updateMode.includes('ttl') && { ttl: 'x' }) };`);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.kind).toBe('property');
    expect(tokensOf(gates[0]!.cond)).toEqual(['ttl']);
  });

  it('records a spread-gated resource LIST as resource-list, not property', () => {
    // The #1512 shape. It contains no `new`, so a construct-only heuristic
    // would have classified the exact motivating case as a harmless property.
    const gates = gatesOf(
      `const p = { ...(updateMode.includes('cross-region') && { replicas: [{ region: 'eu-west-1' }] }) };`,
    );
    expect(gates[0]!.kind).toBe('resource-list');
  });

  it('records an if-gated construct', () => {
    const gates = gatesOf(
      `if (updateMode.includes('extra')) { const q = new sqs.Queue(this, 'Q'); }`,
    );
    expect(gates[0]!.kind).toBe('construct');
  });

  it('resolves a condition through an intermediate const binding', () => {
    const gates = gatesOf(
      `const wants = updateMode.includes('cross-region');\n` +
        `const p = { ...(wants && { replicas: [{ region: 'eu-west-1' }] }) };`,
    );
    expect(tokensOf(gates[0]!.cond)).toEqual(['cross-region']);
  });

  it('unions an OR across bindings, so a sibling token still holds the gate', () => {
    // `useProvisioned = useAutoScaling || includes('billing-provisioned')` is
    // real code; a per-TOKEN rule reports a drop at a step where `autoscaling`
    // still holds the declaration in the template.
    const gates = gatesOf(
      `const auto = updateMode.includes('autoscaling');\n` +
        `const prov = auto || updateMode.includes('billing-provisioned');\n` +
        `const p = { ...(prov && { billing: 'PROVISIONED' }) };`,
    );
    expect(tokensOf(gates[0]!.cond).sort()).toEqual(['autoscaling', 'billing-provisioned']);
  });

  it('records only the TRUTHY arm of a ternary', () => {
    const gates = gatesOf(`const p = { r: updateMode.includes('x') ? [{ a: 1 }] : [] };`);
    expect(gates).toHaveLength(1);
    expect(gates[0]!.kind).toBe('resource-list');
  });

  it('skips a gate whose truthy arm is EMPTY (the `drop-*` idiom)', () => {
    // `...(includes('drop-x') ? {} : { limit })` — the token removes rather
    // than adds, which is a deliberate removal test by construction.
    expect(gatesOf(`const p = { ...(updateMode.includes('drop-x') ? {} : { limit: 100 }) };`)).toEqual(
      [],
    );
  });

  it('ignores the BOOLEAN `=== true` spelling, which has no token list', () => {
    const gates = collectModeGates(
      `const updateMode = process.env.CDKD_TEST_UPDATE === 'true';\n` +
        `const p = { ...(updateMode && { a: 1 }) };`,
      'stack.ts',
    );
    expect(gates).toEqual([]);
  });

  it('finds the mode binding by its initializer, not by the name `updateMode`', () => {
    const gates = collectModeGates(
      `const phases = (process.env.CDKD_TEST_UPDATE ?? '').split(',');\n` +
        `const p = { ...(phases.includes('x') && { a: 1 }) };`,
      'stack.ts',
    );
    expect(tokensOf(gates[0]!.cond)).toEqual(['x']);
  });

  it('does not treat an unrelated array `.includes` as a gate', () => {
    expect(gatesOf(`const p = { ...(['a'].includes('a') && { x: 1 }) };`)).toEqual([]);
  });

  it('reads the allow marker from a comment above the statement', () => {
    const gates = gatesOf(
      `// allow-mode-gated-drop: step 12d removes the replica on purpose\n` +
        `const p = { ...(updateMode.includes('cross-region') && { replicas: [{ region: 'x' }] }) };`,
    );
    expect(gates[0]!.allowReason).toBe('step 12d removes the replica on purpose');
  });

  it('reports a bare marker with no reason as empty, not as absent', () => {
    const gates = gatesOf(
      `// allow-mode-gated-drop:\n` +
        `const p = { ...(updateMode.includes('x') && { replicas: [{ region: 'y' }] }) };`,
    );
    expect(gates[0]!.allowReason).toBe('');
  });

  it('keeps a mode-derived gate whose TOKEN is unreadable, as unknown-token', () => {
    // `unknown-token` must stay distinct from `unknown`: collapsing the two
    // made `isModeDerived` false and the gate vanished from the analysis
    // entirely — a silent skip rather than the `inconclusive-gate` note.
    const gates = gatesOf(
      `const p = { ...(updateMode.includes(SOME_CONST) && { replicas: [{ region: 'x' }] }) };`,
    );
    expect(gates).toHaveLength(1);
    expect(gates[0]!.cond).toEqual<Cond>({ t: 'unknown-token' });
  });

  it('does NOT record a gate whose condition never reads the mode list', () => {
    expect(gatesOf(`const p = { ...(process.env.OTHER === '1' && { replicas: [{ r: 1 }] }) };`)).toEqual(
      [],
    );
  });
});

describe('evaluateCond', () => {
  const token = (t: string): Cond => ({ t: 'token', token: t });

  it('settles an AND on a definite false even beside an unknown leaf', () => {
    expect(evaluateCond({ t: 'and', l: token('a'), r: { t: 'unknown' } }, [])).toBe(false);
  });

  it('settles an OR on a definite true even beside an unknown leaf', () => {
    expect(evaluateCond({ t: 'or', l: token('a'), r: { t: 'unknown' } }, ['a'])).toBe(true);
  });

  it('returns null when nothing settles it', () => {
    expect(evaluateCond({ t: 'and', l: token('a'), r: { t: 'unknown' } }, ['a'])).toBeNull();
  });

  it('handles negation', () => {
    expect(evaluateCond({ t: 'not', e: token('a') }, [])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

const REPLICA_GATE = `const p = { ...(updateMode.includes('cross-region') && { replicas: [{ region: 'eu-west-1' }] }) };`;

describe('lintFixture', () => {
  it('flags a resource gated on a token a LATER deploy omits', () => {
    const v = lintFixture(
      'f',
      'lib/s.ts',
      STACK_HEADER + REPLICA_GATE,
      `${CLI_HEADER}CDKD_TEST_UPDATE=cross-region \${CLI} deploy S\nCDKD_TEST_UPDATE=base \${CLI} deploy S\n`,
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe('dropped-mid-run');
    expect(v[0]!.blocking).toBe(true);
    expect(v[0]!.message).toContain('24h source-region delete lock');
  });

  it('flags a GAP between two carrying deploys, not only a trailing drop', () => {
    // The issue's stated rule ("a deploy after the LAST carrying one") misses
    // this, and it is strictly worse: the resource is deleted and re-created.
    const v = lintFixture(
      'f',
      'lib/s.ts',
      STACK_HEADER + REPLICA_GATE,
      `${CLI_HEADER}CDKD_TEST_UPDATE=cross-region \${CLI} deploy S\n` +
        `CDKD_TEST_UPDATE=base \${CLI} deploy S\n` +
        `CDKD_TEST_UPDATE=cross-region \${CLI} deploy S\n`,
    );
    expect(v).toHaveLength(1);
  });

  it('does NOT flag a token that is only ever added and carried forward', () => {
    const v = lintFixture(
      'f',
      'lib/s.ts',
      STACK_HEADER + REPLICA_GATE,
      `${CLI_HEADER}\${CLI} deploy S\n` +
        `CDKD_TEST_UPDATE=cross-region \${CLI} deploy S\n` +
        `CDKD_TEST_UPDATE=cross-region,more \${CLI} deploy S\n`,
    );
    expect(v).toEqual([]);
  });

  it('does NOT flag a declaration a SIBLING token still enables', () => {
    const v = lintFixture(
      'f',
      'lib/s.ts',
      STACK_HEADER +
        `const auto = updateMode.includes('autoscaling');\n` +
        `const prov = auto || updateMode.includes('billing-provisioned');\n` +
        `const p = { ...(prov && { replicas: [{ region: 'x' }] }) };`,
      `${CLI_HEADER}CDKD_TEST_UPDATE=billing-provisioned \${CLI} deploy S\n` +
        `CDKD_TEST_UPDATE=autoscaling \${CLI} deploy S\n`,
    );
    expect(v).toEqual([]);
  });

  it('reports a property drop as NON-blocking', () => {
    const v = lintFixture(
      'f',
      'lib/s.ts',
      STACK_HEADER + `const p = { ...(updateMode.includes('dp') && { deletionProtection: true }) };`,
      `${CLI_HEADER}CDKD_TEST_UPDATE=dp \${CLI} deploy S\n\${CLI} deploy S\n`,
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.blocking).toBe(false);
    expect(v[0]!.gateKind).toBe('property');
  });

  it('silences a drop carrying an allow-mode-gated-drop reason', () => {
    const v = lintFixture(
      'f',
      'lib/s.ts',
      `${STACK_HEADER}// allow-mode-gated-drop: the removal IS the test\n${REPLICA_GATE}`,
      `${CLI_HEADER}CDKD_TEST_UPDATE=cross-region \${CLI} deploy S\n\${CLI} deploy S\n`,
    );
    expect(v).toEqual([]);
  });

  it('rejects an allow marker with no reason', () => {
    const v = lintFixture(
      'f',
      'lib/s.ts',
      `${STACK_HEADER}// allow-mode-gated-drop:\n${REPLICA_GATE}`,
      `${CLI_HEADER}CDKD_TEST_UPDATE=cross-region \${CLI} deploy S\n\${CLI} deploy S\n`,
    );
    expect(v.map((x) => x.kind)).toContain('unreasoned-allow');
    expect(v.find((x) => x.kind === 'unreasoned-allow')!.blocking).toBe(true);
  });

  it('fails LOUDLY on an unresolvable mode list instead of passing vacuously', () => {
    const v = lintFixture(
      'f',
      'lib/s.ts',
      STACK_HEADER + REPLICA_GATE,
      `${CLI_HEADER}CDKD_TEST_UPDATE="\${MODES}" \${CLI} deploy S\n\${CLI} deploy S\n`,
    );
    expect(v).toHaveLength(1);
    expect(v[0]!.kind).toBe('unresolvable-mode-list');
    expect(v[0]!.blocking).toBe(true);
  });

  it('surfaces an inconclusive gate rather than skipping it silently', () => {
    const v = lintFixture(
      'f',
      'lib/s.ts',
      STACK_HEADER + `const p = { ...(updateMode.includes(K) && { replicas: [{ region: 'x' }] }) };`,
      `${CLI_HEADER}\${CLI} deploy S\n`,
    );
    expect(v.map((x) => x.kind)).toEqual(['inconclusive-gate']);
    expect(v[0]!.blocking).toBe(false);
  });

  it('says nothing about a fixture with no mode gates at all', () => {
    expect(
      lintFixture('f', 'lib/s.ts', `const q = new sqs.Queue(this, 'Q');`, `${CLI_HEADER}\${CLI} deploy S\n`),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Real-tree sweep + parser floors
// ---------------------------------------------------------------------------

describe('the real fixture tree', () => {
  const violations = lintFixtureTree(INTEG_ROOT);

  it('has no un-annotated mode-gated resource drop', () => {
    expect(violations.filter((v) => v.blocking).map(formatViolation)).toEqual([]);
  });

  it('parses at least one fixture that actually uses the token-list form', () => {
    // A coverage floor, not decoration: every classifier half can regress to
    // "found nothing", and a tree-wide green is indistinguishable from a
    // silent parse failure without it. Only `dynamodb-globaltable` uses the
    // token-list spelling today; the other three `CDKD_TEST_UPDATE` fixtures
    // use the boolean `=== 'true'` form, which carries no token to drop.
    const withGates = readdirSync(INTEG_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
      .flatMap((e) =>
        fixtureStackFiles(join(INTEG_ROOT, e.name)).map((rel) =>
          collectModeGates(readFileSync(join(INTEG_ROOT, e.name, rel), 'utf8'), rel),
        ),
      )
      .filter((g) => g.length > 0);
    expect(withGates.length).toBeGreaterThanOrEqual(1);
    expect(withGates.flat().length).toBeGreaterThanOrEqual(8);
  });

  it('resolves a real, non-trivial number of mode lists — per SHAPE, not just a total', () => {
    // The aggregate step count is NOT a floor for this: the column-0 anchor bug
    // left all 353 steps parsed and only emptied their mode lists, so the total
    // stayed green while the one real finding vanished. What has to be fenced
    // is the number of steps whose mode list actually RESOLVED to something.
    const resolved = readdirSync(INTEG_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
      .flatMap((e) => parseDeploySteps(readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8')));
    const nonEmpty = resolved.filter((s) => s.modes !== null && s.modes.length > 0);
    expect(nonEmpty.length, 'no deploy carries a resolved mode list — parser regression?')
      .toBeGreaterThanOrEqual(60);
    // And at least one must come from the monotonic-suffix idiom, the shape a
    // `$`-give-up parser silently turns into `unresolvable`.
    expect(nonEmpty.some((s) => s.modes!.includes('cross-region-ondemand-dropped'))).toBe(true);
  });

  it('collects every gate KIND the classifier claims to produce', () => {
    const kinds = new Set(
      readdirSync(INTEG_ROOT, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
        .flatMap((e) =>
          fixtureStackFiles(join(INTEG_ROOT, e.name)).flatMap((rel) =>
            collectModeGates(readFileSync(join(INTEG_ROOT, e.name, rel), 'utf8'), rel),
          ),
        )
        .map((g) => g.kind),
    );
    // An aggregate `>= 8` survives losing a whole shape; this does not.
    expect([...kinds].sort()).toEqual(['construct', 'property', 'resource-list']);
  });

  it('pins the NON-blocking findings so the visibility-only bucket cannot rot', () => {
    // Nothing prints these today, so without a pin they are unobservable — and
    // an inconclusive gate silently becoming zero would look like progress.
    const notes = violations.filter((v) => !v.blocking);
    expect(notes.length).toBeGreaterThanOrEqual(5);
    expect(
      notes.some((v) => v.kind === 'inconclusive-gate' && v.gateKind === 'resource-list'),
      'the #1512 replica gate must stay VISIBLE as inconclusive, never silently dropped',
    ).toBe(true);
  });

  it('parses a plausible number of deploy steps across the tree', () => {
    const total = readdirSync(INTEG_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
      .reduce(
        (n, e) => n + parseDeploySteps(readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8')).length,
        0,
      );
    expect(total).toBeGreaterThanOrEqual(200);
  });

  it('resolves every mode list in the tree (no unresolvable-mode-list today)', () => {
    expect(violations.filter((v) => v.kind === 'unresolvable-mode-list')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// REAL-CODE fail probes — the classifier must catch the bug in the real
// fixture, not only in synthetic shapes it was written against.
// ---------------------------------------------------------------------------

describe('real-code probes against the dynamodb-globaltable fixture', () => {
  const FIXTURE = join(INTEG_ROOT, 'dynamodb-globaltable');
  const STACK_REL = 'lib/dynamodb-globaltable-stack.ts';
  const stack = readFileSync(join(FIXTURE, STACK_REL), 'utf8');
  const verify = readFileSync(join(FIXTURE, 'verify.sh'), 'utf8');

  it('is CLEAN as shipped — the real replica gate carries its annotation', () => {
    expect(
      lintFixture('dynamodb-globaltable', STACK_REL, stack, verify).filter((x) => x.blocking)
    ).toEqual([]);
  });

  it('flags the real cross-region replica gate once the annotation is REMOVED', () => {
    // The inverse of the test above, and the one that actually proves the lint
    // works: strip the `allow-mode-gated-drop` line from the REAL fixture and
    // the real verify.sh must produce the blocking finding. Without this, an
    // annotation that silences everything would look identical to a lint that
    // detects nothing.
    const stripped = stack.replace(/^.*allow-mode-gated-drop.*\n/m, '');
    expect(stripped, 'the strip probe did not apply').not.toBe(stack);

    const replica = lintFixture('dynamodb-globaltable', STACK_REL, stripped, verify).find(
      (x) => x.blocking && x.gateKind === 'resource-list'
    );
    expect(replica, 'the real replica drop was not detected').toBeDefined();
    expect(replica!.message).toContain('cross-region');
    expect(replica!.message).toContain('24h source-region delete lock');
  });

  it('flags the real ttl property gate once a later real step drops it', () => {
    // `ttl` is carried forward to the end today, so it is clean. Truncating
    // verify.sh after a `ttl`-carrying deploy and appending an unmoded one
    // reproduces the drop against unmodified fixture SOURCE.
    const v = lintFixture(
      'dynamodb-globaltable',
      STACK_REL,
      stack,
      `${verify}\nunset CDKD_TEST_UPDATE\n\${CLI} deploy "\${STACK}"\n`,
    );
    expect(v.some((x) => x.message.includes('ttl'))).toBe(true);
  });
});

describe('real-code probes for the remaining blocking verdicts', () => {
  const FIXTURE2 = join(INTEG_ROOT, 'dynamodb-globaltable');
  const STACK_REL2 = 'lib/dynamodb-globaltable-stack.ts';
  const stack2 = readFileSync(join(FIXTURE2, STACK_REL2), 'utf8');
  const verify2 = readFileSync(join(FIXTURE2, 'verify.sh'), 'utf8');

  it('unreasoned-allow: blanking the REAL annotation reason blocks', () => {
    const blanked = stack2.replace(/allow-mode-gated-drop:.*$/m, 'allow-mode-gated-drop:');
    expect(blanked).not.toBe(stack2);
    const v = lintFixture('dynamodb-globaltable', STACK_REL2, blanked, verify2);
    const found = v.find((x) => x.kind === 'unreasoned-allow');
    expect(found, 'a reasonless marker must be refused').toBeDefined();
    expect(found!.blocking).toBe(true);
  });

  it('unresolvable-mode-list: a command substitution in the REAL verify.sh blocks', () => {
    // The LATER assignment, not the empty seed: the seed is re-set to a
    // literal further down, so wrecking it leaves every USE resolvable and the
    // probe proves nothing.
    const wrecked = verify2.replace(
      /OD_MODE_SUFFIX=",cross-region-ondemand-dropped"/,
      'OD_MODE_SUFFIX=$(echo ,cross-region-ondemand-dropped)',
    );
    expect(wrecked).not.toBe(verify2);
    const v = lintFixture('dynamodb-globaltable', STACK_REL2, stack2, wrecked);
    const found = v.find((x) => x.kind === 'unresolvable-mode-list');
    expect(found, 'an unresolvable mode list must fail loudly').toBeDefined();
    expect(found!.blocking).toBe(true);
  });
});

describe('lintFixtureTree over a scratch copy', () => {
  it('detects an injected mode-gated resource drop in a real-shaped fixture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-1543-'));
    try {
      const fixture = join(dir, 'scratch-fixture');
      mkdirSync(join(fixture, 'lib'), { recursive: true });
      writeFileSync(
        join(fixture, 'verify.sh'),
        `${CLI_HEADER}CDKD_TEST_UPDATE=extra \${CLI} deploy S\n\${CLI} deploy S\n`,
      );
      writeFileSync(
        join(fixture, 'lib', 'scratch-stack.ts'),
        `${STACK_HEADER}if (updateMode.includes('extra')) { const t = new ddb.Table(this, 'T'); }`,
      );

      const v = lintFixtureTree(dir);
      expect(v).toHaveLength(1);
      expect(v[0]!.fixture).toBe('scratch-fixture');
      expect(v[0]!.file).toBe(join('lib', 'scratch-stack.ts'));
      expect(v[0]!.blocking).toBe(true);
      expect(formatViolation(v[0]!)).toContain('[ERROR]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
