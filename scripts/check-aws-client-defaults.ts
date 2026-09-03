/**
 * AWS SDK client construction critic (issue #2388).
 *
 * WHAT THIS CHECKS
 * ----------------
 * Every `new XClient(...)` under `src/**` where `XClient` was imported from an
 * `@aws-sdk/client-*` package must spread `awsClientDefaults(...)` as the FIRST
 * property of its config object.
 *
 * WHY IT HAS TO BE MECHANICAL
 * ---------------------------
 * The AWS SDK for JavaScript v3 does not read `HTTPS_PROXY` / `HTTP_PROXY`, so
 * behind a corporate proxy a client built without those defaults cannot reach
 * AWS at all — and it fails at CREDENTIAL RESOLUTION, before any service call,
 * with a certificate error that names neither the proxy nor the client. There
 * are ~150 construction sites across ~80 files and the repository gains
 * providers steadily, so the invariant decays the first time a new provider
 * writes a bare `new XClient({ region })`. A reviewer cannot see the omission:
 * the code looks exactly like every correct site minus one line, and every test
 * passes, because no test runs behind a proxy.
 *
 * WHY IT BINDS TO THE IMPORT, NOT THE NAME
 * ----------------------------------------
 * Matching `/new \w+Client\(/` would bind to a naming convention rather than to
 * the thing that matters, catching cdkd's own `S3StateBackend`-style helpers
 * and missing a construction split across lines. Resolving the identifier back
 * to an `@aws-sdk/client-*` import statement asks the real question: is this an
 * SDK client, whose transport we are on the hook for?
 *
 * WHY FIRST-PROPERTY AND NOT MERELY PRESENT
 * -----------------------------------------
 * `awsClientDefaults()` supplies a `credentials` chain, and a site with its own
 * explicit `credentials` must keep them. Spread-first is what makes the site's
 * own config win; spread-LAST would silently replace the identity a site
 * deliberately chose (`config-loader.ts`'s default-bucket probe reuses the STS
 * client's provider so the bucket is checked as the identity its name was
 * derived from). So the ORDER is load-bearing and is checked, not just the
 * presence.
 *
 * THE ALLOW-LIST SHRINKS, NEVER GROWS
 * -----------------------------------
 * `tests/aws-client-defaults-allowlist.json` holds the files not yet migrated,
 * so this can go green while the sweep is incomplete (PR 1 migrates the
 * bootstrap and state paths; PR 2 empties the list). A stale entry — a file
 * that no longer constructs a client, or has been fully migrated — FAILS, so
 * finishing a file forces its entry out and the ratchet cannot quietly stop.
 *
 * Usage:
 *   node scripts/check-aws-client-defaults.ts            # human summary
 *   node scripts/check-aws-client-defaults.ts --check    # exit 1 on a gap
 *   node scripts/check-aws-client-defaults.ts --json     # machine readable
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// `typescript-v6` is an npm alias of typescript@6 — TS7 ships the stable
// compiler API only under `typescript/unstable/*`. Same import the sibling
// codegen critics use.
import ts from 'typescript-v6';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DEFAULT_SRC_DIR = join(REPO_ROOT, 'src');
const ALLOW_LIST_PATH = join(REPO_ROOT, 'tests/aws-client-defaults-allowlist.json');

/** The helper every SDK client config must open with. */
export const DEFAULTS_HELPER = 'awsClientDefaults';

/** Its own module, which is the one file that legitimately does not call it. */
export const HELPER_MODULE = join(REPO_ROOT, 'src/utils/aws-client-defaults.ts');

export type SiteVerdict =
  /** Spreads `awsClientDefaults(...)` first. */
  | 'defaults-first'
  /** Calls it, but not as the first property — a later spread would win. */
  | 'defaults-not-first'
  /** Does not call it at all. */
  | 'missing'
  /** Config argument is not an object literal this checker can read. */
  | 'opaque'
  /**
   * Two or more clients are built from the SAME config bag, so they share one
   * `requestHandler` and therefore one routing agent.
   *
   * This is the per-client-agent rule broken through the back door, and it
   * looks correct at every individual call site. `NodeHttpHandler.destroy()`
   * forwards into an agent whose `destroy()` kills ACTIVE sockets, so one
   * client's teardown can abort the other's in-flight request. It reads as
   * `defaults-first` on both sites, which is why presence and order are not
   * enough to check.
   */
  | 'shared-defaults';

