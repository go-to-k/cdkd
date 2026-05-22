/**
 * AWS API Gateway VTL (Velocity Template Language) evaluator — hand-rolled
 * minimal subset for `cdkd local start-api`'s REST v1 non-AWS_PROXY
 * integrations (#457).
 *
 * Background
 * ----------
 *
 * AWS API Gateway uses VTL to map between HTTP request / response shapes
 * and integration backend (Lambda non-proxy / HTTP / MOCK / AWS service)
 * request / response shapes. The full VTL spec is large; AWS API Gateway
 * exposes a SUBSET plus three AWS-specific built-in variables (`$input`,
 * `$context`, `$util`). cdkd implements the SUBSET that real CDK apps
 * use in practice — anything outside it surfaces a clear error rather
 * than silently producing wrong output. See the
 * `VtlEvaluationError.message` field for the exact name when something
 * is unsupported.
 *
 * Supported VTL features
 * ----------------------
 *
 *   - Variable references: `$var` / `${var}` / `$obj.field` /
 *     `$obj.field.subField` (Velocity property notation).
 *   - Method calls on built-ins: `$input.body` / `$input.json('$.path')` /
 *     `$input.path('$.path')` / `$input.params()` / `$input.params('name')` /
 *     `$input.params('header')` / `$context.*` / `$util.escapeJavaScript(x)` /
 *     `$util.base64Encode(x)` / `$util.base64Decode(x)` / `$util.urlEncode(x)` /
 *     `$util.urlDecode(x)` / `$util.parseJson(x)`.
 *   - `#set($var = expr)` directives.
 *   - `#if(cond) ... #elseif(cond) ... #else ... #end` blocks.
 *   - `#foreach($x in $list) ... #end` loops.
 *   - String / number / boolean / null literals: `"text"`, `'text'`, `42`,
 *     `3.14`, `true`, `false`, `null`.
 *   - Logical operators: `&&`, `||`, `!`.
 *   - Comparison operators: `==`, `!=`, `<`, `<=`, `>`, `>=`.
 *   - Implicit string concatenation (literal text + interpolated `$var`).
 *
 * NOT supported (intentionally)
 * -----------------------------
 *
 *   - User-defined macros (`#macro`).
 *   - `#parse` / `#include`.
 *   - Velocity's arithmetic operators (`+ - * /`) outside literal concat.
 *   - Range operator (`[1..5]`).
 *   - `$velocityCount` and other Velocity context built-ins.
 *
 * AWS API Gateway-specific bindings
 * ---------------------------------
 *
 *   `$input.body` — the raw request body as a string.
 *   `$input.json('$.path.to.field')` — JSONPath against the body,
 *     returned as a JSON-stringified value (so primitives are JSON-quoted).
 *   `$input.path('$.path.to.field')` — JSONPath against the body, returned
 *     as the native value (primitives unquoted).
 *   `$input.params()` — `{header: {...}, querystring: {...}, path: {...}}`.
 *   `$input.params('name')` — order: path > query > header (deployed
 *     behavior; AWS docs).
 *   `$input.params('header').<name>` — header lookup.
 *   `$input.params('querystring').<name>` — querystring lookup.
 *   `$input.params('path').<name>` — path-parameter lookup.
 *
 *   `$context.requestId` — synthesized per request.
 *   `$context.identity.sourceIp` — request client IP.
 *   `$context.identity.userAgent` — request user agent.
 *   `$context.httpMethod` — request method.
 *   `$context.resourcePath` — the route's pathPattern.
 *   `$context.stage` — the route's stage name (`$default` if no stage).
 *
 *   `$util.escapeJavaScript(s)` — escape `\`, `'`, `"`, `\n`, `\r`, `\t`
 *     for embedding inside a JavaScript string literal.
 *   `$util.base64Encode(s)` — base64 (no padding stripped).
 *   `$util.base64Decode(s)` — UTF-8 decode of base64.
 *   `$util.urlEncode(s)` / `$util.urlDecode(s)` — RFC 3986 encoding.
 *   `$util.parseJson(s)` — `JSON.parse(s)`.
 *
 * Mismatches between cdkd's evaluator and AWS-deployed VTL surface as
 * `VtlEvaluationError`. Spurious whitespace / formatting differences are
 * acceptable and not in the contract.
 */

