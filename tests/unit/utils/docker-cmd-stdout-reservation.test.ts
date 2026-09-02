import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { spawn } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * Four things are asserted rather than just the routing, because the other
 * three are what a fix could break while the routing assertion stayed green.
 * Where each is asserted differs, so it is stated per bullet rather than
 * claimed for every case:
 *  - the child's stdout reaches the RIGHT one of our two streams — every
 *    case;
 *  - the child's STDERR is unaffected — it was always ours-stderr and the
 *    reservation must not make it a payload. Every case whose child writes to
 *    both fds, i.e. all but the failing-child one, whose child writes only to
 *    stdout before exiting non-zero;
 *  - the CAPTURE still carries both streams byte-exact — every case, as the
 *    returned {@link SpawnResult}, or as the `SpawnError`'s two buffers on
 *    the failure path, which is the same capture read from the other end. The
 *    mirroring is a side channel; every caller (`ecr-puller.ts`'s inspect
 *    parse, the `SpawnError` message) reads the capture, so a fix that routed
 *    the capture instead of the mirror would break them silently;
 *  - `streamLive: false` still silences the mirror on both streams, in both
 *    reservation states — its OWN case, since its subject is the mirror being
 *    off.
 *
 * `spawnForeground`'s half of the same fix — `'inherit'` on fd 1 hands the
 * child OUR payload stream outright — is fenced by the second `describe`
 * below, which needs a child process of its own to observe.
 */

const OUT_TOKEN = 'lane2410-child-stdout-token';
const ERR_TOKEN = 'lane2410-child-stderr-token';

/**
 * Both tokens, in EITHER order — the assertion for a run where the child's
 * stdout has been routed to join its stderr on OUR fd 2.
 *
 * The two arrive on SEPARATE OS pipes, so which `'data'` event the parent
 * sees first is a libuv scheduling detail no API guarantees; it was measured
 * at 300/300 stdout-first, which is an observation and not a contract.
 * Membership of this two-element set keeps everything the byte-exact `toBe`
 * bought — a dropped token, an extra byte, or a partial mirror that splits
 * one token around the other all still red — while not pinning an order the
 * platform never promised.
 */
const BOTH_TOKENS_EITHER_ORDER = [
  `${OUT_TOKEN}${ERR_TOKEN}`,
  `${ERR_TOKEN}${OUT_TOKEN}`,
];

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
    expect(BOTH_TOKENS_EITHER_ORDER).toContain(ourStderr);

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
    expect(BOTH_TOKENS_EITHER_ORDER).toContain(ourStderr);
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

/**
 * The SECOND half of the same fix, and the more reachable one:
 * `spawnForeground` (`src/utils/docker-cmd.ts`) spawns with `stdio:
 * 'inherit'`, which hands the child OUR fd 1 — the payload stream on a
 * command holding a reservation. `src/local/ecr-puller.ts` calls
 * `runDockerForeground(['pull', <uri>])` UNCONDITIONALLY, so
 * `cdkd local invoke Stack/ImageFn > out.json` put `docker pull` progress
 * into the payload with NO `--verbose` and no flag at all — where the
 * `spawnStreaming` leak above needed `--verbose` to open. Under a
 * reservation fd 1 is redirected to OUR fd 2 (`['inherit', 2, 'inherit']`)
 * rather than piped, so the child keeps a real terminal descriptor and
 * docker's progress bars still animate.
 *
 * WHY A CHILD OF OUR OWN. `'inherit'` hands over the PROCESS's file
 * descriptors, not its JS `process.stdout` object, so the `capture()` helper
 * above — which swaps `process.stdout.write` — cannot see this at all: it
 * would report an empty stdout under BOTH versions and pass for the wrong
 * reason. The only way to observe where the bytes land is to be a process
 * whose fd 1 and fd 2 are two things we can read back, so these cases spawn
 * a real `node` whose fd 1 and fd 2 are two separate FILES, let it call the
 * real `spawnForeground`, and then read the files. Asserting the `stdio`
 * array through a `spawn` spy was the cheaper alternative and was rejected:
 * it would pin the literal we wrote rather than the effect it has, and the
 * effect (`2` means "the PARENT's fd 2") is precisely the part that is easy
 * to get wrong.
 *
 * The probe imports `src/**` directly under node's native type stripping.
 * cdkd spells its relative imports `.js` (see CLAUDE.md), which node
 * resolves LITERALLY, so the probe installs a `module.registerHooks` resolve
 * hook that retries a non-existent `./x.js` as `./x.ts` — the same rewrite
 * `tsconfig.json`'s `rewriteRelativeImportExtensions` performs at emit time.
 *
 * RUNTIME REQUIREMENT, stated because it is stricter than `package.json`'s
 * `engines` and a reader will otherwise re-derive it from a failure: the
 * probe child needs default type stripping AND `module.registerHooks`, so it
 * needs Node >= 24. That is the repo's pinned dev/CI runtime (`.node-version`
 * 24.15.0, managed by Vite+ / mise), and the same assumption every
 * `node scripts/*.ts` invocation in this repo already makes; `engines`'
 * `>= 20` bounds what cdkd's USERS need, not what building it needs. On an
 * older runner the failure is self-diagnosing — the probe's own stderr is
 * printed in the assertion message.
 */
