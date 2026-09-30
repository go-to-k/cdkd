/**
 * The PASTE harness: feed a rendered cdkd message to real shells (bash, and zsh
 * where it is installed) at three granularities within a line, plus runs of
 * consecutive lines, and report which spans RAN.
 *
 * Shared by `pasteable-message-paste.test.ts` (the shapes) and by per-site
 * test files of go-to-k/cdkd#3436's fold-in, so a site drives ITS OWN renderer
 * through the same shells rather than a synthetic copy of what it prints. Not
 * every touched site has such a case: `grep -rl spansThatRun tests/` answers
 * which do.
 *
 * What a case buys depends on whether the site's pre-fix message RAN. Where it
 * was already inert — its value was gated before the fold and only the SHAPE
 * around the command changed — reverting the site reds its SPELLING pins, not
 * its paste case; the paste case is defence in depth there, pinning that no
 * later edit introduces a running span, and it is the one fence that can see
 * a running DISPLAY (`expectOnlyDisplayResidual`). Where the pre-fix message
 * RAN, the paste case is the primary fence and reds a revert on its own — the
 * SSM refusal's bare `displaySafe` prose on a plain `;`, for example, or a
 * value hand-quoted inside cdkd's own `'...'` in prose. Which sites are which
 * is recorded at each case, not listed here.
 *
 * THREE GRANULARITIES, because the issue measured why all three are needed: on
 * the vulnerable build, pasting whole LINES found 0 instances — the line also
 * held `resource record(s)`, whose `(` is a bash syntax error that stops the
 * line before the payload — while sentences found 2 and clauses found 2. An
 * operator selects a phrase, not a line. And a BLOCK: every run of two or more
 * consecutive lines is a span too (go-to-k/cdkd#4133), because a quote one line
 * opens can close on a later one and leave what sits between them bare.
 *
 * DECOYS, because an execution sentinel alone is blind to REDIRECTION: a bare
 * `<stack>` reads stdin from a file named `stack` and `>` TRUNCATES the next
 * word, and both only happen when the file EXISTS (go-to-k/cdkd#3440 created a
 * file called `where`). Every hole name the sites driven through this harness
 * print is planted WITH CONTENT (the list is those names, not every hole in
 * `src/` — `stackName`, `constructPath` and the like are not exercised here),
 * and a span counts as having run when it created a file OR changed
 * a decoy — a truncation onto an existing decoy creates no filename, so a
 * name-only comparison missed exactly the shape the decoys are for.
 *
 * ISOLATED, because the spans are attacker-shaped text run under a real shell:
 * the child gets a minimal env (no credentials, no `BASH_ENV`, `HOME` in the
 * scratch tree), a bound after which it is KILLED, and a PATH whose FIRST
 * entry holds stub executables named `cdkd` and `aws`. The stubs are what make
 * the verb stubbing hold by construction rather than by spelling: on a
 * case-insensitive filesystem (macOS) a span beginning `AWS ...` — export.ts
 * has prose like that — resolves through the stub directory before it can
 * reach the real `aws` binary, and on a case-sensitive one such a spelling is
 * not found at all. The shell functions of the same names still cover the
 * exact spellings (a function wins over PATH).
 *
 * TWO SHELLS, bash and zsh (go-to-k/cdkd#3950). macOS operators paste into zsh
 * by default, and the two disagree on exactly the shape several sites lean on:
 * a ` (` after a JSON-quoted name is a bash SYNTAX error, which stops the line
 * before anything runs, while zsh reads `(us-east-1)` as a glob qualifier and
 * expands `"x$(touch OWNED)"` BEFORE it reports the bad pattern. A span counts
 * as having run when it ran under EITHER shell. zsh is driven the way a paste
 * reaches it: INTERACTIVE (`-i`), the span fed on stdin, because an interactive
 * zsh leaves `INTERACTIVE_COMMENTS` off and so does not read a ` #` as a
 * comment, while `zsh -c` does (`echo see #1 "x$(touch OWNED)"` runs under the
 * first only). It is started with `-f`, so no user startup file is read
 * (`/etc/zshenv` still is). Where zsh is not installed the harness drives bash alone,
 * except under `CI`, where a missing zsh FAILS: the CI jobs install it, so a
 * skip there would be a harness quietly measuring less than it claims.
 */

