import { Readable } from 'node:stream';
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
 *
 * After the HTTP probe succeeds, sleep a short post-ready settle window
 * before returning. Even when RIE answered an HTTP status, the very next
 * `fetch(/2015-03-31/...)` from the caller has been observed to race
 * against RIE on cold-loaded dockers and hit `TypeError: fetch failed`
 * (intermittent on slow / loaded daemons). 250ms is empirically
 * sufficient and is cheap for the common case; the `fetchWithStartupRetry`
 * helper inside `invokeRie` is the second line of defense for the case
 * where 250ms isn't enough.
 */
export async function waitForRieReady(host: string, port: number, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const ok = await httpProbe(host, port, 500);
      if (ok) {
        // Post-ready settle — see docstring above. Defense-in-depth on top
        // of the HTTP probe: even after a real HTTP response, the very
        // next `fetch()` against RIE has been observed to race on cold
        // dockers; a short pause shrinks the window further.
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
 * Wrap a single POST against RIE in a tiny startup-retry loop. Even
 * after `waitForRieReady`'s HTTP probe has succeeded and the post-ready
 * settle has elapsed, the next `fetch()` has been observed to race
 * against RIE's HTTP handler on cold dockers. The race manifests as
 * Node's `TypeError: fetch failed` (a pre-response, connection-level
 * error with no HTTP status). We retry twice with a 200ms backoff —
 * cheap when the race doesn't trigger, decisive when it does.
 *
 * Once a real HTTP response (any status) is observed, we return it
 * unchanged: the handler may have legitimately failed, and that's not
 * something we should retry. Abort errors propagate immediately so the
 * outer timeout still wins.
 */
async function fetchWithStartupRetry(
  url: string,
  body: string,
  signal: AbortSignal,
  extraHeaders?: Record<string, string>
): Promise<Response> {
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
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
 * Parsed prelude metadata emitted by a streaming Lambda response.
 *
 * The Lambda runtime's streaming response format (verified empirically
 * against `public.ecr.aws/lambda/nodejs:20` RIE on 2026-05-22 for #467):
 *
 *   <JSON prelude bytes> <8 NULL bytes> <raw body bytes...>
 *
 * The prelude is a JSON object with `statusCode`, `headers`, and
 * (optionally) `cookies`, produced by the handler's call to
 * `awslambda.HttpResponseStream.from(stream, metadata)`. The body
 * is the bytes the handler subsequently `write`'d / piped into the
 * stream — no framing, no chunked-encoding markers, just raw bytes
 * that the HTTP layer can pipe straight through.
 */
export interface StreamingPrelude {
  /** Lambda-declared HTTP status. */
  statusCode: number;
  /** Lambda-declared response headers (case as emitted). */
  headers: Record<string, string>;
  /** Lambda-declared cookies (HTTP API v2 shape — each rendered as a separate Set-Cookie). */
  cookies?: string[];
}

/** Resolved streaming invocation result: parsed prelude + a Readable of the body chunks. */
export interface StreamingInvokeResult {
  prelude: StreamingPrelude;
  /**
   * The body stream — a Node `Readable` that emits the chunks the handler
   * streamed AFTER the prelude/separator. Pipe directly into a
   * `ServerResponse` with `Transfer-Encoding: chunked`.
   */
  body: Readable;
}

/**
 * The 8-NULL-byte separator AWS Lambda RIE writes between the JSON
 * metadata prelude and the streaming body chunks. Empirically verified
 * — see `StreamingPrelude` docstring above.
 */
const STREAM_PRELUDE_SEPARATOR = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]);

/**
 * Maximum bytes we'll buffer searching for the prelude separator before
 * giving up. 1 MiB is far past anything Lambda's streamifyResponse would
 * emit as metadata (typical preludes are <500 bytes) — a runaway here
 * indicates the handler didn't call `HttpResponseStream.from` at all, in
 * which case we want to fail fast rather than buffer the whole body.
 */
export const STREAM_PRELUDE_MAX_BYTES = 1024 * 1024;

/**
 * Maximum cumulative bytes of body the streaming Readable will push
 * before destroying itself with a clear error (defense-in-depth against
 * a buggy / malicious handler streaming gigabytes — Node's chunked-pipe
 * machinery handles per-chunk backpressure, but the running total can
 * still grow without bound on a slow consumer).
 *
 * 100 MiB is the default cap — generous enough that no realistic
 * dev-loop streaming response (token-by-token LLM output, large-file
 * download, video segment) hits it, low enough that a genuine runaway
 * surfaces locally before swap pressure kicks in. The HTTP server
 * converts the destroyed Readable to a truncated response (best-effort —
 * headers may already be on the wire).
 *
 * Consistent with {@link STREAM_PRELUDE_MAX_BYTES} (1 MiB cap on the
 * pre-body buffer); this is the post-body counterpart.
 */
