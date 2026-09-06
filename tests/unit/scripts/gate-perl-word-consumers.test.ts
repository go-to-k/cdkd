import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * `GATE_PERL_WORD` in `.claude/hooks/lib/command-match.sh` is one shared shell
 * literal that several BLOCKING gates interpolate into `perl -0777` programs.
 * Two failure modes are invisible from any single file, and both were live:
 *
 *   1. **The canonical comment undercounts its own consumers.** The header said
 *      "Three gates -- issue-deferral-criteria, gh-body-english,
 *      issue-dup-check" while FIVE files consumed the constant; the two it
 *      omitted are exactly the ones a maintainer would then not check when
 *      fixing an extraction bug. That is the stale-sibling-note class the
 *      constant was introduced to end, reappearing in the constant's own home.
 *
 *   2. **A perl program calls a helper it does not define.** These programs are
 *      SHELL-QUOTED STRINGS, so nothing type-checks them, and every one runs
 *      with `2>/dev/null`. A program calling `line_writes(...)` without the
 *      `sub` in the same `perl -e` string dies on "Undefined subroutine",
 *      writes nothing, and the caller reads the non-zero exit as "the command
 *      does not write this path" -- a silent wrong answer. Measured while
 *      writing this: a refactor left two of `pr-body-item-number-gate.sh`'s
 *      three programs in exactly that state, and every shell suite stayed
 *      green, because the affected shapes had no case.
 *
 * Both halves are structural, so they belong in CI rather than in a sentence.
 * Same invariant shape as `cross-cutting-list-sync.test.ts`: two places must
 * describe the same set, and neither may drift alone.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HOOKS = join(repoRoot, '.claude', 'hooks');
const LIB = join(HOOKS, 'lib', 'command-match.sh');

/** Every gate hook (never a `*.test.sh`) that interpolates the shared prelude. */
function consumers(): string[] {
  return readdirSync(HOOKS)
    .filter((f) => f.endsWith('.sh') && !f.endsWith('.test.sh'))
    .filter((f) => readFileSync(join(HOOKS, f), 'utf8').includes('GATE_PERL_WORD'))
    .sort();
}

/**
 * The `perl -e '...'` programs in one hook. Each is the single-quoted string
 * between `perl [flags] -e ['|"$GATE_PERL_WORD"']` and the closing `' `, which
 * is unambiguous here because a literal single quote cannot appear inside a
 * bash single-quoted string.
 */
function perlPrograms(source: string): { body: string; whole: string }[] {
  // `-\S*e\s` and not `-e\s`: the flag is routinely FUSED (`perl -0777 -ne`,
  // `perl -ne`), and requiring a standalone `-e` token silently matched 0 of
  // issue-dup-check's and issue-classification-label's programs -- the
  // no-prelude assertion below was vacuous for two of the five consumers.
  // ONE-LINE programs first. Without that alternative a `perl -pe '...'`
  // whose program has no `2>/dev/null` swallowed everything down to the next
  // terminator -- measured, one such helper produced a 7,914-character
  // "program" spanning three real ones, and the offender indices this test
  // prints named the wrong function.
  const re =
    /perl\s+(?:-\S+\s+)*-\S*e\s+(?:"\$GATE_PERL_WORD")?(?:'([^'\n]*)'|'([\s\S]*?)'\s*2>\/dev\/null)/g;
  return [...source.matchAll(re)].map((m) => ({ body: m[1] ?? m[2] ?? '', whole: m[0] }));
}

describe('GATE_PERL_WORD consumers', () => {
  it('the library header names the same count as the tree', () => {
    const found = consumers();
    // Five today. Asserted as a NUMBER WORD against the header sentence rather
    // than as a hard-coded 5 here: the point is that the two agree, so adding a
    // sixth consumer must update the sentence, not this file.
    const words: Record<number, string> = {
      1: 'ONE',
      2: 'TWO',
      3: 'THREE',
      4: 'FOUR',
      5: 'FIVE',
      6: 'SIX',
      7: 'SEVEN',
      8: 'EIGHT',
    };
    const word = words[found.length];
    expect(word, `no spelling for ${found.length} consumers`).toBeDefined();
    const lib = readFileSync(LIB, 'utf8');
    // The claim sits in the "A shell WORD, for the gates that extract with
    // PERL" block; match case-insensitively so `FIVE gates` / `Five gates`
    // both satisfy it while `Three gates` does not.
    expect(
      new RegExp(`\\b${word}\\s+gates\\b`, 'i').test(lib),
      `command-match.sh should say "${word} gates"; consumers are:\n  ${found.join('\n  ')}`,
    ).toBe(true);
  });

  it('the library header names every consumer by name', () => {
    const lib = readFileSync(LIB, 'utf8');
    for (const f of consumers()) {
      const stem = f.replace(/-gate\.sh$/, '').replace(/\.sh$/, '');
      expect(lib.includes(stem), `command-match.sh does not name ${f}`).toBe(true);
    }
  });
});

