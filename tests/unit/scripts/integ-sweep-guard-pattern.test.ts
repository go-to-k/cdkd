import { describe, expect, it } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A teardown guard that never accepts its own scope is WORSE than no guard:
 * every delete in these sweeps is `|| true`, so the run leaks its AWS resources
 * and still exits 0, with the WARN buried in an EXIT trap.
 *
 * `Cdkd?*` is the pattern this tree's guarded fixtures happen to need, and it is
 * NOT a house convention — many fixtures use a stack name that does not begin
 * with `Cdkd` (measured 2026-09-06: 36 of 213 literal `STACK=` values, by
 * grepping every fixture's `STACK=` line and counting those not starting
 * `"Cdkd`). Copy-pasted into one of those, the guard refuses permanently and
 * silently.
 *
 * The check RECONSTRUCTS each `case` and runs it, rather than testing patterns
 * one at a time, because the two ways a guard goes inert are both invisible to
 * a per-pattern test: bash takes the FIRST matching arm, so a `*)` arm written
 * above the accepting one swallows every scope; and the WARN can sit on the
 * wrong arm, which inverts the guard while every pattern still looks right.
 *
 * Deliberately narrow. It does not decide whether a guard DOMINATES its sweep,
 * or whether a fixture that needs one has one — that is the classifier tracked
 * as issue #2690. It answers the questions a shipped guard must never get
 * wrong, and it shares no blind spot with that classifier because it EXECUTES
 * the `case` rather than parsing it.
 *
 * `bash -n` is not repeated here: `integ-verify-signal-traps.test.ts` already
 * runs it over the whole fixture population.
 */

const INTEG_ROOT = join(import.meta.dirname, '../../../tests/integration');

/**
 * The WARN text this convention requires, and the reason it is a fixed string
 * rather than "some warning": this fence FINDS a guard by it. A refusal spelled
 * any other way is invisible here, so `docs/integ-fixture-conventions.md` and
 * `.claude/rules/testing.md` both mandate the phrase.
 */
const WARN_SENTINEL = 'teardown sweep refused';

/**
 * Fixtures that carry the sentinel with NO `case` at all, because their refusal
 * is the early-`return` spelling. Named rather than counted: a count cannot say
 * WHICH fixture is exempt, and the exploit this fence now catches turned on
 * exactly that substitutability.
 */
const SENTINEL_WITHOUT_CASE: Readonly<Record<string, string>> = {
  'eventsourcemapping-race': 'guards its own $1 with `if [ -z ]`, the third refusal spelling',
};

/** Bound for a case that spawns bash many times (`.claude/rules/testing.md`). */
const SPAWN_TIMEOUT_MS = 60_000;

/** Fixtures with a `verify.sh`, the same population the sibling suites walk. */
const fixtures = readdirSync(INTEG_ROOT, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(INTEG_ROOT, e.name, 'verify.sh')))
  .map((e) => e.name)
  .sort();

interface Arm {
  /** Every alternative of the arm: `Alpha|Beta` is two patterns, not one. */
  patterns: string[];
  /** The arm's body carries the refusal WARN. */
  warns: boolean;
}

interface Unresolved {
  fixture: string;
  line: number;
  reason: string;
}

interface Guard {
  fixture: string;
  line: number;
  scope: string;
  /** Every arm, catch-all included, in SOURCE ORDER — bash takes the first match. */
  arms: Arm[];
  /** Every scope value this guard can see. Empty when it could not be resolved. */
  literals: string[];
}

/**
 * The scope values a guarded name can hold, read from the fixture's own text.
 * Three sources, in order:
 *
 *   - its nearest `VAR="literal"` assignment ABOVE the guard — a later
 *     reassignment does not describe the value the guard sees;
 *   - a loop variable's sources (`for stack in "${A}" "${B}"`);
 *   - a POSITIONAL, resolved to the Nth argument of every call to the enclosing
 *     function. That is the spelling `docs/integ-fixture-conventions.md`
 *     MANDATES for a parameter-scoped guard, so it has to work rather than
 *     merely be reported.
 *
 * A `${VAR}` inside the literal stands in as a placeholder, so
 * `cdkd-test-array-secret-${ACCOUNT_ID}` is tested the way an account id would
 * leave it rather than as text containing `$`. Returns [] when the scope cannot
 * be read; the caller REPORTS those.
 */
