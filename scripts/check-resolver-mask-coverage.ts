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
 * Functions a render may reach: they mask by VALUE **and** sanitize for a
 * terminal.
 *
 * Deliberately short, and adding to it is a security decision: everything here
 * is trusted to render a secret unreadable. `stringifyAttributeForLog` and
 * `stringifyParameterForLog` are NOT here — they are encoders that redact on a
 * NAME, so they must themselves sit inside a masker.
 *
 * ## The second property, and why it lives in THIS list
 *
 * Until go-to-k/cdkd#3426 the list meant "masks" alone, and two entries —
 * `maskSecretsForLog` and `maskThenStripThenMask` — answered only the SECRET
 * question. A render reaching one of them was certified here while carrying
 * whatever `ESC` / CR / `U+2028` a template-supplied name put in it, which is
 * how ten `const logged* = this.maskSecretsForLog(...)` bindings came to render
 * a live terminal-rewriting sequence on the DEFAULT `Fn::ImportValue` path.
 *
 * Patching that at the ten render sites would have been the fifth round of one
 * enumeration (go-to-k/cdkd#3408 ran four). What ended it is that this list now
 * carries BOTH properties, so the walk below — which already resolves an
 * interpolated IDENTIFIER to its declaration and judges the initializer —
 * answers the control-character question by the same mechanism, at the binding
 * as well as at the render. The resolver deleted `maskSecretsForLog` in that
 * change: its escaping call sites now call `displayMasked`, and the bare masker
 * (`maskSecretsRaw`) plus `maskThenStripThenMask` are reachable only from
 * inside the builder.
 *
 * So the rule for a new entry is TWO questions, not one: does it render a
 * secret unreadable, and is its result safe to put on a terminal?
 */
export const MASKERS = [
  'maskValueLeaves',
  // A local closure in `resolveParameters` masking against the INHERITED-secret
  // bag ALONE — NOT `displayMasked`'s contract, which masks the inherited bag
  // AND `context.recordedSecretValues`. It is listed because it is the RIGHT
  // masker at its three sites: they print a parent-supplied parameter value at
  // the seam where it first enters the child, before any `{Ref: <Param>}` has
  // copied it into the child's own bag, so the inherited bag is the only bag
  // that can hold the needle. Entry-wide it is WEAKER than the others about
  // BAGS, so a FOURTH call site is a security decision — check that its value's
  // needle can only be in the inherited bag before adding one. It satisfies the
  // list's second property in its own body (mask, strip, mask, `displaySafe`),
  // since go-to-k/cdkd#3426.
  'maskInherited',
  // The DISPLAY builder (go-to-k/cdkd#3408). `displaySafe(maskThenStripThenMask(v))`
  // — so every path through it passes the needle-and-twin mask, twice, which
  // makes it strictly stronger than the bare masker it replaced at 84 sites and
  // unable to be weaker at any input. Listing it is a security decision under
  // this list's own rule, and it is the one that lets the sibling scanner
  // (`tests/unit/deployment/resolver-display-masked-population.test.ts`) demand
  // it INSTEAD of a bare masker at every interpolation: without the entry here,
  // routing a render through it would trade a strip-coverage failure for a
  // mask-coverage one.
  //
  // Since go-to-k/cdkd#3426 the resolver has no OTHER exit from the masking
  // machinery: `maskSecretsRaw` and `maskThenStripThenMask` were dropped from
  // this list AND confined to this builder's own composition, so a binding of
  // either is a finding wherever it is interpolated. `maskThenStripThenMask` in
  // particular reads like the whole answer while omitting `displaySafe`, and
  // therefore `U+2028` / `U+2029` and the bidi overrides.
  'displayMasked',
  // The LOG-TWIN display route (go-to-k/cdkd#3408). `displayMasked(logTextOfLeaf(v))`
  // — so it is `displayMasked` plus a twin resolution, and inherits that
  // entry's justification unchanged. Listed for the same reason: without it,
  // routing the four `origin` builders through it would trade a strip-coverage
  // failure for a mask-coverage one.
  'displayLeaf',
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
        // THE RECEIVER **AND** EVERY VALUE-BEARING ARGUMENT, since
        // go-to-k/cdkd#3426 review round 3. The receiver-only rule credited
        // `displayMasked(v, ctx).replace('@', this.logTextOfLeaf(v, ctx))` as
        // masked and reported NOTHING — not even the weaker verdict — because
        // the argument was invisible to both walks at once. Measured on the
        // real subject: adding the argument test leaves 137 / 172 / 0 findings
        // / 0 stale byte-identical, and flips that shape to a finding. The
        // subject already writes `this.displayMasked(physicalId,
        // context).slice(0, 64)` at three sites, so the hole was one argument
        // away from live code.
        //
        // Deliberately NOT applied to `reachesRawMasker`'s twin arm: that is
        // where round 1's two measured false positives came from
        // (`describeAvailableOutputs(Object.keys(cfnOutputs), context)` and a
        // masker passed as a CALLBACK). Here the direction is opposite — a
        // bare argument makes the call LESS masked, never more — so the
        // asymmetry is the point rather than an oversight.
        const valueArgs = node.arguments.filter((a) => !carriesNoValue(a));
        return (
          isMasked(recv, src, depth + 1) && valueArgs.every((a) => isMasked(a, src, depth + 1))
        );
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

/**
 * Does this expression REACH a {@link RAW_MASKERS} function — directly, or
 * through a local binding?
 *
 * The mirror image of {@link isMasked}, and deliberately its DUAL rather than
 * its negation: `isMasked` asks "is every path covered", so it takes the AND of
 * a conditional's arms, while this asks "does any path touch the raw
 * machinery", so it takes the OR. One raw arm of a ternary is a raw render.
 *
 * It stops at a {@link MASKERS} call: a raw masker INSIDE the builder
 * (`displayMasked(logTextOfLeaf(v))` — which is what `displayLeaf` is) is the
 * sanctioned composition, not a finding. That is the whole reason this is a
 * separate walk rather than a name grep: the offending shape is the raw masker
 * ESCAPING the builder, and only a walk that knows where the builder sits can
 * tell the two apart.
 *
 * Identifier resolution is its OWN (`taintSourcesOf`) rather than `isMasked`'s,
 * which is what makes the BINDING shape visible: `const x = this.maskSecretsRaw(v)`
 * followed by `${x}` sixty lines later is one hop from the render, and that hop
 * is why go-to-k/cdkd#3426 needed no second scanner. The two resolvers differ
 * on purpose and in OPPOSITE directions — `isMasked` refuses a `let` because a
 * reassignment makes the initializer stop describing what is read, while a
 * reassignable binding is MORE suspicious here, not less (see
 * {@link taintSourcesOf}).
 *
 * ## WHAT THIS DOES NOT REACH, and why the arms that would were WITHDRAWN
 *
 * The shapes below are NOT followed: a value carried through a callback
 * (`.map(cb)`), an object or array literal, a spread, an `await`, a `new`, or a
 * binding chain deeper than the cap. A render reaching a masking answer that
 * way is reported as `unmasked-unannotated` — still a finding, but one an
 * exclusion marker can silence.
 *
 * Arms for all of those were written (go-to-k/cdkd#3426 review round 1) and
 * withdrawn one round later, because every axis of round 2 found a defect
 * INSIDE them: an unmemoized exponential at the raised depth cap (48.8 s on one
 * real expression, verdict `false` at every cap), `filter` / `find` / `sort`
 * credited as carriers when their callback's value does not build the result,
 * a nested-function guard that missed `function` declarations, an object
 * literal tainting a read of an unrelated SIBLING key, and a taint resolver
 * that was fail-open on `+=` while over-reporting through a shadowed name.
 * Two of them reported FALSE POSITIVES on the real subject.
 *
 * `.claude/skills/work-issues/references/verify.md` §8-h names that shape:
 * blockers CONCENTRATING in one added part mean WITHDRAW the addition rather
 * than bound it. So the walk is back to the shape that drew no findings, and
 * the coverage the arms were meant to add is provided by cheaper mechanisms
 * that have no dataflow model to get wrong:
 *
 *  - the CONTAINMENT fence in
 *    `tests/unit/deployment/resolver-display-masked-population.test.ts`, which
 *    asserts from the AST that `maskSecretsRaw` is referenced only inside
 *    `maskThenStripThenMask` and that helper only inside `displayMasked` —
 *    exact reference counts, no inference;
 *  - that same file's line rules, which forbid interpolating the raw maskers
 *    directly, whatever the enclosing expression;
 *  - and the behavioural suites, which read the emitted BYTES.
 *
 * Widening this walk again means answering round 2's nine findings first. It is
 * not the cheapest place to buy coverage.
 */
export function reachesRawMasker(node: ts.Node, src: ts.SourceFile, depth = 0): boolean {
  // SIX, the same bound `isMasked` uses, and go-to-k/cdkd#3426's review round 2
  // is why it is not higher. Raised to 24 to follow longer binding chains, it
  // became an unmemoized exponential over a genuine cycle (`let result` plus
  // its own reassignments re-expand per hop): MEASURED on one real expression
  // in this subject at 5 ms / 214 ms / 1.9 s / 48.8 s for caps 6 / 14 / 18 / 24,
  // with the verdict `false` at every one of them. A CI gate that can take a
  // minute on a shape nobody notices adding is worse than a shallower walk.
  if (depth > 6) return false;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return reachesRawMasker(node.expression, src, depth + 1);
  }
  if (ts.isCallExpression(node)) {
    const name = calleeName(node);
    // The builder ENDS the walk in both directions: reaching it is safe, and
    // whatever it wraps is its business.
    if (name && (MASKERS as readonly string[]).includes(name)) return false;
    if (name && (RAW_MASKERS as readonly string[]).includes(name)) return true;
    if (ts.isPropertyAccessExpression(node.expression)) {
      const recv = node.expression.expression;
      // The SAME set `isMasked` uses. Keeping the two literal copies in step is
      // a known cost; diverging them is worse, because a value `isMasked`
      // credits and this walk does not (or the reverse) makes the two verdicts
      // disagree about one expression.
      const NAMESPACES = new Set(['JSON', 'Object', 'Array', 'String', 'Number', 'Math']);
      if (!(ts.isIdentifier(recv) && NAMESPACES.has(recv.text))) {
        // A METHOD CALL is decided on its RECEIVER ALONE — the same split
        // `isMasked` makes, for the same reason, and the arguments are
        // deliberately NOT consulted. "Any tainted argument taints the result"
        // was the first cut and it reported TWO false positives on the real
        // subject the moment the walk got stronger: `describeAvailableOutputs(
        // Object.keys(cfnOutputs), context)`, where the taint arrived through
        // `cfnOutputs`' own lookup call and the RESULT is re-masked per key,
        // and `resolveSSMReference(parts, true, 'ssm-secure', context,
        // nameLogText)`, where a raw masker is passed as a CALLBACK and the
        // result is a parameter record. A fence that reds on correct code is
        // one the next author deletes.
        //
        // What carries the weight instead is the two lists naming every
        // masking answer this file returns — so a method whose result is one
        // is caught by NAME rather than by dataflow. That is a CLAIM, not a
        // fenced invariant, and go-to-k/cdkd#3426's review round 2 falsified
        // the first version of it: `logTwinOfProduct` and
        // `resolveDynamicReferencesWithLogTwin` both returned masked,
        // unstripped text from neither list. They are listed now. The residual
        // is a FUTURE method that does the same; `RAW_MASKERS`' own doc says
        // what to check when adding one.
        return reachesRawMasker(recv, src, depth + 1);
      }
    }
    // A NAMESPACED or FREE function call IS an encoder — `JSON.stringify(x)`,
    // `displayAwsMessage(x)`, `stringifyValue(x)` all carry their input out —
    // so a tainted argument taints the result.
    return node.arguments.some((a) => reachesRawMasker(a, src, depth + 1));
  }
  if (ts.isPropertyAccessExpression(node)) {
    return reachesRawMasker(node.expression, src, depth + 1);
  }
  if (ts.isConditionalExpression(node)) {
    return (
      reachesRawMasker(node.whenTrue, src, depth + 1) ||
      reachesRawMasker(node.whenFalse, src, depth + 1)
    );
  }
  if (ts.isBinaryExpression(node)) {
    return (
      reachesRawMasker(node.left, src, depth + 1) || reachesRawMasker(node.right, src, depth + 1)
    );
  }
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.some((s) => reachesRawMasker(s.expression, src, depth + 1));
  }
  if (ts.isIdentifier(node)) {
    return taintSourcesOf(node).some((e) => reachesRawMasker(e, src, depth + 1));
  }
  return false;
}

