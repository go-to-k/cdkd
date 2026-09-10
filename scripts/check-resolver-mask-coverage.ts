/**
 * Every value interpolated into a `throw` or `logger.*` in the intrinsic
 * resolver is either MASKED or individually annotated. Nothing in between.
 *
 * ## Why this file is an AST walk and not a scanner
 *
 * Issue [#2827](https://github.com/go-to-k/cdkd/issues/2827) is "the resolver
 * leaves a resolved secret bare where it interpolates one". FOUR enumerations of
 * that population disagreed, each asserting completeness and each refuted by the
 * next round:
 *
 *   1. the issue body: ~14 throw sites;
 *   2. sweep 1: 18 throws, missing every success-path LOG line beside them and
 *      two throws spelled `markNonRetryable(new IntrinsicResolutionRefusalError(...))`;
 *   3. sweep 2: still missed `guardedPhysicalIdFallback` (the `default:` arm of
 *      38 `Fn::GetAtt` call sites), `rejectPlaceholderArnAttribute`, the
 *      `CrossAccountSecretRefusalError` throw and the four `origin` builders;
 *   4. a LINE-ANCHORED checker written to end that cycle — which could not see
 *      the masks it certified. Its exclusion was per-STATEMENT, so one note
 *      exempted every interpolation in the statement including the masked ones;
 *      stripping the mask off `physicalId` in `guardedPhysicalIdFallback` left it
 *      green. And it counted `(`/`)` through COMMENTS, so a comment containing
 *      the text `throw new Error(` ran one statement's window 50 lines past its
 *      end and attached a note to the wrong site.
 *
 * Both of that fourth round's defects are properties of scanning TEXT. An AST
 * has exact statement boundaries and no comments inside expressions, so neither
 * can recur here. That is NOT the same as "a misattached marker is impossible":
 * an AST walk that climbs too far attaches one just as wrongly, and this one did
 * — `markersFor` used to climb to the first enclosing `ts.isStatement` node,
 * which for a `throw` sitting directly in a method body is the CLASS
 * DECLARATION, so one `not-in-class(v)` in the class JSDoc silenced every such
 * site in the class (measured, review round 4). The climb is now BOUNDED at the
 * node's immediately enclosing statement and stops at the first function, class,
 * block or file boundary, and an UNCONSUMED marker is reported rather than
 * ignored — the two halves of "the marker is read at the site it was written
 * for".
 *
 * ## What it decides, and what it refuses to decide
 *
 * It does NOT judge whether a value is secret-bearing. That judgement is what
 * kept being wrong, and it is not mechanisable: whether `logicalId` can carry a
 * plaintext is a fact about CloudFormation's grammar, not about this file. The
 * checker answers the weaker question it CAN answer — "is this expression
 * masked, and if not, has someone written down why" — and forces the answer to
 * sit at the site, per EXPRESSION:
 *
 *     // not-in-class(logicalId): a LOGICAL ID; CloudFormation requires a literal.
 *
 * Per-expression, not per-statement, because the per-statement form is exactly
 * what round 4 shipped: a mixed statement had its masked half unwatched.
 *
 * ## What counts as masked
 *
 * {@link isMasked} is structural, and deliberately strict — each of these shapes
 * was MEASURED passing a substring-matching predicate while leaking:
 *
 *   - a real masker CALL whose result is the whole expression. `MASKERS` holds
 *     only functions that mask by VALUE. `stringifyAttributeForLog` was in that
 *     list and is not one: it redacts on the attribute NAME regex and otherwise
 *     returns the value verbatim (`src/utils/stringify.ts`), so dropping the real
 *     `maskSecretsForLog` wrapper from all four `Fn::GetAtt` lines left the old
 *     checker at zero findings;
 *   - a conditional needs BOTH arms masked — `${c ? mask(a) : b}` passed before;
 *   - a `+` concatenation needs every non-literal operand masked, which is also
 *     how a message built without any `${}` at all gets seen;
 *   - an IDENTIFIER is resolved to its declaration and judged on the initializer.
 *     A name is never evidence: 27 `${logged*}` interpolations rode on a naming
 *     convention with nothing checking that the binding was in fact masked, and
 *     a message assembled in a helper and logged as a bare identifier was
 *     invisible.
 */