function scopeLiterals(lines: string[], guardLine: number, scope: string): string[] {
  const assignAbove = (name: string, before: number): string | undefined => {
    const re = new RegExp('^\\s*(?:readonly\\s+|local\\s+|export\\s+)?' + name + '="([^"]*)"');
    for (let i = before - 1; i >= 0; i--) {
      const m = re.exec(lines[i]!);
      if (!m) continue;
      // A command substitution is a value this scan cannot know.
      if (m[1]!.includes('$(') || m[1]!.includes('`')) return undefined;
      return m[1]!.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, 'x');
    }
    return undefined;
  };

  if (/^[0-9]+$/.test(scope)) {
    let start = -1;
    for (let i = guardLine - 1; i >= 0; i--) {
      if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{|^function\s+[A-Za-z_][A-Za-z0-9_]*/.test(lines[i]!)) {
        start = i;
        break;
      }
    }
    if (start === -1) return [];
    const fn = /^(?:function\s+)?([A-Za-z_][A-Za-z0-9_]*)/.exec(lines[start]!)?.[1];
    if (fn === undefined) return [];
    const n = Number(scope);
    const out: string[] = [];
    for (let k = 0; k < lines.length; k++) {
      if (k === start) continue;
      if (!new RegExp('(?:^|[\\s;(|&$])' + fn + '\\b').test(lines[k]!)) continue;
      const tail = lines[k]!.slice(lines[k]!.indexOf(fn) + fn.length);
      const args = tail.match(/"[^"]*"|'[^']*'|\S+/g);
      const arg = args?.[n - 1];
      if (arg === undefined) return [];
      const inner = arg.replace(/^["']|["']$/g, '');
      const named = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(inner)?.[1];
      const value = named === undefined ? inner : assignAbove(named, lines.length);
      if (value === undefined || value.includes('$')) return [];
      out.push(value);
    }
    return out;
  }

  const direct = assignAbove(scope, guardLine);
  if (direct !== undefined) return [direct];

  const loop = new RegExp('^\\s*for\\s+' + scope + '\\s+in\\s+([\\s\\S]*?)\\bdo\\b', 'm').exec(
    lines.join('\n'),
  );
  if (!loop) return [];
  const names = [...loop[1]!.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]!);
  const resolved = names.map((n) => assignAbove(n, lines.length));
  // All or nothing: a loop with one unreadable source is not partially known.
  return names.length > 0 && resolved.every((v) => v !== undefined) ? (resolved as string[]) : [];
}

const CASE_OPENER = /^\s*case\s+(.+?)\s+in\b/;
const ARM = /^\s*\(?([^\s()]+(?:\s*\|\s*[^\s()]+)*)\)/;
/** A line that ends an arm pattern but that `ARM` did not recognise. */
const ARM_SHAPED = /\)\s*(?:;;)?\s*$/;

/** The variable a `case` subject names, or undefined when it is not one name. */
function scopeName(subject: string): string | undefined {
  const bare = subject.trim().replace(/^"(.*)"$/s, '$1');
  // `$V`, `${V}`, `${V:-}`, `${V:-x}`, `${V:?msg}`, `$1`, `${1}`.
  const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*|[0-9]+)(?::[-?+=][^}]*)?\}?$/.exec(bare);
  return m?.[1];
}

/**
 * Every `case` whose body carries the refusal WARN, plus every `case` this
 * parser could NOT read. Keying on the WARN rather than a list of fixture names
 * keeps the population derived: a new guard is covered the day it is written.
 *
 * Nothing is `continue`d away once the sentinel is found. Skipping an
 * unrecognised opener hid a live leak behind `case "${STACK:-}" in` — the
 * spelling this repo teaches for a variable read under `set +eu`, which is
 * exactly what `cleanup` is.
 */