/**
 * Every expression a local binding can hold, for the TAINT walk only.
 *
 * Deliberately NOT {@link resolveBinding}, and the difference is one word in
 * each direction. `resolveBinding` answers "what does this name definitely
 * hold", so a `let` is a REFUSAL there — a reassignment makes the initializer
 * stop describing what the interpolation reads, and crediting it would be a
 * fail-OPEN for the masked verdict. This walk asks "can this name hold
 * something raw", where a reassignable binding is MORE suspicious, not less:
 * refusing it is the fail-open. `intrinsic-function-resolver.ts` has such a
 * binding today (`let loggedRegionText = this.logTextOfLeaf(region, context)`),
 * and with the `const`-only resolver a bare render of it reported the weaker,
 * SILENCEABLE verdict — measured during go-to-k/cdkd#3426's review.
 *
 * So this returns the declaration's initializer AND every assignment to the
 * name inside the enclosing function: a name is tainted if ANY of them reaches
 * the raw machinery, which is the union a reader of the render has to worry
 * about.
 *
 * BOUNDS, stated rather than implied away. A PARAMETER and a DESTRUCTURING
 * pattern both return nothing, so a raw value arriving that way is invisible to
 * this verdict — it is still covered by the `unmasked-unannotated` one unless
 * someone annotates it. Neither shape carries a masker result in the subject
 * today, and the RUNTIME fence
 * (`tests/unit/deployment/importvalue-binding-control-chars.test.ts`) is what
 * covers the value-flow question a syntactic walk cannot close.
 */
