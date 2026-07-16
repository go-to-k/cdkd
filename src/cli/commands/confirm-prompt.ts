/**
 * Default-YES confirmation prompt (`[Y/n]`, empty input = yes). Used by the
 * issue #1007 asset-storage auto-create on interactive TTY deploys without
 * `--yes`. Kept in its own module (mirrors `recreate-confirm-prompt.ts`) so
 * the accept/decline parsing is unit-testable without importing the whole
 * deploy command.
 */

import readline from 'node:readline/promises';

export async function promptYesNo(prompt: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(`${prompt} [Y/n] `);
    return /^(y(es)?)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}
