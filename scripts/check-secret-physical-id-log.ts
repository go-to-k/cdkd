/**
 * Secret-physical-id critic (go-to-k/cdkd#6716): every engine or CLI text that
 * renders a physical id goes through `displayPhysicalId`, and every readback key
 * the schemas show can carry a resolved template value under another key's
 * name is one the state redaction pairs (bound (5)).
 *
 * WHY
 * ---
 * Some physical ids ARE a bearer credential (`secret-physical-id.ts`: an AppSync
 * ApiKey's key, a wait condition handle's pre-signed URL). #5868 found the
 * engine printing one at INFO on a replacement; #6694 found the second type.
 * Each fix routed the sites known then, and nothing failed when a new line
 * printed `${record.physicalId}`. A bound secret bag masks the id only where
 * the bag already holds it, and an id minted this deploy (a re-created key) is
 * in no bag yet, so the bag is not a guarantee a static check can read.
 * `displayPhysicalId(type, id)` is: it masks the segment from the type and the
 * id alone, wherever it runs. So the rule is by construction: wrap every one.
 *
 * PART 1: THE POPULATION
 * ----------------------
 * Two roots. PROSE: every template literal or `+` chain whose literal text holds
 * a space, wherever it goes. A SINK: `<logger>.debug|info|warn|error(...)` (a
 * receiver named `*logger` / `log`, or `getLogger()`; an object argument's
 * values too), `console.*`, `process.stdout|stderr.write`, and the first
 * argument of `new <Name>Error(...)` (the rest are fields). Every expression in
 * a root that RENDERS a physical id is a site: a property or identifier named
 * `*physicalId` / `*PhysicalResourceId`, or a binding destructured from one. A
 * local binding is followed to its initializer, so
 * `const line = \`... ${r.physicalId}\`; logger.warn(line)` is a site too. A
 * value only TESTED (a comparison, `typeof`, a `?:` condition, the left of
 * `&&`, `.length`) renders nothing and is not one.
 *
 * A site is MASKED when it sits inside the id argument of `displayPhysicalId`
 * whose type argument is not a literal (a literal type masks nothing, except
 * a listed type inside the table entry keyed by it), or inside a whole-record
 * masker (`withSecretPhysicalIdMasked`, `withSecretPhysicalIdsMaskedInState`,
 * `maskSecretSegmentsDeep`), each IMPORTED from `secret-physical-id.js` (a
 * same-named local is no masker). A site in a per-type table entry keyed by
 * an unlisted type is `non-secret-type`; a rendered parameter is judged at
 * its callers (bound (3)); a site listed in {@link EXEMPTIONS} carries an exact
 * per-function count and its reason. Anything else is RAW and fails.
 *
 * KNOWN BOUNDS
 * ------------
 *  (1) Scope is `src/deployment/**` and `src/cli/**`. A provider's own lines run
 *      inside its resource's bound bag, whose needles hold the segment
 *      (`secretNameNeedlesOf`), and the AppSync provider renders its key with
 *      `maskedApiKeyId`.
 *  (2) PROSE is any template literal or `+` chain whose literal text holds a
 *      space: a message stored in a Map, returned by a helper or built in a
 *      callback is read where it is written. An id rendered with no space
 *      around it in any literal (`${a} ${b}` built from parts) is not prose.
 *  (3) A rendered PARAMETER of a named function moves the obligation to its
 *      callers (a plain call in its own file, or in a file importing that
 *      NAME; a method call by name anywhere): each must pass a masked value
 *      or its own parameter, which defers to ITS callers, to a fixpoint. One
 *      raw caller keeps the parameter raw too, and a cycle of forwards with
 *      no outside caller reaches nothing. An import is matched by NAME, not
 *      by its module, and a method call by name anywhere, so a same-named
 *      function elsewhere can count as a caller. A function only called through
 *      a variable is not resolved and stays raw. A call is
 *      read as rendering its arguments (an over-approximation: a helper that
 *      compares an id and masks it in its own text needs an exemption), and a
 *      helper the tree declares as rendering what it RETURNS through a display
 *      call (`displaySafe(mask(physicalId))`), judged in its own file. A
 *      `.map` / `.flatMap` callback inside a root renders what it returns.
 *  (4) Bindings resolve to the nearest lexical declaration (flow-insensitive;
 *      a `let` reassigned later is judged on its declaration), and a
 *      `displayPhysicalId` handed the WRONG type, or a non-literal type
 *      variable holding a constant, is believed. A LITERAL type is refused
 *      outside the table entry keyed by it: it names one type for an id the
 *      record may give another, and a literal unlisted type is a no-op the
 *      next listed type would not reach.
 *  (6) Not seen: a parameter whose name is not `*physicalId` rendered inside
 *      a helper (judged only where the CALL's result reaches a root); a whole
 *      record handed to a logger (`logger.debug('x', { record })`), whose
 *      `physicalId` the logger's JSON rendering shows; a helper returning an
 *      id through a call outside `DISPLAY_CALLEE`. A text in a key or needle
 *      position (`includes`, `startsWith`, a Map / Set key) is compared, not
 *      shown, and is not prose.
 *  (5) Part 2 checks key NAMES and runs the redaction's two empty-map
 *      entries (`redactForState`, `scrubResourceRecord`) per row. That every
 *      `observedProperties` writer routes through them is
 *      `check-observed-properties-redaction.ts`'s (go-to-k/cdkd#6765).
 *
 * PART 2: READBACK KEYS
 * ---------------------
 * A readback can return a key the record does not hold (#5315: a Step
 * Functions readback returns `Definition` rendered from `DefinitionString` plus
 * `DefinitionSubstitutions`), so no position pairs it with the reference that
 * produced it. The rows are DERIVED from the committed CFn schema fixtures:
 * every property `P` with a sibling `P<suffix>` spelling the same content. A
 * `String` / `Substitutions` sibling carries template values into `P`, so `P`
 * must be one of the redaction's `RENDERED_DEFINITION_KEYS` and the sibling one
 * of its `DEFINITION_SOURCE_KEYS` (both read from
 * `src/deployment/secret-redaction/redact-path/definition.ts`). An
 * `S3Location` sibling carries an S3 object, in which CloudFormation resolves
 * no dynamic reference, so its row needs nothing; a substitution applied to
 * that body is the `Substitutions` row's. The unit test runs each row through
 * the redaction at runtime (`secret-physical-id-log.test.ts`).
 *
 * Usage:
 *   node --experimental-strip-types scripts/check-secret-physical-id-log.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript-v6';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SCANNED_DIRS = ['src/deployment', 'src/cli'];
const DEFINITION_KEYS_FILE = 'src/deployment/secret-redaction/redact-path/definition.ts';
const SCHEMA_DIR = 'tests/fixtures/cfn-schemas';

const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error']);
const CONSOLE_METHODS = new Set(['log', 'info', 'warn', 'error', 'debug']);
const PHYSICAL_ID_NAME = /physical(Resource)?Id$/i;
/** Masks the id argument (index 1) from the type argument (index 0). */
const DISPLAY_HELPER = 'displayPhysicalId';
/** Mask every string their argument holds by its record's own type. */
const RECORD_MASKERS = new Set([
  'withSecretPhysicalIdMasked',
  'withSecretPhysicalIdsMaskedInState',
  'maskSecretSegmentsDeep',
]);
/** The module every masker above must be imported from. */
const MASKER_MODULE = /(^|\/)secret-physical-id\.js$/;