export const STREAM_BODY_MAX_BYTES = 100 * 1024 * 1024;

/**
 * POST the event payload to RIE with the `streaming` response-mode
 * header, parse the JSON prelude out of the response bytes, and return
 * a Readable carrying the post-separator body chunks.
 *
 * Why a separate function from `invokeRie`: the prelude/separator/body
 * framing is incompatible with the buffered-response `text()` consumer.
 * Buffered routes still use `invokeRie`; only Function URLs with
 * `InvokeMode: RESPONSE_STREAM` use this path.
 *
 * The `Lambda-Runtime-Function-Response-Mode: streaming` request header
 * tells RIE we want the streaming protocol. (RIE happens to emit the
 * same protocol for `streamifyResponse`-wrapped handlers regardless of
 * the header, but setting it makes the contract explicit and survives
 * future RIE behavior changes.)
 *
 * **`timeoutMs` bounds the TOTAL wall time of the entire streaming
 * exchange**, NOT just the prelude wait — the single armed `setTimeout`
 * covers both the prelude arrival AND the body drain. Once it fires,
 * `controller.abort()` destroys the underlying Readable, so a
 * legitimately long-lived streaming handler (e.g. a 15-minute AI / LLM
 * proxy) will have its connection torn down mid-stream even though
 * bytes are arriving correctly. Callers MUST size `timeoutMs` to cover
 * the longest expected handler stream, NOT just the time to first byte.
 *
 * Convention: pass `lambda.Timeout * 2` with a 30-second floor — same
 * order-of-magnitude formula as `invokeRie`, but the absolute value
 * differs because streaming handlers can intentionally run for the full
 * Lambda timeout (default 15 minutes for streaming-capable functions).
 * Splitting the bound into a strict prelude timer + a per-chunk idle
 * timer that resets on each chunk is deferred to a follow-up — see
 * issue #503 item 1 for the design discussion.
 *
 * The body Readable is additionally guarded by {@link STREAM_BODY_MAX_BYTES}
 * (100 MiB by default) so a runaway handler can't blow host memory; the
 * Readable is destroyed with a clear error when the cap trips.
 */
