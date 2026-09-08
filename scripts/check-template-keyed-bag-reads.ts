/**
 * Classifier for the "a bag keyed by TEMPLATE text is read on a plain object"
 * defect class (issue #2802, fencing the sweep of issue #2767).
 *
 * The class: a CloudFormation template supplies logical ids, parameter names,
 * condition names, mapping keys, attribute names, output names and dynamic-
 * reference JSON keys. Reading one of those off a plain object walks the
 * PROTOTYPE CHAIN, so a name that happens to be an `Object.prototype` member
 * -- `constructor`, `toString`, `valueOf`, `hasOwnProperty` -- answers where no
 * entry exists. Every instance found so far produced a WRONG RESULT rather than
 * a refusal: a function's source text returned as a resolved secret, `undefined`
 * shipped into a live property, a declared resource dropped from the effective
 * template so the diff issued a DELETE for it.
 *
 * WRITES are in scope for the same reason and are not symmetric with reads:
 * `bag['__proto__'] = v` on a plain object routes through the inherited SETTER,
 * so the key is silently absent afterwards and the object's prototype is
 * replaced. A read-only checker reported `template-parser.ts` clean while
 * `filterResourcesByCondition` was dropping resources.
 *
 * WHY A CHECKER AND NOT A REVIEW CHECKLIST. Four review rounds on PR #2777 each
 * surfaced sites the previous round had missed, and the fourth showed the
 * enumeration had been complete all along -- what failed was the TRIAGE, three
 * sites dismissed without reading their callers. A rule that depends on someone
 * classifying 50 accesses correctly, every time, is not a rule.
 *
 * An access is ACCEPTED when any of these holds:
 *
 *  1. the key is not template-shaped -- a numeric / loop index, or the bag is
 *     one of the INTERNAL_BAGS whose keys cdkd itself mints (a region, a cache
 *     key). This is the only heuristic arm, and it is deliberately narrow.
 *  2. an `Object.hasOwn(bag, key)` appears in the same FUNCTION for the same
 *     bag and key, compared after stripping `as` casts and parentheses so a
 *     guard written against `(x as Record<string, unknown>)` matches an access
 *     written against `x`.
 *  3. the bag is initialised from `Object.create(null)` in an ENCLOSING
 *     FUNCTION -- not merely the nearest one, since a bag declared in a method
 *     is written from an inner arrow, and not the whole FILE, since that
 *     exempts every same-named access anywhere in it. Every declaration of the
 *     name in that scope must be null-prototype, or a sibling binding vouches
 *     for an unrelated one.
 *  4. the write is the `defineProperty` SHADOW arm, i.e. it sits in the `else`
 *     of an `if (key === '__proto__')` whose then-branch calls
 *     `Object.defineProperty`.
 *  5. it carries `// allow-template-keyed-bag-read: <reason>` on its own line
 *     or the line above. The reason is mandatory -- an unexplained exemption is
 *     the triage failure this exists to stop, written down.
 *
 * Scope is a LIST, not a glob (`SCANNED_FILES`), so widening it is a conscious
 * edit rather than something a new file inherits silently.
 *
 * KNOWN BOUNDS, stated because a fence that over-claims is worse than none.
 * Each was measured; none is a shape the two scanned files contain today.
 *
 *  a. `INTERNAL_BAGS` is matched on the bag's SOURCE TEXT, so a future
 *     `cachedOutputs[outputName]` -- template text on a `cached*` bag -- is
 *     accepted, and the unqualified names `parts` / `replacements` /
 *     `resolvedList` are accepted wherever any function reuses them.
 *  b. ONE allow marker exempts every access on its line, so `a[k] + b[k]`
 *     behind a single marker clears both.
 *  c. `Object.assign(bag, { [key]: v })` uses `[[Set]]` and IS the defect, and
 *     is not examined at all -- only `in` tests and element access are.
 *  d. A destructuring read, `const { [key]: v } = bag`, is likewise invisible.
 *  e. A guard is matched anywhere in an enclosing FUNCTION, not by dominance,
 *     so `if (other) { if (Object.hasOwn(bag, k)) {} } return bag[k];` is
 *     accepted.
 *
 * Closing (a) needs provenance the syntax does not carry; (b)-(e) need more
 * AST work than the population justifies today. They are recorded rather than
 * fixed so the next reader knows what a green run does NOT say.
 *
 * Separate from its test so the classifier can be table-tested against
 * synthetic source shapes as well as against today's tree.
 */

// `typescript-v6` is an npm alias of typescript@6: TypeScript 7's package no
// longer exports the stable compiler API from its root (see package.json).
import ts from 'typescript-v6';
import { readFileSync } from 'node:fs';