function taintSourcesOf(node: ts.Identifier): ts.Expression[] {
  const name = node.text;
  const out: ts.Expression[] = [];
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (isScopeBoundary(cur)) {
      if (ts.isFunctionLike(cur)) {
        for (const p of cur.parameters) {
          // A parameter shadows anything outer; there is no initializer to
          // judge, so stop rather than credit an outer binding of the name.
          if (bindsName(p.name, name)) return out;
        }
      }
      const { simple, patterns } = declaredDirectlyIn(cur, name);
      if (patterns > 0) return out;
      if (simple.length > 0) {
        for (const decl of simple) if (decl.initializer) out.push(decl.initializer);
        // Every REASSIGNMENT in the scope that declares the name, so a `let`
        // written once and overwritten later is judged on both values.
        //
        // `+=` counts, and that is a MEASURED fix rather than completeness for
        // its own sake: `let t = ''; t += this.maskSecretsRaw(v)` is how a
        // masker result reaches a render by string building, and matching only
        // `=` reported it untainted (go-to-k/cdkd#3426 review round 2).
        const ASSIGNMENT_KINDS = new Set<ts.SyntaxKind>([
          ts.SyntaxKind.EqualsToken,
          ts.SyntaxKind.PlusEqualsToken,
        ]);
        const scopeOfDeclaration = cur;
        const collectAssignments = (n: ts.Node): void => {
          // Do NOT descend into a nested scope that REDECLARES the name: its
          // `x = raw(v)` writes a different binding, and crediting it here
          // tainted an outer `x` that never held the value (measured, same
          // round).
          if (n !== scopeOfDeclaration && isScopeBoundary(n)) {
            const inner = declaredDirectlyIn(n, name);
            if (inner.simple.length > 0 || inner.patterns > 0) return;
            if (ts.isFunctionLike(n) && n.parameters.some((p) => bindsName(p.name, name))) return;
          }
          if (
            ts.isBinaryExpression(n) &&
            ASSIGNMENT_KINDS.has(n.operatorToken.kind) &&
            ts.isIdentifier(n.left) &&
            n.left.text === name
          ) {
            out.push(n.right);
          }
          ts.forEachChild(n, collectAssignments);
        };
        collectAssignments(scopeOfDeclaration);
        return out;
      }
    }
    cur = cur.parent;
  }
  return out;
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

