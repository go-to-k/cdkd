/**
 * Issue #3939 — `runCli`, the CLI's top-level runner, must never let a command
 * exit 0 because the event loop drained while `main()` was still pending.
 *
 * The subject is how a PROCESS exits, which only a child process can show:
 * the first block drives `runCli` itself (source, through the TS loader
 * hooks), the second drives the BUILT `dist/cli.js` with its command tree
 * stubbed, so a wiring regression in `src/cli/index.ts` is caught too.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
  UNSETTLED_COMMAND_EXIT_CODE,
  UNSETTLED_COMMAND_MESSAGE,
} from '../../../src/cli/run-cli.js';
import { isolatedChildEnv, writeSourceLoaderHooks } from '../source-loader-hooks.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SPAWN_TIMEOUT_MS = 30_000;
const LOCK_HINT = 'release it with: cdkd force-unlock <stack-name>';

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-run-cli-'));
  scratchDirs.push(dir);
  return dir;
}

interface Exit {
  status: number | null;
  stdout: string;
  stderr: string;
}

function spawnNode(args: string[]): Exit {
  const proc = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: SPAWN_TIMEOUT_MS,
    env: isolatedChildEnv(),
  });
  return { status: proc.status, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

/** Run `body` (the text of an async function body) as `main()` under `runCli`. */
function runMain(body: string, runner: 'runCli' | 'bare' = 'runCli'): Exit {
  const dir = scratch();
  const hooks = writeSourceLoaderHooks(dir);
  const script = join(dir, 'child.ts');
  const runCliUrl = pathToFileURL(join(REPO_ROOT, 'src/cli/run-cli.ts')).href;
  writeFileSync(
    script,
    `import { runCli } from ${JSON.stringify(runCliUrl)};
async function main() {
${body}
}
${runner === 'runCli' ? 'runCli(main);' : 'main().catch((e) => { console.error(e); process.exit(1); });'}
`
  );
  return spawnNode([
    '--experimental-strip-types',
    '--no-warnings',
    '--import',
    pathToFileURL(hooks).href,
    script,
  ]);
}

const count = (text: string, needle: string): number => text.split(needle).length - 1;

describe('runCli (issue #3939)', () => {
  it('control: WITHOUT it, a main() that never settles exits 0 in silence', () => {
    const result = runMain('await new Promise(() => {});', 'bare');
    expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
  }, SPAWN_TIMEOUT_MS + 5_000);

  it('a main() that never settles exits with its own code, saying so once, with the lock hint', () => {
    // A dedicated status, distinct from 1 (a command's own failure / diff changes).
    expect(UNSETTLED_COMMAND_EXIT_CODE).toBe(70);
    const result = runMain('await new Promise(() => {});');
    expect(result.status).toBe(UNSETTLED_COMMAND_EXIT_CODE);
    expect(count(result.stderr, UNSETTLED_COMMAND_MESSAGE)).toBe(1);
    expect(result.stderr).toContain(LOCK_HINT);
    expect(result.stdout).toBe('');
  }, SPAWN_TIMEOUT_MS + 5_000);

  it('says so once even when the loop drains a second time (async work after the first drain)', () => {
    // Another `beforeExit` listener scheduling work stands in for anything
    // that revives the loop after the first drain, such as a stderr write
    // that completes asynchronously.
    const result = runMain(
      "process.once('beforeExit', () => setTimeout(() => {}, 1));\n" +
        'await new Promise(() => {});'
    );
    expect(result.status).toBe(UNSETTLED_COMMAND_EXIT_CODE);
    expect(count(result.stderr, UNSETTLED_COMMAND_MESSAGE)).toBe(1);
  }, SPAWN_TIMEOUT_MS + 5_000);

  it('the same when it drains mid-way through: output before the stall is kept', () => {
    const result = runMain(
      "console.log('before');\n" +
        'await new Promise((resolve) => setTimeout(resolve, 5));\n' +
        'await new Promise(() => {});\n' +
        "console.log('after');"
    );
    expect(result.status).toBe(UNSETTLED_COMMAND_EXIT_CODE);
    expect(result.stdout).toBe('before\n');
    expect(count(result.stderr, UNSETTLED_COMMAND_MESSAGE)).toBe(1);
  }, SPAWN_TIMEOUT_MS + 5_000);

  it('a main() that settles exits 0 without the message, even with ref\'d work after it', () => {
    const result = runMain(
      "setTimeout(() => console.log('late timer'), 20);\nconsole.log('done');"
    );
    expect(result).toEqual({ status: 0, stdout: 'done\nlate timer\n', stderr: '' });
  }, SPAWN_TIMEOUT_MS + 5_000);

  it('a stall REPLACES an exit code the command had already set (diff exits 1 on changes)', () => {
    const result = runMain('process.exitCode = 1;\nawait new Promise(() => {});');
    expect(result.status).toBe(UNSETTLED_COMMAND_EXIT_CODE);
    expect(count(result.stderr, UNSETTLED_COMMAND_MESSAGE)).toBe(1);
  }, SPAWN_TIMEOUT_MS + 5_000);

  it('a stall replaces an exit code 0 the command had set', () => {
    const result = runMain('process.exitCode = 0;\nawait new Promise(() => {});');
    expect(result.status).toBe(UNSETTLED_COMMAND_EXIT_CODE);
    expect(count(result.stderr, UNSETTLED_COMMAND_MESSAGE)).toBe(1);
  }, SPAWN_TIMEOUT_MS + 5_000);

  it('a main() that settles keeps an exit code it set itself', () => {
    const result = runMain('process.exitCode = 7;');
    expect(result).toEqual({ status: 7, stdout: '', stderr: '' });
  }, SPAWN_TIMEOUT_MS + 5_000);

  it('a main() that rejects prints Fatal error and exits 1, without the unsettled message', () => {
    const result = runMain("throw new Error('boom');");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Fatal error: Error: boom');
    expect(result.stderr).not.toContain(UNSETTLED_COMMAND_MESSAGE);
  }, SPAWN_TIMEOUT_MS + 5_000);
});

