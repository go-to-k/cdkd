import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import type { LogLevel } from '../../../src/types/config.js';
import { spawnStreaming, type SpawnResult } from '../../../src/utils/docker-cmd.js';
import {
  getLogger,
  releaseStdoutForPayload,
  reserveStdoutForPayload,
} from '../../../src/utils/logger.js';

/**
 * Issue [#2410](https://github.com/go-to-k/cdkd/issues/2410), the leak the
 * reservation did NOT close on its own: `spawnStreaming`
 * (`src/utils/docker-cmd.ts`) mirrors a CHILD process's stdout live when
 * `streamLive` is on, and that write never passes through `ConsoleLogger`, so
 * `ConsoleLogger.emit`'s routing cannot reach it. `streamLive` defaults to
 * "the logger is at debug level", i.e. `--verbose` — so on a command that has
 * reserved stdout for its payload, `--verbose` alone reopened the hole:
 * `cdkd local invoke Stack/ImageFn --no-pull --verbose` reaches
 * `src/local/ecr-puller.ts`'s `docker image inspect` through
 * `runDockerStreaming` and put a multi-hundred-line inspect array — including
 * the image's baked-in `Config.Env` — on the payload stream. The child's
 * stdout is DIAGNOSTIC output in every one of cdkd's call sites (pull / build
 * progress, `docker login`'s `Login Succeeded`, `docker image inspect`'s
 * JSON), never the calling command's payload, so under a reservation it joins
 * the logger on stderr.
 *
 * REAL child processes, not a mocked `spawn`, for the reason the sibling
 * `tests/unit/utils/docker-cmd.test.ts` already gives for its streaming
 * cases: what is under test is which of OUR fds a chunk arriving on a pipe is
 * mirrored to, and a fake `spawn` would let the test assert the mirroring of
 * bytes no OS pipe ever carried. `/bin/sh` writing to both fds is the
 * smallest thing that produces the real event sequence.
 *
 * Four things are asserted per case rather than just the routing, because
 * three of them are what a fix could break while the routing assertion stayed
 * green:
 *  - the child's stdout reaches the RIGHT one of our two streams;
 *  - the child's STDERR is unaffected — it was always ours-stderr and the
 *    reservation must not make it a payload;
 *  - {@link SpawnResult} still carries BOTH captured streams byte-exact. The
 *    mirroring is a side channel; every caller (`ecr-puller.ts`'s inspect
 *    parse, the `SpawnError` message) reads the RETURN value, so a fix that
 *    routed the capture instead of the mirror would break them silently;
 *  - `streamLive: false` still silences the mirror on both streams, in both
 *    reservation states.
 */

const OUT_TOKEN = 'lane2410-child-stdout-token';
const ERR_TOKEN = 'lane2410-child-stderr-token';

/** Writes one token to each fd — the smallest child that exercises both pipes. */
const BOTH_STREAMS_ARGV = ['-c', `printf %s '${OUT_TOKEN}'; printf %s '${ERR_TOKEN}' 1>&2`];

interface Captured {
  /** What reached OUR fd 1. */
  ourStdout: string;
  /** What reached OUR fd 2. */
  ourStderr: string;
  /** What `spawnStreaming` returned to its caller. */
  result: SpawnResult;
}

/**
 * Run `body` with `process.stdout.write` / `process.stderr.write` diverted
 * into two buffers. Deliberately NOT a `console` spy: the writer under test is
 * a raw `stream.write(chunk)` with a Buffer, which no `console` method sees.
 */
