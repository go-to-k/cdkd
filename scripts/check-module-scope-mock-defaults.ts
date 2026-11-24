/**
 * Mock-default fence for `tests/unit/**` (issue #6928).
 *
 * WHAT THIS CHECKS
 * ----------------
 * A mock behavior installed where `mockReset` would WIPE it before a test
 * runs. `vite.config.ts` sets `mockReset: true`, which calls
 * `vi.resetAllMocks()` before EVERY test attempt (vitest's `onBeforeTryTask`
 * -> `clearModuleMocks`), after `beforeAll` and before `beforeEach`. A default
 * set anywhere but a `beforeEach` or a test body is gone by then, and a wiped
 * default returns `undefined`, which absence assertions still accept — the
 * test goes silently vacuous instead of red. Every such site is refused; there
 * is no allow-list.
 *
 * THE CALL SHAPES (what `mockReset` wipes, read from `@vitest/spy`)
 * ---------------------------------------------------------------
 * `mockReset()` sets the implementation back to the one the mock was CREATED
 * with and drains the `*Once` queue. So the class is every setter that writes
 * either: `mockImplementation`, `mockReturnValue`, `mockResolvedValue`,
 * `mockRejectedValue`, `mockThrow`, `mockReturnThis`, and every `*Once`
 * variant ({@link SETTERS}). On any receiver: `vi.fn()...`, `vi.mocked(x)...`,
 * `vi.spyOn(o, k)...` (a spy resets to its pass-through) alike.
 *
 * NOT in the class: `vi.fn(impl)`. `fn()` creates the mock with
 * `resetToMockImplementation: true`, so `mockReset()` restores `impl` — that
 * spelling SURVIVES the reset and is the remedy, not the defect. Nor
 * `withImplementation` (scoped to its callback) or `mockName`.
 *
 * WHERE A SETTER IS SAFE (the only two places)
 * -------------------------------------------
 * Inside a function passed to `beforeEach`, or to `it` / `test` (any chain:
 * `.each(t)`, `.only`, `.skip`, `.concurrent`, ...). Everything else is
 * REFUSED, each with its reason:
 *   - module scope, and a `describe` / `suite` body (it runs at COLLECTION,
 *     so an indented call there is module scope — the hidden mass a column-0
 *     grep cannot see);
 *   - a `vi.mock` factory and a `vi.hoisted` callback (run at import);
 *   - a `beforeAll`, `afterAll`, `afterEach`, `aroundAll` or `aroundEach`
 *     callback, and an `onTestFinished` / `onTestFailed` one (reason
 *     `afterEach`): each runs where the next test's reset wipes what it set.
 * A `vi.doMock` factory, an IIFE and any other call's function argument
 * (`forEach`, `new Promise`) runs where it is passed, so it takes its CALLER's
 * context. A function passed to `vi.fn(...)` or to a setter runs when the mock
 * is CALLED (bound 2).
 *
 * NAMED HELPERS are resolved within the file. A function declaration or a
 * `const f = () => ...` defers its body; its context is its WORST in-file
 * reference's: refused (called at module scope, passed to `beforeAll`, called
 * from a refused helper), then unresolved, then safe (`beforeEach(setup)`, a
 * call from a test). A `typeof f` or a value reference is not a call.
 * Resolution is by NAME, so two same-named helpers in different scopes are
 * merged (fail-closed).
 *
 * ACROSS FILES, one hop: an imported helper (like
 * `tests/unit/provisioning/s3-create-client-forward.ts`'s `forwardedS3Client`)
 * is resolved at each importing call site — a static named or namespace import,
 * `const { f } = await import('./x.js')`, or `(await import('./x.js')).f()`.
 * Called from a refused context, every setter the helper reaches (through the
 * in-file helpers it calls too) is a refused site OF THE IMPORTING FILE, `via`
 * naming the helper. The helper's own file judges them by its own calls.
 *
 * WHAT THIS DOES NOT CATCH (bounded; 1-3 are counted as `unresolved`, 4 is not)
 * ----------------------------------------------------------------------------
 *  1. An exported helper called only from another module's helper (the hop is
 *     one deep), from a file outside `tests/unit`, via a bare specifier, a
 *     barrel re-export (`export { f } from './h.js'`) or a directory import;
 *     and an anonymous `export default function`.
 *  2. A function that is neither a named helper nor a call argument: an object
 *     or class METHOD, a property value, an array element (an `it.each` table
 *     row's callback), a returned closure, and an implementation passed TO
 *     `vi.fn` or a setter (it runs when the mock is called).
 *  3. A helper referenced only from such a function, or only in a cycle.
 *  4. A setter reached by an element access (`m['mockReturnValue']`), or a
 *     custom test function (`const myTest = test.extend(...)`; `myTest(...)` is
 *     read as an ordinary call, so its body inherits — fail-closed).
 * `unresolved` sites are reported in `--json` so the bound stays visible; they
 * are NOT gated, so a new one does not fail the run. Bound 2 is real: a setter
 * on a mock a `vi.mock` factory's closure builds (a client class as
 * `vi.fn().mockImplementation(...)`, a long-lived client's `send`) is wiped
 * by the reset too; suites went red that way when `mockReset: true` landed
 * (#6928). Spell it `vi.fn(impl)`.
 *
 * WHAT DEFENDS THIS CHECKER FROM ITSELF
 * -------------------------------------
 * A parse diagnostic in any scanned file fails the run (an unparsed file reads
 * exactly like a clean one), as does an empty scan. The unit suite
 * `tests/unit/scripts/module-scope-mock-defaults.test.ts` pins each shape above
 * on synthetic sources, floors the real tree's file and safe-site counts, and
 * fails if `vite.config.ts` stops setting `mockReset: true`.
 *
 * USAGE
 *   node --experimental-strip-types scripts/check-module-scope-mock-defaults.ts --check
 *   ... --json                    machine-readable report
 *   ... --root=<dir>              test seam: scan a scratch copy
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `typescript-v6` is an npm alias of typescript@6 — TS7 ships the stable
// compiler API only under `typescript/unstable/*`. Same import the sibling
// critics use.
import ts from 'typescript-v6';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
/** The scanned tree, relative to the scan root (the repo, or a scratch copy). */
export const SCAN_SUBDIR = 'tests/unit';

