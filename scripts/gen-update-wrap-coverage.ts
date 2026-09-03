/**
 * Codegen + CI critic: SDK-provider `update()` error-wrapping coverage matrix.
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Every SDK provider is expected to surface an AWS SDK failure as a
 * {@link ProvisioningError} so it carries cdkd's typed error formatting and
 * exit-code handling. `create()` and `delete()` have followed that convention
 * from the start, but `update()` drifted: the wrap is easy to forget because
 * an unwrapped update still "works" on the happy path and only diverges when
 * AWS rejects the call.
 *
 * That defect has now been found TWICE by review and NEVER by a test:
 *   - #1263 -> PR #1265 (`LambdaUrlProvider`)
 *   - #1267 -> PR #1268 (EventBridge bus, SNS topic, Lambda event-source, Logs
 *     log-group)
 * Both were incidental findings while reviewing something else. This critic
 * makes the class non-regressing.
 *
 * THE PAIRED INVARIANT (equally load-bearing)
 * -------------------------------------------
 * A wrap that swallows cdkd's OWN typed errors is its own defect. The deploy
 * engine matches {@link ResourceUpdateNotSupportedError} BY CLASS to fall back
 * to replacement (`deploy-engine.ts`'s `updateError instanceof
 * ResourceUpdateNotSupportedError`), so a `catch` that re-labels it as a
 * `ProvisioningError` silently turns a recoverable class change into a hard
 * failure. PR #1268 hit exactly this on `LogsLogGroupProvider`. So a wrapping
 * `catch` MUST re-throw cdkd-typed errors untouched, and this critic flags a
 * wrap that can capture a typed throw without a pass-through.
 *
 * HOW THE ANALYSIS WORKS (interprocedural, within one class)
 * ----------------------------------------------------------
 * Per provider class, walk from the public `update()` method carrying a
 * `protected` flag:
 *   - entering a `try` whose `catch` throws `ProvisioningError` sets the flag
 *     for everything inside the try block. BOTH spellings count: the literal
 *     `throw new ProvisioningError(...)` and the FACTORY idiom
 *     `throw this.wrapError(...)` (a class method returning / annotated
 *     `ProvisioningError`, or `never`-returning and throwing one). Missing the
 *     factory form reported five fully-wrapped providers as gaps;
 *   - entering a `try` whose `catch` SWALLOWS (never re-throws) also sets the
 *     flag — no raw SDK error can propagate, so "wrap the call" is the wrong
 *     remedy. A CONDITIONAL re-throw is not a swallow;
 *   - a `.send(...)` reached with the flag CLEAR is an unwrapped AWS call (a
 *     gap);
 *   - a `this.someMethod(...)` call is followed into that member, inheriting
 *     the current flag — so a provider that wraps at the boundary and
 *     delegates the body to a private helper (the PR #1268 shape) classifies
 *     as covered, and a provider whose `update()` delegates to a helper that
 *     wraps internally (the `s3-tables` shape) does too. Arrow-function class
 *     PROPERTIES are collected as members, not just `MethodDeclaration`s;
 *   - a `this.x()` callee that is NOT a member of this class is recorded as an
 *     UNRESOLVED edge, because sends behind it are unobservable and the class
 *     would otherwise report a confident (green, un-reviewable) `no-aws`.
 *     KNOWN LIMITATION: only the `this.x()` form is tracked. Delegation to a
 *     module-level free function or to `this.someField.method()` is invisible
 *     rather than `unresolved-callee`, so the `unresolvedCallees === 0`
 *     assertion is narrower than it looks. Neither shape reaches a send from
 *     `update()` in the tree today; widening it needs real call-graph
 *     resolution, which is out of proportion to the risk.
 * Recursion is cycle-guarded and bounded to the class's own members.
 *
 * WHY NOT A GREP
 * --------------
 * A brace-matching grep run by hand during PR #1268 produced 5 candidates and
 * at least one confirmed FALSE POSITIVE (`s3-tables`, which wraps inside the
 * helpers its `update()` delegates to). Delegation is the normal shape in this
 * codebase, so any checker that does not follow `this.x()` edges is noise.
 *
 * OFFLINE-ONLY (NO AWS)
 * ---------------------
 * Reads `src/provisioning/providers/*.ts` plus
 * `src/provisioning/cloud-control-provider.ts` (the widest-coverage provider in
 * the repo, which lives one directory up) via the TypeScript Compiler API.
 * Writes `docs/_generated/update-wrap-coverage.{json,md}`.
 *
 * CLASSIFICATION (per provider class that declares `update`)
 * -----------------------------------------------------------
 *   - no-aws            — `update()` reaches no AWS `send`. Nothing to wrap.
 *   - wrapped           — every reachable `send` is wrapped (or swallowed).
 *   - gap               — a reachable `send` escapes unwrapped. BLOCKS CI.
 *   - unguarded-wrap    — a `catch` that can capture a cdkd control-flow throw
 *                         has no pass-through re-throw. BLOCKS CI.
 *   - allow-listed      — a real offender with an `UPDATE_WRAP_ALLOW_LIST`
 *                         entry: still VISIBLE in the matrix, does not block.
 *   - unresolved-callee — the walk hit a `this.x()` it could not resolve, so
 *                         the verdict is not trustworthy. Visible, not blocking.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-update-wrap-coverage.ts          # write the matrix
 *   node --experimental-strip-types scripts/gen-update-wrap-coverage.ts --check  # fail on a gap
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// `typescript-v6` is an npm alias of typescript@6 — TS7 no longer ships the
// stable JS compiler API (see the note in gen-property-coverage.ts).
import ts from 'typescript-v6';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const PROVIDERS_DIR = resolve(repoRoot, 'src/provisioning/providers');
// CloudControlProvider lives one level up but declares update() with sends and
// is the WIDEST-coverage provider in the repo — scanning only providers/ left
// it unaudited.
const EXTRA_PROVIDER_FILES = [resolve(repoRoot, 'src/provisioning/cloud-control-provider.ts')];
const OUT_JSON = resolve(repoRoot, 'docs/_generated/update-wrap-coverage.json');
const OUT_MD = resolve(repoRoot, 'docs/_generated/update-wrap-coverage.md');

/**
 * cdkd error classes an `instanceof` guard may name, mapped to the classes that
 * guard actually COVERS.
 *
 * `ProvisioningError` and `ResourceUpdateNotSupportedError` are SIBLINGS — both
 * extend `CdkdError`, neither extends the other (`src/utils/error-handler.ts`
 * :85 / :248). So `if (error instanceof ProvisioningError) throw error;` does
 * NOT re-throw a `ResourceUpdateNotSupportedError`. Treating the guard set as a
 * flat "any of these counts" list silently accepted exactly that mismatch: a
 * provider guarding only `ProvisioningError` while its try can raise the
 * control-flow error would pass, and the by-class replacement fallback would
 * break anyway. Coverage is therefore per-class, not boolean.
 */
