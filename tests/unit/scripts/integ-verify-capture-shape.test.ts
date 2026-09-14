import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  CANONICAL_CAPTURE_BLOCK,
  classifyCaptureShape,
  codeLines,
  substitutionBodies,
} from '../../../scripts/check-integ-capture-shape.js';

/**
 * Regression guard for issue #3126: under `set -euo pipefail`, the shape
 * `VAR=$(cmd 2>/dev/null | tail -1)` aborts the script at the assignment with
 * the command's stderr already discarded. `scripts/check-integ-capture-shape.ts`
 * holds the mechanism and the correct form (`capture`).
 *
 * Three layers, each of which the others cannot replace:
 *  1. table tests on the classifier (the shapes it must and must not flag);
 *  2. tree-wide: zero abort-shaped captures in any `verify.sh` that sets
 *     `pipefail`, every `capture`-defining fixture carrying the canonical block
 *     byte-for-byte, and coverage floors so a scanner that parses nothing
 *     cannot pass;
 *  3. real-code + bash probes: the banned shape re-introduced into a REAL
 *     fixture is flagged at the right line, and under bash the banned shape
 *     dies with no diagnostic while `capture` survives with one -- so the
 *     CONVENTION is proven, not only the scanner.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');

/**
 * Fixtures that define `capture`, pinned by NAME: the sweep of #3126 swept
 * exactly these, and a literal list cannot silently widen to a fixture whose
 * copy nobody compared against the canonical block. Add a name when a fixture
 * adopts the helper (the byte-identity test below is what the entry buys).
 */
const CAPTURE_FIXTURES = [
  'local-invoke',
  'local-invoke-agentcore',
  'local-invoke-container',
  'local-invoke-dotnet',
  'local-invoke-java',
  'local-invoke-layers',
  'local-invoke-provided',
  'local-invoke-python',
  'local-invoke-ruby',
].sort();