/** Every setter whose effect `mockReset()` undoes (see the header). */
export const SETTERS: ReadonlySet<string> = new Set([
  'mockImplementation',
  'mockImplementationOnce',
  'mockReturnValue',
  'mockReturnValueOnce',
  'mockResolvedValue',
  'mockResolvedValueOnce',
  'mockRejectedValue',
  'mockRejectedValueOnce',
  'mockThrow',
  'mockThrowOnce',
  'mockReturnThis',
]);

/** Why a site is refused. */
export type RefusalReason =
  | 'module-scope'
  | 'describe-body'
  | 'vi.mock-factory'
  | 'vi.hoisted'
  | 'beforeAll'
  | 'afterAll'
  | 'afterEach'
  | 'aroundAll'
  | 'aroundEach';

type Context =
  | { readonly kind: 'safe' }
  | { readonly kind: 'refused'; readonly reason: RefusalReason }
  | { readonly kind: 'helper'; readonly name: string }
  | { readonly kind: 'unresolved' };

export type SiteVerdict = 'refused' | 'safe' | 'unresolved';

export interface Site {
  readonly line: number;
  readonly setter: string;
  readonly verdict: SiteVerdict;
  /** Set when `verdict` is `refused`. */
  readonly reason?: RefusalReason;
  /** The helper chain a refusal came through, outermost first. */
  readonly via?: readonly string[];
}

const SAFE: Context = { kind: 'safe' };
const UNRESOLVED: Context = { kind: 'unresolved' };
const refused = (reason: RefusalReason): Context => ({ kind: 'refused', reason });

/** `it.each(t)('x', fn)` -> `it`; `vi.mock` -> `vi`. The callee's root identifier. */
function calleeRoot(expression: ts.Expression): ts.Identifier | undefined {
  let node: ts.Expression = expression;
  for (;;) {
    if (ts.isIdentifier(node)) return node;
    if (ts.isPropertyAccessExpression(node)) node = node.expression;
    else if (ts.isCallExpression(node)) node = node.expression;
    else if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node)) node = node.expression;
    else return undefined;
  }
}

/** The first member name after `vi`, for `vi.mock` / `vi.hoisted` / `vi.fn`. */
function viMember(expression: ts.Expression): string | undefined {
  if (!ts.isPropertyAccessExpression(expression)) return undefined;
  if (!ts.isIdentifier(expression.expression) || expression.expression.text !== 'vi') return undefined;
  return expression.name.text;
}

