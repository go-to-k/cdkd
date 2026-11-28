/**
 * Observed-baseline redaction critic (go-to-k/cdkd#6765): every value written
 * into a record's `observedProperties` is one the state redaction produced, or
 * one copied from a bag that is already in state.
 *
 * WHY
 * ---
 * `observedProperties` holds a live AWS readback, and a readback can carry the
 * plaintext a `{{resolve:...}}` reference resolved to (#1926, #2828), or a key
 * the record does not hold rendered from one that does (#5315: a Step
 * Functions `Definition` built from `DefinitionSubstitutions`). The redaction
 * (`redactForState` and its family, reached through `scrubResourceRecord`) is
 * what keeps that out of `state.json`. A writer handing a readback to the field
 * without it persists the secret, and nothing else fails. The #2828 regex
 * population test (`observed-properties-redaction-population.test.ts`) counts
 * the sites and checks one-line assignments; this critic follows each written
 * VALUE back to where it came from, through bindings, helpers and callbacks.
 *
 * THE POPULATION
 * --------------
 * Every file under `src/`. A WRITE SITE is:
 *  - `observedProperties: <v>` in an object literal, the shorthand
 *    `{ observedProperties }`, a class field of that name, and each `return`
 *    of a getter of that name;
 *  - `<x>.observedProperties = <v>` (and `['observedProperties']`, `??=`,
 *    `||=`, `&&=`), and `<x>[k] = <v>` for a KEY VARIABLE `k` (a `for ... of`
 *    variable over an array literal holding the name, or a parameter whose
 *    type names it);
 *  - an INTERIOR write into a stored bag: an assignment, a `set` / `push` /
 *    `unshift` / `add` / `splice`, `Object.assign`, `Object.defineProperty`,
 *    `Reflect.set` or a {@link MUTATORS} call whose target runs through
 *    `.observedProperties`, or through a local bound to one (any alias chain,
 *    `const { observedProperties } = r` included); and each such write a
 *    function the repo declares makes into its parameter when a call hands it
 *    a stored bag (one level);
 *  - an `'observedProperties'` string in any other value position (a computed
 *    key the critic cannot follow), which needs an {@link EXEMPTIONS} entry.
 * A destructuring pattern, a type member and `delete` write nothing.
 *
 * PROVENANCE
 * ----------
 * Each written value is followed to its ROOTS. A site passes when it reaches
 * at least one root and every root is one of:
 *  - `redactor`: a call to a {@link REDACTORS} function the redaction family
 *    declares, through the call's own lexical binding (a same-named local at
 *    any depth, or another import renamed onto the name, is not it);
 *  - `stored`: a read of `.observedProperties` off any object. Induction: every
 *    object holding that key got it at a write site this critic judges, or
 *    from state at rest, which those sites wrote. Also `r.observedProperties ??
 *    r.properties`, one receiver: the drift-baseline idiom;
 *  - `physical-id`: a read of `.physicalId`, which state keeps in plaintext
 *    beside the bag anyway;
 *  - `literal`: a literal, `undefined`, `null`, an empty object or array;
 *  - `redaction-input`: the site's object literal is itself the first argument
 *    of `scrubResourceRecord`, which redacts its `observedProperties`.
 * A value is followed through: a binding's initializer and every write into
 * it that can reach the member being followed (a reassignment, a member write,
 * `set` / `push`, `Object.assign`, `Object.defineProperty`, a
 * {@link MUTATORS} call); where the binding's object ESCAPES into a function
 * the repo declares, that function's writes into the parameter (for a
 * container the scope created, `{}` / `[]` / `new Map()` / a clone, also
 * through an alias, under a property name (every write through that name,
 * repo-wide), and into any other call or constructor, which is raw);
 * destructuring and `for ... of`; a member path (`args.report.state` is
 * `args` read at `report.state`, an object literal on the way read at that
 * member only); `?:` / `??` / `||` / `&&` / `??=`; an object or array
 * literal's members and spreads; a {@link CARRIERS} call (the argument it
 * carries); a call to a function the repo declares (its every `return` or
 * `yield`, its parameters bound to the call's arguments); a callback a helper
 * calls (`within(() => redactForState(...))`); a `.map` / `.flatMap`
 * callback; a subset method (`filter`, `slice`, ...); and a PARAMETER of a
 * named function, which moves the obligation to every call of it (renamed,
 * re-exported and namespace imports included). A callback's parameter outside
 * `.map` / `.flatMap`, a caught value, an unresolvable call, `new`, and
 * anything else is RAW, and a raw root fails the site. A branch the site's own
 * guards rule out is not followed: a site under `if (has)` (or a `?:` arm, an
 * `&&` right side, after `if (!has) return`) reads `has ? a : b` as `a`,
 * through parameter bindings, and skips a helper's `return` those facts rule
 * out.
 *
 * KNOWN BOUNDS
 * ------------
 *  (1) A {@link CARRIERS} entry is BELIEVED to return what its argument holds
 *      (plus marks or masks), and a {@link REDACTORS} entry to redact: the
 *      runtime twins in the unit test run each against a resolved secret. The
 *      redaction CONTEXT is not judged: `redactForState(v, { secrets: new
 *      Map() })` counts as redacted, as it is on an UNCHANGED resource.
 *  (2) Aliasing is followed only as far as stated above. Not seen: a write
 *      into a container through an alias the walk did not take (an array
 *      literal holding it, a shallow `{ ...bag }` copy's nested objects, a
 *      container a helper returned, a declared function's parameter passed on
 *      a second level, a method call `x.fill(bag)`, a `let` assigned a stored
 *      bag after its declaration, and, for a binding the scope did not
 *      create, an alias held anywhere but a local `const` (`holder.w = bag`,
 *      a `let` reassigned to it, `map.get(k)` / `arr[0]` after storing it, a
 *      class field) or a property name it is handed on under, `patch({ bag })`:
 *      following those repo-wide reaches most of `src/` and fails unrelated
 *      code). A local `const` alias through casts (an alias of an alias) IS
 *      followed, its writes and its escapes as the binding's; a member
 *      destructured off it, its own writes only. A field name
 *      spelled by computation (`rec['observed' + 'Properties']`) is no write
 *      site: an obfuscation, not a shape a writer reaches for.
 *  (3) A call is matched to a declaration by NAME (an import followed through
 *      re-exports to its module; a method call `x.name(...)` is unresolved and
 *      raw). A parameter's callers are every call of the function in its own
 *      file or a file importing it, and a function also used as a value
 *      (passed, not called) keeps its parameters raw. A recursive call (one
 *      inside the function's own body) is taken to hand on what the outer
 *      call was given: its own arguments are not judged (a recursion passing
 *      a fresh readback is not seen), and a cycle of bindings adds no root of
 *      its own.
 *      Bindings resolve to the nearest lexical declaration, flow-insensitively
 *      (a guard fact is the only branch read).
 *  (4) `stored` trusts a read of `.observedProperties` off ANY object: an
 *      object that gained the key without a judged write (a JSON body read
 *      from somewhere other than state) is believed. The baseline idiom trusts
 *      that receiver's `properties` too.
 *  (5) The deploy engine's capture drain installs a raw readback and relies on
 *      the persist choke point (`redactStateForPersist` -> `scrubResourceRecord`
 *      on every save): an EXEMPTIONS entry, whose wiring the unit test reads.
 *
 * Usage:
 *   node --experimental-strip-types scripts/check-observed-properties-redaction.ts
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript-v6';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIELD = 'observedProperties';
/** The redaction family: a redactor or carrier must be declared here. */
const REDACTION_DIR = 'src/deployment/secret-redaction';

/** Return a redacted copy of their first argument. */
export const REDACTORS: ReadonlySet<string> = new Set([
  'redactForState',
  'redactAtProvenance',
  'redactSecretsForState',
]);

/**
 * Return what argument `arg` holds, re-marked or re-masked, and nothing from
 * elsewhere: the critic follows that argument. Each must be imported from the
 * redaction family.
 */
export const CARRIERS: Readonly<Record<string, { arg: number; why: string }>> = {
  markSameGenerationBag: { arg: 0, why: 'returns its argument with a generation mark' },
  carryRedactionMarks: { arg: 1, why: 'returns its second argument with the first one\'s marks' },
  maskReadbackAtCoordinates: { arg: 0, why: 'masks the NoEcho coordinates of its first argument' },
  keepTemplateLiteralLeaves: {
    arg: 0,
    why: "returns its first argument, a leaf put back only where it equals the TEMPLATE's own plain literal",
  },
  storedReferenceLeavesPutBack: {
    arg: 0,
    why: "returns its first argument, a leaf put back on the second argument's own reference text or masked (go-to-k/cdkd#7167)",
  },
};

/** Write argument `value` into argument `target`. */
export const MUTATORS: Readonly<Record<string, { target: number; value: number }>> = {
  defineOwnKey: { target: 0, value: 2 },
};

/** Array / iterable methods returning a subset or a copy of their receiver. */
const SUBSET_METHODS = new Set([
  'filter',
  'slice',
  'sort',
  'toSorted',
  'reverse',
  'toReversed',
  'flat',
  'find',
  'at',
  'values',
  'entries',
  'keys',
  'get',
  'concat',
]);
const MAPPING_METHODS = new Set(['map', 'flatMap']);
/** The {@link PASS_THROUGH_STATICS} whose result has its argument's shape. */
const SAME_SHAPE_STATICS = new Set(['structuredClone', 'Object.freeze', 'Object.assign', 'JSON.parse', 'Promise.resolve']);
/** Calls that read an argument and never write into it. */
const NON_ESCAPING_CALLS = new Set([
  'Object.keys',
  'Object.entries',
  'Object.values',
  'Object.hasOwn',
  'Object.freeze',
  'Object.isFrozen',
  'Object.getPrototypeOf',
  'JSON.stringify',
  'Array.isArray',
  'Array.from',
  'String',
  'Number',
  'Boolean',
  'structuredClone',
]);
/** Methods whose ARGUMENTS are read, never written (a logger, a lookup, a comparison). */
const NON_ESCAPING_METHODS = new Set([
  'debug',
  'info',
  'warn',
  'error',
  'log',
  'has',
  'get',
  'includes',
  'indexOf',
  'startsWith',
  'endsWith',
]);
/** Static calls returning what their arguments hold. */
const PASS_THROUGH_STATICS = new Set([
  'Object.entries',
  'Object.values',
  'Object.fromEntries',
  'Object.freeze',
  'Object.assign',
  'Array.from',
  'structuredClone',
  'JSON.parse',
  'JSON.stringify',
  'Promise.resolve',
]);

