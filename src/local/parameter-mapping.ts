/**
 * Parameter-mapping resolver for HTTP API v2 service integrations
 * (`IntegrationSubtype` set, no Lambda).
 *
 * AWS API Gateway HTTP APIs let you wire a route directly to an AWS
 * SDK call via `RequestParameters` — a flat map whose KEY is the SDK
 * input parameter name (`QueueUrl`, `MessageBody`, `Source`, ...) and
 * whose VALUE is either a literal string or one of the dollar-prefixed
 * "selection expression" forms documented at
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-parameter-mapping.html
 *
 * Supported value forms (all bare and `${...}`-wrapped variants):
 *   - `$request.header.<name>`    — case-insensitive header lookup; multi-values comma-joined
 *   - `$request.querystring.<key>` — case-SENSITIVE; multi-values comma-joined
 *   - `$request.path.<param>`     — path parameter from `{param}` route patterns
 *   - `$request.path`             — full request path (without stage)
 *   - `$request.body`             — entire request body as a string
 *   - `$request.body.<jsonpath>`  — JSONPath against the parsed JSON body
 *                                   (recursive descent `..` and filter `?()` are NOT supported)
 *   - `$context.<key>`            — supported context variables
 *                                   (requestId / accountId / domainName / identity.sourceIp / etc.)
 *   - `$stageVariables.<key>`     — values from the route's selected stage
 *
 * `${X} ${Y}` interpolation: any string containing `${...}` is treated
 * as a template literal — each placeholder is resolved independently
 * and the surrounding literal characters are preserved.
 *
 * Anything that is not a recognized selection expression AND does not
 * contain `${...}` is returned as a literal string.
 *
 * This module is **pure-functional and async-free** — every input is
 * derived from the HTTP request snapshot, route match, and the
 * pre-discovered route state. SDK invocation happens in the dispatcher
 * (see `httpv2-service-integration.ts`).
 *
 * Unresolved references (e.g. `$request.querystring.url` against a
 * request with no `url` parameter) resolve to the empty string —
 * matches deployed API Gateway behavior, which treats absent values
 * as `""` and passes them to the SDK call. The dispatcher's
 * per-subtype validator then surfaces the SDK's typed rejection.
 */

import { stringifyValue } from '../utils/stringify.js';

/**
 * Snapshot of the HTTP request used during parameter resolution. The
 * server already collected these on the request hot path; we pass them
 * around as a frozen bag so resolution is pure-functional.
 */
export interface RequestParameterContext {
  /** Lowercased headers; multi-value headers joined by `, ` per AWS docs. */
  headers: Readonly<Record<string, string>>;
  /** Raw query string parameters; case-sensitive keys; multi-value joined by `,`. */
  queryString: Readonly<Record<string, string>>;
  /** Path parameters extracted from `{param}` route patterns; values are URL-decoded. */
  pathParameters: Readonly<Record<string, string>>;
  /** Request path (without the stage prefix). */
  requestPath: string;
  /** Raw request body string (best-effort UTF-8 decode). */
  body: string;
  /** AWS context variables; only `.` and `_` allowed in keys per AWS docs. */
  context: Readonly<Record<string, string>>;
  /** Stage variables from the matched route's selected Stage. */
  stageVariables: Readonly<Record<string, string>>;
}

/**
 * Outcome of resolving the full `RequestParameters` map. Per-parameter
 * resolution never fails (unresolved → `""`), so the only failure mode
 * is a structurally malformed mapping (e.g. a non-string value, or a
 * `${...}` interpolation with an unclosed brace).
 */
export type ResolveParametersOutcome =
  | { kind: 'ok'; resolved: Record<string, string> }
  | { kind: 'error'; reason: string };

/**
 * Resolve a `RequestParameters` map (HTTP API v2 service integration
 * shape) against the incoming HTTP request. Keys are passed through
 * verbatim (they identify the SDK input parameter); only the VALUES
 * go through selection-expression resolution.
 */
