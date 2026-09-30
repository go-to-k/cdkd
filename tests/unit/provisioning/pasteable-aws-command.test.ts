import { describe, it, expect } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';

import {
  type PasteableAwsCommand,
  WITHHELD_AWS_COMMAND,
  pasteableAwsCommand,
  renderDisableCommand,
} from '../../../src/provisioning/replacement-protection-advice.js';
import { isRetryableTransientError } from '../../../src/deployment/retryable-errors.js';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';

/**
 * `pasteableAwsCommand`, the tagged-template form of `renderDisableCommand`'s
 * gate (issue [#3136](https://github.com/go-to-k/cdkd/issues/3136)) for provider
 * messages naming several values, or one mid-command.
 *
 * The provider sites are pinned in each provider's own suite, through the
 * shared probes in `pasteable-aws-command-assert.ts`; this file pins the rule
 * they share, including the one property a string assertion
 * cannot show: that a printed command, run by a real shell, hands the value
 * to `aws` as ONE argument and runs nothing else. A value holding a
 * shell-active character is not printed at all (go-to-k/cdkd#3950).
 */

const FORGED_QUOTE = "x'; touch /tmp/cdkd-3136-pwned; echo '";
const FORGED_SUBST = 'x$(touch /tmp/cdkd-3136-pwned)`id`';

/** Run `command` under bash with `aws` stubbed to print its argv, one per line. */
function argvUnderBash(command: string): string[] {
  const script = `aws() { printf '%s\\n' "$@"; }\n${command}\n`;
  const out = spawnSync('bash', ['--noprofile', '--norc', '-c', script], { encoding: 'utf8' });
  expect(out.status).toBe(0);
  return out.stdout.split('\n').slice(0, -1);
}

