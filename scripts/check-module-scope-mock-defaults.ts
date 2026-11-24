/**
 * Module-scope mock-default fence for `tests/unit/**` (issue #6928, step 1).
 *
 * WHAT THIS CHECKS
 * ----------------
 * A mock behavior installed where `mockReset` would WIPE it before a test
 * runs. Issue #6928's goal is `mockReset: true` in `vite.config.ts`, which
 * calls `vi.resetAllMocks()` before EVERY test attempt (vitest's
 * `onBeforeTryTask` -> `clearModuleMocks`), after `beforeAll` and before
 * `beforeEach`. A default set anywhere but a `beforeEach` or a test body is
 * gone by then, and a wiped default returns `undefined`, which absence
 * assertions still accept (#1618: 1181 tests failed, and the rest were worse).
 * This check stops the population from GROWING; issue #6928 step 2 migrates
 * the grandfathered files and step 3 deletes the allow-list.
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
 *   - a `beforeAll`, `afterAll` or `afterEach` callback (each runs where the
 *     next test's reset wipes what it set).
 * A `vi.doMock` factory and any other call's function argument (`forEach`,
 * `new Promise`) runs where it is passed, so it takes its CALLER's context.
 *
 * NAMED HELPERS are resolved within the file. A function declaration or a
 * `const f = () => ...` defers its body; its context is the union of every
 * in-file REFERENCE's context — called at module scope, passed to `beforeAll`,
 * or called from another helper that is itself refused. `beforeEach(setup)`
 * passes it safely. Resolution is by NAME, so two same-named helpers in
 * different scopes are unioned (fail-closed).
 *
 * WHAT THIS DOES NOT CATCH (bounded, and counted as `unresolved`)
 * --------------------------------------------------------------
 *  1. A helper with no in-file reference — EXPORTED for another file. Following
 *     imports would make this a module-graph consumer; the importing file's
 *     call site is where a refusal would belong, and it is not visible here.
 *  2. A function that is neither a named helper nor a call argument: an object
 *     or class METHOD, a property value, an array element (an `it.each` table
 *     row's callback), a returned closure, and an implementation passed TO a
 *     setter (`mockImplementation(() => other.mockReturnValue(1))`, which runs
 *     when the mock is called).
 *  3. A helper referenced only from such a function, or only in a cycle.
 *  4. A setter reached by an element access (`m['mockReturnValue']`), or a
 *     custom test function (`const myTest = test.extend(...)`; `myTest(...)` is
 *     read as an ordinary call, so its body inherits — fail-closed).
 * `unresolved` sites are reported in `--json` so the bound stays visible.
 *
 * THE ALLOW-LIST SHRINKS, NEVER GROWS
 * -----------------------------------
 * `tests/module-scope-mock-defaults-allowlist.json` maps each grandfathered file
 * to its EXACT refused-site count. Every direction fails with its own message:
 * an unlisted file with a refused site (NEW), a listed file whose count rose
 * (GREW), a listed file whose count fell (LOWER: edit the number, or run
 * `--update`), a listed file now clean (STALE: delete the entry), a listed file
 * that no longer exists (DEAD). `--update` only lowers or removes entries; it
 * never adds one or raises a count, so it cannot launder a new default.
 *
 * WHAT DEFENDS THIS CHECKER FROM ITSELF
 * -------------------------------------
 * A parse diagnostic in any scanned file fails the run (an unparsed file reads
 * exactly like a clean one), and the unit suite
 * `tests/unit/scripts/module-scope-mock-defaults.test.ts` pins a floor per
 * refusal reason and per safe shape over the real tree.
 *
 * USAGE
 *   node --experimental-strip-types scripts/check-module-scope-mock-defaults.ts --check
 *   ... --json                    machine-readable report
 *   ... --update                  shrink the allow-list to the current tree
 *   ... --root=<dir> --allow-list=<file>   test seam: scan a scratch copy
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `typescript-v6` is an npm alias of typescript@6 — TS7 ships the stable
// compiler API only under `typescript/unstable/*`. Same import the sibling
// critics use.
import ts from 'typescript-v6';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
/** The scanned tree, relative to the scan root (the repo, or a scratch copy). */
export const SCAN_SUBDIR = 'tests/unit';
export const ALLOW_LIST_PATH = join(REPO_ROOT, 'tests/module-scope-mock-defaults-allowlist.json');

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
  | 'afterEach';

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