import ts from 'typescript-v6';
import { readFileSync } from 'node:fs';

export const SUBJECT = 'src/deployment/intrinsic-function-resolver.ts';

/**
 * Functions that mask by VALUE.
 *
 * Deliberately short, and adding to it is a security decision: everything here
 * is trusted to render a secret unreadable. `stringifyAttributeForLog` and
 * `stringifyParameterForLog` are NOT here — they are encoders that redact on a
 * NAME, so they must themselves sit inside a masker.
 */
export const MASKERS = [
  'maskSecretsForLog',
  'maskValueLeaves',
  'maskThenStripThenMask',
  // A local closure in `resolveParameters` masking against the INHERITED-secret
  // bag ALONE — NOT `maskSecretsForLog`'s contract, which masks the inherited
  // bag AND `context.recordedSecretValues`. It is listed because it is the RIGHT
  // masker at its three sites: they print a parent-supplied parameter value at
  // the seam where it first enters the child, before any `{Ref: <Param>}` has
  // copied it into the child's own bag, so the inherited bag is the only bag
  // that can hold the needle. Entry-wide it is WEAKER than the others, so a
  // FOURTH call site is a security decision — check that its value's needle can
  // only be in the inherited bag before adding one.
  'maskInherited',
] as const;

/** Marker tag; the parenthesised expression is matched against the bare one. */
export const EXCLUSION_TAG = 'not-in-class';

const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error']);

/** Collapse whitespace so a wrapped expression matches its one-line marker. */
function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** An expression whose own syntax proves it carries no value. */
function carriesNoValue(node: ts.Node): boolean {
  if (ts.isTypeOfExpression(node)) return true;
  if (ts.isNumericLiteral(node) || ts.isStringLiteral(node)) return true;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return true;
  if (node.kind === ts.SyntaxKind.TrueKeyword || node.kind === ts.SyntaxKind.FalseKeyword) {
    return true;
  }
  // `x.length`, `arr.length`
  if (ts.isPropertyAccessExpression(node) && node.name.text === 'length') return true;
  return false;
}

function calleeName(node: ts.CallExpression): string | undefined {
  const e = node.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
}

/** A node that OPENS a scope, so a declaration inside it is invisible outside. */
function isScopeBoundary(n: ts.Node): boolean {
  return (
    ts.isSourceFile(n) ||
    ts.isBlock(n) ||
    ts.isModuleBlock(n) ||
    ts.isCaseBlock(n) ||
    ts.isForStatement(n) ||
    ts.isForInStatement(n) ||
    ts.isForOfStatement(n) ||
    ts.isCatchClause(n) ||
    ts.isFunctionLike(n) ||
    ts.isClassLike(n)
  );
}

/** Does this binding name (possibly a destructuring pattern) bind `name`? */
function bindsName(binding: ts.BindingName, name: string): boolean {
  if (ts.isIdentifier(binding)) return binding.text === name;
  return binding.elements.some(
    (el) => !ts.isOmittedExpression(el) && bindsName(el.name, name)
  );
}

/**
 * Declarations of `name` made DIRECTLY in `scope`.
 *
 * `patterns` is the half that is easy to leave out, and leaving it out FAILS
 * OPEN: `const [s] = v` / `const { s } = v` declares `s` with no
 * `ts.isIdentifier` name, so a walk collecting only identifiers sees NOTHING,
 * climbs past the scope that really binds the use, and credits it from an
 * enclosing masked `const` of the same name. Found independently by two
 * reviewers in round 4. Inert on the subject today — 23 uses cross a
 * pattern-shadowed scope and none reaches an outer `const` — but the file holds
 * 51 pattern-declared names of which 7 already exist in BOTH forms, which is the
 * same one-rename-away argument that motivated the scope walk itself.
 */
