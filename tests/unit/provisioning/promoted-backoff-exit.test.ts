/**
 * Issue #3939 — the SYMPTOM, in a real process: a command awaiting a
 * create-only lookup that a background prefetch started, and that is backing
 * off from a throttle, must keep the process alive until the lookup settles.
 *
 * Before the fix, promoting the prefetch call left its backoff on an unref'd
 * timer, so with nothing else ref'd the event loop drained mid-await and Node
 * exited 0 having printed nothing (`cdkd deploy` exited 0 with the stack lock
 * still held). The in-process cases in `create-only-properties.test.ts` pin the
 * timer's ref state; only a child process can show the exit itself.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { DESCRIBE_TYPE_MAX_IN_FLIGHT } from '../../../src/provisioning/describe-type.js';
import { isolatedChildEnv, writeSourceLoaderHooks } from '../source-loader-hooks.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const SPAWN_TIMEOUT_MS = 30_000;

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * The child: a stubbed CloudFormation client throttles the first DescribeType
 * and answers the second; nothing else in the process holds the loop open,
 * exactly as in `cdkd deploy` (its lock renewal and event flush timers are
 * unref'd). `awaitWhen` says whether the lookup joins the prefetch call while
 * it is still QUEUED/running (`at-once`) or mid-backoff (`mid-backoff`), or —
 * `queued-behind-backoffs` — whether the awaited type is one the prefetch
 * QUEUED behind a full limiter whose every running call is backing off: the
 * awaited call is promoted to the head of the queue, but it cannot start until
 * one of those backoffs ends, so their sleeps are what the command waits on.
 */
type AwaitWhen = 'at-once' | 'mid-backoff' | 'queued-behind-backoffs';

function childScript(awaitWhen: AwaitWhen): string {
  const types =
    awaitWhen === 'queued-behind-backoffs'
      ? Array.from({ length: DESCRIBE_TYPE_MAX_IN_FLIGHT + 1 }, (_, i) => `AWS::Test::T${i}`)
      : ['AWS::Test::Throttled'];
  const src = (path: string): string => pathToFileURL(join(REPO_ROOT, 'src', path)).href;
  return `
import { setAwsClients } from ${JSON.stringify(src('utils/aws-clients.ts'))};
import {
  getCreateOnlyPropertyPaths,
  prefetchCreateOnlyPropertyPaths,
} from ${JSON.stringify(src('provisioning/create-only-properties.ts'))};

const types = ${JSON.stringify(types)};
const awaitedType = types[types.length - 1];
const throttledOnce = new Set();
let sends = 0;
let polls = 0;
// Counts the backoffs' first 1 s steps without changing them.
let backoffsStarted = 0;
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = ((fn, ms, ...rest) => {
  if (ms === 1000) backoffsStarted++;
  return realSetTimeout(fn, ms, ...rest);
});
// Every type's FIRST send is throttled; its retry answers.
setAwsClients({
  cloudFormation: {
    send: async (command) => {
      sends++;
      const type = command.input.TypeName;
      if (!throttledOnce.has(type)) {
        throttledOnce.add(type);
        throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
      }
      return { Schema: JSON.stringify({ createOnlyProperties: ['/properties/Name'] }) };
    },
  },
});

// Not a top-level await: like the CLI's \`main()\`, so a drained loop exits
// 0 (an unsettled top-level await would exit 13 instead).
async function main() {
  prefetchCreateOnlyPropertyPaths(types);
  if (${JSON.stringify(awaitWhen)} !== 'at-once') {
    // Let every running call's first send fail and its backoff begin, and
    // prove it did: joining earlier would silently test 'at-once' instead.
    const running = Math.min(types.length, ${DESCRIBE_TYPE_MAX_IN_FLIGHT});
    while (backoffsStarted < running) {
      await new Promise((resolve) => setImmediate(resolve));
      if (++polls > 1000) {
        console.error('the backoff sleep never started');
        process.exit(4);
      }
    }
  }
  const paths = await getCreateOnlyPropertyPaths(awaitedType);
  console.log('settled ' + JSON.stringify(paths) + ' after ' + sends + ' sends');
  process.exit(3);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
}

function runChild(awaitWhen: AwaitWhen): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-3939-'));
  scratchDirs.push(dir);
  const hooks = writeSourceLoaderHooks(dir);
  const script = join(dir, 'child.ts');
  writeFileSync(script, childScript(awaitWhen));
  const proc = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--no-warnings', '--import', pathToFileURL(hooks).href, script],
    { encoding: 'utf8', cwd: REPO_ROOT, timeout: SPAWN_TIMEOUT_MS, env: isolatedChildEnv() }
  );
  return { status: proc.status, stdout: proc.stdout ?? '', stderr: proc.stderr ?? '' };
}

describe('a command awaiting a promoted, throttled prefetch lookup (issue #3939)', () => {
  it.each(['mid-backoff', 'at-once', 'queued-behind-backoffs'] as const)(
    'keeps the process alive until the lookup settles (joined %s)',
    (awaitWhen) => {
      const result = runChild(awaitWhen);
      // Before the fix: status 0, stdout empty — the loop drained mid-await.
      const context = `status ${String(result.status)}, stderr:\n${result.stderr}`;
      expect(result.stdout, context).toContain('settled [["Name"]] after ');
      expect(result.status, context).toBe(3);
    },
    SPAWN_TIMEOUT_MS + 5_000
  );
});