export function resolveServiceIntegrationParameters(
  parameters: Readonly<Record<string, unknown>>,
  ctx: RequestParameterContext
): ResolveParametersOutcome {
  const resolved: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(parameters)) {
    if (typeof rawValue !== 'string') {
      return {
        kind: 'error',
        reason: `RequestParameters[${JSON.stringify(key)}] must be a string (got ${typeof rawValue}: ${stringifyValue(
          rawValue
        )}).`,
      };
    }
    try {
      resolved[key] = resolveSelectionExpression(rawValue, ctx);
    } catch (err) {
      return {
        kind: 'error',
        reason: `RequestParameters[${JSON.stringify(key)}]: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { kind: 'ok', resolved };
}

/**
 * Resolve a single selection-expression string. Public for unit
 * testing — production callers use {@link resolveServiceIntegrationParameters}.
 *
 * Three shapes:
 *   1. Pure bare reference (`$request.querystring.url`) — resolved
 *      and returned as-is. Whole-string match.
 *   2. Embedded `${...}` interpolation — every placeholder is resolved
 *      and concatenated with the surrounding literals.
 *   3. Anything else — returned verbatim as a literal.
 */
export function resolveSelectionExpression(input: string, ctx: RequestParameterContext): string {
  // Form 1: pure bare reference. The bare form does NOT allow trailing
  // characters (`$request.path.idX` is one path-param ref, not
  // `$request.path.id` + literal `X`); use `${...}` for that.
  if (input.startsWith('$') && !input.includes('${')) {
    const resolved = resolveSingleReference(input, ctx);
    if (resolved !== undefined) return resolved;
    // Unknown $X.Y form → literal pass-through (matches AWS's
    // permissive behavior — a typo'd `$reqeust.X` lands as the
    // literal string at the SDK call site).
    return input;
  }

  // Form 2: ${...} interpolation. Walk the string once, collect
  // placeholders.
  if (input.includes('${')) {
    return interpolate(input, ctx);
  }

  // Form 3: literal.
  return input;
}

/**
 * Walk a `${...}`-templated string and emit the concatenated result.
 * Per AWS docs, `${X}` may contain any of the selection-expression
 * forms recognized in bare form.
 */
function interpolate(input: string, ctx: RequestParameterContext): string {
  let out = '';
  let i = 0;
  while (i < input.length) {
    const next = input.indexOf('${', i);
    if (next === -1) {
      out += input.slice(i);
      break;
    }
    out += input.slice(i, next);
    const end = input.indexOf('}', next + 2);
    if (end === -1) {
      throw new Error(`unclosed '\${...}' interpolation in selection expression`);
    }
    const inner = input.slice(next + 2, end);
    // Inner expressions DON'T carry the leading `$` — `${request.path.id}`
    // is the canonical shape. Re-add it for the bare resolver.
    const resolved = resolveSingleReference('$' + inner, ctx);
    out += resolved ?? '';
    i = end + 1;
  }
  return out;
}

/**
 * Resolve one selection-expression reference (without `${...}`
 * wrapping). Returns `undefined` when the reference's PREFIX is not
 * a recognized form (so the bare-form caller can fall through to
 * literal-pass-through); returns `""` when the prefix matched but
 * the referenced datum was absent (AWS-deployed behavior).
 */
function resolveSingleReference(ref: string, ctx: RequestParameterContext): string | undefined {
  if (ref === '$request.body') return ctx.body;
  if (ref === '$request.path') return ctx.requestPath;

  if (ref.startsWith('$request.body.')) {
    const path = ref.substring('$request.body.'.length);
    return resolveBodyJsonPath(ctx.body, path);
  }
  if (ref.startsWith('$request.header.')) {
    const name = ref.substring('$request.header.'.length).toLowerCase();
    return ctx.headers[name] ?? '';
  }
  if (ref.startsWith('$request.querystring.')) {
    const key = ref.substring('$request.querystring.'.length);
    return ctx.queryString[key] ?? '';
  }
  if (ref.startsWith('$request.path.')) {
    const key = ref.substring('$request.path.'.length);
    return ctx.pathParameters[key] ?? '';
  }
  if (ref.startsWith('$context.')) {
    const key = ref.substring('$context.'.length);
    return ctx.context[key] ?? '';
  }
  if (ref.startsWith('$stageVariables.')) {
    const key = ref.substring('$stageVariables.'.length);
    return ctx.stageVariables[key] ?? '';
  }
  return undefined;
}

/**
 * Resolve a simple JSON path against the request body. Per AWS docs:
 *
 *   - The body is JSON-parsed (best-effort; non-JSON → empty string).
 *   - Path segments are `.`-separated. Array indexing via `[N]` is
 *     supported.
 *   - Recursive descent `..` and filter expressions `?()` are NOT
 *     supported and produce `""` (matches AWS rejection at deploy
 *     time, but we degrade gracefully at runtime).
 *
 * Non-string leaves are stringified with `JSON.stringify` so they can
 * round-trip into the SDK call's string-typed input fields.
 */
function resolveBodyJsonPath(body: string, path: string): string {
  // Reject recursive descent ($..) and filter expressions ($?()) — AWS
  // docs explicitly call these out as unsupported, so we degrade to ''
  // rather than walking a partial path. The leading-dot check catches
  // `$request.body..x`, which after the substring slice arrives here
  // as `.x` (the first `.` of the `..` got consumed by the static
  // prefix strip in the caller).
  if (path.startsWith('.') || path.includes('..') || path.includes('?(')) return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return '';
  }
  // Split on `.` while preserving `[N]` index segments.
  const segments = path.split(/\.|\[(\d+)\]/).filter((s) => s !== undefined && s !== '');
  let cursor: unknown = parsed;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined) return '';
    if (typeof cursor !== 'object') return '';
    if (Array.isArray(cursor)) {
      const idx = Number(seg);
      if (!Number.isInteger(idx)) return '';
      cursor = cursor[idx];
    } else {
      cursor = (cursor as Record<string, unknown>)[seg];
    }
  }
  if (cursor === undefined || cursor === null) return '';
  if (typeof cursor === 'string') return cursor;
  return JSON.stringify(cursor);
}
