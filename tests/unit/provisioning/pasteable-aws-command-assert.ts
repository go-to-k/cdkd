import { expect } from 'vite-plus/test';

import { WITHHELD_AWS_COMMAND } from '../../../src/provisioning/replacement-protection-advice.js';
import { shellQuote } from '../../../src/utils/pasteable-command.js';

/**
 * Shared probes for the provider sites routed through `pasteableAwsCommand`
 * (issue [#3136](https://github.com/go-to-k/cdkd/issues/3136)). The rule itself
 * is pinned in `pasteable-aws-command.test.ts`; a site case only has to show
 * that its value REACHES that rule, in both outcomes.
 */

/** Printable ASCII, so the command is still shown — shell-quoted. */
export const FORGED_QUOTE = "x'; touch /tmp/cdkd-3136; echo '";
/** A control byte, so the whole command is withheld. */
export const FORGED_CTRL = 'x\u001b[2Jy';

/**
 * `flag` is the text directly before the value (e.g. `'--role-name '`): the
 * value must follow it QUOTED, and never raw.
 */
export function expectQuotedAfter(message: string, flag: string, forged: string): void {
  expect(message).toContain(`${flag}${shellQuote(forged)}`);
  expect(message).not.toContain(`${flag}${forged}`);
}

/** The command is replaced by the withheld note; `command` never appears. */
export function expectWithheld(message: string, command: string): void {
  expect(message).toContain(WITHHELD_AWS_COMMAND);
  expect(message).not.toContain(command);
}
