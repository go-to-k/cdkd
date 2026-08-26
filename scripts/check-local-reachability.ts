/**
 * Local-execution reachability critic (issue #2228).
 *
 * WHAT THIS CHECKS
 * ----------------
 * cdkd's `src/local/**` is HALF cdkd's own code and half a re-export surface
 * over `cdk-local`, and the boundary between the two has moved several times.
 * When a module moves out to cdk-local, cdkd's copy does not stop compiling and
 * does not stop being tested — it stops being CALLED. What is left behind is
 * worse than dead code: it is a DECOY. It sits at the path a grep lands on, it
 * carries doc comments describing the live behaviour, and its unit tests still
 * pass. Every signal a normal verification pass produces is satisfied by
 * editing the copy that no longer runs.
 *
 * That is not hypothetical. Issue #2203's fix landed in `vtl-engine.ts` and
 * `rie-client.ts`, passed typecheck, lint, unit tests, a code review and the
 * author's own mutation probes, and shipped as a NO-OP: `cdkd local start-api`
 * runs cdk-local's `evaluateVtl`, and a live probe returned the whole value the
 * fix was supposed to truncate. Issue #1972 was the same class one round
 * earlier (`lambda-authorizer.ts` outliving its move, with a dead entry left in
 * four lists).
 *
 * So the rule is REACHABILITY, checked at the SYMBOL level:
 *
 *   every exported VALUE symbol declared with a cdkd-authored body under
 *   `src/local/**` must either be transitively reachable from a shipped entry
 *   point, or carry an annotation at its declaration saying it is not.
 *
 * WHY SYMBOL LEVEL AND NOT MODULE LEVEL
 * -------------------------------------
 * A module-level rule ("every file has a live importer") does NOT catch #2203,
 * and measuring that is the whole reason this critic is shaped the way it is.
 * `vtl-engine.ts` HAS a live importer: `rest-v1-integrations.ts` imports
 * `evaluateVtl` from it, and `local-start-api.ts` imports `warnSsrfRiskyUri`
 * from `rest-v1-integrations.ts`. Under ESM that import chain LOADS
 * `vtl-engine.ts` at runtime — the module is evaluated, so "unreferenced" is
 * false of it — while every function it exports is called only from functions
 * that are themselves never called. Three states, not two:
 *
 *   LIVE          a shipped entry point transitively reaches the symbol.
 *   LOADED-ONLY   the module is evaluated at runtime (some other symbol in it,
 *                 or a `verbatimModuleSyntax` inline-type import, drags it in)
 *                 but no exported symbol is reached.  <- vtl-engine.ts
 *   UNREFERENCED  nothing in `src/` imports the module at all.
 *
 * The last two are equally inert to a user and equally attractive to a fix.
 *
 * WHY THE ANNOTATION, AND WHY IT IS NOT "JUST A COMMENT"
 * -----------------------------------------------------
 * Issue #2228 lists three options: delete the fork, mechanize the drift check,
 * or annotate each orphan. Annotation ALONE is the weakest — it is a comment
 * asking the next reader to remember, which is what both prior instances of
 * this class already had. But a CI check alone does not reach the author
 * either: the tree already contains orphans, so any check that has to be green
 * today must tolerate them, and a tolerated orphan is invisible at exactly the
 * moment someone edits it.
 *
 * This critic is the two together, with the mechanism making the annotation
 * non-optional and non-stale, in BOTH directions:
 *
 *   - an unreachable exported symbol with NO annotation FAILS. So a module
 *     losing its last live caller cannot land silently.
 *   - an annotation on a symbol that IS reachable FAILS as stale. So the
 *     annotations cannot rot into decoration, and — see below — this is also
 *     what stops the critic degrading to a vacuous green.
 *
 * Annotating is the FLOOR, not the destination: DELETING the orphans is issue
 * https://github.com/go-to-k/cdkd/issues/2277, kept separate because removing a
 * subsystem and its tests is a different review from adding a critic. Note that
 * when that lands and the annotation count reaches zero, the stale direction
 * stops defending anything and {@link runSelfProbe} is all that remains.
 *
 * WHAT DEFENDS THIS CRITIC FROM ITSELF
 * ------------------------------------
 *  1. COLLAPSE TOWARD ZERO — the scan silently yields nothing (a renamed
 *     directory, a compiler-API change, an entry point that moved, a file that
 *     stops parsing). The FLOORS below catch this, plus a hard failure on any
 *     file with parse diagnostics and on a missing entry point. A build entry
 *     that moves without this file moving with it is caught separately by
 *     {@link checkBuildEntriesInSync}, because a critic rooted at a path that
 *     is no longer the shipped entry reports everything as dead — loudly, but
 *     for the wrong reason — or, if it were written to tolerate that, silently.
 *
 *  2. COLLAPSE TOWARD GREEN — the reachability computation degrades so that
 *     everything reads as reachable. No floor sees this: file and symbol counts
 *     are unchanged. Two things catch it. While orphans exist, the STALE
 *     direction does it for free: if everything is reachable then every
 *     existing `@no-live-caller` is stale and the run fails. That defence
 *     disappears the day the orphans are deleted, so it is not the primary one.
 *     The primary one is {@link runSelfProbe} — a fixed corpus with known
 *     verdicts, including a known LOADED-ONLY module and a known live shim,
 *     analyzed on every run before the real tree is touched.
 *
 * WHAT IS EXEMPT, AND WHY IT IS STRUCTURAL RATHER THAN AN ALLOWLIST
 * ----------------------------------------------------------------
 * Roughly half of `src/local/**` is legitimately a re-export shim —
 * `http-server.ts` is `export { startApiServer } from 'cdk-local/internal'`
 * and is exactly right. A shim declares no value symbol of its own, so it
 * falls out of the population by construction rather than by being listed:
 * there is no cdkd-authored body in it for a fix to land in, and an author who
 * greps into one sees a re-export and follows it to cdk-local. That is the
 * difference this critic draws — "a shim that re-exports" versus "a fork with a
 * body and no consumer" — and it needs no allowlist to draw it, so it cannot go
 * stale the way an allowlist would.
 *
 * SCOPE, AND THE MEASUREMENT BEHIND IT
 * ------------------------------------
 * The default scope is `src/local`, which is #2228's subject. Measured
 * 2026-08-26 against the whole of `src/`: LOADED-ONLY and UNREFERENCED modules
 * exist ONLY under `src/local/**` (2 of each), which is what makes this
 * directory the right subject — it is the only one with a moving fork
 * boundary. Repo-wide, `--scope=src` additionally reports ~30 unreachable
 * exported symbols in other directories; the large majority are test-reset
 * seams (`resetLiveRenderer`, `clearWriteOnlyPropertiesCache`, ...) rather than
 * decoys, and annotating them is a separate, lower-value pass. Widening the
 * default is issue https://github.com/go-to-k/cdkd/issues/2276.
 *
 * WHAT THIS CRITIC DOES NOT CLAIM
 * -------------------------------
 * Reachability here is an OVER-APPROXIMATION of what runs: a reference from
 * anywhere inside a declaration counts, parameter and local names are not
 * distinguished from imports of the same spelling, and a dynamic
 * `import('./x.js')` marks every export of `x` reachable. Every one of those
 * biases toward calling a symbol LIVE. That is the safe direction for a gate —
 * it cannot manufacture a false accusation — and it means a "no finding" result
 * is not proof that a symbol executes, only that something references it.
 *
 * USAGE
 *   node --experimental-strip-types scripts/check-local-reachability.ts
 *   node --experimental-strip-types scripts/check-local-reachability.ts --json
 *   node --experimental-strip-types scripts/check-local-reachability.ts --scope=src
 */

