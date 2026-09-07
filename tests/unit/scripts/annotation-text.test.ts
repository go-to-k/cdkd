import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { foldAnnotationText, LINE_BREAKING_CHARS } from '../../../scripts/annotation-text.ts';
import {
  formatAnnotation as formatInternalLabels,
  formatFoundRow as foundRowInternalLabels,
  scanChangedFiles as scanInternalLabels,
} from '../../../scripts/check-pr-internal-labels.ts';
import {
  formatAnnotation as formatNonEnglish,
  formatFoundRow as foundRowNonEnglish,
  scanChangedFiles as scanNonEnglish,
} from '../../../scripts/check-pr-non-english-text.ts';
import { fencedQuote } from '../../../scripts/check-gh-body-english.ts';
import { formatFailure } from '../../../scripts/check-pr-title-prefix-scope.ts';

/**
 * The GitHub Actions runner reads WORKFLOW COMMANDS out of a step's own output:
 * it splits the stream into lines, trims each, and treats one beginning `::` as
 * a command. Every check in this family echoes attacker-controlled text into an
 * annotation -- a PR body, or a line of a fork PR's file content.
 *
 * Each echoed line is PREFIXED, so a payload cannot reach column 0 -- unless it
 * can forge a LINE BREAK. Then everything after the break is a fresh line the
 * runner parses on its own terms, and `::stop-commands::` / `::add-mask::`
 * become injectable.
 *
 * Measured 2026-09-07, before go-to-k/cdkd#2736 closed it, the three checks
 * disagreed three ways: one folded a single field, one stripped only a TRAILING
 * carriage return, one stripped nothing.
 *
 * Every character below is built with `String.fromCodePoint`. This file would
 * otherwise carry bytes no diff can render, in the suite whose whole subject is
 * exactly that -- the discipline `pr-non-english-text.test.ts` states and pins.
 */
const cp = String.fromCodePoint;

const BREAKING: ReadonlyArray<readonly [string, number]> = [
  ['CR', 0x0d],
  ['LF', 0x0a],
  ['U+2028 LINE SEPARATOR', 0x2028],
  ['U+2029 PARAGRAPH SEPARATOR', 0x2029],
  ['U+0085 NEL', 0x85],
  ['vertical tab', 0x0b],
  ['form feed', 0x0c],
];

const KEPT: ReadonlyArray<readonly [string, number]> = [
  ['TAB', 0x09],
  ['NUL', 0x00],
  ['space', 0x20],
  ['BEL', 0x07],
];

describe('foldAnnotationText', () => {
  it.each(BREAKING.map(([n, c]) => [n, c] as const))('folds %s to a space', (_n, code) => {
    expect(foldAnnotationText(`a${cp(code)}b`)).toBe('a b');
  });

  it.each(KEPT.map(([n, c]) => [n, c] as const))('leaves %s alone', (_n, code) => {
    // A checker REPORTS what it found; it must not quietly rewrite the finding
    // beyond the one property it needs. None of these can break a line.
    expect(foldAnnotationText(`a${cp(code)}b`)).toBe(`a${cp(code)}b`);
  });

  it('folds every occurrence, not just the first', () => {
    // The `g` flag. Without it only the first break is folded and the second
    // still starts a line.
    expect(foldAnnotationText(`a${cp(0x0d)}b${cp(0x0d)}c`)).toBe('a b c');
  });

  it('folds to a SPACE rather than deleting', () => {
    // Deleting silently changes the text a human is being shown, and quoting
    // the offending line accurately is the annotation's whole job.
    expect(foldAnnotationText(`one${cp(0x0d)}two`)).toBe('one two');
  });

  it('folds correctly even when the shared regex carries state', () => {
    // The previous form asserted `LINE_BREAKING_CHARS.lastIndex === 0` after a
    // fold, and MEASURED, that is unfalsifiable: `String.prototype.replace`
    // resets `lastIndex` for global, non-global and sticky regexes alike, so no
    // class or flag mutation could red it. Two identical calls agreeing was
    // equally inert.
    //
    // This form can fail. The constant is EXPORTED and shared, so a future
    // consumer using `.test()` or an `.exec()` loop leaves `lastIndex` advanced;
    // seeding it here is that future, today.
    LINE_BREAKING_CHARS.lastIndex = 5;
    expect(foldAnnotationText(`a${cp(0x0d)}b`)).toBe('a b');
    LINE_BREAKING_CHARS.lastIndex = 0;
  });
});

