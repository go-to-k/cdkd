/**
 * `withRetry` interrupt-threading critic (issue #2053).
 *
 * WHAT THIS CHECKS
 * ----------------
 * `docs/provider-development.md` states as mandatory that a new `withRetry`
 * thread `isInterrupted` / `onInterrupted`. The reason is structural rather
 * than stylistic: the deploy engine, `destroy-runner.ts` and
 * `rollback-executor.ts` all poll for an interrupt only BETWEEN operations, and
 * `withRetry` is the only thing that looks at one DURING a backoff (it probes
 * once a second while sleeping). A call that omits the pair therefore leaves
 * Ctrl-C dead for its whole schedule — minutes on the DynamoDB and Cloud Map
 * sites — and on the destroy path `withResourceTimeout` has by then abandoned
 * the promise, so the loop keeps issuing writes behind a run the user was told
 * had ended.
 *
 * Measured when issue #2053 was filed: 11 `withRetry(` call sites under
 * `src/provisioning/providers/**` and `isInterrupted` in exactly ONE of them,
 * the site issue #2033 had just added. A convention the docs call mandatory and
 * one site in eleven honors is not a convention; it teaches the next author the
 * wrong pattern. This critic is what makes it one.
 *
 * The reference shape is `custom-resource-provider.ts`:
 *
 *   const watch = startInterruptWatch(`... ${logicalId}`);
 *   try {
 *     await withRetry(op, logicalId, {
 *       logger: this.logger,
 *       isInterrupted: watch.isInterrupted,
 *       onInterrupted: watch.onInterrupted,
 *     });
 *   } finally {
 *     watch.dispose();
 *   }
 *
 * WHAT COUNTS AS A DEFECT
 * -----------------------
 *  - `threaded` — the options object literal carries BOTH properties AND both
 *    read them off the SAME watch object, which was itself produced by the
 *    shared `startInterruptWatch`. This is the only passing verdict.
 *
 *    PRESENCE alone was the first cut and it is not enough: `isInterrupted: ()
 *    => false` declares the property and disables the mechanism, which is a
 *    checker that verifies its own spelling rather than its own effect. Reading
 *    the values off ONE watch also rules out the subtler shape of two watches
 *    whose flags cannot agree.
 *
 *    Provenance is checkable only because there is ONE helper to point at
 *    (issue #2104 consolidated four module-local copies into
 *    `src/provisioning/interrupt-watch.ts`), and it is what makes the LATCH and
 *    the listener policy non-regressable rather than only the threading.
 *  - `dropped`  — no options argument at all, or one that names neither or only
 *    one of the pair. Half a pair is still a defect: `withRetry` falls back to
 *    a bare `new Error('Interrupted')` when `onInterrupted` is missing, which
 *    reaches the user with no resource in it, and an `onInterrupted` without an
 *    `isInterrupted` is never called.
 *  - `opaque`   — the options argument is not an object literal (an identifier,
 *    a spread, a call). Reported as a defect rather than skipped: a site this
 *    checker cannot READ is a site it cannot guard, and skipping it silently is
 *    the failure mode a critic exists to not have. Inline the bag.
 *
 * A SECOND rule runs per FILE rather than per call site: every watch a scanned
 * file starts must be `dispose()`d from inside a `finally`. This is the
 * highest-value shape now that the latch is STICKY — a leaked watch stays in
 * the live set forever, so after one Ctrl-C every later wait aborts instantly.
 * A `dispose()` on the happy path only is exactly the case that leaks, since
 * the throw it must survive is the interrupt itself.
 *
 * Both rules resolve IMPORT ALIASES. `import { withRetry as retry }` and
 * `import { startInterruptWatch as watch }` are legal, and a name-only match
 * would have stopped seeing a renamed site while still reporting a clean
 * sweep — a silent hole in exactly the direction floors cannot detect.
 *
 * SCOPE
 * -----
 * `src/provisioning/**` — issue #2053's `providers/**` plus
 * `dynamodb-index-busy-delete.ts`, the shared delete-retry module both DynamoDB
 * providers read, which is issue #1952's site and lives one directory up.
 *
 * {@link EXEMPT} carries the one file in that tree deliberately outside the
 * rule, and its entries are AUDITED on every run: an exempt path that no longer
 * exists, or no longer contains a `withRetry` at all, FAILS. An allow-list
 * nobody re-checks goes inert exactly when it stops being needed, and then
 * hides the next real entry.
 *
 * USAGE
 *   node --experimental-strip-types scripts/check-withretry-interrupt.ts
 *   node --experimental-strip-types scripts/check-withretry-interrupt.ts --json
 *   node --experimental-strip-types scripts/check-withretry-interrupt.ts \
 *     --scan-dir=/tmp/scratch-copy      (test seam; probes never touch src/)
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript-v6';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const SCAN_ROOT_REL = join('src', 'provisioning');
const DEFAULT_SCAN_DIR = join(REPO_ROOT, SCAN_ROOT_REL);

/** The two options a `withRetry` must carry, per `docs/provider-development.md`. */
const REQUIRED_OPTIONS = ['isInterrupted', 'onInterrupted'] as const;

