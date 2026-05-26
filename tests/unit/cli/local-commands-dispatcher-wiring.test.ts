/**
 * Dispatcher-wiring regression test for the four `cdkd local *` commands.
 *
 * Issue #611 test gap: only `cdkd local invoke` is exercised end-to-end
 * by the existing `local-invoke-from-cfn-stack` integ. The other three
 * commands (`local-start-api` / `local-run-task` / `local-start-service`)
 * trust the unit-test dispatcher contract — if any of them forgets to
 * call `createLocalStateProvider` or fails to bubble the
 * `LocalStateSourceError` raised on the mutually-exclusive flag combo,
 * only the integ would catch it, and we only have an integ for one of
 * the four.
 *
 * This test closes the gap with a pure-source-text scan: each of the
 * four command files must
 *   (a) import `createLocalStateProvider` from `./local-state-source.js`,
 *   (b) call `createLocalStateProvider(` somewhere in the body, and
 *   (c) declare `fromCfnStack?: string | boolean` on its options type
 *       (so commander grammar wiring stays in lock-step).
 *
 * Plus a live mutual-exclusion assertion against `createLocalStateProvider`
 * itself — the four commands share this single dispatcher, so verifying
 * the dispatcher's bubble-up surface once (here) covers all four
 * command call sites without needing to mock Synthesizer / Docker /
 * route discovery / etc. for each command's full action.
 */

import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createLocalStateProvider,
  LocalStateSourceError,
} from '../../../src/cli/commands/local-state-source.js';

interface LocalCommand {
  /** Human label used in test names + assertion failure messages. */
  name: string;
  /** Path to the command's source file, relative to the repo root. */
  path: string;
}

const COMMANDS: LocalCommand[] = [
  { name: 'local-invoke', path: 'src/cli/commands/local-invoke.ts' },
  { name: 'local-start-api', path: 'src/cli/commands/local-start-api.ts' },
  { name: 'local-run-task', path: 'src/cli/commands/local-run-task.ts' },
  { name: 'local-start-service', path: 'src/cli/commands/local-start-service.ts' },
];

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

function readCommandSource(cmd: LocalCommand): string {
  return readFileSync(resolve(REPO_ROOT, cmd.path), 'utf-8');
}

describe.each(COMMANDS)('$name dispatcher wiring (Issue #611)', (cmd) => {
  const source = readCommandSource(cmd);

  it('imports createLocalStateProvider from ./local-state-source.js', () => {
    // Must import the helper. Either named import or aliased — the
    // regex matches the canonical "createLocalStateProvider" identifier
    // appearing anywhere in an import line from the dispatcher module.
    const importRegex =
      /import\s*\{[^}]*\bcreateLocalStateProvider\b[^}]*\}\s*from\s*['"]\.\/local-state-source\.js['"]/s;
    expect(source).toMatch(importRegex);
  });

  it('calls createLocalStateProvider(...) at least once in the body', () => {
    // Must invoke the dispatcher. The `(` at the end excludes a stray
    // mention in a comment / docstring that doesn't actually call.
    const callRegex = /\bcreateLocalStateProvider\s*\(/;
    expect(source).toMatch(callRegex);
  });

  it('declares fromCfnStack?: string | boolean on its options type', () => {
    // Commander grammar surface: the four commands must each have the
    // `--from-cfn-stack [<cfn-stack-name>]` flag wired into their
    // option type, otherwise the `createLocalStateProvider` call gets
    // a stale-shaped input and Commander silently ignores the flag.
    const optsRegex = /\bfromCfnStack\?\s*:\s*string\s*\|\s*boolean\b/;
    expect(source).toMatch(optsRegex);
  });
});

describe('createLocalStateProvider — bubble-up surface (shared by all 4 commands)', () => {
  // Every `cdkd local *` command surfaces the dispatcher's
  // `LocalStateSourceError` to the user via `withErrorHandling`. The
  // mutual-exclusion message is the most user-visible bubble-up path
  // (typed by users who supply both flags by mistake). Verifying it
  // here once exercises the bubble-up surface for all four commands
  // without needing to mock each command's full action shape.

  it('throws LocalStateSourceError when both --from-state and --from-cfn-stack are set (explicit name)', () => {
    expect(() =>
      createLocalStateProvider(
        { fromState: true, fromCfnStack: 'X', statePrefix: 'cdkd' },
        'CdkdStack',
        'us-east-1'
      )
    ).toThrow(LocalStateSourceError);
  });

  it('throws LocalStateSourceError when both --from-state and --from-cfn-stack (bare/boolean) are set', () => {
    expect(() =>
      createLocalStateProvider(
        { fromState: true, fromCfnStack: true, statePrefix: 'cdkd' },
        'CdkdStack',
        'us-east-1'
      )
    ).toThrow(LocalStateSourceError);
  });

  it('the surfaced error message names the mutual-exclusion violation', () => {
    expect(() =>
      createLocalStateProvider(
        { fromState: true, fromCfnStack: 'X', statePrefix: 'cdkd' },
        'CdkdStack',
        'us-east-1'
      )
    ).toThrow(/mutually exclusive/);
  });
});
