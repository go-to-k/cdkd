/**
 * The PASTE harness: feed a rendered cdkd message to a real bash at three
 * granularities and report which spans RAN.
 *
 * Shared by `pasteable-message-paste.test.ts` (the shapes) and by the test
 * file of every site go-to-k/cdkd#3436's fold-in touched, so each site drives
 * ITS OWN renderer through the same bash rather than a synthetic copy of what
 * it prints. What that buys is stated exactly: at every folded-in site but the
 * SSM refusal the pre-fold message was ALREADY inert under paste, because its
 * value was gated before the fold and only the SHAPE around the command
 * changed — so reverting such a site reds its SPELLING pins, not its paste
 * case. The paste case is defence in depth there: it pins that the fold, and
 * any later edit, introduces no running span, and it is the one fence that
 * can see a running DISPLAY (`expectOnlyDisplayResidual`). At the SSM site the
 * paste case alone reds a revert — the bare `displaySafe` prose ran on a plain
 * `;` — which is the one site where the harness is the primary fence.
 *
 * THREE GRANULARITIES, because the issue measured why all three are needed: on
 * the vulnerable build, pasting whole LINES found 0 instances — the line also
 * held `resource record(s)`, whose `(` is a bash syntax error that stops the
 * line before the payload — while sentences found 2 and clauses found 2. An
 * operator selects a phrase, not a line.
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
 * not found at all. The bash functions of the same names still cover the
 * exact spellings (a function wins over PATH).
 */

import { expect } from 'vite-plus/test';
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
] as const;

const DECOY_CONTENT = 'decoy\n';

/** How long a span may run before the child is killed (SIGKILL). */
export const PASTE_CHILD_TIMEOUT_MS = 5_000;

/** The verbs stubbed on the child's PATH, and as bash functions. */
const STUBBED_VERBS = ['cdkd', 'aws'] as const;

/**
 * The stub directory {@link withPasteDir} put first on the child's PATH, set
 * for the duration of one `withPasteDir` call. {@link filesTouchedBy} refuses
 * to run without it: a span run outside the isolation is a span run against
 * the real `aws` and the real credentials.
 */
let stubBin: string | undefined;

/** Lines, sentences and clauses — what an operator actually selects. */
export function segmentsOf(message: string): Set<string> {
  const out = new Set<string>();
  for (const line of message.split('\n')) {
    out.add(line);
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      out.add(sentence);
      for (const clause of sentence.split(/: | — | -- /)) out.add(clause);
    }
  }
  return out;
}

/**
 * Run one span under bash with `cdkd` and `aws` stubbed; return every file it
 * CREATED or CHANGED, then put the directory back — created files removed,
 * changed decoys re-seeded — so the next span starts from the decoys alone.
 */
export function filesTouchedBy(span: string, dir: string): string[] {
  expect(stubBin, 'filesTouchedBy runs only inside withPasteDir').toBeDefined();
  const before = new Map(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
  // A bounded child with a minimal env: a span that BLOCKS fails the case
  // rather than hanging the file, and `HOME` is the scratch directory so a
  // `~`-expanding span writes where the sweep below can see it. The stub
  // directory is FIRST on PATH (see the header).
  const functions = STUBBED_VERBS.map((verb) => `${verb}() { :; };`).join(' ');
  const r = spawnSync('bash', ['-c', `${functions} ${span}`], {
    cwd: dir,
    encoding: 'utf8',
    timeout: PASTE_CHILD_TIMEOUT_MS,
    // SIGKILL, not the default SIGTERM: `spawnSync` waits for the child to
    // EXIT after the signal, so a span ignoring TERM (`trap '' TERM`) would
    // hang the synchronous runner past the timeout.
    killSignal: 'SIGKILL',
    env: { PATH: `${stubBin}${delimiter}${process.env['PATH'] ?? ''}`, HOME: dir },
  });
  expect(r.error, `bash did not start, or hung, for: ${span}`).toBeUndefined();
  expect(r.signal, `the child was killed for: ${span}`).toBeNull();
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
  return touched;
}

/** Every span of `message`, at all three granularities, that touched a file. */
export function spansThatRun(message: string, dir: string): string[] {
  const out: string[] = [];
  for (const span of segmentsOf(message)) {
    if (filesTouchedBy(span, dir).length > 0) out.push(span);
  }
  return out;
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
 * go-to-k/cdkd#3232's class — and that is what this pins: no span that runs
 * carries a command fragment (a `cdkd` / `aws` verb, or a `--flag` remedy such
 * as the SSM `--resource` one), and every one that runs holds THE VALUE
 * inside a paired JSON span — a bare `displaySafe` render, which the SSM
 * refusal used to have, runs on a plain `;` and fails this, and so does a
 * bare value with unrelated `"..."` words on either side of it. Returns the
 * residual so a caller can see what ran. Where a site's spans are ALL inert
 * today, its test asserts `spansThatRun(...)` empty instead — the stronger
 * contract — and this helper is for the site whose display genuinely runs.
 */
export function expectOnlyDisplayResidual(message: string, dir: string, value: string): string[] {
  const ran = spansThatRun(message, dir);
  for (const span of ran) {
    // A verb may sit behind a prose quote (`run 'cdkd state show ...'`), which
    // is the pre-fold shape itself, so the boundary before it is whitespace OR
    // a quote, not whitespace alone; and the boundary after it is whitespace
    // OR the end of the span, so a span ending in `cdkd` or `--force` counts.
    expect(span, 'a span carrying a command fragment ran').not.toMatch(
      /(^|[\s'"`])(cdkd|aws|--[a-z][a-z-]*)(\s|$)/
    );
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
 * through PATH alone (`type -P`, which ignores the bash functions), must
 * resolve to the stub beside the scratch directory — the property the
 * unstubbed-spelling argument in the header rests on.
 */
export function withPasteDir<T>(fn: (dir: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'cdkd-paste-'));
  const dir = join(root, 'work');
  const bin = join(root, 'bin');
  mkdirSync(dir);
  mkdirSync(bin);
  for (const verb of STUBBED_VERBS) {
    writeFileSync(join(bin, verb), '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(join(bin, verb), 0o755);
  }
  stubBin = bin;
  try {
    for (const decoy of DECOYS) writeFileSync(join(dir, decoy), DECOY_CONTENT, 'utf8');
    for (const { label, value, flipped } of PASTE_PAYLOADS) {
      const control = flipped ? `echo it's ${value}` : `echo ${value}`;
      expect(filesTouchedBy(control, dir), `the ${label} control did not run`).toContain('OWNED');
    }
    expect(
      filesTouchedBy('cdkd state show <stack> region', dir),
      'the redirection control did not truncate its decoy'
    ).toEqual(['region']);
    // The population is spelled out here, not read off `STUBBED_VERBS`: a
    // verb dropped from that list would otherwise drop its own control.
    for (const verb of ['cdkd', 'aws']) {
      expect(
        filesTouchedBy(`[ "$(type -P ${verb})" -ef "$HOME/../bin/${verb}" ] && touch OWNED`, dir),
        `${verb} does not resolve to the stub first on PATH`
      ).toEqual(['OWNED']);
    }
    return fn(dir);
  } finally {
    stubBin = undefined;
    rmSync(root, { recursive: true, force: true });
  }
}