/**
 * `non-secret-type`: the site sits in a function keyed by a CloudFormation
 * type outside `SECRET_PHYSICAL_ID_TYPES` (a per-type table entry such as
 * `COMPOSITE_ID_SPLITTERS['AWS::EC2::Route']`), so the id it renders is that
 * type's. A type joining the list turns its entry's sites raw.
 */
export type SiteShape =
  | 'logger'
  | 'console'
  | 'stdout'
  | 'error'
  | 'prose'
  | 'prose-return'
  | 'prose-map-set'
  | 'helper-return';

export type Verdict = 'masked' | 'non-secret-type' | 'raw';

const SECRET_TYPES_FILE = 'src/provisioning/secret-physical-id.ts';
let secretTypesCache: ReadonlySet<string> | undefined;
/** `SECRET_PHYSICAL_ID_TYPES`, read from its module as text. */
export function secretPhysicalIdTypes(root = REPO_ROOT): ReadonlySet<string> {
  if (secretTypesCache !== undefined && root === REPO_ROOT) return secretTypesCache;
  const list = declaredStringList(readFileSync(join(root, SECRET_TYPES_FILE), 'utf8'), 'SECRET_PHYSICAL_ID_TYPES');
  if (list === undefined || list.length === 0) {
    throw new Error(`${SECRET_TYPES_FILE}: SECRET_PHYSICAL_ID_TYPES not found as a string list`);
  }
  const set = new Set(list);
  if (root === REPO_ROOT) secretTypesCache = set;
  return set;
}
/** The list the current {@link analyzeSource} call judges with. */
let secretTypes: ReadonlySet<string> = new Set();

export interface Site {
  file: string;
  line: number;
  /** 1-based column of the rendering expression: two on one line are two sites. */
  column: number;
  /** The enclosing named function, `<module>` at top level. */
  fn: string;
  /** Which root found it: a sink's kind, or where a prose text goes. */
  shape?: SiteShape;
  text: string;
  verdict: Verdict;
  /** A rendered parameter: its function's callers carry the obligation. */
  param?: { fn: string; index: number };
}

interface Found {
  node: ts.Node;
  verdict: Verdict;
  param?: { fn: string; index: number };
  /** The file `node` is in, when not the file being read (a helper's return). */
  file?: ParsedFile;
}

/**
 * A reviewed site whose id cannot be a secret type. `count` is EXACT: a new
 * raw site in the same function fails, and so does one that goes away.
 */
export interface Exemption {
  file: string;
  fn: string;
  count: number;
  reason: string;
}

export const EXEMPTIONS: readonly Exemption[] = [
  {
    file: 'src/cli/commands/drift/revert-apply.ts',
    fn: 'applyRevertUpdateInScope',
    count: 1,
    reason:
      'the raw id is an ARGUMENT of revertReplacementOf, which compares it and masks both ids in ' +
      'the text it returns (its own sites are read as masked); a call is read as rendering its ' +
      'arguments, which this one does not',
  },
  {
    file: 'src/cli/commands/destroy-runner/delete-resource.ts',
    fn: 'deleteStackResource',
    count: 1,
    reason:
      'the raw id is an ARGUMENT of protectionRefusalHint, which only removes it from AWS text ' +
      'before matching and returns fixed cdkd text; a call is read as rendering its arguments, ' +
      'which this one does not (#6855)',
  },
  {
    file: 'src/cli/commands/export/sg-ingress-rule-id.ts',
    fn: 'backfillSecurityGroupIngressRuleId',
    count: 1,
    reason: 'the id is an AWS::EC2::SecurityGroupIngress composite, a type with no secret segment',
  },
  {
    file: 'src/cli/commands/retire-cfn-stack/retain-injection.ts',
    fn: 'injectRetainPoliciesRecursiveInternal',
    count: 1,
    reason: "the id is a CloudFormation nested stack's ARN, read from CloudFormation itself",
  },
];

function isLoggerReceiver(node: ts.Expression): boolean {
  if (ts.isIdentifier(node)) return /logger$/i.test(node.text) || node.text === 'log';
  if (ts.isPropertyAccessExpression(node)) return /logger$/i.test(node.name.text) || node.name.text === 'log';
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'getLogger'
  );
}

/**
 * The interpolated parts of a PROSE text: a template literal (tagged or not)
 * or a `+` chain whose literal text holds a space. Prose is read by a person
 * wherever it ends up (a log line, an error, a Map a later warning prints, a
 * helper's return value); an id spliced into an ARN, URL or key has no space
 * around it, so it is not prose.
 */
function proseParts(node: ts.Node): ts.Expression[] | undefined {
  if (ts.isTemplateExpression(node) && !ts.isTaggedTemplateExpression(node.parent)) {
    return templateProse(node);
  }
  if (ts.isTaggedTemplateExpression(node) && ts.isTemplateExpression(node.template)) {
    return templateProse(node.template);
  }
  return chainProse(node);
}

function templateProse(node: ts.TemplateExpression): ts.Expression[] | undefined {
  {
    const texts = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)];
    if (!texts.some((t) => t.includes(' '))) return undefined;
    return node.templateSpans.map((s) => s.expression);
  }
}

