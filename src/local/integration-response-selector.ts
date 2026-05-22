/**
 * `IntegrationResponses[]` selection logic for `cdkd local start-api`'s
 * REST v1 non-AWS_PROXY integrations (#457).
 *
 * AWS API Gateway picks one `IntegrationResponses[]` entry per call to
 * shape the HTTP response. The rules (from AWS docs):
 *
 *   1. If the backend returned **without error** (Lambda success / HTTP
 *      2xx / MOCK), AWS picks the entry whose `SelectionPattern` is
 *      undefined or `''` — that's the "default" entry. If none exists,
 *      the response defaults to HTTP 200.
 *   2. If the backend returned **with an error** (Lambda errorMessage /
 *      HTTP 4xx-5xx), AWS picks the FIRST entry whose `SelectionPattern`
 *      regex matches the error string. The match target depends on the
 *      integration type:
 *        - Lambda: `errorMessage` field of the parsed return value.
 *        - HTTP: the HTTP status code as a string (e.g. `'404'`).
 *      Falls back to the default entry when no regex matches.
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
 * @param entries - The `IntegrationResponses[]` array from the template
 *   (already extracted from the route's Integration property).
 * @param outcome - The backend outcome: `success` (no error) or
 *   `error` with a match target (Lambda errorMessage / HTTP status code
 *   as a string).
 */
export function selectIntegrationResponse(
  entries: IntegrationResponseEntry[] | undefined,
  outcome: { kind: 'success' } | { kind: 'error'; matchTarget: string }
): SelectedIntegrationResponse {
  if (!entries || entries.length === 0) {
    return { entry: null, statusCode: 200 };
  }
  // Locate the default entry (empty / missing SelectionPattern).
  const defaultEntry = entries.find(
    (e) => e.SelectionPattern === undefined || e.SelectionPattern === ''
  );

  if (outcome.kind === 'success') {
    const entry = defaultEntry ?? null;
    return {
      entry,
      statusCode: entry !== null ? parseStatus(entry.StatusCode, 200) : 200,
    };
  }

  // Error outcome: walk every non-default entry, looking for a match
  // against `matchTarget`. AWS anchors the regex with `^...$` and uses
  // case-sensitive matching by default — we mirror it.
  for (const entry of entries) {
    if (entry.SelectionPattern === undefined || entry.SelectionPattern === '') continue;
    try {
      const re = new RegExp(`^${entry.SelectionPattern}$`);
      if (re.test(outcome.matchTarget)) {
        return { entry, statusCode: parseStatus(entry.StatusCode, 500) };
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
    statusCode: entry !== null ? parseStatus(entry.StatusCode, 500) : 500,
  };
}

function parseStatus(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
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
    const headerName = headerMatch[1]!;
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