export type RootKind = 'redactor' | 'stored' | 'physical-id' | 'literal' | 'redaction-input';
export type SiteKind = 'property' | 'shorthand' | 'assignment' | 'interior' | 'computed-key';

export interface Site {
  file: string;
  line: number;
  fn: string;
  kind: SiteKind;
  text: string;
  roots: RootKind[];
  /** Each raw root, as `file:line text (why)`. Empty: the site passes. */
  raw: string[];
}

/**
 * A reviewed site the critic cannot follow. `count` is EXACT per file and
 * enclosing function: a new raw site there fails, and so does one that goes.
 */
export interface Exemption {
  file: string;
  fn: string;
  count: number;
  reason: string;
}

export const EXEMPTIONS: readonly Exemption[] = [
  {
    file: 'src/deployment/deploy-engine/observed-capture.ts',
    fn: 'drainObservedCaptures',
    count: 1,
    reason:
      'the deploy capture drain installs the readback raw: every engine save goes through ' +
      '`redactStateForPersist` -> `scrubResourceRecord`, which redacts `observedProperties` ' +
      '(bound (5); the unit test reads that wiring, and ' +
      '`tests/unit/deployment/deploy-engine-cross-stack-read-writers.test.ts` fences that every ' +
      '`engine.stateBackend.saveState` wraps `withParentInfo`, the step that calls it)',
  },
  {
    file: 'src/cli/commands/scrub/twin-references.ts',
    fn: 'withObservedTwinsPositioned',
    count: 1,
    reason:
      'cdkd scrub (go-to-k/cdkd#7154) re-positions an observed leaf of the bag ' +
      '`scrubResourceRecord` just redacted onto the expression text of `properties` as positioned, ' +
      'only where substituting each token by the plaintext THIS pass resolved it to gives the stored ' +
      'leaf exactly and the text outside the tokens holds no recorded plaintext ' +
      '(`provenTemplateText`); every other leaf is the redacted one. The unit test reads that wiring',
  },
];

// ---------------------------------------------------------------- files

interface ParsedFile {
  rel: string;
  source: ts.SourceFile;
  /** Local name -> module specifier, for every named import. */
  imports: Map<string, { module: string; name: string }>;
  /** `import * as ns`: local namespace names. */
  namespaces: Set<string>;
}

const files = new Map<string, ParsedFile>();

function parse(text: string, rel: string): ParsedFile {
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const imports = new Map<string, { module: string; name: string }>();
  const namespaces = new Set<string>();
  for (const st of source.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const bindings = st.importClause?.namedBindings;
    if (bindings !== undefined && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    for (const el of bindings.elements) {
      imports.set(el.name.text, {
        module: st.moduleSpecifier.text,
        name: (el.propertyName ?? el.name).text,
      });
    }
  }
  return { rel, source, imports, namespaces };
}

function fileOf(node: ts.Node): ParsedFile {
  const parsed = files.get(node.getSourceFile().fileName);
  if (parsed === undefined) throw new Error(`unparsed file ${node.getSourceFile().fileName}`);
  return parsed;
}

function resolveModule(fromRel: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const base = join(dirname(fromRel), spec).replace(/\.js$/, '');
  for (const cand of [`${base}.ts`, `${base}/index.ts`]) {
    if (files.has(cand)) return cand;
  }
  return undefined;
}

/**
 * Whether the bare callee reaches the function of that
 * same name the redaction family declares: imported under its own name
 * (through any re-export), or declared in a family file. A same-named local,
 * or an import renamed onto the name, is not it.
 */
function familyCallee(callee: ts.Identifier): boolean {
  const decl = declarationOf(callee);
  if (decl === undefined) return false;
  const intro = introducer(decl);
  const file = fileOf(callee);
  if (ts.isImportSpecifier(intro)) {
    const imp = file.imports.get(callee.text);
    if (imp === undefined || imp.name !== callee.text) return false;
    const target = resolveModule(file.rel, imp.module);
    const hit = target === undefined ? undefined : exportedFunction(target, imp.name);
    return hit !== undefined && inRedactionFamily(hit.file.rel);
  }
  // Declared in the calling file: only a family file's top-level declaration.
  const topLevel =
    (ts.isFunctionDeclaration(decl.parent) && ts.isSourceFile(decl.parent.parent)) ||
    (ts.isVariableDeclaration(intro) && ts.isSourceFile(intro.parent.parent.parent));
  return topLevel && inRedactionFamily(file.rel);
}

function inRedactionFamily(rel: string): boolean {
  return rel === `${REDACTION_DIR}.ts` || rel.startsWith(`${REDACTION_DIR}/`);
}

// ---------------------------------------------------------------- declarations

type FnLike = ts.FunctionLikeDeclaration;

/** A top-level function `name` declares in `file`, following re-exports. */
function exportedFunction(rel: string, name: string, hops = 0): { fn: FnLike; file: ParsedFile } | undefined {
  const file = files.get(rel);
  if (file === undefined || hops > 8) return undefined;
  for (const st of file.source.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name && st.body !== undefined) {
      return { fn: st, file };
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer !== undefined) {
          const init = unwrap(d.initializer);
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return { fn: init, file };
        }
      }
    }
  }
  for (const st of file.source.statements) {
    if (!ts.isExportDeclaration(st) || st.moduleSpecifier === undefined) continue;
    if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
    const target = resolveModule(rel, st.moduleSpecifier.text);
    if (target === undefined) continue;
    if (st.exportClause === undefined) {
      const hit = exportedFunction(target, name, hops + 1);
      if (hit !== undefined) return hit;
    } else if (ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.name.text === name) return exportedFunction(target, (el.propertyName ?? el.name).text, hops + 1);
      }
    }
  }
  const local = file.imports.get(name);
  if (local !== undefined) {
    const target = resolveModule(rel, local.module);
    if (target !== undefined) return exportedFunction(target, local.name, hops + 1);
  }
  return undefined;
}

/** The initializer of a top-level `const name` `rel` declares, following re-exports. */
function exportedConst(rel: string, name: string, hops = 0): ts.Expression | undefined {
  const file = files.get(rel);
  if (file === undefined || hops > 8) return undefined;
  for (const st of file.source.statements) {
    if (!ts.isVariableStatement(st) || (st.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer !== undefined) {
        return isFunctionValue(unwrap(d.initializer)) ? undefined : d.initializer;
      }
    }
  }
  for (const st of file.source.statements) {
    if (!ts.isExportDeclaration(st) || st.moduleSpecifier === undefined) continue;
    if (!ts.isStringLiteral(st.moduleSpecifier)) continue;
    const target = resolveModule(rel, st.moduleSpecifier.text);
    if (target === undefined) continue;
    if (st.exportClause === undefined) {
      const hit = exportedConst(target, name, hops + 1);
      if (hit !== undefined) return hit;
    } else if (ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        if (el.name.text === name) return exportedConst(target, (el.propertyName ?? el.name).text, hops + 1);
      }
    }
  }
  const local = file.imports.get(name);
  if (local !== undefined) {
    const target = resolveModule(rel, local.module);
    if (target !== undefined) return exportedConst(target, local.name, hops + 1);
  }
  return undefined;
}

function isScope(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isModuleBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isFunctionLike(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isCatchClause(node)
  );
}

function bindsName(name: ts.BindingName, text: string): ts.Node | undefined {
  if (ts.isIdentifier(name)) return name.text === text ? name : undefined;
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    const hit = bindsName(el.name, text);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** The declaring identifier of `id`, by nearest lexical scope; undefined when global. */
function declarationOf(id: ts.Identifier): ts.Identifier | undefined {
  const text = id.text;
  for (let scope: ts.Node | undefined = id.parent; scope !== undefined; scope = scope.parent) {
    if (!isScope(scope)) continue;
    if (ts.isFunctionLike(scope)) {
      for (const p of scope.parameters) {
        const hit = bindsName(p.name, text);
        if (hit !== undefined) return hit as ts.Identifier;
      }
      if (ts.isFunctionExpression(scope) && scope.name?.text === text) return scope.name;
      continue;
    }
    if (ts.isCatchClause(scope)) {
      const v = scope.variableDeclaration;
      const hit = v === undefined ? undefined : bindsName(v.name, text);
      if (hit !== undefined) return hit as ts.Identifier;
      continue;
    }
    if (ts.isForStatement(scope) || ts.isForOfStatement(scope) || ts.isForInStatement(scope)) {
      const init = scope.initializer;
      if (init !== undefined && ts.isVariableDeclarationList(init)) {
        for (const d of init.declarations) {
          const hit = bindsName(d.name, text);
          if (hit !== undefined) return hit as ts.Identifier;
        }
      }
      continue;
    }
    // A `switch`'s clauses share one lexical scope, its case block.
    const statements = ts.isCaseBlock(scope)
      ? scope.clauses.flatMap((c) => [...c.statements])
      : ts.isSourceFile(scope) || ts.isBlock(scope) || ts.isModuleBlock(scope)
        ? scope.statements
        : [];
    for (const st of statements) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          const hit = bindsName(d.name, text);
          if (hit !== undefined) return hit as ts.Identifier;
        }
      } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name?.text === text) {
        return st.name;
      } else if (ts.isImportDeclaration(st)) {
        const b = st.importClause?.namedBindings;
        if (b !== undefined && ts.isNamedImports(b)) {
          for (const el of b.elements) if (el.name.text === text) return el.name;
        }
        if (b !== undefined && ts.isNamespaceImport(b) && b.name.text === text) return b.name;
        if (st.importClause?.name?.text === text) return st.importClause.name;
      }
    }
  }
  return undefined;
}

/** The node that introduced a declaring identifier (a declaration, parameter, ...). */
function introducer(decl: ts.Identifier): ts.Node {
  let node: ts.Node = decl.parent;
  while (ts.isBindingElement(node) || ts.isObjectBindingPattern(node) || ts.isArrayBindingPattern(node)) {
    node = node.parent;
  }
  return node;
}