function declaredDirectlyIn(
  scope: ts.Node,
  name: string
): { simple: ts.VariableDeclaration[]; patterns: number } {
  const simple: ts.VariableDeclaration[] = [];
  let patterns = 0;
  const visit = (n: ts.Node, depth: number): void => {
    // Never cross into a NESTED scope: what it declares is not visible here.
    if (depth > 0 && isScopeBoundary(n)) return;
    if (ts.isVariableDeclaration(n)) {
      if (ts.isIdentifier(n.name)) {
        if (n.name.text === name) simple.push(n);
      } else if (bindsName(n.name, name)) {
        patterns++;
      }
    }
    ts.forEachChild(n, (c) => visit(c, depth + 1));
  };
  visit(scope, 0);
  return { simple, patterns };
}

/**
 * Resolve an identifier USE to the initializer of the declaration that use
 * actually sees, walking outward through lexical scopes.
 *
 * THE FIRST CUT WAS SCOPE-BLIND — the first textual `VariableDeclaration` of the
 * name anywhere in the file won — and review round 4 measured three fail-open
 * shapes with that rule, each of which credits a use as masked from a
 * declaration it cannot see: a `let` reassigned after a masked initializer, a
 * PARAMETER shadowed by a foreign masked `const`, and a use in method B
 * resolving to method A's masked `const`. On the subject the first two changed
 * no verdict; the `const`-only refusal DID — it withdrew `attempt` (a `for`
 * header's `let`), which is why this round had to annotate that site. The file
 * holds 51 duplicated declaration names, so the other two are one rename away.
 *
 * Walking scopes is the fix rather than a stricter heuristic, because the
 * heuristic ("refuse a name declared more than once in the file") cannot see the
 * shadowed-parameter shape at all: there IS only one variable declaration.
 *
 * FOUR REFUSALS, each returning undefined, which the caller reads as UNMASKED —
 * the safe direction, and a finding the author answers with an explicit mask or
 * a distinct name:
 *
 *   - the nearest binding is a PARAMETER (its name may itself be a pattern):
 *     there is no initializer to judge;
 *   - the nearest binding is a DESTRUCTURING pattern: it binds the name, and its
 *     initializer describes the whole object rather than this element. This is
 *     also what covers a `catch` binding, in both spellings;
 *   - the nearest binding is not `const`: TypeScript lets a `let` be reassigned,
 *     so its initializer stops describing what the interpolation reads;
 *   - two declarations of the name in ONE scope, which cannot happen in valid
 *     TypeScript and therefore means the input is not what this walk models.
 *
 * BOUND, stated rather than claimed away: a widened SCOPE KIND is the shape that
 * would fail open next — a construct that binds a name without being in
 * {@link isScopeBoundary} lets the climb pass through it. The self-probe corpus
 * in the suite is what pins the set.
 */
function resolveBinding(node: ts.Identifier): ts.Expression | undefined {
  const name = node.text;
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (isScopeBoundary(cur)) {
      if (ts.isFunctionLike(cur)) {
        // A parameter's name may itself be a pattern (`{ a }`, `[a]`).
        for (const p of cur.parameters) {
          if (bindsName(p.name, name)) return undefined;
        }
      }
      // NO separate `catch`-binding arm, deliberately: a catch binding IS a
      // `VariableDeclaration`, so `declaredDirectlyIn` reaches it and refuses it
      // either as a pattern or — for `catch (e)` — as a declaration with no
      // initializer. An explicit arm was written first and measured fully
      // redundant (deleting it left the suite 44/44), which is the same
      // unreachable-branch class this round removed from `walk`.
      const { simple, patterns } = declaredDirectlyIn(cur, name);
      if (patterns > 0) return undefined;
      if (simple.length > 0) {
        if (simple.length > 1) return undefined;
        const decl = simple[0]!;
        if (!decl.initializer) return undefined;
        const list = decl.parent;
        if (!ts.isVariableDeclarationList(list)) return undefined;
        if ((list.flags & ts.NodeFlags.Const) === 0) return undefined;
        return decl.initializer;
      }
    }
    cur = cur.parent;
  }
  return undefined;
}