/**
 * Bindings available to a VTL template evaluation. Built up by
 * `buildVtlContext` from an `HttpRequestSnapshot` + `MatchedRouteContext`.
 */
export interface VtlContext {
  /** `$input` — the request body + parameter accessor. */
  input: VtlInput;
  /** `$context` — request metadata (requestId, identity, etc.). */
  context: VtlRequestContext;
  /**
   * `$util` — utility functions (escape, base64, URL encoding, JSON parse).
   * The `util` reference is shared across templates; pure-functional, no
   * shared state.
   */
  util: VtlUtil;
  /**
   * Additional bindings for response-side templates. The Lambda integration
   * type binds `$inputRoot` to the parsed return value (AWS docs convention
   * for response mapping templates).
   */
  inputRoot?: unknown;
}

/** `$input` binding — request body + parameter accessor. */
export interface VtlInput {
  /** Raw request body as a string. */
  body: string;
  /** Parsed JSON of `body` (computed lazily — read-only here). */
  jsonBody: unknown;
  /** Header map (single-value form; comma-joined when AWS emits multi-value). */
  headers: Record<string, string>;
  /** Query-string map (single-value form). */
  querystring: Record<string, string>;
  /** Path-parameter map. */
  path: Record<string, string>;
}

/** `$context` binding — synthesized per request. */
export interface VtlRequestContext {
  requestId: string;
  httpMethod: string;
  resourcePath: string;
  stage: string;
  identity: {
    sourceIp: string;
    userAgent: string;
  };
}

/** `$util` binding — built-in functions. */
export interface VtlUtil {
  escapeJavaScript(input: unknown): string;
  base64Encode(input: unknown): string;
  base64Decode(input: unknown): string;
  urlEncode(input: unknown): string;
  urlDecode(input: unknown): string;
  parseJson(input: unknown): unknown;
}

/** Error thrown when a template references an unsupported VTL feature. */
export class VtlEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VtlEvaluationError';
    Object.setPrototypeOf(this, VtlEvaluationError.prototype);
  }
}