/**
 * Functions that return a MASKING ANSWER and nothing more — masked text that is
 * NOT safe to put on a terminal (go-to-k/cdkd#3426).
 *
 * The distinction {@link MASKERS} now carries needs a name for the other side,
 * because the two failures read identically at a render site and have opposite
 * remedies. A value that reached one of these has already had its secrets
 * removed; what it has NOT had is the control-character strip, so the fix is
 * never an exclusion marker (the marker answers "this carries no resolved
 * value", which is false here by construction) but the display builder.
 *
 * `maskSecretsInText` is the module-level masker in `secret-redaction.ts`, on
 * the list for the same reason — `maskInherited` composes it into a sanitizing
 * closure, and anything else reaching it directly is a raw render.
 *
 * ## It is the COMPLEMENT of {@link MASKERS}, and that is a checkable claim
 *
 * go-to-k/cdkd#3426's review measured the first cut billing itself as a
 * complement while five masked-but-unsanitized answers sat on NEITHER list, so
 * a render reaching one of them took the weaker, SILENCEABLE verdict. They are
 * here now. What that claim means precisely: every private method of
 * `IntrinsicFunctionResolver` that RETURNS masked text (or a collection or
 * closure of it) is on one of the two lists.
 *
 * Deliberately on NEITHER, because they return something else, and listed so
 * the next audit compares against a decision rather than re-deriving one:
 * `describeAvailableOutputs`, `subPlaceholderWarning` and
 * `describeFailureObserved` COMPOSE a sentence whose every operand already
 * went through the builder; `positionalNameMask` returns a TRANSFORM; and
 * `logTwinBag` returns the bag itself.
 *
 * `splitLogTwins` returns an ARRAY and `dynamicReferenceNameLogText` returns a
 * CLOSURE — neither is a string. They are listed anyway, on the DIRECT-call
 * justification that covers every other entry: a render naming one of them, or
 * a local binding taking its result, is caught. What is NOT caught is the value
 * carried out of them by a callback or an element read — the arms that followed
 * those were withdrawn (see {@link reachesRawMasker}), so the list's coverage
 * here is the call, not the carry.
 */