import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript-v6';

const SCRIPT_DIR = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const SRC_ROOT = join(REPO_ROOT, 'src');
const VITE_CONFIG = join(REPO_ROOT, 'vite.config.ts');

/**
 * The shipped entry points, i.e. `pack.entry` in `vite.config.ts`. Everything
 * users can reach — the `cdkd` binary and the library export — starts here.
 * Kept in sync with the build by {@link checkBuildEntriesInSync}.
 */
const ENTRY_RELATIVE = ['src/index.ts', 'src/cli/index.ts'] as const;

/** Annotation tags that make an unreachable exported symbol admissible. */
export const NO_LIVE_CALLER_TAG = '@no-live-caller';
export const TEST_ONLY_TAG = '@test-only-export';

/**
 * Minimum characters of prose a tag must carry. A bare tag is a silencer: it
 * costs nothing to write and says nothing, which is how an annotation scheme
 * decays into decoration. The reason has to name where the live implementation
 * is (or that there is none), because that sentence is the entire payload an
 * author editing the body will read.
 */
const MIN_REASON_CHARS = 24;

// ---------------------------------------------------------------------------
// FLOORS — collapse toward zero
// ---------------------------------------------------------------------------
/** Minimum `src/**` files a healthy scan parses. */
const MIN_SRC_FILES = 250;
/** Minimum modules the load closure reaches from the entry points. */
const MIN_LOADED_MODULES = 240;
/** Minimum symbols the reachability walk marks live across all of `src/`. */
const MIN_REACHABLE_SYMBOLS = 900;
/** Minimum files in the checked scope. */
const MIN_SCOPE_FILES = 40;
/** Minimum LIVE exported symbols in the checked scope. */
const MIN_LIVE_SCOPE_SYMBOLS = 40;
/**
 * Minimum re-export shims in the checked scope.
 *
 * This one is not decoration. Shims are exempt BY CONSTRUCTION (they declare no
 * value symbol), so a parser regression that stopped recognising `export ...
 * from` would move every shim into "declares nothing" — which is also exempt —
 * and the run would stay green having lost the distinction the exemption rests
 * on. The floor is what makes that regression loud.
 */
const MIN_SHIM_FILES = 30;

export type ModuleClass =
  | 'live'
  | 'live-partial'
  | 'loaded-only'
  | 'unreferenced'
  | 'shim-consumed'
  | 'shim-unreferenced'
  | 'types-only';

export type FindingKind = 'unannotated' | 'stale-annotation' | 'bare-annotation';