/** The scope a declaration's writes are looked for in. */
function declaringScope(decl: ts.Identifier): ts.Node {
  let node: ts.Node = introducer(decl);
  if (ts.isParameter(node)) return node.parent;
  while (!isScope(node)) node = node.parent;
  return node;
}

// ---------------------------------------------------------------- judging

interface Binding {
  expr: ts.Node;
  env: Env;
}
/** Parameter (declaring identifier) -> what the call being followed passed. */
type Env = ReadonlyMap<ts.Node, Binding>;
/** A member path into a followed value (`['report', 'state']`). */
type Path = readonly string[];
/** Which escapes of a binding are followed (see {@link Judge.escape}). */
type EscapeMode = 'all' | 'calls' | 'none';
const EMPTY_ENV: Env = new Map();

interface Judgement {
  roots: Set<RootKind>;
  raw: string[];
}

function unwrap(node: ts.Node): ts.Node {
  for (;;) {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isSatisfiesExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isAwaitExpression(node)
    ) {
      node = node.expression;
    } else {
      return node;
    }
  }
}

function where(node: ts.Node): string {
  const sf = node.getSourceFile();
  const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  return `${files.get(sf.fileName)?.rel ?? sf.fileName}:${line}`;
}

function snippet(node: ts.Node): string {
  return node.getText().replace(/\s+/g, ' ').slice(0, 100);
}

function isFieldName(name: ts.PropertyName | ts.MemberName): boolean {
  return (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) && name.text === FIELD;
}

/**
 * `x.observedProperties` / `x['observedProperties']` / `x?.observedProperties`,
 * and `x[k]` for a KEY VARIABLE `k` that can name the field.
 */
function isFieldRead(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) return isFieldName(node.name);
  if (!ts.isElementAccessExpression(node)) return false;
  const arg = unwrap(node.argumentExpression);
  if (ts.isStringLiteralLike(arg)) return arg.text === FIELD;
  return ts.isIdentifier(arg) && isKeyVariable(arg);
}

function holdsFieldLiteral(node: ts.Node | undefined): boolean {
  if (node === undefined) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteralLike(n) && n.text === FIELD) found = true;
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * A key variable: a `for ... of` variable over an array literal holding
 * `'observedProperties'`, or a parameter whose declared type names that
 * literal (`key: 'attributes' | 'observedProperties'`). An element access
 * through one is a field access, read or written.
 */
function isKeyVariable(id: ts.Identifier): boolean {
  const decl = declarationOf(id);
  if (decl === undefined) return false;
  const intro = introducer(decl);
  if (ts.isParameter(intro)) return intro.name === decl && holdsFieldLiteral(intro.type);
  if (!ts.isVariableDeclaration(intro) || intro.name !== decl) return false;
  const loop = intro.parent.parent;
  return ts.isForOfStatement(loop) && ts.isArrayLiteralExpression(unwrap(loop.expression)) && holdsFieldLiteral(loop.expression);
}

/** `x.physicalId` / `x['physicalId']`: state keeps the id in plaintext beside the bag. */
function isPhysicalIdRead(node: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(node)) return node.name.text === 'physicalId';
  return (
    ts.isElementAccessExpression(node) &&
    ts.isStringLiteralLike(node.argumentExpression) &&
    node.argumentExpression.text === 'physicalId'
  );
}

/** `r.observedProperties ?? r.properties`, one receiver spelled alike on both sides. */
function isBaselineFallback(node: ts.BinaryExpression): boolean {
  const left = unwrap(node.left);
  const right = unwrap(node.right);
  return (
    ts.isPropertyAccessExpression(left) &&
    isFieldName(left.name) &&
    ts.isPropertyAccessExpression(right) &&
    right.name.text === 'properties' &&
    left.expression.getText() === right.expression.getText()
  );
}

function isFunctionValue(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/** The expressions a function returns (an arrow's expression body included). */
function returnsOf(fn: FnLike): ts.Expression[] {
  if (fn.body === undefined) return [];
  if (!ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Expression[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isFunctionLike(n) && n !== fn) return;
    if (ts.isReturnStatement(n) && n.expression !== undefined) out.push(n.expression);
    // A generator hands out what it yields.
    if (ts.isYieldExpression(n) && n.expression !== undefined) out.push(n.expression);
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn.body, visit);
  return out;
}

/** The name a parameter's callers call its function by, or undefined (a callback). */
function calledName(fn: FnLike): string | undefined {
  if ((ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) && fn.name !== undefined) {
    return ts.isIdentifier(fn.name) || ts.isPrivateIdentifier(fn.name) ? fn.name.text : undefined;
  }
  if (isFunctionValue(fn) && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
    return fn.parent.name.text;
  }
  if (isFunctionValue(fn) && ts.isPropertyDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
    return fn.parent.name.text;
  }
  return undefined;
}

/**
 * Every call of `name`, and whether `name` is also used as a value anywhere
 * that can reach it. A file reaches it under its own name (the declaring file)
 * or under any local name an import gives it, renamed or re-exported under
 * another name included, and through a namespace import (`ns.name(...)`).
 */
function callsOf(name: string, declFile: ParsedFile, isMethod: boolean): { calls: ts.CallExpression[]; asValue: boolean } {
  const calls: ts.CallExpression[] = [];
  let asValue = false;
  // The names it is exported under: its own, and every `export { name as x }`.
  const exported = new Set([name]);
  for (const file of files.values()) {
    for (const st of file.source.statements) {
      if (!ts.isExportDeclaration(st) || st.exportClause === undefined || !ts.isNamedExports(st.exportClause)) continue;
      for (const el of st.exportClause.elements) if ((el.propertyName ?? el.name).text === name) exported.add(el.name.text);
    }
  }
  for (const file of files.values()) {
    const locals = new Set<string>();
    if (!isMethod) {
      if (file === declFile) locals.add(name);
      for (const [local, imp] of file.imports) if (exported.has(imp.name)) locals.add(local);
    }
    const reachesByNamespace = !isMethod && file.namespaces.size > 0;
    if (!isMethod && locals.size === 0 && !reachesByNamespace) continue;
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n)) {
        const callee = unwrap(n.expression);
        if (ts.isIdentifier(callee) && locals.has(callee.text)) calls.push(n);
        if (ts.isPropertyAccessExpression(callee) && exported.has(callee.name.text)) {
          const viaNamespace = ts.isIdentifier(callee.expression) && file.namespaces.has(callee.expression.text);
          if (isMethod || viaNamespace) calls.push(n);
        }
      }
      if (ts.isIdentifier(n) && locals.has(n.text) && isReference(n)) {
        const p = n.parent;
        const declared =
          (ts.isFunctionDeclaration(p) && p.name === n) ||
          (ts.isVariableDeclaration(p) && p.name === n) ||
          ts.isImportSpecifier(p) ||
          ts.isExportSpecifier(p) ||
          (ts.isCallExpression(p) && unwrap(p.expression) === n) ||
          ts.isTypeReferenceNode(p) ||
          ts.isTypeQueryNode(p);
        if (!declared) asValue = true;
      }
      ts.forEachChild(n, visit);
    };
    visit(file.source);
  }
  return { calls, asValue };
}

const MAX_DEPTH = 40;

class Judge {
  private stack = new Set<string>();
  private depth = 0;
  private memo = new Map<string, Judgement>();
  /** Set when a cycle was cut below the node being judged: its result is partial. */
  private cut = false;

  /** Branch facts that hold at the site being judged: a declaration -> its truthiness. */
  private facts = new Map<ts.Node, boolean>();
  private factsKey = '';

  judge(node: ts.Node, env: Env, site?: ts.Node): Judgement {
    const out: Judgement = { roots: new Set(), raw: [] };
    this.facts = new Map();
    if (site !== undefined) {
      for (const g of guardsOf(site, undefined)) {
        const fact = conditionIdentifier(g.cond);
        const decl = fact === undefined ? undefined : declarationOf(fact.id);
        if (decl !== undefined) this.facts.set(decl, fact!.negated ? !g.truthy : g.truthy);
      }
    }
    this.factsKey = [...this.facts].map(([d, v]) => `${d.getSourceFile().fileName}:${d.pos}=${v}`).join(',');
    this.into(node, env, out);
    return out;
  }

  /** A condition's truthiness from the site's facts, through parameter bindings; undefined when unknown. */
  private evalCond(expr: ts.Node, env: Env): boolean | undefined {
    const c = conditionIdentifier(expr);
    if (c === undefined) return undefined;
    const decl = declarationOf(c.id);
    if (decl === undefined) return undefined;
    let value: boolean | undefined;
    if (this.facts.has(decl)) value = this.facts.get(decl);
    else {
      const bound = env.get(decl);
      if (bound !== undefined) value = this.evalCond(bound.expr, bound.env);
    }
    return value === undefined ? undefined : c.negated ? !value : value;
  }

  private key(node: ts.Node, env: Env, path: Path): string {
    const ids: string[] = [];
    for (const [k, v] of env) {
      ids.push(`${k.getSourceFile().fileName}:${k.pos}:${v.expr.getSourceFile().fileName}:${v.expr.pos}`);
    }
    return `${node.getSourceFile().fileName}:${node.pos}:${node.end}|${ids.join(',')}|${path.join('.')}|${this.factsKey}`;
  }

  private trail: ts.Node[] = [];

  private root(out: Judgement, kind: RootKind): void {
    out.roots.add(kind);
  }

  private raw(out: Judgement, node: ts.Node, why: string): void {
    const via = this.trail
      .slice(1)
      .map((n) => where(n))
      .filter((w, i, all) => i === 0 || all[i - 1] !== w);
    out.raw.push(`${where(node)} \`${snippet(node)}\` (${why})${via.length > 0 ? ` via ${via.slice(-8).join(' > ')}` : ''}`);
  }

