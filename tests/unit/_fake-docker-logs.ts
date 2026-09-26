/**
 * A stand-in `docker` binary for driving the REAL `streamLogs`
 * (`src/local/docker-runner.ts`) through a real OS pipe — issue
 * [#2419](https://github.com/go-to-k/cdkd/issues/2419).
 *
 * `streamLogs` spawns `getDockerCmd() logs -f <id>`, and `getDockerCmd()`
 * honours `CDK_DOCKER`, so pointing that variable at this script is the whole
 * seam: nothing in production is mocked. The script writes one token to each
 * of its fds — the container-stdout token carries the argv it was given, so a
 * case can see the container id arrived — and then `exec sleep`s, the way
 * `docker logs -f` stays attached until the caller's stop function kills it.
 *
 * A mocked `spawn` would let a test assert the routing of bytes no pipe ever
 * carried, which is the reason `tests/unit/utils/docker-cmd-stdout-reservation.test.ts`
 * gives for using a real child too. POSIX-only, like that suite.
 */
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Prefix of what the fake container prints on its STDOUT (then `logs -f <id>`). */
export const CONTAINER_STDOUT_TOKEN = 'lane2419-container-stdout:';
/** What the fake container prints on its STDERR. */
export const CONTAINER_STDERR_TOKEN = 'lane2419-container-stderr';

export interface FakeDockerLogs {
  /** Restore `CDK_DOCKER` and remove the script's directory. */
  restore(): void;
}

/** Install the fake as `CDK_DOCKER` until {@link FakeDockerLogs.restore}. */
export function installFakeDockerLogs(): FakeDockerLogs {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-lane2419-docker-'));
  const script = join(dir, 'docker');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `printf '%s%s' '${CONTAINER_STDOUT_TOKEN}' "$*"`,
      `printf '%s' '${CONTAINER_STDERR_TOKEN}' 1>&2`,
      'exec sleep 30',
      '',
    ].join('\n')
  );
  chmodSync(script, 0o755);
  const before = process.env['CDK_DOCKER'];
  process.env['CDK_DOCKER'] = script;
  return {
    restore(): void {
      if (before === undefined) delete process.env['CDK_DOCKER'];
      else process.env['CDK_DOCKER'] = before;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Resolve once `seen()` holds both tokens, whichever stream they reached;
 * reject after `timeoutMs`. Waiting on DELIVERY rather than on a sleep keeps a
 * loaded host from turning a routing assertion into a timing one.
 */
export async function waitForContainerOutput(
  seen: () => string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = seen();
    if (text.includes(CONTAINER_STDOUT_TOKEN) && text.includes(CONTAINER_STDERR_TOKEN)) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`fake container output never arrived; saw: ${JSON.stringify(seen())}`);
}