export interface ClientSite {
  readonly file: string;
  readonly line: number;
  readonly client: string;
  readonly verdict: SiteVerdict;
}

/** Is this the `await import('@aws-sdk/client-*')` expression? */
function isSdkDynamicImport(node: ts.Node | undefined): boolean {
  if (node === undefined) return false;
  const call = ts.isAwaitExpression(node) ? node.expression : node;
  if (!ts.isCallExpression(call) || call.expression.kind !== ts.SyntaxKind.ImportKeyword) {
    return false;
  }
  const arg = call.arguments[0];
  return arg !== undefined && ts.isStringLiteral(arg) && arg.text.startsWith('@aws-sdk/client-');
}

/**
 * Names bound to a whole `@aws-sdk/client-*` MODULE, for the `new mod.XClient()`
 * form (`const mod = await import('@aws-sdk/client-sns'); new mod.SNSClient()`).
 *
 * `src/local/httpv2-service-integration.ts` builds six clients this way.
 */
export function sdkClientNamespaces(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      isSdkDynamicImport(node.initializer)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/**
 * Identifiers this source binds to a class from an `@aws-sdk/client-*` package.
 *
 * TWO shapes, and the second was the hole that made PR 2465's totality claim
 * false: a STATIC named import (`import { S3Client } from '@aws-sdk/client-s3'`,
 * aliases included), and a DESTRUCTURED DYNAMIC one
 * (`const { STSClient } = await import('@aws-sdk/client-sts')`). Reading only
 * top-level `ImportDeclaration`s meant a dynamic site contributed no
 * identifiers, so it never got a verdict at all -- not a gap, not anything --
 * and 17 of them, including `deploy.ts`'s `GetCallerIdentity` on every deploy,
 * sat unmigrated behind a green run and an empty allow-list.
 *
 * WHAT IS STILL NOT COVERED, stated exhaustively because the previous version of
 * this comment named one exclusion and was silent about the one that mattered --
 * and silence reads as coverage:
 *
 * - A STATIC namespace import (`import * as sns from '@aws-sdk/client-sns'`).
 *   Nothing uses one. The DYNAMIC namespace form IS covered, by
 *   {@link sdkClientNamespaces}.
 * - An inline `(await import('...')).XClient`, and a `.then(m => m.XClient)`
 *   chain. Neither appears in the tree.
 * - A class re-exported through an intermediate module.
 * - The AGGREGATED client (`import { S3 } from '@aws-sdk/client-s3'`, or
 *   `new mod.S3()`): every SDK package exports a convenience class without the
 *   `Client` suffix. This one is worth naming separately because it is the ONE
 *   shape the reconciliation cannot rescue -- the text scan in
 *   `aws-client-defaults-fence.test.ts` keys on the same suffix, so the two
 *   methods are wrong in the SAME way here, which is exactly the premise
 *   ("wrong in DIFFERENT ways") that makes the reconciliation worth anything.
 *   Nothing in the tree uses one; a first use needs both sides widened.
 *
 * The floors in the unit suite are what stop this list quietly becoming stale:
 * a shape that stops being detected shows up as a count regression, and the
 * reconciliation against an independent `grep -c 'new [A-Za-z]*Client('` is
 * what proves the detected population IS the real one.
 */
export function sdkClientIdentifiers(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();

  // The destructured dynamic form, anywhere in the file.
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      isSdkDynamicImport(node.initializer)
    ) {
      for (const element of node.name.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        // `propertyName` is the EXPORTED name under an alias
        // (`{ S3Client: Bucket }`); `name` is what the `new` refers to.
        const exported = element.propertyName ?? element.name;
        if (ts.isIdentifier(exported) && exported.text.endsWith('Client')) {
          names.add(element.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (!ts.isStringLiteral(specifier)) continue;
    if (!specifier.text.startsWith('@aws-sdk/client-')) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      // `element.name` is the LOCAL binding, which is what the `new` refers to.
      //
      // The `Client` suffix is a SECOND filter, not the primary one. An
      // `@aws-sdk/client-*` package exports commands, paginators and
      // exceptions from the same module, and `new HeadBucketCommand({...})`
      // takes an input bag that has nothing to do with transport — matching
      // the import alone reported 1726 sites against a real population of ~160
      // (158 at the commit that swept them; run the checker for today's). Binding to
      // the suffix ALONE is what the AST replaces: a name regex also matches
      // cdkd's own `S3StateBackend`-style classes and misses a construction
      // split across lines. Both filters together ask the real question.
      // The suffix is checked on the EXPORTED name and the LOCAL name is what
      // gets recorded: `import { S3Client as Bucket }` is still an SDK client,
      // and it is `Bucket` the `new` refers to. Checking the local name would
      // reintroduce exactly the naming-convention coupling the AST replaces.
      const exported = (element.propertyName ?? element.name).text;
      if (exported.endsWith('Client')) names.add(element.name.text);
    }
  }
  return names;
}

/** Is this expression a call to {@link DEFAULTS_HELPER}? */
function isDefaultsCall(node: ts.Expression): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === DEFAULTS_HELPER
  );
}