  /**
   * Follow `input` to its roots. `path` is the member of it the caller needs
   * (`args.report.state` is `args` with path `report.state`): an object literal
   * on the way is read at that member only; anything else is followed whole.
   */
  private into(input: ts.Node, env: Env, out: Judgement, wanted: Path = []): void {
    const node = unwrap(input);
    const path = normalizePath(wanted);
    const key = this.key(node, env, path);
    // A cycle (a recursive helper, a binding written from itself) adds no
    // root of its own: what reaches it from outside is judged there.
    if (this.stack.has(key)) {
      this.cut = true;
      return;
    }
    const memo = this.memo.get(key);
    if (memo !== undefined) {
      for (const r of memo.roots) out.roots.add(r);
      out.raw.push(...memo.raw);
      return;
    }
    if (this.depth > MAX_DEPTH) {
      this.raw(out, node, 'followed too deep');
      return;
    }
    const own: Judgement = { roots: new Set(), raw: [] };
    const outerCut = this.cut;
    this.cut = false;
    this.stack.add(key);
    this.trail.push(node);
    this.depth++;
    try {
      this.step(node, env, own, path);
    } finally {
      this.depth--;
      this.trail.pop();
      this.stack.delete(key);
    }
    own.raw = [...new Set(own.raw)];
    if (!this.cut) this.memo.set(key, own);
    this.cut = this.cut || outerCut;
    for (const r of own.roots) out.roots.add(r);
    out.raw.push(...own.raw);
  }

  private step(node: ts.Node, env: Env, out: Judgement, path: Path): void {
    if (
      ts.isStringLiteralLike(node) ||
      ts.isNumericLiteral(node) ||
      ts.isBigIntLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword ||
      ts.isRegularExpressionLiteral(node) ||
      (ts.isIdentifier(node) && node.text === 'undefined') ||
      ts.isVoidExpression(node) ||
      ts.isTypeOfExpression(node)
    ) {
      this.root(out, 'literal');
      return;
    }
    if (ts.isTemplateExpression(node)) {
      this.root(out, 'literal');
      for (const span of node.templateSpans) this.into(span.expression, env, out);
      return;
    }
    if (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) {
      this.root(out, 'literal');
      return;
    }
    if (ts.isConditionalExpression(node)) {
      const known = this.evalCond(node.condition, env);
      if (known !== false) this.into(node.whenTrue, env, out, path);
      if (known !== true) this.into(node.whenFalse, env, out, path);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      if (op === ts.SyntaxKind.QuestionQuestionToken && isBaselineFallback(node)) {
        // `r.observedProperties ?? r.properties`: the drift baseline idiom, a
        // stored record's observed bag or, absent, its stored properties.
        this.into(node.left, env, out, path);
        this.root(out, 'stored');
        return;
      }
      if (
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken ||
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.PlusToken ||
        op === ts.SyntaxKind.CommaToken
      ) {
        const keep = op === ts.SyntaxKind.PlusToken ? [] : path;
        if (op !== ts.SyntaxKind.CommaToken) this.into(node.left, env, out, keep);
        this.into(node.right, env, out, keep);
        return;
      }
      if (op === ts.SyntaxKind.EqualsToken) {
        this.into(node.right, env, out, path);
        return;
      }
      if (isAssignment(op)) {
        // `a ??= b` as a value: what `a` held, or `b`.
        this.into(node.left, env, out, path);
        this.into(node.right, env, out, path);
        return;
      }
      // A comparison / arithmetic / `in` / `instanceof`: a boolean or number.
      this.root(out, 'literal');
      return;
    }
    if (ts.isSpreadElement(node) || ts.isSpreadAssignment(node)) {
      this.into(node.expression, env, out, path);
      return;
    }
    if (ts.isObjectLiteralExpression(node) && path.length > 0) {
      this.member(node, path, env, out);
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      if (node.properties.length === 0) this.root(out, 'literal');
      for (const p of node.properties) {
        if (ts.isPropertyAssignment(p)) this.into(p.initializer, env, out);
        else if (ts.isShorthandPropertyAssignment(p)) this.into(p.name, env, out);
        else if (ts.isSpreadAssignment(p)) this.into(p.expression, env, out);
        else this.raw(out, p, 'an accessor or method member');
      }
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      if (node.elements.length === 0) this.root(out, 'literal');
      for (const e of node.elements) this.into(e, env, out, path);
      return;
    }
    if (isFieldRead(node)) {
      this.root(out, 'stored');
      return;
    }
    if (isPhysicalIdRead(node)) {
      this.root(out, 'physical-id');
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      // A member of a followed value holds what the value holds.
      this.into(node.expression, env, out, [node.name.text, ...path]);
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      const arg = unwrap(node.argumentExpression);
      this.into(node.expression, env, out, [ts.isStringLiteralLike(arg) ? arg.text : '*', ...path]);
      return;
    }
    if (ts.isIdentifier(node)) {
      this.identifier(node, env, out, path);
      return;
    }
    if (ts.isCallExpression(node)) {
      this.call(node, env, out, path);
      return;
    }
    if (ts.isNewExpression(node)) {
      const name = ts.isIdentifier(node.expression) ? node.expression.text : '';
      if (name === 'Map' || name === 'Set' || name === 'Array' || name === 'WeakMap') {
        if ((node.arguments ?? []).length === 0) this.root(out, 'literal');
        for (const a of node.arguments ?? []) this.into(a, env, out);
        return;
      }
      this.raw(out, node, 'a constructed object');
      return;
    }
    this.raw(out, node, `a ${ts.SyntaxKind[node.kind]} the critic does not follow`);
  }

  private identifier(id: ts.Identifier, env: Env, out: Judgement, path: Path): void {
    const decl = declarationOf(id);
    if (decl === undefined) {
      this.raw(out, id, 'an undeclared or global name');
      return;
    }
    const bound = env.get(decl);
    if (bound !== undefined) {
      // A parameter of a followed call: what the call passed, plus anything
      // the function writes into it (`out.push(...)` on an accumulator).
      this.into(bound.expr, bound.env, out, withMember(decl, path));
      this.writesInto(decl, env, out, path);
      return;
    }
    const intro = introducer(decl);
    if (ts.isParameter(intro)) {
      this.parameter(decl, intro, id, out, withMember(decl, path));
      this.writesInto(decl, env, out, path);
      return;
    }
    if (ts.isVariableDeclaration(intro) && ts.isCatchClause(intro.parent)) {
      this.raw(out, id, 'a caught value');
      return;
    }
    if (ts.isVariableDeclaration(intro)) {
      const list = intro.parent;
      const loop = ts.isVariableDeclarationList(list) ? list.parent : undefined;
      if (loop !== undefined && (ts.isForOfStatement(loop) || ts.isForInStatement(loop))) {
        if (ts.isForInStatement(loop)) this.root(out, 'literal');
        else this.into(loop.expression, env, out, ts.isIdentifier(intro.name) ? ['*', ...path] : []);
      } else if (intro.initializer !== undefined) {
        const init = unwrap(intro.initializer);
        if (isFunctionValue(init)) {
          this.raw(out, id, 'a function value');
          return;
        }
        this.into(intro.initializer, env, out, withMember(decl, path));
      } else if (ts.isIdentifier(intro.name)) {
        this.root(out, 'literal');
      }
      this.writesInto(decl, env, out, path);
      return;
    }
    if (ts.isImportSpecifier(intro)) {
      const file = fileOf(id);
      const imp = file.imports.get(id.text);
      const target = imp === undefined ? undefined : resolveModule(file.rel, imp.module);
      const init = target === undefined ? undefined : exportedConst(target, imp!.name);
      if (init !== undefined) this.into(init, EMPTY_ENV, out, path);
      else this.raw(out, id, 'an imported binding that is no exported const');
      return;
    }
    this.raw(out, id, `a binding introduced by ${ts.SyntaxKind[intro.kind]}`);
  }

  /**
   * Every later write into a local binding: a reassignment, a member write, a
   * Map / Set / array write, `Object.assign` / `Object.defineProperty`, a
   * {@link MUTATORS} call. Then where the binding ESCAPES its scope: into a
   * function the repo declares (that function's writes into its parameter),
   * under a property name (every write through that name, repo-wide), or into
   * a call the critic cannot follow (raw).
   */
  /**
   * Every write into a binding that can reach member `path` of it: a
   * reassignment, a member write, a Map / Set / array write,
   * `Object.assign` / `Object.defineProperty`, a {@link MUTATORS} call. For a
   * container the scope created (or one reached through an escape), also the
   * writes where it ESCAPES: into a function the repo declares (its writes
   * into that parameter), under a property name (every write through that
   * name, repo-wide), through an alias; any other escape is raw.
   */
  private writesInto(
    decl: ts.Identifier,
    env: Env,
    out: Judgement,
    path: Path,
    escapes: EscapeMode = isFreshContainer(decl) ? 'all' : 'calls'
  ): void {
    const refersHere = (n: ts.Node): boolean =>
      ts.isIdentifier(n) && n.text === decl.text && n !== decl && isReference(n) && declarationOf(n) === decl;
    this.scan(`W|${this.key(decl, env, path)}|${escapes}`, out, (own) => {
      const scope = declaringScope(decl);
      this.writesThrough(refersHere, [scope], env, own, path);
      if (escapes !== 'none') this.escapes(refersHere, scope, own, path, escapes);
    });
  }

  /** Every write through a property, or a binding destructured, NAMED `name`, anywhere in the tree. */
  private writesNamed(name: string, out: Judgement, path: Path): void {
    // Under the field itself it is a stored bag: every write through
    // `.observedProperties` is a site of its own.
    if (name === FIELD) return;
    // `x.<name>`, or a binding destructured off something as `<name>`: the
    // places a container stored under that property is read back.
    const named = (n: ts.Node): boolean => {
      if (ts.isPropertyAccessExpression(n)) return n.name.text === name;
      if (!ts.isIdentifier(n) || n.text !== name) return false;
      const decl = declarationOf(n);
      return decl !== undefined && memberKey(decl) === name;
    };
    this.scan(`N|${name}|${path.join('.')}|${this.factsKey}`, out, (own) =>
      this.writesThrough(named, [...files.values()].map((f) => f.source), EMPTY_ENV, own, path)
    );
  }