export interface Finding {
  readonly file: string;
  readonly line: number;
  readonly symbol: string;
  readonly kind: FindingKind;
  readonly tag?: string;
}

export interface ScopeModule {
  readonly file: string;
  readonly moduleClass: ModuleClass;
  readonly loaded: boolean;
  readonly exportedSymbols: number;
  readonly liveSymbols: number;
  readonly deadSymbols: readonly string[];
}

export interface ReachabilityReport {
  readonly filesScanned: number;
  readonly loadedModules: number;
  readonly reachableSymbols: number;
  readonly scopeFiles: number;
  readonly scopeExportedSymbols: number;
  readonly liveScopeSymbols: number;
  readonly deadScopeSymbols: number;
  readonly shimFiles: number;
  readonly annotatedNoLiveCaller: number;
  readonly annotatedTestOnly: number;
  readonly modules: readonly ScopeModule[];
  readonly findings: readonly Finding[];
  readonly parseErrors: readonly string[];
}

export interface AnalysisInput {
  /** Absolute path -> source text. The only thing the analysis reads. */
  readonly sources: ReadonlyMap<string, string>;
  /** Absolute paths of the shipped entry points. */
  readonly entries: readonly string[];
  /** Absolute directory prefix whose modules are reported on and gated. */
  readonly scopeRoot: string;
  /** Used only to render paths in findings. */
  readonly repoRoot: string;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface ImportBinding {
  readonly spec: string;
  readonly imported: string;
  readonly typeOnly: boolean;
}

interface ReExport {
  readonly spec: string;
  readonly exported: string;
  readonly imported: string;
  readonly typeOnly: boolean;
  readonly star: boolean;
}

interface DeclInfo {
  readonly exported: boolean;
  readonly refs: Set<string>;
  readonly dynamicSpecs: Set<string>;
  readonly line: number;
  readonly tag?: string;
  readonly reasonChars: number;
}

interface FileInfo {
  readonly path: string;
  readonly importsByLocal: Map<string, ImportBinding>;
  readonly reexports: ReExport[];
  readonly decls: Map<string, DeclInfo>;
  readonly moduleRefs: Set<string>;
  readonly moduleDynamicSpecs: Set<string>;
  readonly importedFiles: Set<string>;
  /** True when the file re-exports from a package (not a relative path). */
  readonly hasExternalReExport: boolean;
}

/**
 * Collects the identifiers a declaration REFERENCES, skipping type positions.
 *
 * Type positions are skipped because a type reference emits nothing: under
 * `verbatimModuleSyntax` an inline `{ type X }` import still loads the MODULE
 * (which is why `reload-orchestrator.ts` classifies as loaded-only rather than
 * unreferenced) but it never makes the exported VALUE run. A `class C extends
 * B` heritage clause is the opposite case and is walked, because `extends` is
 * evaluated; `implements` is not.
 */
function collectRefs(node: ts.Node, out: Set<string>, dynamicSpecs: Set<string>): void {
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = n.arguments[0];
      if (arg && ts.isStringLiteral(arg)) dynamicSpecs.add(arg.text);
      return;
    }
    if (ts.isHeritageClause(n)) {
      if (n.token === ts.SyntaxKind.ExtendsKeyword) for (const t of n.types) visit(t.expression);
      return;
    }
    if (ts.isTypeNode(n) || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) return;
    // `a.b` references `a`, never `b`; `{ k: v }` references `v`, never `k`.
    if (ts.isPropertyAccessExpression(n)) return visit(n.expression);
    if (ts.isPropertyAssignment(n)) return visit(n.initializer);
    if (ts.isIdentifier(n)) {
      out.add(n.text);
      return;
    }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
}

/** Reads the annotation tag, if any, out of a statement's leading comments. */
function readTag(text: string, node: ts.Node): { tag?: string; reasonChars: number } {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  for (const tag of [NO_LIVE_CALLER_TAG, TEST_ONLY_TAG]) {
    for (const range of ranges) {
      const comment = text.slice(range.pos, range.end);
      const at = comment.indexOf(tag);
      if (at < 0) continue;
      const reason = comment
        .slice(at + tag.length)
        .replace(/^[ \t]*[-:—]?[ \t]*/, '')
        .replace(/[*/\s]+/g, ' ')
        .trim();
      return { tag, reasonChars: reason.length };
    }
  }
  return { reasonChars: 0 };
}

