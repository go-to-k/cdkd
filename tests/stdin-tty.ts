/**
 * The ONE way a unit test forces `process.stdin.isTTY`.
 *
 * Every command that prompts is guarded by `process.stdin.isTTY !== true`
 * (issue [#2275](https://github.com/go-to-k/cdkd/issues/2275) folded nine of
 * them into `confirmOrRefuse`; `destroy-runner.ts` and `state.ts`'s
 * `state destroy --all` keep their own inline copies), so every suite that
 * exercises one has to drive that flag. Eleven of them had grown their own
 * byte-identical copy of this function — the same duplication class
 * `tests/unit/cli/readline-prompt-population.test.ts` exists to end one layer
 * up, reproduced in the tests that fence it.
 *
 * `defineProperty`, not a plain assignment: `process.stdin.isTTY` is typed
 * `boolean` while its real value is ABSENT whenever stdin is not a terminal,
 * which is vitest's normal state.
 *
 * RESTORING absence DELETES the property rather than defining `undefined`
 * onto it. Measured on Node 24.15.0 with stdin redirected from `/dev/null`:
 * `'isTTY' in process.stdin` is `false` and
 * `Object.getOwnPropertyDescriptor(process.stdin, 'isTTY')` is `undefined` —
 * there is no own property at all. Writing `undefined` back therefore CREATES
 * one that was genuinely missing, so a suite's `afterEach` left the process in
 * a shape no real run produces. Nothing under test reads the difference today
 * (both spellings fail `!== true`), but a helper whose job is to restore must
 * actually restore.
 */
export function setStdinIsTty(value: boolean | undefined): void {
  if (value === undefined) {
    // `delete` on an absent property is a no-op, so this is also the right
    // move for a suite that never had one to begin with.
    delete (process.stdin as { isTTY?: boolean }).isTTY;
    return;
  }
  Object.defineProperty(process.stdin, 'isTTY', {
    value,
    configurable: true,
    writable: true,
  });
}
