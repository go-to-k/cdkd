/**
 * `IntegrationResponses[]` selection logic for `cdkd local start-api`'s
 * REST v1 non-AWS_PROXY integrations (#457).
 *
 * AWS API Gateway picks one `IntegrationResponses[]` entry per call to
 * shape the HTTP response. The rule (from AWS docs):
 *
 *   - AWS matches `SelectionPattern` (a regex) against a per-integration
 *     match target REGARDLESS of whether the backend returned success
 *     or error. The first regex-matching entry wins. The match target
 *     depends on the integration type:
 *       - Lambda: `errorMessage` field of the parsed return value, or
 *         the sentinel `'success'` when the payload has no errorMessage.
 *       - HTTP / HTTP_PROXY: the HTTP status code as a string
 *         (e.g. `'404'` / `'200'`).
 *     Falls back to the default entry (`SelectionPattern` undefined or
 *     `''`) when no regex matches. If no default exists either, the
 *     caller's `fallbackStatusCode` drives the response (200 / 500
 *     depending on outcome).
 *
 * Notes
 * -----
 *
 *   - AWS pre-compiles `SelectionPattern` as a regex with `^pattern$`
 *     anchoring. cdkd matches that — `'.*Not Found.*'` works against
 *     errorMessage values containing "Not Found", but a bare
 *     `'Not Found'` only matches the literal string.
 *   - The `StatusCode` field on the selected entry drives the HTTP
 *     response status. AWS stores it as a string; cdkd parses to int.
 *   - `IntegrationResponses` is OPTIONAL on AWS — when absent for a non-
 *     AWS_PROXY integration, AWS returns the backend response as-is
 *     (with `application/json` for Lambda success). cdkd mirrors this.
 *   - PR #505 review fix 14: an earlier draft short-circuited the
 *     success branch to the default entry without running the regex
 *     loop, which silently dropped success-side selection (e.g. a
 *     `SelectionPattern: '200'` entry never matched). The current
 *     implementation always runs the loop.
 */

import { VtlEvaluationError } from './vtl-engine.js';

/**
 * Shape of one entry in `Integration.IntegrationResponses`. CFn property
 * names (PascalCase).
 */
export interface IntegrationResponseEntry {
  /** HTTP status code AWS returns when this entry is selected. */
  StatusCode: string;
  /**
   * Regex pattern AWS matches against the integration's error / status.
   * Undefined / empty marks this as the "default" entry. AWS allows ONE
   * default entry per integration; multiple defaults is a template error
   * but cdkd just picks the first one for resilience.
   */
  SelectionPattern?: string;
  /**
   * Response header literals — values can be:
   *   - `"'literal'"` (single-quoted; AWS unwraps quotes).
   *   - `"integration.response.body.path"` (mapped from backend body).
   *   - `"integration.response.header.<name>"` (mapped from backend header).
   *   - `"context.<field>"` (mapped from `$context`).
   *
   * cdkd v1 supports the single-quoted literal form. Mapping expressions
   * surface a warn and are skipped (rather than silently producing an
   * empty header — AWS gives a defined-but-unhelpful header on local
   * mismatches, which we don't want to mimic).
   */
  ResponseParameters?: Record<string, string>;
  /**
   * VTL templates keyed by content-type. The template evaluates against
   * a context where `$input.body` is the backend response body and
   * `$inputRoot` is the parsed JSON (Lambda's native return value).
   * AWS picks the content-type per Accept header; cdkd picks the
   * `application/json` entry first, then any other entry.
   */
  ResponseTemplates?: Record<string, string>;
  /** `CONVERT_TO_TEXT` / `CONVERT_TO_BINARY` — cdkd treats both as text. */
  ContentHandling?: string;
}

/**
 * Result of selecting one entry. Surfaced to the dispatchers so they
 * apply ResponseTemplates / ResponseParameters consistently.
 */
export interface SelectedIntegrationResponse {
  /** The picked entry. `null` when no entry matches (caller default). */
  entry: IntegrationResponseEntry | null;
  /** Parsed status code, defaulting to 200 when entry is null / unparseable. */
  statusCode: number;
}