const FOREGROUND_PROBE_SOURCE = `
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// cdkd's source spells relative imports '.js'; node resolves that literally.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      specifier.endsWith('.js') &&
      context.parentURL
    ) {
      const asFile = fileURLToPath(new URL(specifier, context.parentURL));
      if (!existsSync(asFile)) return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});

const [dockerCmdUrl, loggerUrl, mode] = process.argv.slice(2);
const { spawnForeground } = await import(dockerCmdUrl);
const { reserveStdoutForPayload } = await import(loggerUrl);
if (mode === 'reserved') reserveStdoutForPayload();
// One token to each of the GRANDCHILD's fds. Both are inherited descriptors,
// so where they land is decided entirely by the stdio array under test.
await spawnForeground('/bin/sh', [
  '-c',
  "printf %s '${OUT_TOKEN}'; printf %s '${ERR_TOKEN}' 1>&2",
]);
`;

interface ForegroundProbe {
  /** Everything written to the probe process's fd 1. */
  fd1: string;
  /** Everything written to the probe process's fd 2. */
  fd2: string;
  /** The probe's exit code — non-zero means the probe itself failed. */
  code: number | null;
}

/**
 * Run {@link FOREGROUND_PROBE_SOURCE} as a real child whose fd 1 and fd 2 are
 * two separate files, and return what each one received.
 */
async function runForegroundProbe(mode: 'plain' | 'reserved'): Promise<ForegroundProbe> {
  const dir = mkdtempSync(join(tmpdir(), 'cdkd-2410-foreground-'));
  try {
    const script = join(dir, 'probe.mjs');
    writeFileSync(script, FOREGROUND_PROBE_SOURCE, 'utf-8');
    const fd1Path = join(dir, 'fd1.txt');
    const fd2Path = join(dir, 'fd2.txt');
    const fd1 = openSync(fd1Path, 'w');
    const fd2 = openSync(fd2Path, 'w');
    try {
      const code = await new Promise<number | null>((resolvePromise, reject) => {
        const child = spawn(
          process.execPath,
          [
            script,
            new URL('../../../src/utils/docker-cmd.ts', import.meta.url).href,
            new URL('../../../src/utils/logger.ts', import.meta.url).href,
            mode,
          ],
          // The probe's OWN fds 1 and 2 are these two files. Everything the
          // stdio array under test does with 'inherit' / 2 lands in one of them.
          { stdio: ['ignore', fd1, fd2] }
        );
        child.once('error', reject);
        child.once('close', (exitCode) => resolvePromise(exitCode));
      });
      return { fd1: readFileSync(fd1Path, 'utf-8'), fd2: readFileSync(fd2Path, 'utf-8'), code };
    } finally {
      closeSync(fd1);
      closeSync(fd2);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("spawnForeground routes the child's INHERITED fd 1 by the reservation (issue #2410)", () => {
  // `/bin/sh` again, plus a `node` child: POSIX-only, same as the sibling above.
  const itPosix = process.platform === 'win32' ? it.skip : it;

  itPosix(
    'hands the child OUR fd 1 when nothing is reserved',
    async () => {
      const { fd1, fd2, code } = await runForegroundProbe('plain');

      // A non-zero code means the probe failed to load, which would make the
      // stream assertions below pass vacuously on two empty files. Its fd 2
      // carries the reason (a node stack trace), so surface it rather than
      // reporting a bare `expected 1 to be 0`.
      expect(code, `probe exited non-zero; its fd 2 said: ${fd2}`).toBe(0);
      expect(fd1).toBe(OUT_TOKEN);
      expect(fd2).toBe(ERR_TOKEN);
    },
    30_000
  );

  itPosix(
    "redirects the child's fd 1 onto OUR fd 2 while a command holds the reservation",
    async () => {
      const { fd1, fd2, code } = await runForegroundProbe('reserved');

      expect(code, `probe exited non-zero; its fd 2 said: ${fd2}`).toBe(0);
      // The whole point: `docker pull` progress never reaches the payload
      // stream, with no `--verbose` involved on either side.
      expect(fd1).toBe('');
      // MOVED, not dropped — and byte-exact here, unlike the pipe-mirroring
      // sibling above: both of the grandchild's descriptors are dups of the
      // SAME open file description, so they share one file offset and the
      // shell's two sequential `printf`s append in source order. There is no
      // second pipe whose delivery could be reordered.
      expect(fd2).toBe(`${OUT_TOKEN}${ERR_TOKEN}`);
    },
    30_000
  );
});
