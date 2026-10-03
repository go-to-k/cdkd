import { afterEach, describe, expect, it } from 'vite-plus/test';
import {
  flushStdio,
  followContainerLogs,
  killAndDrainContainerLogs,
  killContainer,
} from '../../../src/local/docker-runner.js';
import { releaseStdoutForPayload } from '../../../src/utils/logger.js';
import {
  CONTAINER_LATE_TOKEN,
  CONTAINER_STDERR_TOKEN,
  installFakeDockerLogs,
  waitForContainerOutput,
  type FakeDockerLogs,
} from '../_fake-docker-logs.js';

/**
 * Issue [#4480](https://github.com/go-to-k/cdkd/issues/4480): `docker logs -f`
 * receives a container's output with a lag that grows under host load, so a
 * teardown that SIGTERMs the follower as soon as the request returns drops
 * the handler's last lines. `killAndDrainContainerLogs` stops the container
 * and waits for the follower to end on its own. The fake `docker`
 * (`tests/unit/_fake-docker-logs.ts`) relays {@link CONTAINER_LATE_TOKEN} only
 * after `docker kill`, which is that lag.
 */

interface Capture {
  text(): string;
  restore(): void;
}

function captureOutput(): Capture {
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const sink = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  return {
    text: () => chunks.join(''),
    restore: () => {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

const itPosix = process.platform === 'win32' ? it.skip : it;

describe('container log drain (issue #4480)', () => {
  let fake: FakeDockerLogs | undefined;

  afterEach(() => {
    fake?.restore();
    fake = undefined;
    releaseStdoutForPayload();
  });

  itPosix('kill-then-drain relays the line the follower receives after the stop', async () => {
    fake = installFakeDockerLogs();
    const out = captureOutput();
    let drained: boolean | undefined;
    try {
      const stream = followContainerLogs('cdkd-lane4480-container');
      await waitForContainerOutput(out.text);
      const drain = stream.drain.bind(stream);
      stream.drain = async (ms: number): Promise<boolean> => {
        drained = await drain(ms);
        return drained;
      };
      await killAndDrainContainerLogs('cdkd-lane4480-container', stream, 10_000);
    } finally {
      out.restore();
    }

    expect(out.text()).toContain(`${CONTAINER_LATE_TOKEN}:cdkd-lane4480-container`);
    expect(drained).toBe(true);
  }, 20_000);

  // The contrast that makes the case above mean something: the pre-#4480
  // teardown SIGTERMed the follower FIRST, so when the container then stops
  // (the kill below), nothing is left to relay its last line.
  itPosix('stop() before the container stops drops the line relayed after it', async () => {
    fake = installFakeDockerLogs();
    const out = captureOutput();
    let closedAfterStop: boolean | undefined;
    try {
      const stream = followContainerLogs('cdkd-lane4480-container');
      await waitForContainerOutput(out.text);
      stream.stop();
      // The follower closed because of the SIGTERM, not a timeout...
      closedAfterStop = await stream.drain(10_000);
      // ...so a container stop now has no follower left to relay through.
      await killContainer('cdkd-lane4480-container');
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      out.restore();
    }

    expect(closedAfterStop).toBe(true);
    expect(out.text()).toContain(CONTAINER_STDERR_TOKEN);
    expect(out.text()).not.toContain(CONTAINER_LATE_TOKEN);
  }, 20_000);

  itPosix('docker kill is bounded when the daemon hangs', async () => {
    fake = installFakeDockerLogs({ killHangs: true });
    const started = Date.now();
    await killContainer('cdkd-lane4480-container', 300);
    // Well under the fake's 30 s sleep: the timeout ended it.
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 20_000);

  // `docker kill` exits non-zero for a container that already stopped on its
  // own ("is not running"); that must not skip the drain.
  itPosix('a failing docker kill still drains the follower', async () => {
    fake = installFakeDockerLogs({ killFails: true });
    const out = captureOutput();
    try {
      const stream = followContainerLogs('cdkd-lane4480-container');
      await waitForContainerOutput(out.text);
      await killAndDrainContainerLogs('cdkd-lane4480-container', stream, 10_000);
    } finally {
      out.restore();
    }

    expect(out.text()).toContain(`${CONTAINER_LATE_TOKEN}:cdkd-lane4480-container`);
  }, 20_000);

  itPosix('drain is bounded: a follower that never ends is stopped at the timeout', async () => {
    fake = installFakeDockerLogs({ neverEnds: true });
    const out = captureOutput();
    let drained: boolean | undefined;
    let elapsedMs = 0;
    let closedAfter: boolean | undefined;
    try {
      const stream = followContainerLogs('cdkd-lane4480-container');
      await waitForContainerOutput(out.text);
      const started = Date.now();
      drained = await stream.drain(200);
      elapsedMs = Date.now() - started;
      // ...and the timeout STOPPED it: it now closes promptly on its own.
      closedAfter = await stream.drain(10_000);
    } finally {
      out.restore();
    }

    expect(drained).toBe(false);
    // Well under the fake's 30 s sleep: the timeout, not the follower, ended it.
    expect(elapsedMs).toBeLessThan(10_000);
    expect(closedAfter).toBe(true);
  }, 20_000);

  it('flushStdio resolves once the writes queued on BOTH streams are handed off', async () => {
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const flushed: string[] = [];
    const deferred =
      (name: string, delayMs: number) =>
      (_chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
        const cb = rest.find((a): a is () => void => typeof a === 'function');
        setTimeout(() => {
          flushed.push(name);
          cb?.();
        }, delayMs);
        return false;
      };
    process.stdout.write = deferred('stdout', 40) as typeof process.stdout.write;
    process.stderr.write = deferred('stderr', 10) as typeof process.stderr.write;
    try {
      await flushStdio(10_000);
    } finally {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    expect(flushed.sort()).toEqual(['stderr', 'stdout']);
  });

  it('flushStdio is bounded when a write never completes', async () => {
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((): boolean => false) as typeof process.stderr.write;
    const started = Date.now();
    try {
      await flushStdio(50);
    } finally {
      process.stderr.write = origErr;
    }
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