/** Files this checker scans. A list, never a glob. */
export const SCANNED_FILES: readonly string[] = [
  'src/deployment/intrinsic-function-resolver.ts',
  'src/analyzer/template-parser.ts',
];

export const ALLOW_MARKER = 'allow-template-keyed-bag-read';

/**
 * Bags whose keys cdkd MINTS rather than reads out of a template: a region
 * name, a composed cache key, a positional array. Matched on the bag's source
 * text. Kept small on purpose -- every entry is a place the checker stops
 * looking, so a wrong one is a silent hole.
 */
const INTERNAL_BAGS = [
  /^cached[A-Za-z0-9]*$/,
  /^this\.cfnClients$/,
  /^parts$/,
  /^replacements$/,
  /^resolvedList$/,
];

/** Keys that are positional rather than template text. */
const POSITIONAL_KEY =
  /^(i|j|k|idx|index|cursor|cursor\+\+|\+\+cursor)$|^[\w$.]+\.length(\s*[+-]\s*\d+)?$|\.index$|^\d+$/;

export type Shape = 'in' | 'index-read' | 'index-write';

export interface BagAccessFinding {
  file: string;
  line: number;
  shape: Shape;
  bag: string;
  key: string;
  text: string;
}

export interface BagAccessReport {
  findings: BagAccessFinding[];
  /** Every access examined, accepted or not — the checker's coverage evidence. */
  examined: Record<Shape, number>;
}

/** Strip `as` casts, parentheses and non-null assertions for text comparison. */
const normalize = (node: ts.Node, src: ts.SourceFile): string => {
  let n = node;
  for (;;) {
    if (ts.isParenthesizedExpression(n)) n = n.expression;
    else if (ts.isAsExpression(n)) n = n.expression;
    else if (ts.isNonNullExpression(n)) n = n.expression;
    else break;
  }
  return n.getText(src).replace(/\s+/g, '');
};

/**
 * Every enclosing function-like node, innermost first, ending at the source
 * file. The null-prototype search needs ALL of them: `evaluateConditions`
 * declares its bag and then writes to it from an inner arrow, so a search
 * bounded to the NEAREST function cannot see the declaration -- two live
 * writes were accepted only because a different arm happened to cover them.
 */
const enclosingScopes = (node: ts.Node): ts.Node[] => {
  const out: ts.Node[] = [];
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n)
    ) {
      out.push(n);
    }
    n = n.parent;
  }
  return out;
};

/** The nearest enclosing function-like node, or the source file. */
const enclosingFunction = (node: ts.Node): ts.Node => {
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (
      ts.isFunctionDeclaration(n) ||
      ts.isFunctionExpression(n) ||
      ts.isArrowFunction(n) ||
      ts.isMethodDeclaration(n) ||
      ts.isConstructorDeclaration(n) ||
      ts.isSourceFile(n)
    ) {
      return n;
    }
    n = n.parent;
  }
  return node.getSourceFile();
};

/** Does an `Object.hasOwn(bag, key)` for this pair appear inside `scope`? */
const hasGuardIn = (scope: ts.Node, src: ts.SourceFile, bag: string, key: string): boolean => {
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      normalize(n.expression.expression, src) === 'Object' &&
      n.expression.name.text === 'hasOwn' &&
      n.arguments.length === 2 &&
      normalize(n.arguments[0]!, src) === bag &&
      normalize(n.arguments[1]!, src) === key
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  walk(scope);
  return found;
};

/** Is `bag` initialised from `Object.create(null)` inside `scope`? */
const isNullPrototypeBagIn = (scope: ts.Node, src: ts.SourceFile, bag: string): boolean => {
  let found = false;
  const isCreateNull = (init: ts.Expression | undefined): boolean => {
    if (init === undefined) return false;
    let e: ts.Node = init;
    while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    return (
      ts.isCallExpression(e) &&
      ts.isPropertyAccessExpression(e.expression) &&
      normalize(e.expression.expression, src) === 'Object' &&
      e.expression.name.text === 'create' &&
      e.arguments.length === 1 &&
      e.arguments[0]!.kind === ts.SyntaxKind.NullKeyword
    );
  };
  // Every declaration of this NAME in scope must be a null-prototype bag, not
  // merely one of them: `const out: unknown[] = new Array(n)` and a sibling
  // `const out = Object.create(null)` coexist in one real function, and
  // crediting the first from the second accepted a genuine bare write.
  let sawAny = false;
  let allCreateNull = true;
  const walk = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && normalize(n.name, src) === bag) {
      sawAny = true;
      if (!isCreateNull(n.initializer)) allCreateNull = false;
    }
    ts.forEachChild(n, walk);
  };
  walk(scope);
  found = sawAny && allCreateNull;
  return found;
};

