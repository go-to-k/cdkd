import { setTimeout as delay } from 'node:timers/promises';

/**
 * HTTP client for the AWS Lambda Runtime Interface Emulator (RIE) baked
 * into the Lambda base images.
 *
 * RIE listens on `:8080` inside the container and exposes the same
 * Invoke endpoint the real Lambda runtime uses:
 *
 *   POST /2015-03-31/functions/function/invocations
 *
 * The response body is the handler's return value (or the error
 * structure if the handler threw). HTTP status is 200 in both cases —
 * mirroring the real AWS API. The caller treats both as exit code 0
 * (per the issue's exit-code semantics).
 */

const INVOKE_PATH = '/2015-03-31/functions/function/invocations';

export interface InvokeResult {
  /** Parsed JSON response when the body is valid JSON, else the raw string. */
  payload: unknown;
  /** Raw response body (for logging / verbose output). */
  raw: string;
}

/**
 * Wait until RIE accepts connections on `host:port`. Returns once a
 * single TCP connect succeeds; throws after `timeoutMs`.
 *
 * RIE is fast to start (<1s in practice) but the container's overall
 * boot can be slower on a cold daemon — 5s is the spec's recommended
 * window. We poll cheap (every 100ms) so the typical case is sub-second.
 *
 * After the TCP probe succeeds, sleep a short post-ready settle window
 * before returning. RIE's TCP listener comes up before its HTTP handler
 * is fully wired in some cold-start cases; without the settle, the
 * caller's `fetch(/2015-03-31/...)` races against RIE and hits
 * `TypeError: fetch failed` (intermittent on slow / loaded dockers).
 * 250ms is empirically sufficient and is cheap for the common case.
 */
export async function waitForRieReady(host: string, port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const ok = await tcpProbe(host, port, 500);
      if (ok) {
        // Post-ready settle — see docstring above.
        await delay(250);
        return;
      }
    } catch (err) {
      lastError = err;
    }
    await delay(100);
  }

  const tail = lastError instanceof Error ? `: ${lastError.message}` : '';
  throw new Error(
    `RIE did not become ready on ${host}:${port} within ${timeoutMs}ms${tail}. ` +
      `The container may have exited early — check 'docker logs' output.`
  );
}

/**
 * POST the event payload to RIE. The container CMD has already named the
 * handler, so the request URL is fixed.
 *
 * `timeoutMs` defaults to the function's `Timeout` * 2 (with a floor of
 * 30s) so a slow handler doesn't hang the CLI forever, but still has
 * room past the function's nominal timeout — RIE itself doesn't enforce
 * the timeout in v1, but it's the right ballpark.
 */
export async function invokeRie(
  host: string,
  port: number,
  event: unknown,
  timeoutMs: number
): Promise<InvokeResult> {
  const url = `http://${host}:${port}${INVOKE_PATH}`;
  const body = JSON.stringify(event ?? {});

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchWithStartupRetry(url, body, controller.signal);
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error(
        `RIE invoke at ${url} timed out after ${timeoutMs}ms. The handler may be hung; check container logs.`
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let payload: unknown = raw;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Non-JSON body — surface it as-is. The Lambda runtime always
    // emits JSON for valid handler returns, but a misconfigured
    // container could return plain text and we should not crash.
  }
  return { payload, raw };
}

/**
 * Wrap a single POST against RIE in a tiny startup-retry loop. RIE's
 * TCP listener can be up (so `waitForRieReady`'s TCP probe returns
 * success) before its HTTP handler is fully wired, especially on cold
 * dockers. The race manifests as Node's `TypeError: fetch failed` (a
 * pre-response, connection-level error with no HTTP status). We retry
 * twice with a 200ms backoff — same total cost as a slightly longer
 * post-ready settle, but only paid when the race actually triggers.
 *
 * Once a real HTTP response (any status) is observed, we return it
 * unchanged: the handler may have legitimately failed, and that's not
 * something we should retry. Abort errors propagate immediately so the
 * outer timeout still wins.
 */
async function fetchWithStartupRetry(
  url: string,
  body: string,
  signal: AbortSignal
): Promise<Response> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal,
      });
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'AbortError') throw err;
      lastError = err;
      if (attempt === maxAttempts) break;
      await delay(200);
    }
  }
  throw lastError;
}

/**
 * Best-effort TCP probe. Resolves `true` on connect, `false` on refused.
 * Errors other than ECONNREFUSED propagate so the caller can decide
 * whether to retry.
 */
async function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const { Socket } = await import('node:net');
  return new Promise<boolean>((resolveProbe, rejectProbe) => {
    const socket = new Socket();
    const cleanup = (): void => {
      socket.removeAllListeners();
      socket.destroy();
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      cleanup();
      resolveProbe(true);
    });
    socket.once('timeout', () => {
      cleanup();
      resolveProbe(false);
    });
    socket.once('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      if (err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET') {
        resolveProbe(false);
        return;
      }
      rejectProbe(err);
    });
    socket.connect(port, host);
  });
}