describe('no checker in this family can emit a forged workflow command', () => {
  const forge = `${cp(0x0d)}::stop-commands::abcd`;

  const startsACommand = (rendered: string): boolean =>
    rendered.split(/\r\n|\r|\n/).some((l) => l.trimStart().startsWith('::stop-commands::'));

  it('check-pr-non-english-text: a CR in the file line cannot start a line', () => {
    const out = formatNonEnglish({
      file: 'docs/x.md',
      line: 7,
      text: `text${forge}`,
    });
    expect(startsACommand(out)).toBe(false);
    expect(out).toContain('docs/x.md');
  });

  it('check-pr-internal-labels: neither the hit nor the line can start one', () => {
    // BOTH fields are file-derived here, and an earlier fix folded only one of
    // them in the sibling check -- so both directions are asserted.
    expect(
      startsACommand(
        formatInternalLabels({ file: 'README.md', line: 3, hit: '(PR 8b)', text: `t${forge}` }),
      ),
    ).toBe(false);
    expect(
      startsACommand(
        formatInternalLabels({ file: 'README.md', line: 3, hit: `(PR 8b)${forge}`, text: 't' }),
      ),
    ).toBe(false);
  });

  it('check-pr-title-prefix-scope: a fork PR FILE PATH cannot start one', () => {
    // The fourth emitter, and the one nobody listed by hand -- the derived
    // fence below found it on its first run. Git permits a carriage return in
    // a filename and these paths come from the fork PR's own diff.
    const out = formatFailure({
      prefix: 'feat',
      suggestedPrefix: 'chore',
      files: [`docs/x${forge}.md`],
      ok: false,
    } as Parameters<typeof formatFailure>[0]);
    expect(startsACommand(out)).toBe(false);
    expect(out).toContain('docs/x');
  });

  it.each([
    ['check-pr-non-english-text', 'nonEnglish'],
    ['check-pr-internal-labels', 'internalLabels'],
  ])('%s folds the FILE PATH, which has no construction-time twin', (_n, which) => {
    // `o.text` is folded twice (construction and emitter) so each masks the
    // other; `o.file` is folded ONLY at the emitter, so removing it is a live
    // regression -- and removing all four `foldAnnotationText(o.file)` calls
    // passed the whole suite (measured, go-to-k/cdkd#2736 round-4 review).
    const evil = `docs/a${forge}.md`;
    const out =
      which === 'nonEnglish'
        ? formatNonEnglish({ file: evil, line: 1, text: 'x' })
        : formatInternalLabels({ file: evil, line: 1, hit: '(PR 8b)', text: 'x' });
    expect(out).not.toContain(cp(0x0d));
    // The annotation legitimately BEGINS with `::error`, so "no line starts a
    // command" cannot be the assertion here -- the payload must simply be gone.
    expect(out).toContain('docs/a');
  });

  it.each([
    ['check-pr-non-english-text', foundRowNonEnglish],
    ['check-pr-internal-labels', foundRowInternalLabels],
  ])("%s's Found: row survives a path NAMED like a command", (_n, fmt) => {
    // No control character needed: `git diff --name-only` C-quotes control
    // bytes but never `:`, `,`, `=` or a space, so a fork PR can add a file
    // literally named `::error file=...::...`. Folding is powerless there --
    // the `- ` marker is what stops it, because the runner TRIM-STARTS before
    // matching and a whitespace indent protects nothing.
    const named = '::error file=src/index.ts,line=1::CI self-check FAILED';
    const row = fmt({ file: named, line: 7, hit: '(PR 8b)', text: 'text' } as never);
    expect(row.trimStart().startsWith('::')).toBe(false);
    expect(row).toContain(named);
    // Control: the same row WITHOUT a non-whitespace marker is the exposure.
    expect(`  ${named}:7: text`.trimStart().startsWith('::')).toBe(true);
  });

  it.each([
    ['check-pr-non-english-text', foundRowNonEnglish],
    ['check-pr-internal-labels', foundRowInternalLabels],
  ])("%s's Found: row folds a break too", (_n, fmt) => {
    const row = fmt({ file: `docs/a${forge}.md`, line: 1, hit: 'h', text: 'x' } as never);
    expect(row).not.toContain(cp(0x0d));
  });

  it.each([
    ['check-pr-internal-labels', (f: string) => scanInternalLabels([f], () => null, () => '')],
    ['check-pr-non-english-text', (f: string) => scanNonEnglish([f], [], () => null)],
  ])("%s's refusal message folds the path it names", (_n, scan) => {
    // A THIRD echo per file, reached by neither fold until now: the
    // `cannot read <path>` throw, whose message the catch prints straight into
    // `::error::`. Reachable from a fork PR adding a file whose name has a
    // LEADING SPACE (legal in git) -- `resolveDiffScope` trims it, the trimmed
    // path is not in the head tree, the read returns null, and the throw
    // carries the raw name (go-to-k/cdkd#2736 round-4 code review).
    const evil = `docs/a${forge}.md`;
    let message = '';
    try {
      scan(evil);
      throw new Error('expected scanChangedFiles to refuse an unreadable in-scope file');
    } catch (err) {
      message = (err as Error).message;
    }
    // Asserted on the CAUGHT message. `toThrowError(expect.not.stringContaining(...))`
    // was the first spelling and it did NOT discriminate -- the mutant passed
    // 35 of 35 (measured). An asymmetric matcher there is not the negative it
    // reads as.
    expect(message, 'the refusal must name the file it could not read').toContain('docs/a');
    expect(message, 'and must not carry a line break out of it').not.toContain(cp(0x0d));
    expect(
      message.split(/\r\n|\r|\n/).some((l) => l.trimStart().startsWith('::')),
      'the refusal is printed straight into ::error::',
    ).toBe(false);
  });

  it('formatFailure rows fold their paths', () => {
    const row = formatFailure({
      prefix: 'feat',
      suggestedPrefix: 'chore',
      files: [`docs/a${forge}.md`],
      ok: false,
    } as Parameters<typeof formatFailure>[0]);
    expect(row).not.toContain(cp(0x0d));
    expect(row).toContain('docs/a');
  });

  it('the control: an unfolded string DOES start a command', () => {
    // Without this every case above passes for a `startsACommand` that always
    // returns false.
    expect(startsACommand(`::error::x${forge}`)).toBe(true);
  });
});