/** The ONE helper allowed to produce the watch those options read from. */
const WATCH_FACTORY = 'startInterruptWatch';
/** The module that exports it — matched on the SPECIFIER, not on the name alone. */
const WATCH_MODULE_SUFFIX = 'interrupt-watch.js';
/** The retry helper whose call sites this critic governs. */
const RETRY_FN = 'withRetry';

/**
 * Call sites deliberately outside the rule, keyed by repo-relative path.
 *
 * `describe-type.ts` wraps a single CloudFormation `DescribeType` schema fetch
 * on the ANALYSIS path — it runs before any resource is provisioned, is not
 * reachable from a provider `create` / `update` / `delete`, and neither the
 * deploy engine nor `destroy-runner.ts` is inside a resource operation while it
 * runs, so there is no abandoned-promise half of the problem to solve. Widening
 * the rule to it is a separate decision with its own call-site audit.
 *
 * Every entry is re-audited on each run (see {@link auditExemptions}).
 */
const EXEMPT: ReadonlyMap<string, string> = new Map([
  [
    'src/provisioning/describe-type.ts',
    'analysis-path schema fetch, not reachable from a provider operation',
  ],
]);

// ---------------------------------------------------------------------------
// FLOORS — "found nothing" must never read as "everything matches"
// ---------------------------------------------------------------------------
/** Minimum `.ts` files a healthy scan walks under the scan root. */
const MIN_FILES_SCANNED = 60;
/**
 * Minimum `withRetry` call sites a healthy scan FINDS.
 *
 * Measured at 12 when this landed (11 under `providers/**` — the 10 issue #2053
 * enumerated plus the #2033 one — and 1 in `dynamodb-index-busy-delete.ts`).
 * The floor sits below that rather than at it so a site that is legitimately
 * DELETED does not fail the build, while a parser or path regression that
 * finds none or a handful still does. It is the count that fails silently: a
 * dropped site fails loudly on its own.
 */
const MIN_WITHRETRY_SITES = 10;
/** Minimum sites a healthy scan finds THREADED (every non-exempt site is). */
const MIN_THREADED_SITES = 10;
/** Minimum distinct files carrying at least one site. */
const MIN_FILES_WITH_SITES = 4;
/**
 * Minimum `startInterruptWatch` bindings a healthy scan finds.
 *
 * A separate floor from the site count because the two collapse for DIFFERENT
 * reasons: the site floor dies if `withRetry` stops being recognised, this one
 * if the import-alias resolution or the `interrupt-watch.js` specifier match
 * breaks — and that failure is the quiet one, since every site would then read
 * `unshared` and the run would fail for a misleading reason.
 */