function parseGuards(fixture: string, lines: string[]): { guards: Guard[]; unresolved: Unresolved[] } {
  const guards: Guard[] = [];
  const unresolved: Unresolved[] = [];

  for (let i = 0; i < lines.length; i++) {
    const opener = CASE_OPENER.exec(lines[i]!);
    if (!opener) continue;

    // Walk to the matching `esac` FIRST: whether this is a guard at all depends
    // on finding the sentinel inside it.
    const arms: Arm[] = [];
    const skipped: number[] = [];
    let current: Arm | undefined;
    let warns = false;
    let fallsThrough = false;
    let depth = 0;
    let closed = false;
    for (let j = i + 1; j < lines.length; j++) {
      if (CASE_OPENER.test(lines[j]!)) depth++;
      if (/^\s*esac\b/.test(lines[j]!)) {
        if (depth === 0) {
          closed = true;
          break;
        }
        depth--;
        continue;
      }
      if (depth > 0) continue;
      if (/;;?&/.test(lines[j]!)) fallsThrough = true;

      const arm = ARM.exec(lines[j]!);
      if (arm) {
        current = { patterns: arm[1]!.split('|').map((p) => p.trim()), warns: false };
        arms.push(current);
      } else if (ARM_SHAPED.test(lines[j]!) && !/^\s*(?:esac|;;|fi|done|\))/.test(lines[j]!.trim())) {
        // Ends like an arm but did not parse as one: report, never ignore.
        skipped.push(j + 1);
      }
      if (current && lines[j]!.includes(WARN_SENTINEL)) {
        current.warns = true;
        warns = true;
      }
    }

    if (!warns) continue; // an ordinary `case`, not a guard
    const at = { fixture, line: i + 1 };
    if (!closed) {
      unresolved.push({ ...at, reason: 'case has no matching esac' });
      continue;
    }
    if (fallsThrough) {
      // `;&` / `;;&` fall INTO the next arm, so reconstructing every arm with
      // `;;` reports the wrong one. Measured: such a guard really reaches its
      // warning arm and is inert while the fence read arm 0 and passed.
      unresolved.push({ ...at, reason: 'case uses ;& / ;;& fall-through' });
      continue;
    }
    if (skipped.length > 0) {
      unresolved.push({ ...at, reason: 'unparsed arm line(s) ' + skipped.join(', ') });
      continue;
    }
    const scope = scopeName(opener[1]!);
    if (scope === undefined) {
      unresolved.push({ ...at, reason: 'unreadable case subject ' + opener[1]! });
      continue;
    }
    guards.push({ ...at, scope, arms, literals: scopeLiterals(lines, i, scope) });
  }

  return { guards, unresolved };
}

function readFixture(fixture: string): { guards: Guard[]; unresolved: Unresolved[] } {
  return parseGuards(fixture, readFileSync(join(INTEG_ROOT, fixture, 'verify.sh'), 'utf8').split('\n'));
}

/**
 * Runs the guard's `case` for real and reports which arm bash selected, or
 * `undefined` when none did.
 *
 * Every pattern is passed as a POSITIONAL and referenced as `${N}` in the case
 * body, so bash expands it once and uses the result as a pattern. Interpolating
 * it into the script SOURCE would execute a pattern containing a backtick or
 * a command substitution, and would silently mis-evaluate the very shape the
 * convention forbids: a pattern that is itself an expansion becomes `*` inside
 * the fence and makes the accept assertion pass vacuously.
 *
 * Each ALTERNATIVE gets its own positional. An expanded `|` is not alternation,
 * so passing `Alpha|Beta` whole would send `Beta` to the catch-all — loud for an
 * allowlist, silent for a denylist-shaped guard.
 */
