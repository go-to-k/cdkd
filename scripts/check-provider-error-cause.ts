/**
 * Provider error-cause threading critic (issue #2040).
 *
 * WHAT THIS CHECKS
 * ----------------
 * cdkd's transient-error classifiers all read the AWS error through the
 * `.cause` chain:
 *
 *   - `isTransientServerError`  (`$metadata.httpStatusCode` in 500/502/503/504)
 *   - `isThrottlingError`       (throttle error NAMES + retryable statuses)
 *   - `isMarkedNonRetryable`    (the `Symbol.for('cdkd.nonRetryable')` marker)
 *
 * Each walks `error.cause` up to a bounded depth. A provider `catch` site that
 * builds a `ProvisioningError` (or any other `CdkdError` subclass) WITHOUT
 * threading the caught value as `cause` makes all three INERT for that call:
 * the classifiers see a cdkd-authored wrapper with no `$metadata` and no
 * marker, so the same AWS failure is retryable in one provider and terminal in
 * another, for no reason a user could predict.
 *
 * The reference shape is `sqs-queue-policy-provider.ts`:
 *
 *   } catch (error) {
 *     const cause = error instanceof Error ? error : undefined;
 *     throw new ProvisioningError(
 *       `Failed to ...: ${error instanceof Error ? error.message : String(error)}`,
 *       resourceType,
 *       logicalId,
 *       physicalId,
 *       cause
 *     );
 *   }
 *
 * WHAT COUNTS AS A DEFECT
 * -----------------------
 * A construction is CHECKED when a caught value is in scope for it, which
 * happens two ways:
 *
 *  - LEXICALLY — it sits inside a `catch (error)` block. A bare `catch {` binds
 *    nothing, so there is no cause to thread.
 *
 *  - THROUGH A HELPER — it sits inside a function that a `catch` block hands
 *    its binding to (`throw this.wrapError(error, op, ...)`). Five such helpers
 *    exist under `providers/` and they account for 33 throw sites; every one of
 *    them builds its `ProvisioningError` OUTSIDE any lexical catch. A purely
 *    lexical rule reports all 33 as "no cause in scope" and a regression in any
 *    of them is invisible — deleting the `cause` argument from
 *    `rds-dbproxy-provider.ts`'s `wrapError` silently un-threads 7 sites at
 *    once. Call sites are resolved to a FIXPOINT, so a helper calling a helper
 *    is covered too.
 *
 * Anything outside both is a validation / precondition throw with no cause in
 * scope — bucket (c), and the largest bucket by far (378 of 765).
 *
 * WHAT COUNTS AS THREADED (structural, not "mentions the binding")
 * ---------------------------------------------------------------
 * The cause argument must BE the caught value, not merely be computed from it.
 * `const cause = new Error(error.message)` mentions the binding, and is exactly
 * as inert as dropping it: the new `Error` carries no `$metadata` and no
 * marker, so every classifier still returns false. So the check is structural —
 * a bare identifier resolving to the caught binding, optionally through
 * parentheses, an `as` cast, a `!`, an `undefined`-guarded conditional, or
 * `??` / `||`, and optionally through local `const` / `let` bindings resolved
 * to the declaration NEAREST the use. A property access (`result.error`), a
 * call, a `new`, an object literal or a string is REFUSED.
 *
 * HOW THE RULE WAS CALIBRATED
 * ---------------------------
 * Against the pre-fix tree, not against the issue's prose — the issue records
 * two reviewers reaching 6-of-363 and ~325-of-719 from two different matchings,
 * which is what an uncalibrated rule produces.
 *
 * WHAT DEFENDS THIS CHECKER FROM ITSELF
 * -------------------------------------
 * Two failure modes, and they need different defenses. Stating this precisely
 * matters: an earlier revision of this comment credited the FLOORS with both,
 * and they only provide the first.
 *
 *  1. COLLAPSE TOWARD ZERO — the parse silently yields nothing (a renamed
 *     directory, a compiler-API change, a file that stops parsing). The FLOORS
 *     below catch this: minimum files, constructions, catch-sited, helper-sited
 *     and already-threaded counts, plus a hard failure on any file with parse
 *     diagnostics (a file that fails to parse contributes zero sites, and the
 *     floors have enough slack that up to three whole provider files could
 *     disappear unnoticed — so the diagnostics check, not the numbers, is what
 *     actually closes it).
 *
 *  2. COLLAPSE TOWARD GREEN — the classifier itself degrades so that everything
 *     reads as threaded. No floor can see this: the counts are unchanged and
 *     the output is byte-identical. The SELF-PROBE below is what catches it —
 *     a fixed set of sources with known verdicts, including known-DROPPED ones,
 *     analyzed on every run before the real tree is touched. Making
 *     `isThreaded` return true unconditionally fails the self-probe.
 *
 * SCOPE, AND THE MEASUREMENT BEHIND IT
 * ------------------------------------
 * The default root is `src/provisioning/providers`, which is #2040's subject,
 * and the tree is CLEAN there. The root is a parameter rather than a constant
 * because the same defect DOES exist elsewhere — running this with
 * `--providers-dir=src` reports 6 sites (4 `AssetError` in
 * `src/assets/docker-asset-publisher.ts`, 2 `StateError` in
 * `src/state/s3-state-backend.ts`), which is where #2040's "6-of-363" review
 * estimate came from. Those files were outside that PR's edit scope, so the set
 * with ZERO defects is regression-guarded and the set with SIX is not. Widening
 * this default once they are fixed is issue
 * https://github.com/go-to-k/cdkd/issues/2075.
 *
 * USAGE
 *   node --experimental-strip-types scripts/check-provider-error-cause.ts
 *   node --experimental-strip-types scripts/check-provider-error-cause.ts --json
 *   node --experimental-strip-types scripts/check-provider-error-cause.ts \
 *     --providers-dir=/tmp/scratch-copy      (test seam; probes never touch src/)
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript-v6';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const DEFAULT_PROVIDERS_DIR = join(REPO_ROOT, 'src', 'provisioning', 'providers');
const ERROR_HANDLER_PATH = join(REPO_ROOT, 'src', 'utils', 'error-handler.ts');

/** The root of cdkd's error hierarchy; every checked class descends from it. */
const ERROR_ROOT = 'CdkdError';