const MIN_WATCH_BINDINGS = 8;

export type SiteVerdict = 'threaded' | 'dropped' | 'opaque' | 'unshared';

export interface RetrySite {
  readonly file: string;
  readonly line: number;
  readonly verdict: SiteVerdict;
  /** Which of {@link REQUIRED_OPTIONS} the options bag names. */
  readonly present: readonly string[];
  /** Why an `opaque` / `unshared` site failed. */
  readonly reason?: string;
}

/** A `const w = startInterruptWatch(...)` binding, and how it is released. */
export interface WatchBinding {
  readonly file: string;
  readonly line: number;
  readonly name: string;
  /** True when a `<name>.dispose()` call sits lexically inside a `finally`. */
  readonly disposedInFinally: boolean;
}

export interface InterruptReport {
  readonly filesScanned: number;
  readonly filesWithSites: number;
  readonly sites: number;
  readonly threaded: number;
  readonly dropped: number;
  readonly opaque: number;
  readonly unshared: number;
  readonly exempt: number;
  readonly watches: number;
  readonly leakedWatches: number;
  readonly siteList: readonly RetrySite[];
  readonly watchList: readonly WatchBinding[];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

class ScanFailure extends Error {}

function parseSource(fileName: string, text: string): ts.SourceFile {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  // A file that fails to parse contributes ZERO sites, which reads exactly like
  // a file with none. The floors have slack enough to hide several, so the
  // diagnostics are checked rather than left to the counts.
  const diagnostics =
    (source as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const detail = first ? ts.flattenDiagnosticMessageText(first.messageText, ' ') : 'unknown';
    throw new ScanFailure(`${fileName} failed to parse (${diagnostics.length} errors): ${detail}`);
  }
  return source;
}

/**
 * Local names an import binds for `exported`, including aliases.
 *
 * A name-only match stops seeing a site the moment someone writes
 * `import { withRetry as retry }` — and it stops seeing it SILENTLY, while the
 * summary still reports a clean sweep. `moduleSuffix`, when given, also
 * requires the binding to come from the right module, so a same-named local
 * helper cannot pose as the shared one.
 */
function importedLocalNames(
  source: ts.SourceFile,
  exported: string,
  moduleSuffix?: string
): Set<string> {
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    if (moduleSuffix !== undefined && !specifier.text.endsWith(moduleSuffix)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const original = element.propertyName?.text ?? element.name.text;
      if (original === exported) names.add(element.name.text);
    }
  }
  return names;
}

/** `withRetry(...)`, `retry(...)` (aliased import) and `mod.withRetry(...)` all count. */
function isWithRetryCall(node: ts.CallExpression, localNames: ReadonlySet<string>): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    return callee.text === RETRY_FN || localNames.has(callee.text);
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
    return callee.name.text === RETRY_FN;
  }
  return false;
}

/**
 * Names bound by `const <name> = startInterruptWatch(...)` anywhere in the file.
 *
 * Collected per FILE rather than per scope on purpose: two watches in one file
 * are both legitimate, and the question a site is judged on is only whether the
 * object it reads came from the shared factory at all.
 */
/**
 * The declaration `name` resolves to at `use`, by LEXICAL scope.
 *
 * Walks outward through enclosing blocks, taking the first declaration found —
 * so two same-named watches in different blocks of one function resolve to the
 * right one each. Keying the dispose rule on the name plus the enclosing
 * FUNCTION (the previous cut) merged them, and one block's correct `finally`
 * then covered another block's leak.
 */
function resolveDeclaration(use: ts.Node, name: string): ts.Node | undefined {
  let current: ts.Node | undefined = use;
  while (current) {
    const statements = (current as unknown as { statements?: ts.NodeArray<ts.Statement> })
      .statements;
    if (statements) {
      for (const statement of statements) {
        if (!ts.isVariableStatement(statement)) continue;
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
            return declaration;
          }
        }
      }
    }
    current = current.parent;
  }
  return undefined;
}