function parseFile(path: string, text: string): { info: FileInfo; parseError?: string } {
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  // `createSourceFile` records only syntactic diagnostics, which is exactly the
  // failure mode that matters here: a file that does not parse contributes zero
  // symbols and would otherwise read as "nothing dead in it".
  const syntactic = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] })
    .parseDiagnostics;
  const info: FileInfo = {
    path,
    importsByLocal: new Map(),
    reexports: [],
    decls: new Map(),
    moduleRefs: new Set(),
    moduleDynamicSpecs: new Set(),
    importedFiles: new Set(),
    hasExternalReExport: false,
  };
  let externalReExports = 0;

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      const clause = st.importClause;
      // A whole-declaration `import type { X } from 'y'` is erased entirely; an
      // inline `import { type X }` is not, under `verbatimModuleSyntax`.
      if (!clause?.isTypeOnly) info.importedFiles.add(spec);
      if (!clause) continue;
      const typeOnly = clause.isTypeOnly;
      if (clause.name) {
        info.importsByLocal.set(clause.name.text, { spec, imported: 'default', typeOnly });
      }
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        info.importsByLocal.set(named.name.text, { spec, imported: '*', typeOnly });
      }
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          info.importsByLocal.set(el.name.text, {
            spec,
            imported: (el.propertyName ?? el.name).text,
            typeOnly: typeOnly || el.isTypeOnly,
          });
        }
      }
      continue;
    }

    if (ts.isExportDeclaration(st) && st.moduleSpecifier) {
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      if (!st.isTypeOnly) info.importedFiles.add(spec);
      if (!spec.startsWith('.')) externalReExports++;
      if (!st.exportClause) {
        info.reexports.push({ spec, exported: '*', imported: '*', typeOnly: st.isTypeOnly, star: true });
      } else if (ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          info.reexports.push({
            spec,
            exported: el.name.text,
            imported: (el.propertyName ?? el.name).text,
            typeOnly: st.isTypeOnly || el.isTypeOnly,
            star: false,
          });
        }
      }
      continue;
    }

    const modifiers = ts.canHaveModifiers(st) ? (ts.getModifiers(st) ?? []) : [];
    const exported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const line = sf.getLineAndCharacterOfPosition(st.getStart(sf)).line + 1;
    const { tag, reasonChars } = readTag(text, st);

    const addDecl = (name: string, node: ts.Node): void => {
      const refs = new Set<string>();
      const dynamicSpecs = new Set<string>();
      collectRefs(node, refs, dynamicSpecs);
      info.decls.set(name, { exported, refs, dynamicSpecs, line, tag, reasonChars });
    };

    if (ts.isFunctionDeclaration(st) && st.name) addDecl(st.name.text, st);
    else if (ts.isClassDeclaration(st) && st.name) addDecl(st.name.text, st);
    else if (ts.isEnumDeclaration(st)) addDecl(st.name.text, st);
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const names: string[] = [];
        const bind = (n: ts.BindingName): void => {
          if (ts.isIdentifier(n)) names.push(n.text);
          else for (const el of n.elements) if (ts.isBindingElement(el)) bind(el.name);
        };
        bind(d.name);
        for (const name of names) addDecl(name, d);
      }
    } else if (!ts.isInterfaceDeclaration(st) && !ts.isTypeAliasDeclaration(st)) {
      // Anything else at top level runs on module evaluation.
      collectRefs(st, info.moduleRefs, info.moduleDynamicSpecs);
      if (ts.isExpressionStatement(st) && ts.isIdentifier(st.expression)) {
        info.moduleRefs.add(st.expression.text);
      }
    }
  }

  for (const decl of info.decls.values()) {
    for (const spec of decl.dynamicSpecs) info.importedFiles.add(spec);
  }
  for (const spec of info.moduleDynamicSpecs) info.importedFiles.add(spec);

  const parseError =
    syntactic && syntactic.length > 0
      ? `${path}: ${syntactic.length} parse diagnostic(s); first: ${ts.flattenDiagnosticMessageText(syntactic[0]!.messageText, ' ')}`
      : undefined;

  return {
    info: { ...info, hasExternalReExport: externalReExports > 0 },
    parseError,
  };
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export function analyzeReachability(input: AnalysisInput): ReachabilityReport {
  const { sources, entries, scopeRoot, repoRoot } = input;
  const infos = new Map<string, FileInfo>();
  const parseErrors: string[] = [];

  for (const [path, text] of sources) {
    const { info, parseError } = parseFile(path, text);
    infos.set(path, info);
    if (parseError) parseErrors.push(parseError);
  }

  const resolveSpec = (from: string, spec: string): string | undefined => {
    if (!spec.startsWith('.')) return undefined;
    const base = resolve(dirname(from), spec);
    const candidates = [
      base.endsWith('.js') ? `${base.slice(0, -3)}.ts` : `${base}.ts`,
      `${base.replace(/\.js$/, '')}${sep}index.ts`,
      base,
    ];
    for (const c of candidates) if (sources.has(c)) return c;
    return undefined;
  };

  // ---- module load closure -------------------------------------------------
  const loaded = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (loaded.has(file)) continue;
    loaded.add(file);
    const info = infos.get(file);
    if (!info) continue;
    for (const spec of info.importedFiles) {
      const target = resolveSpec(file, spec);
      if (target && !loaded.has(target)) stack.push(target);
    }
  }

  // ---- symbol graph --------------------------------------------------------
  const key = (file: string, name: string): string => `${file}#${name}`;
  const MODULE_SYMBOL = '<module>';

  const exportCache = new Map<string, string[]>();
  const resolveExport = (file: string, name: string, seen: Set<string>): string[] => {
    const ck = key(file, name);
    const cached = exportCache.get(ck);
    if (cached) return cached;
    if (seen.has(ck)) return [];
    seen.add(ck);
    const info = infos.get(file);
    if (!info) return [];
    if (info.decls.has(name)) {
      exportCache.set(ck, [ck]);
      return [ck];
    }
    const out: string[] = [];
    for (const re of info.reexports) {
      if (re.typeOnly) continue;
      const target = resolveSpec(file, re.spec);
      if (!target) continue;
      if (re.star) out.push(...resolveExport(target, name, seen));
      else if (re.exported === name) out.push(...resolveExport(target, re.imported, seen));
    }
    exportCache.set(ck, out);
    return out;
  };

  const edges = new Map<string, Set<string>>();
  const addEdges = (
    file: string,
    info: FileInfo,
    from: string,
    refs: Set<string>,
    dynamicSpecs: Set<string>
  ): void => {
    let set = edges.get(from);
    if (!set) {
      set = new Set();
      edges.set(from, set);
    }
    for (const ref of refs) {
      if (info.decls.has(ref)) {
        set.add(key(file, ref));
        continue;
      }
      const imported = info.importsByLocal.get(ref);
      if (!imported || imported.typeOnly) continue;
      const target = resolveSpec(file, imported.spec);
      if (!target) continue;
      if (imported.imported === '*' || imported.imported === 'default') {
        const ti = infos.get(target);
        if (ti) for (const name of ti.decls.keys()) set.add(key(target, name));
        continue;
      }
      for (const sym of resolveExport(target, imported.imported, new Set())) set.add(sym);
    }
    // A dynamic import is opaque: mark every export of the target reachable.
    for (const spec of dynamicSpecs) {
      const target = resolveSpec(file, spec);
      const ti = target ? infos.get(target) : undefined;
      if (ti) for (const [name, d] of ti.decls) if (d.exported) set.add(key(target!, name));
    }
  };

  for (const [file, info] of infos) {
    for (const [name, decl] of info.decls) {
      addEdges(file, info, key(file, name), decl.refs, decl.dynamicSpecs);
    }
    addEdges(file, info, key(file, MODULE_SYMBOL), info.moduleRefs, info.moduleDynamicSpecs);
  }

  // ---- roots ---------------------------------------------------------------
  const roots = new Set<string>();
  // Every LOADED module's top-level statements run on evaluation.
  for (const file of loaded) roots.add(key(file, MODULE_SYMBOL));
  // Everything an entry point exports is public API a consumer may call.
  for (const entry of entries) {
    const info = infos.get(entry);
    if (!info) continue;
    for (const [name, decl] of info.decls) if (decl.exported) roots.add(key(entry, name));
    for (const re of info.reexports) {
      if (re.typeOnly) continue;
      const target = resolveSpec(entry, re.spec);
      if (!target) continue;
      if (re.star) {
        const ti = infos.get(target);
        if (ti) for (const [n, d] of ti.decls) if (d.exported) roots.add(key(target, n));
      } else {
        for (const sym of resolveExport(target, re.imported, new Set())) roots.add(sym);
      }
    }
  }

  const reachable = new Set<string>();
  const walk = [...roots];
  while (walk.length > 0) {
    const sym = walk.pop()!;
    if (reachable.has(sym)) continue;
    reachable.add(sym);
    for (const next of edges.get(sym) ?? []) if (!reachable.has(next)) walk.push(next);
  }

  // ---- scope report --------------------------------------------------------
  const prefix = scopeRoot.endsWith(sep) ? scopeRoot : scopeRoot + sep;
  const scopeFiles = [...sources.keys()].filter((f) => f.startsWith(prefix)).sort();

  const modules: ScopeModule[] = [];
  const findings: Finding[] = [];
  let scopeExportedSymbols = 0;
  let liveScopeSymbols = 0;
  let deadScopeSymbols = 0;
  let shimFiles = 0;
  let annotatedNoLiveCaller = 0;
  let annotatedTestOnly = 0;

  for (const file of scopeFiles) {
    const info = infos.get(file)!;
    const rel = relative(repoRoot, file);
    const exported = [...info.decls.entries()].filter(([, d]) => d.exported);
    const live: string[] = [];
    const dead: string[] = [];

    for (const [name, decl] of exported) {
      const isReachable = reachable.has(key(file, name));
      if (isReachable) live.push(name);
      else dead.push(name);

      if (decl.tag) {
        if (decl.tag === NO_LIVE_CALLER_TAG) annotatedNoLiveCaller++;
        else annotatedTestOnly++;
      }

      if (isReachable && decl.tag) {
        findings.push({ file: rel, line: decl.line, symbol: name, kind: 'stale-annotation', tag: decl.tag });
      } else if (!isReachable && !decl.tag) {
        findings.push({ file: rel, line: decl.line, symbol: name, kind: 'unannotated' });
      } else if (!isReachable && decl.reasonChars < MIN_REASON_CHARS) {
        findings.push({ file: rel, line: decl.line, symbol: name, kind: 'bare-annotation', tag: decl.tag });
      }
    }

    scopeExportedSymbols += exported.length;
    liveScopeSymbols += live.length;
    deadScopeSymbols += dead.length;

    const isLoaded = loaded.has(file);
    let moduleClass: ModuleClass;
    if (exported.length === 0) {
      if (info.hasExternalReExport) {
        shimFiles++;
        moduleClass = isLoaded ? 'shim-consumed' : 'shim-unreferenced';
      } else moduleClass = 'types-only';
    } else if (live.length > 0) moduleClass = dead.length === 0 ? 'live' : 'live-partial';
    else moduleClass = isLoaded ? 'loaded-only' : 'unreferenced';

    modules.push({
      file: rel,
      moduleClass,
      loaded: isLoaded,
      exportedSymbols: exported.length,
      liveSymbols: live.length,
      deadSymbols: dead,
    });
  }

  return {
    filesScanned: sources.size,
    loadedModules: loaded.size,
    reachableSymbols: reachable.size,
    scopeFiles: scopeFiles.length,
    scopeExportedSymbols,
    liveScopeSymbols,
    deadScopeSymbols,
    shimFiles,
    annotatedNoLiveCaller,
    annotatedTestOnly,
    modules,
    findings,
    parseErrors,
  };
}

