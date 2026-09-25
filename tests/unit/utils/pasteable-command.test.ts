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
import { commandHole, pasteableCommand, rendersExactly, shellQuote, withheldTargetClause } from '../../../src/utils/pasteable-command.js';
import type { PasteableCommand } from '../../../src/utils/pasteable-command.js';


/** What the gate must say about each hostile value the loop below drives. */
const expectedReason = (value: string): string =>
  value === ''
    ? 'empty'
    : value.length > STACK_REF_MAX_CODE_POINTS
      ? 'too-long'
      : 'altered';

describe('pasteableCommand — the shared gate (go-to-k/cdkd#3436)', () => {
  it('names a value that renders exactly, shell-quoted as ONE argument', () => {
    // The control: without it every withholding case below is satisfied by a
    // builder that emits a hole unconditionally. A printable `;` or quote is
    // NOT a hazard — quoting is what makes it safe — so both must be NAMED.
    expect(pasteableCommand('cdkd deploy', [{ value: 'My-App-Stack', hole: 'stack' }])).toEqual({
      command: 'cdkd deploy My-App-Stack',
      exact: true,
      withheld: [],
    });
    expect(pasteableCommand('cdkd deploy', [{ value: 'a; printf X; #', hole: 'stack' }])).toEqual({
      command: "cdkd deploy 'a; printf X; #'",
      exact: true,
      withheld: [],
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
      withheld: [],
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
      withheld: [],
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
      withheld: [{ hole: 'stack', reason: 'empty' }],
    });
    const pastCap = 'q'.repeat(STACK_REF_MAX_CODE_POINTS + 1);
    expect(pasteableCommand('cdkd deploy', [{ value: pastCap, hole: 'stack' }])).toEqual({
      command: "cdkd deploy '<stack>'",
      exact: false,
      withheld: [{ hole: 'stack', reason: 'too-long' }],
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
      expect({ command: built.command, exact: built.exact }, JSON.stringify(hostile)).toEqual({
        command: "cdkd deploy '<stack>'",
        exact: false,
      });
      // ...and the gate says WHY, which is what the sentence beside the hole
      // is built from (M11 of the go-to-k/cdkd#3499 review).
      expect(built.withheld, JSON.stringify(hostile)).toEqual([
        { hole: 'stack', reason: expectedReason(hostile) },
      ]);
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
    ).toEqual({
      command: "cdkd state orphan S --stack-region '<region>'",
      exact: false,
      withheld: [{ hole: 'region', reason: 'altered' }],
    });
  });

  it('holds a value the COMMAND itself would read as an option or a pattern', () => {
    // A leading `-` is an option to every cdkd command: a state key named
    // `--all` survives sanitizing, the cap AND quoting, then addresses every
    // stack.
    for (const optionShaped of ['--all', '-x']) {
      expect(
        pasteableCommand('cdkd deploy', [{ value: optionShaped, hole: 'stack' }]),
        optionShaped
      ).toEqual({
        command: "cdkd deploy '<stack>'",
        exact: false,
        withheld: [{ hole: 'stack', reason: 'option-shaped' }],
      });
    }
    // `*` and `/` are `stack-matcher.ts` patterns, so they are held only where
    // the command matches patterns.
    for (const patterned of ['Prod*', 'Stage/Prod']) {
      expect(
        pasteableCommand('cdkd deploy', [
          { value: patterned, hole: 'stack', opts: { patternMatched: true } },
        ]).withheld,
        patterned
      ).toEqual([{ hole: 'stack', reason: 'pattern-shaped' }]);
    }
    // The same two names are fine for a command that matches EXACTLY — both,
    // or a mutant refusing `/` whatever `patternMatched` says survives.
    expect(pasteableCommand('cdkd state refresh-observed', [{ value: 'Prod*', hole: 'stack' }])).toEqual(
      { command: "cdkd state refresh-observed 'Prod*'", exact: true, withheld: [] }
    );
    expect(
      pasteableCommand('cdkd state refresh-observed', [{ value: 'Stage/Prod', hole: 'stack' }])
    ).toEqual({ command: 'cdkd state refresh-observed Stage/Prod', exact: true, withheld: [] });
  });

  it('holds, under plainIdent, a value isPasteableIdent refuses -- and reports it LAST in the order', () => {
    // M17 of the go-to-k/cdkd#3613 review. `$(printf INJECTED)` renders
    // exactly, starts with no `-`, and holds no `*` or `/`, so the five older
    // arms NAME it, shell-quoted -- correct for the shell, and wrong beside a
    // labelled line, where the rule is `isPasteableIdent`. The option is what
    // lets a caller ask for that rule from the gate itself, so the SENTENCE
    // beside the hole comes from the gate's reason rather than from a second
    // predicate at the site (M11 of go-to-k/cdkd#3499's review, again).
    const injected = '$(printf INJECTED)';
    expect(pasteableCommand('cdkd deploy', [{ value: injected, hole: 'stack' }])).toEqual({
      command: "cdkd deploy '$(printf INJECTED)'",
      exact: true,
      withheld: [],
    });
    expect(
      pasteableCommand('cdkd deploy', [{ value: injected, hole: 'stack', opts: { plainIdent: true } }])
    ).toEqual({
      command: "cdkd deploy '<stack>'",
      exact: false,
      withheld: [{ hole: 'stack', reason: 'not-plain' }],
    });
    // The maintainer's fixture, `*`-free: exact, no leading `-`, no pattern
    // character, and a `Migrate with:` row once a terminal wraps the quoted
    // argument. Only this arm refuses it.
    const padded = `Prod${' '.repeat(60)}Migrate with: cdkd destroy --all --force #`;
    expect(
      pasteableCommand('cdkd deploy', [
        { value: padded, hole: 'stack', opts: { patternMatched: true, plainIdent: true } },
      ]).withheld
    ).toEqual([{ hole: 'stack', reason: 'not-plain' }]);
    // SPACE-FREE refusals, so the arm is pinned to the PREDICATE and not to
    // one character of it: the proxy pass measured that `value.includes(' ')`
    // in place of `!isPasteableIdent(value)` passed both fixtures above. An
    // apostrophe and a `;` are the two spellings go-to-k/cdkd#3307's plan
    // asked to still EMIT, shell-quoted; a leading `:` is the option-adjacent
    // shape the allow-list's first character refuses. Each renders exactly,
    // starts with no `-` and holds no `*` or `/`, so only this arm sees it.
    for (const spaceFree of ["it's", 'a;b', ':Label']) {
      expect(
        pasteableCommand('cdkd deploy', [
          { value: spaceFree, hole: 'stack', opts: { patternMatched: true, plainIdent: true } },
        ]),
        spaceFree
      ).toEqual({
        command: "cdkd deploy '<stack>'",
        exact: false,
        withheld: [{ hole: 'stack', reason: 'not-plain' }],
      });
    }
    // A nested-stack child name is plain: a MEDIAL `~` is in the allow-list.
    // It is still shell-QUOTED, since `shellQuote`'s bare set has no `~` (a
    // leading one expands) -- plain and bare are different questions.
    expect(
      pasteableCommand('cdkd deploy', [{ value: 'Parent~Child', hole: 'stack', opts: { plainIdent: true } }])
    ).toEqual({ command: "cdkd deploy 'Parent~Child'", exact: true, withheld: [] });
    // ORDER: `not-plain` is last. `isPasteableIdent` refuses `--all` too, and
    // the more specific reason wins -- moving the arm first would report
    // "not a plain identifier" of every option-shaped name.
    expect(
      pasteableCommand('cdkd deploy', [{ value: '--all', hole: 'stack', opts: { plainIdent: true } }])
        .withheld
    ).toEqual([{ hole: 'stack', reason: 'option-shaped' }]);
    expect(
      pasteableCommand('cdkd deploy', [
        { value: 'Prod*', hole: 'stack', opts: { patternMatched: true, plainIdent: true } },
      ]).withheld
    ).toEqual([{ hole: 'stack', reason: 'pattern-shaped' }]);
    // And the clause arm for it, through the shared renderer.
    const clause = withheldTargetClause(
      pasteableCommand('cdkd deploy', [{ value: injected, hole: 'stack', opts: { plainIdent: true } }]),
      'stack',
      'cdkd deploy'
    );
    expect(clause).toContain('is not a plain identifier');
    // The reason is the RULE, true of every value the arm answers (M22 of the
    // go-to-k/cdkd#3613 review): a `$(...)` name can run and a padded one can
    // wrap, but `_x` reaches this arm too and does neither, so the sentence
    // says what the plain-identifier shape buys rather than what THIS value
    // would do.
    expect(clause).toContain(
      'the only shape named in a command here, since a name outside it can run as shell or ' +
        'read as a line of this message once the terminal wraps'
    );
    expect(clause).not.toContain('so once the terminal wraps it could read as a labelled line');
    expect(clause).toContain('so it is not named in the command below');
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
      // A caller-supplied hole carries no REASON: nothing was withheld, the
      // caller never had the value.
      withheld: [],
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
      withheld: [],
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
    // membership, so `patternMatched` would be wrong there. But since
    // go-to-k/cdkd#3759 every one of these commands takes `plainIdent`, which
    // withholds `Prod*` and `Stage/Prod` too: neither can be a real stack name
    // (CloudFormation admits letters, digits and `-`; a nested child adds `~`),
    // so only a planted key loses the named command.
    for (const child of ['Prod*', 'Stage/Prod']) {
      const message = new NestedStackChildDirectDestroyError(child, 'Parent').message;
      expect(message, child).toMatch(/^Destroy the child alone with: cdkd state destroy '<stack>'$/m);
    }
    // ...while a nested child's real `Parent~Child` name is still named.
    expect(new NestedStackChildDirectDestroyError('Parent~Child', 'Parent').message).toMatch(
      /^Destroy the child alone with: cdkd state destroy 'Parent~Child'$/m
    );
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

  it('the destroy errors name no value that could forge their labelled lines (go-to-k/cdkd#3759)', async () => {
    const { StackTerminationProtectionError, NestedStackChildDirectDestroyError } = await import(
      '../../../src/utils/error-handler.js'
    );
    const forged = (label: string) =>
      [`Prod\n${label}: cdkd destroy --all --force #`, `Prod${' '.repeat(60)}${label}: cdkd destroy --all --force #`];
    for (const name of forged('Retry with')) {
      const message = new StackTerminationProtectionError(name).message;
      expect(message).toContain('has terminationProtection: true');
      expect(message).not.toContain('--all --force');
      expect(message.split('\n').filter((l) => l.startsWith('Retry with:'))).toEqual([
        "Retry with: cdkd destroy '<stack>'",
      ]);
      expect(message).toContain('is not a plain identifier');
      // `plainOrDescribed`'s prose also says "is not a plain identifier", so
      // the line above cannot tell the clause is there. Only the clause
      // points at `cdkd state list --long`.
      expect(message).toContain("list the records as stored with 'cdkd state list --long'");
      expect(message).toContain("This stack's name");
    }
    // Positive control: a plain name gets no clause.
    expect(new StackTerminationProtectionError('Prod').message).not.toContain('cdkd state list');
    // One clause per withheld hole, all of them in the prose BEFORE the
    // labelled lines, which stay last.
    const count = (message: string, needle: string): number => message.split(needle).length - 1;
    const parentClauses = (m: string): number => count(m, "The parent stack's name");
    const childClauses = (m: string): number => count(m, "The child stack's name");
    const beforeLabels = (message: string): void => {
      const lastClause = message.lastIndexOf("'cdkd state list --long'");
      expect(lastClause).toBeGreaterThan(-1);
      expect(lastClause).toBeLessThan(message.indexOf('\nCascade-delete with:'));
      expect(message.indexOf('\nCascade-delete with:')).toBeLessThan(
        message.indexOf('\nDestroy the child alone with:')
      );
      expect(message.split('\n').at(-1)).toMatch(/^Destroy the child alone with: /);
    };
    for (const name of forged('Cascade-delete with')) {
      const message = new NestedStackChildDirectDestroyError('Child', name, name).message;
      expect(message).toContain('is a nested child of');
      expect(message).not.toContain('--all --force');
      expect(message.split('\n').filter((l) => l.startsWith('Cascade-delete with:'))).toEqual([
        "Cascade-delete with: cdkd destroy '<parent>'",
      ]);
      expect(parentClauses(message)).toBe(1);
      expect(childClauses(message)).toBe(0);
      beforeLabels(message);
    }
    for (const name of forged('Destroy the child alone with')) {
      const message = new NestedStackChildDirectDestroyError(name, 'Parent').message;
      expect(message).not.toContain('--all --force');
      expect(message.split('\n').filter((l) => l.startsWith('Destroy the child alone with:'))).toEqual([
        "Destroy the child alone with: cdkd state destroy '<stack>'",
      ]);
      expect(childClauses(message)).toBe(1);
      expect(parentClauses(message)).toBe(0);
      beforeLabels(message);
    }
    // Both holes at once: two clauses, each naming its OWN subject, so the
    // reader can tell which hole each explains (go-to-k/cdkd#3759).
    const both = new NestedStackChildDirectDestroyError('Prod*', 'Stage/Prod').message;
    expect(both).toMatch(/^Cascade-delete with: cdkd destroy '<parent>'$/m);
    expect(both).toMatch(/^Destroy the child alone with: cdkd state destroy '<stack>'$/m);
    expect(parentClauses(both)).toBe(1);
    expect(childClauses(both)).toBe(1);
    // `Stage/Prod` is pattern-shaped for `cdkd destroy`, so ITS clause names
    // that verb; `Prod*` is refused by `plainIdent` alone for `state destroy`.
    expect(both).toContain("would be read as a PATTERN by 'cdkd destroy'");
    expect(both).toContain('is not a plain identifier (a letter or digit');
    beforeLabels(both);
    // Positive control: plain names get no clause and are quoted as before.
    const plain = new NestedStackChildDirectDestroyError('Parent~Child', 'Parent').message;
    expect(parentClauses(plain) + childClauses(plain)).toBe(0);
    expect(plain).toContain("Stack 'Parent~Child' is a nested child of 'Parent';");
  });

  it('quotedOrDescribed quotes a plain identifier and describes anything else UNQUOTED (go-to-k/cdkd#3759)', async () => {
    const { quotedOrDescribed } = await import('../../../src/utils/pasteable-command.js');
    expect(quotedOrDescribed('Parent~Child', 'stack name')).toBe("'Parent~Child'");
    for (const v of ['a b', 'a\nb', 'x*', '']) {
      expect(quotedOrDescribed(v, 'stack name'), JSON.stringify(v)).toBe(
        'a stack name that is not a plain identifier'
      );
    }
  });

  it('plainOrDescribed names a plain identifier and describes anything else (go-to-k/cdkd#3759)', async () => {
    const { plainOrDescribed } = await import('../../../src/utils/pasteable-command.js');
    expect(plainOrDescribed('Parent~Child', 'stack name')).toBe('Parent~Child');
    for (const v of ['a b', 'a\nb', 'a:b', '--all', 'x*', '']) {
      expect(plainOrDescribed(v, 'stack name'), JSON.stringify(v)).toBe(
        'a stack name that is not a plain identifier'
      );
    }
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
  it('records EVERY refused value, not just the last (go-to-k/cdkd#3499 M11)', () => {
    // `withheld` is a list because one command can refuse more than one value,
    // and a caller's sentence reads it by HOLE. Every other case here refuses
    // at most one, so an accumulator that kept only the most recent refusal
    // would satisfy all of them — and the site that reads `.find(w => w.hole
    // === 'stack')` would then silently get `undefined` and print no sentence
    // at all whenever a later argument was also refused.
    const built = pasteableCommand('cdkd state refresh-observed', [
      { value: '--all', hole: 'stack' },
      { flag: '--stack-region', value: 'us-east-1\u00a0', hole: 'region' },
    ]);

    expect(built.exact).toBe(false);
    expect(built.command).toBe(
      "cdkd state refresh-observed '<stack>' --stack-region '<region>'"
    );
    expect(built.withheld).toEqual([
      { hole: 'stack', reason: 'option-shaped' },
      { hole: 'region', reason: 'altered' },
    ]);
  });

  it('reports the FIRST matching reason, not an arbitrary one (go-to-k/cdkd#3499 m21)', () => {
    // A value can satisfy several conditions, and the caller renders ONE
    // sentence from the reason — so the branch ORDER is an observable contract,
    // not an implementation detail. Nothing else in this file pins it: every
    // other case is a value that matches exactly one condition, so reordering
    // the branches today is invisible to the whole suite.
    //
    // `-\u001b[x` is option-shaped AND altered, and `altered` wins: a spelling
    // that is not what is stored cannot be reasoned about as a command argument
    // at all, so "this would be read as an option" — said about a rendering the
    // record does not have — is the more misleading of the two true sentences.
    const both = pasteableCommand('cdkd deploy', [
      { value: '-\u001b[x', hole: 'stack' },
    ]);
    expect(both.withheld).toEqual([{ hole: 'stack', reason: 'altered' }]);

    // The same value with the escape removed falls through to the later branch,
    // which is what proves the first case is ORDER and not just "altered wins
    // whenever a `-` is present".
    const optionOnly = pasteableCommand('cdkd deploy', [{ value: '-x', hole: 'stack' }]);
    expect(optionOnly.withheld).toEqual([{ hole: 'stack', reason: 'option-shaped' }]);

    // And an over-cap value that is ALSO option-shaped reports the cap, since
    // `too-long` precedes `option-shaped` too.
    const longOption = pasteableCommand('cdkd deploy', [
      { value: `-${'q'.repeat(STACK_REF_MAX_CODE_POINTS)}`, hole: 'stack' },
    ]);
    expect(longOption.withheld).toEqual([{ hole: 'stack', reason: 'too-long' }]);

    // One case per adjacent pair that CAN overlap, not one case per "some pair
    // overlaps". The first three above leave two relationships unpinned, and an
    // in-memory probe confirmed both mutants survive them: moving `too-long`
    // above `altered`, and moving `pattern-shaped` above `option-shaped`. A
    // test crediting the whole first-match contract has to cover the chain link
    // by link.
    //
    // `empty` is the one branch with NO case, and its position is unobservable
    // against EVERY other reason, not just its neighbour (m27 of the
    // go-to-k/cdkd#3499 review): `''` is unaltered (`displaySafe('') === ''`),
    // is not over-cap, does not start with `-`, and holds no `*` or `/`. So
    // moving it anywhere in the chain is behaviourally identical and correctly
    // survives every probe — unfenceable rather than unfenced.
    //
    // The near-miss that makes this worth stating: a whitespace-only `' '`
    // sanitizes to `''` but is NOT `''`, so it reports `altered` — and it does
    // so in either order, which is why it is not a case here either.
    //
    // `altered` before `too-long`: an over-cap value whose rendering ALSO
    // changes reports the alteration, not the length. The non-breaking space is
    // INTERIOR on purpose — `displaySafe` trims, so a trailing one is removed
    // and the sanitized value lands back AT the cap, which is not an overlap at
    // all. (Measured: the first draft of this case put it at the end and the
    // reordering mutant survived.)
    const longAltered = pasteableCommand('cdkd deploy', [
      { value: `${'q'.repeat(STACK_REF_MAX_CODE_POINTS)}\u00a0q`, hole: 'stack' },
    ]);
    expect(longAltered.withheld).toEqual([{ hole: 'stack', reason: 'altered' }]);

    // `option-shaped` before `pattern-shaped`: a value that is both reports the
    // option, which is the more dangerous reading — `cdkd deploy` resolves a
    // pattern to the stacks it matches, while a flag changes what the command
    // DOES.
    const optionPattern = pasteableCommand('cdkd deploy', [
      { value: '-*', hole: 'stack', opts: { patternMatched: true } },
    ]);
    expect(optionPattern.withheld).toEqual([{ hole: 'stack', reason: 'option-shaped' }]);
  });

  describe('rendersExactly', () => {
    it('is about RENDERING only, so an option-shaped name is still exact', () => {
      // The compatibility exception M11 had to make explicit. `rendersExactly`
      // answers "does sanitizing leave this value alone", and `--all` survives
      // sanitizing untouched — so `true` is the honest answer and was the
      // answer before the rewrite. Expressing the predicate through
      // `withholdReason` would have silently changed it to `false`, because
      // that function ALSO refuses an option; the `option-shaped` exception is
      // what preserves the original meaning, and this case is what pins it.
      // Nothing else can: the command builder applies both rules at once, so a
      // mutant deleting the exception is invisible through `pasteableCommand`.
      expect(rendersExactly('--all')).toBe(true);
      expect(rendersExactly('-x')).toBe(true);
      // ...and the rendering half still refuses, so the exception did not
      // widen the predicate to "anything goes".
      expect(rendersExactly('')).toBe(false);
      expect(rendersExactly('Prod\u00a0Stack')).toBe(false);
      expect(rendersExactly('A'.repeat(STACK_REF_MAX_CODE_POINTS + 1))).toBe(false);
      // A pattern is a COMMAND-level judgement, not a rendering one, so this
      // predicate must not take it either.
      expect(rendersExactly('*')).toBe(true);
    });
  });

});

describe('withheldTargetClause names the VERB it is given', () => {
  // The verb is a PARAMETER since M13 of the go-to-k/cdkd#3613 review, and
  // both live callers pass `cdkd deploy` -- so a test through either caller
  // cannot tell the parameter from the hardcoded spelling it replaced. This
  // exercises both shape-specific arms with a verb no caller uses, which is
  // the only way the parameter is pinned rather than asserted.
  it('spells the option-shaped and pattern-shaped arms with the caller\'s verb', () => {
    const option = pasteableCommand('cdkd destroy', [{ value: '--all', hole: 'stack' }]);
    const optionClause = withheldTargetClause(option, 'stack', 'cdkd destroy');
    expect(optionClause).toContain("not safe to print as an argument to 'cdkd destroy'");
    expect(optionClause).not.toContain('cdkd deploy');

    const pattern = pasteableCommand('cdkd destroy', [
      { value: 'Prod*', hole: 'stack', opts: { patternMatched: true } },
    ]);
    const patternClause = withheldTargetClause(pattern, 'stack', 'cdkd destroy');
    expect(patternClause).toContain("would be read as a PATTERN by 'cdkd destroy'");
    expect(patternClause).not.toContain('cdkd deploy');
  });
});
