import { describe, it, expect, vi } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_REPORT,
  NON_ENGLISH_RE,
  containsNonEnglish,
  formatReport,
  offendingCharacters,
  scanField,
  scanSubject,
} from '../../../scripts/check-gh-body-english.js';
import { parseSubject } from '../../../scripts/gh-subject.js';

// Every case below SPAWNS a `.ts` entry point, paying Node startup plus type
// stripping per call. Vitest's default bound is 5 s and is an IN-PROCESS
// bound, so these pass locally and time out on a loaded CI runner -- the shape
// `.claude/rules/testing.md` records from go-to-k/cdkd#2553 (~2 s local, 5000 ms
// in CI), and the one that reads as flakiness rather than an under-declared
// bound. Measured here at up to 2088 ms locally during the go-to-k/cdkd#2717
// test review. The bound's job is to stop a HANG, not to police latency, so it
// is set generously.
vi.setConfig({ testTimeout: 60_000 });


/**
 * Port of `.claude/hooks/gh-body-english-gate.test.sh` (144 cases), for the CI
 * check that replaced the hook.
 *
 * ## Why every literal here is a `\uXXXX` escape
 *
 * The hook's suite carried LITERAL hiragana and kanji, and it therefore had to
 * be listed in `.claude/hooks/non-english-allowlist.txt` -- a permanent,
 * per-path hole in the English-only rule, because the sibling PR-diff gate
 * reads a changed file's WHOLE content and would otherwise block every PR that
 * touched the suite. Escapes remove that dependency entirely: this file is pure
 * ASCII, needs no allowlist entry, and the code points are then checkable by
 * eye against the five ranges the checker declares. That is a small
 * strengthening the move to CI made available, so it is taken.
 *
 * ## What was dropped from the 144, and why
 *
 * 101 cases had shell parsing as their WHOLE subject and have no counterpart
 * here: flag spellings (`--body-file=`, `-F <p>`, glued `-F<p>`, `-f body=`,
 * `--field`, `--raw-field`, `--notes-file`, the deliberately-unscanned `-b` /
 * `-t` / `-n`), quoting (single / double / bare / spaced-and-quoted paths /
 * backslash-escaped paths / ANSI-C `$'...'` in three escape families / escaped
 * quotes / mid-word `$'...'` / apostrophe parity), heredoc extraction (both
 * redirect orders, `<<-` TAB-only stripping, indented terminators, several
 * chunks per path, empty bodies, `>f<<EOF` / `>f;` / `>f&&`), the
 * write-vs-append distinction, command-position segmentation (`&&` / `;` /
 * `||` / `|` / newline / backslash continuation / subshells / quoted
 * mentions), `cd` and `gh -C` / `-R` resolution, relative and `~/` path
 * spellings, byte-fidelity of a `$'...'` path, the `GATE_PERL_WORD` load
 * guard, the `__GATE_PW_OK` env guard, and the settings.json registration
 * check. None of them describe a property of the DETECTION, which is what was
 * ported.
 *
 * Every case that pinned a FALSE-POSITIVE avoidance or a documented KNOWN LIMIT
 * of the CHARACTER CLASS is here, plus cases the shell suite could not express
 * (per-field scoping, CRLF, the report's line numbers, the boundary code
 * points of all five ranges).
 *
 * Case count: 35 `it` blocks.
 */

// --- the five ranges, as escapes -------------------------------------------
const HIRAGANA = '\u3042\u308A\u304C\u3068\u3046'; // "arigatou"
const KATAKANA = '\u30C6\u30B9\u30C8'; // "tesuto"
const KANJI = '\u4FEE\u6B63'; // "shuusei"
const HANGUL = '\uD14C\uC2A4\uD2B8'; // "teseuteu"
const CJK_COMMA = '\u3001'; // ideographic comma
const IDEOGRAPHIC_SPACE = '\u3000';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const SCRIPT = join(REPO_ROOT, 'scripts/check-gh-body-english.ts');

function subject(fields: Record<string, unknown>) {
  return parseSubject(JSON.stringify({ kind: 'issue', number: 1, ...fields }));
}

/** Spawn the checker the way the workflow does, and report exit code + stdout. */
function runCli(doc: unknown): { status: number; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), 'gh-body-english-'));
  const file = join(dir, 'subject.json');
  writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
  try {
    const stdout = execFileSync('node', [SCRIPT, file], { encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? '' };
  }
}