  /** Memoised like {@link into}: a result a cycle cut short is not kept, and a re-entry is a cut. */
  private scan(key: string, out: Judgement, body: (own: Judgement) => void): void {
    const memo = this.memo.get(key);
    if (memo !== undefined) {
      for (const r of memo.roots) out.roots.add(r);
      out.raw.push(...memo.raw);
      return;
    }
    if (this.scanning.has(key)) {
      this.cut = true;
      return;
    }
    this.scanning.add(key);
    const own: Judgement = { roots: new Set(), raw: [] };
    const outerCut = this.cut;
    this.cut = false;
    try {
      body(own);
    } finally {
      this.scanning.delete(key);
    }
    own.raw = [...new Set(own.raw)];
    if (!this.cut) this.memo.set(key, own);
    this.cut = this.cut || outerCut;
    for (const r of own.roots) out.roots.add(r);
    out.raw.push(...own.raw);
  }

  private scanning = new Set<string>();

  /**
   * The writes through a container `matches` names, each judged at the part of
   * `path` it can reach: a write at member chain S reaches `path` when S and
   * `path` agree on their common prefix (`*` matches any key).
   */
  private writesThrough(
    matches: (n: ts.Node) => boolean,
    scopes: ts.Node[],
    env: Env,
    out: Judgement,
    path: Path
  ): void {
    for (const scope of scopes) {
      for (const w of writesOf(scope.getSourceFile())) {
        if (!within(w.node, scope)) continue;
        const chain = chainTo(w.target, matches);
        if (chain === undefined) continue;
        const rest = reach([...chain, ...w.suffix], path);
        if (rest !== undefined) this.into(w.value, env, out, [...w.wrap, ...rest]);
      }
    }
  }

  /** Where a binding's object leaves it, and the writes made through it there. */
  private escapes(
    refersHere: (n: ts.Node) => boolean,
    scope: ts.Node,
    out: Judgement,
    path: Path,
    mode: EscapeMode
  ): void {
    const visit = (n: ts.Node): void => {
      if (refersHere(n)) this.escape(n, out, path, mode);
      ts.forEachChild(n, visit);
    };
    visit(scope);
  }

  /**
   * `all` (a container the scope created): an alias, a property name, a
   * declared function's parameter, and any other call (raw). `calls` (any
   * other binding on the way): a declared function's parameter only, one level.
   */
  private escape(ref: ts.Node, out: Judgement, path: Path, mode: EscapeMode): void {
    let cur: ts.Node = ref;
    while (
      ts.isParenthesizedExpression(cur.parent) ||
      ts.isAsExpression(cur.parent) ||
      ts.isNonNullExpression(cur.parent) ||
      ts.isSatisfiesExpression(cur.parent) ||
      ts.isTypeAssertionExpression(cur.parent)
    ) {
      cur = cur.parent;
    }
    // A member of it handed on (`patch(bag.Definition, live)`) carries the
    // same object's insides: judged like the binding, whole.
    let member: ts.Node = cur;
    for (;;) {
      const mp = member.parent;
      if ((ts.isPropertyAccessExpression(mp) || ts.isElementAccessExpression(mp)) && mp.expression === member) member = mp;
      else if (
        member !== cur &&
        (ts.isParenthesizedExpression(mp) || ts.isAsExpression(mp) || ts.isNonNullExpression(mp) || ts.isSatisfiesExpression(mp))
      ) {
        member = mp;
      } else break;
    }
    const mp = member.parent;
    if (member !== cur && ts.isCallExpression(mp) && mp.arguments.includes(member as ts.Expression)) {
      this.callEscape(mp, mp.arguments.indexOf(member as ts.Expression), ref, out, [], mode);
      return;
    }
    const p = cur.parent;
    if (ts.isCallExpression(p) && p.arguments.includes(cur as ts.Expression)) {
      this.callEscape(p, p.arguments.indexOf(cur as ts.Expression), ref, out, path, mode);
      return;
    }
    // A local alias (`const bag = written as Record<...>`, `bag = written`)
    // is the same object: writes through it count, in every mode.
    // A `const` alias (`const bag = written as Record<...>`, an alias of an
    // alias, or a member destructured off it) is the same object: its writes
    // and escapes are followed as the binding's are.
    if (ts.isVariableDeclaration(p) && p.initializer === cur && (ts.getCombinedNodeFlags(p) & ts.NodeFlags.Const) !== 0) {
      if (ts.isIdentifier(p.name)) this.writesInto(p.name, EMPTY_ENV, out, path, mode);
      // A destructured member: its own writes (its escapes are bound (2)).
      else {
        for (const id of bindingIdentifiers(p.name)) {
          // Only a member on the followed path can hold what is followed.
          const key = memberKey(id);
          const rest = key === undefined ? [] : reach([key], path);
          if (rest !== undefined) this.writesInto(id, EMPTY_ENV, out, rest, 'none');
        }
      }
      return;
    }
    if (mode !== 'all') return;
    if (ts.isBinaryExpression(p) && isAssignment(p.operatorToken.kind) && p.right === cur) {
      const left = unwrap(p.left);
      const decl = ts.isIdentifier(left) ? declarationOf(left) : undefined;
      if (decl !== undefined) {
        this.writesInto(decl, EMPTY_ENV, out, path, 'all');
        return;
      }
    }
    if (ts.isVariableDeclaration(p) && p.initializer === cur && ts.isIdentifier(p.name)) {
      this.writesInto(p.name, EMPTY_ENV, out, path, 'all');
      return;
    }
    if (ts.isShorthandPropertyAssignment(p)) {
      this.writesNamed(p.name.text, out, path);
      return;
    }
    if (ts.isPropertyAssignment(p) && p.initializer === cur) {
      const key = propertyNameText(p.name);
      if (key !== undefined) this.writesNamed(key, out, path);
      else this.raw(out, ref, 'escapes under a computed key');
      return;
    }
    const newArgs: readonly ts.Node[] = ts.isNewExpression(p) ? (p.arguments ?? []) : [];
    if (ts.isNewExpression(p) && newArgs.includes(cur)) {
      const name = ts.isIdentifier(p.expression) ? p.expression.text : '';
      if (name !== 'Map' && name !== 'Set' && name !== 'Array' && name !== 'WeakMap' && name !== 'WeakSet') {
        this.raw(out, ref, `escapes into \`new ${snippet(p.expression)}\`, whose writes the critic cannot see`);
      }
      return;
    }
    if (ts.isBinaryExpression(p) && isAssignment(p.operatorToken.kind) && p.right === cur) {
      const left = unwrap(p.left);
      if (ts.isPropertyAccessExpression(left)) this.writesNamed(left.name.text, out, path);
      else this.raw(out, ref, 'escapes into a member the critic cannot name');
    }
  }

  private callEscape(
    call: ts.CallExpression,
    index: number,
    ref: ts.Node,
    out: Judgement,
    path: Path,
    mode: EscapeMode
  ): void {
    const name = calleeText(call);
    const callee = unwrap(call.expression);
    if (name !== undefined && (NON_ESCAPING_CALLS.has(name) || MUTATORS[name] !== undefined)) return;
    if (name === 'Object.assign' || name === 'Object.defineProperty' || name === 'Reflect.set') return;
    if (
      ts.isIdentifier(callee) &&
      (REDACTORS.has(callee.text) || CARRIERS[callee.text] !== undefined) &&
      familyCallee(callee)
    ) {
      return;
    }
    if (ts.isPropertyAccessExpression(callee) && NON_ESCAPING_METHODS.has(callee.name.text)) return;
    if (ts.isIdentifier(callee)) {
      const fn = this.functionNamed(callee, declarationOf(callee), fileOf(call));
      const param = fn?.parameters[index];
      if (param !== undefined && param.dotDotDotToken === undefined) {
        // The callee's own writes into that parameter; its further escapes
        // are followed only for a container the caller created.
        const next: EscapeMode = mode === 'all' ? 'calls' : 'none';
        if (ts.isIdentifier(param.name)) this.writesInto(param.name, EMPTY_ENV, out, path, next);
        else for (const id of bindingIdentifiers(param.name)) this.writesInto(id, EMPTY_ENV, out, [], next);
        return;
      }
    }
    if (mode === 'all') {
      this.raw(out, ref, `escapes into \`${snippet(call.expression)}\`, whose writes the critic cannot see`);
    }
  }

  private parameter(decl: ts.Identifier, param: ts.ParameterDeclaration, at: ts.Node, out: Judgement, path: Path): void {
    const fn = param.parent as FnLike;
    const index = fn.parameters.indexOf(param);
    if (param.dotDotDotToken !== undefined) {
      this.raw(out, at, 'a rest parameter');
      return;
    }
    const name = calledName(fn);
    if (name === undefined) {
      this.raw(out, at, 'a callback parameter, whose caller the critic cannot see');
      return;
    }
    const declFile = fileOf(fn);
    const { calls, asValue } = callsOf(name, declFile, ts.isMethodDeclaration(fn) || ts.isPropertyDeclaration(fn.parent));
    if (asValue) {
      this.raw(out, at, `a parameter of \`${name}\`, which is also passed as a value`);
      return;
    }
    if (calls.length === 0) {
      this.raw(out, at, `a parameter of \`${name}\`, which nothing calls`);
      return;
    }
    for (const call of calls) {
      // A recursive call hands on what the function itself holds: judged at the outside calls.
      if (within(call, fn)) continue;
      const arg = call.arguments[index];
      if (arg === undefined) {
        if (param.initializer !== undefined) this.into(param.initializer, EMPTY_ENV, out, path);
        else this.root(out, 'literal');
        continue;
      }
      if (ts.isSpreadElement(arg)) {
        this.raw(out, arg, 'a spread argument');
        continue;
      }
      this.into(arg, EMPTY_ENV, out, path);
    }
  }