/** The first member name after `vi`, for `vi.mock` / `vi.hoisted` / `vi.doMock`. */
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
      return refused(root);
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

interface RawSite {
  readonly line: number;
  readonly setter: string;
  readonly context: Context;
}

interface Reference {
  readonly name: string;
  readonly context: Context;
}

/** Parse diagnostics; `parseDiagnostics` is internal but stable across TS 4-6. */
function parseDiagnosticCount(source: ts.SourceFile): number {
  return ((source as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? []).length;
}

export interface FileAnalysis {
  readonly sites: readonly Site[];
  readonly parseErrors: number;
}

export function analyzeSource(fileName: string, text: string): FileAnalysis {
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const rawSites: RawSite[] = [];
  const references: Reference[] = [];
  const helpers = new Set<string>();

  /** Walk a function's parameters and body in `context` (not the function node itself). */
  const visitBody = (fn: ts.Node, context: Context): void => {
    ts.forEachChild(fn, (child) => visit(child, context));
  };
  const visit = (node: ts.Node, context: Context): void => {
    // Types never run (and `ReturnType<typeof f>` is no call of `f`).
    if (ts.isTypeNode(node)) return;
    // A named helper defers its body: `function f() {}`, `const f = () => {}`.
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      helpers.add(node.name.text);
      const inner: Context = { kind: 'helper', name: node.name.text };
      node.parameters.forEach((p) => visit(p, inner));
      if (node.body) visit(node.body, inner);
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      isFunctionLike(unwrap(node.initializer))
    ) {
      helpers.add(node.name.text);
      visitBody(unwrap(node.initializer), { kind: 'helper', name: node.name.text });
      return;
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
        rawSites.push({
          line: source.getLineAndCharacterOfPosition(node.expression.name.getStart(source)).line + 1,
          setter: node.expression.name.text,
          context,
        });
      }
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee)) {
        // `f()`: a helper runs in its call site's context.
        references.push({ name: callee.text, context });
      } else if (isFunctionLike(callee)) {
        // `(() => { ... })()`: an IIFE runs right here.
        visitBody(callee, context);
      } else {
        visit(node.expression, context);
      }
      for (const argument of node.arguments) {
        const bare = unwrap(argument);
        if (isFunctionLike(bare)) {
          visitBody(bare, argumentContext(node, context));
        } else if (ts.isIdentifier(bare)) {
          // `beforeEach(setup)`: the helper runs where a function argument would.
          references.push({ name: bare.text, context: argumentContext(node, context) });
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

  // Resolve each helper to the union of its references' contexts. Refused wins
  // (fail-closed); a cycle or a reference-less helper is unresolved.
  const resolved = new Map<string, { context: Context; via: string[] }>();
  const resolving = new Set<string>();
  const resolveHelper = (name: string): { context: Context; via: string[] } => {
    const cached = resolved.get(name);
    if (cached) return cached;
    if (resolving.has(name)) return { context: UNRESOLVED, via: [] };
    resolving.add(name);
    let best: { context: Context; via: string[] } = { context: UNRESOLVED, via: [] };
    for (const reference of references) {
      if (reference.name !== name) continue;
      const outcome = resolveContext(reference.context);
      if (outcome.context.kind === 'refused') {
        best = { context: outcome.context, via: [...outcome.via, name] };
        break;
      }
      if (outcome.context.kind === 'safe') best = { context: SAFE, via: [] };
    }
    resolving.delete(name);
    resolved.set(name, best);
    return best;
  };
  const resolveContext = (context: Context): { context: Context; via: string[] } =>
    context.kind === 'helper' && helpers.has(context.name)
      ? resolveHelper(context.name)
      : context.kind === 'helper'
        ? { context: UNRESOLVED, via: [] }
        : { context, via: [] };

  const sites: Site[] = rawSites.map((raw) => {
    const { context, via } = resolveContext(raw.context);
    if (context.kind === 'refused') {
      return {
        line: raw.line,
        setter: raw.setter,
        verdict: 'refused',
        reason: context.reason,
        ...(via.length > 0 ? { via } : {}),
      };
    }
    return { line: raw.line, setter: raw.setter, verdict: context.kind === 'safe' ? 'safe' : 'unresolved' };
  });
  return { sites, parseErrors: parseDiagnosticCount(source) };
}

function* walkTypeScriptFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkTypeScriptFiles(full);
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) yield full;
  }
}

