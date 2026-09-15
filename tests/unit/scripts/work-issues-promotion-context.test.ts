import { describe, it, expect } from 'vite-plus/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * The `ctx()` helper inside `/work-issues` section 10-0's promotion check, the
 * block that prints the body sentence each PROMOTE hit came from.
 *
 * WHY THIS FILE EXISTS — it is an INSTRUMENT CHANGE, not extra caution. That
 * recipe shipped three defects while it was hand-verified prose:
 *
 *   1. context grepped for the extracted TOKEN, so a bare `verify.sh` printed a
 *      sentence about a sibling fixture (go-to-k/cdkd#2655);
 *   2. `cut -c1-110`, a head cut that truncated the token out of its own line;
 *   3. `grep -oE ".{0,50}<needle>.{0,50}"`, which ugrep REFUSES for a needle
 *      under 9 characters — rc=2, empty output, which takes the `else` arm and
 *      prints `AMBIGUOUS`, the row the prose calls the strongest citation
 *      signal. A tool failure rendered as a positive finding.
 *
 * Its `awk` rewrite then shipped three more, all found by review rather than by
 * any test: a non-terminating loop on an empty needle (`index(s, "")` is 1, so
 * the advance never moves), `awk -v` processing escape sequences so a needle
 * containing a backslash never arrived literally, and a window documented as
 * characters that is bytes.
 *
 * Six defects across three rounds is exactly `references/implement.md` 5-f''s
 * "three spellings in three rounds is the signal to change instrument", and the
 * precedent is one file over: `work-issues-launch-mode.test.ts` extracts and
 * EXECUTES the probe in `references/launch-mode.md`, on the argument that the
 * shell-edge-case reading beside it in the doc is otherwise re-checked by
 * nothing. Same class, same remedy.
 *
 * WHAT THIS CANNOT DO. It fences `ctx()`, not the whole recipe: the surrounding
 * loop calls `gh` and reads a git range, so running it end to end would need the
 * network. `ctx()` is where all six defects lived, and it is pure text in / text
 * out, so it is the part a unit test can own. The loop around it stays covered
 * by the reading, which is the honest division rather than a claim of full
 * coverage.
 *
 * WHICH CASE WOULD HAVE CAUGHT THE ugrep DEFECT — measured, because the
 * obvious answer is wrong. Case (e) pins that a short needle produces output,
 * and where `grep` IS ugrep 7.8.4 the old form exits 2 for a needle of 8
 * characters or fewer and 0 from 9 up — the boundary is exact. But this
 * harness runs `bash -c`, which resolves `/usr/bin/grep` (BSD) and accepts the
 * same pattern, so (e) alone is VACUOUS against the historical defect: it
 * passes under both implementations.
 *
 * WHERE ugrep ACTUALLY LIVES, since the obvious answer is wrong twice over:
 * NOT the login shell. `zsh -l -i -c 'type grep'` answers `/usr/bin/grep`.
 * The shim is a shell FUNCTION injected by Claude Code's shell snapshot, so it
 * is the AGENT's Bash tool shell that gets ugrep — which is exactly where a
 * session pastes this recipe, and exactly where no `bash -c` probe looks.
 *
 * That divergence is why case (j) exists. No probe built on `bash -c` can
 * settle a question about `grep` behaviour. What IS decidable, and what (j)
 * asserts, is that the helper depends on no `grep` at all — the property the
 * `awk` rewrite buys and the one a future edit could silently give back.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RETRO_DOC = join(repoRoot, '.claude', 'skills', 'work-issues', 'references', 'retro.md');

/**
 * Lift `ctx()` out of the doc rather than restating it. A transcription would
 * be a COPY, and `implement.md` 5-e is explicit that mutating a copy reports a
 * verdict about a fence that does not exist — the defect this file replaces was
 * in the doc, so the doc is the subject.
 */
function extractCtx(): string {
  const doc = readFileSync(RETRO_DOC, 'utf8');
  const start = doc.indexOf('ctx() { [ -n "$1" ] || return 0');
  expect(
    start,
    `retro.md no longer contains a \`ctx()\` definition starting with the empty-needle ` +
      `guard. If the helper was renamed or rewritten, update this extractor — do NOT ` +
      `delete the fence, which is the whole reason section 10-0's block is trustworthy.`,
  ).toBeGreaterThan(-1);
  const end = doc.indexOf("}'; }", start);
  expect(end, 'the `ctx()` definition in retro.md has no recognisable end').toBeGreaterThan(start);
  const slice = doc.slice(start, end + "}'; }".length);
  // NON-VACUITY, the precedent's shape (work-issues-launch-mode.test.ts asserts
  // the same about its extracted probe). The token checks say the slice IS the
  // helper...
  for (const token of ['awk', 'index(', 'ENVIRON']) {
    expect(
      slice.includes(token),
      `the text extracted from retro.md as \`ctx()\` does not contain \`${token}\`, so the ` +
        `slice is not the helper — every case below would test the wrong text.`,
    ).toBe(true);
  }
  // ...and this says it is not the helper PLUS something else. The tokens
  // alone cannot: the slice always BEGINS at `ctx()`, so it contains them
  // however far the end anchor overshoots. A length bound was the first
  // attempt and is the same proxy one notch coarser — review measured a 397 B
  // over-extraction (perturbed end marker plus an adjacent 60 B sibling) that
  // cleared both the tokens and a 900 B bound with every case green. The
  // decidable property is that the slice defines exactly ONE function.
  const openers = slice.match(/\w+\(\) \{/g) ?? [];
  expect(
    openers.length,
    `the text extracted as \`ctx()\` declares ${openers.length} functions ` +
      `(${openers.join(', ') || 'none'}), not 1. The end anchor ("}'; }") has overshot onto ` +
      `a LATER definition, so the cases below would execute text that is not the subject.`,
  ).toBe(1);
  return slice;
}

/** Run the extracted helper against `body` with `needle`, returning its rows. */
function runCtx(body: string, needle: string): { rows: string[]; status: number } {
  const script = `${extractCtx()}\nprintf '%s' "$BODY" | ctx "$NEEDLE"\n`;
  let status = 0;
  let out = '';
  try {
    out = execFileSync('bash', ['-c', script], {
      env: { ...process.env, BODY: body, NEEDLE: needle },
      encoding: 'utf8',
      // The empty-needle defect was an UNBOUNDED loop that produced 123 MB in
      // seconds. `maxBuffer` is what actually catches THAT (measured: it trips
      // at ~78 ms); this timeout is the backstop for a helper that hangs
      // producing NOTHING, which no buffer cap can see. The per-`it` 30 s
      // bounds below are NOT about orphaning — `execFileSync` blocks the
      // worker, so vitest's timer cannot fire until it returns — they are the
      // spawn-cost rule in `.claude/rules/testing.md`, since each case pays
      // Node plus bash startup and the default 5 s is an in-process bound.
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (err) {
    const e = err as { status?: number; stdout?: string; signal?: string };
    status = e.status ?? (e.signal ? 124 : 1);
    out = e.stdout ?? '';
  }
  return { rows: out.split('\n').filter((l) => l.length > 0), status };
}

/**
 * The whole section 10-0 block, lifted verbatim and executed against stub
 * `gh` / `git` on PATH.
 *
 * `runCtx` above tests the HELPER; this tests the block that calls it, which
 * is where three measured regressions hid — each left `ctx()` byte-identical
 * and every helper case green while the check printed `AMBIGUOUS` for every
 * hit or fabricated a citation row.
 *
 * Only the two placeholders are substituted (the issue list and the git
 * range); everything else runs as written, so a rewrite of the loop, the
 * pipeline, the `[ -n "$c" ]` arm or the dedupe is exercised rather than
 * pattern-matched.
 */
function runBlock(
  body: string,
  touchedPaths: string,
  opts: { keepSessionFitFilter?: boolean } = {},
): { rows: string[]; status: number } {
  const doc = readFileSync(RETRO_DOC, 'utf8');
  const fences = [...doc.matchAll(/^[ \t]*```bash\n([\s\S]*?)^[ \t]*```$/gm)].map((m) => m[1]!);
  // EXACTLY one, not the first: `find` would silently take block A if a second
  // block ever carried the marker, and every case below would then describe a
  // block nobody runs.
  const matching = fences.filter((f) => f.includes('PROMOTE #$n'));
  expect(
    matching.length,
    `${matching.length} fenced bash blocks in retro.md contain \`PROMOTE #$n\`; expected ` +
      `exactly 1. At 0 the promotion check could not be located; above 1 the cases below ` +
      `would run whichever came first. Update this extractor rather than deleting the case.`,
  ).toBe(1);
  const block = matching[0];

  const dir = mkdtempSync(join(tmpdir(), 'promo-block-'));
  try {
    // Stubs. BOTH check their verb and exit 99 otherwise, so a block that
    // starts calling something else fails loudly instead of reading an empty
    // answer as "nothing to promote" — the failure mode this whole file
    // exists to stop, one layer out.
    writeFileSync(
      join(dir, 'gh'),
      `#!/bin/sh\ncase "$1 $2" in "issue view") cat "${join(dir, 'body.txt')}" ;; ` +
        `*) echo "unexpected gh $*" >&2; exit 99 ;; esac\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(dir, 'git'),
      `#!/bin/sh\ncase "$1" in diff) cat "${join(dir, 'touched.txt')}" ;; ` +
        `*) echo "unexpected git $*" >&2; exit 99 ;; esac\n`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, 'body.txt'), body);
    writeFileSync(join(dir, 'touched.txt'), touchedPaths.endsWith('\n') ? touchedPaths : touchedPaths + '\n');

    const FILTER = `printf '%s' "$b" | grep -q 'Session-fit: *next' || continue`;
    let script = block!
      .replace('<the sha main was at when this run started>..origin/main', 'STUBRANGE')
      .replace('<the numbers this run filed that are still open>', '4242');
    if (!opts.keepSessionFitFilter) {
      // Most fixtures are about the CONTEXT machinery, so the `Session-fit`
      // gate is neutralised rather than satisfied in every body. Assert the
      // line was THERE before replacing it: an exact-string `.replace` of a
      // DELETED line is a silent no-op, so without this the filter could be
      // removed from the recipe and every case would stay green (round 5).
      expect(
        script.includes(FILTER),
        "section 10-0's block no longer carries the `Session-fit: next` filter in the exact " +
          'form this harness neutralises. If it was reworded, update FILTER; if it was ' +
          'DELETED, the block now promotes every issue it is handed.',
      ).toBe(true);
      script = script.replace(FILTER, ':');
    }

    let status = 0;
    let out = '';
    try {
      out = execFileSync('bash', ['-c', script], {
        env: { ...process.env, PATH: `${dir}:${process.env['PATH'] ?? ''}` },
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; signal?: string };
      status = e.status ?? (e.signal ? 124 : 1);
      out = e.stdout ?? '';
    }
    return { rows: out.split('\n').filter((l) => l.length > 0), status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('work-issues section 10-0 ctx() helper', () => {
  it('(a) exits cleanly on an ordinary hit', () => {
    const { rows, status } = runCtx('the fix landed in scripts/gen-foo.ts today', 'scripts/gen-foo.ts');
    expect(status).toBe(0);
    expect(rows).toHaveLength(1);
  }, 30_000);

  it('(b) prints one row per OCCURRENCE, not one merged row', () => {
    // Two occurrences closer than the window: `grep -o` merged these into one
    // row, which is the behaviour the prose now claims to have improved on.
    const body = 'a retro.md here, b retro.md there, c retro.md last';
    const { rows } = runCtx(body, 'retro.md');
    expect(
      rows,
      `three occurrences must yield three rows; got ${rows.length}. A merged row is the ` +
        `\`grep -o\` behaviour the doc says this replaced.`,
    ).toHaveLength(3);
  }, 30_000);

  it('(c) every row contains the needle it is context FOR', () => {
    const { rows } = runCtx('x'.repeat(200) + 'docs/state-management.md' + 'y'.repeat(200), 'docs/state-management.md');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row).toContain('docs/state-management.md');
  }, 30_000);

  it('(d) the window is CENTERED — the needle is not at column 0 when left context exists', () => {
    const body = 'L'.repeat(200) + 'ship.md' + 'R'.repeat(200);
    const { rows } = runCtx(body, 'ship.md');
    expect(rows).toHaveLength(1);
    expect(
      rows[0]!.indexOf('ship.md'),
      `the needle sits at column ${rows[0]!.indexOf('ship.md')}; a head cut (the ` +
        `go-to-k/cdkd#2636 defect) puts it at 0 or drops it entirely.`,
    ).toBe(50);
  }, 30_000);

  it('(e) a SHORT needle still produces output', () => {
    // Under the interactive shell's grep (ugrep) the old bounded-repeat form
    // exits 2 with `exceeds complexity limits` for a needle of <= 8 chars and
    // prints nothing, which the caller renders as AMBIGUOUS. This harness's
    // `bash -c` resolves a different grep, so this case does NOT discriminate
    // against that form -- see (j), and the header for why. It still pins the
    // property, which is what a future rewrite would break.
    for (const needle of ['retro.md', 'ship.md', 'a.md']) {
      const { rows, status } = runCtx(`the body names ${needle} once`, needle);
      expect(status, `ctx exited ${status} for the short needle ${needle}`).toBe(0);
      expect(
        rows.length,
        `a short needle (${needle}, ${needle.length} chars) produced NO context. That is ` +
          `the ugrep bounded-repeat refusal, and the caller renders an empty result as ` +
          `AMBIGUOUS — a tool failure printed as the strongest positive signal.`,
      ).toBeGreaterThan(0);
    }
  }, 30_000);

  it('(f) an absent needle yields empty output and rc 0', () => {
    const { rows, status } = runCtx('nothing relevant on this line', 'absent/path.md');
    expect(status).toBe(0);
    expect(rows).toHaveLength(0);
  }, 30_000);

  it('(g) an EMPTY needle terminates instead of looping forever', () => {
    // index(s, "") is 1, so the loop's advance does not move. Before the guard
    // this produced megabytes per second.
    const { rows, status } = runCtx('any body at all', '');
    expect(status, 'ctx did not exit cleanly on an empty needle — 124 means it timed out').toBe(0);
    expect(rows).toHaveLength(0);
  }, 30_000);

  it('(h) a needle containing a BACKSLASH arrives literally', () => {
    // `awk -v n="..."` processes escape sequences, so `\t` in a path became a
    // TAB and matched nothing — an empty result the caller prints as AMBIGUOUS.
    const body = String.raw`touched weird\tdir/foo.md in this run`;
    const { rows } = runCtx(body, String.raw`weird\tdir/foo.md`);
    expect(
      rows.length,
      'a needle containing a backslash matched nothing; the needle is being escape-processed ' +
        'in transit rather than passed literally.',
    ).toBe(1);
  }, 30_000);

  it('(i) a needle with regex metacharacters needs no escaping', () => {
    const body = 'touched tests/a+b(c)/verify.sh here';
    const { rows } = runCtx(body, 'tests/a+b(c)/verify.sh');
    expect(rows).toHaveLength(1);
  }, 30_000);

  it('(k) a MULTI-LINE body is scanned on every line, not just the first', () => {
    // Every other case body is one line; every real `$b` from `gh issue view`
    // is many. Measured: `{ line = $0` -> `NR == 1 { line = $0` changed a real
    // body's output from one row to none and reddened NOTHING, so the
    // line-based bound the doc states was asserted by nothing.
    const body = ['first line, nothing here', 'second line names docs/a-page.md', 'third line'].join('\n');
    const { rows } = runCtx(body, 'docs/a-page.md');
    expect(
      rows.length,
      'a needle on the SECOND line produced no row — the scan is reaching only line 1.',
    ).toBe(1);
    // ...and a needle on several lines yields a row per line.
    const multi = ['x docs/a-page.md x', 'y', 'z docs/a-page.md z'].join('\n');
    expect(runCtx(multi, 'docs/a-page.md').rows).toHaveLength(2);
  }, 30_000);

  it('(l) the RIGHT edge is bounded too, not just the left', () => {
    // Case (d) watches the left edge only, so an unbounded right window
    // (dropping the length argument from substr) reddened nothing.
    const body = 'L'.repeat(200) + 'ship.md' + 'R'.repeat(200);
    const { rows } = runCtx(body, 'ship.md');
    expect(rows).toHaveLength(1);
    expect(
      rows[0]!.length,
      `the row is ${rows[0]!.length} B; a 50-byte window each side of a 7-byte needle is ` +
        `107. An unbounded right edge prints the rest of the line.`,
    ).toBe(107);
  }, 30_000);

  it('(p) a needle at COLUMN 0 clamps the left edge without widening the right', () => {
    // Every other case gives the needle >= 200 B of left context, so dropping
    // the `if (s < 1) s = 1` clamp reddened nothing: at column 0 the start
    // index goes negative, and this awk then returns the whole remainder —
    // 100 B of right context, double the window (l) pins.
    // The 57 B PASS value is portable; the 107 B mutant value is BWK awk's
    // (macOS, measured 2026-09-15). mawk and gawk shrink the length when the
    // start index goes below 1, so on a Linux runner this mutation is
    // invisible — the case still pins the correct behaviour everywhere, but
    // do not read a green CI run as having exercised it.
    const body = 'ship.md' + 'R'.repeat(200);
    const { rows } = runCtx(body, 'ship.md');
    expect(rows).toHaveLength(1);
    expect(
      rows[0]!.length,
      `a needle at column 0 must yield 7 B of needle + 50 B of right context = 57; got ` +
        `${rows[0]!.length}. A negative start index widens the window instead of clamping it.`,
    ).toBe(57);
  }, 30_000);

  it('(q) a SELF-OVERLAPPING needle does not double-count', () => {
    // `index(substr(line, off + 1), n)` -> `substr(line, off)` re-reads one
    // byte and reports `aa` in `aaa` twice; no other case uses a needle that
    // can overlap itself.
    const { rows } = runCtx('aaa', 'aa');
    expect(
      rows.length,
      `\`aa\` occurs once non-overlapping in \`aaa\`; got ${rows.length} rows, so the scan ` +
        `re-reads a byte it has already consumed.`,
    ).toBe(1);
  }, 30_000);

  it('(m) ADJACENT occurrences each get a row — the advance is exact', () => {
    // `off = abs + length(n) - 1` -> `+ length(n)` skips an occurrence that
    // begins immediately after the previous one; no other case spaces them
    // that closely.
    const { rows } = runCtx('retro.mdretro.md', 'retro.md');
    expect(
      rows.length,
      'two back-to-back occurrences yielded fewer than two rows — the scan advance is ' +
        'off by one and skips an occurrence that starts where the last ended.',
    ).toBe(2);
  }, 30_000);

  it('(n) the WHOLE block is run, and a full-path hit prints its sentence', () => {
    // A probed callee says nothing about its WIRING (.claude/rules/testing.md
    // -> "Mutation probes", go-to-k/cdkd#2719), and a SUBSTRING check of the
    // wiring is a proxy that plausible rewrites defeat. Three were measured
    // green against one: renaming `hit` in the loop but not in the call,
    // inverting `[ -n "$c" ]`, and piping `$hits` instead of `$b`. Each makes
    // every hit print AMBIGUOUS or fabricates a citation row, which is the
    // exact defect this file exists for. So the block is EXECUTED.
    const { rows, status } = runBlock(
      ['a first line', 'the subject is `scripts/gen-foo.ts` in this run', 'a last line'].join('\n'),
      ['scripts/gen-foo.ts', 'docs/unrelated.md'].join('\n'),
    );
    expect(status, 'the promotion-check block exited non-zero').toBe(0);
    expect(rows.filter((r) => r.startsWith('PROMOTE '))).toHaveLength(1);
    const ctxRows = rows.filter((r) => r.trim().startsWith('ctx: '));
    expect(
      ctxRows,
      `expected exactly one ctx row for a path the body names in full; got ${JSON.stringify(rows)}`,
    ).toHaveLength(1);
    // The SENTENCE, not just the path — piping the wrong variable prints a row
    // containing the path and nothing else, which reads like a citation.
    expect(ctxRows[0]).toContain('the subject is');
    expect(rows.join('\n')).not.toContain('AMBIGUOUS');
  }, 30_000);

  it('(r) a path named TWO ways yields ONE row — the dedupe is live', () => {
    // The extraction emits both a full path and its bare basename, so one
    // touched file matches twice; `| sort -u` is what collapses that, and the
    // block's own comment calls it load-bearing. Measured: deleting it left
    // all 17 other cases green while every PROMOTE row and its ctx row
    // printed twice. No other fixture names a path two ways.
    const { rows, status } = runBlock(
      'the subject is `scripts/gen-foo.ts`, and gen-foo.ts is also named bare here',
      'scripts/gen-foo.ts',
    );
    expect(status).toBe(0);
    expect(
      rows.filter((r) => r.startsWith('PROMOTE ')),
      `a single touched file named both by full path and by basename must PROMOTE once; ` +
        `got ${JSON.stringify(rows)}. The hits pipeline has stopped deduping.`,
    ).toHaveLength(1);
  }, 30_000);

  it('(t) ere() escapes the DOT — a dash-spelled sibling must not promote', () => {
    // `.` is the ONE metacharacter the suffix match can meet: the extraction
    // charset admits no other, which is why an earlier attempt at this case
    // (a path containing `+` and `(`) was vacuous. Unescaped, `x.test.ts`
    // becomes a wildcard that matches the touched `dir/x-test.ts`, and the
    // block then FABRICATES a promotion for a file the run never touched by
    // that name — printed as AMBIGUOUS with an empty context, the same
    // tool-artefact-as-strongest-signal class this file exists to stop.
    // `a.test.ts` / `a-test.ts` siblings are ordinary here, so it is reachable.
    const { rows, status } = runBlock('the subject is `x.test.ts` here', 'dir/x-test.ts');
    expect(status).toBe(0);
    expect(
      rows.filter((r) => r.startsWith('PROMOTE ')),
      `\`x.test.ts\` must not match the touched \`dir/x-test.ts\`; got ${JSON.stringify(rows)}. ` +
        `The suffix match has stopped escaping \`.\` and is matching as a wildcard.`,
    ).toHaveLength(0);
  }, 30_000);

  it('(s) the Session-fit filter is LIVE — only `next` issues promote', () => {
    // Every other block case neutralises this gate. Run it for real in both
    // directions: without a case here, DELETING the filter from the recipe is
    // invisible (an exact-string replace of an absent line is a no-op), and
    // the check would promote every issue handed to it.
    const touched = 'scripts/gen-foo.ts';
    const named = 'the subject is `scripts/gen-foo.ts` here';
    const isNext = runBlock(`${named}\nSession-fit: next (not this session)`, touched, {
      keepSessionFitFilter: true,
    });
    expect(isNext.status).toBe(0);
    expect(
      isNext.rows.filter((r) => r.startsWith('PROMOTE ')),
      'an issue carrying `Session-fit: next` did not promote, so the filter rejects what it ' +
        'should pass.',
    ).toHaveLength(1);

    const notNext = runBlock(`${named}\nSession-fit: now (do it here)`, touched, {
      keepSessionFitFilter: true,
    });
    expect(notNext.status).toBe(0);
    expect(
      notNext.rows.filter((r) => r.startsWith('PROMOTE ')),
      'an issue classified `now` was promoted. The promotion check is for deferrals only; ' +
        'promoting a `now` tells the run to re-decide something it already committed to.',
    ).toHaveLength(0);
  }, 30_000);

  it('(o) a basename-only hit prints AMBIGUOUS, through the whole block', () => {
    // The other direction: the row must still be reachable, or a fix for (n)
    // that simply never takes the else arm would pass.
    const { rows, status } = runBlock(
      'the body mentions verify.sh and nothing else',
      'tests/integration/alpha/verify.sh',
    );
    expect(status).toBe(0);
    expect(rows.join('\n')).toContain('AMBIGUOUS');
    expect(rows.some((r) => r.trim().startsWith('ctx: '))).toBe(true);
  }, 30_000);

  it('(j) the helper invokes no grep — the property the awk rewrite buys', () => {
    // This is the case that DISCRIMINATES against the historical defect, and
    // (e) is not (header: `bash -c` and the interactive shell resolve
    // different greps, so no case here can settle grep behaviour). What is
    // decidable is the dependency: any bounded-repeat `grep` form reintroduces
    // a helper whose verdict depends on which grep the pasting session has,
    // and whose failure mode is an EMPTY result the caller prints as the
    // strongest positive signal.
    const helper = extractCtx();
    // `[eu]?` on purpose: plain `\bgrep\b` matched neither `egrep` nor
    // `ugrep`, and `ugrep` is the exact binary whose refusal caused the
    // defect — so the first spelling of this case would have passed a rewrite
    // that reintroduced it by name.
    expect(
      /\b[eu]?grep\b/.test(helper),
      `section 10-0's ctx() helper invokes grep again. It exists precisely to not: a ` +
        `bounded-repeat pattern is refused by ugrep for a needle of 8 characters or ` +
        `fewer (exit 2, no output), and an empty result takes the caller's else arm and ` +
        `prints AMBIGUOUS — a tool failure rendered as the strongest citation signal. ` +
        `awk's index() is a literal search with no such dependency.`,
    ).toBe(false);
  }, 30_000);
});
