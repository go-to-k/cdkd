import { describe, it, expect } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';

import {
  type PasteableAwsCommand,
  WITHHELD_AWS_COMMAND,
  pasteableAwsCommand,
  renderDisableCommand,
} from '../../../src/provisioning/replacement-protection-advice.js';
import { shellQuote } from '../../../src/utils/pasteable-command.js';
import { isRetryableTransientError } from '../../../src/deployment/retryable-errors.js';

/**
 * `pasteableAwsCommand`, the tagged-template form of `renderDisableCommand`'s
 * gate (issue [#3136](https://github.com/go-to-k/cdkd/issues/3136)) for provider
 * messages naming several values, or one mid-command.
 *
 * The provider sites are pinned in each provider's own suite, through the
 * shared probes in `pasteable-aws-command-assert.ts`; this file pins the rule
 * they share, including the one property a string assertion
 * cannot show: that the printed command, run by a real shell, hands the forged
 * value to `aws` as ONE argument and runs nothing else.
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
  ])('shell-quotes a value carrying %s, so bash passes it as ONE argument', (_label, forged) => {
    const cmd = aws`aws iam delete-role --role-name ${forged} --no-cli-pager`;
    expect(cmd.text).toBe(`aws iam delete-role --role-name ${shellQuote(forged)} --no-cli-pager`);
    expect(argvUnderBash(cmd.text!)).toEqual([
      'iam',
      'delete-role',
      '--role-name',
      forged,
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
    expect(aws`aws events delete-rule --name ${'r'}${bus("b'x")}`.text).toBe(
      `aws events delete-rule --name r --event-bus-name ${shellQuote("b'x")}`
    );
    expect(aws`aws events delete-rule --name ${'r'}${aws``}`.text).toBe(
      'aws events delete-rule --name r'
    );
    expect(aws`aws events delete-rule --name ${'r'}${bus('b\nx')}`.text).toBeUndefined();
  });

  it('withholds a command that splices a fragment built by ANOTHER tag', () => {
    // The fragment's value passed ITS tag's masker (none here), not the outer
    // one's, so splicing it would let a secret the outer masker catches through.
    const masked = pasteableAwsCommand((t) => t.replaceAll('s3cr3t', '***'));
    const unmaskedFragment = pasteableAwsCommand()` --n ${"s3cr3t'q"}`;
    expect(unmaskedFragment.text).toBe(` --n ${shellQuote("s3cr3t'q")}`);
    expect(masked`aws x y${unmaskedFragment}`.text).toBeUndefined();
    // The same fragment built by the outer tag is judged by ITS masker.
    expect(masked`aws x y${masked` --n ${'plain'}`}`.text).toBe('aws x y --n plain');
  });

  it('withholds a value the masker would change, and leaves one it would not', () => {
    const masked = pasteableAwsCommand((t) => t.replaceAll('s3cr3t', '***'));
    expect(masked`aws x y --n ${"s3cr3t'q"}`.text).toBeUndefined();
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

  it('the withheld note names no value and matches no retryable pattern', () => {
    // It is spliced into THROWN messages (the ACM create failure), which
    // `isRetryableTransientError` classifies by substring.
    expect(isRetryableTransientError(new Error(WITHHELD_AWS_COMMAND), WITHHELD_AWS_COMMAND)).toBe(
      false
    );
  });
});