/** Built-in `$util` implementation. */
export function buildDefaultUtil(): VtlUtil {
  const coerce = (v: unknown): string => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
      return String(v);
    }
    // Object / array — JSON-stringify to avoid the `[object Object]` trap.
    try {
      return JSON.stringify(v);
    } catch {
      return '';
    }
  };
  return {
    escapeJavaScript(input) {
      // Mirror AWS API Gateway behavior: escape backslash, single + double
      // quote, and common control chars. Forward slash is NOT escaped
      // (mismatches some online references; AWS-deployed behavior is the
      // arbiter).
      return coerce(input)
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/'/g, "\\'")
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t');
    },
    base64Encode(input) {
      return Buffer.from(coerce(input), 'utf-8').toString('base64');
    },
    base64Decode(input) {
      return Buffer.from(coerce(input), 'base64').toString('utf-8');
    },
    urlEncode(input) {
      return encodeURIComponent(coerce(input));
    },
    urlDecode(input) {
      try {
        return decodeURIComponent(coerce(input));
      } catch {
        return coerce(input);
      }
    },
    parseJson(input) {
      const s = coerce(input);
      try {
        return JSON.parse(s);
      } catch (err) {
        throw new VtlEvaluationError(
          `$util.parseJson: invalid JSON input: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
  };
}

/**
 * Public entry point — evaluate a VTL template against a context and
 * return the rendered string. Throws {@link VtlEvaluationError} on any
 * unsupported syntax or runtime failure.
 *
 * Empty / undefined templates short-circuit to an empty string, matching
 * AWS API Gateway behavior when `RequestTemplates` / `ResponseTemplates`
 * is absent for the selected content type.
 */
export function evaluateVtl(template: string | undefined, ctx: VtlContext): string {
  if (template === undefined || template.length === 0) return '';
  const evaluator = new VtlEvaluator(ctx);
  return evaluator.evaluate(template);
}

// ===================== Internal implementation ============================

/**
 * Stateful evaluator. Tokenizes + parses + renders in one pass — minimal
 * subset, so a recursive-descent walk over the template suffices. Tracks
 * a per-template scope chain for `#set` and `#foreach` bindings.
 */
class VtlEvaluator {
  private readonly ctx: VtlContext;
  private readonly scopes: Array<Map<string, unknown>>;
  private readonly output: string[] = [];

  constructor(ctx: VtlContext) {
    this.ctx = ctx;
    this.scopes = [new Map()];
  }

  evaluate(template: string): string {
    this.renderBlock(template);
    return this.output.join('');
  }

  /**
   * Render a block — walks the template, interpolating `${var}` /
   * `$var.field.method(args)` and handling `#set` / `#if` / `#foreach`
   * directives.
   *
   * The walk is line-aware for directives: every `#directive` MUST start
   * a line (after whitespace) per Velocity convention, but for ergonomics
   * we also accept directives at the start of the template. Inline `$var`
   * references are handled anywhere.
   */
  private renderBlock(block: string): void {
    let i = 0;
    while (i < block.length) {
      const ch = block[i];
      if (ch === '#' && this.isDirectiveStart(block, i)) {
        i = this.handleDirective(block, i);
        continue;
      }
      if (ch === '$') {
        const consumed = this.handleVariable(block, i);
        if (consumed > 0) {
          i += consumed;
          continue;
        }
      }
      if (ch === '\\' && i + 1 < block.length && block[i + 1] === '$') {
        // Escaped `\$` — emit literal `$`.
        this.output.push('$');
        i += 2;
        continue;
      }
      this.output.push(ch ?? '');
      i++;
    }
  }

  private isDirectiveStart(block: string, i: number): boolean {
    // `#` must be followed by an alpha (or `*` for comments — unsupported).
    if (i + 1 >= block.length) return false;
    const next = block[i + 1];
    if (next === '#') return true; // single-line comment `##`
    return next !== undefined && /[a-zA-Z]/.test(next);
  }

  /**
   * Handle one directive (`#set`, `#if`, `#foreach`, etc.) — returns the
   * NEW index in `block` (i.e. how far we consumed past the directive).
   */
  private handleDirective(block: string, start: number): number {
    // Single-line `##` comment.
    if (block[start + 1] === '#') {
      const eol = block.indexOf('\n', start);
      return eol === -1 ? block.length : eol + 1;
    }

    const directiveMatch = /^#([a-zA-Z]+)/.exec(block.slice(start));
    if (!directiveMatch) {
      this.output.push('#');
      return start + 1;
    }
    const name = directiveMatch[1]!;
    const afterDirective = start + 1 + name.length;

    switch (name) {
      case 'set':
        return this.handleSetDirective(block, afterDirective);
      case 'if':
        return this.handleIfDirective(block, afterDirective);
      case 'foreach':
        return this.handleForeachDirective(block, afterDirective);
      case 'else':
      case 'elseif':
      case 'end':
        // Bare `#else` / `#elseif` / `#end` outside their parent — caller
        // already consumed these via `consumeUntilEnd`. If we see them
        // here it's a template-author error.
        throw new VtlEvaluationError(`Unexpected #${name} outside of a #if / #foreach block`);
      default:
        throw new VtlEvaluationError(
          `Unsupported VTL directive #${name} (cdkd local start-api supports #set / #if / #elseif / #else / #foreach / #end / ##)`
        );
    }
  }

  /**
   * `#set($var = expression)` — assigns to the innermost scope.
   */
  private handleSetDirective(block: string, after: number): number {
    const { args, end } = this.readParenArgs(block, after);
    const eq = args.indexOf('=');
    if (eq === -1) {
      throw new VtlEvaluationError(`#set requires '=': got #set(${args})`);
    }
    const left = args.slice(0, eq).trim();
    const right = args.slice(eq + 1).trim();
    if (!left.startsWith('$')) {
      throw new VtlEvaluationError(`#set left side must be a $var reference (got '${left}')`);
    }
    const varName = left.slice(1).replace(/^\{/, '').replace(/\}$/, '');
    const value = this.evaluateExpression(right);
    this.scopes[this.scopes.length - 1]!.set(varName, value);
    return this.skipDirectiveTrailingNewline(block, end);
  }

  /**
   * `#if (cond) ... #elseif (cond) ... #else ... #end`. Renders the
   * first true branch only; the rest are skipped (their text NOT emitted).
   */
  private handleIfDirective(block: string, after: number): number {
    const { args: condExpr, end } = this.readParenArgs(block, after);
    let rendered = false;
    let renderedAny = false;

    // Find the matching #end (with #else / #elseif handling).
    const branches: Array<{ condition: string | null; bodyStart: number; bodyEnd: number }> = [
      {
        condition: condExpr,
        bodyStart: this.skipDirectiveTrailingNewline(block, end),
        bodyEnd: -1,
      },
    ];
    let cursor = branches[0]!.bodyStart;
    let depth = 1;
    while (cursor < block.length && depth > 0) {
      if (block[cursor] !== '#') {
        cursor++;
        continue;
      }
      const m = /^#([a-zA-Z]+)/.exec(block.slice(cursor));
      if (!m) {
        cursor++;
        continue;
      }
      const tag = m[1]!;
      const tagAfter = cursor + 1 + tag.length;
      if (tag === 'if' || tag === 'foreach') {
        depth++;
        cursor = tagAfter;
        continue;
      }
      if (tag === 'end') {
        depth--;
        if (depth === 0) {
          branches[branches.length - 1]!.bodyEnd = cursor;
          const endIdx = this.skipDirectiveTrailingNewline(block, tagAfter);
          // Render the first true branch.
          for (const branch of branches) {
            if (rendered) break;
            const truthy: boolean =
              branch.condition === null ? !renderedAny : this.evaluateCondition(branch.condition);
            if (truthy) {
              this.renderBlock(block.slice(branch.bodyStart, branch.bodyEnd));
              rendered = true;
            }
            renderedAny = renderedAny || truthy;
          }
          return endIdx;
        }
        cursor = tagAfter;
        continue;
      }
      if (depth === 1 && (tag === 'elseif' || tag === 'else')) {
        branches[branches.length - 1]!.bodyEnd = cursor;
        if (tag === 'elseif') {
          const { args, end: elseifEnd } = this.readParenArgs(block, tagAfter);
          branches.push({
            condition: args,
            bodyStart: this.skipDirectiveTrailingNewline(block, elseifEnd),
            bodyEnd: -1,
          });
          cursor = branches[branches.length - 1]!.bodyStart;
        } else {
          branches.push({
            condition: null,
            bodyStart: this.skipDirectiveTrailingNewline(block, tagAfter),
            bodyEnd: -1,
          });
          cursor = branches[branches.length - 1]!.bodyStart;
        }
        continue;
      }
      cursor = tagAfter;
    }
    throw new VtlEvaluationError('#if without matching #end');
  }

  /**
   * `#foreach($x in $list) ... #end` — iterates a list / object's values.
   */
  private handleForeachDirective(block: string, after: number): number {
    const { args, end } = this.readParenArgs(block, after);
    const m = /^\s*\$([a-zA-Z_][a-zA-Z_0-9]*)\s+in\s+(.+)$/.exec(args);
    if (!m) {
      throw new VtlEvaluationError(`Invalid #foreach syntax: ${args}`);
    }
    const varName = m[1]!;
    const listExpr = m[2]!;
    const listValue = this.evaluateExpression(listExpr);

    let depth = 1;
    let cursor = this.skipDirectiveTrailingNewline(block, end);
    const bodyStart = cursor;
    while (cursor < block.length && depth > 0) {
      if (block[cursor] !== '#') {
        cursor++;
        continue;
      }
      const tm = /^#([a-zA-Z]+)/.exec(block.slice(cursor));
      if (!tm) {
        cursor++;
        continue;
      }
      const tag = tm[1]!;
      if (tag === 'if' || tag === 'foreach') {
        depth++;
        cursor += 1 + tag.length;
        continue;
      }
      if (tag === 'end') {
        depth--;
        if (depth === 0) {
          const bodyEnd = cursor;
          const endIdx = this.skipDirectiveTrailingNewline(block, cursor + 1 + tag.length);

          const items = this.coerceToIterable(listValue);
          for (const item of items) {
            this.scopes.push(new Map([[varName, item]]));
            try {
              this.renderBlock(block.slice(bodyStart, bodyEnd));
            } finally {
              this.scopes.pop();
            }
          }
          return endIdx;
        }
      }
      cursor += 1 + tag.length;
    }
    throw new VtlEvaluationError('#foreach without matching #end');
  }

  /** Convert a value into an iterable sequence for `#foreach`. */
  private coerceToIterable(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>);
    if (value == null) return [];
    return [value];
  }

  /**
   * Skip whitespace and a single trailing newline immediately after a
   * directive — matches Velocity's "directive eats its own newline"
   * convention. Without this rule, every `#set(...)` line in a template
   * would leave a blank line in the output.
   */
  private skipDirectiveTrailingNewline(block: string, after: number): number {
    let i = after;
    while (i < block.length && (block[i] === ' ' || block[i] === '\t')) i++;
    if (block[i] === '\r') i++;
    if (block[i] === '\n') i++;
    return i;
  }

  /**
   * Read `(...)` arguments after a directive name. Returns the inner
   * string + the index AFTER the closing paren. Handles nested parens
   * inside string literals / method calls.
   */
  private readParenArgs(block: string, after: number): { args: string; end: number } {
    let i = after;
    while (i < block.length && (block[i] === ' ' || block[i] === '\t')) i++;
    if (block[i] !== '(') {
      throw new VtlEvaluationError(`Expected '(' after directive at offset ${after}`);
    }
    i++;
    let depth = 1;
    const start = i;
    let inString: '"' | "'" | null = null;
    while (i < block.length && depth > 0) {
      const c = block[i];
      if (inString) {
        if (c === '\\' && i + 1 < block.length) {
          i += 2;
          continue;
        }
        if (c === inString) inString = null;
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        inString = c;
        i++;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      if (depth === 0) break;
      i++;
    }
    if (depth !== 0) {
      throw new VtlEvaluationError(`Unterminated parenthesised argument at offset ${after}`);
    }
    return { args: block.slice(start, i), end: i + 1 };
  }

  /**
   * Handle a `$var` / `${var}` / `$obj.field.method(args)` reference.
   * Returns the number of characters consumed (0 if not a reference —
   * caller emits the literal `$`).
   */
  private handleVariable(block: string, start: number): number {
    const m = /^\$(\{[^}]+\}|[a-zA-Z_][a-zA-Z_0-9]*(?:\.[a-zA-Z_][a-zA-Z_0-9]*)*)/.exec(
      block.slice(start)
    );
    if (!m) return 0;
    const ref = m[1]!;
    const refStr = ref.startsWith('{') ? ref.slice(1, -1) : ref;
    let consumed = m[0].length;

    // After the chain, look for method call `(...)`. Repeat to chain
    // method calls (e.g. `$input.params('querystring').name`).
    let value = this.resolveReference(refStr);
    let pos = start + consumed;
    while (pos < block.length) {
      if (block[pos] === '(') {
        const { args, end } = this.readParenArgs(block, pos);
        value = this.callValueAsMethod(value, args, refStr);
        consumed = end - start;
        pos = end;
        // After a method call, allow a trailing `.field` chain like
        // `$input.params('querystring').name`.
        if (pos < block.length && block[pos] === '.') {
          const tailMatch = /^\.([a-zA-Z_][a-zA-Z_0-9]*)/.exec(block.slice(pos));
          if (tailMatch) {
            const field = tailMatch[1]!;
            value = lookupField(value, field);
            consumed += tailMatch[0].length;
            pos += tailMatch[0].length;
            continue;
          }
        }
        break;
      }
      break;
    }

    this.output.push(this.stringifyForOutput(value));
    return consumed;
  }

  /**
   * Resolve a dotted reference path against context + scopes. The first
   * segment is matched against built-in roots (`input` / `context` / `util`
   * / `inputRoot`) and the scope chain in order.
   */
  private resolveReference(path: string): unknown {
    const parts = path.split('.');
    const first = parts[0]!;
    const rest = parts.slice(1);
    let base: unknown;
    if (first === 'input') base = this.ctx.input;
    else if (first === 'context') base = this.ctx.context;
    else if (first === 'util') base = this.ctx.util;
    else if (first === 'inputRoot') base = this.ctx.inputRoot;
    else {
      // Walk scope chain from innermost outward.
      let found = false;
      for (let i = this.scopes.length - 1; i >= 0; i--) {
        const scope = this.scopes[i]!;
        if (scope.has(first)) {
          base = scope.get(first);
          found = true;
          break;
        }
      }
      if (!found) {
        // Unknown variable returns `null` (Velocity convention — silent).
        return null;
      }
    }
    return rest.reduce<unknown>((acc, seg) => lookupField(acc, seg), base);
  }

  /**
   * Invoke a value as a method — used after a `$ref(args)` shape. The
   * value must be a function or a special-cased built-in.
   */
  private callValueAsMethod(value: unknown, argsRaw: string, refPath: string): unknown {
    if (typeof value !== 'function') {
      throw new VtlEvaluationError(
        `Reference '$${refPath}' is not callable (got ${typeof value}). cdkd supports calling $input / $util / $context method-style references only.`
      );
    }
    const args = this.parseArgList(argsRaw);
    const fn = value as (...a: unknown[]) => unknown;
    return fn(...args);
  }

  /**
   * Parse a comma-separated argument list — recursively evaluates each
   * expression. Handles string literals, numbers, booleans, and nested
   * `$var` refs.
   */
  private parseArgList(raw: string): unknown[] {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return [];
    const parts: string[] = [];
    let depth = 0;
    let inString: '"' | "'" | null = null;
    let start = 0;
    for (let i = 0; i < trimmed.length; i++) {
      const c = trimmed[i]!;
      if (inString) {
        if (c === '\\' && i + 1 < trimmed.length) {
          i++;
          continue;
        }
        if (c === inString) inString = null;
        continue;
      }
      if (c === '"' || c === "'") {
        inString = c;
        continue;
      }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(trimmed.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(trimmed.slice(start));
    return parts.map((p) => this.evaluateExpression(p.trim()));
  }

  /**
   * Evaluate a sub-expression (string literal / number / boolean / null /
   * `$ref` / `$ref.field`). Tiny grammar — no arithmetic operators.
   */
  private evaluateExpression(expr: string): unknown {
    const trimmed = expr.trim();
    if (trimmed.length === 0) return null;

    if (trimmed === 'true') return true;
    if (trimmed === 'false') return false;
    if (trimmed === 'null') return null;

    // String literal — single or double quotes.
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return this.unescapeStringLiteral(trimmed.slice(1, -1));
    }

    // Number literal.
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      return Number(trimmed);
    }

    // Variable reference (potentially with method call). Reuse the
    // variable handler by reading the whole thing.
    if (trimmed.startsWith('$')) {
      // Strip optional `${...}` wrapping.
      const refMatch = /^\$(\{[^}]+\}|[a-zA-Z_][a-zA-Z_0-9]*(?:\.[a-zA-Z_][a-zA-Z_0-9]*)*)$/.exec(
        trimmed
      );
      if (refMatch) {
        const refStr = refMatch[1]!;
        const refPath = refStr.startsWith('{') ? refStr.slice(1, -1) : refStr;
        return this.resolveReference(refPath);
      }
      // Has trailing `(args)` — call the reference.
      const callMatch = /^\$([a-zA-Z_][a-zA-Z_0-9]*(?:\.[a-zA-Z_][a-zA-Z_0-9]*)*)\((.*)\)$/.exec(
        trimmed
      );
      if (callMatch) {
        const refPath = callMatch[1]!;
        const argsRaw = callMatch[2]!;
        const value = this.resolveReference(refPath);
        return this.callValueAsMethod(value, argsRaw, refPath);
      }
    }
    throw new VtlEvaluationError(`Could not evaluate VTL sub-expression: '${trimmed}'`);
  }

  private unescapeStringLiteral(s: string): string {
    return s
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'");
  }

  /**
   * Evaluate a `#if` / `#elseif` condition expression. Supports `&&`,
   * `||`, `!`, comparison ops, and bare value tests (truthy/falsy).
   */
  private evaluateCondition(expr: string): boolean {
    const trimmed = expr.trim();
    // Tokenize at top-level `&&` / `||`.
    const orParts = splitTopLevel(trimmed, '||');
    if (orParts.length > 1) {
      return orParts.some((p) => this.evaluateCondition(p));
    }
    const andParts = splitTopLevel(trimmed, '&&');
    if (andParts.length > 1) {
      return andParts.every((p) => this.evaluateCondition(p));
    }
    if (trimmed.startsWith('!')) {
      return !this.evaluateCondition(trimmed.slice(1).trim());
    }
    // Parenthesised expression.
    if (trimmed.startsWith('(') && trimmed.endsWith(')')) {
      return this.evaluateCondition(trimmed.slice(1, -1));
    }
    // Comparison operators.
    for (const op of ['==', '!=', '<=', '>=', '<', '>'] as const) {
      const parts = splitTopLevel(trimmed, op);
      if (parts.length === 2) {
        const lhs = this.evaluateExpression(parts[0]!);
        const rhs = this.evaluateExpression(parts[1]!);
        return compareValues(lhs, rhs, op);
      }
    }
    // Bare value test — truthy unless null / false / empty string / 0.
    const value = this.evaluateExpression(trimmed);
    return isTruthy(value);
  }

  /**
   * Convert a value to its template output form. Mirrors Velocity's
   * `toString` convention: `null` → empty string; objects → JSON; numbers
   * / booleans → standard.
   */
  private stringifyForOutput(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return JSON.stringify(value);
  }
}

// ===================== Helpers ============================================

/**
 * Look up `field` on `obj`. Returns `null` for missing fields (Velocity
 * silent-undefined convention).
 */
function lookupField(obj: unknown, field: string): unknown {
  if (obj == null) return null;
  if (typeof obj === 'object') {
    const rec = obj as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(rec, field)) return rec[field];
    // Allow camelCase / dot-style lookups against AWS-shape contexts.
    return null;
  }
  return null;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString: '"' | "'" | null = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (inString) {
      if (c === '\\' && i + 1 < s.length) {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(start, i));
      start = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

function compareValues(
  lhs: unknown,
  rhs: unknown,
  op: '==' | '!=' | '<' | '<=' | '>' | '>='
): boolean {
  if (op === '==') return looseEqual(lhs, rhs);
  if (op === '!=') return !looseEqual(lhs, rhs);
  // Number / string comparison — coerce strings to numbers when possible.
  const a = typeof lhs === 'number' ? lhs : Number(lhs);
  const b = typeof rhs === 'number' ? rhs : Number(rhs);
  if (Number.isFinite(a) && Number.isFinite(b)) {
    switch (op) {
      case '<':
        return a < b;
      case '<=':
        return a <= b;
      case '>':
        return a > b;
      case '>=':
        return a >= b;
    }
  }
  const sa = String(lhs);
  const sb = String(rhs);
  switch (op) {
    case '<':
      return sa < sb;
    case '<=':
      return sa <= sb;
    case '>':
      return sa > sb;
    case '>=':
      return sa >= sb;
  }
}

function looseEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === typeof b) {
    if (typeof a === 'object') return JSON.stringify(a) === JSON.stringify(b);
    return false;
  }
  // Cross-type compare: AWS templates often write `$x == "true"` where
  // `$x` is a boolean; fall back to string compare. Use a defensive
  // stringifier that JSON-encodes objects rather than the default
  // `[object Object]` trap.
  return safeStringify(a) === safeStringify(b);
}

function safeStringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

function isTruthy(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

/**
 * Build a `VtlInput` binding from an HTTP request snapshot + matched
 * route context. `$input` exposes the body + parameter accessors used by
 * AWS API Gateway's VTL templates.
 *
 * `params()` returns the union of header / querystring / path maps;
 * `params(name)` resolves first against path, then querystring, then
 * header (matches AWS-deployed precedence).
 *
 * `json(jsonPath)` returns a JSON-stringified slice of the parsed body;
 * `path(jsonPath)` returns the raw native value (primitives unquoted).
 *
 * JSONPath support is minimal: supports `$` (root), `$.field`,
 * `$.field.subField`, `$.array[0]`. AWS supports more (filter
 * expressions, recursive descent); cdkd surfaces a clear error on
 * unsupported expressions rather than silently producing wrong output.
 */
export function buildVtlInput(
  body: string,
  headers: Record<string, string>,
  querystring: Record<string, string>,
  pathParams: Record<string, string>
): VtlInput {
  let jsonBodyCache: unknown;
  let jsonBodyParsed = false;
  function lazyJson(): unknown {
    if (!jsonBodyParsed) {
      jsonBodyParsed = true;
      try {
        jsonBodyCache = body.length === 0 ? null : JSON.parse(body);
      } catch {
        jsonBodyCache = null;
      }
    }
    return jsonBodyCache;
  }
  // `$input.json('$.path')` — JSON-stringified.
  function jsonFn(...args: unknown[]): string {
    const expr = args.length > 0 ? String(args[0]) : '$';
    const val = applyJsonPath(lazyJson(), expr);
    return JSON.stringify(val ?? null);
  }
  // `$input.path('$.path')` — native value.
  function pathFn(...args: unknown[]): unknown {
    const expr = args.length > 0 ? String(args[0]) : '$';
    return applyJsonPath(lazyJson(), expr);
  }
  // `$input.params()` / `$input.params('name')`.
  function paramsFn(...args: unknown[]): unknown {
    if (args.length === 0) {
      return { header: headers, querystring, path: pathParams };
    }
    const arg = String(args[0]);
    if (arg === 'header') return headers;
    if (arg === 'querystring') return querystring;
    if (arg === 'path') return pathParams;
    // params('<name>') — AWS precedence: path, querystring, header.
    if (Object.prototype.hasOwnProperty.call(pathParams, arg)) return pathParams[arg];
    if (Object.prototype.hasOwnProperty.call(querystring, arg)) return querystring[arg];
    if (Object.prototype.hasOwnProperty.call(headers, arg)) return headers[arg];
    // Case-insensitive header lookup as a last resort.
    const lowerArg = arg.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === lowerArg) return v;
    }
    return null;
  }
  return {
    body,
    get jsonBody() {
      return lazyJson();
    },
    headers,
    querystring,
    path: pathParams,
    // Method-call surface — Velocity treats these as zero-arg property
    // accessors when no parens are used. We expose them as functions so
    // `$input.json('$')` works; `$input.body` is a plain string already.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...({ json: jsonFn, path: pathFn, params: paramsFn } as any),
  } as VtlInput;
}