function matchedArm(arms: readonly Arm[], value: string, shell = 'bash'): number | undefined {
  const positionals: string[] = [];
  const body = arms
    .map((arm, index) => {
      const refs = arm.patterns.map((p) => {
        positionals.push(p);
        return '${' + String(positionals.length + 1) + '}';
      });
      return '  ' + refs.join('|') + ') echo ' + String(index) + ' ;;';
    })
    .join('\n');
  const res = spawnSync(
    shell,
    ['-c', 'case "$1" in\n' + body + '\nesac', 'probe', value, ...positionals],
    { encoding: 'utf8', timeout: 10_000 },
  );
  // A spawn that never ran must not read as "matched nothing".
  if (res.error || res.status !== 0) {
    throw new Error('bash probe failed: ' + (res.error?.message ?? 'status ' + String(res.status)));
  }
  const out = res.stdout.trim();
  return out === '' ? undefined : Number(out);
}

const parsed = fixtures.map((f) => readFixture(f));
const guards = parsed.flatMap((p) => p.guards);
const unresolved = parsed.flatMap((p) => p.unresolved);

describe('integ teardown scope guards', () => {
  it('reads every guard it can see, and reports every one it cannot', () => {
    // A `case` this parser cannot read is REPORTED, never skipped. Skipping it
    // hid a live leak behind a `case "${STACK:-}" in` opener with the suite
    // green — which is also why there is no `guards.length >= N` floor here any
    // more: an aggregate count is exactly what that exploit satisfied, by
    // adding a correct guard elsewhere.
    const problems = [
      ...unresolved.map((u) => `${u.fixture}:${u.line} ${u.reason}`),
      ...guards
        .filter((g) => g.literals.length === 0)
        .map((g) => `${g.fixture}:${g.line} could not resolve the scope of ${g.scope}`),
    ];
    expect(problems).toEqual([]);
  });

  it('every fixture carrying the WARN yields a guard, or is a named exemption', () => {
    // Reconciled against RAW TEXT, so a guard that never parsed cannot be
    // invisible to both the population and the report above.
    const missing: string[] = [];
    for (const fixture of fixtures) {
      const body = readFileSync(join(INTEG_ROOT, fixture, 'verify.sh'), 'utf8');
      if (!body.includes(WARN_SENTINEL)) continue;
      if (guards.some((g) => g.fixture === fixture)) continue;
      if (fixture in SENTINEL_WITHOUT_CASE) {
        // The exemption has to stay TRUE: a `case` appearing here later means
        // the fixture is no longer exempt and must parse like the rest.
        if (CASE_OPENER.test(body)) {
          missing.push(`${fixture} is exempted as having no \`case\` guard, but now has one`);
        }
        continue;
      }
      missing.push(`${fixture} carries the refusal WARN but yielded no guard`);
    }
    expect(missing).toEqual([]);
  });

  it(
    'every guard accepts its own fixture scope, in a non-refusing arm',
    { timeout: SPAWN_TIMEOUT_MS },
    () => {
      const inert = guards.flatMap((g) =>
        g.literals.flatMap((lit) => {
          const k = matchedArm(g.arms, lit);
          if (k === undefined) {
            return [`${g.fixture}: ${g.scope}="${lit}" matches NO arm of the guard`];
          }
          const arm = g.arms[k]!;
          // Order matters: bash takes the first match, so a `*)` above the
          // accepting arm swallows the real scope and the sweep never runs. A
          // guard whose scope could not be read is not silently absent here —
          // it is already a failure of the first case in this file.
          if (arm.patterns.includes('*') || arm.warns) {
            return [
              `${g.fixture}: ${g.scope}="${lit}" lands in the REFUSING arm ${arm.patterns.join('|')})`,
            ];
          }
          return [];
        }),
      );
      expect(inert).toEqual([]);
    },
  );

  it(
    'every guard sends the EMPTY scope to the refusing arm',
    { timeout: SPAWN_TIMEOUT_MS },
    () => {
      const permissive = guards.flatMap((g) => {
        const k = matchedArm(g.arms, '');
        if (k === undefined) {
          return [`${g.fixture}:${g.line} EMPTY scope matches no arm — the case falls through`];
        }
        const arm = g.arms[k]!;
        return arm.warns
          ? []
          : [`${g.fixture}:${g.line} EMPTY scope lands in ${arm.patterns.join('|')}), which does not refuse`];
      });
      expect(permissive).toEqual([]);
    },
  );

  describe('a guard this parser cannot read is REPORTED, never dropped', () => {
    const sweep = [
      '      for q in $(aws sqs list-queues --queue-name-prefix "${STACK}"); do',
      '        aws sqs delete-queue --queue-url "${q}" || true',
      '      done',
      '      ;;',
    ];
    const warnArm = [
      '    *)',
      '      echo "    WARN: teardown sweep refused a stack scope" >&2',
      '      ;;',
    ];

    it('THE EXPLOIT: a live leak behind an opener the parser did not know', () => {
      // A reviewer built this by hand twice: catch-all FIRST, so an empty
      // `STACK` sweeps every queue in the account, hidden behind a
      // `case "${STACK:-}" in` opener an earlier parser skipped. It was green.
      // `${V:-}` now parses, so the leak is caught directly by arm order; an
      // opener that still cannot be read is reported instead of vanishing.
      const lines = [
        'STACK="CdkdFooExample"',
        'cleanup() {',
        '  case "${STACK:-}" in',
        ...warnArm,
        '    Cdkd?*)',
        ...sweep,
        '  esac',
        '}',
      ];
      const { guards: g, unresolved: u } = parseGuards('probe', lines);
      expect(u).toEqual([]);
      expect(g).toHaveLength(1);
      // The catch-all is first, so the fixture's own scope lands in it.
      expect(matchedArm(g[0]!.arms, 'CdkdFooExample')).toBe(0);
      expect(g[0]!.arms[0]!.warns).toBe(true);
    });

    it.each([
      ['a subject that is not one name', 'case "${A}${B}" in'],
      ['a subject that is a command substitution', 'case "$(get_scope)" in'],
      ['a quoted-literal subject', "case '${STACK}' in"],
    ])('reports %s', (_label, opener) => {
      const { guards: g, unresolved: u } = parseGuards('probe', [
        'STACK="CdkdFooExample"',
        'cleanup() {',
        `  ${opener}`,
        '    Cdkd?*)',
        ...sweep,
        ...warnArm,
        '  esac',
        '}',
      ]);
      expect(g).toHaveLength(0);
      expect(u).toHaveLength(1);
      expect(u[0]!.reason).toMatch(/unreadable case subject/);
    });

    it('reports a `;&` fall-through instead of reconstructing it as `;;`', () => {
      // Measured: `Cdkd?*) … ;& *) warn ;;` really reaches the warning arm and
      // the guard is inert — the #2621 bug itself — while a reconstruction that
      // emits `;;` for every arm reports arm 0 and passes.
      const { guards: g, unresolved: u } = parseGuards('probe', [
        'STACK="CdkdFooExample"',
        'cleanup() {',
        '  case "${STACK}" in',
        '    Cdkd?*)',
        '      echo sweeping',
        '      ;&',
        ...warnArm,
        '  esac',
        '}',
      ]);
      expect(g).toHaveLength(0);
      expect(u[0]!.reason).toMatch(/fall-through/);
    });

    it('reports an arm-shaped line it could not parse', () => {
      // Ends like an arm but does not parse as one. Ignoring it would leave the
      // arm list short and the reconstruction wrong, silently.
      const { guards: g, unresolved: u } = parseGuards('probe', [
        'STACK="CdkdFooExample"',
        'cleanup() {',
        '  case "${STACK}" in',
        '    Cdkd Foo?*)',
        '      echo sweeping',
        '      ;;',
        ...warnArm,
        '  esac',
        '}',
      ]);
      expect(g).toHaveLength(0);
      expect(u[0]!.reason).toMatch(/unparsed arm line/);
    });

    it('keeps every ALTERNATIVE of a multi-pattern arm', () => {
      // An expanded `|` is not alternation. Passing `Alpha|Beta` whole sends
      // `Beta` to the catch-all — loud for an allowlist, SILENT for a
      // denylist-shaped guard whose catch-all does the sweeping.
      const { guards: g } = parseGuards('probe', [
        'STACK="Beta"',
        'cleanup() {',
        '  case "${STACK}" in',
        '    Alpha|Beta)',
        '      echo sweeping',
        '      ;;',
        ...warnArm,
        '  esac',
        '}',
      ]);
      expect(g[0]!.arms[0]!.patterns).toEqual(['Alpha', 'Beta']);
      expect(matchedArm(g[0]!.arms, 'Beta')).toBe(0);
    });

    it('reports a `case` with no `esac`', () => {
      const { guards: g, unresolved: u } = parseGuards('probe', [
        'STACK="CdkdFooExample"',
        '  case "${STACK}" in',
        '    Cdkd?*)',
        ...sweep,
        ...warnArm,
      ]);
      expect(g).toHaveLength(0);
      expect(u[0]!.reason).toMatch(/no matching esac/);
    });

    it('resolves a POSITIONAL scope through the caller, as the doc mandates', () => {
      const { guards: g, unresolved: u } = parseGuards('probe', [
        'LG_PREFIX="/cdkd-integ/probe/"',
        'sweep_for() {',
        '  case "$1" in',
        '    /cdkd-integ/*/)',
        '      echo sweeping',
        '      ;;',
        ...warnArm,
        '  esac',
        '}',
        'cleanup() {',
        '  sweep_for "${LG_PREFIX}"',
        '}',
      ]);
      expect(u).toEqual([]);
      expect(g[0]!.literals).toEqual(['/cdkd-integ/probe/']);
    });
  });

  it('finds a plausible fixture population', () => {
    expect(fixtures.length).toBeGreaterThan(240);
  });

  it('the matcher discriminates on ORDER, alternation and which arm refuses', () => {
    // Without these, a `matchedArm` that always returned 0 would satisfy the
    // accept case and one that always returned the last arm would satisfy the
    // refuse case, and neither assertion above would mean anything.
    const accept: Arm = { patterns: ['Cdkd?*'], warns: false };
    const refuse: Arm = { patterns: ['*'], warns: true };
    expect(matchedArm([accept, refuse], 'CdkdFooExample')).toBe(0);
    expect(matchedArm([accept, refuse], '')).toBe(1);
    // Order reversed: the catch-all now swallows the real scope.
    expect(matchedArm([refuse, accept], 'CdkdFooExample')).toBe(0);
    // An expanded `|` is not alternation — each alternative needs its own
    // positional, or `Beta` falls through to the catch-all.
    const alts: Arm = { patterns: ['Alpha', 'Beta'], warns: false };
    expect(matchedArm([alts, refuse], 'Alpha')).toBe(0);
    expect(matchedArm([alts, refuse], 'Beta')).toBe(0);
    expect(matchedArm([alts, refuse], 'Gamma')).toBe(1);
    expect(matchedArm([accept], 'ApiGatewayStack')).toBeUndefined();
  });

  it('a bash probe that could not run THROWS rather than reading as no match', () => {
    // Fail-closed: a spawn failure must not be indistinguishable from "the
    // scope matched no arm", which is itself a reported failure. Driven by
    // pointing the probe at a shell that does not exist, which is the only way
    // to reach that branch without breaking the real one.
    expect(() =>
      matchedArm([{ patterns: ['Cdkd?*'], warns: false }], 'x', '/nonexistent/bash'),
    ).toThrow(/bash probe failed/);
  });

  it('passes patterns as data, not as script source', () => {
    // The pattern reaches bash as a positional. Interpolated into the script it
    // would EXECUTE: this exact shape created a file when measured. The witness
    // path is per-run rather than a fixed `/tmp` name, which parallel lanes
    // share.
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-fence-'));
    const witness = join(dir, 'executed');
    try {
      const probe: Arm = { patterns: ['`echo pwned > ' + witness + '`x*'], warns: false };
      expect(() => matchedArm([probe], 'x')).not.toThrow();
      expect(existsSync(witness), 'the pattern was executed as script source').toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
