/**
 * The PASTE fence: the message SHAPES this lane introduced, plus the pure
 * message builders it touched, fed to real shells (bash, and zsh where it is
 * installed) at three granularities with
 * four payload families — through `paste-harness.ts`, which the test file of
 * every other touched site (`gc.test.ts`, `export-composite-identifier.test.ts`,
 * `rollback-executor-retain-new-resource.test.ts`,
 * `pasteable-command-hand-quoted-ids.test.ts`) also runs its OWN rendered
 * message through. What a per-site paste case catches is stated in the
 * harness header: at every folded-in site but the SSM refusal the pre-fold
 * message was already inert under paste, so a revert there reds the site's
 * SPELLING pins and the paste case is defence in depth over the rendered text;
 * at the SSM site the paste case alone reds the revert.
 *
 * go-to-k/cdkd#3436 asks for this separately from the source fence, and the
 * reason is its shape C. A `shellQuote`d value in PROSE needs no command and no
 * placeholder to be dangerous: an apostrophe anywhere EARLIER in the sentence
 * (`this stack's name`, `the record's region`, `doesn't`) opens a shell quote,
 * which then closes at the value's own opening quote and leaves the value bare.
 * Measured on go-to-k/cdkd#3363's `c5f07636`. A source-shape check cannot see
 * that — the hazard is a property of the RENDERED sentence, not of the literal.
 */

import { describe, expect, it } from 'vite-plus/test';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandHole, pasteableCommand, shellQuote } from '../../../src/utils/pasteable-command.js';
import { displayIdent } from '../../../src/utils/display-safe.js';
import {
  malformedOrphansWarning,
  malformedOutputsWarning,
} from '../../../src/state/malformed-resources-bag.js';
import { buildProgram } from '../../../src/cli/program.js';
import {
  CDKD_TOP_LEVEL_COMMANDS,
  PASTE_CHILD_TIMEOUT_MS,
  PASTE_PAYLOADS,
  PASTE_SHELLS,
  expectNoCommandBesideDisplay,
  expectOnlyDisplayResidual,
  expectZshRunsTheDisplay,
  filesTouchedBy,
  spansThatRun,
  withPasteDir,
} from './paste-harness.js';