  /** Member `path` of an object literal: the property it names, or a spread that may hold it. */
  private member(lit: ts.ObjectLiteralExpression, path: Path, env: Env, out: Judgement): void {
    const [key, ...rest] = path;
    let matched = false;
    for (const p of lit.properties) {
      if (ts.isSpreadAssignment(p)) {
        matched = true;
        this.into(p.expression, env, out, path);
      } else if (ts.isShorthandPropertyAssignment(p) && (key === '*' || p.name.text === key)) {
        matched = true;
        this.into(p.name, env, out, rest);
      } else if (
        ts.isPropertyAssignment(p) &&
        (key === '*' || propertyNameText(p.name) === key || propertyNameText(p.name) === undefined)
      ) {
        matched = true;
        this.into(p.initializer, env, out, rest);
      } else if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) {
        if (key === '*' || p.name === undefined || propertyNameText(p.name) === key) {
          matched = true;
          this.raw(out, p, 'an accessor or method member');
        }
      }
    }
    if (!matched) this.root(out, 'literal');
  }

  private call(call: ts.CallExpression, env: Env, out: Judgement, path: Path): void {
    const callee = unwrap(call.expression);
    const name = calleeText(call);
    const file = fileOf(call);
    if (ts.isIdentifier(callee)) {
      const bare = callee.text;
      if (REDACTORS.has(bare) && familyCallee(callee)) {
        this.root(out, 'redactor');
        return;
      }
      const carrier = CARRIERS[bare];
      if (carrier !== undefined && familyCallee(callee)) {
        const arg = call.arguments[carrier.arg];
        if (arg === undefined) this.raw(out, call, 'a carrier call without its argument');
        else this.into(arg, env, out, path);
        return;
      }
    }
    if (name === 'Object.create' && call.arguments[0] !== undefined && unwrap(call.arguments[0]).kind === ts.SyntaxKind.NullKeyword) {
      this.root(out, 'literal');
      return;
    }
    if (name === 'Symbol') {
      this.root(out, 'literal');
      return;
    }
    if (name !== undefined && PASS_THROUGH_STATICS.has(name)) {
      if (call.arguments.length === 0) this.root(out, 'literal');
      // Only a copy of its argument keeps the member path; the others reshape it.
      const keep = SAME_SHAPE_STATICS.has(name) ? path : [];
      for (const a of call.arguments) this.into(a, env, out, keep);
      return;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const method = callee.name.text;
      if (SUBSET_METHODS.has(method)) {
        this.into(callee.expression, env, out);
        if (method === 'concat') for (const a of call.arguments) this.into(a, env, out);
        return;
      }
      if (MAPPING_METHODS.has(method)) {
        const cb = call.arguments[0] === undefined ? undefined : unwrap(call.arguments[0]);
        const named =
          cb !== undefined && ts.isIdentifier(cb)
            ? this.functionNamed(cb, declarationOf(cb), file)
            : undefined;
        const fnCb = cb !== undefined && isFunctionValue(cb) ? cb : named;
        if (fnCb !== undefined && fnCb !== cb) {
          // `xs.map(named)`: the named function on each element, guarded like a call.
          if (this.inlining.has(fnCb) && within(call, fnCb)) {
            this.cut = true;
            return;
          }
          const fresh = !this.inlining.has(fnCb);
          this.inlining.add(fnCb);
          try {
            const inner = new Map<ts.Node, Binding>();
            const first = fnCb.parameters[0];
            if (first !== undefined) bindParam(first.name, { expr: callee.expression, env }, inner);
            for (const r of returnsOf(fnCb)) this.into(r, inner, out, ['*', ...path]);
          } finally {
            if (fresh) this.inlining.delete(fnCb);
          }
          return;
        }
        if (cb !== undefined && isFunctionValue(cb)) {
          const inner = new Map(env);
          const first = cb.parameters[0];
          if (first !== undefined) bindParam(first.name, { expr: callee.expression, env }, inner);
          for (const r of returnsOf(cb)) this.into(r, inner, out, path);
          return;
        }
      }
      this.raw(out, call, `a method call \`.${method}()\` the critic cannot resolve`);
      return;
    }
    if (ts.isIdentifier(callee)) {
      // A callback bound by the call being followed, or a local function value.
      const decl = declarationOf(callee);
      const bound = decl === undefined ? undefined : env.get(decl);
      if (bound !== undefined) {
        const fnNode = unwrap(bound.expr);
        if (isFunctionValue(fnNode)) {
          this.inline(fnNode, call, env, bound.env, out, path);
          return;
        }
        this.into(bound.expr, bound.env, out, path);
        return;
      }
      const target = this.functionNamed(callee, decl, file);
      if (target !== undefined) {
        this.inline(target, call, env, EMPTY_ENV, out, path);
        return;
      }
      this.raw(out, call, `a call to \`${callee.text}\`, which the critic cannot resolve`);
      return;
    }
    if (isFunctionValue(callee)) {
      this.inline(callee, call, env, env, out, path);
      return;
    }
    this.raw(out, call, 'a call the critic cannot resolve');
  }

  private functionNamed(callee: ts.Identifier, decl: ts.Identifier | undefined, file: ParsedFile): FnLike | undefined {
    if (decl === undefined) return undefined;
    const intro = introducer(decl);
    if (ts.isFunctionDeclaration(intro) && intro.body !== undefined) return intro;
    if (ts.isFunctionDeclaration(decl.parent) && decl.parent.body !== undefined) return decl.parent;
    if (ts.isVariableDeclaration(intro) && intro.initializer !== undefined) {
      const init = unwrap(intro.initializer);
      if (isFunctionValue(init)) return init;
    }
    if (ts.isImportSpecifier(intro)) {
      const imp = file.imports.get(callee.text);
      const target = imp === undefined ? undefined : resolveModule(file.rel, imp.module);
      return target === undefined ? undefined : exportedFunction(target, imp!.name)?.fn;
    }
    return undefined;
  }

  /** Follow every `return` of `fn`, its parameters bound to `call`'s arguments. */
  private inlining = new Set<ts.Node>();

  private inline(fn: FnLike, call: ts.CallExpression, argEnv: Env, outerEnv: Env, out: Judgement, path: Path): void {
    // A RECURSIVE call (one inside the body being followed) passes members of
    // what the outer call was given, which the outer call's judgement covers.
    // Two calls of one helper from outside it (`id(id(x))`) are both followed.
    const recursive = this.inlining.has(fn) && within(call, fn);
    if (recursive || this.inlining.has(call)) {
      this.cut = true;
      return;
    }
    const fresh = !this.inlining.has(fn);
    this.inlining.add(call);
    this.inlining.add(fn);
    try {
      this.inlineBody(fn, call, argEnv, outerEnv, out, path);
    } finally {
      this.inlining.delete(call);
      if (fresh) this.inlining.delete(fn);
    }
  }

  private inlineBody(fn: FnLike, call: ts.CallExpression, argEnv: Env, outerEnv: Env, out: Judgement, path: Path): void {
    const inner = new Map(outerEnv);
    fn.parameters.forEach((p, i) => {
      const arg = call.arguments[i];
      if (p.dotDotDotToken !== undefined) return;
      if (arg !== undefined && !ts.isSpreadElement(arg)) bindParam(p.name, { expr: arg, env: argEnv }, inner);
      else if (p.initializer !== undefined) bindParam(p.name, { expr: p.initializer, env: inner }, inner);
      else bindParam(p.name, { expr: UNDEFINED_LITERAL, env: EMPTY_ENV }, inner);
    });
    // A return the site's facts rule out (`if (observed) return a; return b;`
    // with `observed` known true) is not followed.
    const returns = returnsOf(fn).filter((r) =>
      guardsOf(r, fn).every((g) => {
        const known = this.evalCond(g.cond, inner);
        return known === undefined || known === g.truthy;
      })
    );
    if (returns.length === 0) {
      this.root(out, 'literal');
      return;
    }
    for (const r of returns) this.into(r, inner, out, path);
  }
}

const UNDEFINED_LITERAL: ts.Node = (ts.createSourceFile('undefined.ts', 'undefined', ts.ScriptTarget.Latest, true)
  .statements[0]! as ts.ExpressionStatement).expression;

/** `x` or `!x`, a plain identifier condition. */
function conditionIdentifier(expr: ts.Node): { id: ts.Identifier; negated: boolean } | undefined {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return { id: e, negated: false };
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const inner = conditionIdentifier(e.operand);
    return inner === undefined ? undefined : { id: inner.id, negated: !inner.negated };
  }
  return undefined;
}

/** Whether a statement always leaves its block (`return` / `throw`, or a block ending in one). */
function exits(st: ts.Statement): boolean {
  if (ts.isReturnStatement(st) || ts.isThrowStatement(st)) return true;
  if (ts.isBlock(st)) {
    const last = st.statements[st.statements.length - 1];
    return last !== undefined && exits(last);
  }
  return false;
}

/**
 * The conditions that must hold for `node` to run, up to `stop`: a `?:` / `if`
 * branch, the right side of `&&`, and an earlier `if (c) return` in the same
 * block (`c` false).
 */
function guardsOf(node: ts.Node, stop: ts.Node | undefined): { cond: ts.Expression; truthy: boolean }[] {
  const out: { cond: ts.Expression; truthy: boolean }[] = [];
  let child: ts.Node = node;
  for (let p: ts.Node | undefined = node.parent; p !== undefined && p !== stop; child = p, p = p.parent) {
    if (ts.isConditionalExpression(p)) {
      if (child === p.whenTrue) out.push({ cond: p.condition, truthy: true });
      else if (child === p.whenFalse) out.push({ cond: p.condition, truthy: false });
    } else if (ts.isIfStatement(p)) {
      if (child === p.thenStatement) out.push({ cond: p.expression, truthy: true });
      else if (child === p.elseStatement) out.push({ cond: p.expression, truthy: false });
    } else if (
      ts.isBinaryExpression(p) &&
      p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      child === p.right
    ) {
      out.push({ cond: p.left, truthy: true });
    } else if (ts.isBlock(p) || ts.isSourceFile(p)) {
      for (const st of p.statements) {
        if (st === child) break;
        if (ts.isIfStatement(st) && st.elseStatement === undefined && exits(st.thenStatement)) {
          out.push({ cond: st.expression, truthy: false });
        }
      }
    }
    if (ts.isFunctionLike(p)) break;
  }
  return out;
}

/**
 * A binding holding a container this scope created (`{}`, `[]`, `new Map()`,
 * a clone): writes into it can happen wherever it escapes to. A binding
 * holding a value from elsewhere is judged where that value came from.
 */