import { expect, it } from 'vite-plus/test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

/**
 * The four payload families. `;` alone is not the class: `$( )` and backticks
 * SUBSTITUTE, and the embedded quote is what flips the parity in the first
 * place — its `'` closes a shell quote an apostrophe earlier in the sentence
 * opened, and what follows it is bare shell. Each creates `OWNED` if the span
 * it sits in ever RUNS.
 *
 * `flipped` marks the family that is INERT on its own: bare, the embedded
 * quote opens a span nothing closes and bash refuses the line before running
 * anything, so its positive control has to supply the apostrophe an English
 * sentence would (`it's`). A control that ran it bare reported the family as
 * dead and every "nothing ran" below would have passed for the wrong reason
 * (measured: `echo x'$(touch OWNED) #` creates nothing).
 */
export const PASTE_PAYLOADS = [
  { label: 'separator', value: 'x; touch OWNED; #', flipped: false },
  { label: 'substitution', value: 'x$(touch OWNED)', flipped: false },
  { label: 'backtick', value: 'x`touch OWNED`', flipped: false },
  { label: 'embedded quote', value: "x'$(touch OWNED) #", flipped: true },
] as const;

/**
 * A clause break INSIDE the value (go-to-k/cdkd#3950): a selection can start
 * after its `: `, inside any quote cdkd put around the value, so its control
 * is that clause on its own. NOT in {@link PASTE_PAYLOADS} yet: on the tree
 * that added it, quoted displays and `pasteableCommand` arguments in several
 * other modules still run on it, so only the sites that handle it opt in.
 */
export const CLAUSE_BREAK_PAYLOAD = {
  label: 'clause break',
  value: 'x: touch OWNED; # : y',
  flipped: false,
  control: 'touch OWNED; # : y',
} as const;

/**
 * The hole names the driven sites print, planted as decoys so a bare `<name>`
 * redirection has a file to read and its `>` a target to truncate. A site
 * printing a hole outside this list gets no decoy for it — add the name here
 * when such a site joins the harness.
 */
const DECOYS = [
  'stack',
  'region',
  'id',
  'logicalId',
  'physicalId',
  'parameterName',
  'profile',
  'bucket',
  'prefix',
  'name',
  'runId',
  // `displayIdent`'s fallback token, which a site may print bare.
  'unrenderable',
] as const;

const DECOY_CONTENT = 'decoy\n';

/** Whether `zsh` starts at all; probed once. */
const ZSH_AVAILABLE = spawnSync('zsh', ['-f', '-c', 'exit 0'], { encoding: 'utf8' }).status === 0;

/**
 * The shells every span runs under: bash always, zsh where it is installed.
 * See the header for why a missing zsh is a FAILURE under `CI`.
 */
export const PASTE_SHELLS: readonly ('bash' | 'zsh')[] = ZSH_AVAILABLE ? ['bash', 'zsh'] : ['bash'];

/**
 * `it` where zsh is driven, skipped where it is not (a local run without zsh;
 * under `CI` a missing zsh fails {@link withPasteDir} instead). For an S1 row's
 * ZSH paste case (go-to-k/cdkd#3950), which pins the row's current violation
 * with {@link expectZshRunsTheDisplay} and flips when its source fix lands.
 */
export function itUnderZsh(name: string, fn: () => Promise<void> | void, timeout?: number): void {
  (ZSH_AVAILABLE ? it : it.skip)(name, fn, timeout);
}

/** How long a span may run before the child is killed (SIGKILL). */
export const PASTE_CHILD_TIMEOUT_MS = 5_000;

/** The verbs stubbed on the child's PATH, and as shell functions. */
const STUBBED_VERBS = ['cdkd', 'aws'] as const;

/**
 * The stub directory {@link withPasteDir} put first on the child's PATH, set
 * for the duration of one `withPasteDir` call. {@link filesTouchedBy} refuses
 * to run without it: a span run outside the isolation is a span run against
 * the real `aws` and the real credentials.
 */
let stubBin: string | undefined;