async function capture(body: () => Promise<SpawnResult>): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8'));
    return true;
  }) as typeof process.stderr.write;

  try {
    const result = await body();
    return { ourStdout: out.join(''), ourStderr: err.join(''), result };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe("spawnStreaming routes a child's live stdout by the reservation (issue #2410)", () => {
  // Same guard as the streaming cases in `tests/unit/utils/docker-cmd.test.ts`:
  // these spawn `/bin/sh`, so they are POSIX-only.
  const itPosix = process.platform === 'win32' ? it.skip : it;
  let levelBefore: LogLevel;

  beforeEach(() => {
    levelBefore = getLogger().getLevel();
    releaseStdoutForPayload();
  });

  afterEach(() => {
    releaseStdoutForPayload();
    getLogger().setLevel(levelBefore);
  });

  itPosix('mirrors the child stdout to OUR stdout when nothing is reserved', async () => {
    const { ourStdout, ourStderr, result } = await capture(() =>
      spawnStreaming('/bin/sh', BOTH_STREAMS_ARGV, { streamLive: true })
    );

    expect(ourStdout).toBe(OUT_TOKEN);
    expect(ourStderr).toBe(ERR_TOKEN);
    expect(result).toEqual({ stdout: OUT_TOKEN, stderr: ERR_TOKEN });
  });

  itPosix('mirrors the child stdout to OUR STDERR while a command holds the reservation', async () => {
    reserveStdoutForPayload();

    const { ourStdout, ourStderr, result } = await capture(() =>
      spawnStreaming('/bin/sh', BOTH_STREAMS_ARGV, { streamLive: true })
    );

    // The whole point: nothing of the child's diagnostic output on the
    // payload stream. Byte-exact `toBe('')` rather than `not.toContain`, so a
    // partial mirror (a first chunk on stdout, the rest on stderr) reds too.
    expect(ourStdout).toBe('');
    // MOVED, not dropped — `--verbose` still shows the operator what it asked
    // for, and the child's own stderr is still there beside it.
    expect(ourStderr).toBe(`${OUT_TOKEN}${ERR_TOKEN}`);

    // ...and what the CALLER reads is byte-identical to the unreserved run.
    // `ecr-puller.ts` parses `result.stdout` as JSON; routing the mirror must
    // not touch the capture.
    expect(result).toEqual({ stdout: OUT_TOKEN, stderr: ERR_TOKEN });
  });

  itPosix('routes by the reservation on the DEFAULT streamLive, which is `--verbose`', async () => {
    // The production trigger: no explicit `streamLive`, just a debug-level
    // logger — exactly what `--verbose` produces, and the shape the
    // `ecr-puller.ts` leak took. A fix keyed on an explicit `streamLive: true`
    // would leave this green while the real path stayed broken.
    getLogger().setLevel('debug');
    reserveStdoutForPayload();

    const { ourStdout, ourStderr, result } = await capture(() =>
      spawnStreaming('/bin/sh', BOTH_STREAMS_ARGV)
    );

    expect(ourStdout).toBe('');
    expect(ourStderr).toBe(`${OUT_TOKEN}${ERR_TOKEN}`);
    expect(result).toEqual({ stdout: OUT_TOKEN, stderr: ERR_TOKEN });
  });

  itPosix('mirrors to OUR stdout on the default streamLive when nothing is reserved', async () => {
    // The counter-case to the one above, and the one that pins that the
    // routing is decided by the RESERVATION and not by the log level: same
    // `--verbose` default, no reservation, byte-identical to the old behavior.
    getLogger().setLevel('debug');

    const { ourStdout, ourStderr, result } = await capture(() =>
      spawnStreaming('/bin/sh', BOTH_STREAMS_ARGV)
    );

    expect(ourStdout).toBe(OUT_TOKEN);
    expect(ourStderr).toBe(ERR_TOKEN);
    expect(result).toEqual({ stdout: OUT_TOKEN, stderr: ERR_TOKEN });
  });

  itPosix('streamLive:false still silences BOTH streams, reserved or not', async () => {
    for (const reserved of [false, true]) {
      releaseStdoutForPayload();
      if (reserved) reserveStdoutForPayload();

      const { ourStdout, ourStderr, result } = await capture(() =>
        spawnStreaming('/bin/sh', BOTH_STREAMS_ARGV, { streamLive: false })
      );

      expect(ourStdout, `reserved=${reserved}`).toBe('');
      expect(ourStderr, `reserved=${reserved}`).toBe('');
      // Silenced on the wire, still captured for the caller.
      expect(result, `reserved=${reserved}`).toEqual({ stdout: OUT_TOKEN, stderr: ERR_TOKEN });
    }
  });

  itPosix('a failing child still carries both streams on the SpawnError while reserved', async () => {
    // The error path reads the same two buffers the success path returns, so
    // the capture-vs-mirror split has to hold there too: a reserved run whose
    // child exits non-zero must still put the child's stdout in
    // `err.stdout` — `spawnStreaming` falls back to it for the message when
    // stderr is empty.
    reserveStdoutForPayload();

    let caught: unknown;
    const { ourStdout, ourStderr } = await capture(async () => {
      try {
        return await spawnStreaming('/bin/sh', ['-c', `printf %s '${OUT_TOKEN}'; exit 3`], {
          streamLive: true,
        });
      } catch (err) {
        caught = err;
        return { stdout: '', stderr: '' };
      }
    });

    const spawnError = caught as { stdout: string; stderr: string; exitCode: number | null };
    expect(spawnError.stdout).toBe(OUT_TOKEN);
    expect(spawnError.stderr).toBe('');
    expect(spawnError.exitCode).toBe(3);
    // The message falls back to the captured stdout, which is how the operator
    // sees WHY it failed — that must not be emptied by the routing either.
    expect((caught as Error).message).toBe(OUT_TOKEN);

    expect(ourStdout).toBe('');
    expect(ourStderr).toBe(OUT_TOKEN);
  });
});