// ---------------------------------------------------------------------------
// Source tree
// ---------------------------------------------------------------------------

export function readSourceTree(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walkDir = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walkDir(p);
      else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.set(p, readFileSync(p, 'utf8'));
    }
  };
  walkDir(root);
  return out;
}

/**
 * A critic rooted at a path that is no longer a shipped entry point reports the
 * whole tree as dead. That is loud, but it points at the source files rather
 * than at this constant, so it is worth naming the real cause directly.
 */
export function checkBuildEntriesInSync(viteConfigText: string): string[] {
  const failures: string[] = [];
  for (const entry of ENTRY_RELATIVE) {
    if (!viteConfigText.includes(`'${entry}'`)) {
      failures.push(
        `vite.config.ts no longer lists \`${entry}\` as a pack entry. This critic's ` +
          `reachability roots are ENTRY_RELATIVE in scripts/check-local-reachability.ts; ` +
          `update them together or every symbol reads as unreachable.`
      );
    }
  }
  return failures;
}

// ---------------------------------------------------------------------------
// SELF-PROBE — collapse toward green
// ---------------------------------------------------------------------------

const PROBE_ROOT = '/probe';
const PROBE_SRC = `${PROBE_ROOT}${sep}src`;

/**
 * A fixed corpus with known verdicts, analyzed before the real tree on every
 * run. It contains one module of every class this critic distinguishes -
 * including the two a naive module-level rule collapses together (`loaded-only`
 * versus `live`) and both halves of the shim exemption - and one instance of
 * every finding kind, so a classifier degrading toward "everything is
 * reachable" and one degrading toward "everything is dead" are BOTH caught.
 *
 * It also carries four SHAPES THE REAL TREE HAPPENS NOT TO CONTAIN today - a
 * type-only re-export, a module reached only by `import type`, an entry point
 * that declares (rather than re-exports) its own API, and a class reaching its
 * base through `extends`. Each of those is a clause in the analysis whose
 * removal changes nothing about `src/`, so the real-tree probes cannot see it
 * and a later refactor would silently lose it. The real tree stays the primary
 * subject; this corpus is where the clauses that have no real instance yet get
 * their fence.
 */