describe('pasteableAwsCommand (issue #3136)', () => {
  const aws = pasteableAwsCommand();

  it('renders a clean value BARE, literal spans untouched', () => {
    const cmd = aws`aws iam delete-role --role-name ${'my-role_1'} --query 'x[].y'`;
    expect(cmd.text).toBe("aws iam delete-role --role-name my-role_1 --query 'x[].y'");
    expect(cmd.render()).toBe(cmd.text);
  });

  it.each([
    ['a quote', FORGED_QUOTE],
    ['command substitution', FORGED_SUBST],
    ['a space and a semicolon', 'a b; c'],
  ])('WITHHOLDS the whole command for a value carrying %s (go-to-k/cdkd#3950)', (_label, forged) => {
    const cmd = aws`aws iam delete-role --role-name ${forged} --no-cli-pager`;
    expect(cmd.text).toBeUndefined();
    expect(cmd.render()).toBe(WITHHELD_AWS_COMMAND);
    // A plain value is still named bare, and bash passes it as ONE argument.
    const plain = aws`aws iam delete-role --role-name ${'team.a_b@c:d/e+f'} --no-cli-pager`;
    expect(plain.text).toBe('aws iam delete-role --role-name team.a_b@c:d/e+f --no-cli-pager');
    expect(argvUnderBash(plain.text!)).toEqual([
      'iam',
      'delete-role',
      '--role-name',
      'team.a_b@c:d/e+f',
      '--no-cli-pager',
    ]);
  });

  it.each([
    ['ESC', 'x\u001b[2Jy'],
    ['a newline', 'x\nWARN forged line'],
    ['NUL', 'x\u0000y'],
    ['non-ASCII', 'café'],
    ['a bidi override', 'x‮y'],
    ['empty', ''],
  ])('WITHHOLDS the whole command for a value carrying %s', (_label, forged) => {
    const cmd = aws`aws iam delete-role --role-name ${forged}`;
    expect(cmd.text).toBeUndefined();
    expect(cmd.render()).toBe(WITHHELD_AWS_COMMAND);
  });

  it('withholds for a non-string value that reached a string-typed slot through a cast', () => {
    const cmd = aws`aws iam delete-role --role-name ${{ Ref: 'X' } as unknown as string}`;
    expect(cmd.text).toBeUndefined();
  });

  it('withholds when ANY one of several values is unnameable', () => {
    expect(aws`aws a b --x ${'ok'} --y ${'bad\u001b'}`.text).toBeUndefined();
    expect(aws`aws a b --x ${'ok'} --y ${'ok2'}`.text).toBe('aws a b --x ok --y ok2');
  });

  it('splices a nested fragment verbatim, and withholds the outer command when it is withheld', () => {
    const bus = (name: string): PasteableAwsCommand =>
      aws` --event-bus-name ${name}`;
    expect(aws`aws events delete-rule --name ${'r'}${bus('b.x')}`.text).toBe(
      'aws events delete-rule --name r --event-bus-name b.x'
    );
    expect(aws`aws events delete-rule --name ${'r'}${aws``}`.text).toBe(
      'aws events delete-rule --name r'
    );
    expect(aws`aws events delete-rule --name ${'r'}${bus('b\nx')}`.text).toBeUndefined();
    // A shell-active character in the fragment withholds the outer command too
    // (go-to-k/cdkd#3950).
    expect(aws`aws events delete-rule --name ${'r'}${bus("b'x")}`.text).toBeUndefined();
  });

  it('withholds a command that splices a fragment built by ANOTHER tag', () => {
    // The fragment's value passed ITS tag's masker (none here), not the outer
    // one's, so splicing it would let a secret the outer masker catches through.
    const masked = pasteableAwsCommand((t) => t.replaceAll('s3cr3t', '***'));
    const unmaskedFragment = pasteableAwsCommand()` --n ${'s3cr3t'}`;
    expect(unmaskedFragment.text).toBe(' --n s3cr3t');
    expect(masked`aws x y${unmaskedFragment}`.text).toBeUndefined();
    // The same fragment built by the outer tag is judged by ITS masker.
    expect(masked`aws x y${masked` --n ${'plain'}`}`.text).toBe('aws x y --n plain');
  });

  it('withholds a value the masker would change, and leaves one it would not', () => {
    const masked = pasteableAwsCommand((t) => t.replaceAll('s3cr3t', '***'));
    // No quote in it: a `'` is withheld by the shell-active gate whatever the
    // masker says (go-to-k/cdkd#3950), so only a quote-free secret proves the
    // masker gate withholds on its own.
    expect(masked`aws x y --n ${'s3cr3tq'}`.text).toBeUndefined();
    expect(masked`aws x y --n ${'plain'}`.text).toBe('aws x y --n plain');
  });

  it('agrees with renderDisableCommand, which shares the gate', () => {
    for (const value of ['clean', FORGED_QUOTE, 'x\u001by', '']) {
      const tagged = aws`aws logs delete-log-group --log-group-name ${value}`.text ?? '';
      expect(
        renderDisableCommand({
          before: 'aws logs delete-log-group --log-group-name',
          identifier: value,
        })
      ).toBe(tagged);
    }
  });

  it('renderDisableCommand withholds an identifier that would change the command once unquoted (go-to-k/cdkd#3950)', () => {
    const render = (identifier: string): string => renderDisableCommand({ before: 'aws x y --id', identifier });
    // Refused: each character that changes a word anywhere, measured under bash
    // and zsh (a tab is left out: `displaySafe` changes it before this gate),
    // plus the ones that complete a glob or a brace expansion.
    const anywhere = [...' \'"`$;&|<>()\\*?[]{}!'];
    expect(anywhere).toHaveLength(20);
    for (const c of anywhere) expect(render(`a${c}b`), JSON.stringify(c)).toBe('');
    // Refused only where the shell acts on them: `#` or `=` starting the word,
    // and `~` starting it or right after `=` or `:` (bash expands both inside an
    // assignment-shaped word).
    for (const id of ['#ab', '=ab', '~ab', 'a=~root', 'x=y:~']) expect(render(id), id).toBe('');
  });

  it('renderDisableCommand keeps the command for a mid-word #, =, , % or ^ (go-to-k/cdkd#3950)', () => {
    // Literal under both shells, and AWS names carry them: a log group
    // `/app#blue`, an IAM name with `=` or `,`. The gate must not reach them.
    const render = (identifier: string): string => renderDisableCommand({ before: 'aws x y --id', identifier });
    for (const id of ['/app#blue', 'role=a', 'a,b', 'a%b', 'a^b', 'a~b']) {
      expect(render(id), id).toMatch(/^aws x y --id /);
    }
    expect(render('team.a_b@c:d/e+f')).toBe('aws x y --id team.a_b@c:d/e+f');
  });

  it('a pasteableAwsCommand hint after a cdkd\'s apostrophe pastes nothing runnable (go-to-k/cdkd#3950)', () => {
    // The apostrophe opens a single quote a pasted line then closes early, so
    // a shell-quoted identifier would sit bare. Each payload family, plus a
    // space-free backtick payload, as the identifier.
    const ids = [...PASTE_PAYLOADS.map((p) => p.value), 'x`touch${IFS}OWNED`y'];
    withPasteDir((dir) => {
      for (const id of ids) {
        const hint = `cdkd's cleanup could not delete it. Run: ${pasteableAwsCommand()`aws x y --id ${id}`.render()}`;
        expect(spansThatRun(hint, dir), id).toEqual([]);
        expect(hint, id).toContain(WITHHELD_AWS_COMMAND);
      }
    });
  }, 120_000);

  it('the withheld note names no value and matches no retryable pattern', () => {
    // It is spliced into THROWN messages (the ACM create failure), which
    // `isRetryableTransientError` classifies by substring.
    expect(isRetryableTransientError(new Error(WITHHELD_AWS_COMMAND), WITHHELD_AWS_COMMAND)).toBe(
      false
    );
  });
});