describe('the rule reaches every checker that emits an annotation', () => {
  it('the set of annotation emitters is exactly the set that folds', () => {
    // DERIVED from the directory, so a FIFTH sibling written next year is caught
    // rather than silently starting a fifth answer -- which is how the first
    // four drifted apart.
    //
    // Three corrections from the round-3 review, each a way the first version
    // could miss:
    //   - the detector required a BACKTICK before `::`, so
    //     `console.error('::error::' + x)` was invisible. Any of the three
    //     quote characters now counts.
    //   - comment lines are stripped, so a file merely DISCUSSING `::error` is
    //     not forced to import.
    //   - the population was floored at `> 2` against an actual 4, which
    //     tolerated one emitter silently dropping out of the scan. The sorted
    //     list is pinned instead.
    //
    // It still tests IMPORT, not application -- an unused import satisfies it,
    // and the round-1 state of closes-paren (one field folded, one raw) would
    // have passed. That is why it stands beside the behavioural cases above and
    // never instead of them; its job is only "somebody remembered this file".
    const dir = join(import.meta.dirname, '../../../scripts');
    const codeOf = (f: string): string =>
      readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
        .join('\n');

    const emitters = readdirSync(dir)
      .filter((f) => /^check-(pr|issue|gh)-.*\.ts$/.test(f))
      .filter((f) => /['"`]::(error|warning|notice)/.test(codeOf(f)))
      .sort();

    expect(emitters, 'the emitter population changed -- decide, do not re-floor').toEqual([
      'check-pr-closes-paren.ts',
      'check-pr-internal-labels.ts',
      'check-pr-non-english-text.ts',
      'check-pr-title-prefix-scope.ts',
    ]);

    const missing = emitters.filter((f) => !codeOf(f).includes("from './annotation-text.ts'"));
    expect(missing, 'these emit workflow commands without the shared fold').toEqual([]);
  });

  it.each([
    ['U+2028', 0x2028],
    ['U+2029', 0x2029],
    ['U+0085', 0x85],
    ['vertical tab', 0x0b],
    ['form feed', 0x0c],
  ])('fencedQuote folds %s, which its own private version did not', (_label, code) => {
    // The BEHAVIOURAL half of the delegation. Restoring `fencedQuote`'s private
    // `/[\r\n]+/g` is indistinguishable for CR and LF, so only the wider
    // characters can tell the two apart -- and without this, swapping the
    // shared fold back out passed everything (measured).
    //
    // `fencedQuote`'s output is posted as an issue COMMENT and printed to the
    // log by a job holding `issues: write` that any GitHub user can trigger, so
    // it is the highest-privilege member of this family.
    const quoted = fencedQuote(`before${String.fromCodePoint(code)}after`);
    expect(quoted).not.toContain(String.fromCodePoint(code));
    expect(quoted).toContain('before after');
  });

  it('fencedQuote collapses a RUN of breaks to exactly one space', () => {
    // `foldAnnotationRuns`, not `foldAnnotationText`: the per-character fold
    // turns CRLF into TWO spaces, which the private version it replaced did
    // not. Swapping them back passed every other case here (measured), because
    // they differ only in run handling.
    expect(fencedQuote(`a${cp(0x0d)}${cp(0x0a)}b`)).toContain('a b');
    expect(fencedQuote(`a${cp(0x0d)}${cp(0x0a)}b`)).not.toContain('a  b');
  });

  it('fencedQuote leaves runs it did NOT create alone', () => {
    // The other direction, and it is why `.replace(/ +/g, ' ')` was wrong:
    // collapsing every space run silently re-indents code and mis-aligns
    // tables inside a fence whose whole purpose is preserving them.
    expect(fencedQuote('    const x = 1;  // note')).toContain('    const x = 1;  // note');
  });

  it('the fold reaches the family half that emits no `::` at all', () => {
    // `check-gh-body-english.ts` and `check-issue-*.ts` write no workflow
    // command, so the scan above cannot see them -- but their output is `cat`ed
    // into the log by `issue-conventions.yml`, in the two jobs that hold
    // `issues: write` and that ANY GitHub user can trigger via `issue_comment`.
    // They were safe only through `fencedQuote`'s own private fold, which is
    // exactly the drift this module exists to end (round-3 security review).
    const dir = join(import.meta.dirname, '../../../scripts');
    expect(
      readFileSync(join(dir, 'check-gh-body-english.ts'), 'utf8'),
      'fencedQuote must delegate to the shared fold, not re-implement it',
    ).toContain("from './annotation-text.ts'");
  });
});