function chainProse(node: ts.Node): ts.Expression[] | undefined {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    // The TOP of a chain only: its parent is not itself a `+`.
    const p = node.parent;
    if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.PlusToken) return undefined;
    const operands: ts.Expression[] = [];
    const flatten = (e: ts.Expression): void => {
      if (ts.isParenthesizedExpression(e)) return flatten(e.expression);
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
        flatten(e.left);
        flatten(e.right);
      } else operands.push(e);
    };
    flatten(node);
    const literal = (e: ts.Expression): boolean =>
      (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) && e.text.includes(' ');
    const templateOf = (e: ts.Expression): ts.TemplateExpression | undefined =>
      ts.isTemplateExpression(e)
        ? e
        : ts.isTaggedTemplateExpression(e) && ts.isTemplateExpression(e.template)
          ? e.template
          : undefined;
    const hasSpace = (e: ts.Expression): boolean => {
      const t = templateOf(e);
      return t !== undefined && [t.head.text, ...t.templateSpans.map((x) => x.literal.text)].some((x) => x.includes(' '));
    };
    if (!operands.some((e) => literal(e) || hasSpace(e))) return undefined;
    // A template operand's own parts belong to the chain's prose: `(${id})`
    // carries no space of its own.
    const parts: ts.Expression[] = [];
    for (const e of operands) {
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) continue;
      const t = templateOf(e);
      if (t !== undefined) parts.push(...t.templateSpans.map((x) => x.expression));
      else parts.push(e);
    }
    return parts;
  }
  return undefined;
}

/** Is `node` a line-writing sink, or an error whose message a line prints? */
export function isSink(node: ts.Node): node is ts.CallExpression | ts.NewExpression {
  if (ts.isNewExpression(node)) {
    // `new Error(...)` / `new ProvisioningError(...)`: the CLI prints the message.
    const c = node.expression;
    const name = ts.isIdentifier(c) ? c.text : ts.isPropertyAccessExpression(c) ? c.name.text : '';
    return /Error$/.test(name);
  }
  if (!ts.isCallExpression(node)) return false;
  const call = node;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return false;
  const method = callee.name.text;
  const recv = callee.expression;
  if (LOG_METHODS.has(method) && isLoggerReceiver(recv)) return true;
  if (ts.isIdentifier(recv) && recv.text === 'console' && CONSOLE_METHODS.has(method)) return true;
  return (
    method === 'write' &&
    ts.isPropertyAccessExpression(recv) &&
    (recv.name.text === 'stdout' || recv.name.text === 'stderr') &&
    ts.isIdentifier(recv.expression) &&
    recv.expression.text === 'process'
  );
}

function calleeName(call: ts.CallExpression): string | undefined {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return undefined;
}

/** Local names `import { displayPhysicalId as X }` binds, per masker. */
function importedAliases(source: ts.SourceFile): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const bindings = stmt.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    // A same-named local function or another module's export is no masker.
    if (!ts.isStringLiteral(stmt.moduleSpecifier) || !MASKER_MODULE.test(stmt.moduleSpecifier.text)) {
      continue;
    }
    for (const el of bindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (imported === DISPLAY_HELPER || RECORD_MASKERS.has(imported)) {
        aliases.set(el.name.text, imported);
      }
    }
  }
  return aliases;
}

/** Every name an import binds (a function such as `withDisplayedPhysicalId` is no id). */
function importedBindingNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const stmt of source.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const clause = stmt.importClause;
    if (clause?.name !== undefined) names.add(clause.name.text);
    const bindings = clause?.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
    else for (const el of bindings.elements) names.add(el.name.text);
  }
  for (const stmt of source.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name !== undefined) names.add(stmt.name.text);
  }
  return names;
}

function isLiteralType(node: ts.Expression | undefined): boolean {
  if (node === undefined) return true;
  if (ts.isParenthesizedExpression(node)) return isLiteralType(node.expression);
  // A LISTED type spelled literally masks only inside the table entry keyed
  // by that same type (the AppSync ApiKey export splitter): elsewhere a
  // literal names a type the id may not have. Any other literal is the
  // identity.
  if (ts.isStringLiteral(node) && secretTypes.has(node.text) && typeKeyOf(node) === node.text) {
    return false;
  }
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined') ||
    ts.isVoidExpression(node)
  );
}

const COMPARISON = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.LessThanToken,
  ts.SyntaxKind.GreaterThanToken,
  ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.InstanceOfKeyword,
  ts.SyntaxKind.InKeyword,
]);

/** Does `node`, read inside `root`, only get TESTED rather than rendered? */
function onlyTested(node: ts.Node, root: ts.Node): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.expression === child) {
    if (parent.name.text === 'length') return true;
  }
  while (child !== root && parent !== undefined) {
    if (ts.isBinaryExpression(parent)) {
      if (COMPARISON.has(parent.operatorToken.kind)) return true;
      if (
        parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        parent.left === child
      ) {
        return true;
      }
    }
    if (ts.isTypeOfExpression(parent) || ts.isPrefixUnaryExpression(parent)) return true;
    if (ts.isConditionalExpression(parent) && parent.condition === child) return true;
    if (ts.isIfStatement(parent) || ts.isTypeNode(parent)) return true;
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/** Is `node` (inside `root`) wrapped by a masker? */
function isWrapped(node: ts.Node, root: ts.Node, aliases: Map<string, string>): boolean {
  let child: ts.Node = node;
  let parent = node.parent;
  while (parent !== undefined) {
    if (ts.isCallExpression(parent) && parent.expression !== child) {
      const name = calleeName(parent);
      const real = name === undefined ? undefined : aliases.get(name);
      if (real === DISPLAY_HELPER && parent.arguments[1] === child) {
        if (!isLiteralType(parent.arguments[0])) return true;
      }
      if (real !== undefined && RECORD_MASKERS.has(real) && parent.arguments.includes(child as ts.Expression)) {
        return true;
      }
    }
    // `withSecretPhysicalIdMasked(r).physicalId`: the record was masked whole.
    if (ts.isPropertyAccessExpression(child) && ts.isCallExpression(child.expression)) {
      const name = calleeName(child.expression);
      const real = name === undefined ? undefined : aliases.get(name);
      if (real !== undefined && RECORD_MASKERS.has(real)) return true;
    }
    if (child === root) return false;
    child = parent;
    parent = parent.parent;
  }
  return false;
}

/** The declaration `name` resolves to from `use`: nearest lexical binding. */
function resolveBinding(
  use: ts.Identifier
): ts.VariableDeclaration | ts.ParameterDeclaration | ts.BindingElement | undefined {
  const name = use.text;
  let scope: ts.Node | undefined = use.parent;
  while (scope !== undefined) {
    if (ts.isFunctionLike(scope)) {
      for (const p of (scope as ts.SignatureDeclaration).parameters) {
        const hit = findInBindingName(p.name, name);
        if (hit !== undefined) return ts.isIdentifier(hit) ? p : hit;
      }
    }
    const statements =
      ts.isBlock(scope) || ts.isSourceFile(scope) || ts.isModuleBlock(scope) || ts.isCaseClause(scope)
        ? scope.statements
        : undefined;
    if (statements !== undefined) {
      for (const stmt of statements) {
        if (!ts.isVariableStatement(stmt) || stmt.pos > use.pos) continue;
        for (const decl of stmt.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl;
          const hit = findInBindingName(decl.name, name);
          if (hit !== undefined) return hit as ts.BindingElement;
        }
      }
    }
    if ((ts.isForOfStatement(scope) || ts.isForInStatement(scope)) && ts.isVariableDeclarationList(scope.initializer)) {
      for (const decl of scope.initializer.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) return decl;
        const hit = findInBindingName(decl.name, name);
        if (hit !== undefined) return hit as ts.BindingElement;
      }
    }
    scope = scope.parent;
  }
  return undefined;
}