function probeSources(): Map<string, string> {
  const f = (p: string): string => join(PROBE_SRC, ...p.split('/'));
  const reason = 'cdk-local owns the live implementation of this; see its own copy.';
  return new Map<string, string>([
    [
      f('index.ts'),
      `import { libExport2 } from './scope/lib2.js';\n` +
        `export { libExport } from './scope/lib.js';\n` +
        `export function libraryApi(): number { return libExport2; }\n`,
    ],
    [
      f('cli/index.ts'),
      `import { entryUsed } from '../scope/live.js';\n` +
        `import { startApiServer } from '../scope/shim.js';\n` +
        `import { stillLive } from '../scope/stale.js';\n` +
        `import { Derived } from '../scope/derived.js';\n` +
        `import { orphan as viaTypeHub } from '../scope/type-hub.js';\n` +
        `import type { typeOnlyTarget } from '../scope/type-only-target.js';\n` +
        `entryUsed();\n` +
        `startApiServer();\n` +
        `stillLive();\n` +
        `void Derived;\n` +
        `void viaTypeHub;\n`,
    ],
    [
      f('scope/live.ts'),
      `import { evaluate } from './loaded-only.js';\n` +
        `export function entryUsed(): number { return helper(); }\n` +
        `export function helper(): number { return 1; }\n` +
        `export function neverCalled(): number { return evaluate(); }\n`,
    ],
    [f('scope/loaded-only.ts'), `export function evaluate(): number { return 2; }\n`],
    [f('scope/lib.ts'), `export const libExport = 3;\n`],
    // Reached ONLY through the entry point's own exported declaration, so the
    // entry-declaration root is load-bearing for it.
    [f('scope/lib2.ts'), `export const libExport2 = 4;\n`],
    [f('scope/unreferenced.ts'), `export function orphan(): number { return 5; }\n`],
    [f('scope/shim.ts'), `export { startApiServer } from 'cdk-local/internal';\n`],
    [f('scope/shim-orphan.ts'), `export { unusedShim } from 'cdk-local/internal';\n`],
    [
      f('scope/annotated.ts'),
      `/** ${NO_LIVE_CALLER_TAG} ${reason} */\nexport function annotatedDead(): number { return 6; }\n`,
    ],
    [
      f('scope/stale.ts'),
      `/** ${NO_LIVE_CALLER_TAG} ${reason} */\nexport function stillLive(): number { return 7; }\n`,
    ],
    [
      f('scope/bare.ts'),
      `/** ${NO_LIVE_CALLER_TAG} dead */\nexport function bareAnnotated(): number { return 8; }\n`,
    ],
    // `Base` is reached ONLY through `extends`, which is a value position
    // sitting inside a heritage clause the type-skipping walk would otherwise
    // discard.
    [f('scope/base.ts'), `export class Base {}\n`],
    [
      f('scope/derived.ts'),
      `import { Base } from './base.js';\nexport class Derived extends Base {}\n`,
    ],
    // An erased re-export must not carry reachability through to `orphan`.
    [f('scope/type-hub.ts'), `export type { orphan } from './unreferenced.js';\n`],
    // Reached only by `import type`, which is erased whole, so the module is
    // never even loaded.
    [
      f('scope/type-only-target.ts'),
      `export function typeOnlyTarget(): number { return 9; }\n`,
    ],
  ]);
}