const GUARD_COVERAGE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['CdkdError', new Set(['CdkdError', 'ProvisioningError', 'ResourceUpdateNotSupportedError'])],
  ['ProvisioningError', new Set(['ProvisioningError'])],
  ['ResourceUpdateNotSupportedError', new Set(['ResourceUpdateNotSupportedError'])],
]);

/**
 * Typed throws whose CAPTURE by a wrap is CI-blocking.
 *
 * `ResourceUpdateNotSupportedError` is control flow the deploy engine matches
 * BY CLASS, so swallowing it changes BEHAVIOR: a recoverable LogGroupClass
 * change becomes a hard failure.
 *
 * `ProvisioningError` was added by #1272 once the last re-labelling site was
 * fixed. Swallowing one is not behavior-affecting (same failure, worse
 * message), but every site is now clean, so blocking keeps it that way. Adding
 * a class here is only safe when the tree is already free of it — otherwise CI
 * goes red on merge.
 *
 * Still a SEPARATE set from {@link TYPED_PASSTHROUGH_CLASSES}, which is the set
 * of guards ACCEPTED as a valid pass-through: being generous there is always
 * safe, being generous here is not.
 */
const CONTROL_FLOW_THROW_CLASSES: ReadonlySet<string> = new Set([
  'ResourceUpdateNotSupportedError',
  'ProvisioningError',
]);

export interface AllowListEntry {
  readonly rationale: string;
}

/**
 * Per-(class, method) entries the critic must not fail on. Key: `Class#method`
 * via {@link allowKey}.
 *
 * Two kinds of entry can live here:
 *   - NOT-A-BUG: the analysis is over-strict for a legitimate shape.
 *   - KNOWN GAP: a real gap being worked off under a tracking issue.
 *
 * EMPTY as of #1270: the 5 gaps the critic found on introduction are all fixed,
 * and removing their entries is what makes the critic VERIFY those fixes and
 * block a re-regression. Keep it empty unless a genuinely unwrappable shape
 * appears — an entry here is a deliberate, reviewable exception, not a
 * convenience.
 *
 * Keying by METHOD (not class) is deliberate: a class allow-listed for method A
 * must still block CI when a NEW gap appears in method B.
 */
export const UPDATE_WRAP_ALLOW_LIST: ReadonlyMap<string, AllowListEntry> = new Map<
  string,
  AllowListEntry
>();

export type Bucket =
  | 'no-aws'
  | 'wrapped'
  | 'gap'
  | 'unguarded-wrap'
  | 'allow-listed'
  | 'unresolved-callee';

export interface ClassClassification {
  readonly file: string;
  readonly className: string;
  readonly bucket: Bucket;
  /** Method names, reachable from update(), holding an unwrapped `send`. */
  readonly unwrappedSendMethods: readonly string[];
  /** Methods whose wrapping catch can capture a typed throw with no pass-through. */
  readonly unguardedWrapMethods: readonly string[];
  /** `this.x()` callees the walk could not resolve (see {@link WalkResult}). */
  readonly unresolvedCallees: readonly string[];
  readonly rationale?: string;
}

/** Allow-list key: `ClassName#methodName`, so an entry cannot hide a NEW gap. */
export const allowKey = (className: string, method: string): string => `${className}#${method}`;

