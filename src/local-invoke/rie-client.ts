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
 * Wait until RIE is ready to handle invokes on `host:port`. Returns once
 * a real HTTP probe succeeds; throws after `timeoutMs`.
 *
 * **Why HTTP and not TCP**: Docker's userland port forwarder accepts TCP
 * connections from the host as soon as `docker run -p` binds the port,
 * which is BEFORE the container's RIE process has actually started its
 * own HTTP listener. A TCP-only probe declares "ready" prematurely and
 * the very first `invokeRie` call lands during the gap with
 * `TypeError: fetch failed` (ECONNRESET on the unfinished HTTP socket).
 * The race is more pronounced on the Python base image than on the
 * Node.js one (the rapid layer's bootstrap path is longer for Python),
 * but it exists for both — see PR 4 of #224 for the failing-Node
 * reproducer that prompted the upgrade.
 *
 * The HTTP probe issues `POST /` with an empty body and treats every
 * server response (including 4xx — RIE answers 404 to unknown paths) as
 * "ready". Connect/reset/abort failures are treated as "not ready yet"
 * and retried; any other class of error (e.g. DNS failure) propagates
 * immediately — there's nothing to retry past.
 *
 * RIE is fast to start (<1s in practice) but the container's overall
 * boot can be slower on a cold daemon — 5s is the spec's recommended
 * window. We poll cheap (every 100ms) so the typical case is sub-second.
 */
export async function waitForRieReady(host: string, port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const ok = await httpProbe(host, port, 500);
      if (ok) return;
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
 * Issue a tiny HTTP request to confirm RIE's HTTP listener is up (not
 * just the TCP forwarder Docker-side). Resolves `true` on any HTTP
 * response, `false` on connect / reset / abort. Other failure classes
 * (DNS, etc.) propagate so the caller can decide whether to retry.
 */
async function httpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // POST / instead of GET / so we exercise the same verb as the real
    // invoke; some HTTP stacks have separate readiness for read-only vs
    // write methods. Body is a tiny empty JSON object so we don't pay
    // a content-length parse on the way through.
    const response = await fetch(`http://${host}:${port}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
      signal: controller.signal,
    });
    // Drain the body so the underlying socket is released back to the
    // pool. We don't care about the content — any response means RIE
    // is up.
    await response.text().catch(() => undefined);
    return true;
  } catch (err) {
    if (isTransientNetworkError(err)) return false;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `fetch()` failures during container boot manifest as a generic
 * `TypeError: fetch failed` whose `.cause` carries the underlying
 * Node `ECONNRESET` / `ECONNREFUSED` / `UND_ERR_SOCKET`. Treat all of
 * those as "not ready, try again" so the readiness loop covers the gap
 * between Docker's port forwarder accepting a TCP connection and the
 * container's RIE process being ready for HTTP.
 */
function isTransientNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === 'AbortError') return true;
  if (err.name === 'TypeError' && err.message === 'fetch failed') return true;
  const cause = (err as { cause?: { code?: string } }).cause;
  if (cause?.code === 'ECONNRESET') return true;
  if (cause?.code === 'ECONNREFUSED') return true;
  if (cause?.code === 'UND_ERR_SOCKET') return true;
  return false;
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
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });
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