/**
 * Is this write the `else` arm of an `if (<key> === '__proto__')` whose
 * then-branch calls `Object.defineProperty`? That is the sanctioned shadow.
 */
const isDefinePropertyShadowElse = (write: ts.Node, src: ts.SourceFile): boolean => {
  let n: ts.Node | undefined = write.parent;
  while (n && !ts.isIfStatement(n)) {
    if (ts.isFunctionLike(n)) return false;
    n = n.parent;
  }
  if (!n || !ts.isIfStatement(n) || n.elseStatement === undefined) return false;
  // The write must be in the ELSE branch. Walking up to the nearest `if` and
  // stopping there accepted a write in the THEN branch -- executed exactly when
  // the key IS `__proto__`, which is the case the shadow exists to divert.
  const elseStart = n.elseStatement.getStart(src);
  const elseEnd = n.elseStatement.getEnd();
  const w = write.getStart(src);
  if (w < elseStart || w >= elseEnd) return false;
  const cond = normalize(n.expression, src);
  if (!cond.includes("==='__proto__'")) return false;
  // The then-branch must define the SAME bag and key the else-branch writes.
  // Without that, `if (k === '__proto__') { Object.defineProperty(other, 'x', ...) }
  // else { bag[k] = v }` was accepted -- a shadow arm that shadows nothing.
  const target = ts.isBinaryExpression(write) && ts.isElementAccessExpression(write.left)
    ? {
        bag: normalize(write.left.expression, src),
        key: normalize(write.left.argumentExpression, src),
      }
    : undefined;
  if (target === undefined) return false;
  let calls = false;
  const walk = (x: ts.Node): void => {
    if (
      ts.isCallExpression(x) &&
      ts.isPropertyAccessExpression(x.expression) &&
      x.expression.name.text === 'defineProperty' &&
      x.arguments.length >= 2 &&
      normalize(x.arguments[0]!, src) === target.bag &&
      normalize(x.arguments[1]!, src) === target.key
    ) {
      calls = true;
    }
    ts.forEachChild(x, walk);
  };
  walk(n.thenStatement);
  return calls;
};

/**
 * Does the access carry the allow marker on its own line, or anywhere in the
 * CONTIGUOUS `//` comment block directly above it?
 *
 * The block, not just one line: a reason of real length wraps, and a marker
 * that only counted on the immediately preceding line would silently stop
 * applying the moment an author added a second sentence -- reporting the site
 * as unguarded and teaching them to delete the explanation.
 */
const hasAllowMarker = (lines: readonly string[], line: number): boolean => {
  const marked = (s: string): boolean => {
    const i = s.indexOf(ALLOW_MARKER);
    if (i === -1) return false;
    // The reason is mandatory: `<marker>: <at least one word>`.
    return /allow-template-keyed-bag-read:\s*\S/.test(s.slice(i));
  };
  if (marked(lines[line - 1] ?? '')) return true;
  for (let i = line - 2; i >= 0; i -= 1) {
    const text = (lines[i] ?? '').trim();
    if (!text.startsWith('//')) break;
    if (marked(text)) return true;
  }
  return false;
};