function findInBindingName(
  name: ts.BindingName,
  wanted: string
): ts.Identifier | ts.BindingElement | undefined {
  if (ts.isIdentifier(name)) return name.text === wanted ? name : undefined;
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    if (ts.isIdentifier(el.name) && el.name.text === wanted) return el;
    const hit = findInBindingName(el.name, wanted);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function isValueIdentifier(node: ts.Identifier): boolean {
  const p = node.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === node) return false;
  if ((ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === node) {
    return false;
  }
  if (ts.isCallExpression(p) && p.expression === node) return false;
  // A declared NAME is no use; an initializer (`const s = physicalId`) is.
  if (ts.isBindingElement(p) && (p.name === node || p.propertyName === node)) return false;
  if ((ts.isVariableDeclaration(p) || ts.isParameter(p)) && p.name === node) return false;
  return true;
}

/**
 * Every raw / masked site rendered by `root` (a sink argument, or an
 * initializer a sink argument reads), reported against `report` (the sink
 * argument a reader sees).
 */
function collect(
  root: ts.Node,
  aliases: Map<string, string>,
  importedNames: ReadonlySet<string>,
  out: Found[],
  seen: Set<ts.Node>,
  depth: number,
  /** The file being read, when it is a helper's (its sites are tagged with it). */
  inFile?: ParsedFile
): void {
  if (seen.has(root) || depth > 8) return;
  seen.add(root);
  const tag = (f: Found): Found => (inFile !== undefined ? { ...f, file: inFile } : f);
  const visit = (node: ts.Node): void => {
    if (node !== root && (ts.isArrowFunction(node) || ts.isFunctionExpression(node))) {
      // A `.map` / `.flatMap` callback renders what it returns into the
      // array the root joins; any other nested function renders only where
      // it is called.
      const p = node.parent;
      if (
        ts.isCallExpression(p) &&
        ts.isPropertyAccessExpression(p.expression) &&
        (p.expression.name.text === 'map' || p.expression.name.text === 'flatMap')
      ) {
        for (const r of returnsOf(node)) {
          collect(r, aliases, importedNames, out, seen, depth + 1, inFile);
        }
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      // A key or needle (`includes`, a Map key) is compared, never shown.
      // Its receiver is only tested (`id.includes('|')` renders a boolean).
      if (ts.isPropertyAccessExpression(node.expression) && KEY_METHODS.has(node.expression.name.text)) {
        if (node.expression.name.text === 'set' && node.arguments[1] !== undefined) {
          visit(node.arguments[1]);
        }
        return;
      }
      // A helper the scanned tree declares renders what it RETURNS too: an id
      // it fetches itself (`displacedPhysicalIdShown(op)`) is judged there.
      if (ts.isIdentifier(node.expression) && !aliases.has(node.expression.text)) {
        const here = node.getSourceFile().fileName;
        const name = node.expression.text;
        for (const def of knownFunctions.get(name) ?? []) {
          if (def.file.fileName !== here && !importedNames.has(name)) continue;
          if (isWrapped(node, root, aliases)) continue;
          out.push(...helperReturnFindings(def));
        }
      }
    }
    // An object literal renders nothing until something stringifies it.
    if (ts.isObjectLiteralExpression(node)) return;
    let occurrence = false;
    let param: Found['param'];
    if (ts.isPropertyAccessExpression(node) && PHYSICAL_ID_NAME.test(node.name.text)) occurrence = true;
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteral(node.argumentExpression) &&
      PHYSICAL_ID_NAME.test(node.argumentExpression.text)
    ) {
      occurrence = true;
    }
    if (ts.isIdentifier(node) && isValueIdentifier(node) && !importedNames.has(node.text)) {
      // `x.field` renders the field, not `x`: only a bare use follows the alias.
      const parent = node.parent;
      const isReceiver =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node;
      const binding = isReceiver ? undefined : resolveBinding(node);
      const init =
        binding !== undefined && ts.isVariableDeclaration(binding) ? binding.initializer : undefined;
      if (init !== undefined && !onlyTested(node, root) && !isWrapped(node, root, aliases)) {
        // Follow the alias: what it holds is what renders.
        collect(init, aliases, importedNames, out, seen, depth + 1, inFile);
      } else if (
        !isReceiver &&
        init === undefined &&
        (PHYSICAL_ID_NAME.test(node.text) ||
          // `const { physicalId: id } = record`: the id under another name.
          (binding !== undefined &&
            ts.isBindingElement(binding) &&
            binding.propertyName !== undefined &&
            ts.isIdentifier(binding.propertyName) &&
            PHYSICAL_ID_NAME.test(binding.propertyName.text)))
      ) {
        occurrence = true;
        param = binding !== undefined && ts.isParameter(binding) ? paramOf(binding) : undefined;
      }
    }
    if (occurrence) {
      if (!onlyTested(node, root)) {
        const verdict: Verdict = isWrapped(node, root, aliases)
          ? 'masked'
          : nonSecretTypeKey(node) !== undefined
            ? 'non-secret-type'
            : 'raw';
        out.push(tag({ node, verdict, ...(verdict === 'raw' && param !== undefined && { param }) }));
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(root);
}

/** The CFn type key of the table entry `node` sits in, listed or not. */
function typeKeyOf(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (!ts.isArrowFunction(n) && !ts.isFunctionExpression(n) && !ts.isMethodDeclaration(n)) continue;
    const holder = ts.isMethodDeclaration(n) ? n : n.parent;
    const key =
      (ts.isPropertyAssignment(holder) || ts.isMethodDeclaration(holder)) && ts.isStringLiteral(holder.name)
        ? holder.name.text
        : undefined;
    return key !== undefined && /^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/.test(key) ? key : undefined;
  }
  return undefined;
}

/** The CFn type key of the table entry `node` sits in, when that type is not listed. */
function nonSecretTypeKey(node: ts.Node): string | undefined {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if (!ts.isArrowFunction(n) && !ts.isFunctionExpression(n) && !ts.isMethodDeclaration(n)) continue;
    const holder = ts.isMethodDeclaration(n) ? n : n.parent;
    const key =
      (ts.isPropertyAssignment(holder) || ts.isMethodDeclaration(holder)) && ts.isStringLiteral(holder.name)
        ? holder.name.text
        : undefined;
    if (key === undefined || !/^AWS::[A-Za-z0-9]+::[A-Za-z0-9]+$/.test(key)) return undefined;
    return secretTypes.has(key) ? undefined : key;
  }
  return undefined;
}

/** The named function a plain parameter belongs to, and its position. */
function paramOf(p: ts.ParameterDeclaration): Found['param'] {
  if (!ts.isIdentifier(p.name) || p.dotDotDotToken !== undefined) return undefined;
  const fn = p.parent;
  const index = fn.parameters.indexOf(p);
  if (ts.isFunctionDeclaration(fn) && fn.name !== undefined) return { fn: fn.name.text, index };
  if (ts.isMethodDeclaration(fn) && ts.isIdentifier(fn.name)) return { fn: fn.name.text, index };
  if (
    (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
    ts.isVariableDeclaration(fn.parent) &&
    ts.isIdentifier(fn.parent.name)
  ) {
    return { fn: fn.parent.name.text, index };
  }
  return undefined;
}

/** Does `node` hold a call to an imported masker anywhere inside it? */
function containsMasker(node: ts.Node, aliases: Map<string, string>): boolean {
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (name !== undefined && aliases.has(name)) return true;
  }
  return ts.forEachChild(node, (c) => (containsMasker(c, aliases) ? true : undefined)) === true;
}

function isLiteralValue(node: ts.Expression): boolean {
  return (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(node) && node.text === 'undefined')
  );
}

function enclosingFunctionName(node: ts.Node): string {
  for (let n: ts.Node | undefined = node.parent; n !== undefined; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name !== undefined) {
      return n.name.getText();
    }
    if (
      (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) &&
      (ts.isVariableDeclaration(n.parent) || ts.isPropertyAssignment(n.parent))
    ) {
      return n.parent.name.getText();
    }
  }
  return '<module>';
}

