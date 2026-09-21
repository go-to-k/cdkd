/**
 * The shared pasteable-command builder (go-to-k/cdkd#3436).
 *
 * Two halves, and the second is what makes the first mean anything: a hazard
 * matrix over `pasteableCommand`'s gates, and a case that pastes what it built
 * into a REAL bash under a stub `cdkd`, asserting the argv the command
 * produces and that nothing in the directory changed. A builder asserted only
 * against expected STRINGS can be correct about its own spelling and still
 * emit something the shell re-splits.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vite-plus/test';
import { STACK_REF_MAX_CODE_POINTS } from '../../../src/utils/display-safe.js';
import {
  commandHole,
  pasteableCommand,
  rendersExactly,
  shellQuote,
} from '../../../src/utils/pasteable-command.js';
import type { PasteableCommand } from '../../../src/utils/pasteable-command.js';


describe('pasteableCommand — the shared gate (go-to-k/cdkd#3436)', () => {
  it('names a value that renders exactly, shell-quoted as ONE argument', () => {
    // The control: without it every withholding case below is satisfied by a
    // builder that emits a hole unconditionally. A printable `;` or quote is
    // NOT a hazard — quoting is what makes it safe — so both must be NAMED.
    expect(pasteableCommand('cdkd deploy', [{ value: 'My-App-Stack', hole: 'stack' }])).toEqual({
      command: 'cdkd deploy My-App-Stack',
      exact: true,
    });
    expect(pasteableCommand('cdkd deploy', [{ value: 'a; printf X; #', hole: 'stack' }])).toEqual({
      command: "cdkd deploy 'a; printf X; #'",
      exact: true,
    });
    expect(
      pasteableCommand('cdkd drift', [
        { value: "it's", hole: 'stack' },
        { literal: '--revert' },
        { flag: '--stack-region', value: 'us-east-1', hole: 'region' },
      ])
    ).toEqual({
      command: "cdkd drift 'it'\\''s' --revert --stack-region us-east-1",
      exact: true,
    });
    // A legitimate multi-level nested child is long, and the cap must not cut
    // it. AT the cap, not merely past 128: with only a short name here, a
    // smaller cap passes every case, since the refusal below needs cap + 1.
    const nested = `Root~${'N'.repeat(80)}~${'C'.repeat(80)}`;
    expect(pasteableCommand('cdkd deploy', [{ value: nested, hole: 'stack' }]).command).toBe(
      `cdkd deploy '${nested}'`
    );
    const atCap = 'q'.repeat(STACK_REF_MAX_CODE_POINTS);
    expect(pasteableCommand('cdkd deploy', [{ value: atCap, hole: 'stack' }])).toEqual({
      command: `cdkd deploy ${atCap}`,
      exact: true,
    });
  });

  it('holds an EMPTY name and one past the cap — the two arms the hand-rolled gates lacked', () => {
    // The nit on go-to-k/cdkd#3499's round 2: `main`'s copy of this gate
    // printed `cdkd deploy ''` for an empty name and had no cap at all, so
    // nothing in the suite distinguished this builder from the one it replaced
    // on those two inputs.
    expect(pasteableCommand('cdkd deploy', [{ value: '', hole: 'stack' }])).toEqual({
      command: "cdkd deploy '<stack>'",
      exact: false,
    });
    const pastCap = 'q'.repeat(STACK_REF_MAX_CODE_POINTS + 1);
    expect(pasteableCommand('cdkd deploy', [{ value: pastCap, hole: 'stack' }])).toEqual({
      command: "cdkd deploy '<stack>'",
      exact: false,
    });
  });

  it('prints a HOLE, never the altered spelling and never nothing, for a value sanitizing changes', () => {
    // One name per forgery class `displaySafe({ asciiOnly: true })` drops, plus
    // the two shapes that are not characters at all: empty, and past the cap.
    for (const hostile of [
      'a\nb',
      'a\u0085b',
      'a\u009bb',
      'a\u2028b',
      'a\u202eb',
      'a\u00a0b',
      'a\u001bb',
      ' padded',
      'padded ',
      '',
      'q'.repeat(STACK_REF_MAX_CODE_POINTS + 1),
    ]) {
      const built = pasteableCommand('cdkd deploy', [{ value: hostile, hole: 'stack' }]);
      expect(built, JSON.stringify(hostile)).toEqual({
        command: "cdkd deploy '<stack>'",
        exact: false,
      });
    }
  });

  it('keeps a flag bound to its value, so the flag can never outlive it', () => {
    // Dropping the VALUE and keeping `--stack-region` would make the command
    // address every region holding the name; dropping the FLAG would silently
    // widen it the same way. The pair goes or stays together.
    expect(
      pasteableCommand('cdkd state orphan', [
        { value: 'S', hole: 'stack' },
        { flag: '--stack-region', value: 'us-east-1\u001b', hole: 'region' },
      ])
    ).toEqual({ command: "cdkd state orphan S --stack-region '<region>'", exact: false });
  });

  it('holds a value the COMMAND itself would read as an option or a pattern', () => {
    // A leading `-` is an option to every cdkd command: a state key named
    // `--all` survives sanitizing, the cap AND quoting, then addresses every
    // stack.
    for (const optionShaped of ['--all', '-x']) {
      expect(
        pasteableCommand('cdkd deploy', [{ value: optionShaped, hole: 'stack' }]),
        optionShaped
      ).toEqual({ command: "cdkd deploy '<stack>'", exact: false });
    }
    // `*` and `/` are `stack-matcher.ts` patterns, so they are held only where
    // the command matches patterns.
    for (const patterned of ['Prod*', 'Stage/Prod']) {
      expect(
        pasteableCommand('cdkd deploy', [
          { value: patterned, hole: 'stack', opts: { patternMatched: true } },
        ]).exact,
        patterned
      ).toBe(false);
    }
    // The same two names are fine for a command that matches EXACTLY — both,
    // or a mutant refusing `/` whatever `patternMatched` says survives.
    expect(pasteableCommand('cdkd state refresh-observed', [{ value: 'Prod*', hole: 'stack' }])).toEqual(
      { command: "cdkd state refresh-observed 'Prod*'", exact: true }
    );
    expect(
      pasteableCommand('cdkd state refresh-observed', [{ value: 'Stage/Prod', hole: 'stack' }])
    ).toEqual({ command: 'cdkd state refresh-observed Stage/Prod', exact: true });
  });

  it('quotes a hole the caller asks for, and appends extra flags LAST', () => {
    expect(
      pasteableCommand(
        'cdkd state orphan',
        [{ hole: 'stack' }, { flag: '--stack-region', value: 'us-east-1', hole: 'region' }],
        ['--profile prod', "--state-bucket 'b b'"]
      )
    ).toEqual({
      command: "cdkd state orphan '<stack>' --stack-region us-east-1 --profile prod --state-bucket 'b b'",
      exact: false,
    });
  });

  it('quotes a flag\'s placeholder too, where a bare one would redirect', () => {
    // `--asset-bucket <name>` pasted reads stdin from a file `name`; with any
    // word after it, `>` truncates that word instead.
    expect(
      pasteableCommand('cdkd bootstrap', [
        { flag: '--region', value: 'us-east-1', hole: 'region' },
        { flag: '--asset-bucket', hole: 'name' },
      ])
    ).toEqual({
      command: "cdkd bootstrap --region us-east-1 --asset-bucket '<name>'",
      exact: false,
    });
  });

  it("passes patternMatched wherever the COMMAND matches patterns — the destroy hints' wiring", async () => {
    // A helper test cannot see what a SITE passes, and both `cdkd destroy`
    // hints in `error-handler.ts` resolve their argument through
    // `stack-matcher.ts`: a record named `Prod*` would select every stack it
    // matches, which quoting does not prevent (go-to-k/cdkd#3436 delta round 1).
    const { StackTerminationProtectionError, NestedStackChildDirectDestroyError } = await import(
      '../../../src/utils/error-handler.js'
    );
    const retry = new StackTerminationProtectionError('Prod*').message;
    expect(retry).toMatch(/^Retry with: cdkd destroy '<stack>'$/m);
    expect(retry).not.toContain("cdkd destroy 'Prod*'");

    const nested = new NestedStackChildDirectDestroyError('Child', 'Prod*').message;
    expect(nested).toMatch(/^Cascade-delete with: cdkd destroy '<parent>'$/m);
    // The CHILD argument goes to `cdkd state destroy`, which resolves by exact
    // membership — so a pattern-shaped child name is still NAMED. Without these
    // two, restoring `patternMatched` on that call survives every assertion
    // above while withholding the only command that works (proxy round 2).
    // The expected spelling is written out per name rather than derived through
    // `shellQuote`: `/` is in its safe charset and `*` is not, so a derived
    // expectation would agree with the code under test by construction.
    for (const [child, expected] of [
      ['Prod*', "cdkd state destroy 'Prod*'"],
      ['Stage/Prod', 'cdkd state destroy Stage/Prod'],
    ] as const) {
      const message = new NestedStackChildDirectDestroyError(child, 'Parent').message;
      expect(message, child).toContain(`Destroy the child alone with: ${expected}`);
    }
    // The CONTROLS, one per hint: an ordinary name is still NAMED, so neither
    // case above is satisfied by a hint that withholds everything. The nested
    // one needs its own — the termination-protection control does not cover it,
    // and an unconditional hole there passed every other assertion here
    // (measured, proxy round 14).
    const ordinary = new StackTerminationProtectionError('ProdStack').message;
    expect(ordinary).toMatch(/^Retry with: cdkd destroy ProdStack$/m);
    const ordinaryNested = new NestedStackChildDirectDestroyError('Child', 'ProdStack').message;
    expect(ordinaryNested).toMatch(/^Cascade-delete with: cdkd destroy ProdStack$/m);
    expect(ordinaryNested).toMatch(/^Destroy the child alone with: cdkd state destroy Child$/m);
  });

  it('rendersExactly compares against the RAW value, so it cannot pass vacuously', () => {
    expect(rendersExactly('plain')).toBe(true);
    expect(rendersExactly('a\u001bb')).toBe(false);
    expect(rendersExactly('')).toBe(false);
    // The pair the gate is built from, asserted directly: a second sanitizing
    // pass would compare two sanitized spellings and be satisfied by anything.
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(commandHole('stack')).toBe("'<stack>'");
  });

  it('pastes into a real bash as literal arguments — no redirection, no file created', () => {
    // Each case carries the argv the shell MUST produce, derived from the input
    // values rather than from re-parsing the output line: comparing the line
    // against its own re-parse agrees by construction for a builder that
    // dropped quoting on a value with no metacharacter, so it would catch
    // quote-removal but not re-splitting — which is the property this case
    // claims (m9 of the go-to-k/cdkd#3499 review).
    const cases: Array<{ built: PasteableCommand; argv: string[] }> = [
      {
        built: pasteableCommand('cdkd deploy', [{ value: 'a; touch OWNED; #', hole: 'stack' }]),
        argv: ['deploy', 'a; touch OWNED; #'],
      },
      {
        built: pasteableCommand('cdkd deploy', [{ value: '$(touch OWNED)', hole: 'stack' }]),
        argv: ['deploy', '$(touch OWNED)'],
      },
      {
        built: pasteableCommand('cdkd deploy', [{ value: '`touch OWNED`', hole: 'stack' }]),
        argv: ['deploy', '`touch OWNED`'],
      },
      {
        built: pasteableCommand('cdkd deploy', [{ value: "x'; touch OWNED; #", hole: 'stack' }]),
        argv: ['deploy', "x'; touch OWNED; #"],
      },
      {
        // A value with a SPACE and no metacharacter: this is the one that
        // catches re-splitting, and the one a re-parse of the output could
        // never catch.
        built: pasteableCommand('cdkd deploy', [{ value: 'two words', hole: 'stack' }]),
        argv: ['deploy', 'two words'],
      },
      {
        built: pasteableCommand(
          'cdkd state orphan',
          [{ hole: 'stack' }, { flag: '--stack-region', value: 'us-east-1\u001b', hole: 'region' }],
          ['--profile prod']
        ),
        argv: ['state', 'orphan', '<stack>', '--stack-region', '<region>', '--profile', 'prod'],
      },
    ];
    const built = cases.map((c) => c.built.command);
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-pasteable-'));
    // The POSITIVE control first: the same payload UNQUOTED does create the
    // sentinel here, so a bash that cannot start — or a directory check that
    // never sees anything — fails loudly rather than passing.
    const control = spawnSync('bash', ['-c', 'cdkd() { :; }; cdkd $(touch OWNED)'], {
      cwd: dir,
      encoding: 'utf8',
    });
    expect(control.error, 'bash did not start').toBeUndefined();
    expect(readdirSync(dir), 'the control payload did not run').toContain('OWNED');
    // REMOVED, not left in place: with the sentinel already present, a probe
    // that ran `touch OWNED` again would be invisible to a name-only compare.
    rmSync(join(dir, 'OWNED'));
    // Decoys named after every hole: a bare `<stack>` would READ one of these
    // and truncate the next word, which is the shape `commandHole` closes.
    for (const f of ['stack', 'region']) writeFileSync(join(dir, f), 'decoy\n');
    const before = readdirSync(dir).sort();
    // CONTENTS too: `> stack` truncates the decoy without changing the listing,
    // so a name-only compare cannot see a redirection that hit an existing file.
    const contentsBefore = before.map((f) => readFileSync(join(dir, f), 'utf8'));
    for (const { built: b, argv } of cases) {
      const line = b.command;
      const r = spawnSync('bash', ['-c', `cdkd() { printf '%s\\n' "$@"; }; ${line}`], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(r.error, line).toBeUndefined();
      expect(r.status, `${line}\n${r.stderr}`).toBe(0);
      // The argv the shell actually built, against what the CALLER passed.
      expect(r.stdout.split('\n').slice(0, -1), line).toEqual(argv);
      const after = readdirSync(dir).sort();
      expect(after, line).toEqual(before);
      expect(
        after.map((f) => readFileSync(join(dir, f), 'utf8')),
        line
      ).toEqual(contentsBefore);
    }
  });
});