function isFreshContainer(decl: ts.Identifier): boolean {
  const intro = introducer(decl);
  if (!ts.isVariableDeclaration(intro) || intro.name !== decl || intro.initializer === undefined) return false;
  const init = unwrap(intro.initializer);
  if (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)) return true;
  if (ts.isNewExpression(init)) return true;
  if (ts.isCallExpression(init)) {
    const name = calleeText(init);
    return name === 'JSON.parse' || name === 'structuredClone' || name === 'Object.create' || name === 'Array.from';
  }
  return false;
}

interface Write {
  /** The writing expression (its span places it in a scope). */
  node: ts.Node;
  /** The container written into. */
  target: ts.Node;
  /** Where in `target` the value lands (`set` / `push`: an element). */
  suffix: Path;
  value: ts.Node;
  /** The member of `value` that lands (`defineProperty`'s descriptor: `value`). */
  wrap: Path;
}

const writesCache = new Map<ts.SourceFile, Write[]>();

/** Every write a file makes into some container, collected once. */
function writesOf(source: ts.SourceFile): Write[] {
  const cached = writesCache.get(source);
  if (cached !== undefined) return cached;
  const out: Write[] = [];
  const add = (node: ts.Node, target: ts.Node | undefined, suffix: Path, value: ts.Node | undefined, wrap: Path = []): void => {
    if (target !== undefined && value !== undefined) out.push({ node, target, suffix, value, wrap });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n) && isAssignment(n.operatorToken.kind)) add(n, n.left, [], n.right);
    if (ts.isCallExpression(n)) {
      const callee = unwrap(n.expression);
      if (ts.isPropertyAccessExpression(callee) && WRITE_METHODS.has(callee.name.text)) {
        const m = callee.name.text;
        const values = m === 'set' ? n.arguments.slice(1, 2) : m === 'splice' ? n.arguments.slice(2) : n.arguments;
        for (const v of values) add(n, callee.expression, ['*'], v);
      }
      const name = calleeText(n);
      const target = n.arguments[0];
      if (name === 'Object.assign') for (const a of n.arguments.slice(1)) add(n, target, [], a);
      if (name === 'Object.defineProperty' || name === 'Reflect.set') {
        const key = n.arguments[1] === undefined ? undefined : unwrap(n.arguments[1]);
        const seg = key !== undefined && ts.isStringLiteralLike(key) ? key.text : '*';
        add(n, target, [seg], n.arguments[2], name === 'Reflect.set' ? [] : ['value']);
      }
      const mut = name === undefined ? undefined : MUTATORS[name];
      if (mut !== undefined) add(n, n.arguments[mut.target], ['*'], n.arguments[mut.value]);
    }
    ts.forEachChild(n, visit);
  };
  visit(source);
  writesCache.set(source, out);
  return out;
}

/**
 * The member chain from a node `matches` names out to `target`
 * (`a.b[k].c` -> `['b', '*', 'c']` for `a`), or undefined when `target` does
 * not run through it.
 */
function chainTo(target: ts.Node, matches: (n: ts.Node) => boolean): Path | undefined {
  const segments: string[] = [];
  let cur = unwrap(target);
  for (;;) {
    if (matches(cur)) return segments.reverse();
    if (ts.isPropertyAccessExpression(cur)) {
      segments.push(cur.name.text);
      cur = unwrap(cur.expression);
    } else if (ts.isElementAccessExpression(cur)) {
      const arg = unwrap(cur.argumentExpression);
      segments.push(ts.isStringLiteralLike(arg) ? arg.text : '*');
      cur = unwrap(cur.expression);
    } else {
      return undefined;
    }
  }
}

/**
 * What a write at member chain `chain` contributes to member `path`: the rest
 * of `path` below it, `[]` (all of it) when the write is inside `path`, or
 * undefined when the two part ways.
 */
function reach(chain: Path, path: Path): Path | undefined {
  const n = Math.min(chain.length, path.length);
  for (let i = 0; i < n; i++) {
    if (chain[i] !== '*' && path[i] !== '*' && chain[i] !== path[i]) return undefined;
  }
  return chain.length <= path.length ? path.slice(chain.length) : [];
}

/** Methods that write their arguments into the receiver. */
const WRITE_METHODS = new Set(['set', 'push', 'unshift', 'add', 'splice']);

/** An identifier in an expression position (not a property or declaration name). */
function isReference(n: ts.Identifier): boolean {
  const p = n.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return false;
  if (ts.isQualifiedName(p) && p.right === n) return false;
  if (
    (ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isGetAccessor(p) ||
      ts.isSetAccessor(p)) &&
    p.name === n
  ) {
    return false;
  }
  if (ts.isBindingElement(p) && p.propertyName === n) return false;
  return true;
}

function bindingIdentifiers(name: ts.BindingName): ts.Identifier[] {
  if (ts.isIdentifier(name)) return [name];
  const out: ts.Identifier[] = [];
  for (const el of name.elements) if (!ts.isOmittedExpression(el)) out.push(...bindingIdentifiers(el.name));
  return out;
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) ? name.text : undefined;
}

/**
 * The member a binding destructures directly off its parameter or initializer
 * (`{ a }`, `{ b: a }`); undefined for a plain or nested binding.
 */
function memberKey(decl: ts.Identifier): string | undefined {
  const el = decl.parent;
  if (!ts.isBindingElement(el) || el.dotDotDotToken !== undefined) return undefined;
  const pattern = el.parent;
  if (!ts.isObjectBindingPattern(pattern)) return undefined;
  if (!ts.isParameter(pattern.parent) && !ts.isVariableDeclaration(pattern.parent)) return undefined;
  if (el.propertyName === undefined) return decl.text;
  return propertyNameText(el.propertyName);
}

/**
 * A path asks for ONE member; asking for the whole value is always safe. So a
 * path of wildcards alone is the whole value, and a long one is cut to its
 * first segments: a recursive walk then meets the same key again.
 */
function normalizePath(path: Path): Path {
  const cut = path.length > MAX_PATH ? path.slice(0, MAX_PATH) : path;
  return cut.every((seg) => seg === '*') ? [] : cut;
}

const MAX_PATH = 3;

/** Whether `node` lies inside `outer` (same file, inside its span). */
function within(node: ts.Node, outer: ts.Node): boolean {
  return node.getSourceFile() === outer.getSourceFile() && node.pos >= outer.pos && node.end <= outer.end;
}

/** `path` under the member a destructured binding takes off its source. */
function withMember(decl: ts.Identifier, path: Path): Path {
  const key = memberKey(decl);
  return key === undefined ? path : [key, ...path];
}

function bindParam(name: ts.BindingName, binding: Binding, into: Map<ts.Node, Binding>): void {
  if (ts.isIdentifier(name)) {
    into.set(name, binding);
    return;
  }
  // A destructured parameter: each name holds a member of the argument.
  for (const el of name.elements) if (!ts.isOmittedExpression(el)) bindParam(el.name, binding, into);
}

function isAssignment(kind: ts.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsToken ||
    kind === ts.SyntaxKind.QuestionQuestionEqualsToken ||
    kind === ts.SyntaxKind.BarBarEqualsToken ||
    kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken
  );
}

/** `name`, `A.name` for a call to an identifier or a member of one. */
function calleeText(call: ts.CallExpression): string | undefined {
  const c = unwrap(call.expression);
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression)) return `${c.expression.text}.${c.name.text}`;
  return undefined;
}

// ---------------------------------------------------------------- sites

function enclosingFunctionName(node: ts.Node): string {
  for (let cur: ts.Node | undefined = node.parent; cur !== undefined; cur = cur.parent) {
    if (!ts.isFunctionLike(cur)) continue;
    const name = calledName(cur as FnLike);
    if (name !== undefined) return name;
    if ((ts.isMethodDeclaration(cur) || ts.isGetAccessor(cur)) && cur.name !== undefined) return cur.name.getText();
  }
  return '<module>';
}

/**
 * Whether an expression is, or runs through, a stored bag: `x.observedProperties...`,
 * or a local bound to one (`const o = r.observedProperties`, `const p = o`,
 * `const { observedProperties } = r`, a `??` / `?:` arm), followed a few hops.
 */
function runsThroughField(node: ts.Node, hops = 0): boolean {
  let cur = unwrap(node);
  for (;;) {
    if (isFieldRead(cur)) return true;
    if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) cur = unwrap(cur.expression);
    else break;
  }
  if (ts.isConditionalExpression(cur)) return runsThroughField(cur.whenTrue, hops) || runsThroughField(cur.whenFalse, hops);
  if (
    ts.isBinaryExpression(cur) &&
    (cur.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || cur.operatorToken.kind === ts.SyntaxKind.BarBarToken)
  ) {
    return runsThroughField(cur.left, hops) || runsThroughField(cur.right, hops);
  }
  if (!ts.isIdentifier(cur) || hops > 4) return false;
  const decl = declarationOf(cur);
  if (decl === undefined) return false;
  // Destructured off a record as the field, at any depth of the pattern.
  for (let el: ts.Node = decl.parent; ts.isBindingElement(el); el = el.parent.parent) {
    const key = el.propertyName === undefined ? (ts.isIdentifier(el.name) ? el.name.text : undefined) : propertyNameText(el.propertyName);
    if (key === FIELD) return true;
  }
  const intro = introducer(decl);
  if (!ts.isVariableDeclaration(intro) || intro.initializer === undefined || intro.name !== decl) return false;
  return runsThroughField(intro.initializer, hops + 1);
}

/** The function a bare call resolves to, when the repo declares it. */
function declaredFunction(callee: ts.Identifier): FnLike | undefined {
  const decl = declarationOf(callee);
  if (decl === undefined) return undefined;
  const intro = introducer(decl);
  if (ts.isFunctionDeclaration(decl.parent) && decl.parent.body !== undefined) return decl.parent;
  if (ts.isVariableDeclaration(intro) && intro.initializer !== undefined) {
    const init = unwrap(intro.initializer);
    if (isFunctionValue(init)) return init;
  }
  if (ts.isImportSpecifier(intro)) {
    const file = fileOf(callee);
    const imp = file.imports.get(callee.text);
    const target = imp === undefined ? undefined : resolveModule(file.rel, imp.module);
    return target === undefined ? undefined : exportedFunction(target, imp!.name)?.fn;
  }
  return undefined;
}