export function isMasked(node: ts.Node, src: ts.SourceFile, depth = 0): boolean {
  if (depth > 6) return false;
  if (carriesNoValue(node)) return true;

  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
    return isMasked(node.expression, src, depth + 1);
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    if (name && (MASKERS as readonly string[]).includes(name)) return true;
    // A METHOD CALL is decided ONLY on its RECEIVER: `mask(v).slice(0, 64)` is
    // the truncating-gate shape, where masking BEFORE the cut is the point.
    //
    // Its arguments are deliberately NOT consulted, and that is not a
    // simplification — routing a method call through the encoder rule below
    // credits `stripControlChars(v).slice(0, 64)`, because `0` and `64` are
    // literals and "every argument masked" is vacuously true of them. Measured:
    // that spelling is the region backstop, and it went from a finding to a pass
    // the moment the encoder rule was added.
    if (ts.isPropertyAccessExpression(node.expression)) {
      // A NAMESPACED function (`JSON.stringify`, `Object.keys`) is an encoder,
      // not a method on a value: its receiver is a global object, so judging the
      // receiver would reject `JSON.stringify(mask(v))` — the exact
      // mask-before-encode shape this PR implements. Fall through to the
      // argument rule for those.
      const recv = node.expression.expression;
      const NAMESPACES = new Set(['JSON', 'Object', 'Array', 'String', 'Number', 'Math']);
      if (!(ts.isIdentifier(recv) && NAMESPACES.has(recv.text))) {
        return isMasked(recv, src, depth + 1);
      }
    }
    // A PLAIN-FUNCTION call is an ENCODER, masked iff everything it encodes is:
    // `JSON.stringify(mask(v))`, `stringifyValue(mask(v))` — the
    // mask-BEFORE-encode rule the resolver implements. Stating it as "every
    // argument masked" is what keeps `stringifyAttributeForLog(attributeName,
    // value)`, whose arguments are both bare, a finding rather than a pass.
    //
    // "EVERY argument masked" is VACUOUSLY TRUE of an all-LITERAL argument list,
    // and that is the same hole the receiver rule above closed for method calls,
    // one shape over. Measured on the free-function form: `lookupSecret(
    // 'db-password')` was credited masked because both arguments are literals,
    // and `sourceClause(mask(v))` passes while the helper appends text it
    // CAPTURED rather than received. So the encoder rule needs a real subject —
    // at least one argument carrying a value — before "everything it encodes is
    // masked" says anything. It still cannot see captured text; what it buys is
    // that a call encoding NOTHING is no longer evidence about a value.
    const encodes = node.arguments.filter((a) => !carriesNoValue(a));
    if (encodes.length > 0) {
      return encodes.every((a) => isMasked(a, src, depth + 1));
    }
    return false;
  }
  // `mask(v).length` and friends.
  if (ts.isPropertyAccessExpression(node)) {
    return isMasked(node.expression, src, depth + 1);
  }
  // BOTH arms, or the bare arm leaks.
  if (ts.isConditionalExpression(node)) {
    return isMasked(node.whenTrue, src, depth + 1) && isMasked(node.whenFalse, src, depth + 1);
  }
  // Every non-literal operand of a `+` chain. Also the shape a message built
  // WITHOUT any `${}` takes.
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return isMasked(node.left, src, depth + 1) && isMasked(node.right, src, depth + 1);
  }
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.every((s) => isMasked(s.expression, src, depth + 1));
  }
  // A NAME is not evidence — judge the binding it resolves to.
  if (ts.isIdentifier(node)) {
    const init = resolveBinding(node);
    return init ? isMasked(init, src, depth + 1) : false;
  }
  return false;
}

/** Every value-bearing sub-expression of a message argument. */
function valueOperands(node: ts.Node, out: ts.Node[] = []): ts.Node[] {
  if (ts.isTemplateExpression(node)) {
    for (const span of node.templateSpans) out.push(span.expression);
    return out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    valueOperands(node.left, out);
    valueOperands(node.right, out);
    return out;
  }
  if (ts.isParenthesizedExpression(node)) return valueOperands(node.expression, out);
  if (carriesNoValue(node)) return out;
  // A bare identifier / call argument: a message assembled elsewhere.
  out.push(node);
  return out;
}