describe('the character class', () => {
  // The five ranges IN ISOLATION. The shell suite added these because without
  // them, deleting any single range from the class still passed every case.
  it('blocks hiragana alone', () => {
    expect(containsNonEnglish(HIRAGANA)).toBe(true);
  });

  it('blocks katakana alone', () => {
    expect(containsNonEnglish(KATAKANA)).toBe(true);
  });

  it('blocks kanji / Chinese alone', () => {
    expect(containsNonEnglish(KANJI)).toBe(true);
  });

  it('blocks hangul alone', () => {
    expect(containsNonEnglish(HANGUL)).toBe(true);
  });

  it('blocks CJK punctuation alone', () => {
    expect(containsNonEnglish(`hello${CJK_COMMA}world`)).toBe(true);
    expect(containsNonEnglish(`a${IDEOGRAPHIC_SPACE}b`)).toBe(true);
  });

  // Stronger than the shell suite could be: every range BOUNDARY, so shrinking
  // a range by one code point at either end is caught. A range list is exactly
  // the kind of constant that gets "tidied" into a narrower one.
  it('includes both endpoints of all five declared ranges', () => {
    const endpoints = [
      0x3000, 0x303f, // CJK punctuation
      0x3040, 0x309f, // hiragana
      0x30a0, 0x30ff, // katakana
      0x4e00, 0x9fff, // CJK ideographs
      0xac00, 0xd7af, // hangul
    ];
    for (const cp of endpoints) {
      expect(containsNonEnglish(String.fromCodePoint(cp))).toBe(true);
    }
  });

  // ...and the code points immediately OUTSIDE each contiguous block, so
  // widening is caught too. U+3000-U+30FF is contiguous across the first three
  // ranges, hence four probes rather than ten.
  it('excludes the code points immediately outside each block', () => {
    const outside = [0x2fff, 0x3100, 0x4dff, 0xa000, 0xabff, 0xd7b0];
    for (const cp of outside) {
      expect(containsNonEnglish(String.fromCodePoint(cp))).toBe(false);
    }
  });

  it('is not a global regex', () => {
    // A `g` flag makes `.test()` stateful via `lastIndex`, so alternating
    // calls on the same string return true, false, true. The checker calls it
    // once per line AND once per character in `offendingCharacters`.
    expect(NON_ENGLISH_RE.global).toBe(false);
    expect(containsNonEnglish(HIRAGANA)).toBe(true);
    expect(containsNonEnglish(HIRAGANA)).toBe(true);
  });
});

describe('false positives the class must not produce', () => {
  // The brief's explicit list, and the shell suite's own control cases. Each of
  // these is punctuation or a letter an ENGLISH body legitimately carries.
  it('passes em-dashes, en-dashes and curly quotes', () => {
    expect(containsNonEnglish('a — b – c')).toBe(false);
    expect(containsNonEnglish('“quoted” and ‘single’')).toBe(false);
    expect(containsNonEnglish('ellipsis…')).toBe(false);
  });

  it('passes box-drawing characters', () => {
    expect(containsNonEnglish('┌─┐│└┘')).toBe(false);
  });

  it('passes arrows', () => {
    expect(containsNonEnglish('a → b ← c ⇒ d')).toBe(false);
  });

  it('passes accented Latin', () => {
    // The shell suite's `ACC` control: an ordinary U+00E9 is not blocked, and
    // it was the carrier that made an encoding bug invisible there.
    expect(containsNonEnglish('café naïve résumé')).toBe(false);
  });

  it('passes emoji', () => {
    expect(containsNonEnglish('ship it \u{1f680}')).toBe(false);
  });

  it('passes an ordinary English body and an empty one', () => {
    expect(containsNonEnglish('All English content here.')).toBe(false);
    expect(containsNonEnglish('')).toBe(false);
  });
});

describe('known limits of the class, pinned so they cannot change silently', () => {
  // These PASS, and that is the hook's behaviour preserved character-for-
  // character rather than an oversight. U+FF00-U+FFEF is outside all five
  // declared ranges. Anyone widening the class must change these cases
  // DELIBERATELY -- and must make the same change in the sibling PR-diff check,
  // or a body rule and a file rule start disagreeing.
  it('passes halfwidth katakana (U+FF65-U+FF9F)', () => {
    expect(containsNonEnglish('ｱｲｳ')).toBe(false);
  });

  it('passes fullwidth forms (U+FF01-U+FF60)', () => {
    expect(containsNonEnglish('！？［')).toBe(false);
  });

  it('passes Kana Supplement, which is outside the BMP ranges', () => {
    expect(containsNonEnglish('\u{1b000}')).toBe(false);
  });
});