// ---------------------------------------------------------------------------
// FLOORS
// ---------------------------------------------------------------------------
/** Minimum provider files a healthy scan sees. */
const MIN_PROVIDER_FILES = 60;
/** Minimum error constructions a healthy scan sees across those files. */
const MIN_ERROR_CONSTRUCTIONS = 600;
/** Minimum catch-sited constructions a healthy scan sees. */
const MIN_CATCH_SITED_CONSTRUCTIONS = 250;
/**
 * Minimum HELPER-sited constructions a healthy scan sees.
 *
 * Measured at exactly 5 — the five `wrapError` / `wrapUpdateError` helpers,
 * each of which is ONE construction serving MANY throw sites (33 in total:
 * appsync 9, the three rds-dbproxy files 21, microvm 3). The floor counts
 * constructions because that is what this critic classifies, but the blast
 * radius of one regression here is the throw-site count, not 1.
 *
 * The floor is what stops the helper analysis from silently regressing back to
 * the purely-lexical rule: that regression moves all 5 into `no-cause-in-scope`
 * and leaves every other count identical, so nothing else would notice.
 */
const MIN_HELPER_SITED_CONSTRUCTIONS = 5;
/** Minimum ALREADY-THREADED constructions a healthy scan sees. */
const MIN_THREADED_CONSTRUCTIONS = 250;
/** Minimum size of the DERIVED error-class table. */
const MIN_ERROR_CLASSES = 20;

export type SiteContext = 'catch' | 'catch-no-binding' | 'helper' | 'no-catch';
export type SiteVerdict = 'threaded' | 'dropped' | 'no-cause-in-scope';

export interface CauseSite {
  readonly file: string;
  readonly line: number;
  readonly errorClass: string;
  readonly context: SiteContext;
  /** Name(s) of the caught value in scope, when there is one. */
  readonly caughtBinding?: string;
  readonly verdict: SiteVerdict;
}

export interface CauseReport {
  readonly filesScanned: number;
  readonly constructions: number;
  readonly catchSited: number;
  readonly helperSited: number;
  readonly threaded: number;
  readonly dropped: number;
  readonly validation: number;
  readonly errorClasses: number;
  readonly sites: readonly CauseSite[];
}

/** Error class name -> zero-based index of its `cause` constructor parameter. */
export type ErrorClassTable = ReadonlyMap<string, number>;