export interface Finding {
  readonly line: number;
  readonly kind: 'throw' | 'log';
  readonly expr: string;
  readonly reason: 'unmasked-unannotated';
}

export interface Site {
  readonly line: number;
  readonly kind: 'throw' | 'log';
  readonly bare: readonly string[];
  readonly annotated: readonly string[];
}

/**
 * What the walk must find on the real subject, BANDED from both sides.
 *
 * A one-sided floor cannot see a walk that stopped SHORT, and this checker had
 * exactly that hole: a `/*` inserted mid-file opens a comment that closes on the
 * next `*\/` — no parse error, no diagnostic, just statements that quietly stop
 * existing. Measured 2026-09-10, four such injections removed 3 to 5 statements
 * and 3 to 10 masked expressions each, and the slack under the old floors
 * covered all of them.
 *
 * The bands are TIGHT on purpose (measured 131 / 155 / 98). Changing the
 * population of throw/log sites in this file is a decision, and a band that
 * makes it a decision is the point; widen the number in the same commit that
 * widens the population.
 */
export const BANDS = {
  statements: { min: 128, max: 165 },
  maskedExprs: { min: 150, max: 200 },
  markers: { min: 90, max: 140 },
} as const;

/** A `not-in-class(<expr>)` note the file carries but no site ever read. */
export interface UnconsumedMarker {
  readonly line: number;
  readonly expr: string;
}

interface ScanResult {
  readonly sites: Site[];
  readonly findings: Finding[];
  readonly statements: number;
  readonly maskedExprs: number;
  readonly markers: number;
  readonly unconsumedMarkers: UnconsumedMarker[];
}

/**
 * Every `not-in-class(<expr>)` note in `body`, paren-BALANCED.
 *
 * Balanced rather than `[^)]*`: the annotated expression routinely contains a
 * call — `results.join(', ')`, `JSON.stringify(raw).slice(0, 80)` — and a
 * non-greedy class truncates at the inner `)`, so the marker never matched the
 * finding and the site read as unannotated forever.
 */