/**
 * The context a function passed as an argument to `call` runs in, given the
 * context the call itself sits in.
 */
function argumentContext(call: ts.CallExpression, outer: Context): Context {
  const member = viMember(call.expression);
  if (member === 'mock') return refused('vi.mock-factory');
  if (member === 'hoisted') return refused('vi.hoisted');
  // `vi.fn(impl)`: the implementation runs when the mock is called.
  if (member === 'fn') return UNRESOLVED;
  // An implementation handed TO a setter runs when the mock is called.
  if (ts.isPropertyAccessExpression(call.expression) && SETTERS.has(call.expression.name.text)) {
    return UNRESOLVED;
  }
  const root = calleeRoot(call.expression)?.text;
  switch (root) {
    case 'it':
    case 'test':
    case 'beforeEach':
      return SAFE;
    case 'beforeAll':
    case 'afterAll':
    case 'afterEach':
    case 'aroundAll':
    case 'aroundEach':
      return refused(root);
    // Registered inside a test, run after it: the next reset wipes them.
    case 'onTestFinished':
    case 'onTestFailed':
      return refused('afterEach');
    case 'describe':
    case 'suite':
      // A describe body runs at collection: module scope when the describe is.
      return outer.kind === 'refused' && outer.reason === 'module-scope'
        ? refused('describe-body')
        : outer;
    default:
      return outer;
  }
}