describe('which fields are scanned', () => {
  it('scans an issue title', () => {
    const found = scanSubject(subject({ title: KANJI, body: 'English body.' }));
    expect(found).toHaveLength(1);
    expect(found[0]!.field).toBe('title');
  });

  it('scans an issue body', () => {
    const found = scanSubject(subject({ title: 'fix(deploy): a real bug', body: HIRAGANA }));
    expect(found).toHaveLength(1);
    expect(found[0]!.field).toBe('body');
  });

  it('scans a pull request title and body', () => {
    const found = scanSubject(
      parseSubject(
        JSON.stringify({ kind: 'pull_request', number: 7, title: KANJI, body: KATAKANA }),
      ),
    );
    expect(found.map((o) => o.field)).toEqual(['title', 'body']);
  });

  it('scans a comment body', () => {
    const found = scanSubject(
      parseSubject(JSON.stringify({ kind: 'issue_comment', number: 5, body: HIRAGANA })),
    );
    expect(found).toHaveLength(1);
    expect(found[0]!.field).toBe('body');
  });

  it('does not invent a title for a comment', () => {
    // A comment has none. If a caller supplies one anyway it must be ignored,
    // not scanned -- the CI analogue of the hook extracting only the published
    // field rather than scanning the whole command.
    //
    // BOTH layers are asserted, and separately. `parseSubject` drops the field
    // and `scanSubject` skips it for this kind; either alone is sufficient, so
    // a test that only checks the OUTCOME passes while one of them is broken.
    // Measured: mutating `parseSubject` to keep the title failed 0 cases until
    // the first assertion below existed.
    const parsed = parseSubject(
      JSON.stringify({ kind: 'issue_comment', number: 5, title: KANJI, body: 'English.' }),
    );
    expect(parsed.title).toBeUndefined();
    expect(scanSubject(parsed)).toEqual([]);
    // ...and the scan skips it even when a caller constructs the subject by
    // hand rather than through `parseSubject`.
    expect(scanSubject({ kind: 'issue_comment', number: 5, title: KANJI, body: 'English.', labels: [] }))
      .toEqual([]);
  });

  it('does not scan labels, url or any other payload field', () => {
    // The CI counterpart of "japanese in the PATH but english body passes":
    // only what this repo PUBLISHED as prose is in scope.
    const found = scanSubject(
      subject({
        title: 'English title',
        body: 'English body.',
        labels: [KANJI, 'bug'],
        url: `https://example.invalid/${encodeURIComponent(KANJI)}`,
      }),
    );
    expect(found).toEqual([]);
  });

  it('passes a null body (GitHub sends null for an empty body)', () => {
    const found = scanSubject(subject({ title: 'English title', body: null }));
    expect(found).toEqual([]);
  });
});

describe('the report', () => {
  it('reports 1-based line numbers', () => {
    const found = scanField('body', `line one\nline two\nline three ${KANJI}\nline four`);
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(3);
  });

  it('finds non-English on the LAST line of a multi-line body', () => {
    // The shell suite's "multi-line body with japanese only on the last line";
    // there it fenced `perl -ne` being line-wise, here it fences the split.
    const found = scanField('body', `english\nenglish\n${KANJI}`);
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(3);
  });

  it('names the offending characters, de-duplicated and in order', () => {
    expect(offendingCharacters(`a${CJK_COMMA}b${CJK_COMMA}c\u3002`)).toEqual([
      CJK_COMMA,
      '\u3002',
    ]);
    expect(offendingCharacters('all english')).toEqual([]);
  });

  it('caps the reported lines at MAX_REPORT per field', () => {
    const body = Array.from({ length: MAX_REPORT + 5 }, () => KANJI).join('\n');
    expect(scanField('body', body)).toHaveLength(MAX_REPORT);
  });

  it('blocks a localized Session-fit gloss', () => {
    // The exact shape seen live (issue #1993): both halves of the line glossed
    // in the session's chat language.
    const body = `Session-fit: next (\u4ECA\u56DE\u306F\u3084\u3089\u306A\u3044)`;
    const found = scanField('body', body);
    expect(found).toHaveLength(1);
  });

  it('carries the fix guidance and the rule pointer', () => {
    const s = subject({ title: 'English title', body: KANJI });
    const report = formatReport(s, scanSubject(s));
    expect(report).toContain('Session-fit: next (not this session)');
    expect(report).toContain('hiragana / katakana / kanji / Chinese / hangul / CJK punctuation');
    expect(report).toContain('CLAUDE.md -> Workflow Rules -> English-only');
    expect(report).toContain('only what gets PUBLISHED');
  });

  it('truncates a very long offending line', () => {
    const found = scanField('body', `${'x'.repeat(300)}${KANJI}`);
    expect(found[0]!.text.length).toBeLessThanOrEqual(121);
  });
});

describe('CRLF, which the hook never saw', () => {
  it('normalises CRLF so line numbers are still right', () => {
    const s = parseSubject(
      JSON.stringify({ kind: 'issue', number: 1, title: 'x', body: `a\r\nb\r\n${KANJI}` }),
    );
    const found = scanSubject(s);
    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(3);
  });
});

describe('the CLI, as the workflow invokes it', () => {
  // The requirement this whole file exists for: the check must be PROVEN to
  // fail on a real violation, not merely to run.
  it('exits 1 and prints the report on a real violation', () => {
    const { status, stdout } = runCli({ kind: 'issue', number: 9, title: 'x', body: HANGUL });
    expect(status).toBe(1);
    expect(stdout).toContain('Non-English text');
    expect(stdout).toContain('English-only');
  });

  it('exits 0 on a clean subject', () => {
    const { status, stdout } = runCli({
      kind: 'issue',
      number: 9,
      title: 'fix(deploy): a real bug',
      body: 'All English content here — including an em-dash.',
    });
    expect(status).toBe(0);
    expect(stdout).toContain('English-only');
  });

  it('exits 2, never 0, when the subject cannot be read', () => {
    // "Could not evaluate" must never be reported as "clean". This is the
    // fail-open the retired hooks' own load guards existed to prevent, and it
    // is the failure mode a CI port is most likely to reintroduce.
    expect(runCli('{ not json').status).toBe(2);
    expect(runCli({ kind: 'nonsense', number: 1, body: '' }).status).toBe(2);
  });
});