/** Every site in one source text. Throws on a file that does not parse. */
interface ParsedFile {
  fileName: string;
  source: ts.SourceFile;
  aliases: Map<string, string>;
  importedNames: Set<string>;
}

/** Every named function the files being analyzed declare, by name. */
let knownFunctions = new Map<string, { fn: ts.FunctionLikeDeclaration; file: ParsedFile }[]>();
const helperMemo = new Map<ts.Node, Found[]>();
const helperInProgress = new Set<ts.Node>();

function registerFunctions(file: ParsedFile, into: typeof knownFunctions): void {
  const add = (name: string, fn: ts.FunctionLikeDeclaration): void => {
    into.set(name, [...(into.get(name) ?? []), { fn, file }]);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined && node.body !== undefined) {
      add(node.name.text, node);
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      add(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file.source);
}

/** The expressions `fn` returns (an arrow's expression body included). */
function returnsOf(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const body = fn.body;
  if (body === undefined) return [];
  if (!ts.isBlock(body)) return [body];
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression !== undefined) out.push(node.expression);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return out;
}

/**
 * A call that turns a value into TEXT to show (`displaySafe`, `displayIdent`,
 * `String`, a masker, `quotedRender`): a helper returning one is a display
 * helper. Any other returned call (`cfnRefValueFromPhysicalId`) computes a
 * VALUE the caller uses.
 */
const DISPLAY_CALLEE = /^(display|String$|mask|safe|shown|quoted|refusal)/i;

/** What a helper's returns render, read once per helper (a cycle reads nothing). */
function helperReturnFindings(def: { fn: ts.FunctionLikeDeclaration; file: ParsedFile }): Found[] {
  const memo = helperMemo.get(def.fn);
  if (memo !== undefined) return memo;
  if (helperInProgress.has(def.fn)) return [];
  helperInProgress.add(def.fn);
  const found: Found[] = [];
  // A DISPLAY return: the id passed through a call (`displaySafe(...)`,
  // `mask(...)`). A bare id or a space-free template is a VALUE the caller
  // uses (an ARN, a `Ref`), and a prose return is a root of its own.
  // Through `?:` arms, `??` / `||` operands and a local `const` returned by
  // name, to the calls the value can come from.
  const leaves: ts.Expression[] = [];
  const seenLeaf = new Set<ts.Node>();
  const expand = (x: ts.Expression): void => {
    let e = x;
    while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
    if (seenLeaf.has(e)) return;
    seenLeaf.add(e);
    if (ts.isConditionalExpression(e)) {
      expand(e.whenTrue);
      expand(e.whenFalse);
    } else if (
      ts.isBinaryExpression(e) &&
      (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        e.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      expand(e.left);
      expand(e.right);
    } else if (ts.isIdentifier(e)) {
      const b = resolveBinding(e);
      if (b !== undefined && ts.isVariableDeclaration(b) && b.initializer !== undefined) expand(b.initializer);
    } else {
      leaves.push(e);
    }
  };
  for (const r of returnsOf(def.fn)) expand(r);
  for (const e of leaves) {
    if (!ts.isCallExpression(e)) continue;
    const callee = calleeName(e);
    if (callee === undefined || !DISPLAY_CALLEE.test(callee)) continue;
    collect(e, def.file.aliases, def.file.importedNames, found, new Set(), 0, def.file);
  }
  helperInProgress.delete(def.fn);
  helperMemo.set(def.fn, found);
  return found;
}

function parse(sourceText: string, fileName: string): ParsedFile {
  const source = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const { parseDiagnostics } = source as unknown as { parseDiagnostics: readonly ts.Diagnostic[] };
  if (parseDiagnostics.length > 0) {
    throw new Error(`${fileName} does not parse, so its sites cannot be read`);
  }
  return {
    fileName,
    source,
    aliases: importedAliases(source),
    importedNames: importedBindingNames(source),
  };
}

function siteOf(reading: ParsedFile, f: Found, shape?: SiteShape): Site {
  const file = f.file ?? reading;
  const at = file.source.getLineAndCharacterOfPosition(f.node.getStart(file.source));
  return {
    file: file.fileName,
    line: at.line + 1,
    column: at.character + 1,
    fn: enclosingFunctionName(f.node),
    text: f.node.getText(file.source).replace(/\s+/g, ' '),
    verdict: f.verdict,
    ...(f.param !== undefined && { param: f.param }),
    ...((f.file !== undefined || shape !== undefined) && {
      shape: f.file !== undefined ? ('helper-return' as const) : shape,
    }),
  };
}

function sinkKind(call: ts.CallExpression): SiteShape {
  const callee = call.expression as ts.PropertyAccessExpression;
  if (callee.name.text === 'write') return 'stdout';
  return ts.isIdentifier(callee.expression) && callee.expression.text === 'console' ? 'console' : 'logger';
}

/** Where a prose text goes: returned, stored as a Map value, or elsewhere. */
function proseShape(node: ts.Node): SiteShape {
  for (let n: ts.Node = node; n.parent !== undefined; n = n.parent) {
    const p = n.parent;
    if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === n)) return 'prose-return';
    if (
      ts.isCallExpression(p) &&
      ts.isPropertyAccessExpression(p.expression) &&
      p.expression.name.text === 'set' &&
      p.arguments[1] === n
    ) {
      return 'prose-map-set';
    }
    if (ts.isStatement(p) || ts.isFunctionLike(p)) return 'prose';
  }
  return 'prose';
}