export const RAW_MASKERS = [
  'maskSecretsRaw',
  'maskNeedlesForLog',
  'maskThenStripThenMask',
  'registeredLogTwin',
  'logTextOfLeaf',
  'logTwinText',
  'nameLogText',
  'outputNameLogText',
  'maskSecretsInText',
  // The five go-to-k/cdkd#3426's review found on neither list. Each returns a
  // twin (or `SECRET_MASK`) with no strip: `regionLogText` and
  // `straddleSafeTwin` a string, `productLogTwin` a string joined from a
  // product's twins, `splitLogTwins` an array of them, and
  // `dynamicReferenceNameLogText` a closure returning one.
  'regionLogText',
  'straddleSafeTwin',
  'productLogTwin',
  'splitLogTwins',
  'dynamicReferenceNameLogText',
  // Round 2 found two more, both returning an OBJECT whose `.twin` member is
  // the masking answer: `logTwinOfProduct` (which `productLogTwin` is a
  // one-line wrapper around, so the pair sat on opposite sides of the list)
  // and `resolveDynamicReferencesWithLogTwin`. Neither has a live raw render
  // today — both twins reach `logTwinText` and then the builder — but a render
  // of `.twin` took the silenceable verdict, measured.
  'logTwinOfProduct',
  'resolveDynamicReferencesWithLogTwin',
] as const;