/**
 * Pick the right `IntegrationResponses[]` entry for the given outcome.
 *
 * Per AWS docs, `SelectionPattern` is matched against the backend
 * outcome regardless of whether the backend returned success or error —
 * a `SelectionPattern: '200'` entry IS expected to match an HTTP 200
 * upstream response. cdkd ALWAYS runs the regex loop first and only
 * falls to the default entry when no pattern matches; pre-#505-review
 * the success branch short-circuited to the default entry without
 * running the regex loop, which silently dropped success-side selection.
 *
 * @param entries - The `IntegrationResponses[]` array from the template
 *   (already extracted from the route's Integration property).
 * @param matchTarget - The string AWS would match `SelectionPattern`
 *   against. For HTTP / HTTP_PROXY this is `String(upstream.status)`;
 *   for Lambda this is the `errorMessage` field on the parsed payload,
 *   or the sentinel `'success'` when the payload has no `errorMessage`.
 *   For MOCK this is unused (MOCK dispatch picks by `StatusCode`).
 * @param fallbackStatusCode - Status code to use when `entries` is empty
 *   or no entry matches AND no default entry exists. HTTP / HTTP_PROXY
 *   pass the upstream status; Lambda passes 200 on success / 500 on
 *   error.
 */
export function selectIntegrationResponse(
  entries: IntegrationResponseEntry[] | undefined,
  matchTarget: string,
  fallbackStatusCode = 200
): SelectedIntegrationResponse {
  if (!entries || entries.length === 0) {
    return { entry: null, statusCode: fallbackStatusCode };
  }
  // Locate the default entry (empty / missing SelectionPattern). Used
  // when no SelectionPattern matches the target.
  const defaultEntry = entries.find(
    (e) => e.SelectionPattern === undefined || e.SelectionPattern === ''
  );

  // Walk every entry that DOES have a SelectionPattern. AWS anchors the
  // regex with `^...$` and uses case-sensitive matching by default — we
  // mirror it. This runs unconditionally (regardless of upstream
  // success / error) per AWS's documented behavior.
  for (const entry of entries) {
    if (entry.SelectionPattern === undefined || entry.SelectionPattern === '') continue;
    try {
      const re = new RegExp(`^${entry.SelectionPattern}$`);
      if (re.test(matchTarget)) {
        return { entry, statusCode: parseStatus(entry.StatusCode, fallbackStatusCode) };
      }
    } catch {
      // Invalid regex in template — skip the entry but don't abort the
      // whole dispatch. AWS rejects invalid regex at template-validation
      // time; cdkd is more forgiving here so a typo doesn't make the
      // whole route un-emulatable.
    }
  }

  // Fall back to default entry on no-match (matches AWS docs).
  const entry = defaultEntry ?? null;
  return {
    entry,
    statusCode:
      entry !== null ? parseStatus(entry.StatusCode, fallbackStatusCode) : fallbackStatusCode,
  };
}

function parseStatus(raw: unknown, fallback: number): number {
  // Issue (#507) item 6: prefer `Number(...) + Number.isInteger(...)` over
  // `parseInt` so a malformed `StatusCode` value like `"200abc"` is rejected
  // as `undefined` and the caller falls back to `fallback` rather than
  // silently truncating to `200`. Same rationale as `extractStatusCodeFromRendered`
  // in `rest-v1-integrations.ts`.
  //
  // PR #511 review fix-back: `Number(...)` accepts empty strings (→ 0),
  // pure-whitespace strings (→ 0), negative numbers, and out-of-range
  // integers — all of which are invalid HTTP status codes. Tighten the
  // validation to reject those classes too:
  //   - non-string non-number → fallback
  //   - empty / whitespace-only string → fallback
  //   - NaN / non-integer → fallback
  //   - integer outside [100, 599] → fallback (HTTP status code range)
  if (typeof raw === 'number') {
    if (Number.isInteger(raw) && raw >= 100 && raw < 600) return raw;
    return fallback;
  }
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) return fallback;
  if (parsed < 100 || parsed >= 600) return fallback;
  return parsed;
}