export async function invokeRieStreaming(
  host: string,
  port: number,
  event: unknown,
  timeoutMs: number
): Promise<StreamingInvokeResult> {
  const url = `http://${host}:${port}${INVOKE_PATH}`;
  const body = JSON.stringify(event ?? {});

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchWithStartupRetry(url, body, controller.signal, {
      'Lambda-Runtime-Function-Response-Mode': 'streaming',
    });
  } catch (err) {
    clearTimeout(timer);
    if ((err as { name?: string }).name === 'AbortError') {
      throw new Error(
        `RIE streaming invoke at ${url} timed out after ${timeoutMs}ms. The handler may be hung; check container logs.`
      );
    }
    throw err;
  }

  if (!response.body) {
    clearTimeout(timer);
    throw new Error(`RIE streaming invoke at ${url} returned no response body.`);
  }

  // Split the response stream at the 8-NULL-byte separator: prelude
  // bytes accumulate in `preludeBuf`, then the remaining bytes (plus
  // the rest of the stream) become the returned body Readable.
  const reader = response.body.getReader();
  let preludeBytes = Buffer.alloc(0);
  let bodyTail: Buffer | undefined;
  let separatorIdx = -1;

  while (separatorIdx < 0) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    preludeBytes = Buffer.concat([preludeBytes, chunk]);
    separatorIdx = preludeBytes.indexOf(STREAM_PRELUDE_SEPARATOR);
    if (separatorIdx >= 0) {
      // Capture any body bytes already present in this chunk; everything
      // AFTER the separator belongs to the body.
      bodyTail = preludeBytes.subarray(separatorIdx + STREAM_PRELUDE_SEPARATOR.length);
      preludeBytes = preludeBytes.subarray(0, separatorIdx);
      break;
    }
    if (preludeBytes.length > STREAM_PRELUDE_MAX_BYTES) {
      clearTimeout(timer);
      reader.cancel().catch(() => undefined);
      throw new Error(
        `RIE streaming response did not emit the prelude/body separator within ${STREAM_PRELUDE_MAX_BYTES} bytes. ` +
          `The handler likely did not call awslambda.HttpResponseStream.from(stream, metadata).`
      );
    }
  }

  if (separatorIdx < 0) {
    clearTimeout(timer);
    throw new Error(
      `RIE streaming response ended before the prelude/body separator (got ${preludeBytes.length} bytes). ` +
        `The handler likely threw before streaming the prelude — check container logs.`
    );
  }

  let prelude: StreamingPrelude;
  try {
    prelude = parseStreamingPrelude(preludeBytes.toString('utf8'));
  } catch (err) {
    clearTimeout(timer);
    reader.cancel().catch(() => undefined);
    throw new Error(
      `RIE streaming response prelude is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  // Build a Readable that emits any already-buffered body bytes first,
  // then drains the remaining response stream until done. The timeout
  // is kept armed so a hung mid-body handler still aborts.
  const stream = new Readable({
    read() {
      // No-op — chunks are pushed by the IIFE below.
    },
  });

  // Track cumulative body bytes pushed into the Readable so we can
  // destroy the stream if it crosses the safety cap. See
  // STREAM_BODY_MAX_BYTES for the rationale.
  let bodyBytesPushed = 0;
  const exceedsCap = (added: number): boolean => {
    bodyBytesPushed += added;
    return bodyBytesPushed > STREAM_BODY_MAX_BYTES;
  };

  void (async () => {
    try {
      if (bodyTail && bodyTail.length > 0) {
        if (exceedsCap(bodyTail.length)) {
          reader.cancel().catch(() => undefined);
          stream.destroy(
            new Error(
              `RIE streaming body exceeded ${STREAM_BODY_MAX_BYTES} bytes — destroying stream.`
            )
          );
          return;
        }
        stream.push(bodyTail);
      }
      // Drain the rest. The reader has internal backpressure; pushing
      // into the Readable returns false on overflow but Node's pipe()
      // handles draining via the 'drain' event.
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        if (exceedsCap(chunk.length)) {
          reader.cancel().catch(() => undefined);
          stream.destroy(
            new Error(
              `RIE streaming body exceeded ${STREAM_BODY_MAX_BYTES} bytes — destroying stream.`
            )
          );
          return;
        }
        stream.push(chunk);
      }
      stream.push(null);
    } catch (err) {
      stream.destroy(err instanceof Error ? err : new Error(String(err)));
    } finally {
      clearTimeout(timer);
    }
  })();

  return { prelude, body: stream };
}

/**
 * Parse a streaming prelude payload (JSON text). Normalizes the shape
 * the http-server consumes: `statusCode` is coerced to a number (RIE
 * sometimes emits it as a string), `headers` is always an object (the
 * handler may omit it), `cookies` is preserved only when an array.
 *
 * Exported for unit tests. Throws on invalid JSON or a non-numeric
 * statusCode (cdkd cannot map that to HTTP).
 */
export function parseStreamingPrelude(text: string): StreamingPrelude {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error('empty prelude');
  }
  const raw = JSON.parse(trimmed) as unknown;
  if (!raw || typeof raw !== 'object') {
    throw new Error('prelude is not a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const statusRaw = obj['statusCode'];
  let statusCode: number;
  if (typeof statusRaw === 'number' && Number.isFinite(statusRaw)) {
    statusCode = Math.trunc(statusRaw);
  } else if (typeof statusRaw === 'string' && /^[0-9]+$/.test(statusRaw)) {
    statusCode = Number.parseInt(statusRaw, 10);
  } else {
    throw new Error(`statusCode must be a number (got ${typeof statusRaw})`);
  }

  const headers: Record<string, string> = {};
  const headersRaw = obj['headers'];
  if (headersRaw && typeof headersRaw === 'object') {
    for (const [k, v] of Object.entries(headersRaw as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      // AWS's documented shape is string/number/boolean scalars; map
      // everything else through JSON.stringify (defensive — a buggy
      // handler emitting an object would otherwise log `[object Object]`).
      if (typeof v === 'string') {
        headers[k] = v;
      } else if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
        headers[k] = String(v);
      } else {
        headers[k] = JSON.stringify(v) ?? '';
      }
    }
  }

  const result: StreamingPrelude = { statusCode, headers };
  const cookiesRaw = obj['cookies'];
  if (Array.isArray(cookiesRaw)) {
    result.cookies = cookiesRaw.map((c) => String(c));
  }
  return result;
}