/**
 * The wiring: `dist/cli.js` with its command tree replaced by a stub whose
 * `parseAsync` never settles. Deleting `runCli(main)` from `src/cli/index.ts`
 * (or bypassing it) turns this back into a silent exit 0. Same skip contract
 * as `version.test.ts`: skipped on an unbuilt tree, required under
 * `CDKD_EXPECT_DIST` (CI's build job).
 */
const cliPath = join(REPO_ROOT, 'dist', 'cli.js');
const skipUnbuilt = !existsSync(cliPath) && !process.env['CDKD_EXPECT_DIST'];

function runBuiltCliWithStubbedTree(parseAsync: string): Exit {
  expect(existsSync(cliPath), 'CDKD_EXPECT_DIST is set but dist/cli.js is absent').toBe(true);
  const distDir = join(REPO_ROOT, 'dist');
  const entry = readFileSync(cliPath, 'utf8');
  const programChunk = /import\(["'](\.\/[^"']*program[^"']*)["']\)/.exec(entry)?.[1];
  expect(programChunk, 'the entry no longer imports the command tree dynamically').toBeDefined();
  const sandbox = scratch();
  for (const match of entry.matchAll(/^import\s[^\n]*from\s*["'](\.\/[^"']+)["']/gm)) {
    copyFileSync(join(distDir, match[1]!), join(sandbox, match[1]!.replace('./', '')));
  }
  copyFileSync(cliPath, join(sandbox, 'cli.js'));
  writeFileSync(
    join(sandbox, programChunk!.replace('./', '')),
    `export function buildProgram() { return { parseAsync: ${parseAsync} }; }\n`
  );
  writeFileSync(join(sandbox, 'package.json'), '{"type":"module"}\n');
  return spawnNode([join(sandbox, 'cli.js'), 'deploy']);
}

describe('dist/cli.js runs main() through runCli (issue #3939)', () => {
  it.skipIf(skipUnbuilt)(
    'a command that never settles exits non-zero with the message',
    () => {
      const result = runBuiltCliWithStubbedTree('() => new Promise(() => {})');
      expect(result.status).toBe(UNSETTLED_COMMAND_EXIT_CODE);
      expect(count(result.stderr, UNSETTLED_COMMAND_MESSAGE)).toBe(1);
    },
    SPAWN_TIMEOUT_MS + 5_000
  );

  it.skipIf(skipUnbuilt)(
    'control: a command that settles exits 0 in silence through the same sandbox',
    () => {
      const result = runBuiltCliWithStubbedTree('async () => {}');
      expect(result).toEqual({ status: 0, stdout: '', stderr: '' });
    },
    SPAWN_TIMEOUT_MS + 5_000
  );
});