export interface Finding {
  readonly line: number;
  readonly kind: 'throw' | 'log';
  readonly expr: string;
  /**
   * `raw-masker-render` is the STRONGER verdict and is NOT annotatable: the
   * expression reached the masking machinery, so it is by definition a value
   * that can carry a resolved secret, and an exclusion marker claiming
   * otherwise is false. `unmasked-unannotated` is the original verdict —
   * nothing masked this and nobody wrote down why.
   */
  readonly reason: 'unmasked-unannotated' | 'raw-masker-render';
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
 * The bands are TIGHT on purpose (measured 131 / 155 / 98 on 2026-09-10; 132 /
 * 155 / 100 after issue #2814's drain warning). Changing the
 * population of throw/log sites in this file is a decision, and a band that
 * makes it a decision is the point; widen the number in the same commit that
 * widens the population.
 */
export const BANDS = {
  // Floors moved with the population by the same delta (issue #3096's review
  // rounds added three throw sites, five masks and eight notes: 132 / 155 /
  // 100 -> 135 / 160 / 108). A floor left behind goes inert on the block-comment
  // injection above: the `resolveFindInMap` cut swallows seven statements, and
  // 135 - 7 = 128 sat EXACTLY on the old floor, so the band no longer fired
  // (measured by `resolver-mask-coverage.test.ts`'s instrument case). Issue
  // #3150 added six masks (161 -> 167) and moved the masks floor by the same
  // delta: the same cut left 157 masked expressions, above the old floor of 155.
  // go-to-k/cdkd#3426 RAISED the statements floor from 131 to 133, and the
  // reason is the injection above rather than the population (still 137). That
  // change rewrote several doc comments between `resolveFindInMap` and
  // `displayMasked`, which moved the first `*` + `/` AFTER the injection point
  // EARLIER — so the same cut now swallows 5 statements instead of 7, landing
  // on 132 and clearing a floor of 131. A floor calibrated against a cut whose
  // reach depends on comment layout goes inert whenever the comments move,
  // which is why `resolver-display-masked-population.test.ts` asserts no stray
  // opener exists at all and why this one is re-measured per change.
  statements: { min: 133, max: 165 },
  maskedExprs: { min: 161, max: 200 },
  markers: { min: 98, max: 140 },
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
    // The RAW-MASKER verdict is taken over EVERY operand, masked ones included,
    // and that is the point (go-to-k/cdkd#3426): a value can be masked — so
    // `isMasked` credits it and it never reaches `bare` — while still carrying
    // the `ESC` / CR the mask makes no claim about. Judging only the bare
    // operands would reproduce the hole this verdict exists to close, since the
    // ten binding sites were all MASKED.
    const rawRenders: string[] = [];
    for (const op of operands) {
      if (reachesRawMasker(op, src)) rawRenders.push(norm(op.getText(src)));
      if (isMasked(op, src)) {
        maskedExprs++;
        continue;
      }
      bare.push(norm(op.getText(src)));
    }
    const line = src.getLineAndCharacterOfPosition(statementNode.getStart(src)).line + 1;
    // Reported whether or not the site carries a marker: an exclusion says "this
    // value carries no resolved secret", which cannot be true of a value that
    // went through the masking machinery, so the marker is not an answer here.
    for (const expr of rawRenders) {
      findings.push({ line, kind, expr, reason: 'raw-masker-render' });
    }
    if (bare.length === 0) return;

    const markers = markersFor(statementNode);
    for (const m of markers) if (bare.includes(m.expr)) consumed.add(m.pos);
    const names = markers.map((m) => m.expr);
    const unannotated = bare.filter((b) => !names.includes(b));
    sites.push({ line, kind, bare, annotated: names });
    for (const expr of unannotated) {
      // Not reported TWICE: a raw render already has its own, more specific
      // finding with the remedy that actually applies.
      if (rawRenders.includes(expr)) continue;
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
    if (f.reason === 'raw-masker-render') {
      console.error(
        `${SUBJECT}:${f.line} [${f.kind}] renders a BARE MASKER result: \${${f.expr}}\n` +
          `    that value is masked but NOT control-stripped, so a template-supplied name can carry\n` +
          `    ESC / CR / U+2028 into this line and redraw the reader's terminal (go-to-k/cdkd#3426).\n` +
          `    render through this.displayMasked(value, context) -- or this.displayLeaf(value, context)\n` +
          `    for a log-twin leaf. An ${EXCLUSION_TAG} marker does NOT answer this: the value reached\n` +
          `    the masking machinery, so it is exactly the kind that can carry a resolved secret.`
      );
      continue;
    }
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
  const rawRenders = result.findings.filter((f) => f.reason === 'raw-masker-render').length;
  console.error(
    `\n${result.statements} throw/log statement(s); ${result.maskedExprs} masked expression(s); ` +
      `${result.sites.length} site(s) with a bare expression; ` +
      `${result.findings.length - rawRenders} unannotated; ${rawRenders} bare-masker render(s); ` +
      `${result.markers} marker(s), ${result.unconsumedMarkers.length} stale.`
  );
  process.exit(
    result.findings.length === 0 && result.unconsumedMarkers.length === 0 && bands.length === 0
      ? 0
      : 1
  );
}
