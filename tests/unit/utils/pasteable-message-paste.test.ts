/**
 * The PASTE fence: the message SHAPES this lane introduced, plus the pure
 * message builders it touched, fed to a real bash at three granularities with
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
import {
  PASTE_CHILD_TIMEOUT_MS,
  PASTE_PAYLOADS,
  expectOnlyDisplayResidual,
  filesTouchedBy,
  spansThatRun,
  withPasteDir,
} from './paste-harness.js';

describe('pasteable messages — nothing runs at any granularity', () => {
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
    withPasteDir((dir) => {
      const value = shellQuote('x$(touch OWNED)');
      const sentence = `The record's name is ${value} and it isn't readable.`;
      // The LINE split first: a message whose first line is inert (`record(s)`
      // aborts it) and whose second line runs only extracts that second line
      // when lines are split — pasted whole, the syntax error on line one
      // stops bash before line two.
      const secondLine = 'echo $(touch OWNED)';
      const twoLines = `Found 2 resource record(s)\n${secondLine}`;
      expect(filesTouchedBy(twoLines, dir), 'the whole message must be inert').toEqual([]);
      expect(spansThatRun(twoLines, dir)).toEqual([secondLine]);
      // Once per sentence terminator the splitter knows (`.`, `!`, `?`): a
      // control over `.` alone leaves `[.!?]` -> `[.]` green.
      for (const terminator of ['.', '!', '?']) {
        const line = `Found 2 resource record(s) in this stack${terminator} ${sentence}`;
        expect(
          filesTouchedBy(line, dir),
          `${terminator}: the whole line must be inert for this to pin anything`
        ).toEqual([]);
        expect(spansThatRun(line, dir), terminator).toEqual([sentence]);
      }
      // And the LINE itself is a span: a line that runs only WHOLE, because
      // the sentence boundary sits inside a quoted run so every extracted
      // sentence and clause is an unclosed quote (dropping `out.add(line)`
      // leaves every other control green, their lines being inert by design).
      const wholeLine = `echo 'prefix. '$(touch OWNED)' suffix'`;
      expect(spansThatRun(wholeLine, dir)).toEqual([wholeLine]);
      // And a SENTENCE that runs only whole: its line is inert (`record(s)`),
      // and its clause split at `: ` falls inside the quoted run, so each
      // clause is an unclosed quote. The sentence controls above carry no
      // clause separator, so the clause loop re-adds the identical span and
      // dropping `out.add(sentence)` is invisible to them.
      const sentenceOnly = `echo 'prefix: '$(touch OWNED)' suffix'`;
      expect(spansThatRun(`Found record(s). ${sentenceOnly}`, dir)).toEqual([sentenceOnly]);
      // And the CLAUSE split, once per separator the splitter knows (`: `,
      // ` — `, ` -- `), where the sentence is the whole line (no `. `) and the
      // payload sits after the separator: deleting any one alternative leaves
      // its line's only running clause unextracted, and the "nothing ran"
      // assertions above would accept that silently.
      const clause = `the record's name is ${value} and it isn't readable.`;
      for (const separator of [': ', ' — ', ' -- ']) {
        const joined = `Found 2 resource record(s)${separator}${clause}`;
        expect(filesTouchedBy(joined, dir), JSON.stringify(separator)).toEqual([]);
        expect(spansThatRun(joined, dir), JSON.stringify(separator)).toEqual([clause]);
      }
    });
  }, 120_000);

  it('the per-block helper refuses a running COMMAND span and a boundary-less display', () => {
    // `expectOnlyDisplayResidual` is what the gc site fence leans on for a
    // withheld value (the other sites are inert today and assert that), so
    // each of its refusals is driven here by a span
    // that RUNS: dropping either check leaves the site fences green over the
    // exact shape it exists to refuse (the pre-fold gc sentence; the SSM
    // refusal's former bare `displaySafe`), which is a mutant the maintainer
    // would run.
    withPasteDir((dir) => {
      // The pre-fold shape: a command inside prose quotes after an apostrophe,
      // with the parity kept EVEN so the line parses and the flip is live.
      const hostile = 'x$(touch OWNED)';
      const commandRan =
        `This file's key is unreadable — run 'cdkd state show ${hostile}' if it's yours.`;
      expect(() => expectOnlyDisplayResidual(commandRan, dir, hostile)).toThrow(/command fragment/);
      // A FLAG remedy is a command fragment too: the SSM `--resource` one has
      // no verb in front of it, and a verb-only check admits it.
      const flagRan = `--resource "${hostile}"='<parameterName>'`;
      expect(() => expectOnlyDisplayResidual(flagRan, dir, hostile)).toThrow(/command fragment/);
      // And an `aws` verb with NO flag behind it, so the `--flag` arm cannot
      // stand in for the verb arm (dropping `aws|` leaves every other control
      // green).
      const awsRan = `Read it with: aws s3 ls "${hostile}"`;
      expect(() => expectOnlyDisplayResidual(awsRan, dir, hostile)).toThrow(/command fragment/);
      // And a verb or flag ENDING the span, with nothing after it: the
      // boundary after a fragment is whitespace or the end of the span.
      for (const trailing of [`Read "${hostile}" with cdkd`, `Read "${hostile}" with --force`]) {
        expect(() => expectOnlyDisplayResidual(trailing, dir, hostile), trailing).toThrow(
          /command fragment/
        );
      }
      // A bare display: the value is not inside a JSON boundary...
      const separator = 'x; touch OWNED; #';
      const bareRan = `Cannot adopt SSM parameter ${separator} from an ARN.`;
      expect(() => expectOnlyDisplayResidual(bareRan, dir, separator)).toThrow(/JSON boundary/);
      // ...and a boundary around something ELSE in the span does not count:
      // the check binds the quotes to the value.
      const elsewhere = `Cannot adopt SSM parameter ${separator} from "an ARN".`;
      expect(() => expectOnlyDisplayResidual(elsewhere, dir, separator)).toThrow(/JSON boundary/);
      // ...nor two unrelated quoted words on EITHER side of a bare value,
      // which a flanking-pair regex accepts: the span runs, and the value is
      // outside every paired `"..."`.
      const flanked = `Key "a" holds ${hostile} at "b"`;
      expect(() => expectOnlyDisplayResidual(flanked, dir, hostile)).toThrow(/JSON boundary/);
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
      expect(() => expectOnlyDisplayResidual(`Found record(s): Key ${split}`, dir, split)).toThrow(
        /JSON boundary/
      );
      // And a value inside a paired span AND bare beside it: the positive
      // check alone accepts it, the absence check is what refuses it.
      const twice = `Key "${hostile}" also ${hostile}`;
      expect(() => expectOnlyDisplayResidual(twice, dir, hostile)).toThrow(/outside a JSON boundary/);
      // ...and a second copy inside a quoted run that is NOT valid JSON is
      // bare too: only a decodable span is a boundary.
      const invalidBeside = `Key "${hostile}" also "\\q ${hostile}"`;
      expect(() => expectOnlyDisplayResidual(invalidBeside, dir, hostile)).toThrow(
        /outside a JSON boundary/
      );
      // A value carrying a quote or a backslash renders JSON-ESCAPED inside
      // its boundary; the check decodes the span before comparing, so a
      // correctly bounded render is accepted (both spans run: double quotes
      // do not stop `$( )`).
      for (const escaped of ['x"$(touch OWNED)', 'x\\$(touch OWNED)']) {
        const bounded = `State file ${JSON.stringify(`cdkd/${escaped}/state.json`)} is not valid JSON.`;
        expect(expectOnlyDisplayResidual(bounded, dir, escaped), escaped).toEqual([bounded]);
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
      expect(expectOnlyDisplayResidual(accepted, dir, hostile)).toEqual([accepted]);
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
  });

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
  });

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