// ---------------------------------------------------------------------------
// Error-class table — DERIVED, never hardcoded
// ---------------------------------------------------------------------------

/**
 * An allowlist of error classes is the one thing in a checker like this that
 * fails SILENTLY: a class missing from it is not reported as unknown, it is
 * simply never analyzed. That is not hypothetical — `HostedZoneNameNotFoundError`
 * (declared inside `route53-provider.ts`, extending `ProvisioningError` with the
 * same cause index) was invisible to the hardcoded table, and a catch-sited
 * construction of it that dropped its cause passed with counts unchanged.
 *
 * So the table is derived from the source of truth: every class that
 * transitively extends {@link ERROR_ROOT}, with its `cause` parameter position
 * read off its own constructor (or inherited from its base when it declares
 * none). Provider-LOCAL classes are added per-file by {@link analyzeFile}, which
 * is what covers the route53 case.
 *
 * Note the positional index itself does not need fencing: adding a parameter
 * before `cause` makes every site of that class read `dropped`, which is loud.
 * It is the class SET that fails quietly, and that is what this derives.
 */
function collectErrorClasses(
  source: ts.SourceFile,
  known: Map<string, number>
): Map<string, number> {
  const declarations: { name: string; base: string; causeIndex?: number }[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const base = node.heritageClauses
        ?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)
        ?.types[0]?.expression;
      if (base && ts.isIdentifier(base)) {
        const constructor = node.members.find(ts.isConstructorDeclaration);
        const index = constructor?.parameters.findIndex(
          (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === 'cause'
        );
        declarations.push({
          name: node.name.text,
          base: base.text,
          ...(index !== undefined && index >= 0 ? { causeIndex: index } : {}),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  // Resolve to a fixpoint: a subclass may be declared before its base.
  const table = new Map(known);
  const rooted = new Set<string>([ERROR_ROOT, ...known.keys()]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (rooted.has(declaration.name)) continue;
      if (!rooted.has(declaration.base)) continue;
      rooted.add(declaration.name);
      const inherited = table.get(declaration.base);
      const index = declaration.causeIndex ?? inherited;
      if (index !== undefined) table.set(declaration.name, index);
      changed = true;
    }
  }
  return table;
}

/** The base table, derived from `src/utils/error-handler.ts`. */
export function buildErrorClassTable(errorHandlerPath = ERROR_HANDLER_PATH): ErrorClassTable {
  const text = readFileSync(errorHandlerPath, 'utf8');
  const source = parseSource(errorHandlerPath, text);
  return collectErrorClasses(source, new Map());
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

class ParseFailure extends Error {}

function parseSource(fileName: string, text: string): ts.SourceFile {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  // A file that does not parse contributes ZERO sites, which reads exactly like
  // a clean file. The floors have enough slack to hide several such files, so
  // the diagnostics are checked rather than the counts.
  const diagnostics =
    (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const detail = first ? ts.flattenDiagnosticMessageText(first.messageText, ' ') : 'unknown';
    throw new ParseFailure(`${fileName} failed to parse (${diagnostics.length} errors): ${detail}`);
  }
  return source;
}

// ---------------------------------------------------------------------------
// Scope + threading analysis
// ---------------------------------------------------------------------------

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isTypeAssertionExpression(current)) current = current.expression;
    else if (ts.isSatisfiesExpression(current)) current = current.expression;
    else return current;
  }
}

function isUndefinedLiteral(node: ts.Node): boolean {
  const inner = unwrap(node);
  return (
    (ts.isIdentifier(inner) && inner.text === 'undefined') ||
    inner.kind === ts.SyntaxKind.NullKeyword
  );
}

/**
 * The declaration of `name` NEAREST the use, walking outward through enclosing
 * scopes only. A scope-blind search would credit a `const cause = error` in a
 * SIBLING block or a nested arrow to an unrelated site.
 */
function nearestDeclaration(use: ts.Node, name: string): ts.Node | undefined {
  let current: ts.Node | undefined = use;
  while (current) {
    const statements = (current as unknown as { statements?: ts.NodeArray<ts.Statement> })
      .statements;
    if (statements) {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (
            ts.isIdentifier(declaration.name) &&
            declaration.name.text === name &&
            declaration.initializer
          ) {
            return declaration.initializer;
          }
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Is `expression` THE caught value bound to one of `targets`?
 *
 * Structural on purpose. "Does this expression mention the binding?" answers
 * yes for `new Error(error.message)` and for `result.error`, and the first of
 * those is the realistic regression: it looks like threading, reads like
 * threading, and is exactly as inert as passing nothing.
 */
function isThreaded(expression: ts.Node, targets: ReadonlySet<string>, depth = 0): boolean {
  if (depth > 8) return false;
  const node = unwrap(expression);

  if (ts.isIdentifier(node)) {
    if (targets.has(node.text)) return true;
    const declaration = nearestDeclaration(node, node.text);
    // A local alias (`const cause = error instanceof Error ? error : undefined`)
    // is the reference shape, so it must resolve — but only through its OWN
    // nearest declaration, and only to something itself accepted.
    return declaration ? isThreaded(declaration, targets, depth + 1) : false;
  }

  if (ts.isConditionalExpression(node)) {
    const branches = [node.whenTrue, node.whenFalse];
    const accepted = branches.filter((branch) => isThreaded(branch, targets, depth + 1));
    const inert = branches.filter((branch) => isUndefinedLiteral(branch));
    return accepted.length > 0 && accepted.length + inert.length === branches.length;
  }

  if (ts.isBinaryExpression(node)) {
    const operator = node.operatorToken.kind;
    if (
      operator === ts.SyntaxKind.QuestionQuestionToken ||
      operator === ts.SyntaxKind.BarBarToken ||
      operator === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      return (
        isThreaded(node.left, targets, depth + 1) || isThreaded(node.right, targets, depth + 1)
      );
    }
    return false;
  }

  // Everything else — a property access, a call, a `new`, a literal, an object
  // or template expression — is a DERIVED value, not the caught one.
  return false;
}

// ---------------------------------------------------------------------------
// Helper (non-lexical) caught-value propagation
// ---------------------------------------------------------------------------

interface FunctionLike {
  readonly node: ts.Node;
  readonly parameters: readonly string[];
}

/** Every named function-like in a file, keyed by the name a caller would use. */
function collectFunctions(source: ts.SourceFile): Map<string, FunctionLike[]> {
  const functions = new Map<string, FunctionLike[]>();

  const record = (name: string, node: ts.Node, parameters: ts.NodeArray<ts.ParameterDeclaration>) => {
    const names = parameters.map((parameter) =>
      ts.isIdentifier(parameter.name) ? parameter.name.text : ''
    );
    const existing = functions.get(name) ?? [];
    existing.push({ node, parameters: names });
    functions.set(name, existing);
  };

  const visit = (node: ts.Node): void => {
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name) {
      if (ts.isIdentifier(node.name)) record(node.name.text, node, node.parameters);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        record(node.name.text, initializer, initializer.parameters);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return functions;
}

function calleeName(call: ts.CallExpression): string | undefined {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) return callee.text;
  // `this.wrapError(...)` / `self.wrapError(...)`
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) return callee.name.text;
  return undefined;
}

/**
 * Which parameters of which functions receive a caught value, to a FIXPOINT.
 *
 * Seeded from every call inside a lexical `catch` that passes the binding, then
 * grown: a helper that forwards its caught-value parameter to another helper
 * makes that one a caught-value parameter too.
 */
function resolveHelperBindings(
  source: ts.SourceFile,
  functions: ReadonlyMap<string, FunctionLike[]>
): Map<ts.Node, Set<string>> {
  const helperTargets = new Map<ts.Node, Set<string>>();

  const targetsAt = (node: ts.Node): Set<string> => {
    const targets = new Set<string>();
    let current: ts.Node | undefined = node;
    while (current) {
      if (ts.isCatchClause(current)) {
        const declaration = current.variableDeclaration;
        if (declaration && ts.isIdentifier(declaration.name)) targets.add(declaration.name.text);
      }
      const inherited = helperTargets.get(current);
      if (inherited) for (const name of inherited) targets.add(name);
      current = current.parent;
    }
    return targets;
  };

  let changed = true;
  let rounds = 0;
  while (changed && rounds < 10) {
    changed = false;
    rounds += 1;

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const targets = targetsAt(node);
        if (targets.size > 0) {
          const name = calleeName(node);
          const candidates = name ? (functions.get(name) ?? []) : [];
          for (const candidate of candidates) {
            node.arguments.forEach((argument, index) => {
              if (!isThreaded(argument, targets)) return;
              const parameter = candidate.parameters[index];
              if (!parameter) return;
              const existing = helperTargets.get(candidate.node) ?? new Set<string>();
              if (existing.has(parameter)) return;
              existing.add(parameter);
              helperTargets.set(candidate.node, existing);
              changed = true;
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return helperTargets;
}

// ---------------------------------------------------------------------------
// Per-file analysis
// ---------------------------------------------------------------------------

let baseTableCache: ErrorClassTable | undefined;
function baseTable(): ErrorClassTable {
  baseTableCache ??= buildErrorClassTable();
  return baseTableCache;
}

export function analyzeFile(
  fileName: string,
  sourceText: string,
  table: ErrorClassTable = baseTable()
): CauseSite[] {
  const source = parseSource(fileName, sourceText);
  // Provider-LOCAL error classes (route53's HostedZoneNameNotFoundError) are
  // declared in the same file they are constructed in.
  const classes = collectErrorClasses(source, new Map(table));
  const functions = collectFunctions(source);
  const helperTargets = resolveHelperBindings(source, functions);
  const sites: CauseSite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const errorClass = node.expression.text;
      const causeIndex = classes.get(errorClass);
      if (causeIndex !== undefined) {
        sites.push(classify(node, errorClass, causeIndex, fileName, source, helperTargets));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return sites;
}

function classify(
  node: ts.NewExpression,
  errorClass: string,
  causeIndex: number,
  fileName: string,
  source: ts.SourceFile,
  helperTargets: ReadonlyMap<ts.Node, ReadonlySet<string>>
): CauseSite {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const base = { file: fileName, line, errorClass } as const;

  const targets = new Set<string>();
  let context: SiteContext = 'no-catch';
  let sawBindinglessCatch = false;

  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isCatchClause(current)) {
      const declaration = current.variableDeclaration;
      if (declaration && ts.isIdentifier(declaration.name)) {
        targets.add(declaration.name.text);
        context = 'catch';
      } else {
        sawBindinglessCatch = true;
      }
    }
    const helper = helperTargets.get(current);
    if (helper) {
      for (const name of helper) targets.add(name);
      if (context !== 'catch') context = 'helper';
    }
    current = current.parent;
  }

  if (targets.size === 0) {
    return {
      ...base,
      context: sawBindinglessCatch ? 'catch-no-binding' : 'no-catch',
      verdict: 'no-cause-in-scope',
    };
  }

  const argument = (node.arguments ?? [])[causeIndex];
  const threaded = argument !== undefined && isThreaded(argument, targets);

  return {
    ...base,
    context,
    caughtBinding: [...targets].join('/'),
    verdict: threaded ? 'threaded' : 'dropped',
  };
}

// ---------------------------------------------------------------------------
// Self-probe — the defense against COLLAPSE TOWARD GREEN
// ---------------------------------------------------------------------------

interface SelfProbe {
  readonly name: string;
  readonly source: string;
  readonly expected: readonly SiteVerdict[];
}

/**
 * Floors cannot see a classifier that degrades to "everything is threaded":
 * the counts are unchanged and the printed line is byte-identical. These fixed
 * sources have known verdicts INCLUDING dropped ones, and are analyzed on every
 * run before the real tree is read, so such a degradation fails loudly.
 */
const SELF_PROBES: readonly SelfProbe[] = [
  {
    name: 'reference shape (const alias) threads',
    source: `try { go(); } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError('m', 't', 'l', 'p', cause);
    }`,
    expected: ['threaded'],
  },
  {
    name: 'omitted cause argument is dropped',
    source: `try { go(); } catch (error) {
      throw new ProvisioningError(String(error), 't', 'l', 'p');
    }`,
    expected: ['dropped'],
  },
  {
    name: 'explicit undefined in the cause position is dropped',
    source: `try { go(); } catch (error) {
      throw new ProvisioningError(String(error), 't', 'l', 'p', undefined);
    }`,
    expected: ['dropped'],
  },
  {
    name: 'a cause DERIVED from the binding is dropped',
    source: `try { go(); } catch (error) {
      const cause = new Error(error instanceof Error ? error.message : String(error));
      throw new ProvisioningError('m', 't', 'l', 'p', cause);
    }`,
    expected: ['dropped'],
  },
  {
    name: 'a property access that merely mentions the binding is dropped',
    source: `try { go(); } catch (error) {
      throw new ProvisioningError('m', 't', 'l', 'p', error.message);
    }`,
    expected: ['dropped'],
  },
  {
    name: 'a helper handed the caught value is checked, and can be dropped',
    source: `class P {
      run() { try { go(); } catch (error) { throw this.wrapError(error, 'op'); } }
      wrapError(err: unknown, op: string): ProvisioningError {
        return new ProvisioningError(op, 't', 'l', 'p');
      }
    }`,
    expected: ['dropped'],
  },
  {
    name: 'a helper that threads the caught value passes',
    source: `class P {
      run() { try { go(); } catch (error) { throw this.wrapError(error, 'op'); } }
      wrapError(err: unknown, op: string): ProvisioningError {
        const cause = err instanceof Error ? err : undefined;
        return new ProvisioningError(op, 't', 'l', 'p', cause);
      }
    }`,
    expected: ['threaded'],
  },
  {
    name: 'a validation throw outside any catch is not checked',
    source: `if (!x) { throw new ProvisioningError('required', 't', 'l'); }`,
    expected: ['no-cause-in-scope'],
  },
  {
    name: 'a bare `catch {` binds nothing, so there is no cause to thread',
    source: `try { go(); } catch {
      throw new ProvisioningError('gone', 't', 'l');
    }`,
    expected: ['no-cause-in-scope'],
  },
  {
    name: 'a sibling block’s `const cause = error` does not credit an unrelated site',
    source: `function f() {
      { const cause = new Error('x'); use(cause); }
      try { go(); } catch (error) {
        throw new ProvisioningError('m', 't', 'l', 'p', cause);
      }
    }`,
    expected: ['dropped'],
  },
  {
    name: 'a locally-declared subclass of ProvisioningError is checked',
    source: `class LocalNotFoundError extends ProvisioningError {
      constructor(message: string, resourceType: string, logicalId: string, physicalId?: string, cause?: Error) {
        super(message, resourceType, logicalId, physicalId, cause);
      }
    }
    function f() { try { go(); } catch (error) { throw new LocalNotFoundError('m', 't', 'l', 'p'); } }`,
    expected: ['dropped'],
  },
  {
    name: 'ResourceUpdateNotSupportedError uses its own cause position',
    source: `try { go(); } catch (error) {
      throw new ResourceUpdateNotSupportedError('t', 'l', String(error));
    }`,
    expected: ['dropped'],
  },
];

export function runSelfProbes(table: ErrorClassTable = baseTable()): string[] {
  const failures: string[] = [];
  for (const probe of SELF_PROBES) {
    let actual: SiteVerdict[];
    try {
      actual = analyzeFile(`self-probe/${probe.name}.ts`, probe.source, table).map((s) => s.verdict);
    } catch (error) {
      failures.push(
        `self-probe "${probe.name}" threw: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    if (actual.length !== probe.expected.length || actual.some((v, i) => v !== probe.expected[i])) {
      failures.push(
        `self-probe "${probe.name}": expected [${probe.expected.join(', ')}], got [${actual.join(', ')}]`
      );
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function listProviderFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch (error) {
      throw new ParseFailure(
        `cannot read directory ${current}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    for (const entry of entries) {
      const full = join(current, entry);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(full).isDirectory();
      } catch (error) {
        // A dangling symlink is a broken tree, not something to skip quietly.
        throw new ParseFailure(
          `cannot stat ${full}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      if (isDirectory) walk(full);
      else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(dir);
  return out;
}

export function buildReport(providersDir: string, table: ErrorClassTable = baseTable()): CauseReport {
  const files = listProviderFiles(providersDir);
  const sites: CauseSite[] = [];

  for (const file of files) {
    const rel = relative(REPO_ROOT, file);
    sites.push(...analyzeFile(rel, readFileSync(file, 'utf8'), table));
  }

  return {
    filesScanned: files.length,
    constructions: sites.length,
    catchSited: sites.filter((s) => s.context === 'catch').length,
    helperSited: sites.filter((s) => s.context === 'helper').length,
    threaded: sites.filter((s) => s.verdict === 'threaded').length,
    dropped: sites.filter((s) => s.verdict === 'dropped').length,
    validation: sites.filter((s) => s.verdict === 'no-cause-in-scope').length,
    errorClasses: table.size,
    sites,
  };
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

function main(argv: readonly string[]): number {
  let providersDir = DEFAULT_PROVIDERS_DIR;
  let json = false;

  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--providers-dir=')) {
      providersDir = resolve(arg.slice('--providers-dir='.length));
    } else {
      process.stderr.write(`Unrecognized argument: ${arg}\n`);
      return 2;
    }
  }

  const failures: string[] = [];

  let table: ErrorClassTable;
  try {
    table = buildErrorClassTable();
  } catch (error) {
    process.stderr.write(
      `provider error-cause check FAILED: could not derive the error-class table: ` +
        `${error instanceof Error ? error.message : String(error)}\n`
    );
    return 1;
  }

  // COLLAPSE TOWARD GREEN — checked FIRST, before any real file is read.
  failures.push(...runSelfProbes(table));

  if (table.size < MIN_ERROR_CLASSES) {
    failures.push(
      `derived ${table.size} error classes from src/utils/error-handler.ts, expected at least ` +
        `${MIN_ERROR_CLASSES} (class-hierarchy walk regression?)`
    );
  }
  for (const [name, index] of [
    ['ProvisioningError', 4],
    ['ResourceUpdateNotSupportedError', 3],
  ] as const) {
    if (table.get(name) !== index) {
      failures.push(
        `expected ${name} to carry its cause at argument index ${index}, derived ` +
          `${table.get(name) ?? 'nothing'} (error-handler.ts signature changed?)`
      );
    }
  }

  let report: CauseReport | undefined;
  try {
    report = buildReport(providersDir, table);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (report) {
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    // COLLAPSE TOWARD ZERO.
    const floors: [number, number, string][] = [
      [report.filesScanned, MIN_PROVIDER_FILES, 'provider files scanned'],
      [report.constructions, MIN_ERROR_CONSTRUCTIONS, 'error constructions'],
      [report.catchSited, MIN_CATCH_SITED_CONSTRUCTIONS, 'catch-sited constructions'],
      [report.helperSited, MIN_HELPER_SITED_CONSTRUCTIONS, 'helper-sited constructions'],
      [report.threaded, MIN_THREADED_CONSTRUCTIONS, 'cause-threaded constructions'],
    ];
    for (const [actual, minimum, label] of floors) {
      if (actual < minimum) {
        failures.push(`found ${actual} ${label}, expected at least ${minimum} (parser regression?)`);
      }
    }

    for (const site of report.sites) {
      if (site.verdict !== 'dropped') continue;
      const binding = site.caughtBinding ?? 'error';
      failures.push(
        `${site.file}:${site.line}: ${site.errorClass} built with the caught value ` +
          `\`${binding}\` in scope (${site.context}) but NOT threaded as \`cause\`. ` +
          `The transient-error classifiers walk \`.cause\`, so this AWS failure is ` +
          `classified on its interpolated message alone. Thread the caught value itself: ` +
          `\`const cause = ${binding} instanceof Error ? ${binding} : undefined;\` — note a ` +
          `DERIVED value (\`new Error(${binding}.message)\`) is just as inert.`
      );
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`provider error-cause check FAILED (${failures.length} problems)\n\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.stderr.write('\n');
    return 1;
  }

  process.stdout.write(
    `provider error-cause check OK — ${report?.filesScanned} files, ` +
      `${report?.constructions} error constructions across ${report?.errorClasses} error classes ` +
      `(${report?.threaded} cause-threaded: ${report?.catchSited} in a catch + ` +
      `${report?.helperSited} via a helper; ${report?.validation} validation / no cause in scope; ` +
      `${report?.dropped} dropped)\n`
  );
  return 0;
}

/**
 * `import.meta.url === \`file://${process.argv[1]}\`` is WRONG in two ways that
 * both end in the script exiting 0 having done nothing — the precise vacuous
 * green the FLOORS exist to forbid. Node resolves the main module to its
 * REALPATH while `argv[1]` keeps the symlink, and a path needing
 * percent-encoding (a space, a `#`) never string-matches its file URL.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fileURLToPath(import.meta.url) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  // `process.exit()` truncates a large `--json` payload on a pipe (measured:
  // 131072 of 167186 bytes, i.e. invalid JSON for any consumer). Setting the
  // code lets stdout drain and the process end on its own.
  process.exitCode = main(process.argv.slice(2));
}