/**
 * Minimal JSONPath evaluator. Supports `$`, `$.field`, `$.field.sub`,
 * `$.array[index]`. Unsupported syntax throws so the user sees a clear
 * pointer to the gap.
 */
export function applyJsonPath(root: unknown, expr: string): unknown {
  const trimmed = expr.trim();
  if (trimmed === '$' || trimmed.length === 0) return root;
  if (!trimmed.startsWith('$')) {
    throw new VtlEvaluationError(`JSONPath must start with '$': got '${trimmed}'`);
  }
  let cursor: unknown = root;
  let i = 1;
  while (i < trimmed.length) {
    const c = trimmed[i]!;
    if (c === '.') {
      i++;
      // Property access: `.field`.
      const m = /^[a-zA-Z_][a-zA-Z_0-9]*/.exec(trimmed.slice(i));
      if (!m) {
        throw new VtlEvaluationError(
          `Unsupported JSONPath syntax at position ${i}: '${trimmed}' (cdkd supports $, $.field, $.field.sub, $.array[index] only).`
        );
      }
      cursor = lookupField(cursor, m[0]);
      i += m[0].length;
      continue;
    }
    if (c === '[') {
      const close = trimmed.indexOf(']', i);
      if (close === -1) {
        throw new VtlEvaluationError(`Unterminated [ in JSONPath: '${trimmed}'`);
      }
      const inside = trimmed.slice(i + 1, close).trim();
      if (/^-?\d+$/.test(inside)) {
        const idx = Number(inside);
        if (Array.isArray(cursor)) {
          cursor = (cursor as unknown[])[idx];
        } else {
          cursor = null;
        }
      } else if (
        (inside.startsWith('"') && inside.endsWith('"')) ||
        (inside.startsWith("'") && inside.endsWith("'"))
      ) {
        cursor = lookupField(cursor, inside.slice(1, -1));
      } else {
        throw new VtlEvaluationError(
          `Unsupported JSONPath bracket expression: '${inside}' (cdkd supports integer indices and quoted string keys only).`
        );
      }
      i = close + 1;
      continue;
    }
    throw new VtlEvaluationError(`Unexpected character in JSONPath at position ${i}: '${trimmed}'`);
  }
  return cursor;
}

/**
 * Build a `$context` binding from a request snapshot + matched route.
 * The mapping mirrors what AWS API Gateway exposes (see AWS docs:
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-mapping-template-reference.html).
 */
export function buildVtlRequestContext(args: {
  requestId: string;
  httpMethod: string;
  resourcePath: string;
  stage: string;
  sourceIp: string;
  userAgent: string;
}): VtlRequestContext {
  return {
    requestId: args.requestId,
    httpMethod: args.httpMethod,
    resourcePath: args.resourcePath,
    stage: args.stage,
    identity: {
      sourceIp: args.sourceIp,
      userAgent: args.userAgent,
    },
  };
}