export interface AllowList {
  readonly $comment?: string;
  /** Repo-relative path -> exact refused-site count. */
  readonly files: Readonly<Record<string, number>>;
}

export function readAllowList(path: string = ALLOW_LIST_PATH): AllowList {
  return JSON.parse(readFileSync(path, 'utf8')) as AllowList;
}

export interface FileReport {
  readonly file: string;
  readonly refused: readonly Site[];
}

export interface Report {
  readonly filesScanned: number;
  readonly parseErrors: readonly string[];
  /** Refused sites per file, every file with at least one. */
  readonly offenders: readonly FileReport[];
  /** Offending files not on the list. */
  readonly newFiles: readonly FileReport[];
  /** Listed files whose count ROSE: { file, listed, actual }. */
  readonly grew: readonly { file: string; listed: number; actual: number }[];
  /** Listed files whose count FELL but is not zero. */
  readonly lower: readonly { file: string; listed: number; actual: number }[];
  /** Listed files that are clean now. */
  readonly stale: readonly string[];
  /** Listed files that do not exist. */
  readonly dead: readonly string[];
  readonly totals: {
    readonly safe: number;
    readonly refused: number;
    readonly unresolved: number;
    readonly byReason: Readonly<Record<string, number>>;
  };
  readonly unresolvedSites: readonly { file: string; line: number; setter: string }[];
}

export function buildReport(scanRoot: string = REPO_ROOT, allowList?: AllowList): Report {
  const allow = allowList ?? readAllowList();
  const dir = join(scanRoot, SCAN_SUBDIR);
  const parseErrors: string[] = [];
  const offenders: FileReport[] = [];
  const scanned = new Set<string>();
  const byReason: Record<string, number> = {};
  const unresolvedSites: { file: string; line: number; setter: string }[] = [];
  let safe = 0;
  let refusedTotal = 0;
  let unresolved = 0;

  for (const full of walkTypeScriptFiles(dir)) {
    const file = relative(scanRoot, full).split('\\').join('/');
    scanned.add(file);
    const analysis = analyzeSource(full, readFileSync(full, 'utf8'));
    if (analysis.parseErrors > 0) parseErrors.push(file);
    const refusedSites = analysis.sites.filter((s) => s.verdict === 'refused');
    for (const site of analysis.sites) {
      if (site.verdict === 'safe') safe++;
      else if (site.verdict === 'unresolved') {
        unresolved++;
        unresolvedSites.push({ file, line: site.line, setter: site.setter });
      } else {
        refusedTotal++;
        byReason[site.reason!] = (byReason[site.reason!] ?? 0) + 1;
      }
    }
    if (refusedSites.length > 0) offenders.push({ file, refused: refusedSites });
  }

  const listed = allow.files;
  const newFiles: FileReport[] = [];
  const grew: { file: string; listed: number; actual: number }[] = [];
  const lower: { file: string; listed: number; actual: number }[] = [];
  const offending = new Map(offenders.map((o) => [o.file, o]));
  for (const offender of offenders) {
    const count = Object.hasOwn(listed, offender.file) ? listed[offender.file] : undefined;
    if (count === undefined) newFiles.push(offender);
    else if (offender.refused.length > count) {
      grew.push({ file: offender.file, listed: count, actual: offender.refused.length });
    } else if (offender.refused.length < count) {
      lower.push({ file: offender.file, listed: count, actual: offender.refused.length });
    }
  }
  const stale: string[] = [];
  const dead: string[] = [];
  for (const file of Object.keys(listed).sort()) {
    if (!scanned.has(file)) dead.push(file);
    else if (!offending.has(file)) stale.push(file);
  }

  return {
    filesScanned: scanned.size,
    parseErrors,
    offenders,
    newFiles,
    grew,
    lower,
    stale,
    dead,
    totals: { safe, refused: refusedTotal, unresolved, byReason },
    unresolvedSites,
  };
}