function isFunctionLike(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** Strip `( ... )`, `x as T`, `x satisfies T`, `x!`. */
function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The specifier of `import('x')` / `await import('x')`, else undefined. */
function dynamicImportSpecifier(node: ts.Expression): string | undefined {
  const bare = unwrap(node);
  const call = ts.isAwaitExpression(bare) ? unwrap(bare.expression) : bare;
  if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) return undefined;
  const argument = call.arguments[0];
  return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

interface RawSite {
  readonly line: number;
  readonly setter: string;
  readonly context: Context;
}

interface Reference {
  readonly name: string;
  readonly context: Context;
}

/** A call into another module: `f()` with `f` imported, or `(await import('x')).f()`. */
interface RawExternalCall {
  readonly line: number;
  readonly context: Context;
  /** Set for a member call on an import; otherwise `local` names the binding. */
  readonly target?: { readonly specifier: string; readonly name: string };
  readonly local?: string;
}

/** A call into another module, resolved to a refusal at the call site. */
export interface ExternalCall {
  readonly line: number;
  readonly specifier: string;
  readonly name: string;
  readonly reason: RefusalReason;
  readonly via: readonly string[];
}

/** Parse diagnostics; `parseDiagnostics` is internal but stable across TS 4-6. */
function parseDiagnosticCount(source: ts.SourceFile): number {
  return ((source as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length;
}

export interface FileAnalysis {
  readonly sites: readonly Site[];
  readonly parseErrors: number;
  /**
   * Every setter site a named helper reaches (its own body plus the in-file
   * helpers it calls), keyed by helper name: they run wherever an importing
   * file calls it.
   */
  readonly pendingByHelper: Readonly<Record<string, readonly { line: number; setter: string }[]>>;
  /** Calls into other modules made from a refused context. */
  readonly refusedExternalCalls: readonly ExternalCall[];
}

interface Resolution {
  readonly context: Context;
  readonly via: readonly string[];
}

/** refused > unresolved > safe: a helper is as bad as its worst caller. */
const RANK: Record<Context['kind'], number> = { refused: 3, unresolved: 2, helper: 2, safe: 1 };

export function analyzeSource(fileName: string, text: string): FileAnalysis {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const rawSites: RawSite[] = [];
  const references: Reference[] = [];
  const externalCalls: RawExternalCall[] = [];
  const helpers = new Set<string>();
  /** Local binding -> what it imports. `name: '*'` is a namespace. */
  const imports = new Map<string, { specifier: string; name: string }>();
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imports.set(element.name.text, { specifier, name: (element.propertyName ?? element.name).text });
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      imports.set(bindings.name.text, { specifier, name: '*' });
    }
  }

  /** Walk a function's parameters and body in `context` (not the function node itself). */
  const visitBody = (fn: ts.Node, context: Context): void => {
    ts.forEachChild(fn, (child) => visit(child, context));
  };
  const visit = (node: ts.Node, context: Context): void => {
    // A named helper defers its body: `function f() {}`, `const f = () => {}`.
    if (ts.isFunctionDeclaration(node)) {
      if (node.name === undefined) {
        // `export default function () {}`: called from elsewhere, bound 1.
        visitBody(node, UNRESOLVED);
        return;
      }
      helpers.add(node.name.text);
      visitBody(node, { kind: 'helper', name: node.name.text });
      return;
    }
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
      const initializer = unwrap(node.initializer);
      if (ts.isIdentifier(node.name) && isFunctionLike(initializer)) {
        helpers.add(node.name.text);
        visitBody(initializer, { kind: 'helper', name: node.name.text });
        return;
      }
      // `const { f } = await import('x')` binds `f` like a static import.
      const specifier = dynamicImportSpecifier(initializer);
      if (specifier !== undefined && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          const exported = element.propertyName ?? element.name;
          if (ts.isIdentifier(element.name) && ts.isIdentifier(exported)) {
            imports.set(element.name.text, { specifier, name: exported.text });
          }
        }
      } else if (specifier !== undefined && ts.isIdentifier(node.name)) {
        imports.set(node.name.text, { specifier, name: '*' });
      }
    }
    // Methods, accessors, constructors, class bodies: bound 2.
    if (
      ts.isMethodDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isClassStaticBlockDeclaration(node)
    ) {
      ts.forEachChild(node, (child) => visit(child, UNRESOLVED));
      return;
    }

    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && SETTERS.has(node.expression.name.text)) {
        rawSites.push({ line: lineOf(node.expression.name), setter: node.expression.name.text, context });
      }
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee)) {
        // `f()`: a helper runs in its call site's context.
        references.push({ name: callee.text, context });
        externalCalls.push({ line: lineOf(node), context, local: callee.text });
      } else if (isFunctionLike(callee)) {
        // `(() => { ... })()`: an IIFE runs right here.
        visitBody(callee, context);
      } else {
        if (ts.isPropertyAccessExpression(callee)) {
          // `(await import('x')).f()` and `ns.f()` over an imported namespace.
          const specifier = dynamicImportSpecifier(callee.expression);
          const owner = unwrap(callee.expression);
          if (specifier !== undefined) {
            externalCalls.push({ line: lineOf(node), context, target: { specifier, name: callee.name.text } });
          } else if (ts.isIdentifier(owner)) {
            externalCalls.push({ line: lineOf(node), context, local: `${owner.text}.${callee.name.text}` });
          }
        }
        visit(node.expression, context);
      }
      for (const argument of node.arguments) {
        const bare = unwrap(argument);
        if (isFunctionLike(bare)) {
          visitBody(bare, argumentContext(node, context));
        } else if (ts.isIdentifier(bare)) {
          // `beforeEach(setup)`: the helper runs where a function argument would,
          // an imported one included (`beforeAll(importedSetup)`).
          const argContext = argumentContext(node, context);
          references.push({ name: bare.text, context: argContext });
          externalCalls.push({ line: lineOf(bare), context: argContext, local: bare.text });
        } else if (ts.isPropertyAccessExpression(bare) && ts.isIdentifier(unwrap(bare.expression))) {
          // `beforeAll(ns.setup)` over an imported namespace.
          const owner = unwrap(bare.expression) as ts.Identifier;
          externalCalls.push({
            line: lineOf(bare),
            context: argumentContext(node, context),
            local: `${owner.text}.${bare.name.text}`,
          });
          visit(argument, context);
        } else {
          visit(argument, context);
        }
      }
      return;
    }

    // Any other function expression (object property, array element, returned
    // closure): bound 2.
    if (isFunctionLike(node)) {
      ts.forEachChild(node, (child) => visit(child, UNRESOLVED));
      return;
    }

    ts.forEachChild(node, (child) => visit(child, context));
  };
  visit(source, refused('module-scope'));

  // Resolve each helper to its WORST reference's context (refused, then
  // unresolved, then safe). A reference-less helper is unresolved here; an
  // importing file resolves it (`pendingByHelper`).
  const resolved = new Map<string, Resolution>();
  const resolving = new Set<string>();
  const resolveHelper = (name: string): Resolution => {
    const cached = resolved.get(name);
    if (cached) return cached;
    if (resolving.has(name)) return { context: UNRESOLVED, via: [] };
    resolving.add(name);
    const mine = references.filter((reference) => reference.name === name);
    let best: Resolution | undefined = mine.length === 0 ? { context: UNRESOLVED, via: [] } : undefined;
    for (const reference of mine) {
      const outcome = resolveContext(reference.context);
      if (best === undefined || RANK[outcome.context.kind] > RANK[best.context.kind]) {
        best = { ...outcome, via: outcome.context.kind === 'refused' ? [...outcome.via, name] : [] };
      }
      if (best.context.kind === 'refused') break;
    }
    resolving.delete(name);
    resolved.set(name, best!);
    return best!;
  };
  const resolveContext = (context: Context): Resolution =>
    context.kind === 'helper' && helpers.has(context.name)
      ? resolveHelper(context.name)
      : context.kind === 'helper'
        ? { context: UNRESOLVED, via: [] }
        : { context, via: [] };

  const sites: Site[] = [];
  for (const raw of rawSites) {
    const { context, via } = resolveContext(raw.context);
    if (context.kind === 'refused') {
      sites.push({
        line: raw.line,
        setter: raw.setter,
        verdict: 'refused',
        reason: context.reason,
        ...(via.length > 0 ? { via: [...via] } : {}),
      });
      continue;
    }
    sites.push({ line: raw.line, setter: raw.setter, verdict: context.kind === 'safe' ? 'safe' : 'unresolved' });
  }

  // What each helper reaches, transitively through in-file helper calls —
  // regardless of how THIS file calls it, since an importer's call site is a
  // context of its own.
  const directSites = new Map<string, { line: number; setter: string }[]>();
  for (const raw of rawSites) {
    if (raw.context.kind !== 'helper') continue;
    const list = directSites.get(raw.context.name) ?? [];
    list.push({ line: raw.line, setter: raw.setter });
    directSites.set(raw.context.name, list);
  }
  const calls = new Map<string, Set<string>>();
  for (const reference of references) {
    if (reference.context.kind !== 'helper' || !helpers.has(reference.name)) continue;
    const set = calls.get(reference.context.name) ?? new Set<string>();
    set.add(reference.name);
    calls.set(reference.context.name, set);
  }
  const pendingByHelper: Record<string, { line: number; setter: string }[]> = {};
  for (const helper of helpers) {
    const seen = new Set<string>();
    const stack = [helper];
    const reached: { line: number; setter: string }[] = [];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      reached.push(...(directSites.get(current) ?? []));
      stack.push(...(calls.get(current) ?? []));
    }
    if (reached.length > 0) pendingByHelper[helper] = reached;
  }

  const refusedExternalCalls: ExternalCall[] = [];
  for (const call of externalCalls) {
    let target = call.target;
    if (target === undefined && call.local !== undefined) {
      const [head, member] = call.local.split('.');
      const bound = imports.get(head!);
      if (bound !== undefined && member === undefined && bound.name !== '*') target = bound;
      if (bound !== undefined && member !== undefined && bound.name === '*') {
        target = { specifier: bound.specifier, name: member };
      }
    }
    if (target === undefined) continue;
    const { context, via } = resolveContext(call.context);
    if (context.kind !== 'refused') continue;
    refusedExternalCalls.push({ line: call.line, ...target, reason: context.reason, via });
  }

  return { sites, parseErrors: parseDiagnosticCount(source), pendingByHelper, refusedExternalCalls };
}

function* walkTypeScriptFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkTypeScriptFiles(full);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) yield full;
  }
}

export interface FileReport {
  readonly file: string;
  readonly refused: readonly Site[];
}

export interface Report {
  readonly filesScanned: number;
  readonly parseErrors: readonly string[];
  /** Refused sites per file, every file with at least one. Each one fails the check. */
  readonly offenders: readonly FileReport[];
  readonly totals: {
    readonly safe: number;
    readonly refused: number;
    readonly unresolved: number;
    readonly byReason: Readonly<Record<string, number>>;
  };
  readonly unresolvedSites: readonly { file: string; line: number; setter: string }[];
}

export function buildReport(scanRoot: string = REPO_ROOT): Report {
  const dir = join(scanRoot, SCAN_SUBDIR);
  const parseErrors: string[] = [];
  const offenders: FileReport[] = [];
  const scanned = new Set<string>();
  const byReason: Record<string, number> = {};
  const unresolvedSites: { file: string; line: number; setter: string }[] = [];
  let safe = 0;
  let refusedTotal = 0;
  let unresolved = 0;

  // Pass 1: every file on its own.
  const analyses = new Map<string, { file: string; analysis: FileAnalysis }>();
  for (const full of walkTypeScriptFiles(dir)) {
    const file = relative(scanRoot, full).split('\\').join('/');
    scanned.add(file);
    analyses.set(full, { file, analysis: analyzeSource(full, readFileSync(full, 'utf8')) });
  }

  // Pass 2: a call from a refused context into a helper ANOTHER scanned file
  // exports, whose setters nothing in that file calls, is refused at the CALL
  // SITE (one hop; the remedy is either the call site or the helper).
  for (const [full, { file, analysis }] of analyses) {
    if (analysis.parseErrors > 0) parseErrors.push(file);
    const refusedSites: Site[] = analysis.sites.filter((s) => s.verdict === 'refused');
    for (const call of analysis.refusedExternalCalls) {
      if (!call.specifier.startsWith('.')) continue;
      const base = resolve(dirname(full), call.specifier);
      const candidates = [base.replace(/\.js$/, '.ts'), `${base}.ts`, base];
      const exporter = candidates.map((c) => analyses.get(c)).find((a) => a !== undefined);
      if (exporter === undefined || !Object.hasOwn(exporter.analysis.pendingByHelper, call.name)) continue;
      for (const site of exporter.analysis.pendingByHelper[call.name]!) {
        refusedSites.push({
          line: call.line,
          setter: site.setter,
          verdict: 'refused',
          reason: call.reason,
          via: [...call.via, `${exporter.file}#${call.name}`],
        });
      }
    }
    for (const site of analysis.sites) {
      if (site.verdict === 'safe') safe++;
      else if (site.verdict === 'unresolved') {
        unresolved++;
        unresolvedSites.push({ file, line: site.line, setter: site.setter });
      }
    }
    for (const site of refusedSites) {
      refusedTotal++;
      byReason[site.reason!] = (byReason[site.reason!] ?? 0) + 1;
    }
    if (refusedSites.length > 0) offenders.push({ file, refused: refusedSites });
  }
  offenders.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  return {
    filesScanned: scanned.size,
    parseErrors,
    offenders,
    totals: { safe, refused: refusedTotal, unresolved, byReason },
    unresolvedSites,
  };
}