/**
 * A KEY or NEEDLE position: what these methods compare or look up is never
 * shown, so a text there is not prose (the second argument of `set` is the
 * stored VALUE, and is; a Set's `add` stores a value that is listed later).
 */
const KEY_METHODS = new Set([
  'includes',
  'startsWith',
  'endsWith',
  'indexOf',
  'has',
  'get',
  'set',
  'delete',
]);
function isKeyArgument(node: ts.Node): boolean {
  let n: ts.Node = node;
  while (n.parent !== undefined && ts.isParenthesizedExpression(n.parent)) n = n.parent;
  const p = n.parent;
  return (
    p !== undefined &&
    ts.isCallExpression(p) &&
    ts.isPropertyAccessExpression(p.expression) &&
    KEY_METHODS.has(p.expression.name.text) &&
    p.arguments[0] === n
  );
}

/** Every site of one parsed file: the parts of each prose text and sink. */
function sitesOf(file: ParsedFile): Site[] {
  const sites: Site[] = [];
  // One site per rendering expression, however many texts read it.
  const reported = new Set<ts.Node>();
  const take = (roots: readonly ts.Node[], shape: SiteShape): void => {
    const found: Found[] = [];
    const seen = new Set<ts.Node>();
    for (const root of roots) collect(root, file.aliases, file.importedNames, found, seen, 0);
    for (const f of found) {
      if (reported.has(f.node)) continue;
      reported.add(f.node);
      sites.push(siteOf(file, f, shape));
    }
  };
  const visit = (node: ts.Node): void => {
    const prose = isKeyArgument(node) ? undefined : proseParts(node);
    if (prose !== undefined) take(prose, proseShape(node));
    if (isSink(node)) {
      // An error's MESSAGE is its first argument; the rest are fields (a
      // `ProvisioningError`'s physical id is the record's identity, not text).
      if (ts.isNewExpression(node)) take((node.arguments ?? []).slice(0, 1), 'error');
      else {
        const kind = sinkKind(node);
        take(node.arguments, kind);
        // A logger renders its extra arguments too, an object's values included.
        for (const arg of node.arguments) {
          if (!ts.isObjectLiteralExpression(arg)) continue;
          take(
            arg.properties.flatMap((p) =>
              ts.isPropertyAssignment(p) ? [p.initializer] : ts.isShorthandPropertyAssignment(p) ? [p.name] : []
            ),
            kind
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file.source);
  return sites;
}

/**
 * Every site in one source text, `param` sites resolved against the calls in
 * the same text. Throws on a file that does not parse.
 */
export function analyzeSource(
  sourceText: string,
  fileName = 'x.ts',
  listed: ReadonlySet<string> = secretPhysicalIdTypes()
): Site[] {
  return analyzeFiles([{ text: sourceText, fileName }], listed);
}

/** The plain parameters of a named function that `node` references. */
function parametersIn(node: ts.Node): { node: ts.Identifier; param: { fn: string; index: number } }[] {
  const out: { node: ts.Identifier; param: { fn: string; index: number } }[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isIdentifier(n) && isValueIdentifier(n)) {
      const b = resolveBinding(n);
      const param = b !== undefined && ts.isParameter(b) ? paramOf(b) : undefined;
      if (param !== undefined) out.push({ node: n, param });
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** The function names a file declares (a declaration, or a `const` arrow). */
function declaredFunctionNames(file: ParsedFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) names.add(node.name.text);
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file.source);
  return names;
}

/**
 * The sites of several files. A site rendering a PARAMETER of a named function
 * moves the obligation to that function's callers (across every file given; a
 * plain call counts only in a file that declares or imports the name): each
 * call must hand that position a masked value, or the caller's own parameter,
 * which then moves to ITS callers, to a fixpoint. The parameter reads as
 * masked only when it has a caller and no caller handed it anything else:
 * such a call is a raw site at the call, and the parameter stays raw too, so
 * an exemption at the call cannot vouch for the function.
 */
export function analyzeFiles(
  inputs: readonly { text: string; fileName: string }[],
  listed: ReadonlySet<string> = secretPhysicalIdTypes()
): Site[] {
  secretTypes = listed;
  const files = inputs.map((i) => parse(i.text, i.fileName));
  knownFunctions = new Map();
  helperMemo.clear();
  for (const f of files) registerFunctions(f, knownFunctions);
  const declared = new Map(files.map((f) => [f, declaredFunctionNames(f)]));
  const sites = files.flatMap(sitesOf);
  const paramSites: Site[] = sites.filter((x) => x.param !== undefined);
  const forwarded: Site[] = [];
  // A function is its file and name: a same-named one elsewhere is another.
  const keyOfParam = (x: Site): string => `${x.file}#${x.param!.fn}#${x.param!.index}`;
  const processed = new Set<string>();
  // A call that is not a forward of the caller's own parameter.
  const externallyCalled = new Set<string>();
  const handedRaw = new Set<string>();
  // `from` forwards its parameter into `to`.
  const edges: { from: string; to: string }[] = [];
  const callerSites: Site[] = [];
  let pending = paramSites;
  while (pending.length > 0) {
    const byFn = new Map<string, { index: number; file: string; key: string }[]>();
    for (const x of pending) {
      const key = keyOfParam(x);
      if (processed.has(key)) continue;
      processed.add(key);
      const entry = { index: x.param!.index, file: x.file, key };
      byFn.set(x.param!.fn, [...(byFn.get(x.param!.fn) ?? []), entry]);
    }
    const next: Site[] = [];
    for (const file of files) {
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const name = calleeName(node);
          // A plain call reaches the function of its own file, or the one
          // its file imports by that name; a method call any of that name.
          const reaches = (entry: { file: string }): boolean =>
            !ts.isIdentifier(node.expression) ||
            (entry.file === file.fileName
              ? true
              : file.importedNames.has(name!) && !declared.get(file)!.has(name!));
          const entries = (name === undefined ? undefined : byFn.get(name)) ?? [];
          for (const { index, key } of entries.filter(reaches)) {
            const arg = node.arguments[index];
            if (arg === undefined) continue;
            // The caller's own parameter, whatever its name: forwarded.
            const binding = ts.isIdentifier(arg) ? resolveBinding(arg) : undefined;
            const forwardedParam =
              binding !== undefined && ts.isParameter(binding) ? paramOf(binding) : undefined;
            if (forwardedParam !== undefined) {
              const site = { ...siteOf(file, { node: arg, verdict: 'raw' as const }), param: forwardedParam };
              edges.push({ from: keyOfParam(site), to: key });
              next.push(site);
              continue;
            }
            externallyCalled.add(key);
            const found: Found[] = [];
            collect(arg, file.aliases, file.importedNames, found, new Set(), 0);
            // The caller's parameters spliced into the argument (`x ${p}`,
            // `f(p)`): each is forwarded, as a bare one is.
            const spliced = found.length === 0 ? parametersIn(arg) : [];
            for (const { node: pNode, param } of spliced) {
              const site = { ...siteOf(file, { node: pNode, verdict: 'raw' as const }), param };
              edges.push({ from: keyOfParam(site), to: key });
              next.push(site);
            }
            if (
              found.length === 0 &&
              spliced.length === 0 &&
              !isLiteralValue(arg) &&
              !containsMasker(arg, file.aliases)
            ) {
              // Not visibly an id, and not visibly masked: the caller must say.
              handedRaw.add(key);
              callerSites.push(siteOf(file, { node: arg, verdict: 'raw' }));
            }
            for (const f of found) {
              const site = siteOf(file, f);
              if (site.param !== undefined) {
                edges.push({ from: keyOfParam(site), to: key });
                next.push(site);
              }
              else {
                if (f.verdict === 'raw') handedRaw.add(key);
                callerSites.push(site);
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file.source);
    }
    paramSites.push(...next);
    forwarded.push(...next);
    pending = next;
  }
  // REACHED: called from outside the forwarding graph, directly or through
  // forwards from a reached parameter (a cycle with no outside caller is not).
  // RAW: not reached, or handed a raw value, or forwarded from a raw one.
  const reached = new Set(externallyCalled);
  const rawParams = new Set<string>();
  for (const x of paramSites) {
    const key = keyOfParam(x);
    if (handedRaw.has(key)) rawParams.add(key);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of edges) {
      if (reached.has(e.from) && !reached.has(e.to)) {
        reached.add(e.to);
        changed = true;
      }
    }
  }
  for (const x of paramSites) {
    const key = keyOfParam(x);
    if (!reached.has(key)) rawParams.add(key);
  }
  for (let changed = true; changed; ) {
    changed = false;
    for (const e of edges) {
      if (rawParams.has(e.from) && !rawParams.has(e.to)) {
        rawParams.add(e.to);
        changed = true;
      }
    }
  }
  const resolved = [...sites, ...forwarded].map((x) =>
    x.param === undefined
      ? x
      : {
          ...x,
          verdict: rawParams.has(keyOfParam(x)) ? ('raw' as const) : ('masked' as const),
        }
  );
  // A call argument a text already rendered is one site, not two.
  const out: Site[] = [];
  const seenKeys = new Set<string>();
  for (const x of [...resolved, ...callerSites]) {
    const key = `${x.file}:${x.line}:${x.column}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push(x);
  }
  return out;
}

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

export interface Scan {
  files: number;
  sites: Site[];
}

export function scanTree(root = REPO_ROOT): Scan {
  const inputs: { text: string; fileName: string }[] = [];
  for (const dir of SCANNED_DIRS) {
    for (const file of listSourceFiles(join(root, dir))) {
      inputs.push({ text: readFileSync(file, 'utf8'), fileName: relative(root, file) });
    }
  }
  return { files: inputs.length, sites: analyzeFiles(inputs, secretPhysicalIdTypes(root)) };
}

/** The raw sites no exemption covers, and every exemption whose count is off. */
export function judgeSites(
  sites: readonly Site[],
  exemptions: readonly Exemption[] = EXEMPTIONS
): string[] {
  const failures: string[] = [];
  const rawBy = new Map<string, Site[]>();
  for (const s of sites) {
    if (s.verdict !== 'raw') continue;
    const key = `${s.file}#${s.fn}`;
    rawBy.set(key, [...(rawBy.get(key) ?? []), s]);
  }
  const exempt = new Map(exemptions.map((e) => [`${e.file}#${e.fn}`, e]));
  for (const [key, list] of rawBy) {
    const e = exempt.get(key);
    if (e !== undefined && e.count === list.length) continue;
    for (const s of list) {
      failures.push(
        `${s.file}:${s.line} (${s.fn}) renders \`${s.text}\` without displayPhysicalId(<resourceType>, <id>). ` +
          `If this text is never shown (sent to AWS, compared, a key), add an EXEMPTIONS entry with the reason: ` +
          `never wrap a value that is sent or compared` +
          (e !== undefined ? ` (exemption expects ${e.count}, found ${list.length})` : '')
      );
    }
  }
  for (const [key, e] of exempt) {
    if (!rawBy.has(key)) failures.push(`exemption ${key} matches no raw site (expected ${e.count}): remove it`);
  }
  return failures;
}

// ---------------------------------------------------------------- part 2

export type RenderedRowKind = 'template-value' | 's3-object';

export interface RenderedRow {
  resourceType: string;
  /** The key a readback can return the rendered content under. */
  renderedKey: string;
  /** The sibling the record may hold instead. */
  sourceKey: string;
  kind: RenderedRowKind;
}

const SIBLING_SUFFIXES: ReadonlyArray<[string, RenderedRowKind]> = [
  ['String', 'template-value'],
  ['Substitutions', 'template-value'],
  ['S3Location', 's3-object'],
];

/** The rows, from the schema fixtures' top-level `properties`. */
export function renderedReadbackRows(root = REPO_ROOT): RenderedRow[] {
  const rows: RenderedRow[] = [];
  const dir = join(root, SCHEMA_DIR);
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json') || name.startsWith('_')) continue;
    const schema = JSON.parse(readFileSync(join(dir, name), 'utf8')) as {
      resourceType?: unknown;
      properties?: unknown;
    };
    if (typeof schema.resourceType !== 'string' || !Array.isArray(schema.properties)) {
      throw new Error(`${SCHEMA_DIR}/${name}: no resourceType / properties list to read`);
    }
    const props = new Set(schema.properties.filter((p): p is string => typeof p === 'string'));
    for (const prop of props) {
      for (const [suffix, kind] of SIBLING_SUFFIXES) {
        if (!prop.endsWith(suffix) || prop === suffix) continue;
        const stem = prop.slice(0, -suffix.length);
        if (props.has(stem)) {
          rows.push({ resourceType: schema.resourceType, renderedKey: stem, sourceKey: prop, kind });
        }
      }
    }
  }
  return rows;
}

/** A string-literal `Set([...])` / array the definition module declares under `name`. */
export function declaredStringList(sourceText: string, name: string): string[] | undefined {
  const source = ts.createSourceFile('definition.ts', sourceText, ts.ScriptTarget.Latest, true);
  let found: string[] | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      let init = node.initializer;
      if (init !== undefined && ts.isNewExpression(init)) init = init.arguments?.[0];
      if (init !== undefined && ts.isArrayLiteralExpression(init)) {
        found = init.elements.filter(ts.isStringLiteral).map((e) => e.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function judgeRenderedRows(
  rows: readonly RenderedRow[],
  renderedKeys: readonly string[],
  sourceKeys: readonly string[]
): string[] {
  const failures: string[] = [];
  for (const row of rows) {
    if (row.kind !== 'template-value') continue;
    if (!renderedKeys.includes(row.renderedKey) || !sourceKeys.includes(row.sourceKey)) {
      failures.push(
        `${row.resourceType}: a readback's \`${row.renderedKey}\` is rendered from \`${row.sourceKey}\`, ` +
          `which the redaction does not pair (add them to RENDERED_DEFINITION_KEYS / DEFINITION_SOURCE_KEYS in ${DEFINITION_KEYS_FILE}, ` +
          `with a case in tests/unit/scripts/secret-physical-id-log.test.ts)`
      );
    }
  }
  return failures;
}

// ---------------------------------------------------------------- floors

/** Collapse toward zero: a scan reading nothing passes otherwise. */
export const FLOORS = { files: 500, sites: 160, maskedSites: 140, renderedRows: 9, templateRows: 2 } as const;

/**
 * Collapse of ONE shape: each root kind the scan claims to read must still
 * find masked sites in the real tree (an aggregate floor hides a dead shape).
 */
export const SHAPE_FLOORS: Readonly<Partial<Record<SiteShape, number>>> = {
  logger: 40,
  stdout: 1,
  error: 10,
  'prose-map-set': 2,
  'prose-return': 5,
  'helper-return': 1,
};

export function checkAll(root = REPO_ROOT): { failures: string[]; scan: Scan; rows: RenderedRow[] } {
  const scan = scanTree(root);
  const failures = judgeSites(scan.sites);
  const masked = scan.sites.filter((s) => s.verdict === 'masked').length;
  for (const [shape, floor] of Object.entries(SHAPE_FLOORS)) {
    const n = scan.sites.filter((s) => s.shape === shape && s.verdict === 'masked').length;
    if (n < floor!) failures.push(`floor: ${n} masked ${shape} sites, expected >= ${floor}: that root stopped being read`);
  }
  if (scan.files < FLOORS.files) failures.push(`floor: ${scan.files} files scanned, expected >= ${FLOORS.files}`);
  if (scan.sites.length < FLOORS.sites) {
    failures.push(`floor: ${scan.sites.length} sites, expected >= ${FLOORS.sites}: the scan stopped seeing them`);
  }
  if (masked < FLOORS.maskedSites) {
    failures.push(`floor: ${masked} masked sites, expected >= ${FLOORS.maskedSites}: the masker match broke`);
  }
  const rows = renderedReadbackRows(root);
  const definition = readFileSync(join(root, DEFINITION_KEYS_FILE), 'utf8');
  const renderedKeys = declaredStringList(definition, 'RENDERED_DEFINITION_KEYS');
  const sourceKeys = declaredStringList(definition, 'DEFINITION_SOURCE_KEYS');
  if (renderedKeys === undefined || sourceKeys === undefined) {
    failures.push(`${DEFINITION_KEYS_FILE}: RENDERED_DEFINITION_KEYS / DEFINITION_SOURCE_KEYS not found as string lists`);
  } else {
    failures.push(...judgeRenderedRows(rows, renderedKeys, sourceKeys));
  }
  if (rows.length < FLOORS.renderedRows) failures.push(`floor: ${rows.length} readback rows, expected >= ${FLOORS.renderedRows}`);
  const templateRows = rows.filter((r) => r.kind === 'template-value').length;
  if (templateRows < FLOORS.templateRows) {
    failures.push(`floor: ${templateRows} template-value readback rows, expected >= ${FLOORS.templateRows}`);
  }
  return { failures, scan, rows };
}

function main(): number {
  const { failures, scan, rows } = checkAll();
  const masked = scan.sites.filter((s) => s.verdict === 'masked').length;
  console.log(
    `secret physical ids: ${scan.sites.length} rendering sites in ${scan.files} files (${masked} masked); ` +
      `${rows.length} readback rows`
  );
  for (const f of failures) console.log(`  ${f}`);
  return failures.length > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