/** Whether `lit` is the first argument of `scrubResourceRecord` imported from the family. */
function isRedactionInput(lit: ts.ObjectLiteralExpression): boolean {
  let cur: ts.Node = lit;
  while (ts.isParenthesizedExpression(cur.parent) || ts.isAsExpression(cur.parent)) cur = cur.parent;
  const call = cur.parent;
  return (
    ts.isCallExpression(call) &&
    call.arguments[0] === cur &&
    ts.isIdentifier(call.expression) &&
    call.expression.text === 'scrubResourceRecord' &&
    familyCallee(call.expression)
  );
}

function sitesOf(file: ParsedFile, judge: Judge): Site[] {
  const sites: Site[] = [];
  const add = (at: ts.Node, kind: SiteKind, value: ts.Node | undefined, roots?: RootKind[]): void => {
    const sf = file.source;
    const j: Judgement =
      roots !== undefined
        ? { roots: new Set(roots), raw: [] }
        : value === undefined
          ? { roots: new Set(), raw: [`${where(at)} \`${snippet(at)}\` (a key the critic cannot follow)`] }
          : judge.judge(value, EMPTY_ENV, at);
    if (j.raw.length === 0 && j.roots.size === 0) j.raw.push(`${where(at)} \`${snippet(at)}\` (reaches no value)`);
    sites.push({
      file: file.rel,
      line: sf.getLineAndCharacterOfPosition(at.getStart(sf)).line + 1,
      fn: enclosingFunctionName(at),
      kind,
      text: snippet(at),
      roots: [...j.roots].sort(),
      raw: j.raw,
    });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && isFieldName(n.name) && ts.isObjectLiteralExpression(n.parent)) {
      if (isRedactionInput(n.parent)) add(n, 'property', undefined, ['redaction-input']);
      else add(n, 'property', n.initializer);
    } else if (ts.isShorthandPropertyAssignment(n) && n.name.text === FIELD) {
      add(n, 'shorthand', n.name);
    } else if (ts.isPropertyDeclaration(n) && isFieldName(n.name) && n.initializer !== undefined) {
      add(n, 'property', n.initializer);
    } else if (ts.isGetAccessorDeclaration(n) && isFieldName(n.name)) {
      for (const r of returnsOf(n)) add(r, 'property', r);
    } else if (ts.isCallExpression(n)) {
      // A stored bag handed to a function the repo declares: its writes into
      // that parameter (one level; bound (2)).
      const callee = unwrap(n.expression);
      const fn = ts.isIdentifier(callee) ? declaredFunction(callee) : undefined;
      n.arguments.forEach((arg, i) => {
        const param = fn?.parameters[i];
        if (param === undefined || !ts.isIdentifier(param.name) || !runsThroughField(arg)) return;
        const decl = param.name;
        const refersHere = (r: ts.Node): boolean =>
          ts.isIdentifier(r) && r.text === decl.text && r !== decl && isReference(r) && declarationOf(r) === decl;
        for (const w of writesOf(fn!.getSourceFile())) {
          if (!within(w.node, fn!)) continue;
          if (chainTo(w.target, refersHere) !== undefined) add(w.node, 'interior', w.value);
        }
      });
    } else if (ts.isStringLiteralLike(n) && n.text === FIELD && !inTypeOrKeyPosition(n)) {
      add(n, 'computed-key', undefined);
    }
    ts.forEachChild(n, visit);
  };
  // Every write into a container: the whole field, or a member of a stored bag.
  for (const w of writesOf(file.source)) {
    const target = unwrap(w.target);
    if (ts.isBinaryExpression(w.node) && isFieldRead(target)) add(w.node, 'assignment', w.value);
    else if (ts.isBinaryExpression(w.node)) {
      if ((ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target)) && runsThroughField(target.expression)) {
        add(w.node, 'interior', w.value);
      }
    } else if (runsThroughField(target)) add(w.node, 'interior', w.value);
  }
  visit(file.source);
  return sites;
}

/** A string `'observedProperties'` that is a type, a property name, an import, or a read's key. */
function inTypeOrKeyPosition(n: ts.StringLiteralLike): boolean {
  const p = n.parent;
  if (ts.isLiteralTypeNode(p)) return true;
  if ((ts.isPropertyAssignment(p) || ts.isPropertySignature(p) || ts.isPropertyDeclaration(p)) && p.name === n) return true;
  if (ts.isElementAccessExpression(p) && p.argumentExpression === n) return true;
  if (ts.isImportDeclaration(p) || ts.isExportDeclaration(p)) return true;
  if (ts.isBindingElement(p) && p.propertyName === n) return true;
  // The array a key variable iterates: each access through it is judged.
  let arr: ts.Node = p;
  while (ts.isAsExpression(arr.parent) || ts.isParenthesizedExpression(arr.parent)) arr = arr.parent;
  if (ts.isArrayLiteralExpression(p) && ts.isForOfStatement(arr.parent) && arr.parent.expression === arr) {
    const init = arr.parent.initializer;
    return ts.isVariableDeclarationList(init) && init.declarations.every((d) => ts.isIdentifier(d.name));
  }
  // An argument a key-variable parameter takes.
  if (ts.isCallExpression(p) && p.arguments.includes(n as ts.Expression) && ts.isIdentifier(p.expression)) {
    const decl = declarationOf(p.expression);
    const intro = decl === undefined ? undefined : introducer(decl);
    let fn: ts.Node | undefined;
    if (intro !== undefined && ts.isFunctionDeclaration(intro)) fn = intro;
    else if (decl !== undefined && ts.isFunctionDeclaration(decl.parent)) fn = decl.parent;
    else if (intro !== undefined && ts.isVariableDeclaration(intro) && intro.initializer !== undefined) {
      fn = unwrap(intro.initializer);
    }
    if (fn !== undefined && ts.isFunctionLike(fn)) {
      const param = fn.parameters[p.arguments.indexOf(n as ts.Expression)];
      return param !== undefined && ts.isIdentifier(param.name) && holdsFieldLiteral(param.type);
    }
  }
  return false;
}

// ---------------------------------------------------------------- driver

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Judge every write site in `sources` (repo-relative path -> text). */
export function analyzeFiles(sources: ReadonlyMap<string, string>): Site[] {
  files.clear();
  writesCache.clear();
  for (const [rel, text] of sources) files.set(rel, parse(text, rel));
  const judge = new Judge();
  const sites: Site[] = [];
  for (const file of files.values()) sites.push(...sitesOf(file, judge));
  return sites;
}

export interface Scan {
  files: number;
  sites: Site[];
}

export function scanTree(root = REPO_ROOT): Scan {
  const sources = new Map<string, string>();
  for (const full of listSourceFiles(join(root, 'src'))) {
    sources.set(relative(root, full).split('\\').join('/'), readFileSync(full, 'utf8'));
  }
  return { files: sources.size, sites: analyzeFiles(sources) };
}

/** Failures for raw sites, after the exact-count exemptions. */
export function judgeSites(sites: readonly Site[], exemptions: readonly Exemption[] = EXEMPTIONS): string[] {
  const failures: string[] = [];
  const counts = new Map<string, number>();
  for (const s of sites) {
    if (s.raw.length === 0) continue;
    const ex = exemptions.find((e) => e.file === s.file && e.fn === s.fn);
    if (ex !== undefined) {
      counts.set(`${ex.file}#${ex.fn}`, (counts.get(`${ex.file}#${ex.fn}`) ?? 0) + 1);
      continue;
    }
    failures.push(
      `${s.file}:${s.line} (${s.fn}) writes observedProperties from a value the redaction did not produce: ` +
        `\`${s.text}\`\n      ${s.raw.join('\n      ')}\n` +
        '      Route the value through redactForState / scrubResourceRecord (or copy it from a stored bag). ' +
        'If it is redacted somewhere the critic cannot see, add an EXEMPTIONS entry naming where.'
    );
  }
  for (const e of exemptions) {
    const n = counts.get(`${e.file}#${e.fn}`) ?? 0;
    if (n !== e.count) {
      failures.push(
        `exemption ${e.file} (${e.fn}) expects ${e.count} raw site(s), found ${n}` +
          (n < e.count ? ': remove or lower it' : '')
      );
    }
  }
  return failures;
}

/** Collapse toward zero: a scan reading nothing passes otherwise. */
export const FLOORS = { files: 1000, sites: 15 } as const;

/** Each site kind and root kind the critic claims to read must still be seen in the real tree. */
export const KIND_FLOORS: Readonly<Partial<Record<SiteKind | RootKind, number>>> = {
  property: 10,
  assignment: 3,
  interior: 2,
  redactor: 5,
  stored: 9,
  literal: 3,
  'physical-id': 1,
  'redaction-input': 1,
};

export function checkAll(root = REPO_ROOT): { failures: string[]; scan: Scan } {
  const scan = scanTree(root);
  const failures = judgeSites(scan.sites);
  if (scan.files < FLOORS.files) failures.push(`floor: ${scan.files} files scanned, expected >= ${FLOORS.files}`);
  if (scan.sites.length < FLOORS.sites) {
    failures.push(`floor: ${scan.sites.length} write sites, expected >= ${FLOORS.sites}: the scan stopped seeing them`);
  }
  for (const [kind, floor] of Object.entries(KIND_FLOORS)) {
    const n = scan.sites.filter((s) => s.kind === kind || s.roots.includes(kind as RootKind)).length;
    if (n < floor!) failures.push(`floor: ${n} sites of kind ${kind}, expected >= ${floor}: that shape stopped being read`);
  }
  return { failures, scan };
}

function main(): number {
  const { failures, scan } = checkAll();
  const raw = scan.sites.filter((s) => s.raw.length > 0).length;
  console.log(`observedProperties writes: ${scan.sites.length} sites in ${scan.files} files (${raw} raw before exemptions)`);
  if (process.argv.includes('--list')) {
    for (const s of scan.sites) {
      console.log(`  ${s.file}:${s.line} [${s.kind}] (${s.fn}) roots=${s.roots.join(',') || '-'}${s.raw.length > 0 ? ' RAW' : ''}`);
    }
  }
  for (const f of failures) console.log(`  ${f}`);
  return failures.length > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}