export function runSelfProbe(analyze: (input: AnalysisInput) => ReachabilityReport): string[] {
  const report = analyze({
    sources: probeSources(),
    entries: [join(PROBE_SRC, 'index.ts'), join(PROBE_SRC, 'cli', 'index.ts')],
    scopeRoot: join(PROBE_SRC, 'scope'),
    repoRoot: PROBE_ROOT,
  });
  const failures: string[] = [];
  // Test seam. Without it, `main()` dropping its call to this probe changes
  // NOTHING observable: the unit tests call `runSelfProbe` directly, so the
  // probe stays green while the binary stops consulting it - the critic's
  // primary defence against collapse-toward-green, silently disconnected.
  // With it, one spawn proves end to end that a probe failure reaches exit 1.
  if (process.env.CDKD_SELF_PROBE_FORCE_FAIL === '1') {
    failures.push('self-probe: forced failure via CDKD_SELF_PROBE_FORCE_FAIL (test seam)');
  }
  const byName = new Map(report.modules.map((m) => [m.file.split(sep).pop()!, m]));

  for (const [name, cls] of [
    ['live.ts', 'live-partial'],
    ['loaded-only.ts', 'loaded-only'],
    ['lib.ts', 'live'],
    ['lib2.ts', 'live'],
    ['unreferenced.ts', 'unreferenced'],
    ['shim.ts', 'shim-consumed'],
    ['shim-orphan.ts', 'shim-unreferenced'],
    ['base.ts', 'live'],
    ['derived.ts', 'live'],
    ['type-hub.ts', 'types-only'],
    ['type-only-target.ts', 'unreferenced'],
  ] as const) {
    const mod = byName.get(name);
    if (!mod) failures.push(`self-probe: module ${name} missing from the report`);
    else if (mod.moduleClass !== cls) {
      failures.push(`self-probe: ${name} classified ${mod.moduleClass}, expected ${cls}`);
    }
  }

  const kinds = new Map<string, FindingKind>();
  for (const finding of report.findings) kinds.set(finding.symbol, finding.kind);

  // Direction 1: unreachable symbols must be REPORTED. A classifier that
  // degrades toward "everything reachable" fails here.
  for (const [symbol, kind] of [
    ['evaluate', 'unannotated'],
    ['neverCalled', 'unannotated'],
    ['orphan', 'unannotated'],
    ['typeOnlyTarget', 'unannotated'],
    ['bareAnnotated', 'bare-annotation'],
    ['stillLive', 'stale-annotation'],
  ] as const) {
    const actual = kinds.get(symbol);
    if (actual !== kind) {
      failures.push(`self-probe: expected \`${symbol}\` reported as ${kind}, saw ${actual ?? 'nothing'}`);
    }
  }

  // Direction 2: reachable symbols, an annotated orphan and a consumed shim
  // must produce NOTHING. A classifier that degrades toward "everything dead",
  // or an exemption that stops covering shims, fails here.
  for (const symbol of [
    'entryUsed',
    'helper',
    'libExport',
    'libExport2',
    'libraryApi',
    'annotatedDead',
    'startApiServer',
    'Base',
    'Derived',
  ]) {
    if (kinds.has(symbol)) {
      failures.push(`self-probe: \`${symbol}\` must not be reported, saw ${kinds.get(symbol)}`);
    }
  }

  if (report.shimFiles !== 2) failures.push(`self-probe: expected 2 shims, saw ${report.shimFiles}`);
  if (report.findings.length !== 6) {
    failures.push(`self-probe: expected exactly 6 findings, saw ${report.findings.length}`);
  }
  return failures;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function describe(finding: Finding): string {
  switch (finding.kind) {
    case 'unannotated':
      return (
        `${finding.file}:${finding.line}: \`${finding.symbol}\` is exported with a ` +
        `cdkd-authored body but NOTHING in \`src/\` transitively reaches it from a shipped ` +
        `entry point, so a fix landing in it ships as a no-op while every gate stays green ` +
        `(issue #2203). Either delete it, restore its caller, or — if cdk-local owns the ` +
        `live implementation — annotate the declaration:\n` +
        `      /** ${NO_LIVE_CALLER_TAG} cdk-local owns the live copy; see cdk-local's <file>. */\n` +
        `    A test-only reset seam takes ${TEST_ONLY_TAG} instead.`
      );
    case 'stale-annotation':
      return (
        `${finding.file}:${finding.line}: \`${finding.symbol}\` carries \`${finding.tag}\` but IS ` +
        `reachable from a shipped entry point. The annotation is stale and now says the ` +
        `opposite of the truth — remove it.`
      );
    case 'bare-annotation':
      return (
        `${finding.file}:${finding.line}: \`${finding.symbol}\` carries \`${finding.tag}\` with ` +
        `fewer than ${MIN_REASON_CHARS} characters of reason. The reason is the payload — name ` +
        `where the live implementation lives, or say there is none.`
      );
  }
}

export function main(argv: readonly string[]): number {
  const json = argv.includes('--json');
  const scopeArg = argv.find((a) => a.startsWith('--scope='))?.slice('--scope='.length);
  const scopeRoot = scopeArg ? resolve(REPO_ROOT, scopeArg) : join(SRC_ROOT, 'local');

  // A mistyped `--scope=` silently checks the DEFAULT scope and reports a green
  // for a directory the caller did not ask about, so an unknown argument is a
  // hard error rather than something to ignore.
  const unknown = argv.filter((a) => a !== '--json' && !a.startsWith('--scope='));
  if (unknown.length > 0) {
    process.stderr.write(
      `Unrecognized argument(s): ${unknown.join(' ')}\nUsage: check-local-reachability.ts [--json] [--scope=<dir>]\n`
    );
    return 2;
  }

  const failures: string[] = [];

  for (const failure of runSelfProbe(analyzeReachability)) failures.push(failure);
  try {
    for (const failure of checkBuildEntriesInSync(readFileSync(VITE_CONFIG, 'utf8'))) {
      failures.push(failure);
    }
  } catch (error) {
    failures.push(`could not read vite.config.ts: ${error instanceof Error ? error.message : String(error)}`);
  }

  let report: ReachabilityReport | undefined;
  try {
    const sources = readSourceTree(SRC_ROOT);
    const entries = ENTRY_RELATIVE.map((e) => join(REPO_ROOT, ...e.split('/')));
    for (const entry of entries) {
      if (!sources.has(entry)) failures.push(`entry point ${relative(REPO_ROOT, entry)} does not exist`);
    }
    report = analyzeReachability({ sources, entries, scopeRoot, repoRoot: REPO_ROOT });
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  }

  if (report) {
    if (json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

    for (const parseError of report.parseErrors) failures.push(parseError);

    const floors: [number, number, string][] = [
      [report.filesScanned, MIN_SRC_FILES, 'src files parsed'],
      [report.loadedModules, MIN_LOADED_MODULES, 'modules in the load closure'],
      [report.reachableSymbols, MIN_REACHABLE_SYMBOLS, 'reachable symbols'],
      [report.scopeFiles, MIN_SCOPE_FILES, 'files in scope'],
      [report.liveScopeSymbols, MIN_LIVE_SCOPE_SYMBOLS, 'live exported symbols in scope'],
      [report.shimFiles, MIN_SHIM_FILES, 're-export shims in scope'],
    ];
    for (const [actual, minimum, label] of floors) {
      if (actual < minimum) {
        failures.push(`found ${actual} ${label}, expected at least ${minimum} (parser regression?)`);
      }
    }

    for (const finding of report.findings) failures.push(describe(finding));
  }

  if (failures.length > 0) {
    process.stderr.write(`local reachability check FAILED (${failures.length} problems)\n\n`);
    for (const failure of failures) process.stderr.write(`  - ${failure}\n`);
    process.stderr.write('\n');
    return 1;
  }

  process.stdout.write(
    `local reachability check OK — ${report?.scopeFiles} files in ${relative(REPO_ROOT, scopeRoot)} ` +
      `(${report?.shimFiles} re-export shims), ${report?.scopeExportedSymbols} exported symbols: ` +
      `${report?.liveScopeSymbols} reachable, ${report?.deadScopeSymbols} annotated ` +
      `(${report?.annotatedNoLiveCaller} ${NO_LIVE_CALLER_TAG} + ` +
      `${report?.annotatedTestOnly} ${TEST_ONLY_TAG}); ` +
      `${report?.reachableSymbols} symbols reachable across ${report?.filesScanned} src files\n`
  );
  return 0;
}

/**
 * `import.meta.url === \`file://${process.argv[1]}\`` is WRONG in two ways that
 * both end in the script exiting 0 having done nothing. Node resolves the main
 * module to its REALPATH while `argv[1]` keeps the symlink, and a path needing
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