/**
 * One callable member of a provider class.
 *
 * Includes arrow-function class PROPERTIES, not just `MethodDeclaration`s: an
 * unresolvable callee is silently invisible to the walk (it looks like "no AWS
 * call"), so every shape the walk can follow must be collected here.
 */
export interface ClassMethod {
  readonly name: string;
  readonly body: ts.Node;
  /** Returns (or throws) a ProvisioningError — i.e. usable as a wrap factory. */
  readonly isProvisioningErrorFactory: boolean;
  /** Declared `: never` — so a bare statement call to it does not fall through. */
  readonly returnsNever: boolean;
}

/** Is this node a nested function boundary we must NOT descend through? */
function isFunctionBoundary(n: ts.Node): boolean {
  return ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);
}

/**
 * Does this body itself `return` / `throw` a `new ProvisioningError(...)`?
 *
 * Does NOT descend into nested closures: a `new ProvisioningError` sitting in
 * an inner callback the method never returns says nothing about what the
 * METHOD produces, and treating it as a factory would wave through a genuinely
 * unwrapped path.
 */
function producesProvisioningError(node: ts.Node): boolean {
  let found = false;
  const visit = (n: ts.Node, isRoot: boolean): void => {
    if (found) return;
    if (!isRoot && isFunctionBoundary(n)) return;
    const expr = ts.isReturnStatement(n) || ts.isThrowStatement(n) ? n.expression : undefined;
    if (
      expr &&
      ts.isNewExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      expr.expression.text === 'ProvisioningError'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(n, (c) => visit(c, false));
  };
  visit(node, true);
  return found;
}

export function collectMethods(cls: ts.ClassDeclaration): Map<string, ClassMethod> {
  const methods = new Map<string, ClassMethod>();
  const add = (name: string, body: ts.Node, returnType: ts.TypeNode | undefined): void => {
    const annotatedProvisioningError =
      returnType !== undefined &&
      ts.isTypeReferenceNode(returnType) &&
      ts.isIdentifier(returnType.typeName) &&
      returnType.typeName.text === 'ProvisioningError';
    const returnsNever = returnType?.kind === ts.SyntaxKind.NeverKeyword;
    const produces = producesProvisioningError(body);
    methods.set(name, {
      name,
      body,
      // A `never` return alone is NOT enough: `fail(m): never { throw new
      // Error(m); }` returns never and wraps nothing.
      isProvisioningErrorFactory: annotatedProvisioningError || produces,
      returnsNever: returnsNever === true,
    });
  };

  for (const member of cls.members) {
    if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name) && member.body) {
      add(member.name.text, member.body, member.type);
    } else if (ts.isPropertyDeclaration(member) && ts.isIdentifier(member.name)) {
      const init = member.initializer;
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        add(member.name.text, init.body, init.type);
      }
    }
  }
  return methods;
}

/** `Promise.reject(...)` call? (an alternative spelling of `throw`) */
function isPromiseReject(n: ts.Node): boolean {
  return (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === 'reject' &&
    ts.isIdentifier(n.expression.expression) &&
    n.expression.expression.text === 'Promise'
  );
}

/**
 * Does this catch clause raise a ProvisioningError?
 *
 * Accepts all three spellings found in the tree:
 *   - the literal `throw new ProvisioningError(...)`;
 *   - the throw-form FACTORY `throw this.wrapError(...)`;
 *   - the STATEMENT-form helper `this.handleError(error, ...)` — no `throw`
 *     keyword at all, relying on the helper being `never`-returning. This is
 *     `CloudControlProvider`'s shape, and missing it was worse than a
 *     miscount: the clause looked like a SWALLOW, so the whole
 *     typed-pass-through check was skipped for the widest-coverage provider
 *     in the repo.
 */
function catchThrowsProvisioningError(
  clause: ts.CatchClause,
  methods: ReadonlyMap<string, ClassMethod>
): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isThrowStatement(node) && node.expression) {
      const expr = node.expression;
      if (
        ts.isNewExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.expression.text === 'ProvisioningError'
      ) {
        found = true;
        return;
      }
      const callee = thisMethodCallName(expr);
      if (callee !== null && methods.get(callee)?.isProvisioningErrorFactory) {
        found = true;
        return;
      }
    }
    // Statement-form: `this.handleError(...);` on a never-returning factory.
    if (ts.isExpressionStatement(node)) {
      const inner = ts.isAwaitExpression(node.expression)
        ? node.expression.expression
        : node.expression;
      const callee = thisMethodCallName(inner);
      const target = callee !== null ? methods.get(callee) : undefined;
      if (target?.isProvisioningErrorFactory && target.returnsNever) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(clause.block);
  return found;
}

/**
 * Does this body contain a typed pass-through — a POSITIVE `instanceof
 * <TypedClass>` test whose consequent re-throws THE SAME identifier it tested?
 *
 * Generalised over the identifier (rather than pinned to a catch binding) so it
 * works both for a `catch` clause and for a DELEGATED throw-helper's body: in
 * `CloudControlProvider` the wrap is `this.handleError(error, ...)` and the
 * pass-through (`if (error instanceof ProvisioningError) throw error;`) lives
 * inside `handleError`, not in the clause. Checking only the clause would
 * report that provider as swallowing its own typed errors when it does not.
 */