function readFixtures() {
  return readdirSync(INTEG_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
    .map((e) => {
      const content = readFileSync(join(INTEG_ROOT, e.name, 'verify.sh'), 'utf8');
      return { name: e.name, content, ...classifyCaptureShape(content) };
    });
}

describe('classifyCaptureShape', () => {
  const PIPEFAIL = 'set -euo pipefail\nCDKD="node ../../../dist/cli.js"\n';

  it.each([
    ['the originating shape', 'RESULT_1=$(${CDKD} local invoke Fn --no-pull 2>/dev/null | tail -1)'],
    ['spaced /dev/null', 'R=$(${CDKD} local invoke Fn 2> /dev/null | tail -1)'],
    ['head as the line picker', 'R=$(${CDKD} local invoke Fn 2>/dev/null | head -1)'],
    ['env-prefixed', 'R=$(AWS_REGION=x AWS_DEFAULT_REGION=x ${CDKD} local invoke Fn 2>/dev/null | tail -1)'],
    ['inside an if condition (the retry-loop shape)', 'if out=$(${CLI} local invoke "${args[@]}" 2>/dev/null | tail -1) && echo x; then :; fi'],
    ['&> /dev/null', 'R=$(${CDKD} local invoke Fn &>/dev/null | tail -1)'],
    ['a second pipe stage before tail', 'R=$(${CDKD} local invoke Fn 2>/dev/null | grep x | tail -1)'],
    ['the strict-idiom ordering, silenced then piped', 'R=$(${CDKD} local invoke Fn 2>&1 >/dev/null | tail -1)'],
  ])('flags: %s', (_label, stmt) => {
    const c = classifyCaptureShape(`${PIPEFAIL}${stmt}\n`);
    expect(c.setsPipefail).toBe(true);
    expect(c.abortShapedCaptures.map((f) => f.line)).toEqual([3]);
  });

  it.each([
    ['a pipe at the line end', 'R=$(${CDKD} local invoke Fn 2>/dev/null |\n  tail -1)'],
    ['an open $( at the line end', 'R=$(\n  ${CDKD} local invoke Fn 2>/dev/null | tail -1\n)'],
    ['a comment line inside the open substitution', 'R=$(${CDKD} local invoke Fn 2>/dev/null |\n  # pick the response\n  tail -1)'],
  ])('flags a statement wrapped WITHOUT a backslash, at its first line: %s', (_label, stmt) => {
    // The first cut joined backslash continuations only; a wrapped `|` or an
    // open `$(` hid the shape entirely (review of go-to-k/cdkd#3133).
    const c = classifyCaptureShape(`${PIPEFAIL}${stmt}\necho after\n`);
    expect(c.abortShapedCaptures.map((f) => f.line)).toEqual([3]);
  });

  it('attributes a statement joined after a `&&`-ending line to that line, not the next', () => {
    // The `|` / `&&` / `||` arm of the join is observable only through the
    // line number: the open-`$(` arm already joins a wrapped pipe by itself.
    const c = classifyCaptureShape(`${PIPEFAIL}[ -n "$X" ] &&\n  R=$(x 2>/dev/null | tail -1)\n`);
    expect(c.abortShapedCaptures.map((f) => f.line)).toEqual([3]);
  });

  it('a heredoc opened inside an open $( is blanked in place and the join resumes after its terminator', () => {
    // Second review round: joining first and looking for the opener
    // afterwards swallowed the body into the statement, and the terminator
    // search then ran to the NEXT same-named terminator -- 53 real lines of
    // dynamodb-globaltable/verify.sh went inert. Both directions pinned: the
    // real statement after the block is seen, the body's own shape is not.
    const body = [
      `V="$(python3 - <<'PY'`,
      'print(1)',
      'PY',
      ')"',
      'R=$(x 2>/dev/null | tail -1)',
      `W="$(python3 - <<'PY'`,
      'print(2)',
      'PY',
      ')"',
      '',
    ].join('\n');
    expect(classifyCaptureShape(`${PIPEFAIL}${body}`).abortShapedCaptures.map((f) => f.line)).toEqual([7]);
    const inBody = `V="$(bash <<'SH'\nls 2>/dev/null | tail -1\nSH\n)"\n`;
    expect(classifyCaptureShape(`${PIPEFAIL}${inBody}`).abortShapedCaptures).toEqual([]);
  });

  it('flags a backslash-continued statement at its FIRST physical line', () => {
    const c = classifyCaptureShape(
      `${PIPEFAIL}R=$(AWS_ACCESS_KEY_ID=a \\\n  AWS_REGION=us-east-1 \\\n  \${CDKD} local invoke-agentcore T --sigv4 2>/dev/null | tail -1)\n`,
    );
    expect(c.abortShapedCaptures.map((f) => f.line)).toEqual([3]);
  });

  it.each([
    ['the capture form', 'R=$(capture ${CDKD} local invoke Fn --no-pull)'],
    ['env-prefixed capture form', 'R=$(AWS_REGION=x capture ${CDKD} local invoke Fn)'],
    ['stderr kept in a file (retry loop)', 'if out=$(${CLI} local invoke "${args[@]}" 2>"${err}" | tail -1); then :; fi'],
    ['stderr merged into the capture', 'R=$(${CDKD} local invoke Fn 2>&1 | tail -1)'],
    ['tail without a silenced stderr', 'R=$(${CDKD} local invoke Fn | tail -1)'],
    ['silenced but no line picker', 'R=$(${CDKD} local invoke Fn 2>/dev/null)'],
    ['the shape quoted in a comment line', '#     VAR=$(${CDKD} local invoke ... 2>/dev/null | tail -1)'],
    ['the shape inside a heredoc body', 'cat <<EOF\nR=$(x 2>/dev/null | tail -1)\nEOF'],
    ['tail outside the substitution', 'R=$(${CDKD} local invoke Fn 2>/dev/null); echo "$R" | tail -1'],
    ['a fallback after the picker (the caller checks the empty value -- #1120 class)', 'T=$(ls cdk.out/*.template.json 2>/dev/null | head -1 || true)'],
    ['the word capture in a banner is not a call', 'echo "==> Phase 2: capture + confirm the policy"'],
    ['a here-string is not a heredoc (the line AFTER it still counts)', 'read -r x <<< foo\necho ok'],
  ])('does not flag: %s', (_label, stmt) => {
    const c = classifyCaptureShape(`${PIPEFAIL}${stmt}\n`);
    expect(c.abortShapedCaptures).toEqual([]);
  });

  it('tells a capture CALL from the word in prose, env prefix included', () => {
    expect(classifyCaptureShape(`${PIPEFAIL}R=$(capture x)\n`).callsCapture).toBe(true);
    expect(classifyCaptureShape(`${PIPEFAIL}R=$(AWS_REGION=x capture x)\n`).callsCapture).toBe(true);
    expect(classifyCaptureShape(`${PIPEFAIL}echo "==> Phase 2: capture + confirm"\n`).callsCapture).toBe(false);
  });

  it.each([
    ['a bare-word here-string', 'read -r x <<< foo\nR=$(x 2>/dev/null | tail -1)\n'],
    ['a quoted here-string', "read -r x <<< 'foo'\nR=$(x 2>/dev/null | tail -1)\n"],
    ['a heredoc whose terminator never comes', 'echo "<<EOF"\nR=$(x 2>/dev/null | tail -1)\n'],
    // The here-string's word DOES appear later as a standalone line, so the
    // unterminated-heredoc guard cannot rescue this one: only the `<<<`
    // exclusion keeps line 4 visible (second review round).
    ['a here-string whose word later closes a would-be heredoc', 'for w in a; do\n  read -r x <<< done\n  R=$(x 2>/dev/null | tail -1)\ndone\n'],
  ])('does not blank the rest of the file after %s', (_label, body) => {
    // Both shapes used to open a heredoc that never closed, so every later
    // line was data and the fence was silently inert from there on.
    const c = classifyCaptureShape(`${PIPEFAIL}${body}`);
    const expected = body.split('\n').findIndex((l) => l.includes('2>/dev/null')) + 3;
    expect(c.abortShapedCaptures.map((f) => f.line)).toEqual([expected]);
  });

  it('attributes a nested substitution\'s redirections to the inner body only', () => {
    // The outer `$( ... )` carries no silenced stderr of its own; the inner
    // one does and is the one flagged.
    const c = classifyCaptureShape(`${PIPEFAIL}R=$(echo "$(x 2>/dev/null | tail -1)" | tr a b)\n`);
    expect(c.abortShapedCaptures).toHaveLength(1);
    expect(c.abortShapedCaptures[0]!.body).toBe('x 2>/dev/null | tail -1');
  });

  it('reads pipefail from any of its spellings, and its absence', () => {
    expect(classifyCaptureShape('set -euo pipefail\n').setsPipefail).toBe(true);
    expect(classifyCaptureShape('set -o pipefail\n').setsPipefail).toBe(true);
    expect(classifyCaptureShape('set -eu\nset -o pipefail\n').setsPipefail).toBe(true);
    expect(classifyCaptureShape('set -e -o pipefail\n').setsPipefail).toBe(true);
    expect(classifyCaptureShape('set -o errexit -o pipefail\n').setsPipefail).toBe(true);
    expect(classifyCaptureShape('set -eEuo pipefail\n').setsPipefail).toBe(true);
    expect(classifyCaptureShape('set -eu\n').setsPipefail).toBe(false);
    expect(classifyCaptureShape('# set -euo pipefail\n').setsPipefail).toBe(false);
  });

  it('recognizes the canonical block, a definition, and a call', () => {
    const c = classifyCaptureShape(`${PIPEFAIL}${CANONICAL_CAPTURE_BLOCK}R=$(capture true)\n`);
    expect(c.definesCapture).toBe(true);
    expect(c.hasCanonicalCaptureBlock).toBe(true);
    expect(c.callsCapture).toBe(true);
    // A one-character drift in the helper is a different helper.
    const drifted = CANONICAL_CAPTURE_BLOCK.replace('tail -20', 'tail -10');
    const d = classifyCaptureShape(`${PIPEFAIL}${drifted}R=$(capture true)\n`);
    expect(d.definesCapture).toBe(true);
    expect(d.hasCanonicalCaptureBlock).toBe(false);
  });

  it('does not read the definition line as a call', () => {
    const c = classifyCaptureShape(`${PIPEFAIL}${CANONICAL_CAPTURE_BLOCK}`);
    expect(c.definesCapture).toBe(true);
    expect(c.callsCapture).toBe(false);
  });
});

describe('codeLines / substitutionBodies', () => {
  it('keeps the physical line count while blanking comments and heredoc bodies', () => {
    const lines = codeLines('a\n# c\ncat <<EOF\nbody\nEOF\nb \\\n  c\nd\n');
    // Body AND terminator lines are kept as blanks, so every physical line
    // but a joined continuation has an entry and the numbering stays honest.
    expect(lines.map((l) => [l.line, l.text])).toEqual([
      [1, 'a'],
      [2, ''],
      [3, 'cat <<EOF'],
      [4, ''],
      [5, ''],
      [6, 'b  c'],
      [8, 'd'],
      [9, ''],
    ]);
  });

  it('balances parentheses through JMESPath calls', () => {
    expect(substitutionBodies('N=$(aws x --query "length(Items)" 2>/dev/null | tail -1)')).toEqual([
      'aws x --query "length(Items)" 2>/dev/null | tail -1',
    ]);
  });
});

describe('tree-wide (issue #3126)', () => {
  const fixtures = readFixtures();

  it('sees the corpus (coverage floors)', () => {
    // 257 fixtures carried a verify.sh at the sweep, every one setting
    // pipefail. A scanner that parsed nothing would report zero violations
    // just the same.
    expect(fixtures.length).toBeGreaterThanOrEqual(250);
    expect(fixtures.filter((f) => f.setsPipefail).length).toBeGreaterThanOrEqual(250);
  });

  it('every verify.sh sets pipefail (the shape is out of scope without it, so none may slip out)', () => {
    expect(fixtures.filter((f) => !f.setsPipefail).map((f) => f.name)).toEqual([]);
  });

  it('no verify.sh under pipefail carries an abort-shaped capture', () => {
    const violations = fixtures
      .filter((f) => f.setsPipefail)
      .flatMap((f) => f.abortShapedCaptures.map((v) => `${f.name}/verify.sh:${v.line}: $(${v.body})`));
    expect(
      violations,
      'Under `set -euo pipefail`, `$(cmd 2>/dev/null | tail -1)` aborts the script at the assignment with no diagnostic. Use the `capture` helper (copy CANONICAL_CAPTURE_BLOCK from scripts/check-integ-capture-shape.ts): `VAR=$(capture cmd ...)`. In a retry loop, route stderr to a file (`2>"${err}"`) and print its tail on the failure paths.',
    ).toEqual([]);
  });

  it('the capture-defining fixtures are exactly the pinned set, each carrying the canonical block byte-for-byte', () => {
    const defining = fixtures.filter((f) => f.definesCapture).map((f) => f.name).sort();
    expect(defining).toEqual(CAPTURE_FIXTURES);
    const drifted = fixtures.filter((f) => f.definesCapture && !f.hasCanonicalCaptureBlock).map((f) => f.name);
    expect(drifted, 'a fixture\'s capture() differs from CANONICAL_CAPTURE_BLOCK -- update the constant AND every copy together').toEqual([]);
  });

  it('every fixture that calls capture defines it, and every one that defines it calls it', () => {
    expect(fixtures.filter((f) => f.callsCapture && !f.definesCapture).map((f) => f.name)).toEqual([]);
    expect(fixtures.filter((f) => f.definesCapture && !f.callsCapture).map((f) => f.name)).toEqual([]);
  });

  it('the canonical block is the one local-invoke/verify.sh carries (the constant tracks a real file)', () => {
    const real = readFileSync(join(INTEG_ROOT, 'local-invoke', 'verify.sh'), 'utf8');
    expect(real.includes(CANONICAL_CAPTURE_BLOCK)).toBe(true);
  });
});

describe('real-code probes (issue #3126)', () => {
  it('re-introducing the shape into local-invoke/verify.sh is flagged at that line', () => {
    const real = readFileSync(join(INTEG_ROOT, 'local-invoke', 'verify.sh'), 'utf8');
    const fixed = 'RESULT_1=$(capture ${CDKD} local invoke CdkdLocalInvokeFixture/EchoHandler --no-pull)';
    expect(real.split(fixed)).toHaveLength(2);
    const broken = real.replace(
      fixed,
      'RESULT_1=$(${CDKD} local invoke CdkdLocalInvokeFixture/EchoHandler --no-pull 2>/dev/null | tail -1)',
    );
    const line = broken.slice(0, broken.indexOf('RESULT_1=$(')).split('\n').length;
    const c = classifyCaptureShape(broken);
    expect(c.abortShapedCaptures.map((f) => f.line)).toEqual([line]);
    expect(classifyCaptureShape(real).abortShapedCaptures).toEqual([]);
  });

  it('re-wrapping a real site across two lines without a backslash is still flagged', () => {
    const real = readFileSync(join(INTEG_ROOT, 'local-invoke', 'verify.sh'), 'utf8');
    const fixed = 'RESULT_1=$(capture ${CDKD} local invoke CdkdLocalInvokeFixture/EchoHandler --no-pull)';
    const broken = real.replace(
      fixed,
      'RESULT_1=$(${CDKD} local invoke CdkdLocalInvokeFixture/EchoHandler --no-pull 2>/dev/null |\n  tail -1)',
    );
    const line = broken.slice(0, broken.indexOf('RESULT_1=$(')).split('\n').length;
    expect(classifyCaptureShape(broken).abortShapedCaptures.map((f) => f.line)).toEqual([line]);
  });

  it('a shape placed right after a heredoc-in-$( block of dynamodb-globaltable/verify.sh is flagged at its line', () => {
    // The real file carrying four `V="$(python3 - <<'PY' ... PY )"` blocks;
    // the first cut's join blanked the code between them.
    const real = readFileSync(join(INTEG_ROOT, 'dynamodb-globaltable', 'verify.sh'), 'utf8');
    const lines = real.split('\n');
    const closer = lines.findIndex((l, k) => k > 0 && /^\)"/.test(l) && /^\s*PY\s*$/.test(lines[k - 1]!));
    expect(closer, 'the fixture no longer carries the heredoc-in-$( shape this probe needs').toBeGreaterThan(0);
    lines.splice(closer + 1, 0, 'PROBE=$(x 2>/dev/null | tail -1)');
    const c = classifyCaptureShape(lines.join('\n'));
    expect(c.abortShapedCaptures.map((f) => f.line)).toEqual([closer + 2]);
    expect(classifyCaptureShape(real).abortShapedCaptures).toEqual([]);
  });

  it('re-introducing the retry-loop shape into local-invoke-from-state/verify.sh is flagged', () => {
    const real = readFileSync(join(INTEG_ROOT, 'local-invoke-from-state', 'verify.sh'), 'utf8');
    const fixed = 'if out=$(${CLI} local invoke "${args[@]}" 2>"${err}" | tail -1) && \\';
    expect(real.split(fixed)).toHaveLength(2);
    const broken = real.replace(fixed, 'if out=$(${CLI} local invoke "${args[@]}" 2>/dev/null | tail -1) && \\');
    expect(classifyCaptureShape(broken).abortShapedCaptures).toHaveLength(1);
    expect(classifyCaptureShape(real).abortShapedCaptures).toEqual([]);
  });
});

describe('bash behavior (the convention itself, not the scanner)', () => {
  // A stub CLI: prints one stdout line, one stderr line, exits 7.
  const STUB = 'stub() { echo "partial"; echo "boom: the real cause" >&2; return 7; }\n';

  /**
   * Runs `body` under `set -euo pipefail` with `TMPDIR` pointed at a fresh
   * directory AND a `mktemp` shim first on PATH that honours it: macOS's
   * `/usr/bin/mktemp` prefers `_CS_DARWIN_USER_TEMP_DIR` and reads `TMPDIR`
   * only as a fallback, so without the shim the leftovers check below was
   * vacuous on a Mac (measured by review of go-to-k/cdkd#3133: deleting the
   * helper's `rm -f` left `leftovers` empty). The shim makes the check bind
   * on every host; the control case proves it binds.
   */
  function runScript(body: string) {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-3126-'));
    try {
      const bin = join(dir, 'bin');
      mkdirSync(bin);
      writeFileSync(
        join(bin, 'mktemp'),
        '#!/bin/sh\nexec /usr/bin/mktemp "${TMPDIR:?}/tmp.XXXXXXXX"\n',
        { mode: 0o755 },
      );
      const script = join(dir, 'verify.sh');
      writeFileSync(script, `set -euo pipefail\n${STUB}${body}`);
      const r = spawnSync('bash', [script], {
        encoding: 'utf8',
        env: { ...process.env, TMPDIR: dir, PATH: `${bin}:${process.env['PATH'] ?? ''}` },
      });
      const leftovers = readdirSync(dir).filter((f) => f !== 'verify.sh' && f !== 'bin');
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, leftovers };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('the banned shape dies at the assignment with no diagnostic', () => {
    const r = runScript('R=$(stub 2>/dev/null | tail -1)\necho "reached assertion: [$R]"\n');
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('reached assertion');
    expect(r.stderr).not.toContain('boom');
  });

  it('capture reaches the assertion with the status, last stdout line and stderr tail in the log, emits nothing, and leaves no temp file', () => {
    const r = runScript(`${CANONICAL_CAPTURE_BLOCK}R=$(capture stub)\necho "reached assertion: [$R]"\n`);
    expect(r.status).toBe(0);
    // Empty on purpose: a response that happened to look right must not pass
    // a failed invoke. The old shape aborted; this fails the assertion.
    expect(r.stdout).toContain('reached assertion: []');
    expect(r.stderr).toContain('[verify] command exited 7: stub');
    expect(r.stderr).toContain('[verify] last stdout line: partial');
    expect(r.stderr).toContain('boom: the real cause');
    expect(r.leftovers).toEqual([]);
  });

  it('a good-looking last line does NOT pass a failed invoke (the property the old shape had)', () => {
    const r = runScript(
      `${CANONICAL_CAPTURE_BLOCK}bad() { echo '{"greeting":"hello"}'; echo "teardown failed" >&2; return 1; }\n` +
        'R=$(capture bad)\necho "$R" | grep -q \'"greeting":"hello"\' && echo PASSED || echo FAILED-AS-IT-SHOULD\n',
    );
    expect(r.stdout).toContain('FAILED-AS-IT-SHOULD');
    expect(r.stdout).not.toContain('PASSED');
    expect(r.stderr).toContain('last stdout line: {"greeting":"hello"}');
  });

  it('on success capture emits the last stdout line and leaves no temp file', () => {
    const r = runScript(`${CANONICAL_CAPTURE_BLOCK}ok() { echo one; echo two; }\nR=$(capture ok)\necho "got: [$R]"\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('got: [two]');
    expect(r.stderr).toBe('');
    expect(r.leftovers).toEqual([]);
  });

  it('CONTROL: without the helper\'s rm the shim-backed leftovers check goes red (the check binds)', () => {
    const noRm = CANONICAL_CAPTURE_BLOCK.replace(/\n +rm -f "\$\{err\}"\n/g, '\n');
    expect(noRm).not.toBe(CANONICAL_CAPTURE_BLOCK);
    expect(noRm).not.toContain('rm -f');
    const r = runScript(`${noRm}R=$(capture stub)\n`);
    expect(r.leftovers.length).toBeGreaterThan(0);
  });

  it('an env prefix before capture reaches the command', () => {
    const r = runScript(`${CANONICAL_CAPTURE_BLOCK}show() { echo "region=\${AWS_REGION:-unset}"; }\nR=$(AWS_REGION=US-EAST-1 capture show)\necho "got: [$R]"\n`);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('got: [region=US-EAST-1]');
  });
});