/** The nearest enclosing function-like node, or the source file at top level. */
function enclosingFunction(node: ts.Node, source: ts.SourceFile): ts.Node {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ts.isArrowFunction(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isConstructorDeclaration(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      return current;
    }
    current = current.parent;
  }
  return source;
}

/**
 * Whether `call` is an UNCONDITIONAL statement of `block`.
 *
 * Nested plain blocks are transparent; anything else — an `if`, a loop, a
 * `try`, a `switch` — is not. `finally { if (flag) watch.dispose(); }` reads as
 * a release and is not one: it runs only when `flag` holds, and the throw it
 * has to survive is the interrupt, which is exactly when a guard like that
 * tends not to hold.
 */
function isUnconditionalStatementOf(call: ts.Node, block: ts.Block): boolean {
  let node: ts.Node | undefined = call;
  while (node && node.parent) {
    const parent: ts.Node = node.parent;
    if (parent === block) return ts.isExpressionStatement(node);
    if (ts.isBlock(parent) || ts.isExpressionStatement(parent)) {
      node = parent;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Watches a file starts, and whether each is released by a `finally` that
 * really runs.
 *
 * A dispose credits a declaration only when all three hold, and each clause
 * closed a measured false-clear:
 *
 *  - it resolves by LEXICAL SCOPE to that declaration (two same-named watches
 *    in sibling blocks used to share one key);
 *  - it is an UNCONDITIONAL statement of the `finally` (`if (flag)
 *    watch.dispose()` used to pass);
 *  - the `try` it belongs to sits in the SAME function as the declaration (a
 *    `finally` inside an unrelated nested callback used to pass, though that
 *    callback may never run).
 */
function collectWatchBindings(
  file: string,
  source: ts.SourceFile,
  factoryNames: ReadonlySet<string>
): WatchBinding[] {
  const declared = new Map<ts.Node, { name: string; line: number }>();
  const released = new Set<ts.Node>();

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer;
      if (
        ts.isCallExpression(init) &&
        ts.isIdentifier(init.expression) &&
        factoryNames.has(init.expression.text)
      ) {
        declared.set(node, {
          name: node.name.text,
          line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        });
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.name) &&
      node.expression.name.text === 'dispose' &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const name = node.expression.expression.text;
      // Find the `finally` block this call sits directly inside, if any.
      let cursor: ts.Node | undefined = node;
      let owningTry: ts.TryStatement | undefined;
      while (cursor && cursor.parent) {
        const parent: ts.Node = cursor.parent;
        if (ts.isTryStatement(parent) && parent.finallyBlock === cursor) {
          owningTry = parent;
          break;
        }
        cursor = parent;
      }
      if (
        owningTry?.finallyBlock &&
        isUnconditionalStatementOf(node, owningTry.finallyBlock) &&
        enclosingFunction(node, source) === enclosingFunction(owningTry, source)
      ) {
        const declaration = resolveDeclaration(node, name);
        if (
          declaration !== undefined &&
          enclosingFunction(declaration, source) === enclosingFunction(owningTry, source)
        ) {
          released.add(declaration);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return [...declared.entries()].map(([declaration, info]) => ({
    file,
    line: info.line,
    name: info.name,
    disposedInFinally: released.has(declaration),
  }));
}

/** The watch identifier a threaded option reads from, e.g. `watch` in `watch.isInterrupted`. */
function watchOperandOf(node: ts.Expression | undefined): string | undefined {
  if (node === undefined) return undefined;
  const inner = unwrapExpression(node);
  if (!ts.isPropertyAccessExpression(inner)) return undefined;
  if (!ts.isIdentifier(inner.expression)) return undefined;
  return inner.expression.text;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current: ts.Expression = node;
  for (;;) {
    if (ts.isParenthesizedExpression(current)) current = current.expression;
    else if (ts.isNonNullExpression(current)) current = current.expression;
    else if (ts.isAsExpression(current)) current = current.expression;
    else return current;
  }
}

/** The option assignments an object literal declares, by name. Spreads are not entries. */
function declaredOptions(
  literal: ts.ObjectLiteralExpression
): Map<string, ts.Expression | undefined> {
  const found = new Map<string, ts.Expression | undefined>();
  for (const property of literal.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = property.name;
      if (ts.isIdentifier(name)) found.set(name.text, property.initializer);
      else if (ts.isStringLiteral(name)) found.set(name.text, property.initializer);
    } else if (ts.isShorthandPropertyAssignment(property)) {
      // `{ isInterrupted }` names the option but says nothing about where the
      // value came from, so it can never satisfy the provenance rule.
      found.set(property.name.text, undefined);
    }
  }
  return found;
}

export function analyzeFile(file: string, text: string): AnalyzedFile {
  const source = parseSource(file, text);
  const retryNames = importedLocalNames(source, RETRY_FN);
  const factoryNames = importedLocalNames(source, WATCH_FACTORY, WATCH_MODULE_SUFFIX);
  const watches = collectWatchBindings(file, source, factoryNames);
  const watchNames = new Set(watches.map((w) => w.name));
  const sites: RetrySite[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isWithRetryCall(node, retryNames)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const options = node.arguments[2];
      if (options === undefined) {
        sites.push({ file, line, verdict: 'dropped', present: [] });
      } else if (!ts.isObjectLiteralExpression(options)) {
        sites.push({
          file,
          line,
          verdict: 'opaque',
          present: [],
          reason: `the options argument is a ${ts.SyntaxKind[options.kind]}, not an object literal`,
        });
      } else {
        const declared = declaredOptions(options);
        const present = REQUIRED_OPTIONS.filter((name) => declared.has(name));
        if (present.length !== REQUIRED_OPTIONS.length) {
          sites.push({ file, line, verdict: 'dropped', present });
        } else {
          // PROVENANCE. Both values must read off ONE identifier that this file
          // bound from the shared factory. `isInterrupted: () => false` names
          // the option and disables the mechanism; two different watches cannot
          // agree with each other.
          const operands = REQUIRED_OPTIONS.map((name) => watchOperandOf(declared.get(name)));
          const [first] = operands;
          const shared =
            first !== undefined && operands.every((o) => o === first) && watchNames.has(first);
          sites.push({
            file,
            line,
            verdict: shared ? 'threaded' : 'unshared',
            present,
            ...(shared
              ? {}
              : {
                  reason:
                    operands.some((o) => o === undefined) || first === undefined
                      ? `both options must read off one \`${WATCH_FACTORY}\` result ` +
                        `(e.g. \`isInterrupted: watch.isInterrupted\`), not an inline expression`
                      : operands.every((o) => o === first)
                        ? `\`${first}\` is not bound from \`${WATCH_FACTORY}\` imported from ` +
                          `\`${WATCH_MODULE_SUFFIX}\` in this file`
                        : `the two options read off DIFFERENT objects (${operands.join(' / ')}), ` +
                          `so their flags cannot agree`,
                }),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { sites, watches };
}

export interface AnalyzedFile {
  readonly sites: readonly RetrySite[];
  readonly watches: readonly WatchBinding[];
}

// ---------------------------------------------------------------------------
// Self-probes — the defense against COLLAPSE TOWARD GREEN
// ---------------------------------------------------------------------------

interface SelfProbe {
  readonly name: string;
  readonly source: string;
  readonly expected: readonly SiteVerdict[];
}

/** The import + binding every provenance-passing probe needs in scope. */
const SHARED_WATCH_PRELUDE = `import { startInterruptWatch } from '../interrupt-watch.js';
    const watch = startInterruptWatch('w');`;

/**
 * Floors cannot see a classifier that degrades to "everything is threaded":
 * the counts are unchanged and the printed summary is byte-identical. These
 * fixed sources have known verdicts INCLUDING failing ones and are analyzed on
 * every run BEFORE the real tree is read, so such a degradation fails loudly.
 */
const SELF_PROBES: readonly SelfProbe[] = [
  {
    name: 'the reference shape threads',
    source: `${SHARED_WATCH_PRELUDE}
    try {
      await withRetry(op, id, {
        logger: this.logger,
        isInterrupted: watch.isInterrupted,
        onInterrupted: watch.onInterrupted,
      });
    } finally {
      watch.dispose();
    }`,
    expected: ['threaded'],
  },
  {
    name: 'an ALIASED withRetry import is still a site',
    source: `import { withRetry as retryOp } from '../../deployment/retry.js';
    ${SHARED_WATCH_PRELUDE}
    await retryOp(op, id, { logger });`,
    expected: ['dropped'],
  },
  {
    name: 'an ALIASED startInterruptWatch import still counts as provenance',
    source: `import { startInterruptWatch as makeWatch } from '../interrupt-watch.js';
    const w = makeWatch('x');
    try {
      await withRetry(op, id, { isInterrupted: w.isInterrupted, onInterrupted: w.onInterrupted });
    } finally {
      w.dispose();
    }`,
    expected: ['threaded'],
  },
  {
    name: 'shorthand properties name the options but prove no provenance',
    source: `await withRetry(op, id, { isInterrupted, onInterrupted });`,
    expected: ['unshared'],
  },
  {
    name: 'a value that DISABLES the mechanism is not threading',
    source: `${SHARED_WATCH_PRELUDE}
    await withRetry(op, id, { isInterrupted: () => false, onInterrupted: () => new Error('x') });`,
    expected: ['unshared'],
  },
  {
    name: 'an explicit undefined in both options is not threading',
    source: `${SHARED_WATCH_PRELUDE}
    await withRetry(op, id, { isInterrupted: undefined, onInterrupted: undefined });`,
    expected: ['unshared'],
  },
  {
    name: 'a watch NOT from the shared factory is not threading',
    source: `const watch = makeMyOwnWatch('x');
    await withRetry(op, id, { isInterrupted: watch.isInterrupted, onInterrupted: watch.onInterrupted });`,
    expected: ['unshared'],
  },
  {
    name: 'two DIFFERENT watches cannot agree, so the pair is not threading',
    source: `import { startInterruptWatch } from '../interrupt-watch.js';
    const a = startInterruptWatch('a');
    const b = startInterruptWatch('b');
    await withRetry(op, id, { isInterrupted: a.isInterrupted, onInterrupted: b.onInterrupted });`,
    expected: ['unshared'],
  },
  {
    name: 'no options argument at all is dropped',
    source: `await withRetry(op, id);`,
    expected: ['dropped'],
  },
  {
    name: 'an options bag naming neither is dropped',
    source: `${SHARED_WATCH_PRELUDE}
    await withRetry(op, id, { logger: this.logger, maxRetries: 8 });`,
    expected: ['dropped'],
  },
  {
    name: 'HALF the pair is still dropped (isInterrupted only)',
    source: `${SHARED_WATCH_PRELUDE}
    await withRetry(op, id, { isInterrupted: watch.isInterrupted });`,
    expected: ['dropped'],
  },
  {
    name: 'HALF the pair is still dropped (onInterrupted only)',
    source: `${SHARED_WATCH_PRELUDE}
    await withRetry(op, id, { onInterrupted: watch.onInterrupted });`,
    expected: ['dropped'],
  },
  {
    name: 'a conditional SPREAD does not count as declaring the pair',
    source: `await withRetry(op, id, { ...(w && { isInterrupted: w.a, onInterrupted: w.b }) });`,
    expected: ['dropped'],
  },
  {
    name: 'an options bag the checker cannot read is opaque, never skipped',
    source: `await withRetry(op, id, retryOptions);`,
    expected: ['opaque'],
  },
  {
    name: 'a method-call spelling is found too',
    source: `await retry.withRetry(op, id, { logger });`,
    expected: ['dropped'],
  },
  {
    name: 'a same-named property that is not a call is not a site',
    source: `const opts = { withRetry: true };`,
    expected: [],
  },
  {
    name: 'nested calls are both found',
    source: `${SHARED_WATCH_PRELUDE}
    await withRetry(
      () =>
        withRetry(inner, id, {
          isInterrupted: watch.isInterrupted,
          onInterrupted: watch.onInterrupted,
        }),
      id,
      { logger }
    );`,
    expected: ['dropped', 'threaded'],
  },
];

export function runSelfProbes(): string[] {
  const failures: string[] = [];
  for (const probe of SELF_PROBES) {
    let actual: SiteVerdict[];
    try {
      actual = analyzeFile(`self-probe/${probe.name}.ts`, probe.source).sites.map((s) => s.verdict);
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
// Exemption audit
// ---------------------------------------------------------------------------

/**
 * An exemption is only meaningful while the thing it exempts still exists and
 * still has something to exempt. Both are checked, because either failure turns
 * the entry into dead text that the next reader trusts.
 */
export function auditExemptions(scanDir: string): string[] {
  const failures: string[] = [];
  for (const [rel, reason] of EXEMPT) {
    // Keyed repo-relative, resolved against the SCAN ROOT, so the probe seam
    // audits the scratch copy it was pointed at rather than the real tree.
    const full = join(scanDir, relative(SCAN_ROOT_REL, rel));
    let text: string;
    try {
      text = readFileSync(full, 'utf8');
    } catch {
      failures.push(
        `exempt path ${rel} no longer exists (reason on file: "${reason}") — drop the entry`
      );
      continue;
    }
    if (analyzeFile(rel, text).sites.length === 0) {
      failures.push(
        `exempt path ${rel} contains no \`withRetry\` call any more (reason on file: ` +
          `"${reason}") — the exemption is inert, drop it`
      );
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current).sort();
    } catch (error) {
      throw new ScanFailure(
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
        throw new ScanFailure(
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

export function buildReport(scanDir: string): InterruptReport {
  const files = listSourceFiles(scanDir);
  const sites: RetrySite[] = [];
  const watches: WatchBinding[] = [];
  let exempt = 0;

  for (const file of files) {
    // Reported relative to the REPO, and relative to the SCAN ROOT when the
    // probe seam points elsewhere, so a scratch-copy run still prints a path a
    // reader can act on.
    const rel = file.startsWith(REPO_ROOT)
      ? relative(REPO_ROOT, file)
      : join(SCAN_ROOT_REL, relative(scanDir, file));
    const found = analyzeFile(rel, readFileSync(file, 'utf8'));
    if (EXEMPT.has(rel)) {
      exempt += found.sites.length;
      continue;
    }
    sites.push(...found.sites);
    watches.push(...found.watches);
  }

  return {
    filesScanned: files.length,
    filesWithSites: new Set(sites.map((s) => s.file)).size,
    sites: sites.length,
    threaded: sites.filter((s) => s.verdict === 'threaded').length,
    dropped: sites.filter((s) => s.verdict === 'dropped').length,
    opaque: sites.filter((s) => s.verdict === 'opaque').length,
    unshared: sites.filter((s) => s.verdict === 'unshared').length,
    exempt,
    watches: watches.length,
    leakedWatches: watches.filter((w) => !w.disposedInFinally).length,
    siteList: sites,
    watchList: watches,
  };
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

function main(argv: readonly string[]): number {
  let scanDir = DEFAULT_SCAN_DIR;
  let json = false;

  for (const arg of argv) {
    if (arg === '--json') {
      json = true;
    } else if (arg.startsWith('--scan-dir=')) {
      scanDir = resolve(arg.slice('--scan-dir='.length));
    } else {
      process.stderr.write(`Unrecognized argument: ${arg}\n`);
      return 2;
    }
  }

  const failures: string[] = [];

  // COLLAPSE TOWARD GREEN — checked FIRST, before any real file is read.
  failures.push(...runSelfProbes());
  failures.push(...auditExemptions(scanDir));

  let report: InterruptReport | undefined;
  try {
    report = buildReport(scanDir);
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (report) {
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    // COLLAPSE TOWARD ZERO.
    const floors: [number, number, string][] = [
      [report.filesScanned, MIN_FILES_SCANNED, 'source files scanned'],
      [report.sites, MIN_WITHRETRY_SITES, '`withRetry` call sites found'],
      [report.threaded, MIN_THREADED_SITES, 'interrupt-threaded call sites'],
      [report.filesWithSites, MIN_FILES_WITH_SITES, 'files carrying a call site'],
      [report.watches, MIN_WATCH_BINDINGS, '`startInterruptWatch` bindings found'],
    ];
    for (const [actual, minimum, label] of floors) {
      if (actual < minimum) {
        failures.push(`found ${actual} ${label}, expected at least ${minimum} (scan regression?)`);
      }
    }

    // THE LEAK RULE. Highest-value shape now that the latch is STICKY: a watch
    // that is never disposed stays in the live set forever, so after one Ctrl-C
    // every later wait aborts instantly. A `dispose()` on the happy path only is
    // exactly the case that leaks, because the throw it must survive IS the
    // interrupt.
    for (const watch of report.watchList) {
      if (watch.disposedInFinally) continue;
      failures.push(
        `${watch.file}:${watch.line}: the watch \`${watch.name}\` is never ` +
          `\`dispose()\`d from a \`finally\`. A leaked watch stays live for the rest of the ` +
          `process, and because the SIGINT latch is STICKY that makes every later wait abort ` +
          `instantly after a single Ctrl-C. Wrap the wait in \`try { ... } finally { ` +
          `${watch.name}.dispose(); }\` — a \`dispose()\` on the success path alone does not ` +
          `count, since the throw it has to survive is the interrupt itself.`
      );
    }

    for (const site of report.siteList) {
      if (site.verdict === 'threaded') continue;
      const missing = REQUIRED_OPTIONS.filter((name) => !site.present.includes(name));
      const detail =
        site.verdict === 'opaque'
          ? `${site.reason} — inline the options bag so this rule can be checked`
          : site.verdict === 'unshared'
            ? `both option names are present but ${site.reason}`
            : `it does not thread ${missing.map((m) => `\`${m}\``).join(' / ')}`;
      failures.push(
        `${site.file}:${site.line}: \`withRetry\` is not interruptible — ${detail}. ` +
          `Ctrl-C is dead for this call's whole backoff schedule, and on the destroy path ` +
          `\`withResourceTimeout\` has already abandoned the promise, so the loop keeps ` +
          `issuing writes behind a run the user was told had ended. Install one watch per ` +
          `WAIT (never on \`this\` — providers are singletons serving concurrent resources), ` +
          `pass \`isInterrupted\` / \`onInterrupted\`, and \`dispose()\` it in a \`finally\`. ` +
          `Reference: src/provisioning/providers/custom-resource-provider.ts.`
      );
    }
  }

  if (failures.length > 0) {
    process.stderr.write(`withRetry interrupt check FAILED (${failures.length} problems)\n\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.stderr.write('\n');
    return 1;
  }

  process.stdout.write(
    `withRetry interrupt check OK — ${report?.filesScanned} files scanned, ` +
      `${report?.sites} \`withRetry\` sites across ${report?.filesWithSites} files, ` +
      `all threaded from one of ${report?.watches} shared \`${WATCH_FACTORY}\` bindings, ` +
      `every one disposed in a \`finally\` (${report?.exempt} exempt site(s) skipped)\n`
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
  process.exitCode = main(process.argv.slice(2));
}