function collectGuardedClassesIn(node: ts.Node, allowReturn: boolean): Set<string> {
  const covered = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isIfStatement(n)) {
      const test = positiveTypedTest(n.expression);
      if (test && rethrowsIdentifier(n.thenStatement, test.subject, allowReturn)) {
        for (const c of test.guardClasses) covered.add(c);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return covered;
}

/** A positive `x instanceof <TypedClass>` test: the identifier + guard classes. */
interface TypedTest {
  readonly subject: string;
  readonly guardClasses: ReadonlySet<string>;
}

function positiveTypedTest(n: ts.Node): TypedTest | null {
  if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) return null;
  if (ts.isParenthesizedExpression(n)) return positiveTypedTest(n.expression);
  if (
    ts.isBinaryExpression(n) &&
    n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
    ts.isIdentifier(n.right) &&
    GUARD_COVERAGE.has(n.right.text) &&
    ts.isIdentifier(n.left)
  ) {
    return { subject: n.left.text, guardClasses: GUARD_COVERAGE.get(n.right.text)! };
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
    const l = positiveTypedTest(n.left);
    const r = positiveTypedTest(n.right);
    if (l && r && l.subject === r.subject) {
      return { subject: l.subject, guardClasses: new Set([...l.guardClasses, ...r.guardClasses]) };
    }
    return l ?? r;
  }
  return null;
}

/**
 * Does this subtree re-raise `<name>` unchanged?
 *
 * `allowReturn` accepts `return <name>;` as equivalent to `throw <name>;`. That
 * is correct ONLY inside a THROW-FORM factory (`throw this.wrapError(err)`),
 * where whatever the helper returns is immediately thrown by the caller — the
 * `lambda-microvm-image` shape, whose `wrapError` opens with
 * `if (error instanceof ProvisioningError) return error;`. For a STATEMENT-form
 * helper (`this.handleError(err)`) a bare `return` would swallow, so the throw
 * form stays required there.
 */
function rethrowsIdentifier(n: ts.Node, name: string, allowReturn = false): boolean {
  const isRaise = ts.isThrowStatement(n) || (allowReturn && ts.isReturnStatement(n));
  if (isRaise && n.expression && ts.isIdentifier(n.expression)) {
    return n.expression.text === name;
  }
  let hit = false;
  ts.forEachChild(n, (c) => {
    if (rethrowsIdentifier(c, name, allowReturn)) hit = true;
  });
  return hit;
}

/**
 * Which classes does the throw-helper this clause DELEGATES to guard?
 *
 * Only a REAL wrap factory counts: the callee must produce a
 * `ProvisioningError`, and for the statement form it must additionally be
 * `never`-returning (a plain statement call that can fall through does not
 * raise). The CAUGHT BINDING must also appear among the arguments.
 *
 * Without those checks any `this.x(...)` statement in the catch whose body
 * happened to contain a typed guard would be credited with a pass-through it
 * does not perform — e.g. an unrelated helper called before the wrap, a call
 * passing a DIFFERENT error value, or a cleanup routine in a nested try. That
 * last shape is realistic now that `if (error instanceof CdkdError) throw
 * error;` is spreading into helpers.
 */
function delegatedFactoryGuardedClasses(
  clause: ts.CatchClause,
  methods: ReadonlyMap<string, ClassMethod>
): Set<string> {
  const covered = new Set<string>();
  const decl = clause.variableDeclaration;
  const caughtName = decl && ts.isIdentifier(decl.name) ? decl.name.text : null;
  if (caughtName === null) return covered;

  const visit = (node: ts.Node): void => {
    const isThrowForm = ts.isThrowStatement(node);
    const expr = isThrowForm
      ? node.expression
      : ts.isExpressionStatement(node)
        ? ts.isAwaitExpression(node.expression)
          ? node.expression.expression
          : node.expression
        : undefined;
    const callee = expr ? thisMethodCallName(expr) : null;
    const target = callee !== null ? methods.get(callee) : undefined;
    if (
      target &&
      expr &&
      ts.isCallExpression(expr) &&
      target.isProvisioningErrorFactory &&
      (isThrowForm || target.returnsNever) &&
      expr.arguments.some((a) => ts.isIdentifier(a) && a.text === caughtName)
    ) {
      for (const c of collectGuardedClassesIn(target.body, isThrowForm)) covered.add(c);
    }
    ts.forEachChild(node, visit);
  };
  visit(clause.block);
  return covered;
}

/**
 * Which control-flow classes does this catch clause re-throw UNTOUCHED?
 *
 * A clause-level guard counts only when it (1) is a POSITIVE `instanceof` test
 * — the negated `if (!(error instanceof CdkdError)) throw error;` is the
 * inverse shape — and (2) re-throws the CAUGHT BINDING by name.
 * `throw new ProvisioningError(...)` inside an `instanceof` test is precisely
 * the #1268 defect, so accepting any throw would green-light the exact bug this
 * invariant exists to catch.
 *
 * Returns a SET rather than a boolean because the guard classes are SIBLINGS —
 * see {@link GUARD_COVERAGE}. The caller compares it against what the try can
 * actually raise.
 */