/**
 * Lines, sentences and clauses — what an operator actually selects — plus
 * every run of two or more CONSECUTIVE lines, the whole message included
 * (go-to-k/cdkd#4133). A block pasted at once is one shell input, so a quote
 * one line opens can close on a later one: `the owner's record` /
 * `holds the stack's value "x$(touch OWNED)".` runs nothing line by line and
 * runs the substitution pasted whole, under bash and zsh alike. Every run, not
 * just the whole message, because a syntax error on a line OUTSIDE the
 * selection stops the whole-message span before it reaches the straddle.
 */
export function segmentsOf(message: string): Set<string> {
  const out = new Set<string>();
  const lines = message.split('\n');
  for (const line of lines) {
    out.add(line);
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      out.add(sentence);
      for (const clause of sentence.split(/: | — | -- /)) out.add(clause);
    }
  }
  for (let first = 0; first < lines.length; first++) {
    for (let last = first + 1; last < lines.length; last++) {
      out.add(lines.slice(first, last + 1).join('\n'));
    }
  }
  return out;
}

/** A shell the harness drives. */
export type PasteShell = 'bash' | 'zsh';

/** Options for a run: `shells` narrows {@link PASTE_SHELLS} for a bash-specific case. */
export interface PasteRunOptions {
  readonly shells?: readonly PasteShell[];
}

/**
 * The file a stubbed `cdkd` / `aws` writes when it is INVOKED (go-to-k/cdkd#3950):
 * the only evidence that a span ran a command, as opposed to a span whose
 * text merely contains the verb as an argument (`Could not … cdkd force-unlock`
 * runs `Could`). Never reported as a touched file; see {@link spanRun}.
 */
const VERB_RAN = 'VERB_RAN';

/**
 * Run one span under every shell in {@link PASTE_SHELLS} (or `options.shells`)
 * with `cdkd` and `aws` stubbed; return every file it CREATED or CHANGED under
 * any of them (each name once). The directory is put back after each shell. A
 * stubbed verb's own marker is not a touched file.
 */
export function filesTouchedBy(span: string, dir: string, options: PasteRunOptions = {}): string[] {
  return spanRun(span, dir, options).touched;
}

/** What one span did across the shells: the files it touched, and whether a stubbed verb ran. */
function spanRun(
  span: string,
  dir: string,
  options: PasteRunOptions
): { touched: string[]; verbRan: boolean } {
  const runs = (options.shells ?? PASTE_SHELLS).map((shell) => runUnder(shell, span, dir));
  return {
    touched: [...new Set(runs.flatMap((r) => r.touched))],
    verbRan: runs.some((r) => r.verbRan),
  };
}

/**
 * Run one span under `shell` with `cdkd` and `aws` stubbed; return every file it
 * CREATED or CHANGED, then put the directory back — created files removed,
 * changed decoys re-seeded — so the next span starts from the decoys alone.
 * The stubbed verbs' {@link VERB_RAN} marker is reported as `verbRan`, not as
 * a touched file.
 */
