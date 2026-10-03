/**
 * A stand-in `docker` binary for driving the REAL `streamLogs` /
 * `followContainerLogs` (`src/local/docker-runner.ts`) through a real OS pipe —
 * issues [#2419](https://github.com/go-to-k/cdkd/issues/2419) and
 * [#4480](https://github.com/go-to-k/cdkd/issues/4480).
 *
 * `streamLogs` spawns `getDockerCmd() logs -f <id>`, and `getDockerCmd()`
 * honours `CDK_DOCKER`, so pointing that variable at this script is the whole
 * seam: nothing in production is mocked. `logs` writes one token to each of
 * its fds — the container-stdout token carries the argv it was given, so a
 * case can see the container id arrived — and then stays attached, the way
 * `docker logs -f` does, until either the caller kills it or the container
 * stops.
 *
 * The container stopping is modelled by `kill <id>`, which `killContainer`
 * runs: it leaves a per-container marker the attached `logs -f <id>` polls
 * for, and `logs` then relays ONE more token, `${CONTAINER_LATE_TOKEN}:<id>`,
 * before exiting. That is the shape of a loaded daemon (#4480): the
 * container's last line reaches the follower only after the request
 * returned, so a teardown that kills the follower without draining it never
 * prints that token. Every other subcommand (`rm`) exits 0.
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
/** What `logs` relays on its STDOUT only after `kill` stopped the container. */
export const CONTAINER_LATE_TOKEN = 'lane4480-container-late-line';

export interface FakeDockerLogs {
  /** Restore `CDK_DOCKER` and remove the script's directory. */
  restore(): void;
}

export interface FakeDockerLogsOptions {
  /**
   * `logs` never ends, even after `kill` — a follower the daemon never closes,
   * for the drain's timeout arm.
   */
  neverEnds?: boolean;
  /**
   * `kill` exits 1 the way docker does for a container that already stopped
   * on its own ("is not running") — the container is stopped all the same.
   */
  killFails?: boolean;
  /** `kill` never returns — a hung daemon. */
  killHangs?: boolean;
}

/** Install the fake as `CDK_DOCKER` until {@link FakeDockerLogs.restore}. */
export function installFakeDockerLogs(opts: FakeDockerLogsOptions = {}): FakeDockerLogs {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-lane2419-docker-'));
  const script = join(dir, 'docker');
  // `$3` is the id in `logs -f <id>`, `$2` the one in `kill <id>`.
  const killedMarker = (idVar: string): string => `${dir}/killed-${idVar}`;
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  logs)',
      `    printf '%s%s' '${CONTAINER_STDOUT_TOKEN}' "$*"`,
      `    printf '%s' '${CONTAINER_STDERR_TOKEN}' 1>&2`,
      opts.neverEnds === true
        ? '    exec sleep 30'
        : [
            '    i=0',
            `    while [ ! -f "${killedMarker('$3')}" ]; do`,
            '      sleep 0.02',
            '      i=$((i + 1))',
            '      [ "$i" -ge 1500 ] && exit 0',
            '    done',
            `    printf '%s:%s' '${CONTAINER_LATE_TOKEN}' "$3"`,
            '    exit 0',
          ].join('\n'),
      '    ;;',
      opts.killHangs === true
        ? `  kill) exec sleep 30 ;;`
        : opts.killFails === true
        ? `  kill) : > "${killedMarker('$2')}"; echo "Error: container $2 is not running" 1>&2; exit 1 ;;`
        : `  kill) : > "${killedMarker('$2')}" ;;`,
      'esac',
      'exit 0',
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