/**
 * The object literal an expression ultimately names, resolved within one file.
 *
 * Three shapes, all of which the real tree uses:
 *   - the literal itself, `new S3Client({ ... })`
 *   - a shared bag, `const clientOpts = { ... }; new S3Client(clientOpts)`
 *     (`asset-storage.ts` hands one bag to an S3 and an ECR client)
 *   - a member, `...this.clientOptions` (`aws-clients.ts`'s 22 sites all go
 *     through one getter)
 *
 * Resolution is same-file and by NAME. That is a real bound — two same-named
 * declarations in different scopes are not told apart — and it is the safe
 * direction here: the consequence is crediting a site whose sibling is clean,
 * never manufacturing a gap. The alternative, a type checker, would make this
 * a build-graph consumer for a question that is answerable syntactically.
 */
function resolveObjectLiteral(
  expression: ts.Expression,
  source: ts.SourceFile
): ts.ObjectLiteralExpression | undefined {
  if (ts.isObjectLiteralExpression(expression)) return expression;

  const name = ts.isIdentifier(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression) && expression.expression.kind === ts.SyntaxKind.ThisKeyword
      ? expression.name.text
      : undefined;
  if (name === undefined) return undefined;

  let found: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    // `const bag = { ... }`, and the class-field form `private opts = { ... }`.
    // The field is included because it is a real shape and because leaving it
    // out made it classify `missing` -- the checker cannot see its contents at
    // all -- which hides the SHARING behind a louder, wrong verdict.
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      found = node.initializer;
      return;
    }
    // `get clientOptions() { return { ... }; }` — also covers a plain method.
    if (
      (ts.isGetAccessorDeclaration(node) || ts.isMethodDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      const returned = node.body?.statements.find((statement) =>
        ts.isReturnStatement(statement)
      ) as ts.ReturnStatement | undefined;
      if (returned?.expression !== undefined && ts.isObjectLiteralExpression(returned.expression)) {
        found = returned.expression;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** Maximum indirection hops. `new X(bag)` -> `bag` -> `...this.defaults` is two. */
const MAX_RESOLUTION_DEPTH = 4;

/**
 * Does this literal OPEN with the defaults, directly or through a spread that
 * itself opens with them?
 *
 * Order is the property being checked, not mere presence — see the header. A
 * spread of a bag that opens with the defaults preserves the order, because
 * spreading is associative in exactly this sense: `{ ...{ ...d, a }, b }` and
 * `{ ...d, a, b }` agree.
 */
function opensWithDefaults(
  literal: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
  depth: number
): boolean {
  const first = literal.properties[0];
  if (first === undefined || !ts.isSpreadAssignment(first)) return false;
  if (isDefaultsCall(first.expression)) return true;
  if (depth >= MAX_RESOLUTION_DEPTH) return false;
  const inner = resolveObjectLiteral(first.expression, source);
  return inner !== undefined && opensWithDefaults(inner, source, depth + 1);
}

/** Does this literal mention the defaults ANYWHERE, at any depth? */
function mentionsDefaults(
  literal: ts.ObjectLiteralExpression,
  source: ts.SourceFile,
  depth: number
): boolean {
  return literal.properties.some((property) => {
    if (!ts.isSpreadAssignment(property)) return false;
    if (isDefaultsCall(property.expression)) return true;
    if (depth >= MAX_RESOLUTION_DEPTH) return false;
    const inner = resolveObjectLiteral(property.expression, source);
    return inner !== undefined && mentionsDefaults(inner, source, depth + 1);
  });
}

export function classifyConfigArgument(
  argument: ts.Expression | undefined,
  source: ts.SourceFile
): SiteVerdict {
  // `new S3Client()` with no config cannot carry the defaults at all.
  if (argument === undefined) return 'missing';
  const literal = resolveObjectLiteral(argument, source);
  if (literal === undefined) {
    // A config this checker cannot read. Reported rather than skipped: a site
    // it cannot see is a site it cannot guard, so `opaque` BLOCKS unless the
    // file is allow-listed.
    return 'opaque';
  }
  if (opensWithDefaults(literal, source, 0)) return 'defaults-first';
  return mentionsDefaults(literal, source, 0) ? 'defaults-not-first' : 'missing';
}

/**
 * The binding NAME an expression reads, for `bag` and for `this.bag` alike.
 *
 * One spelling for both branches of {@link sharedDefaultsSource}: they were
 * written separately and disagreed, which is how a bare `this.opts` argument
 * escaped the shared-bag pass while the spread form was caught.
 */
function bindingName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (
    ts.isPropertyAccessExpression(expression) &&
    expression.expression.kind === ts.SyntaxKind.ThisKeyword
  ) {
    return expression.name.text;
  }
  return undefined;
}

/**
 * The NAME of the binding a site gets its defaults from, or `undefined` when it
 * calls the helper itself.
 *
 * Two shapes share one bag, and the second is the one that shipped past the
 * first cut of this checker:
 *
 * ```ts
 * new A(bag);              // bare identifier
 * new B({ ...bag, x });    // spread -- classifies `defaults-first` through the
 *                          // `opensWithDefaults` recursion, which is correct
 *                          // about the ORDER and blind to the SHARING
 * ```
 *
 * A DIRECT `awsClientDefaults()` call at the site exempts NOTHING by itself.
 * Every spread is resolved on its own, and the direct call simply contributes
 * no shared root -- it has no binding name, so the walk passes over it. The
 * prescribed form `{ ...awsClientDefaults(), ...bag }` is therefore clean
 * because `bag` resolves to nothing defaults-bearing, not because the call
 * short-circuits the check.
 *
 * There WAS such an exemption, and it was removed for the same reason as its
 * twin in {@link sharedRoot}: it was fail-open, pinned by no test, and wrong for
 * a constructible shape -- a once-evaluated defaults-bearing bag spread AFTER
 * the call wins on later-key-wins, so the clients share and the exemption called
 * it `defaults-first`. Removing it left the report byte-identical, zero sites
 * newly flagged, which is what showed the real sites never leaned on it.
 *
 * Its companion warning died with it: "test the literal written at the site,
 * never the resolved bag" guarded against exempting `new A(bag)` because the
 * call sits inside `bag`, and with no exemption there is nothing to over-apply.
 *
 * WHAT COUNTS AS SHARED IS THE EVALUATION, NOT THE SPELLING. A `const bag = {
 * ...awsClientDefaults() }` is evaluated ONCE, so every client spreading it
 * gets the same handler. A GETTER is evaluated on every access, so
 * `...this.clientOptions` -- how all 22 `aws-clients.ts` sites are written --
 * calls the helper afresh per client and is not sharing anything. Missing that
 * distinction reported those 22 as gaps.
 */
function sharedDefaultsSource(
  argument: ts.Expression | undefined,
  source: ts.SourceFile
): string | undefined {
  if (argument === undefined) return undefined;
  // The BARE-argument branch extracts a name the same way the spread branch
  // below does. Handling only `new A(bag)` and not `new A(this.opts)` left the
  // second escaping the shared-bag pass entirely -- the argument is neither an
  // identifier nor a literal, so this returned `undefined` while the
  // PropertyDeclaration arm of `resolveObjectLiteral` still classified it
  // `defaults-first`.
  const bare = bindingName(argument);
  if (bare !== undefined) return sharedRoot(argument, source, 0);
  if (!ts.isObjectLiteralExpression(argument)) return undefined;

  const spreads = argument.properties.filter((p) => ts.isSpreadAssignment(p)) as ts.SpreadAssignment[];

  for (const spread of spreads) {
    const root = sharedRoot(spread.expression, source, 0);
    if (root !== undefined) return root;
  }
  return undefined;
}

/**
 * The ONCE-evaluated binding an expression ultimately reads the defaults from,
 * following getters on the way.
 *
 * Asking `isEvaluatedOnce` of the TOP name only was a bound: the defaults-credit
 * recursion is transitive, so a getter returning `{ ...this.cached }` over a
 * `private cached = { ...awsClientDefaults() }` hands every caller the SAME
 * object while looking per-access at its own level. The name returned is the
 * ROOT rather than the getter, so two clients reaching one field through
 * different getters still count as one shared binding.
 */
function sharedRoot(
  expression: ts.Expression,
  source: ts.SourceFile,
  depth: number
): string | undefined {
  const name = bindingName(expression);
  if (name === undefined || depth >= MAX_RESOLUTION_DEPTH) return undefined;
  const literal = resolveObjectLiteral(expression, source);
  if (literal === undefined) return undefined;

  if (isEvaluatedOnce(name, source)) {
    return mentionsDefaults(literal, source, 0) ? name : undefined;
  }
  // A getter: it shares nothing of its own, but what it SPREADS may be shared.
  //
  // There is deliberately NO "a direct call inside the getter stops the walk"
  // guard here, and its absence is the point. Such a guard was fail-open and
  // pinned by nothing -- mutating it away redded no test -- and WRONG for a
  // constructible shape: a getter that calls the helper and then spreads a
  // once-evaluated bag hands every caller the bag's `requestHandler` on
  // later-key-wins, so the clients share and the guard called it
  // `defaults-first`. Without it that shape is reported, and the answer on every
  // shape in this tree is unchanged (measured: byte-identical report, 158/158)
  // because the loop below returns `undefined` for a bare helper call anyway.
  const spreads = literal.properties.filter((p) => ts.isSpreadAssignment(p)) as ts.SpreadAssignment[];
  for (const spread of spreads) {
    const root = sharedRoot(spread.expression, source, depth + 1);
    if (root !== undefined) return root;
  }
  return undefined;
}

/**
 * Is this name bound to a value computed ONCE (a variable or a class field), as
 * opposed to recomputed on every read (a getter or a method)?
 *
 * The whole shared-bag question turns on this: sharing is about one VALUE
 * reaching two clients, and a getter hands out a new one each time.
 */
function isEvaluatedOnce(name: string, source: ts.SourceFile): boolean {
  let verdict: boolean | undefined;
  const visit = (node: ts.Node): void => {
    if (verdict !== undefined) return;
    if (
      (ts.isGetAccessorDeclaration(node) || ts.isMethodDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name
    ) {
      verdict = false;
      return;
    }
    if (
      (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      verdict = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return verdict === true;
}

export function findClientSites(filePath: string, source: string): ClientSite[] {
  const parsed = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true);
  const clients = sdkClientIdentifiers(parsed);
  const namespaces = sdkClientNamespaces(parsed);
  if (clients.size === 0 && namespaces.size === 0) return [];

  const sites: ClientSite[] = [];
  /** Config-bag identifier per site, for the shared-bag pass below. */
  const bagNames: (string | undefined)[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      // `new XClient(...)`, or `new mod.XClient(...)` where `mod` is a whole
      // `@aws-sdk/client-*` module bound by a dynamic import.
      const client = ts.isIdentifier(node.expression)
        ? clients.has(node.expression.text)
          ? node.expression.text
          : undefined
        : ts.isPropertyAccessExpression(node.expression) &&
            ts.isIdentifier(node.expression.expression) &&
            namespaces.has(node.expression.expression.text) &&
            node.expression.name.text.endsWith('Client')
          ? node.expression.name.text
          : undefined;
      if (client !== undefined) {
        const argument = node.arguments?.[0];
        sites.push({
          file: filePath,
          line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
          client,
          verdict: classifyConfigArgument(argument, parsed),
        });
        bagNames.push(sharedDefaultsSource(argument, parsed));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);

  // SHARED-BAG pass. A bag naming the defaults, handed to more than one client,
  // gives them one `requestHandler` and one routing agent between them.
  //
  // The count is file-global BY NAME, so two functions each with their own local
  // `const opts = { ...awsClientDefaults() }` for one client apiece would both
  // flip to `shared-defaults` although neither shares anything. That is
  // FAIL-CLOSED, and deliberately the opposite polarity to
  // `resolveObjectLiteral`'s "never manufacturing a gap" note beside it: a false
  // accusation here costs one reviewer a look, while a miss ships the
  // correctness bug the verdict exists to catch. No such shape exists in the
  // tree today; scope it per declaration if one appears.
  const uses = new Map<string, number>();
  for (const name of bagNames) {
    if (name !== undefined) uses.set(name, (uses.get(name) ?? 0) + 1);
  }
  return sites.map((site, index) => {
    const name = bagNames[index];
    if (name === undefined || (uses.get(name) ?? 0) < 2) return site;
    // Only when the bag actually carries the defaults: a bag WITHOUT them is
    // already reported `missing`, and saying "shared" there would name the
    // lesser of the two problems.
    return site.verdict === 'defaults-first' ? { ...site, verdict: 'shared-defaults' as const } : site;
  });
}

function* walkTypeScriptFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkTypeScriptFiles(full);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      yield full;
    }
  }
}

export interface AllowList {
  readonly $comment?: string;
  readonly files: readonly string[];
}

export function readAllowList(path: string = ALLOW_LIST_PATH): AllowList {
  return JSON.parse(readFileSync(path, 'utf8')) as AllowList;
}

export interface Report {
  /** Sites that must be fixed: a non-allow-listed file with a bad verdict. */
  readonly gaps: readonly ClientSite[];
  /** Allow-listed files whose sites are all clean — the entry is now stale. */
  readonly staleAllowList: readonly string[];
  /** Allow-listed files that no longer exist or construct no client. */
  readonly deadAllowList: readonly string[];
  readonly totalSites: number;
  readonly cleanSites: number;
  readonly filesWithSites: number;
}

export function buildReport(srcDir: string = DEFAULT_SRC_DIR, allowList?: AllowList): Report {
  const allow = allowList ?? readAllowList();
  const allowed = new Set(allow.files);

  // Report paths relative to the SCANNED root's parent rather than to the
  // repository, so a scratch COPY of `src/` yields the same `src/...` keys the
  // allow-list uses. For the real tree the two are the same directory.
  const scanRoot = resolve(srcDir, '..');
  const helper = relative(REPO_ROOT, HELPER_MODULE);

  const sitesByFile = new Map<string, ClientSite[]>();
  for (const file of walkTypeScriptFiles(srcDir)) {
    const key = relative(scanRoot, file);
    if (key === helper) continue;
    const sites = findClientSites(file, readFileSync(file, 'utf8'));
    if (sites.length > 0) sitesByFile.set(key, sites);
  }

  const gaps: ClientSite[] = [];
  const staleAllowList: string[] = [];
  let totalSites = 0;
  let cleanSites = 0;
  for (const [file, sites] of sitesByFile) {
    totalSites += sites.length;
    const bad = sites.filter((site) => site.verdict !== 'defaults-first');
    cleanSites += sites.length - bad.length;
    if (allowed.has(file)) {
      if (bad.length === 0) staleAllowList.push(file);
      continue;
    }
    gaps.push(...bad.map((site) => ({ ...site, file })));
  }

  const deadAllowList = allow.files.filter((file) => !sitesByFile.has(file));

  return {
    gaps,
    staleAllowList: staleAllowList.sort(),
    deadAllowList: [...deadAllowList].sort(),
    totalSites,
    cleanSites,
    filesWithSites: sitesByFile.size,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  // Test seam, mirroring `--providers-dir=` on the sibling critics: point the
  // scan at a scratch COPY of the tree so a regression probe can exercise the
  // SHIPPED command's exit code without ever writing to `src/`. Rejected
  // outside `--check`, so it can never rewrite anything.
  const srcDirArg = args.find((arg) => arg.startsWith('--src-dir='));
  if (srcDirArg !== undefined && !args.includes('--check')) {
    console.error('[aws-client-defaults] --src-dir= is only valid with --check');
    process.exitCode = 1;
    return;
  }
  const allowListArg = args.find((arg) => arg.startsWith('--allow-list='));
  const report = buildReport(
    srcDirArg === undefined ? DEFAULT_SRC_DIR : resolve(srcDirArg.slice('--src-dir='.length)),
    allowListArg === undefined
      ? undefined
      : readAllowList(resolve(allowListArg.slice('--allow-list='.length)))
  );

  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `[aws-client-defaults] ${report.cleanSites}/${report.totalSites} client sites spread ` +
        `${DEFAULTS_HELPER}() first, across ${report.filesWithSites} files.`
    );
    for (const gap of report.gaps) {
      console.error(`  GAP  ${gap.file}:${gap.line} new ${gap.client}(...) — ${gap.verdict}`);
    }
    for (const file of report.staleAllowList) {
      console.error(`  STALE allow-list entry (file is clean now): ${file}`);
    }
    for (const file of report.deadAllowList) {
      console.error(`  DEAD  allow-list entry (no client site): ${file}`);
    }
  }

  if (args.includes('--check')) {
    const failed =
      report.gaps.length > 0 ||
      report.staleAllowList.length > 0 ||
      report.deadAllowList.length > 0;
    if (failed) process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