function catchGuardedClasses(
  clause: ts.CatchClause,
  methods: ReadonlyMap<string, ClassMethod>
): Set<string> {
  const covered = delegatedFactoryGuardedClasses(clause, methods);
  const decl = clause.variableDeclaration;
  if (!decl || !ts.isIdentifier(decl.name)) return covered;
  const caughtName = decl.name.text;

  const visit = (n: ts.Node): void => {
    if (ts.isIfStatement(n)) {
      const test = positiveTypedTest(n.expression);
      if (test && test.subject === caughtName && rethrowsIdentifier(n.thenStatement, caughtName)) {
        for (const c of test.guardClasses) covered.add(c);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(clause.block);
  return covered;
}

/**
 * Does this catch clause SWALLOW the error (log-and-continue, never re-raise)?
 *
 * A swallowing catch means no raw SDK error can propagate out of the enclosing
 * try, so the sends inside it are not an unwrapped-escape gap — "wrap the AWS
 * call in a ProvisioningError" is simply the wrong remedy there. Real examples:
 * `Route53Provider.resolveHostedZoneId` (warn, then fall through to a
 * ProvisioningError built from the resolution failure) and
 * `EC2Provider.applyTagDiff` (best-effort tagging).
 *
 * NOT a swallow: a CONDITIONAL re-throw (`if (!(err instanceof NotFound)) throw
 * err;` — the `s3-tables` `lookupTableArn` shape), a `return
 * Promise.reject(...)`, or a statement-form call to a `never`-returning helper
 * that raises internally.
 *
 * KNOWN LIMITATION: capture-then-rethrow (`catch { captured = err; }` … later
 * `throw captured;`) reads as a swallow here. Real at `glue-provider.ts`, where
 * an outer wrap covers it. Widening to a dataflow analysis is not worth it;
 * the outer-wrap check is what protects those sites.
 */
function catchSwallows(clause: ts.CatchClause, methods: ReadonlyMap<string, ClassMethod>): boolean {
  let raises = false;
  const visit = (n: ts.Node): void => {
    if (raises) return;
    if (ts.isThrowStatement(n) || isPromiseReject(n)) {
      raises = true;
      return;
    }
    if (ts.isExpressionStatement(n)) {
      const inner = ts.isAwaitExpression(n.expression) ? n.expression.expression : n.expression;
      const callee = thisMethodCallName(inner);
      if (callee !== null && methods.get(callee)?.returnsNever) {
        raises = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(clause.block);
  return !raises;
}

/**
 * Is this call an AWS SDK invocation that can throw?
 *
 * Covers `*.send(...)` plus the free-function `waitUntil*(...)` waiters — those
 * are AWS calls too and reject on failure, so an unwrapped waiter is the same
 * defect as an unwrapped send. (All 8 waiter sites happen to sit inside a try
 * today; matching them keeps that true.)
 */
function isSendCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false;
  if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'send') {
    return true;
  }
  return ts.isIdentifier(node.expression) && /^waitUntil[A-Z]/.test(node.expression.text);
}

/** `this.foo(...)` -> `foo`, else null. */
function thisMethodCallName(node: ts.Node): string | null {
  if (!ts.isCallExpression(node)) return null;
  const callee = node.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (callee.expression.kind !== ts.SyntaxKind.ThisKeyword) return null;
  return callee.name.text;
}

/**
 * Can this subtree throw a cdkd-typed control-flow error — directly, or via a
 * `this.x()` call it makes?
 *
 * The delegation hop is load-bearing, NOT a refinement. In the boundary-wrapper
 * shape PR #1268 settled on, the `try` body is a single
 * `return await this.applyUpdate(...)` and the `ResourceUpdateNotSupportedError`
 * throw lives inside `applyUpdate` — lexically OUTSIDE the try. A purely
 * lexical scan reports "this wrap cannot capture a typed throw" and silently
 * stops enforcing the pass-through on exactly the providers that need it most.
 * (Caught by live-testing the critic against the real `LogsLogGroupProvider`
 * with its pass-through removed: the lexical-only version returned green.)
 */
function collectRaisedControlFlowClasses(
  node: ts.Node,
  methods: ReadonlyMap<string, ClassMethod>,
  seen: Set<string> = new Set()
): Set<string> {
  const raised = new Set<string>();
  const visit = (n: ts.Node): void => {
    // Match the CONSTRUCTION, not just `throw` — the repo also raises these as
    // `return Promise.reject(new ResourceUpdateNotSupportedError(...))` (9 sites
    // across ec2 / ecs / apigateway / lambda-layer). Keying on `throw` alone
    // made the pass-through invariant silently inert for all of them.
    if (
      ts.isNewExpression(n) &&
      ts.isIdentifier(n.expression) &&
      CONTROL_FLOW_THROW_CLASSES.has(n.expression.text)
    ) {
      raised.add(n.expression.text);
      return;
    }
    const callee = thisMethodCallName(n);
    if (callee !== null && !seen.has(callee)) {
      seen.add(callee);
      const target = methods.get(callee);
      if (target) {
        for (const c of collectRaisedControlFlowClasses(target.body, methods, seen)) raised.add(c);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return raised;
}

export interface WalkResult {
  readonly unwrappedSendMethods: Set<string>;
  readonly unguardedWrapMethods: Set<string>;
  readonly sawAnySend: boolean;
  /**
   * `this.x()` callees reached from update() that could not be resolved to a
   * member of this class. Tracked because an unresolvable callee is otherwise
   * INVISIBLE: the walk cannot see sends behind it, so the class would report
   * a confident `no-aws` (green, un-allow-listed, un-reviewable).
   */
  readonly unresolvedCallees: Set<string>;
}

/**
 * Walk one provider class from `update()`, following `this.x()` edges and
 * tracking whether the current position is inside a ProvisioningError wrap.
 *
 * Exported so unit tests can drive it with synthetic classes.
 */
export function analyzeClass(cls: ts.ClassDeclaration): WalkResult | null {
  const methods = collectMethods(cls);
  const update = methods.get('update');
  if (!update) return null;

  const unwrappedSendMethods = new Set<string>();
  const unguardedWrapMethods = new Set<string>();
  const unresolvedCallees = new Set<string>();
  let sawAnySend = false;
  // A method can be reached both protected and unprotected; key the visited
  // set on both so we do not miss the unprotected reachability.
  const visited = new Set<string>();

  const walkMethod = (method: ClassMethod, protectedHere: boolean): void => {
    const key = `${method.name}:${protectedHere}`;
    if (visited.has(key)) return;
    visited.add(key);

    const walk = (node: ts.Node, isProtected: boolean): void => {
      if (ts.isTryStatement(node)) {
        const clause = node.catchClause;
        const wraps = clause ? catchThrowsProvisioningError(clause, methods) : false;
        // A swallowing catch cannot propagate a raw SDK error, so sends inside
        // it are handled even though nothing is wrapped.
        const swallows = clause ? catchSwallows(clause, methods) : false;
        if (wraps && clause) {
          // A wrap that can capture a typed control-flow throw MUST pass it through.
          const raised = collectRaisedControlFlowClasses(node.tryBlock, methods);
          if (raised.size > 0) {
            const covered = catchGuardedClasses(clause, methods);
            // Per-class: an `instanceof ProvisioningError` guard does NOT cover
            // a sibling ResourceUpdateNotSupportedError.
            if ([...raised].some((c) => !covered.has(c))) {
              unguardedWrapMethods.add(method.name);
            }
          }
        }
        walk(node.tryBlock, isProtected || wraps || swallows);
        if (clause) walk(clause.block, isProtected);
        if (node.finallyBlock) walk(node.finallyBlock, isProtected);
        return;
      }

      if (isSendCall(node)) {
        sawAnySend = true;
        if (!isProtected) unwrappedSendMethods.add(method.name);
        // Still descend: arguments can contain further calls.
      }

      const callee = thisMethodCallName(node);
      if (callee !== null) {
        const target = methods.get(callee);
        if (target) walkMethod(target, isProtected);
        // `this.x()` where x is not a member of THIS class (inherited, or a
        // field holding a helper object). Record it: sends behind it are
        // unobservable, so silently treating the class as send-free would be
        // a false "clean".
        else unresolvedCallees.add(callee);
      }

      ts.forEachChild(node, (child) => walk(child, isProtected));
    };

    walk(method.body, protectedHere);
  };

  walkMethod(update, false);
  return { unwrappedSendMethods, unguardedWrapMethods, sawAnySend, unresolvedCallees };
}

/** Classify every provider class in one source file. Pure + exported for tests. */
export function classifySource(
  source: string,
  fileName = 'provider.ts',
  allowList: ReadonlyMap<string, AllowListEntry> = UPDATE_WRAP_ALLOW_LIST
): ClassClassification[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const out: ClassClassification[] = [];

  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const result = analyzeClass(node);
      if (result) {
        const className = node.name.text;
        const sortNames = (s: Set<string>): string[] =>
          [...s].sort((a, b) => a.localeCompare(b));
        const allUnwrapped = sortNames(result.unwrappedSendMethods);
        const allUnguarded = sortNames(result.unguardedWrapMethods);
        const unresolved = sortNames(result.unresolvedCallees);

        // Per-(class, method) allow-listing: an entry for method A must NOT
        // silence a NEW gap that later appears in method B of the same class.
        const isAllowed = (m: string): boolean => allowList.has(allowKey(className, m));
        const unwrapped = allUnwrapped.filter((m) => !isAllowed(m));
        const unguarded = allUnguarded.filter((m) => !isAllowed(m));
        const allowedHits = [...allUnwrapped, ...allUnguarded].filter(isAllowed);
        const rationale = allowedHits
          .map((m) => allowList.get(allowKey(className, m))?.rationale)
          .find((r) => r !== undefined);

        let bucket: Bucket;
        // Un-allow-listed offenders always win, so an allow-listed class with a
        // NEW gap elsewhere still blocks CI.
        if (unwrapped.length > 0) bucket = 'gap';
        else if (unguarded.length > 0) bucket = 'unguarded-wrap';
        // An allow-listed offender stays VISIBLE as `allow-listed` rather than
        // being relabelled `wrapped` — the matrix must keep documenting the
        // known gap, it just must not fail CI.
        // Ahead of `allow-listed`: a lost edge means the verdict is not
        // trustworthy, and burying it under an allow-list entry would also hide
        // it from the `unresolved-callee === 0` assertion.
        else if (unresolved.length > 0) bucket = 'unresolved-callee';
        else if (allowedHits.length > 0) bucket = 'allow-listed';
        else if (!result.sawAnySend) bucket = 'no-aws';
        else bucket = 'wrapped';

        out.push({
          file: fileName,
          className,
          bucket,
          unwrappedSendMethods: allUnwrapped,
          unguardedWrapMethods: allUnguarded,
          unresolvedCallees: unresolved,
          ...(rationale ? { rationale } : {}),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export interface UpdateWrapCoverageReport {
  readonly summary: {
    readonly classifiedCount: number;
    readonly wrapped: number;
    readonly noAws: number;
    readonly gap: number;
    readonly unguardedWrap: number;
    readonly allowListed: number;
    readonly unresolvedCallee: number;
  };
  readonly classes: readonly ClassClassification[];
}

export function buildReport(classes: readonly ClassClassification[]): UpdateWrapCoverageReport {
  const sorted = [...classes].sort(
    (a, b) => a.file.localeCompare(b.file) || a.className.localeCompare(b.className)
  );
  return {
    summary: {
      classifiedCount: sorted.length,
      wrapped: sorted.filter((c) => c.bucket === 'wrapped').length,
      noAws: sorted.filter((c) => c.bucket === 'no-aws').length,
      gap: sorted.filter((c) => c.bucket === 'gap').length,
      unguardedWrap: sorted.filter((c) => c.bucket === 'unguarded-wrap').length,
      allowListed: sorted.filter((c) => c.bucket === 'allow-listed').length,
      unresolvedCallee: sorted.filter((c) => c.bucket === 'unresolved-callee').length,
    },
    classes: sorted,
  };
}

export function findGaps(report: UpdateWrapCoverageReport): readonly ClassClassification[] {
  return report.classes.filter((c) => c.bucket === 'gap' || c.bucket === 'unguarded-wrap');
}

function renderMarkdown(report: UpdateWrapCoverageReport): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('title: "Update error-wrapping coverage matrix"');
  lines.push('unlisted: true');
  lines.push('---');
  lines.push('');
  lines.push('# SDK-provider `update()` error-wrapping coverage matrix');
  lines.push('');
  lines.push(
    '<!-- AUTO-GENERATED by scripts/gen-update-wrap-coverage.ts — DO NOT EDIT BY HAND. -->'
  );
  lines.push('<!-- Regenerate: `vp run gen:update-wrap-coverage`. -->');
  lines.push('');
  lines.push(
    'For every SDK provider class declaring `update()`, walks from `update()` ' +
      'through `this.x()` delegation edges and classifies whether every reachable ' +
      'AWS `send` is enclosed by a `ProvisioningError` wrap — and whether that wrap ' +
      're-throws cdkd-typed errors untouched (the deploy engine matches ' +
      '`ResourceUpdateNotSupportedError` BY CLASS to fall back to replacement).'
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- Provider classes with \`update()\`: **${report.summary.classifiedCount}**`);
  lines.push(`- Wrapped: **${report.summary.wrapped}**`);
  lines.push(`- No AWS call in update(): **${report.summary.noAws}**`);
  lines.push(`- **Unwrapped-send gaps (blocks CI): ${report.summary.gap}**`);
  lines.push(`- **Unguarded wraps (blocks CI): ${report.summary.unguardedWrap}**`);
  lines.push(`- Allow-listed known gaps (does NOT block CI): **${report.summary.allowListed}**`);
  lines.push(
    `- Unresolved-callee (verdict not trustworthy): **${report.summary.unresolvedCallee}**`
  );
  lines.push('');

  const allowListed = report.classes.filter((c) => c.bucket === 'allow-listed');
  if (allowListed.length > 0) {
    lines.push('## Allow-listed known gaps');
    lines.push('');
    lines.push(
      'Real gaps, deliberately not failing CI while they are worked off. Fixing one ' +
        'means removing its `UPDATE_WRAP_ALLOW_LIST` entry in the same PR, after which ' +
        'the critic verifies the fix and blocks a re-regression.'
    );
    lines.push('');
    lines.push('| Provider class | File | Offending methods | Rationale |');
    lines.push('| --- | --- | --- | --- |');
    for (const c of allowListed) {
      const methods = [...c.unwrappedSendMethods, ...c.unguardedWrapMethods]
        .map((m) => `\`${m}\``)
        .join(', ');
      lines.push(`| \`${c.className}\` | \`${c.file}\` | ${methods} | ${c.rationale ?? ''} |`);
    }
    lines.push('');
  }

  const gaps = report.classes.filter((c) => c.bucket === 'gap');
  if (gaps.length > 0) {
    lines.push('## Unwrapped-send gaps — BLOCKS CI');
    lines.push('');
    lines.push(
      'Wrap the AWS call so an SDK failure surfaces as `ProvisioningError` ' +
        '(`resourceType` / `logicalId` / `physicalId` / `cause`), matching the same ' +
        "provider's `create()`. Remember the typed pass-through."
    );
    lines.push('');
    lines.push('| Provider class | File | Methods with an unwrapped `send` |');
    lines.push('| --- | --- | --- |');
    for (const c of gaps) {
      lines.push(
        `| \`${c.className}\` | \`${c.file}\` | ${c.unwrappedSendMethods
          .map((m) => `\`${m}\``)
          .join(', ')} |`
      );
    }
    lines.push('');
  }

  const unguarded = report.classes.filter((c) => c.bucket === 'unguarded-wrap');
  if (unguarded.length > 0) {
    lines.push('## Unguarded wraps — BLOCKS CI');
    lines.push('');
    lines.push(
      'The `catch` builds a `ProvisioningError` but can capture a cdkd-typed throw. ' +
        'Add `if (error instanceof CdkdError) throw error;` before the wrap.'
    );
    lines.push('');
    lines.push('| Provider class | File | Methods |');
    lines.push('| --- | --- | --- |');
    for (const c of unguarded) {
      lines.push(
        `| \`${c.className}\` | \`${c.file}\` | ${c.unguardedWrapMethods
          .map((m) => `\`${m}\``)
          .join(', ')} |`
      );
    }
    lines.push('');
  }

  if (gaps.length === 0 && unguarded.length === 0) {
    lines.push('## Gaps');
    lines.push('');
    lines.push(
      'None. Every provider `update()` either makes no AWS call or wraps every ' +
        'reachable `send` in a `ProvisioningError`, with typed errors passed through.'
    );
    lines.push('');
  }

  lines.push('## Full classification');
  lines.push('');
  lines.push('| Provider class | File | Bucket |');
  lines.push('| --- | --- | --- |');
  for (const c of report.classes) {
    lines.push(`| \`${c.className}\` | \`${c.file}\` | ${c.bucket} |`);
  }
  lines.push('');
  return lines.join('\n');
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

const isMainModule = (): boolean =>
  Boolean(process.argv[1]) && resolve(process.argv[1]!) === __filename;

function loadReport(): UpdateWrapCoverageReport {
  const classes: ClassClassification[] = [];
  for (const file of readdirSync(PROVIDERS_DIR).sort()) {
    if (!file.endsWith('.ts') || file.endsWith('.d.ts')) continue;
    const src = readFileSync(join(PROVIDERS_DIR, file), 'utf8');
    classes.push(...classifySource(src, file));
  }
  for (const abs of EXTRA_PROVIDER_FILES) {
    classes.push(...classifySource(readFileSync(abs, 'utf8'), abs.slice(repoRoot.length + 1)));
  }
  return buildReport(classes);
}

function main(): void {
  const checkMode = process.argv.includes('--check');
  const report = loadReport();

  if (checkMode) {
    const gaps = findGaps(report);
    if (gaps.length > 0) {
      process.stderr.write(
        'update-wrap-coverage: FAIL — provider update() error-wrapping gap(s) detected.\n' +
          'An AWS SDK failure from these paths would surface RAW, bypassing cdkd typed\n' +
          'error formatting / exit codes (the #1263 / #1267 class), or a wrap would\n' +
          'swallow a typed control-flow error the deploy engine matches by class.\n' +
          'Wrap the call like the same provider create(), keep the typed pass-through,\n' +
          'OR add an UPDATE_WRAP_ALLOW_LIST entry with a rationale in\n' +
          'scripts/gen-update-wrap-coverage.ts.\n\n'
      );
      for (const c of gaps) {
        const detail =
          c.bucket === 'gap'
            ? `unwrapped send in ${c.unwrappedSendMethods.join(', ')}`
            : `unguarded wrap in ${c.unguardedWrapMethods.join(', ')}`;
        process.stderr.write(`  ${c.className} (${c.file}): ${detail}\n`);
      }
      process.exit(1);
    }
    process.stderr.write(
      `update-wrap-coverage: OK — ${report.summary.classifiedCount} provider classes with ` +
        `update() classified, 0 blocking gaps (${report.summary.wrapped} wrapped, ` +
        `${report.summary.noAws} no-aws` +
        (report.summary.allowListed > 0
          ? `, ${report.summary.allowListed} allow-listed KNOWN gaps still open`
          : '') +
        (report.summary.unresolvedCallee > 0
          ? `, ${report.summary.unresolvedCallee} unresolved-callee`
          : '') +
        ').\n'
    );
    return;
  }

  mkdirSync(dirname(OUT_JSON), { recursive: true });
  atomicWrite(OUT_JSON, JSON.stringify(report, null, 2) + '\n');
  atomicWrite(OUT_MD, renderMarkdown(report) + '\n');
  process.stderr.write(
    `update-wrap-coverage: wrote update-wrap-coverage.{json,md} — ` +
      `${report.summary.classifiedCount} classified, ${report.summary.wrapped} wrapped, ` +
      `${report.summary.noAws} no-aws, ${report.summary.gap} gap(s), ` +
      `${report.summary.unguardedWrap} unguarded wrap(s).\n`
  );
}

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`update-wrap-coverage: failed — ${(err as Error).message}\n`);
    process.exit(1);
  }
}