export function reportFails(report: Report): boolean {
  return (
    report.filesScanned === 0 ||
    report.parseErrors.length > 0 ||
    report.newFiles.length > 0 ||
    report.grew.length > 0 ||
    report.lower.length > 0 ||
    report.stale.length > 0 ||
    report.dead.length > 0
  );
}

/** The allow-list `--update` writes: only lowered counts and removed entries. */
export function shrunkAllowList(allow: AllowList, report: Report): AllowList {
  const actual = new Map(report.offenders.map((o) => [o.file, o.refused.length]));
  const files: Record<string, number> = {};
  for (const file of Object.keys(allow.files).sort()) {
    const now = actual.get(file);
    if (now === undefined || now === 0) continue;
    files[file] = Math.min(now, allow.files[file]);
  }
  return { ...(allow.$comment !== undefined ? { $comment: allow.$comment } : {}), files };
}

const TAG = '[module-scope-mock-defaults]';

function main(): void {
  const args = process.argv.slice(2);
  const rootArg = args.find((a) => a.startsWith('--root='));
  const allowArg = args.find((a) => a.startsWith('--allow-list='));
  const scanRoot = rootArg === undefined ? REPO_ROOT : resolve(rootArg.slice('--root='.length));
  const allowPath = allowArg === undefined ? ALLOW_LIST_PATH : resolve(allowArg.slice('--allow-list='.length));
  const allow = readAllowList(allowPath);
  const report = buildReport(scanRoot, allow);

  if (args.includes('--update')) {
    writeFileSync(allowPath, `${JSON.stringify(shrunkAllowList(allow, report), null, 2)}\n`);
    console.log(`${TAG} allow-list shrunk to the current tree (never grown): ${allowPath}`);
    return;
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `${TAG} ${report.filesScanned} files: ${report.totals.refused} refused sites in ` +
        `${report.offenders.length} files (${Object.keys(allow.files).length} grandfathered), ` +
        `${report.totals.safe} safe, ${report.totals.unresolved} unresolved.`
    );
  }
  if (report.filesScanned === 0) console.error(`${TAG} scanned NO files under ${SCAN_SUBDIR}`);
  for (const file of report.parseErrors) console.error(`  PARSE  ${file} has parse errors`);
  for (const offender of report.newFiles) {
    for (const site of offender.refused) {
      const via = site.via ? ` via ${site.via.join(' -> ')}()` : '';
      console.error(
        `  NEW    ${offender.file}:${site.line} .${site.setter}() in ${site.reason}${via} — ` +
          'move it into beforeEach (after vi.resetAllMocks()) or give the mock its default as vi.fn(impl)'
      );
    }
  }
  for (const g of report.grew) {
    console.error(
      `  GREW   ${g.file}: ${g.actual} refused sites, allow-list says ${g.listed} — ` +
        'a grandfathered file may not gain a module-scope default (--json lists them)'
    );
  }
  for (const l of report.lower) {
    console.error(`  LOWER  ${l.file}: ${l.actual} refused sites now, allow-list says ${l.listed} — lower the entry (or --update)`);
  }
  for (const file of report.stale) console.error(`  STALE  ${file} is clean now — delete its entry (or --update)`);
  for (const file of report.dead) console.error(`  DEAD   ${file} does not exist — delete its entry (or --update)`);

  if (args.includes('--check') && reportFails(report)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
