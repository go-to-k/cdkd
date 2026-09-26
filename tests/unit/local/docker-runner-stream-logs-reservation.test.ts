import { afterEach, beforeEach, describe, expect, it } from 'vite-plus/test';
import { streamLogs } from '../../../src/local/docker-runner.js';
import { releaseStdoutForPayload, reserveStdoutForPayload } from '../../../src/utils/logger.js';
import {
  CONTAINER_STDERR_TOKEN,
  CONTAINER_STDOUT_TOKEN,
  installFakeDockerLogs,
  waitForContainerOutput,
  type FakeDockerLogs,
} from '../_fake-docker-logs.js';

/**
 * Issue [#2419](https://github.com/go-to-k/cdkd/issues/2419): `streamLogs`
 * pipes a CONTAINER's stdout into ours. On `cdkd local invoke` /
 * `local invoke-agentcore`, which reserve stdout for the response, the Lambda
 * RIE puts `START` / `END` / `REPORT` and every handler log line there, so
 * `cdkd local invoke X | jq` read log lines ahead of the JSON. The container's
 * stdout now follows the payload reservation, the same way `spawnStreaming`
 * routes its mirror; the long-running servers behind `container-pool.ts`
 * reserve nothing, so their stdout — the human log surface — is unchanged.
 *
 * Both reservation states are driven, because each is a contract: reserved,
 * nothing reaches stdout; unreserved, the old routing holds byte-for-byte.
 * The container's own STDERR is asserted in both, since a fix that moved it
 * would be just as wrong in the other direction.
 */

const EXPECTED_STDOUT = `${CONTAINER_STDOUT_TOKEN}logs -f cdkd-lane2419-container`;

interface Captured {
  ourStdout: string;
  ourStderr: string;
}

async function captureStreamLogs(): Promise<Captured> {
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

  const stop = streamLogs('cdkd-lane2419-container');
  try {
    await waitForContainerOutput(() => out.join('') + err.join(''));
  } finally {
    stop();
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  return { ourStdout: out.join(''), ourStderr: err.join('') };
}

describe("streamLogs routes the container's stdout by the payload reservation (issue #2419)", () => {
  const itPosix = process.platform === 'win32' ? it.skip : it;
  let fake: FakeDockerLogs;

  beforeEach(() => {
    releaseStdoutForPayload();
    fake = installFakeDockerLogs();
  });

  afterEach(() => {
    fake.restore();
    releaseStdoutForPayload();
  });

  itPosix(
    "puts the container's stdout on OUR stdout when nothing is reserved (the servers)",
    async () => {
      const { ourStdout, ourStderr } = await captureStreamLogs();

      expect(ourStdout).toBe(EXPECTED_STDOUT);
      expect(ourStderr).toBe(CONTAINER_STDERR_TOKEN);
    }
  );

  itPosix(
    "moves the container's stdout to OUR stderr while a command holds the reservation",
    async () => {
      reserveStdoutForPayload();

      const { ourStdout, ourStderr } = await captureStreamLogs();

      // Byte-exact, so a partial mirror (a first chunk on stdout) reds too.
      expect(ourStdout).toBe('');
      // MOVED, not dropped. The two arrive on separate pipes, so their order
      // on our stderr is a scheduling detail — accept either.
      expect([
        `${EXPECTED_STDOUT}${CONTAINER_STDERR_TOKEN}`,
        `${CONTAINER_STDERR_TOKEN}${EXPECTED_STDOUT}`,
      ]).toContain(ourStderr);
    }
  );
});