describe('perl programs are self-contained', () => {
  it('every program calling line_writes reaches it through the prelude', () => {
    // `line_writes` USED to be defined inside each program, and this fence
    // required that. Nine byte-identical copies shipped that way -- in a file
    // whose own comment called a private copy "the shape this whole change
    // exists to retire" -- so it moved into `GATE_PERL_WORD`, and the
    // invariant moved with it: a program may no longer define it privately,
    // and must interpolate the prelude that does.
    const offenders: string[] = [];
    for (const f of consumers()) {
      const src = readFileSync(join(HOOKS, f), 'utf8');
      perlPrograms(src).forEach(({ body, whole }, i) => {
        // The prelude marker is interpolated at the SHELL level, so it belongs
        // to the INVOCATION -- between `-e` and the opening quote -- and never
        // to the program body. Scoped to exactly that span: `whole.includes()`
        // is satisfiable by the BODY, so a program could drop the marker from
        // its invocation and mention it in a comment instead (measured: that
        // mutant read CLEAN). The revision before this one looked at the 60
        // characters before the BODY, which was correct and which the comment
        // replacing it wrongly called never-true -- this restores that reach
        // and bounds it exactly.
        const hasPrelude = whole.slice(0, whole.indexOf("'")).includes('"$GATE_PERL_WORD"');
        if (body.includes('line_writes(')) {
          if (body.includes('sub line_writes')) {
            offenders.push(`${f} program #${i}: defines line_writes privately again`);
          }
          if (!body.includes('my $want')) offenders.push(`${f} program #${i}: no $want`);
          if (!hasPrelude) {
            offenders.push(`${f} program #${i}: calls line_writes without the prelude`);
          }
        }
        if ((body.includes('$GW') || body.includes('gate_unq(')) && !hasPrelude) {
          offenders.push(`${f} program #${i}: uses $GW/gate_unq without the prelude`);
        }
      });
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the extractor reaches every perl invocation in every consumer', () => {
    // The extractor terminates a multi-line program on `' 2>/dev/null`, so a
    // NEW program without that terminator is INVISIBLE to the fence above --
    // exactly the class it exists to catch. Measured: a `perl -0777 -e` with
    // no prelude and no terminator, calling `line_writes`, read CLEAN; at
    // runtime it dies on "Undefined subroutine", writes nothing, and the
    // caller reads the non-zero exit as "does not write this path".
    //
    // Counting invocations against extractions is the check the fence itself
    // cannot make: it can only judge what it managed to parse.
    const offenders: string[] = [];
    for (const f of consumers()) {
      const src = readFileSync(join(HOOKS, f), 'utf8');
      const invocations = [...src.matchAll(/perl\s+(?:-\S+\s+)*-\S*e\s+(?:"\$GATE_PERL_WORD")?'/g)].length;
      const extracted = perlPrograms(src).length;
      if (invocations !== extracted) {
        offenders.push(`${f}: ${invocations} perl invocations, ${extracted} extracted`);
      }
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('every consumer guards the prelude functionally, at top level', () => {
    const offenders: string[] = [];
    for (const f of consumers()) {
      const src = readFileSync(join(HOOKS, f), 'utf8');
      // The cheap non-empty check is not enough on its own (a present but
      // non-compiling prelude is silent), and the functional probe must sit at
      // TOP LEVEL: these gates call their extraction helpers inside `$( )`,
      // where `exit 2` ends only the substitution subshell. Measured: an
      // in-function guard PRINTED its refusal and the hook still returned 0.
      const call = src.match(/^gate_perl_word_or_die \S+ \|\| exit 2$/m);
      if (!call) offenders.push(`${f}: no top-level \`gate_perl_word_or_die ... || exit 2\``);
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });
});