describe('pasteable messages — nothing runs at any granularity', () => {
  /**
   * `expectOnlyDisplayResidual` runs the per-line block rule first by default
   * (go-to-k/cdkd#4127 M11). The cases below drive its RUNTIME half on its
   * own, through spans that also carry a command, so they opt out; the
   * default itself is pinned by the block-rule self-test.
   */
  const RUNTIME_ONLY = { selfTestRuntimeHalfOnly: true } as const;

  /**
   * The messages, each with the command line its renderer is EXPECTED to
   * print for a hostile payload. The first three are the SHAPES every
   * folded-in site now uses, built from the shared gate; the last two are REAL
   * builders from `malformed-resources-bag.ts`, whose `inspectCommand` this
   * lane moved onto the gate, rendered with the payload as the stack name and
   * as the region. Every entry pins its own expected command, and the survive
   * cases pin the LIST of labels independently, so a builder dropped from
   * here, or one that stopped holing the payload, is a red case rather than a
   * smaller "nothing ran" — the three synthetic shapes alone paste more spans
   * than any aggregate floor would notice losing the two real builders from.
   */
  const PASTE_SITES = [
    'gated stack',
    'gated region',
    'holes',
    'malformedOutputsWarning',
    'malformedOrphansWarning',
  ];
  function messagesFor(payload: string): Array<{ label: string; message: string; expects: string }> {
    const gated = pasteableCommand('cdkd state show', [
      { value: payload, hole: 'stack' },
      { flag: '--stack-region', value: 'us-east-1', hole: 'region' },
    ]);
    const exact = pasteableCommand('cdkd state show', [
      { value: 'MyStack', hole: 'stack' },
      { flag: '--stack-region', value: payload, hole: 'region' },
    ]);
    return [
      {
        // The shape every folded-in site uses: prose that POINTS at a trailing
        // labelled line, with an apostrophe earlier in it on purpose.
        label: 'gated stack',
        message:
          `This record's name could not be read — inspect the object at that key.` +
          `\nInspect it with: ${gated.command}`,
        expects: `\nInspect it with: cdkd state show ${shellQuote(payload)} --stack-region us-east-1`,
      },
      {
        // The same, with the REGION as the hostile value.
        label: 'gated region',
        message: `The stack's region doesn't render exactly.\nInspect it with: ${exact.command}`,
        expects: `\nInspect it with: cdkd state show MyStack --stack-region ${shellQuote(payload)}`,
      },
      {
        // A hole-only command, which is what a fully withheld site prints.
        label: 'holes',
        message:
          `The record's identity is withheld.` +
          `\nInspect it with: cdkd state show ${commandHole('stack')} ` +
          `--stack-region ${commandHole('region')}`,
        expects: `\nInspect it with: cdkd state show '<stack>' --stack-region '<region>'`,
      },
      {
        // The real builders hold both values to `plainIdent`, so a payload is
        // a HOLE there where the synthetic gate above names it shell-quoted.
        label: 'malformedOutputsWarning',
        message: malformedOutputsWarning(payload, 'us-east-1'),
        expects: ` with: cdkd state show '<stack>' --stack-region us-east-1 --json`,
      },
      {
        label: 'malformedOrphansWarning',
        message: malformedOrphansWarning('MyStack', payload),
        expects: ` with: cdkd state show MyStack --stack-region '<region>' --json`,
      },
    ];
  }

  for (const { label, value } of PASTE_PAYLOADS) {
    it(`survives a ${label} payload at line, sentence and clause granularity`, () => {
      withPasteDir((dir) => {
        const messages = messagesFor(value);
        expect(messages.map((m) => m.label)).toEqual(PASTE_SITES);
        for (const { label: site, message, expects } of messages) {
          expect(message, `${site} did not render the command this case expects`).toContain(
            expects
          );
          expect(spansThatRun(message, dir), `${label} ran in ${site}`).toEqual([]);
        }
      });
    }, 120_000);
  }

  it('pastes SENTENCES and CLAUSES, not lines alone — the blind spot the issue measured', () => {
    // The mutant that replaces the splitter with `[line]` extracts fewer
    // spans from every message above, but it leaves their "nothing ran"
    // verdict unchanged — none of the dropped sentences or clauses runs
    // either, so the survive cases cannot see it. So the granularity is pinned
    // HERE, on the shape the issue measured: a line whose payload-bearing
    // sentence is preceded by `record(s)`. The `(` is a syntax error that
    // stops bash before the payload, so the LINE is inert and only the
    // sentence runs.
    // BASH ONLY (go-to-k/cdkd#3950, the maintainer's H3): this case pins
    // bash's own stop at `record(s)`, the measurement this suite was written
    // around. zsh reads `(s)` as a glob qualifier and runs past it, which the
    // site cases measure; here it would change what is being pinned.
    const BASH_ONLY = { shells: ['bash'] } as const;
    withPasteDir((dir) => {
      const value = shellQuote('x$(touch OWNED)');
      const sentence = `The record's name is ${value} and it isn't readable.`;
      // The LINE split first: a message whose first line is inert (`record(s)`
      // aborts it) and whose second line runs only extracts that second line
      // when lines are split — pasted whole, the syntax error on line one
      // stops bash before line two.
      const secondLine = 'echo $(touch OWNED)';
      const twoLines = `Found 2 resource record(s)\n${secondLine}`;
      expect(filesTouchedBy(twoLines, dir, BASH_ONLY), 'the whole message must be inert').toEqual([]);
      expect(spansThatRun(twoLines, dir, BASH_ONLY)).toEqual([secondLine]);
      // Once per sentence terminator the splitter knows (`.`, `!`, `?`): a
      // control over `.` alone leaves `[.!?]` -> `[.]` green.
      for (const terminator of ['.', '!', '?']) {
        const line = `Found 2 resource record(s) in this stack${terminator} ${sentence}`;
        expect(
          filesTouchedBy(line, dir, BASH_ONLY),
          `${terminator}: the whole line must be inert for this to pin anything`
        ).toEqual([]);
        expect(spansThatRun(line, dir, BASH_ONLY), terminator).toEqual([sentence]);
      }
      // And the LINE itself is a span: a line that runs only WHOLE, because
      // the sentence boundary sits inside a quoted run so every extracted
      // sentence and clause is an unclosed quote (dropping `out.add(line)`
      // leaves every other control green, their lines being inert by design).
      const wholeLine = `echo 'prefix. '$(touch OWNED)' suffix'`;
      expect(spansThatRun(wholeLine, dir, BASH_ONLY)).toEqual([wholeLine]);
      // And a SENTENCE that runs only whole: its line is inert (`record(s)`),
      // and its clause split at `: ` falls inside the quoted run, so each
      // clause is an unclosed quote. The sentence controls above carry no
      // clause separator, so the clause loop re-adds the identical span and
      // dropping `out.add(sentence)` is invisible to them.
      const sentenceOnly = `echo 'prefix: '$(touch OWNED)' suffix'`;
      expect(spansThatRun(`Found record(s). ${sentenceOnly}`, dir, BASH_ONLY)).toEqual([sentenceOnly]);
      // And the CLAUSE split, once per separator the splitter knows (`: `,
      // ` — `, ` -- `), where the sentence is the whole line (no `. `) and the
      // payload sits after the separator: deleting any one alternative leaves
      // its line's only running clause unextracted, and the "nothing ran"
      // assertions above would accept that silently.
      const clause = `the record's name is ${value} and it isn't readable.`;
      for (const separator of [': ', ' — ', ' -- ']) {
        const joined = `Found 2 resource record(s)${separator}${clause}`;
        expect(filesTouchedBy(joined, dir, BASH_ONLY), JSON.stringify(separator)).toEqual([]);
        expect(spansThatRun(joined, dir, BASH_ONLY), JSON.stringify(separator)).toEqual([clause]);
      }
    });
  }, 120_000);

  it('the block rule accepts a block with no command and refuses each command shape beside a display', () => {
    // `expectNoCommandBesideDisplay` decides the S1 rows (go-to-k/cdkd#3950), so
    // each of its clauses is driven here on its own.
    const v = 'x$(touch OWNED)';
    const refuses = (message: string): void =>
      expect(() => expectNoCommandBesideDisplay(message, v), message).toThrow(
        /also carries a pasteable command/
      );
    // Accepted: a display with no command, a command with no display, and a
    // prose mention of cdkd that is not an invocation.
    expectNoCommandBesideDisplay(`Nothing is recorded for ${JSON.stringify(v)}.`, v);
    expectNoCommandBesideDisplay("Run 'cdkd deploy' to deploy it.", v);
    expectNoCommandBesideDisplay(`cdkd records ${JSON.stringify(v)} as the name.`, v);
    // Refused: a directive and a prose quote, a bare display, a value inside a
    // JSON-quoted path, an `aws` operation, and a `--flag` ending in `'`, `.`,
    // `=` or the end of the block.
    refuses(`Nothing to roll back for ${JSON.stringify(v)}. Run 'cdkd deploy' to deploy it.`);
    refuses(`Events for ${JSON.stringify(v)} are recorded by 'cdkd deploy'.`);
    refuses(`Nothing to roll back for ${v}; run cdkd rollback.`);
    refuses(`No file at ${JSON.stringify(`cdkd/${v}/state.json`)}: aws s3 ls it.`);
    refuses(`No ${JSON.stringify(v)} here. Retry with '--force'.`);
    refuses(`No ${JSON.stringify(v)} here. Retry with --force.`);
    refuses(`No ${JSON.stringify(v)} here: --resource=x`);
    refuses(`No ${JSON.stringify(v)} here: --force`);
    // Each boundary character on its own: a command opened by a backtick or
    // `(`, and one closed by a backtick.
    refuses(`No ${JSON.stringify(v)} here: \`cdkd deploy x`);
    refuses(`No ${JSON.stringify(v)} here (cdkd deploy x`);
    refuses(`No ${JSON.stringify(v)} here: run --force\` now`);
    // A value JSON escaping CHANGES, displayed only RAW, and then only in its
    // escaped form: each detection arm on its own.
    const rawOnly = `Nothing for x"$(touch OWNED). Run 'cdkd deploy'.`;
    expect(rawOnly.includes(JSON.stringify('x"$(touch OWNED)').slice(1, -1))).toBe(false);
    expect(() => expectNoCommandBesideDisplay(rawOnly, 'x"$(touch OWNED)')).toThrow(
      /also carries a pasteable command/
    );
    const quoted = 'x"$(touch OWNED)';
    const escapedOnly = `Nothing for ${JSON.stringify(quoted)}. Run 'cdkd deploy'.`;
    expect(escapedOnly.includes(quoted)).toBe(false);
    expect(() => expectNoCommandBesideDisplay(escapedOnly, quoted)).toThrow(
      /also carries a pasteable command/
    );
    // Both boundaries: a token embedded in a longer word, and a command name
    // as a PREFIX of one, are not invocations.
    expectNoCommandBesideDisplay(`${JSON.stringify(v)} -- mycdkd deploy x`, v);
    expectNoCommandBesideDisplay(`${JSON.stringify(v)} -- cdkd deployment x`, v);
    expectNoCommandBesideDisplay(`${JSON.stringify(v)} -- see aws-docs x`, v);
    expectNoCommandBesideDisplay(`${JSON.stringify(v)} -- a x--force flag`, v);
    // EVERY boundary character on its own, so dropping any one alternative of
    // the pattern reds exactly its case. Whitespace is a space, a tab and a
    // newline, each on its own. Opening: the block start, whitespace, a quote,
    // a backtick, `(`. Closing: the block end, whitespace, a quote, `=`, a
    // backtick, `.`, `,`, `;`, `:`, `)`.
    const shown = JSON.stringify(v);
    refuses(`cdkd deploy x, and then ${shown}`);
    for (const open of [' ', '\t', '\n', "'", '"', '`', '(']) refuses(`x${open}cdkd deploy y ${shown}`);
    refuses(`${shown} x cdkd deploy`);
    for (const close of [' ', '\t', '\n', "'", '"', '=', '`', '.', ',', ';', ':', ')']) {
      refuses(`${shown} x --force${close}z`);
    }
    // `aws` needs a service AND an operation, each of `[a-z0-9-]`: a hyphen in
    // either, and a digit in the operation, still make an invocation, while
    // `aws` and one word in prose do not.
    refuses(`${shown} x aws logs describe-log-groups`);
    refuses(`${shown} x aws service-quotas list-x`);
    refuses(`${shown} x aws s3api list-objects-v2`);
    expectNoCommandBesideDisplay(`${shown} lives in the aws account.`, v);
    // Words split by more than one space, or by a tab, are still one invocation.
    refuses(`${shown} x cdkd  deploy`);
    refuses(`${shown} x cdkd\tdeploy`);
    refuses(`${shown} x aws\ts3  ls`);
    // A `--flag` may carry a hyphen after its first letter (`--stack-region`).
    refuses(`${shown} x --stack-region z`);
    // A block is a LINE (go-to-k/cdkd#4127 M10): the value on one line and a
    // command on the next pass, and the same two joined on one line refuse.
    expectNoCommandBesideDisplay(
      `No stack ${shown} was found.\nRun 'cdkd state list' to see available stacks.`,
      v
    );
    refuses(`No stack ${shown} was found. Run 'cdkd state list' to see available stacks.`);
    // A value carrying a newline is displayed across lines: a line holding a
    // piece of it and a command refuses (go-to-k/cdkd#4127 M12).
    const multi = 'x\n$(touch OWNED)';
    expect(() =>
      expectNoCommandBesideDisplay(`Stack ${multi} not found; run cdkd deploy`, multi)
    ).toThrow(/also carries a pasteable command/);
    // A display no line holds whole (cut, sanitized), with the payload's
    // sentinel still there, refuses rather than pass (M12).
    const long = 'x$(touch OWNED) and more';
    expect(() =>
      expectNoCommandBesideDisplay('Stack x$(touch OWNED) [cut] not found', long)
    ).toThrow(/a form the rule cannot see/);
    // Every top-level command starts an invocation (one per command, so a
    // dropped alternative is seen), and the list IS `buildProgram()`'s.
    for (const command of CDKD_TOP_LEVEL_COMMANDS) refuses(`${JSON.stringify(v)} -- cdkd ${command} x`);
    expect([...CDKD_TOP_LEVEL_COMMANDS].sort()).toEqual(
      buildProgram()
        .commands.map((c) => c.name())
        .sort()
    );
  });

  it('the per-block helper refuses a span that runs a stubbed verb and a boundary-less display, and the S1 zsh reason holds both ways', () => {
    // `expectOnlyDisplayResidual` is what the site fences lean on for a
    // displayed value whose span genuinely runs (gc's withheld value, and
    // since go-to-k/cdkd#3950 every site zsh runs past a ` (` on), so each
    // of its refusals is driven here by a span
    // that RUNS: dropping either check leaves the site fences green over the
    // exact shape it exists to refuse (the pre-fold gc sentence; the SSM
    // refusal's former bare `displaySafe`), which is a mutant the maintainer
    // would run.
    withPasteDir((dir) => {
      // A span that RUNS a stubbed verb while its display runs too: the
      // verb's marker, not a verb token in the text, is what refuses it
      // (go-to-k/cdkd#3950, the maintainer's H1). The function stub and the
      // PATH stub (`command` skips the function) are each driven.
      const hostile = 'x$(touch OWNED)';
      for (const ran of [
        `cdkd state show "${hostile}"`,
        `command cdkd state show "${hostile}"`,
        `aws s3 ls "${hostile}"`,
      ]) {
        expect(() => expectOnlyDisplayResidual(ran, dir, hostile, RUNTIME_ONLY), ran).toThrow(
          /also ran a stubbed cdkd \/ aws/
        );
      }
      // A verb only ZSH runs (go-to-k/cdkd#4127 review M4): the trailing
      // `x(N)` is a bash syntax error, so bash runs nothing, while zsh reads a
      // glob qualifier and runs both the substitution and the verb. The
      // marker must be the UNION over the shells, not bash's alone.
      if (PASTE_SHELLS.includes('zsh')) {
        // `expectZshRunsTheDisplay`, the S1 rows' zsh reason, in both
        // directions: it accepts the ` (` shape zsh runs past, refuses a
        // substitution family zsh did NOT run (the reason gone), and refuses
        // an inert family that DID run (another reason).
        expectZshRunsTheDisplay(`Nothing for "${hostile}" (us-east-1).`, dir, hostile);
        expect(() =>
          expectZshRunsTheDisplay(`Nothing for '${hostile}' (us-east-1).`, dir, hostile)
        ).toThrow(/zsh ran nothing/);
        const separator = 'x; touch OWNED; #';
        expect(() => expectZshRunsTheDisplay(`Nothing for ${separator}`, dir, separator)).toThrow(
          /zsh ran an inert family/
        );
        // A run the display did not cause: an unrelated substitution in a
        // sentence of its own, a span that does not hold the value.
        expect(() =>
          expectZshRunsTheDisplay(
            `Nothing for "${hostile}" (us-east-1). Then $(touch OTHER) (x).`,
            dir,
            hostile
          )
        ).toThrow(/without the displayed value/);
        // Each arm of the "span holds the value" check on its own, with a value
        // JSON escaping changes (go-to-k/cdkd#4127 round-3 optional): shown
        // only JSON-escaped, and shown only raw.
        const quoted = 'x"$(touch OWNED)';
        expectZshRunsTheDisplay(`Nothing for ${JSON.stringify(quoted)} (us-east-1).`, dir, quoted);
        expectZshRunsTheDisplay(`Nothing for ${quoted}" here (us-east-1).`, dir, quoted);
        // A run that also invokes a stubbed verb (the M4 shape: `x(N)` lets zsh
        // go on to run the verb after the substitution).
        expect(() =>
          expectZshRunsTheDisplay(`cdkd deploy "${hostile}" x(N)`, dir, hostile)
        ).toThrow(/also ran a stubbed cdkd/);
        const zshOnlyVerb = `cdkd deploy "${hostile}" x(N)`;
        expect(filesTouchedBy(zshOnlyVerb, dir, { shells: ['bash'] })).toEqual([]);
        expect(() => expectOnlyDisplayResidual(zshOnlyVerb, dir, hostile, RUNTIME_ONLY)).toThrow(
          /also ran a stubbed cdkd \/ aws/
        );
      }
      // A verb that is only an ARGUMENT does not count, which was the token
      // rule's false positive: `Could` runs, with `cdkd` as its argument.
      const argument = `Could not lock "${hostile}" -- see cdkd force-unlock`;
      expect(expectOnlyDisplayResidual(argument, dir, hostile, RUNTIME_ONLY).length).toBeGreaterThan(0);
      // The pre-fold shape — a command inside prose quotes after an
      // apostrophe — is still refused, by the boundary check: the value runs
      // inside cdkd's single quotes, not a JSON pair. A `--flag` remedy beside
      // a JSON-bounded display invokes no verb, so it is the block-level rule
      // of the maintainer's S1 rows (a block displaying an untrusted value
      // carries no pasteable command), not this helper's.
      const commandRan =
        `This file's key is unreadable — run 'cdkd state show ${hostile}' if it's yours.`;
      expect(() => expectOnlyDisplayResidual(commandRan, dir, hostile, RUNTIME_ONLY)).toThrow(/JSON boundary/);
      // A bare display: the value is not inside a JSON boundary...
      const separator = 'x; touch OWNED; #';
      const bareRan = `Cannot adopt SSM parameter ${separator} from an ARN.`;
      expect(() => expectOnlyDisplayResidual(bareRan, dir, separator, RUNTIME_ONLY)).toThrow(/JSON boundary/);
      // ...and a boundary around something ELSE in the span does not count:
      // the check binds the quotes to the value.
      const elsewhere = `Cannot adopt SSM parameter ${separator} from "an ARN".`;
      expect(() => expectOnlyDisplayResidual(elsewhere, dir, separator, RUNTIME_ONLY)).toThrow(/JSON boundary/);
      // ...nor two unrelated quoted words on EITHER side of a bare value,
      // which a flanking-pair regex accepts: the span runs, and the value is
      // outside every paired `"..."`.
      const flanked = `Key "a" holds ${hostile} at "b"`;
      expect(() => expectOnlyDisplayResidual(flanked, dir, hostile, RUNTIME_ONLY)).toThrow(/JSON boundary/);
      // And the decoy sweep: a span that DELETES a decoy counts as having run
      // and the decoy is re-seeded, so the next span still has it (a first cut
      // walked surviving entries only and lost the decoy silently).
      expect(filesTouchedBy('rm region', dir)).toEqual(['region']);
      // The deleted decoy is the next span's INPUT: `<region` fails and touches
      // nothing unless it was re-seeded (a `>` target would have re-created
      // it and hidden a missing re-seed).
      expect(filesTouchedBy('cdkd state show <region> stack', dir)).toEqual(['stack']);
      // ...and re-seeded WITH its content: a truncation onto it must still
      // read as a change (an empty re-seed would hide every later truncation).
      expect(filesTouchedBy('cdkd state show <stack> region', dir)).toEqual(['region']);
      // The child runs with a MINIMAL env, not this process's: an ambient
      // `BASH_ENV` naming a file that creates the sentinel is not inherited
      // (`{ ...process.env, HOME: dir }` would run it).
      const hook = join(dir, 'envhook.sh');
      writeFileSync(hook, 'touch OWNED\n', 'utf8');
      const priorBashEnv = process.env['BASH_ENV'];
      process.env['BASH_ENV'] = hook;
      try {
        expect(filesTouchedBy('true', dir)).toEqual([]);
      } finally {
        if (priorBashEnv === undefined) delete process.env['BASH_ENV'];
        else process.env['BASH_ENV'] = priorBashEnv;
        rmSync(hook, { force: true });
      }
      // A value the clause split cut in half: the running clause holds no
      // boundary and no whole value, so the absence check alone passed it.
      const split = 'x$(touch OWNED): y';
      expect(() => expectOnlyDisplayResidual(`Found record(s): Key ${split}`, dir, split, RUNTIME_ONLY)).toThrow(
        /JSON boundary/
      );
      // And a value inside a paired span AND bare beside it: the positive
      // check alone accepts it, the absence check is what refuses it.
      const twice = `Key "${hostile}" also ${hostile}`;
      expect(() => expectOnlyDisplayResidual(twice, dir, hostile, RUNTIME_ONLY)).toThrow(/outside a JSON boundary/);
      // ...and a second copy inside a quoted run that is NOT valid JSON is
      // bare too: only a decodable span is a boundary.
      const invalidBeside = `Key "${hostile}" also "\\q ${hostile}"`;
      expect(() => expectOnlyDisplayResidual(invalidBeside, dir, hostile, RUNTIME_ONLY)).toThrow(
        /outside a JSON boundary/
      );
      // A value carrying a quote or a backslash renders JSON-ESCAPED inside
      // its boundary; the check decodes the span before comparing, so a
      // correctly bounded render is accepted (both spans run: double quotes
      // do not stop `$( )`).
      for (const escaped of ['x"$(touch OWNED)', 'x\\$(touch OWNED)']) {
        const bounded = `State file ${JSON.stringify(`cdkd/${escaped}/state.json`)} is not valid JSON.`;
        expect(expectOnlyDisplayResidual(bounded, dir, escaped, RUNTIME_ONLY), escaped).toEqual([bounded]);
      }
      // The child's HOME is the scratch directory, so a `~`-expanding span
      // lands where the sweep sees it rather than in the real home.
      expect(filesTouchedBy('echo hi > ~/OWNED', dir)).toEqual(['OWNED']);
      // And a span that BLOCKS is bounded: it fails the case rather than
      // hanging the file. The child's duration and the bound are BOTH derived
      // from the harness timeout, and the premise between them is asserted:
      // killed, the call returns near PASTE_CHILD_TIMEOUT_MS and inside the
      // bound; merely asked (a TERM-ignoring child under the default signal
      // runs to completion), it returns only when the child exits, past the
      // bound. A fixed 12 s child would let a larger timeout make the bound
      // vacuous.
      const bound = PASTE_CHILD_TIMEOUT_MS + 4_500;
      const childSeconds = Math.ceil(bound / 1_000) + 3;
      expect(childSeconds * 1_000).toBeGreaterThan(bound);
      expect(() => filesTouchedBy(`sleep ${childSeconds}`, dir)).toThrow(/hung/);
      const started = Date.now();
      expect(() => filesTouchedBy(`trap '' TERM; sleep ${childSeconds}`, dir)).toThrow(/hung/);
      expect(Date.now() - started).toBeLessThan(bound);
      // And the residual the criterion ACCEPTS and returns: the value inside
      // `displayIdent`'s boundary, no command in the span. Double quotes do
      // not stop `$( )`, which is the whole reason the criterion is per block.
      const accepted = `State file "cdkd/${hostile}/state.json" is not valid JSON.`;
      expect(expectOnlyDisplayResidual(accepted, dir, hostile, RUNTIME_ONLY)).toEqual([accepted]);
    });
  }, 120_000);

  it('the harness refuses a span outside its isolation, and a child that died by a signal', () => {
    // Outside `withPasteDir` there is no stub directory on PATH: a span would
    // run against the real `aws` with the real environment, so the runner
    // refuses rather than degrading to that.
    expect(() => filesTouchedBy('true', tmpdir())).toThrow(/only inside withPasteDir/);
    withPasteDir((dir) => {
      // A child killed by a signal it sent itself sets no `error` on the
      // result (that field is the timeout's), so the signal is asserted on
      // its own: a span that died that way ran something.
      expect(() => filesTouchedBy('kill -KILL $$', dir)).toThrow(/killed/);
    });
  }, 120_000);

  it('expectOnlyDisplayResidual runs the per-line block rule by default, and an opt-out must name its row', () => {
    // go-to-k/cdkd#4127 M11: an unclassified row reds here instead of passing
    // on the runtime half alone, and only a named S1 row skips it.
    const v = 'x$(touch OWNED)';
    const joined = `No stack ${JSON.stringify(v)} was found. Run 'cdkd state list'.`;
    const split = `No stack ${JSON.stringify(v)} was found.\nRun 'cdkd state list'.`;
    withPasteDir((dir) => {
      expect(() => expectOnlyDisplayResidual(joined, dir, v)).toThrow(/also carries a pasteable command/);
      expect(expectOnlyDisplayResidual(split, dir, v).length).toBeGreaterThan(0);
      expect(
        expectOnlyDisplayResidual(joined, dir, v, { unfixedS1Row: 'go-to-k/cdkd#3950 self-test row' }).length
      ).toBeGreaterThan(0);
      expect(() => expectOnlyDisplayResidual(joined, dir, v, { unfixedS1Row: 'some row' })).toThrow(
        /names its go-to-k\/cdkd#3950 row/
      );
      // The reference is anchored (`#39500` is another issue), and an opt-out
      // on a row that no longer violates the rule refuses (M13).
      expect(() =>
        expectOnlyDisplayResidual(joined, dir, v, { unfixedS1Row: 'go-to-k/cdkd#39500 row' })
      ).toThrow(/names its go-to-k\/cdkd#3950 row/);
      expect(() =>
        expectOnlyDisplayResidual(split, dir, v, { unfixedS1Row: 'go-to-k/cdkd#3950 fixed row' })
      ).toThrow(/no longer violates the block rule/);
    });
  }, 120_000);

  it('a nested withPasteDir leaves the outer call isolated, even when the inner one throws', () => {
    withPasteDir((outer) => {
      expect(() =>
        withPasteDir(() => {
          throw new Error('inner failure');
        })
      ).toThrow('inner failure');
      withPasteDir((inner) => {
        expect(filesTouchedBy('true', inner)).toEqual([]);
      });
      // Still inside the outer isolation: the runner does not refuse, and the
      // stub is still first on PATH for the outer directory.
      expect(filesTouchedBy('true', outer)).toEqual([]);
      expect(
        filesTouchedBy('[ "$(type -P cdkd)" -ef "$HOME/../bin/cdkd" ] && touch OWNED', outer)
      ).toEqual(['OWNED']);
    });
  }, 120_000);

  it('records what displayIdent costs in a pasted span — it is a DISPLAY boundary, not a shell one', () => {
    // `displayIdent` JSON-quotes, and JSON quotes stop neither COMMAND
    // SUBSTITUTION nor the parity flip. Inside a command that is a defect I
    // shipped into go-to-k/cdkd#3613 before review probed it; in prose it is
    // the maintainer's go-to-k/cdkd#3486 round-3 finding (16 executing spans
    // in a revert-plan block), and the reason his criterion is per BLOCK: a
    // block that carries untrusted values carries no pasteable command, and
    // what such a block DISPLAYS is go-to-k/cdkd#3232's class, not this
    // fence's. Measured here rather than asserted, so the line between the two
    // renderers cannot drift back into a comment.
    withPasteDir((dir) => {
      const hostile = 'x$(touch OWNED)';

      // INSIDE a command: live through displayIdent, inert through the gate —
      // and the difference is the QUOTE KIND, not withholding. This value
      // renders exactly (printable ASCII, no leading `-`, no pattern
      // character), so the gate NAMES it, shell-quoted; `shellQuote` is what
      // makes `$( )` inert in argv.
      const viaDisplay =
        `Repair with: cdkd import ${commandHole('stack')} --resource ` +
        `${displayIdent(hostile, { maxCodePoints: 255 })}=${commandHole('physicalId')} --force`;
      expect(filesTouchedBy(viaDisplay, dir), 'displayIdent inside a COMMAND is live').toContain(
        'OWNED'
      );
      const viaGate =
        `Repair with: ${
          pasteableCommand('cdkd import', [
            { hole: 'stack' },
            { flag: '--resource', value: hostile, hole: 'logicalId' },
          ]).command
        }=${commandHole('physicalId')} --force`;
      expect(filesTouchedBy(viaGate, dir), 'the gated form must be inert').toEqual([]);
      expect(viaGate).toContain(`--resource 'x$(touch OWNED)'`);
      expect(viaDisplay).toContain(`--resource "x$(touch OWNED)"`);

      // In PROSE, both ways a sentence can run. With no apostrophe the word
      // is expanded before `The` is even looked up, so the substitution runs;
      // with one, the embedded-quote payload closes the span `record's`
      // opened and the rest is bare shell. An earlier revision of this file
      // put the second sentence in the survive set above and called the JSON
      // boundary the reason it held — it held only for payloads without a `'`.
      expect(
        filesTouchedBy(`The record name is ${displayIdent(hostile)} and it is unreadable.`, dir)
      ).toContain('OWNED');
      expect(
        filesTouchedBy(
          `The record's name is ${displayIdent("x'$(touch OWNED) #")} and it could not be read.`,
          dir
        )
      ).toContain('OWNED');
    });
  }, 120_000);

  it('records what shape C costs, so the prose rule is not folklore', () => {
    // The measurement the issue rests on, re-run here rather than cited: a
    // shell-quoted value is INERT in a sentence with no apostrophe, and LIVE
    // in the same sentence once one appears before it. That is the whole of
    // shape C, and it is why a `shellQuote`d value does not belong in prose at
    // all — the fix is the trailing labelled line, not more quoting.
    withPasteDir((dir) => {
      const value = shellQuote('x$(touch OWNED)');
      const noApostrophe = filesTouchedBy(`The record name is ${value} and it is unreadable.`, dir);
      expect(noApostrophe, 'quoting alone holds when the parity is even').toEqual([]);

      // TWO apostrophes, not one. With a single opener the line is
      // syntactically incomplete and bash refuses it before running anything —
      // which reads as safety and is not: any sentence that closes the span
      // later, as ordinary English constantly does, executes.
      const withApostrophe = filesTouchedBy(
        `The record's name is ${value} and it isn't readable.`,
        dir
      );
      expect(
        withApostrophe,
        'shape C did not reproduce — the parity flip is what this rule is about'
      ).toContain('OWNED');
    });
  }, 120_000);
});