/** Classify one file's source text. Exported so the test can feed it shapes. */
export function findBagAccesses(fileName: string, sourceText: string): BagAccessReport {
  const src = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.ES2022, true);
  // A file that did not parse contributes zero accesses, which is byte-identical
  // to a clean one. Fail loudly instead -- the sibling critics
  // (`check-provider-secret-mask.ts`, `check-provider-update-context.ts`) do the
  // same, and measured here: truncating both scanned files to 80% left every
  // floor satisfied with 0 findings at exit 0.
  const diagnostics = (src as unknown as { parseDiagnostics?: readonly unknown[] })
    .parseDiagnostics;
  if (diagnostics !== undefined && diagnostics.length > 0) {
    throw new Error(
      `check-template-keyed-bag-reads: ${fileName} did not parse cleanly ` +
        `(${diagnostics.length} diagnostic(s)). A file the checker cannot read is ` +
        `a file it cannot guard.`
    );
  }
  const lines = sourceText.split('\n');
  const findings: BagAccessFinding[] = [];
  const examined: Record<Shape, number> = { in: 0, 'index-read': 0, 'index-write': 0 };

  const walk = (node: ts.Node): void => {
    let shape: Shape | undefined;
    let bagNode: ts.Node | undefined;
    let keyNode: ts.Node | undefined;
    let whole: ts.Node = node;

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.InKeyword &&
      !ts.isStringLiteralLike(node.left)
    ) {
      shape = 'in';
      bagNode = node.right;
      keyNode = node.left;
    } else if (ts.isElementAccessExpression(node)) {
      const arg = node.argumentExpression;
      const literalKey =
        ts.isStringLiteralLike(arg) || ts.isNumericLiteral(arg) || ts.isPrefixUnaryExpression(arg);
      if (!literalKey) {
        const p = node.parent;
        // Every assignment operator, not just `=`. A compound form (`+=`,
        // `??=`, `||=`) still goes through the inherited SETTER, so classifying
        // it as a read let an `Object.hasOwn` guard clear it -- and that guard
        // proves the opposite for a write.
        const isWrite =
          ts.isBinaryExpression(p) &&
          p.left === node &&
          p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          p.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
        shape = isWrite ? 'index-write' : 'index-read';
        bagNode = node.expression;
        keyNode = arg;
        whole = isWrite ? p : node;
      }
    }

    if (shape !== undefined && bagNode !== undefined && keyNode !== undefined) {
      examined[shape] += 1;
      const bag = normalize(bagNode, src);
      const key = normalize(keyNode, src);
      const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;
      const scope = enclosingFunction(node);

      const accepted =
        INTERNAL_BAGS.some((r) => r.test(bag)) ||
        POSITIONAL_KEY.test(key) ||
        // Arm 2 is for READS only. On a WRITE an `Object.hasOwn` guard proves
        // the OPPOSITE of what is needed: the write executes when the key is
        // ABSENT, which is exactly when `bag['__proto__'] = v` reaches the
        // inherited setter. Accepting a write on this arm made two live
        // `conditions[name] = ...` writes pass on a guard that does not
        // protect them.
        (shape !== 'index-write' && hasGuardIn(scope, src, bag, key)) ||
        enclosingScopes(node).some((s2) => isNullPrototypeBagIn(s2, src, bag)) ||
        (shape === 'index-write' && isDefinePropertyShadowElse(whole, src)) ||
        hasAllowMarker(lines, line);

      if (!accepted) {
        findings.push({
          file: fileName,
          line,
          shape,
          bag,
          key,
          text: whole.getText(src).replace(/\s+/g, ' ').slice(0, 100),
        });
      }
    }
    ts.forEachChild(node, walk);
  };

  walk(src);
  return { findings, examined };
}

/** Scan the repo's declared file list. */
export function scanRepo(read: (p: string) => string = (p) => readFileSync(p, 'utf8')): {
  findings: BagAccessFinding[];
  examined: Record<Shape, number>;
} {
  const findings: BagAccessFinding[] = [];
  const examined: Record<Shape, number> = { in: 0, 'index-read': 0, 'index-write': 0 };
  for (const file of SCANNED_FILES) {
    const report = findBagAccesses(file, read(file));
    findings.push(...report.findings);
    for (const shape of Object.keys(examined) as Shape[]) {
      examined[shape] += report.examined[shape];
    }
  }
  return { findings, examined };
}

/**
 * Per-shape lower bounds the BINARY enforces, not only the unit suite.
 * CI runs the binary, so floors that live only in the test leave the CI step a
 * byte-identical green when the walk stops seeing a shape. Measured 2026-09-08
 * at 1 / 37 / 15; deliberately loose.
 */
export const EXAMINED_FLOORS: Record<Shape, number> = {
  in: 1,
  'index-read': 25,
  'index-write': 10,
};

const isMain = process.argv[1]?.endsWith('check-template-keyed-bag-reads.ts') === true;
if (isMain) {
  const { findings, examined } = scanRepo();
  const belowFloor = (Object.keys(EXAMINED_FLOORS) as Shape[]).filter(
    (shape) => examined[shape] < EXAMINED_FLOORS[shape]
  );
  if (belowFloor.length > 0) {
    process.stdout.write(
      `check-template-keyed-bag-reads: the walk examined fewer accesses than the ` +
        `floor for ${belowFloor.join(', ')} ` +
        `(${belowFloor.map((s) => `${s}: ${examined[s]} < ${EXAMINED_FLOORS[s]}`).join('; ')}).\n` +
        `That is a checker that stopped seeing its input, not a clean tree.\n`
    );
    process.exit(1);
  }
  process.stdout.write(
    `examined: ${examined.in} in-tests, ${examined['index-read']} index reads, ${examined['index-write']} index writes\n`
  );
  if (findings.length > 0) {
    process.stdout.write(
      `\n${findings.length} unguarded template-keyed bag access(es):\n\n` +
        findings
          .map((f) => `  ${f.file}:${f.line}  [${f.shape}]  ${f.text}`)
          .join('\n') +
        `\n\nGuard with Object.hasOwn(<bag>, <key>), or -- when the key is not ` +
        `template text -- annotate the line with\n  // ${ALLOW_MARKER}: <reason>\n`
    );
    process.exit(1);
  }
  process.stdout.write('no unguarded template-keyed bag accesses\n');
}