export function reportFails(report: Report): boolean {
  return report.filesScanned === 0 || report.parseErrors.length > 0 || report.offenders.length > 0;
}

const TAG = '[module-scope-mock-defaults]';

function main(): void {
  const args = process.argv.slice(2);
  // Refuse what this command does not take, the removed `--update` and
  // `--allow-list=` included: ignoring one would print a report and exit 0.
  const unknown = args.filter((a) => a !== '--check' && a !== '--json' && !a.startsWith('--root='));
  if (unknown.length > 0) {
    console.error(`${TAG} unknown argument(s): ${unknown.join(' ')} (takes --check, --json, --root=<dir>)`);
    process.exitCode = 1;
    return;
  }
  const rootArg = args.find((a) => a.startsWith('--root='));
  const scanRoot = rootArg === undefined ? REPO_ROOT : resolve(rootArg.slice('--root='.length));
  const report = buildReport(scanRoot);

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `${TAG} ${report.filesScanned} files: ${report.totals.refused} refused sites in ` +
        `${report.offenders.length} files, ${report.totals.safe} safe, ${report.totals.unresolved} unresolved.`
    );
  }
  if (report.filesScanned === 0) console.error(`${TAG} scanned NO files under ${SCAN_SUBDIR}`);
  for (const file of report.parseErrors) console.error(`  PARSE  ${file} has parse errors`);
  for (const offender of report.offenders) {
    for (const site of offender.refused) {
      const via = site.via ? ` via ${site.via.join(' -> ')}()` : '';
      console.error(
        `  REFUSED ${offender.file}:${site.line} .${site.setter}() in ${site.reason}${via} — ` +
          'mockReset wipes it before every test; move it into beforeEach or give the mock its default as vi.fn(impl)'
      );
    }
  }

  if (args.includes('--check') && reportFails(report)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