function runUnder(
  shell: PasteShell,
  span: string,
  dir: string
): { touched: string[]; verbRan: boolean } {
  expect(stubBin, 'filesTouchedBy runs only inside withPasteDir').toBeDefined();
  const before = new Map(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
  // A bounded child with a minimal env: a span that BLOCKS fails the case
  // rather than hanging the file, and `HOME` is the scratch directory so a
  // `~`-expanding span writes where the sweep below can see it. The stub
  // directory is FIRST on PATH (see the header).
  // The marker's path is ABSOLUTE, so a span that `cd`s before calling the
  // verb still writes it where the sweep below looks.
  const functions = STUBBED_VERBS.map((verb) => `${verb}() { : > '${join(dir, VERB_RAN)}'; };`).join(' ');
  const script = `${functions} ${span}`;
  // zsh reads the span on stdin as an INTERACTIVE shell (see the header);
  // bash's interactive default already reads ` #` as a comment, as `-c` does.
  // Two things an interactive zsh does that a paste into an operator's shell
  // does not (go-to-k/cdkd#4127 review):
  // - it opens the controlling terminal and reads commands from it, not from
  //   stdin, whenever the test run has one (a developer's `vp run test`), so
  //   the child is DETACHED into its own session, with no terminal (M6);
  // - its `!` history expansion aborts a `!<word>` span with "event not
  //   found", since the child's history is empty, while an operator's shell
  //   has a history and runs it. `no_bang_hist` is set on a line of its own
  //   BEFORE the span, because history expansion happens when a line is
  //   read, before any command on it runs (M8). The harness then
  //   over-approximates a successful expansion.
  const r = spawnSync(shell, shell === 'zsh' ? ['-f', '-i'] : ['-c', script], {
    cwd: dir,
    encoding: 'utf8',
    ...(shell === 'zsh' ? { input: `setopt no_bang_hist\n${script}\n`, detached: true } : {}),
    timeout: PASTE_CHILD_TIMEOUT_MS,
    // SIGKILL, not the default SIGTERM: `spawnSync` waits for the child to
    // EXIT after the signal, so a span ignoring TERM (`trap '' TERM`) would
    // hang the synchronous runner past the timeout.
    killSignal: 'SIGKILL',
    env: { PATH: `${stubBin}${delimiter}${process.env['PATH'] ?? ''}`, HOME: dir },
  });
  expect(r.error, `${shell} did not start, or hung, for: ${span}`).toBeUndefined();
  expect(r.signal, `the ${shell} child was killed for: ${span}`).toBeNull();
  const touched: string[] = [];
  const after = new Set(readdirSync(dir));
  for (const f of after) {
    const was = before.get(f);
    if (was === undefined) {
      touched.push(f);
      rmSync(join(dir, f), { recursive: true, force: true });
    } else if (readFileSync(join(dir, f), 'utf8') !== was) {
      touched.push(f);
      writeFileSync(join(dir, f), was, 'utf8');
    }
  }
  // A DELETED decoy ran too, and is re-seeded so later spans still have it.
  for (const [f, was] of before) {
    if (!after.has(f)) {
      touched.push(f);
      writeFileSync(join(dir, f), was, 'utf8');
    }
  }
  return { touched: touched.filter((f) => f !== VERB_RAN), verbRan: touched.includes(VERB_RAN) };
}

/**
 * An S1 row's zsh paste reason, pinned (go-to-k/cdkd#4127 review M0 / M2): a
 * `$( )` or backtick family displayed in the row's block RUNS when the message
 * is pasted into zsh, which a ` (` after it no longer stops, while every other
 * family stays inert. Asserted per value, so a case cannot pass on some other
 * failure. The bash side of the same row is asserted inert by the site's own
 * case (`{ shells: ['bash'] }`). When the row's source fix lands, the site
 * asserts `spansThatRun(...)` empty under both shells instead.
 */
export function expectZshRunsTheDisplay(message: string, dir: string, value: string): void {
  const ran: string[] = [];
  for (const span of segmentsOf(message)) {
    const run = spanRun(span, dir, { shells: ['zsh'] });
    if (run.touched.length === 0) continue;
    ran.push(span);
    // What ran is the DISPLAY: no stubbed verb, and the span holds the value
    // (raw or JSON-escaped), so a run caused by something else in the message
    // cannot stand in for the row's reason.
    expect(run.verbRan, `a zsh span that ran also ran a stubbed cdkd / aws: ${span}`).toBe(false);
    expect(
      span.includes(value) || span.includes(JSON.stringify(value).slice(1, -1)),
      `a zsh span ran without the displayed value: ${span}`
    ).toBe(true);
  }
  if (/\$\(|`/.test(value)) {
    expect(ran.length, `zsh ran nothing for ${value}`).toBeGreaterThan(0);
  } else {
    expect(ran, `zsh ran an inert family for ${value}`).toEqual([]);
  }
}

/** Every span of `message` ({@link segmentsOf}) that touched a file. */
export function spansThatRun(message: string, dir: string, options: PasteRunOptions = {}): string[] {
  const out: string[] = [];
  for (const span of segmentsOf(message)) {
    if (filesTouchedBy(span, dir, options).length > 0) out.push(span);
  }
  return out;
}

/** Options for {@link expectOnlyDisplayResidual}. */
export interface ResidualOptions {
  /**
   * Set ONLY for a classified S1 row of go-to-k/cdkd#3950 whose source fix has
   * not landed: the row's block rule is asserted by its own case, and this
   * helper asserts that the row still violates it (so the option cannot spread
   * to another row or outlive the fix). The text must name the row and carry
   * the `go-to-k/cdkd#3950` reference; remove it as the row's fix lands.
   */
  readonly unfixedS1Row?: string;
}

/**
 * The per-block criterion, for a message rendered with a HOSTILE `value` the
 * gate WITHHELD.
 *
 * A message whose value the gate NAMED must be inert in every span — the
 * caller asserts `spansThatRun(...)` empty for that. For a withheld value the
 * message still DISPLAYS it in prose, and a displayed value in a pasted
 * sentence is the maintainer's go-to-k/cdkd#3486 round-3 finding: the JSON
 * boundary `displayIdent` puts around it makes a `;` and a `'` literal, but
 * double quotes do not stop `$( )` or a backtick, so a prose span that parses
 * can still run. His criterion is therefore per BLOCK — a block carrying an
 * untrusted value carries no pasteable command, and what it displays is
 * go-to-k/cdkd#3232's class. This helper pins both halves. The RUNTIME half,
 * through {@link expectRuntimeResidual}: no span
 * that runs also runs a stubbed `cdkd` / `aws` (its marker, not a verb token
 * in the text: `Could not … cdkd force-unlock …` runs `Could`, with `cdkd` as
 * an argument, go-to-k/cdkd#3950), and every one that runs holds THE VALUE
 * inside a paired JSON span — a bare `displaySafe` render, which the SSM
 * refusal used to have, runs on a plain `;` and fails this, and so does a
 * bare value with unrelated `"..."` words on either side of it. Returns the
 * residual so a caller can see what ran. Where a site's spans are ALL inert
 * today, its test asserts `spansThatRun(...)` empty instead — the stronger
 * contract — and this helper is for the site whose display genuinely runs.
 * The TEXT half, a command quoted beside the display on the same line, is
 * {@link expectNoCommandBesideDisplay}, which this helper runs first; for a
 * caller naming an unfixed S1 row ({@link ResidualOptions.unfixedS1Row}) it
 * asserts instead that the row still VIOLATES the rule.
 */
export function expectOnlyDisplayResidual(
  message: string,
  dir: string,
  value: string,
  options: ResidualOptions = {}
): string[] {
  // The TEXT half first, by default (the maintainer's go-to-k/cdkd#4127 M11):
  // a row nobody classified reds here instead of passing on its runtime half
  // alone. A classified S1 row names itself to skip it until its fix lands.
  if (options.unfixedS1Row !== undefined) {
    expect(options.unfixedS1Row, 'an unfixedS1Row names its go-to-k/cdkd#3950 row').toMatch(
      /go-to-k\/cdkd#3950\b/
    );
    // The opt-out must still be a VIOLATION (M13): it cannot spread to a
    // harness-only row, or outlive its row's fix.
    expect(
      () => expectNoCommandBesideDisplay(message, value),
      `unfixedS1Row "${options.unfixedS1Row}" no longer violates the block rule; remove it`
    ).toThrow(/also carries a pasteable command/);
  } else {
    expectNoCommandBesideDisplay(message, value);
  }
  return expectRuntimeResidual(message, dir, value);
}

/**
 * The RUNTIME half of {@link expectOnlyDisplayResidual} on its own, without the
 * block rule: for the harness's self-test, which drives it through spans that
 * also carry a command (go-to-k/cdkd#4127 round-5 optional). A site test uses
 * {@link expectOnlyDisplayResidual}, so the options a site can pass hold no
 * switch that skips the block rule.
 */
export function expectRuntimeResidual(message: string, dir: string, value: string): string[] {
  const ran: string[] = [];
  for (const span of segmentsOf(message)) {
    const run = spanRun(span, dir, {});
    if (run.touched.length === 0) continue;
    ran.push(span);
    // The marker a stubbed verb writes when it is INVOKED, under either shell.
    expect(run.verbRan, `a span that ran also ran a stubbed cdkd / aws: ${span}`).toBe(false);
    // The value must sit INSIDE a paired JSON span: strip every properly
    // paired `"..."` and require the value gone. A flanking-pair regex
    // (`"[^"]*value[^"]*"`) is satisfied by a BARE value between two
    // unrelated quoted words (`Key "a" holds x$(touch OWNED) at "b"`, which
    // runs).
    // ...and, positively, one paired span must HOLD the value: a clause split
    // that cut the value in half (`x$(touch OWNED): y` at a `: `) leaves a
    // running span with no boundary and no whole value, which the absence
    // check alone accepts.
    // Each paired span is DECODED before the containment test: a value
    // carrying `"` or `\` renders JSON-escaped, and comparing the encoded
    // text with the raw value refuses a correctly bounded render. A span that
    // is not valid JSON decodes to nothing and holds nothing.
    // Only a span that DECODES is a boundary; one that does not (`"\q ..."`)
    // is left in the remainder, where the value inside it counts as bare —
    // stripping every quoted run lets a second copy hide in an invalid span
    // beside a valid one.
    const decode = (s: string): string | undefined => {
      try {
        return String(JSON.parse(s));
      } catch {
        return undefined;
      }
    };
    const paired = span.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
    expect(
      paired.some((s) => decode(s)?.includes(value) === true),
      'a span ran without a paired JSON boundary holding the value'
    ).toBe(true);
    const stripped = span.replace(/"(?:[^"\\]|\\.)*"/g, (s) => (decode(s) === undefined ? s : ''));
    expect(stripped, 'a span ran with the value outside a JSON boundary').not.toContain(value);
  }
  return ran;
}

/**
 * cdkd's top-level commands, the words a pasteable `cdkd` invocation starts
 * with. `pasteable-message-paste.test.ts` pins this list to `buildProgram()`'s
 * own commands, so a new command cannot fall outside it unnoticed.
 */
export const CDKD_TOP_LEVEL_COMMANDS = [
  'bootstrap',
  'synth',
  'list',
  'deploy',
  'diff',
  'drift',
  'destroy',
  'rollback',
  'scrub',
  'events',
  'gc',
  'orphan',
  'import',
  'publish-assets',
  'force-unlock',
  'state',
  'local',
  'export',
] as const;

/**
 * A pasteable command, as the block rule means it: a `cdkd <command>` or an
 * `aws <service> <operation>` invocation (its words split by spaces or tabs),
 * or a `--flag`, each starting a word (after whitespace, a quote, a backtick or
 * `(`) and ending one (before whitespace, a quote, `=`, a backtick or
 * punctuation). A prose mention such as `cdkd records the name` is not one:
 * `records` is not a cdkd command.
 */
const PASTEABLE_COMMAND = new RegExp(
  `(^|[\\s'"\`(])(cdkd[ \\t]+(?:${CDKD_TOP_LEVEL_COMMANDS.join('|')})|aws[ \\t]+[a-z0-9-]+[ \\t]+[a-z0-9-]+|--[a-z][a-z-]*)(?=$|[\\s'"=\`.,;:)])`
);

/**
 * The BLOCK rule, stated over the message text (go-to-k/cdkd#3486 round 3; the
 * S1 rows of go-to-k/cdkd#3950): a block that DISPLAYS the untrusted `value`
 * carries no pasteable command ({@link PASTEABLE_COMMAND}), whether it is a
 * directive or quoted in prose. "Displays" means a line holds the value raw or
 * JSON-escaped, a JSON-quoted path around it included, or, for a payload, a
 * line holding its sentinel. A value split across lines by its own newline is
 * therefore covered only when it carries the sentinel. Pass a HOSTILE value: a
 * plain one may be named beside its own command.
 *
 * A block is a LINE (the maintainer's go-to-k/cdkd#4127 round-3 ruling): a
 * line that displays the value must carry no command, and a command on a line
 * of its own is not beside it. Pasting such a message whole runs what pasting
 * the value's line alone runs, so the command line adds no execution. The
 * caveat is a span that crosses lines through a straddling quote, which is
 * go-to-k/cdkd#4133's.
 *
 * {@link expectOnlyDisplayResidual} runs this by default; on its own it is
 * what an S1 row's block-rule case asserts, until the row describes the value
 * instead of showing it.
 */
export function expectNoCommandBesideDisplay(message: string, value: string): void {
  const escaped = JSON.stringify(value).slice(1, -1);
  // A line displays the value when it holds the whole value, raw or
  // JSON-escaped, or, for a payload, its sentinel (go-to-k/cdkd#4127 M14): that
  // sees a value split across lines by its own newline, and a cut or
  // re-quoted copy, on the very line that shows it. A display cut before the
  // sentinel is invisible to any text rule; the runtime half still measures
  // it. Only `\n` splits a line: a bare `\r` stays inside it, the
  // conservative direction, since a terminal paste reads `\r` as Enter.
  const sentinel = value.includes(PAYLOAD_SENTINEL);
  for (const line of message.split('\n')) {
    const displays =
      line.includes(value) || line.includes(escaped) || (sentinel && line.includes(PAYLOAD_SENTINEL));
    if (!displays) continue;
    expect(line, 'a line that displays the value also carries a pasteable command').not.toMatch(
      PASTEABLE_COMMAND
    );
  }
}

/**
 * The command every payload family carries, whatever shape its display takes.
 * The block rule keys on it, and `pasteable-message-paste.test.ts` asserts every
 * payload carries it.
 */
export const PAYLOAD_SENTINEL = 'touch OWNED';

/**
 * A scratch directory seeded with the decoys, beside a stub `bin` the child's
 * PATH starts with, both removed afterwards. The POSITIVE CONTROLS run first:
 * a payload that had silently stopped working — a shell that does not do
 * backticks, a sentinel name that collides — would otherwise make every
 * "nothing ran" below pass for the wrong reason. `echo`, not a bare `Name:`
 * prefix: with a quote-carrying payload `Name: x' ; ...` makes `Name:` the
 * command and its own quotes swallow the rest, so that control never ran and
 * reported the payload as inert. The `flipped` family gets its apostrophe from
 * the control sentence, as it would from prose. Then a bare-hole REDIRECTION
 * onto a decoy, which creates no file: it is what proves the decoy mechanism
 * sees a truncation. Last, the PATH control: each stubbed verb, looked up
 * through PATH alone (`type -P` in bash, `whence -p` in zsh, which ignore the
 * shell functions), must resolve to the stub beside the scratch directory — the
 * property the unstubbed-spelling argument in the header rests on. The
 * controls run under EACH shell.
 */
export function withPasteDir<T>(fn: (dir: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'cdkd-paste-'));
  const dir = join(root, 'work');
  const bin = join(root, 'bin');
  mkdirSync(dir);
  mkdirSync(bin);
  for (const verb of STUBBED_VERBS) {
    writeFileSync(join(bin, verb), `#!/bin/sh\n: > '${join(dir, VERB_RAN)}'\nexit 0\n`, 'utf8');
    chmodSync(join(bin, verb), 0o755);
  }
  // Saved and restored rather than cleared, so a nested call leaves the
  // outer one's isolation in place.
  const outer = stubBin;
  stubBin = bin;
  try {
    for (const decoy of DECOYS) writeFileSync(join(dir, decoy), DECOY_CONTENT, 'utf8');
    // A missing zsh is a skip only outside CI (see the header).
    expect(
      ZSH_AVAILABLE || !process.env['CI'],
      'zsh is not installed, and under CI the paste harness must drive it'
    ).toBe(true);
    // Keyed on AVAILABILITY, not on `PASTE_SHELLS`: a population that dropped
    // zsh would otherwise skip the very control that catches the drop (M7).
    if (ZSH_AVAILABLE) {
      // `zsh -f` reads no startup file: one planted in the child's HOME (the
      // scratch directory) would otherwise run before every span.
      writeFileSync(join(dir, '.zshenv'), 'touch RC_RAN\n', 'utf8');
      expect(runUnder('zsh', 'true', dir).touched, 'zsh read a startup file').toEqual([]);
      rmSync(join(dir, '.zshenv'));
      // The shape the two shells disagree on, as its own control: an unquoted
      // `(` after a JSON-quoted `$( )` stops bash at a syntax error, and zsh
      // runs the substitution before it reports the bad pattern.
      const disagreement = 'echo "x$(touch OWNED)" (us-east-1)';
      expect(runUnder('bash', disagreement, dir).touched, 'bash ran past the `(`').toEqual([]);
      expect(runUnder('zsh', disagreement, dir).touched, 'zsh stopped at the `(`').toEqual([
        'OWNED',
      ]);
      // The ` #` shape: bash (interactive or `-c`) reads it as a comment, and
      // an interactive zsh, which a macOS paste reaches, does not. A zsh run
      // through `-c` would report this line inert.
      const comment = 'echo see #1 "x$(touch OWNED)" here';
      expect(runUnder('bash', comment, dir).touched, 'bash ran past the ` #`').toEqual([]);
      expect(runUnder('zsh', comment, dir).touched, 'zsh read the ` #` as a comment').toEqual([
        'OWNED',
      ]);
      // The zsh child has no terminal, so it reads the span from stdin even
      // when the test run has one (M6): `$TTY` is empty.
      expect(runUnder('zsh', '[[ -z $TTY ]] && touch OWNED', dir).touched, 'the zsh child has a tty').toEqual([
        'OWNED',
      ]);
      // A `!<word>` span runs, as it would in an operator's shell with a
      // history (M8); an empty history would abort it with "event not found".
      expect(runUnder('zsh', 'echo "x$(touch OWNED)!aws"', dir).touched, 'zsh history expansion aborted the span').toEqual([
        'OWNED',
      ]);
      // The DEFAULT shell list reaches zsh (M7): a call with no `shells`
      // option runs the shape only zsh runs. A population hard-coded to bash
      // would otherwise turn every default `spansThatRun` bash-only in silence.
      expect(filesTouchedBy(disagreement, dir), 'the default shell list does not reach zsh').toEqual([
        'OWNED',
      ]);
    }
    // Every control runs under EACH shell on its own: a union would let one
    // shell's working control hide the other's dead one.
    for (const shell of PASTE_SHELLS) {
      for (const payload of [...PASTE_PAYLOADS, CLAUSE_BREAK_PAYLOAD]) {
        const { label, value, flipped } = payload;
        const control =
          'control' in payload ? payload.control : flipped ? `echo it's ${value}` : `echo ${value}`;
        expect(
          runUnder(shell, control, dir).touched,
          `the ${label} control did not run under ${shell}`
        ).toContain('OWNED');
      }
      expect(
        runUnder(shell, 'cdkd state show <stack> region', dir).touched,
        `the redirection control did not truncate its decoy under ${shell}`
      ).toEqual(['region']);
      // The population is spelled out here, not read off `STUBBED_VERBS`: a
      // verb dropped from that list would otherwise drop its own control.
      // `type -P` is bash's PATH-only lookup, `whence -p` is zsh's.
      const lookup = shell === 'zsh' ? 'whence -p' : 'type -P';
      for (const verb of ['cdkd', 'aws']) {
        expect(
          runUnder(
            shell,
            `[ "$(${lookup} ${verb})" -ef "$HOME/../bin/${verb}" ] && touch OWNED`,
            dir
          ).touched,
          `${verb} does not resolve to the stub first on PATH under ${shell}`
        ).toEqual(['OWNED']);
        // The verb marker: an invocation through the function AND through the
        // PATH stub (`command` skips the function) reports `verbRan`, so does
        // one after a `cd` (the marker's path is absolute), and a span naming
        // the verb as an argument does not.
        for (const invocation of [
          `${verb} state show x`,
          `command ${verb} state show x`,
          `cd .. && ${verb} state show x`,
          `cd .. && command ${verb} state show x`,
        ]) {
          expect(
            runUnder(shell, invocation, dir),
            `${invocation} did not report its verb under ${shell}`
          ).toEqual({ touched: [], verbRan: true });
        }
        expect(
          runUnder(shell, `echo ${verb} state show x`, dir),
          `echo ${verb} reported a verb under ${shell}`
        ).toEqual({ touched: [], verbRan: false });
      }
    }
    return fn(dir);
  } finally {
    stubBin = outer;
    rmSync(root, { recursive: true, force: true });
  }
}