function markersIn(body: string, offset = 0): { expr: string; pos: number }[] {
  const out: { expr: string; pos: number }[] = [];
  let i = body.indexOf(`${EXCLUSION_TAG}(`);
  while (i !== -1) {
    let depth = 0;
    let j = i + EXCLUSION_TAG.length;
    const start = j + 1;
    for (; j < body.length; j++) {
      if (body[j] === '(') depth++;
      else if (body[j] === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth === 0) out.push({ expr: norm(body.slice(start, j)), pos: offset + i });
    i = body.indexOf(`${EXCLUSION_TAG}(`, j + 1);
  }
  return out;
}

export function scan(source?: string, fileName = SUBJECT): ScanResult {
  const text = source ?? readFileSync(fileName, 'utf8');
  const src = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  // A file with parse errors yields a PARTIAL tree: statements vanish, every
  // count stays plausible, and the run exits 0 over a subject nobody read. Every
  // sibling critic under `scripts/` refuses one; measured here, inserting a `/*`
  // mid-file removed five throw/log statements with every floor still satisfied.
  const diagnostics =
    (src as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (diagnostics.length > 0) {
    const first = diagnostics[0];
    const where =
      first && typeof first.start === 'number'
        ? `:${src.getLineAndCharacterOfPosition(first.start).line + 1}`
        : '';
    throw new Error(
      `${fileName}${where}: ${diagnostics.length} parse diagnostic(s) — refusing to report ` +
        `coverage over a partial tree. First: ${ts.flattenDiagnosticMessageText(first?.messageText, ' ')}`
    );
  }
  const full = src.getFullText();

  const sites: Site[] = [];
  const findings: Finding[] = [];
  let statements = 0;
  let maskedExprs = 0;

  // Every marker the FILE carries, by position, so one that no site ever reads
  // can be reported instead of sitting there looking like coverage.
  //
  // Scanned over the raw TEXT, so a `not-in-class(` inside a STRING LITERAL
  // would count as a marker. That direction is safe — a phantom marker can only
  // be reported STALE, never silence a finding, because `markersFor` reads
  // comment ranges and would never hand this one to a site — and all 98 are in
  // comments today.
  const allMarkers = new Map<number, { expr: string; line: number }>();
  for (const m of markersIn(full)) {
    allMarkers.set(m.pos, {
      expr: m.expr,
      line: src.getLineAndCharacterOfPosition(m.pos).line + 1,
    });
  }
  // A marker counts as CONSUMED only when it MATCHED a bare expression at a site
  // that read it. Being read is not enough: a marker on a site whose expressions
  // are all masked, or naming a spelling the walk reports differently, silences
  // nothing and is exactly the stale note this reports.
  const consumed = new Set<number>();

  /**
   * Markers in the comments attached to `node` (AST-attached: no line math).
   *
   * Also consults the immediately enclosing STATEMENT. A `return new
   * SomeError(...)` or a throw inside a `catch` carries its comment on the
   * statement, not on the expression the walk reports, so looking only at the
   * node left five real annotations unseen.
   *
   * The climb is BOUNDED, and the bound is the point (review round 4). Walking
   * to the first `ts.isStatement` ancestor with no bound is not "the enclosing
   * statement": a method BODY is a function block, which `ts.isStatement`
   * rejects, so a `throw` sitting directly in a method body climbed past the
   * body and the method to the CLASS DECLARATION — where one `not-in-class(v)`
   * in the class JSDoc silenced every such site in the class, while a marker
   * written in the METHOD's own JSDoc was read by nothing. Both measured. So the
   * climb stops at the first function, class, block or file boundary and credits
   * nothing beyond it.
   */
  const markersFor = (node: ts.Node): { expr: string; pos: number }[] => {
    const carriers: ts.Node[] = [node];
    let p: ts.Node | undefined = node.parent;
    while (p) {
      if (
        ts.isSourceFile(p) ||
        ts.isBlock(p) ||
        ts.isModuleBlock(p) ||
        ts.isFunctionLike(p) ||
        ts.isClassLike(p)
      ) {
        break;
      }
      if (ts.isStatement(p)) {
        carriers.push(p);
        break;
      }
      p = p.parent;
    }
    const out: { expr: string; pos: number }[] = [];
    for (const c of carriers) {
      for (const r of ts.getLeadingCommentRanges(full, c.getFullStart()) ?? []) {
        out.push(...markersIn(full.slice(r.pos, r.end), r.pos));
      }
    }
    return out;
  };

  const record = (
    kind: Site['kind'],
    messageArgs: readonly ts.Node[],
    statementNode: ts.Node
  ): void => {
    statements++;
    const operands = messageArgs.flatMap((a) => valueOperands(a));
    const bare: string[] = [];
    for (const op of operands) {
      if (isMasked(op, src)) {
        maskedExprs++;
        continue;
      }
      bare.push(norm(op.getText(src)));
    }
    if (bare.length === 0) return;

    const markers = markersFor(statementNode);
    for (const m of markers) if (bare.includes(m.expr)) consumed.add(m.pos);
    const names = markers.map((m) => m.expr);
    const line = src.getLineAndCharacterOfPosition(statementNode.getStart(src)).line + 1;
    const unannotated = bare.filter((b) => !names.includes(b));
    sites.push({ line, kind, bare, annotated: names });
    for (const expr of unannotated) {
      findings.push({ line, kind, expr, reason: 'unmasked-unannotated' });
    }
  };

  const walk = (node: ts.Node): void => {
    if (ts.isThrowStatement(node) && node.expression) {
      // The message is the first argument of the constructed error, however many
      // wrappers (`markNonRetryable(new X(...))`) sit around it.
      const errs: ts.NewExpression[] = [];
      const findNew = (n: ts.Node): void => {
        if (ts.isNewExpression(n)) errs.push(n);
        ts.forEachChild(n, findNew);
      };
      findNew(node.expression);
      for (const e of errs) {
        const arg = e.arguments?.[0];
        if (arg) record('throw', [arg], node);
      }
      // A throw that CONSTRUCTS nothing is a RE-THROW (`throw error;`,
      // `throw markNonRetryable(error);`) and is deliberately out of the
      // population: it composes no message, and the error it propagates was
      // masked at its OWN construction site — which is the site this checker
      // already governs. Recording it demanded an annotation on a statement with
      // no interpolation in it, which is a note nobody can write truthfully.
    } else if (ts.isCallExpression(node)) {
      const e = node.expression;
      if (
        ts.isPropertyAccessExpression(e) &&
        LOG_METHODS.has(e.name.text) &&
        /(^|\.)logger$/.test(e.expression.getText(src))
      ) {
        // EVERY argument, not just the message. `Logger.debug(message,
        // ...args)` renders the extra arguments too (`src/utils/logger.ts`), so
        // a value moved out of the template and into a second argument would
        // print unwatched. ZERO such sites exist in the subject today, which is
        // what makes the widening free — and what makes it worth doing now,
        // since the first one to appear would arrive uncounted.
        if (node.arguments.length > 0) record('log', node.arguments, node.parent ?? node);
      }
      // A builder that CONSTRUCTS an error without throwing it (issue #2827
      // round 3: `buildUnknownIntrinsicError` was neither annotated nor even
      // scanned, because nothing threw at its site) is handled by the
      // `isNewExpression` arm below — a `new` node is never also a
      // `CallExpression`, so there is nothing to do in this branch.
    } else if (ts.isNewExpression(node) && /Error$/.test(node.expression.getText(src))) {
      // Only when not already covered by an enclosing throw.
      let p: ts.Node | undefined = node.parent;
      let inThrow = false;
      while (p) {
        if (ts.isThrowStatement(p)) {
          inThrow = true;
          break;
        }
        p = p.parent;
      }
      if (!inThrow) {
        const arg = node.arguments?.[0];
        if (arg) record('throw', [arg], node);
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(src);

  const unconsumedMarkers: UnconsumedMarker[] = [];
  for (const [pos, m] of allMarkers) {
    if (!consumed.has(pos)) unconsumedMarkers.push({ line: m.line, expr: m.expr });
  }
  unconsumedMarkers.sort((a, b) => a.line - b.line);

  return {
    sites,
    findings,
    statements,
    maskedExprs,
    markers: allMarkers.size,
    unconsumedMarkers,
  };
}

export function findings(result: ScanResult = scan()): Finding[] {
  return result.findings;
}

/** Which {@link BANDS} the run fell outside of, one line each. */
export function bandViolations(result: ScanResult): string[] {
  const out: string[] = [];
  for (const [key, band] of Object.entries(BANDS)) {
    const got = result[key as keyof typeof BANDS];
    if (got < band.min || got > band.max) {
      out.push(`${key}: ${got} is outside the measured band ${band.min}..${band.max}`);
    }
  }
  return out;
}

if (process.argv[1]?.endsWith('check-resolver-mask-coverage.ts')) {
  const result = scan();
  for (const f of result.findings) {
    console.error(
      `${SUBJECT}:${f.line} [${f.kind}] unmasked and unannotated: \${${f.expr}}\n` +
        `    add: // ${EXCLUSION_TAG}(${f.expr}): <why this carries no resolved value>`
    );
  }
  for (const m of result.unconsumedMarkers) {
    console.error(
      `${SUBJECT}:${m.line} STALE ${EXCLUSION_TAG}(${m.expr}) — no site the marker reaches ` +
        `reports that expression as bare.\n` +
        `    the value is masked now, the spelling moved, or the note sits on the wrong statement — delete it or move it.`
    );
  }
  const bands = bandViolations(result);
  for (const b of bands) {
    console.error(
      `POPULATION ${b}\n` +
        `    the walk found a different number of sites than it was calibrated on — widen the band ` +
        `in the same commit that widened the population, or find what stopped being scanned.`
    );
  }
  console.error(
    `\n${result.statements} throw/log statement(s); ${result.maskedExprs} masked expression(s); ` +
      `${result.sites.length} site(s) with a bare expression; ${result.findings.length} unannotated; ` +
      `${result.markers} marker(s), ${result.unconsumedMarkers.length} stale.`
  );
  process.exit(
    result.findings.length === 0 && result.unconsumedMarkers.length === 0 && bands.length === 0
      ? 0
      : 1
  );
}