/**
 * Evaluate `IntegrationResponse.ResponseParameters` — header literals
 * mapped onto the HTTP response. Returns `{name: value}` for every entry
 * we could resolve; unresolvable entries (non-literal / mapping
 * expression) get a warning via `onUnsupported` and are skipped.
 *
 * AWS format: keys are `method.response.header.<HeaderName>`; values
 * are `'literal'` (with single quotes) or mapping expressions
 * (`integration.response.body.X` / `integration.response.header.X` /
 * `context.X`). cdkd v1 supports the literal form only.
 *
 * PR #511 review fix-back: header names are lowercased here so the
 * returned map shares the same key namespace as the dispatcher's
 * default-initialized headers (`{'content-type': '...'}`). Without
 * normalization a template that sets `Content-Type` PascalCase via
 * ResponseParameters produced a headers object carrying BOTH
 * `'content-type': 'application/json'` (default) AND
 * `'Content-Type': 'text/xml'` (overlay), which downstream HTTP
 * serialization rendered as two conflicting headers — AWS-deployed
 * only ever returns one. By lowercasing every key, overlays simply
 * overwrite the default-initializer entry like AWS does.
 */
export function evaluateResponseParameters(
  responseParameters: Record<string, string> | undefined,
  opts: { onUnsupported?: (key: string, value: string, reason: string) => void } = {}
): Record<string, string> {
  if (!responseParameters) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(responseParameters)) {
    const headerMatch = /^method\.response\.header\.(.+)$/.exec(key);
    if (!headerMatch) {
      opts.onUnsupported?.(
        key,
        value,
        `Only method.response.header.<name> keys are supported on REST v1 ResponseParameters; cdkd cannot map ${key}.`
      );
      continue;
    }
    const headerName = headerMatch[1]!.toLowerCase();
    if (typeof value !== 'string') {
      opts.onUnsupported?.(key, String(value), `non-string ResponseParameter value`);
      continue;
    }
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      out[headerName] = value.slice(1, -1);
      continue;
    }
    // Mapping expression — log + skip. AWS docs:
    //  https://docs.aws.amazon.com/apigateway/latest/developerguide/request-response-data-mappings.html
    opts.onUnsupported?.(
      key,
      value,
      `ResponseParameter value '${value}' is a mapping expression (integration.response.* / context.*) which cdkd local start-api does not emulate. Only single-quoted literals are honored.`
    );
  }
  return out;
}

/**
 * Pick the response template AWS would render for the given Accept
 * header. AWS uses content negotiation; cdkd picks `application/json`
 * first, then any other entry. Returns `undefined` when no template is
 * configured (caller emits the backend body verbatim).
 *
 * The chosen template's content-type is also returned so the dispatcher
 * can emit a matching `Content-Type` header (matches AWS-deployed
 * behavior).
 */
export function pickResponseTemplate(
  responseTemplates: Record<string, string> | undefined,
  accept: string | undefined
): { template: string; contentType: string } | undefined {
  if (!responseTemplates) return undefined;
  const entries = Object.entries(responseTemplates);
  if (entries.length === 0) return undefined;

  if (accept) {
    // Match the FIRST accept-type that has a template. We split on `,`
    // and ignore quality values for simplicity.
    const acceptTypes = accept
      .split(',')
      .map((s) => s.split(';')[0]!.trim())
      .filter(Boolean);
    for (const acceptType of acceptTypes) {
      for (const [ct, template] of entries) {
        if (ct === acceptType) return { template, contentType: ct };
      }
    }
  }

  // Default: application/json > anything else.
  const jsonEntry = responseTemplates['application/json'];
  if (jsonEntry !== undefined) return { template: jsonEntry, contentType: 'application/json' };
  const first = entries[0]!;
  return { template: first[1], contentType: first[0] };
}

/**
 * Re-export VtlEvaluationError so callers don't have to import from two
 * modules.
 */
export { VtlEvaluationError };
