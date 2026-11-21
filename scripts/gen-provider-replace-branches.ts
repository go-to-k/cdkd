/**
 * Codegen + CI critic: does `cdkd diff` show a REPLACEMENT for every property
 * change an SDK provider's `update()` handles by replacing the resource?
 * (issue #6656)
 *
 * THE GAP THIS CLOSES
 * -------------------
 * Some providers meet a property change inside `update()` by creating a new
 * resource (and deleting the old one), and report it with `wasReplaced` / a
 * new physical id. The deploy then REPLACES the resource, while `cdkd diff`,
 * `--require-approval` and `diff --fail-on` (one classification) read the
 * change as an UPDATE unless the replacement rules or the CFn schema's
 * `createOnlyProperties` say otherwise. A user approving the diff approves a
 * replacement they were never shown (#6509 SNS subscription, #6513 ACM
 * `ValidationMethod`, found one at a time).
 *
 * WHAT A REPLACE BRANCH IS (offline, TypeScript AST)
 * --------------------------------------------------
 * From `update()`, transitively through the code it reaches (`this.x` class
 * and resolvable base-class members, `this:` companion functions — called as
 * `this.x()` or `x.call(this, ...)` — and module / relative-import functions),
 * narrowed per resource type as `gen-update-path-coverage.ts` narrows
 * (`resourceType` comparisons and `switch`es), a SITE is either:
 *   - was-replaced — an object literal member `wasReplaced: <expr>` whose value
 *                    is not the literal `false` (a computed value is itself a
 *                    guard of the site);
 *   - own-create   — a call of the provider's own create path: `this.create()`
 *                    or a member / companion that `create()` returns the
 *                    result of (transitively). A replacement that keeps
 *                    reporting `wasReplaced: false` (a Lambda permission's
 *                    remove + add) is still one.
 * A replacement the provider builds without either — a `Create*Command` sent
 * for the primary resource with no own-create call and no `wasReplaced` — is
 * out of reach. A returned physical id that differs from the recorded one is
 * NOT a signal: on the update paths that return one without either signal it
 * is an in-place change (an inline policy rename, a policy's target list, an
 * id re-spelled from the update response), as CloudFormation also updates.
 * The custom resource provider is outside the universe (no schema type): its
 * handler decides a replacement at run time, which no diff can preview.
 *
 * WHICH PROPERTY CHANGES LEAD INTO IT (the triggers)
 * --------------------------------------------------
 * The GUARDS of a site are the conditions it sits under on the path from
 * `update()`: an enclosing `if` / `?:` / `&&` / `||` / `??` / loop / `switch`
 * (not a resource-type test), and every earlier `if` in an enclosing block
 * whose then-arm always ends in `return` / `throw` (an early exit), in the
 * function holding the site and at each call site leading to it. A guard's
 * READS are grown through its data flow: a `const` / `let` local to its
 * initialiser and every assignment of it, a `for (const k of LIST)` binding to
 * `LIST`, a destructured `{ A }` to `A`, a module-level declaration to its
 * initialiser, and a resolvable called function to its whole body. A read is
 * `<expr>.Name`, `<expr>['Name']` or the string `'Name'`. Parameters are not
 * followed: the property BAG itself names no property. A site's triggers are
 * the reads that are writable top-level properties of the type in its
 * committed CFn schema.
 *
 * A site whose guards read no property (it replaces on any change, or only on
 * a path no template change reaches) cannot be derived and needs a
 * {@link BRANCH_DISPOSITIONS} entry; a derived read that does not lead into
 * the branch (it is read only to EXEMPT a case) needs a
 * {@link NOT_A_TRIGGER} entry.
 *
 * CLASSIFICATION (per site x trigger)
 * -----------------------------------
 *   - replacement — the diff replaces for any change of it:
 *                   `replacementProperties`, or create-only in the committed
 *                   CFn schema while the rules neither mark it updateable nor
 *                   give it a predicate (`DiffCalculator`'s fallback order);
 *   - conditional — a `conditionalReplacements` predicate decides; its unit
 *                   tests pin that it answers for the provider's branch;
 *   - exempt      — a {@link NOT_A_TRIGGER} entry with its reason;
 *   - gap         — the diff shows an UPDATE for a change the deploy performs
 *                   as a replacement. BLOCKS CI.
 *
 * `--check` fails on a gap, on a site with no derived trigger and no
 * disposition, on a stale disposition / exemption, on a `this.x()` the walk
 * cannot resolve, and on a generated file that is not what this script writes.
 *
 * BOUNDS
 * ------
 * Top-level properties only, as the replacement rules are. A trigger read
 * only inside a callee's body is attributed to every guard that calls it (an
 * over-approximation, settled by NOT_A_TRIGGER). Positions, not values: a
 * guard's reads are property names, not which change of them replaces.
 *
 * Writes `docs/_generated/provider-replace-branches.{json,md}`.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-provider-replace-branches.ts          # write the table
 *   node --experimental-strip-types scripts/gen-provider-replace-branches.ts --check  # fail on a gap or stale file
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// `typescript-v6` is an npm alias of typescript@6 (see gen-property-coverage.ts).
import ts from 'typescript-v6';
import { parseProviderSource } from './gen-property-coverage.ts';
import {
  ModuleIndex,
  branchReach,
  classMembers,
  isResourceTypeOperand,
  parseReplacementRules,
  type RuleSets,
  type SourceHost,
} from './gen-update-path-coverage.ts';
import { escapeCell } from './markdown-table.ts';
import { companionFiles } from './provider-companion-files.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const PROVIDERS_DIR = resolve(repoRoot, 'src/provisioning/providers');
const FIXTURE_DIR = resolve(repoRoot, 'tests/fixtures/cfn-schemas');
const RULES_FILE = resolve(repoRoot, 'src/analyzer/replacement-rules/rules.ts');
const PROVIDER_MARK_FILE = resolve(repoRoot, 'src/analyzer/diff-calculator/provider-replacement.ts');
export const OUT_JSON = resolve(repoRoot, 'docs/_generated/provider-replace-branches.json');
export const OUT_MD = resolve(repoRoot, 'docs/_generated/provider-replace-branches.md');

export type Signal = 'was-replaced' | 'own-create';

export interface BranchDisposition {
  /**
   * - `every-property` — the branch runs for any change that reaches
   *   `update()`, so every writable property of the type is a trigger;
   * - `no-template-trigger` — no property change of a template deploy
   *   reaches it (a rollback replay over an unchanged bag, a refusal-guarded
   *   revert path); it carries no trigger;
   * - `handler-decided` — the replacement is decided at run time by code cdkd
   *   does not hold (a custom resource handler returning a new
   *   `PhysicalResourceId`), which CloudFormation cannot preview either.
   */
  readonly kind: 'every-property' | 'no-template-trigger' | 'handler-decided';
  readonly rationale: string;
}

/**
 * Site key (see {@link siteKey}) -> why its triggers are not derived. Every
 * entry must still name a site: `--check` refuses a stale one.
 */
export const BRANCH_DISPOSITIONS: ReadonlyMap<string, BranchDisposition> = new Map<
  string,
  BranchDisposition
>([
  [
    'AWS::EC2::SecurityGroupIngress src/provisioning/providers/ec2/sg-ingress-update.ts:updateSecurityGroupIngress own-create#1',
    {
      kind: 'no-template-trigger',
      rationale:
        'a rollback replay (replayingState) of an update with the same bag on both sides authorizes ' +
        'the recorded rule again; an unchanged bag returns before it on every other path',
    },
  ],
  [
    'AWS::EC2::SecurityGroupIngress src/provisioning/providers/ec2/sg-ingress-update.ts:updateSecurityGroupIngress was-replaced#1',
    {
      kind: 'no-template-trigger',
      rationale: 'the answer of the rollback-replay re-authorize above',
    },
  ],
  [
    'AWS::CloudFormation::WaitConditionHandle src/provisioning/providers/wait-condition-handle-provider.ts:update own-create#1',
    {
      kind: 'no-template-trigger',
      rationale:
        'only a recorded pre-#6694 placeholder id re-issues the handle (#6704); the type has no ' +
        'properties, and the diff marks that row itself (`providerReplacement`, legacy-handle-heal.ts)',
    },
  ],
  [
    'AWS::CloudFormation::WaitConditionHandle src/provisioning/providers/wait-condition-handle-provider.ts:update was-replaced#1',
    {
      kind: 'no-template-trigger',
      rationale: 'the answer of the placeholder re-issue above',
    },
  ],
  [
    'AWS::Lambda::Permission src/provisioning/providers/lambda-permission-provider.ts:update own-create#1',
    {
      kind: 'every-property',
      rationale:
        'a permission has no update API, so every change removes and re-adds the statement; every ' +
        'property is create-only, so the diff replaces it through the engine first',
    },
  ],
]);

export interface TriggerExemption {
  /**
   * - `not-a-trigger` — the guard reads it, but no change of it leads into the
   *   branch on a template deploy;
   * - `cfn-update` — the branch replaces for it, CloudFormation's own diff
   *   shows an update for the same change, and the replacement is not visible
   *   as one to the user (checked with `@aws-cdk/cloudformation-diff`).
   */
  readonly kind: 'not-a-trigger' | 'cfn-update';
  /**
   * `<file>:<function>` of the sites it answers for. A replace site the type
   * gains elsewhere is classified on its own, never exempted by this entry.
   */
  readonly at: string;
  readonly rationale: string;
}

/**
 * `AWS::X::Y#Prop` -> why a property a site's guards read is not a change the
 * diff must show as a replacement. Every entry must still name a derived
 * read: `--check` refuses a stale one.
 */
export const NOT_A_TRIGGER: ReadonlyMap<string, TriggerExemption> = new Map<string, TriggerExemption>([
  [
    'AWS::EC2::SecurityGroupIngress#Description',
    {
      kind: 'not-a-trigger',
      at: 'src/provisioning/providers/ec2/sg-ingress-update.ts:updateSecurityGroupIngress',
      rationale:
        'a description change updates the rule in place (#6514); revoke + authorize follows only ' +
        'when AWS no longer has the rule or the recorded description is redacted',
    },
  ],
  [
    'AWS::Route53::RecordSet#SetIdentifier',
    {
      kind: 'cfn-update',
      at: 'src/provisioning/providers/route53/record-set.ts:updateRecordSet',
      rationale:
        'CloudFormation shows an update; the record is swapped in one atomic change batch, so the ' +
        'name never stops resolving',
    },
  ],
  [
    'AWS::Route53::RecordSet#Type',
    {
      kind: 'cfn-update',
      at: 'src/provisioning/providers/route53/record-set.ts:updateRecordSet',
      rationale:
        'CloudFormation shows an update; the record is swapped in one atomic change batch, so the ' +
        'name never stops resolving',
    },
  ],
  [
    'AWS::SNS::Subscription#RawMessageDelivery',
    {
      kind: 'not-a-trigger',
      at: 'src/provisioning/providers/sns-subscription-provider.ts:replace',
      rationale: 'the attribute plan sets it in place, and resets it when removed (RESET_VALUES)',
    },
  ],
  [
    'AWS::SNS::Subscription#RedrivePolicy',
    {
      kind: 'not-a-trigger',
      at: 'src/provisioning/providers/sns-subscription-provider.ts:replace',
      rationale: 'the attribute plan sets it in place, and resets it when removed (RESET_VALUES)',
    },
  ],
]);

export const triggerKey = (resourceType: string, prop: string): string => `${resourceType}#${prop}`;

// ---------------------------------------------------------------------------
// The walk.
// ---------------------------------------------------------------------------

interface Guard {
  readonly expr: ts.Node;
  readonly file: string;
}

export interface RawSite {
  readonly signal: Signal;
  readonly file: string;
  readonly fn: string;
  readonly node: ts.Node;
  readonly guards: readonly Guard[];
}

export interface WalkInput {
  readonly cls: ts.ClassDeclaration;
  readonly file: string;
  readonly companions: ReadonlyMap<string, { file: string; fn: ts.FunctionDeclaration }>;
  readonly index: ModuleIndex;
}

export interface WalkResult {
  readonly hasUpdate: boolean;
  readonly sites: readonly RawSite[];
  readonly unresolved: ReadonlySet<string>;
  /**
   * A callee parameter -> the argument expressions the walked calls bind to
   * it, so a guard reading a parameter reads what the callers passed.
   */
  readonly bindings: ParamBindings;
}

export type ParamBindings = ReadonlyMap<ts.ParameterDeclaration, readonly Guard[]>;

const isThisParam = (p: ts.ParameterDeclaration | undefined): boolean =>
  p !== undefined && ts.isIdentifier(p.name) && p.name.text === 'this';

const unwrap = (e: ts.Expression): ts.Expression => {
  let x = e;
  while (
    ts.isParenthesizedExpression(x) ||
    ts.isAsExpression(x) ||
    ts.isAwaitExpression(x) ||
    ts.isNonNullExpression(x) ||
    ts.isSatisfiesExpression(x) ||
    ts.isTypeAssertionExpression(x)
  ) {
    x = x.expression;
  }
  return x;
};

/**
 * How `stmt` leaves the enclosing function on every path: `'throw'` when every
 * path throws, `'return'` when every path leaves and at least one returns,
 * `null` when some path falls through.
 */
function exitKind(stmt: ts.Statement | undefined): 'return' | 'throw' | null {
  if (!stmt) return null;
  if (ts.isReturnStatement(stmt)) return 'return';
  if (ts.isThrowStatement(stmt)) return 'throw';
  if (ts.isBlock(stmt)) return exitKind(stmt.statements[stmt.statements.length - 1]);
  const both = (a: ReturnType<typeof exitKind>, b: ReturnType<typeof exitKind>): ReturnType<typeof exitKind> =>
    a === null || b === null ? null : a === 'throw' && b === 'throw' ? 'throw' : 'return';
  if (ts.isIfStatement(stmt)) {
    return stmt.elseStatement === undefined ? null : both(exitKind(stmt.thenStatement), exitKind(stmt.elseStatement));
  }
  if (ts.isTryStatement(stmt)) {
    if (stmt.finallyBlock && exitKind(stmt.finallyBlock) !== null) return exitKind(stmt.finallyBlock);
    const tried = exitKind(stmt.tryBlock);
    return stmt.catchClause ? both(tried, exitKind(stmt.catchClause.block)) : tried;
  }
  return null;
}

const alwaysExits = (stmt: ts.Statement | undefined): boolean => exitKind(stmt) !== null;

/** The name of the function or method `node` sits in, for the site key. */
function enclosingFunctionName(node: ts.Node): string {
  for (let p: ts.Node | undefined = node.parent; p; p = p.parent) {
    if ((ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) && p.name && ts.isIdentifier(p.name)) {
      return p.name.text;
    }
    if (
      (ts.isVariableDeclaration(p) || ts.isPropertyDeclaration(p)) &&
      ts.isIdentifier(p.name) &&
      p.initializer &&
      (ts.isArrowFunction(unwrap(p.initializer)) || ts.isFunctionExpression(unwrap(p.initializer)))
    ) {
      return p.name.text;
    }
  }
  return '(module)';
}

/**
 * `this.m(...)` -> `{ name: 'm', viaCall: false }`; `m.call(this, ...)` ->
 * `{ name: 'm', viaCall: true }` (a `this:` companion function, which a class
 * member of the same name delegates to); otherwise null.
 */
function ownCall(call: ts.CallExpression): { name: string; viaCall: boolean } | null {
  const callee = unwrap(call.expression);
  if (ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword) {
    return { name: callee.name.text, viaCall: false };
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'call' &&
    call.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword &&
    ts.isIdentifier(unwrap(callee.expression))
  ) {
    return { name: (unwrap(callee.expression) as ts.Identifier).text, viaCall: true };
  }
  return null;
}

type OwnResolver = (name: string, viaCall: boolean) => { node: ts.Node; file: string } | null;

/** A `this.x` member (else companion); for `x.call(this)` the companion first. */
function ownResolver(
  members: ReadonlyMap<string, { node: ts.Node; file: string }>,
  companions: ReadonlyMap<string, { file: string; fn: ts.FunctionDeclaration }>
): OwnResolver {
  return (name, viaCall) => {
    const comp = companions.get(name);
    const compTarget = comp?.fn.body ? { node: comp.fn.body as ts.Node, file: comp.file } : null;
    if (viaCall) return compTarget;
    return members.get(name) ?? compTarget;
  };
}

/** The body a member / companion / module function declaration runs. */
function bodyOf(node: ts.Node): ts.Node | undefined {
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return node.body;
  if (ts.isVariableDeclaration(node)) {
    const init = node.initializer && unwrap(node.initializer);
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) return init.body;
    return undefined;
  }
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node.body;
  return node;
}

export function walkReplaceBranches(input: WalkInput, resourceType: string): WalkResult {
  const { cls, file, companions, index } = input;
  const members = classMembers(cls, file, index);
  const update = members.get('update');
  const unresolved = new Set<string>();
  if (!update) return { hasUpdate: false, sites: [], unresolved, bindings: new Map() };

  const resolveOwn = ownResolver(members, companions);

  // ---- the create path: create() and what it returns the result of ----
  const createEntries = new Set<string>(['create']);
  const createQueue: string[] = ['create'];
  while (createQueue.length > 0) {
    const name = createQueue.shift()!;
    const target = resolveOwn(name, false) ?? resolveOwn(name, true);
    if (!target) continue;
    const visitC = (n: ts.Node): void => {
      if (ts.isFunctionLike(n) && n !== target.node && !ts.isArrowFunction(n)) return;
      if (ts.isReturnStatement(n) && n.expression) {
        const e = unwrap(n.expression);
        if (ts.isCallExpression(e)) {
          const own = ownCall(e);
          if (own !== null && !createEntries.has(own.name) && resolveOwn(own.name, own.viaCall)) {
            createEntries.add(own.name);
            createQueue.push(own.name);
          }
        }
      }
      ts.forEachChild(n, visitC);
    };
    visitC(target.node);
  }

  const sites: RawSite[] = [];
  const bindings = new Map<ts.ParameterDeclaration, Guard[]>();
  /** Bind `args` (in `f`) to the parameters of the function whose body is `body`. */
  const bindArgs = (body: ts.Node, args: readonly ts.Expression[], f: string, viaCall: boolean): void => {
    const fn = ts.isFunctionLike(body) ? body : body.parent;
    if (!fn || !ts.isFunctionLike(fn)) return;
    const params = fn.parameters;
    // `x.call(this, a)` hands `this` to a `this:` parameter; a plain call of a
    // `this:` function skips it.
    const offset = viaCall ? (isThisParam(params[0]) ? 0 : -1) : isThisParam(params[0]) ? 1 : 0;
    args.forEach((arg, i) => {
      const param = params[i + offset];
      if (!param || param.dotDotDotToken || isThisParam(param)) return;
      const list = bindings.get(param) ?? [];
      list.push({ expr: arg, file: f });
      bindings.set(param, list);
    });
  };
  const active = new Set<ts.Node>();
  const memo = new Set<string>();
  const nodeIds = new Map<ts.Node, number>();
  const idOf = (n: ts.Node): number => {
    if (!nodeIds.has(n)) nodeIds.set(n, nodeIds.size);
    return nodeIds.get(n)!;
  };

  const walkBody = (body: ts.Node, bodyFile: string, guards: readonly Guard[]): void => {
    const key = `${idOf(body)}|${guards.map((g) => idOf(g.expr)).join(',')}`;
    if (memo.has(key) || active.has(body)) return;
    memo.add(key);
    active.add(body);
    walk(body, bodyFile, guards);
    active.delete(body);
  };

  const walkStatements = (
    statements: readonly ts.Statement[],
    f: string,
    guards: readonly Guard[]
  ): void => {
    let g = guards;
    for (const st of statements) {
      walk(st, f, g);
      if (ts.isIfStatement(st)) {
        const reach = branchReach(st.expression, resourceType);
        if (reach) {
          // `if (resourceType === 'AWS::X') return ...` ends X's walk here.
          if (reach.then && !reach.else && alwaysExits(st.thenStatement)) return;
          continue;
        }
        // An early `return` guards what follows. An arm that only THROWS is a
        // refusal: what it reads can keep a change out of the branch, never
        // lead one into it.
        if (exitKind(st.thenStatement) === 'return' && !st.elseStatement) {
          g = [...g, { expr: st.expression, file: f }];
        }
      }
    }
  };

  const recordSite = (signal: Signal, node: ts.Node, f: string, guards: readonly Guard[]): void => {
    sites.push({ signal, file: f, fn: enclosingFunctionName(node), node, guards });
  };

  function walk(n: ts.Node, f: string, guards: readonly Guard[]): void {
    if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n)) {
      walkStatements(n.statements, f, guards);
      return;
    }
    if (ts.isCaseClause(n) || ts.isDefaultClause(n)) {
      walkStatements(n.statements, f, guards);
      return;
    }
    if (ts.isIfStatement(n) || ts.isConditionalExpression(n)) {
      const cond = ts.isIfStatement(n) ? n.expression : n.condition;
      const [whenTrue, whenFalse] = ts.isIfStatement(n)
        ? [n.thenStatement, n.elseStatement]
        : [n.whenTrue, n.whenFalse];
      const reach = branchReach(cond, resourceType);
      walk(cond, f, guards);
      if (reach) {
        if (reach.then) walk(whenTrue, f, guards);
        if (reach.else && whenFalse) walk(whenFalse, f, guards);
        return;
      }
      const inner = [...guards, { expr: cond, file: f }];
      walk(whenTrue, f, inner);
      if (whenFalse) walk(whenFalse, f, inner);
      return;
    }
    if (
      ts.isBinaryExpression(n) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(n.operatorToken.kind)
    ) {
      walk(n.left, f, guards);
      const reach = branchReach(n.left, resourceType);
      if (reach && !(n.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ? reach.then : reach.else)) {
        return;
      }
      walk(n.right, f, reach ? guards : [...guards, { expr: n.left, file: f }]);
      return;
    }
    if (ts.isSwitchStatement(n)) {
      const clauses = n.caseBlock.clauses;
      walk(n.expression, f, guards);
      if (isResourceTypeOperand(n.expression)) {
        const literalOf = (c: ts.CaseOrDefaultClause): string | null =>
          ts.isCaseClause(c) && ts.isStringLiteralLike(c.expression) && /^AWS::/.test(c.expression.text)
            ? c.expression.text
            : null;
        if (clauses.some((c) => literalOf(c) !== null)) {
          let start = clauses.findIndex((c) => literalOf(c) === resourceType);
          if (start < 0) start = clauses.findIndex((c) => ts.isDefaultClause(c));
          for (let i = Math.max(start, 0); start >= 0 && i < clauses.length; i++) {
            const st = clauses[i]!.statements;
            walkStatements(st, f, guards);
            const last = st[st.length - 1];
            if (last && (ts.isBreakStatement(last) || alwaysExits(last))) break;
          }
          return;
        }
      }
      for (const c of clauses) {
        const inner = [...guards, { expr: n.expression, file: f }];
        if (ts.isCaseClause(c)) inner.push({ expr: c.expression, file: f });
        walkStatements(c.statements, f, inner);
      }
      return;
    }
    if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
      walk(n.expression, f, guards);
      walk(n.statement, f, [...guards, { expr: n.expression, file: f }]);
      return;
    }
    if (ts.isWhileStatement(n) || ts.isDoStatement(n)) {
      walk(n.expression, f, guards);
      walk(n.statement, f, [...guards, { expr: n.expression, file: f }]);
      return;
    }
    if (ts.isForStatement(n)) {
      if (n.initializer) walk(n.initializer, f, guards);
      const inner = n.condition ? [...guards, { expr: n.condition, file: f }] : guards;
      walk(n.statement, f, inner);
      return;
    }
    if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'wasReplaced') {
      const init = unwrap(n.initializer);
      if (init.kind !== ts.SyntaxKind.FalseKeyword) {
        recordSite(
          'was-replaced',
          n,
          f,
          init.kind === ts.SyntaxKind.TrueKeyword ? guards : [...guards, { expr: init, file: f }]
        );
      }
      walk(n.initializer, f, guards);
      return;
    }
    if (ts.isShorthandPropertyAssignment(n) && n.name.text === 'wasReplaced') {
      recordSite('was-replaced', n, f, [...guards, { expr: n.name, file: f }]);
      return;
    }
    if (ts.isCallExpression(n)) {
      const own = ownCall(n);
      if (own !== null && createEntries.has(own.name)) {
        recordSite('own-create', n, f, guards);
        for (const a of n.arguments) walk(a, f, guards);
        return;
      }
      const callee = unwrap(n.expression);
      if (own !== null) {
        const target = resolveOwn(own.name, own.viaCall);
        if (target) {
          bindArgs(target.node, n.arguments, f, own.viaCall);
          walkBody(target.node, target.file, guards);
        } else if (!own.viaCall) unresolved.add(own.name);
      } else if (ts.isIdentifier(callee)) {
        const hit = index.resolve(f, callee.text);
        if (hit && !ts.isClassDeclaration(hit.node) && !hit.file.endsWith('.generated.ts')) {
          const body = bodyOf(hit.node);
          if (body && body !== hit.node) {
            bindArgs(body, n.arguments, f, false);
            walkBody(body, hit.file, guards);
          }
        }
      }
      walk(n.expression, f, guards);
      for (const a of n.arguments) walk(a, f, guards);
      return;
    }
    ts.forEachChild(n, (c) => walk(c, f, guards));
  }

  walkBody(update.node, update.file, []);
  return { hasUpdate: true, sites, unresolved, bindings };
}

// ---------------------------------------------------------------------------
// A guard's reads, grown through its data flow.
// ---------------------------------------------------------------------------

/** Every name `<expr>.Name`, `<expr>['Name']`, `'Name'` a guard's data flow reads. */
export function guardReads(
  guards: readonly Guard[],
  index: ModuleIndex,
  resolveOwn: OwnResolver,
  bindings: ParamBindings = new Map()
): Set<string> {
  const out = new Set<string>();
  const seen = new Set<ts.Node>();

  /** Where `id` is declared, walking out through the functions holding it. */
  const localSources = (id: ts.Identifier): { found: boolean; sources: ts.Node[]; bound?: readonly Guard[] } => {
    const name = id.text;
    for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
      if (!ts.isFunctionLike(p) && !ts.isSourceFile(p)) continue;
      if (ts.isSourceFile(p)) return { found: false, sources: [] };
      for (const param of p.parameters) {
        // A parameter reads what the walked callers passed for it.
        if (bindingHas(param.name, name)) return { found: true, sources: [], bound: bindings.get(param) ?? [] };
      }
      const sources: ts.Node[] = [];
      let declared = false;
      const scan = (n: ts.Node): void => {
        if (n !== p && ts.isFunctionLike(n) && !ts.isArrowFunction(n)) return;
        if (ts.isVariableDeclaration(n) && bindingHas(n.name, name)) {
          declared = true;
          if (ts.isIdentifier(n.name)) {
            if (n.initializer) sources.push(n.initializer);
            const loop = n.parent?.parent;
            if (loop && (ts.isForOfStatement(loop) || ts.isForInStatement(loop))) sources.push(loop.expression);
          } else {
            // Destructured: the key it is bound from is a read, and so is
            // what the value is computed from.
            for (const key of bindingKeys(n.name, name)) out.add(key);
            if (n.initializer) sources.push(n.initializer);
          }
        }
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          ts.isIdentifier(n.left) &&
          n.left.text === name
        ) {
          sources.push(n.right);
        }
        ts.forEachChild(n, scan);
      };
      if ('body' in p && p.body) scan(p.body);
      if (declared) return { found: true, sources };
    }
    return { found: false, sources: [] };
  };

  const visit = (n: ts.Node, f: string): void => {
    if (seen.has(n)) return;
    seen.add(n);
    if (ts.isPropertyAccessExpression(n)) {
      if (n.expression.kind === ts.SyntaxKind.ThisKeyword) {
        const target = resolveOwn(n.name.text, false);
        if (target) visit(target.node, target.file);
        return;
      }
      out.add(n.name.text);
      visit(n.expression, f);
      return;
    }
    if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) {
      out.add(n.argumentExpression.text);
      visit(n.expression, f);
      return;
    }
    if (ts.isStringLiteralLike(n)) {
      const p = n.parent;
      if (p && (ts.isImportDeclaration(p) || ts.isExportDeclaration(p))) return;
      out.add(n.text);
      return;
    }
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      // A name, not a reference.
      if (p && (ts.isPropertyAssignment(p) || ts.isPropertyAccessExpression(p)) && p.name === n) return;
      if (p && (ts.isVariableDeclaration(p) || ts.isParameter(p) || ts.isBindingElement(p)) && p.name === n) return;
      const local = localSources(n);
      if (local.found) {
        for (const s of local.sources) visit(s, f);
        for (const b of local.bound ?? []) visit(b.expr, b.file);
        return;
      }
      const hit = index.resolve(f, n.text);
      if (hit && !ts.isClassDeclaration(hit.node) && !hit.file.endsWith('.generated.ts')) {
        const decl = hit.node;
        if (ts.isVariableDeclaration(decl)) {
          if (decl.initializer) visit(decl.initializer, hit.file);
        } else {
          const body = bodyOf(decl);
          if (body) visit(body, hit.file);
        }
      }
      return;
    }
    ts.forEachChild(n, (c) => visit(c, f));
  };
  for (const g of guards) visit(g.expr, g.file);
  return out;
}

function bindingHas(name: ts.BindingName, wanted: string): boolean {
  if (ts.isIdentifier(name)) return name.text === wanted;
  return name.elements.some((el) => !ts.isOmittedExpression(el) && bindingHas(el.name, wanted));
}

/** For `{ A: x, B }` bound to `wanted`, the key(s) it reads from the object. */
function bindingKeys(name: ts.BindingName, wanted: string): string[] {
  if (ts.isIdentifier(name)) return [];
  const out: string[] = [];
  for (const el of name.elements) {
    if (ts.isOmittedExpression(el)) continue;
    if (bindingHas(el.name, wanted)) {
      if (ts.isObjectBindingPattern(name)) {
        const key = el.propertyName ?? (ts.isIdentifier(el.name) ? el.name : undefined);
        if (key && (ts.isIdentifier(key) || ts.isStringLiteralLike(key))) out.push(key.text);
      }
      out.push(...bindingKeys(el.name, wanted));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Classification.
// ---------------------------------------------------------------------------

export type Verdict = 'replacement' | 'conditional' | 'provider-marked' | 'exempt' | 'gap';

export interface TriggerRow {
  readonly property: string;
  readonly verdict: Verdict;
  /** For `replacement`: `rule` (replacementProperties) or `create-only` (schema). */
  readonly via?: 'rule' | 'create-only';
  /** For `exempt`: the {@link TriggerExemption} kind. */
  readonly exemption?: TriggerExemption['kind'];
  readonly rationale?: string;
}

export type SiteStatus = 'ok' | 'gap' | 'underived' | 'disposition-conflict';

export interface SiteRow {
  readonly key: string;
  readonly resourceType: string;
  readonly className: string;
  readonly file: string;
  readonly function: string;
  readonly signal: Signal;
  readonly disposition?: BranchDisposition;
  readonly triggers: readonly TriggerRow[];
  readonly status: SiteStatus;
}

export interface SchemaFacts {
  readonly properties: ReadonlySet<string>;
  readonly readOnly: ReadonlySet<string>;
  readonly createOnly: ReadonlySet<string>;
}

/**
 * What `cdkd diff` decides for a change of `prop`, in `DiffCalculator`'s
 * order. `providerMarked` is the type's `PROVIDER_REPLACEMENT_PLANNERS`
 * property list (`src/analyzer/diff-calculator/provider-replacement.ts`): the
 * diff marks such a change a replacement the provider performs, whatever the
 * rules say, unless the engine replaces it anyway.
 */
export function diffVerdict(
  prop: string,
  rules: RuleSets | undefined,
  schema: SchemaFacts,
  providerMarked: ReadonlySet<string> = new Set()
): {
  verdict: 'replacement' | 'conditional' | 'provider-marked' | 'update';
  via?: 'rule' | 'create-only';
} {
  if (rules?.replacement.has(prop)) return { verdict: 'replacement', via: 'rule' };
  const engine = rules?.updateable.has(prop)
    ? 'update'
    : rules?.conditional.has(prop)
      ? 'conditional'
      : schema.createOnly.has(prop)
        ? 'create-only'
        : 'update';
  if (engine === 'create-only') return { verdict: 'replacement', via: 'create-only' };
  if (providerMarked.has(prop)) return { verdict: 'provider-marked' };
  return { verdict: engine };
}

/**
 * `PROVIDER_REPLACEMENT_PLANNERS`' type -> property list, read from its
 * source. A table this cannot read REFUSES: a missed entry would only add
 * gaps, but a misread list would hide them.
 */
export function parseProviderMarks(source: string): Map<string, Set<string>> {
  const sf = ts.createSourceFile('provider-replacement.ts', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const fail = (what: string): never => {
    throw new Error(`provider-replacement marks: ${what}`);
  };
  let table: ts.Expression | undefined;
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === 'PROVIDER_REPLACEMENT_PLANNERS') {
      table = n.initializer;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (!table) return fail('PROVIDER_REPLACEMENT_PLANNERS not found');
  const map = unwrap(table);
  const arr = ts.isNewExpression(map) ? map.arguments?.[0] : undefined;
  if (!arr || !ts.isArrayLiteralExpression(arr)) return fail('expected new Map([...])');
  const out = new Map<string, Set<string>>();
  for (const el of arr.elements) {
    if (!ts.isArrayLiteralExpression(el) || el.elements.length !== 2) return fail(`unreadable entry ${el.getText().slice(0, 60)}`);
    const [typeLit, entry] = el.elements as unknown as [ts.Expression, ts.Expression];
    if (!ts.isStringLiteralLike(typeLit) || !ts.isObjectLiteralExpression(entry)) {
      return fail(`unreadable entry ${el.getText().slice(0, 60)}`);
    }
    const props = entry.properties.find(
      (p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === 'properties'
    );
    if (!props || !ts.isArrayLiteralExpression(props.initializer)) return fail(`${typeLit.text}: no literal properties list`);
    const names = new Set<string>();
    for (const p of props.initializer.elements) {
      if (!ts.isStringLiteralLike(p)) return fail(`${typeLit.text}: non-literal property ${p.getText().slice(0, 40)}`);
      names.add(p.text);
    }
    out.set(typeLit.text, names);
  }
  if (out.size === 0) return fail('parsed zero entries');
  return out;
}

/**
 * `<Type> <file>:<function> <signal>#<n>` — `n` counts the type's sites of
 * that signal in that function, in walk order (1-based).
 */
export const siteKey = (resourceType: string, file: string, fn: string, signal: Signal, n: number): string =>
  `${resourceType} ${file}:${fn} ${signal}#${n}`;

export interface ClassifyInput {
  readonly file: string;
  readonly companions: readonly string[];
  readonly index: ModuleIndex;
  readonly rules: ReadonlyMap<string, RuleSets>;
  /** {@link parseProviderMarks}' answer. */
  readonly providerMarks?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly schema: (resourceType: string) => SchemaFacts | null;
  readonly dispositions?: ReadonlyMap<string, BranchDisposition>;
  readonly notATrigger?: ReadonlyMap<string, TriggerExemption>;
  /** Repo-relative name for a file (rows carry it). */
  readonly display?: (file: string) => string;
}

export interface ClassifyOutput {
  readonly sites: SiteRow[];
  /** `Class (Type): this.x()` the walk could not resolve. BLOCKS CI. */
  readonly unresolved: string[];
}

export function classifyFile(input: ClassifyInput): ClassifyOutput {
  const { file, index, rules, schema } = input;
  const dispositions = input.dispositions ?? BRANCH_DISPOSITIONS;
  const notATrigger = input.notATrigger ?? NOT_A_TRIGGER;
  const display = input.display ?? ((f: string) => f);
  const sf = index.get(file)?.sf;
  if (!sf) throw new Error(`cannot read provider file ${display(file)}`);
  const companions = new Map<string, { file: string; fn: ts.FunctionDeclaration }>();
  for (const c of input.companions) {
    const mod = index.get(c);
    if (!mod) continue;
    for (const stmt of mod.sf.statements) {
      const first = ts.isFunctionDeclaration(stmt) ? stmt.parameters[0] : undefined;
      if (
        ts.isFunctionDeclaration(stmt) &&
        stmt.name &&
        stmt.body &&
        first !== undefined &&
        ts.isIdentifier(first.name) &&
        first.name.text === 'this'
      ) {
        companions.set(stmt.name.text, { file: c, fn: stmt });
      }
    }
  }
  const out: ClassifyOutput = { sites: [], unresolved: [] };
  const visit = (n: ts.Node): void => {
    if (ts.isClassDeclaration(n) && n.name) {
      const className = n.name.text;
      const handled = parseProviderSource(n.getText(), file).handled;
      const resolveOwn = ownResolver(classMembers(n, file, index), companions);
      for (const resourceType of [...handled.keys()].sort()) {
        const facts = schema(resourceType);
        if (!facts) throw new Error(`${resourceType} (${display(file)}) has no CFn schema fixture`);
        const walk = walkReplaceBranches({ cls: n, file, companions, index }, resourceType);
        if (!walk.hasUpdate) {
          throw new Error(
            `${className} (${display(file)}) handles ${resourceType} but no update() is declared on it ` +
              'or on a base class this script can resolve'
          );
        }
        for (const u of [...walk.unresolved].sort()) out.unresolved.push(`${className} (${resourceType}): this.${u}()`);
        const writable = [...facts.properties].filter((p) => !facts.readOnly.has(p)).sort();
        const counters = new Map<string, number>();
        const seenNodes = new Map<ts.Node, number>();
        // A site reached by two call paths is one site: merge its guards.
        const merged: { raw: RawSite; guards: Guard[] }[] = [];
        for (const raw of walk.sites) {
          const at = seenNodes.get(raw.node);
          if (at !== undefined) {
            merged[at]!.guards.push(...raw.guards);
            continue;
          }
          seenNodes.set(raw.node, merged.length);
          merged.push({ raw, guards: [...raw.guards] });
        }
        for (const { raw, guards } of merged) {
          const relFile = display(raw.file);
          const ck = `${relFile}:${raw.fn} ${raw.signal}`;
          const nth = (counters.get(ck) ?? 0) + 1;
          counters.set(ck, nth);
          const key = siteKey(resourceType, relFile, raw.fn, raw.signal, nth);
          const reads = guardReads(guards, index, resolveOwn, walk.bindings);
          const derived = writable.filter((p) => reads.has(p));
          const disposition = dispositions.get(key);
          let props: string[];
          if (disposition?.kind === 'every-property') props = writable;
          else if (disposition) props = [];
          else props = derived;
          const typeRules = rules.get(resourceType);
          const triggers: TriggerRow[] = props.map((p) => {
            const v = diffVerdict(p, typeRules, facts, input.providerMarks?.get(resourceType));
            const entry = notATrigger.get(triggerKey(resourceType, p));
            const exempt = entry?.at === `${relFile}:${raw.fn}` ? entry : undefined;
            // An exemption answers only for a read the diff would show as an
            // update; over a replacement it changes nothing.
            if (exempt !== undefined && v.verdict === 'update' && disposition?.kind !== 'every-property') {
              return { property: p, verdict: 'exempt', exemption: exempt.kind, rationale: exempt.rationale };
            }
            if (v.verdict === 'update') return { property: p, verdict: 'gap' };
            return v.via ? { property: p, verdict: v.verdict, via: v.via } : { property: p, verdict: v.verdict };
          });
          // A disposition saying no template change reaches the site holds
          // only while its guards read no property: a site that gains a
          // derived trigger (or a new site taking its key) is re-examined.
          const status: SiteStatus = triggers.some((t) => t.verdict === 'gap')
            ? 'gap'
            : disposition !== undefined && disposition.kind !== 'every-property' && derived.length > 0
              ? 'disposition-conflict'
              : derived.length === 0 && !disposition
                ? 'underived'
                : 'ok';
          out.sites.push({
            key,
            resourceType,
            className,
            file: relFile,
            function: raw.fn,
            signal: raw.signal,
            ...(disposition && { disposition }),
            triggers,
            status,
          });
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

export interface ReplaceBranchReport {
  readonly summary: {
    readonly sites: number;
    readonly types: number;
    readonly triggers: number;
    readonly replacement: number;
    readonly conditional: number;
    readonly providerMarked: number;
    readonly exempt: number;
    readonly gap: number;
    readonly underived: number;
    readonly disposed: number;
  };
  readonly sites: readonly SiteRow[];
}

export function buildReport(sites: readonly SiteRow[]): ReplaceBranchReport {
  // Code-unit order, not localeCompare: the committed table must not depend on
  // the runner's locale, or `--check` reads it as stale.
  const sorted = [...sites].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const all = sorted.flatMap((s) => s.triggers);
  const count = (v: Verdict): number => all.filter((t) => t.verdict === v).length;
  return {
    summary: {
      sites: sorted.length,
      types: new Set(sorted.map((s) => s.resourceType)).size,
      triggers: all.length,
      replacement: count('replacement'),
      conditional: count('conditional'),
      providerMarked: count('provider-marked'),
      exempt: count('exempt'),
      gap: count('gap'),
      underived: sorted.filter((s) => s.status === 'underived').length,
      disposed: sorted.filter((s) => s.disposition !== undefined).length,
    },
    sites: sorted,
  };
}

/** `Type#Prop (site key)` for every trigger the diff classifies as an update. BLOCKS CI. */
export function findGaps(report: ReplaceBranchReport): string[] {
  return report.sites.flatMap((s) =>
    s.triggers.filter((t) => t.verdict === 'gap').map((t) => `${triggerKey(s.resourceType, t.property)} (${s.key})`)
  );
}

/** Sites with no derived trigger and no disposition. BLOCKS CI. */
export function findUnderived(report: ReplaceBranchReport): string[] {
  return report.sites.filter((s) => s.status === 'underived').map((s) => s.key);
}

/**
 * Sites recorded as reached by no template change (or decided at run time)
 * whose guards now read a property. BLOCKS CI.
 */
export function findDispositionConflicts(report: ReplaceBranchReport): string[] {
  return report.sites.filter((s) => s.status === 'disposition-conflict').map((s) => s.key);
}

/** Disposition / exemption keys that no longer name a site / an exempt trigger row. */
export function findStaleEntries(
  report: ReplaceBranchReport,
  dispositions: ReadonlyMap<string, BranchDisposition> = BRANCH_DISPOSITIONS,
  notATrigger: ReadonlyMap<string, TriggerExemption> = NOT_A_TRIGGER
): string[] {
  const keys = new Set(report.sites.map((s) => s.key));
  const exempt = new Set(
    report.sites.flatMap((s) =>
      s.triggers.filter((t) => t.verdict === 'exempt').map((t) => triggerKey(s.resourceType, t.property))
    )
  );
  return [
    ...[...dispositions.keys()].filter((k) => !keys.has(k)).map((k) => `BRANCH_DISPOSITIONS: ${k}`),
    ...[...notATrigger.keys()].filter((k) => !exempt.has(k)).map((k) => `NOT_A_TRIGGER: ${k}`),
  ].sort();
}

function loadSchema(resourceType: string): SchemaFacts | null {
  const path = join(FIXTURE_DIR, `${resourceType.replace(/::/g, '-')}.json`);
  if (!existsSync(path)) return null;
  const f = JSON.parse(readFileSync(path, 'utf8')) as {
    properties: string[];
    readOnlyProperties: string[];
    createOnlyProperties?: string[];
  };
  return {
    properties: new Set(f.properties),
    readOnly: new Set(f.readOnlyProperties),
    createOnly: new Set(f.createOnlyProperties ?? []),
  };
}

const diskHost: SourceHost = {
  read: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null),
};

export interface LoadedReport {
  readonly report: ReplaceBranchReport;
  readonly unresolved: string[];
}

/** The table as `gen:provider-replace-branches` builds it from the real tree. */
export function loadReport(host: SourceHost = diskHost): LoadedReport {
  const index = new ModuleIndex(host);
  const rules = parseReplacementRules(readFileSync(RULES_FILE, 'utf8'));
  const providerMarks = parseProviderMarks(readFileSync(PROVIDER_MARK_FILE, 'utf8'));
  const sites: SiteRow[] = [];
  const unresolved: string[] = [];
  for (const name of readdirSync(PROVIDERS_DIR).sort()) {
    if (!name.endsWith('.ts') || name.endsWith('.d.ts') || name.endsWith('.test.ts')) continue;
    const file = join(PROVIDERS_DIR, name);
    const out = classifyFile({
      file,
      companions: companionFiles(file),
      index,
      rules,
      providerMarks,
      schema: loadSchema,
      display: (f) => relative(repoRoot, f),
    });
    sites.push(...out.sites);
    unresolved.push(...out.unresolved);
  }
  return { report: buildReport(sites), unresolved };
}

export function renderMarkdown(report: ReplaceBranchReport): string {
  const s = report.summary;
  const lines: string[] = [
    '---',
    'title: "Provider replace-branch matrix"',
    'unlisted: true',
    '---',
    '',
    '# SDK-provider update() replace-branch matrix',
    '',
    '<!-- AUTO-GENERATED by scripts/gen-provider-replace-branches.ts — DO NOT EDIT BY HAND. -->',
    '<!-- Regenerate: `vp run gen:provider-replace-branches`. -->',
    '',
    'Every place an SDK provider\'s `update()` replaces the resource (a `wasReplaced` answer, ' +
      'or a call of its own create path), the property changes that lead into it, and what ' +
      '`cdkd diff` shows for each. A change the diff shows as an update while the deploy ' +
      'replaces is a gap (issue #6656).',
    '',
    '## Summary',
    '',
    `- Replace sites: **${s.sites}** over **${s.types}** types`,
    `- Triggers classified: **${s.triggers}**`,
    `- Replacement in the diff: **${s.replacement}**`,
    `- Conditional replacement in the diff: **${s.conditional}**`,
    `- Marked as a provider replacement in the diff: **${s.providerMarked}**`,
    `- Exempt (not a trigger, does NOT block CI): **${s.exempt}**`,
    `- Sites with a recorded disposition: **${s.disposed}**`,
    `- **Gaps (blocks CI): ${s.gap}**`,
    `- **Underived sites (blocks CI): ${s.underived}**`,
    '',
    '## Sites',
    '',
    '| Type | Site | Signal | Triggers | Disposition |',
    '| --- | --- | --- | --- | --- |',
  ];
  const verdictText = (t: TriggerRow): string =>
    `${t.property} (${t.verdict === 'replacement' ? `replacement: ${t.via}` : t.verdict})`;
  for (const site of report.sites) {
    const disposition = site.disposition ? `${site.disposition.kind}: ${site.disposition.rationale}` : '';
    lines.push(
      `| \`${site.resourceType}\` | \`${site.file}:${site.function}\` | ${site.signal} | ${escapeCell(
        site.triggers.map(verdictText).join(', ')
      )} | ${escapeCell(disposition)} |`
    );
  }
  const exempt = report.sites.flatMap((site) =>
    site.triggers.filter((t) => t.verdict === 'exempt').map((t) => ({ site, t }))
  );
  if (exempt.length > 0) {
    lines.push(
      '',
      '## Exempt reads',
      '',
      '| Type | Property | Kind | Rationale |',
      '| --- | --- | --- | --- |'
    );
    const seen = new Set<string>();
    for (const { site, t } of exempt) {
      const k = triggerKey(site.resourceType, t.property);
      if (seen.has(k)) continue;
      seen.add(k);
      lines.push(
        `| \`${site.resourceType}\` | \`${t.property}\` | ${t.exemption ?? ''} | ${escapeCell(t.rationale ?? '')} |`
      );
    }
  }
  lines.push('');
  return lines.join('\n');
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export const serializeReport = (report: ReplaceBranchReport): string => JSON.stringify(report, null, 2) + '\n';

function main(): void {
  const { report, unresolved } = loadReport();
  const json = serializeReport(report);
  const md = renderMarkdown(report) + '\n';
  if (process.argv.includes('--check')) {
    const gaps = findGaps(report);
    const underived = findUnderived(report);
    const conflicts = findDispositionConflicts(report);
    const stale = findStaleEntries(report);
    const staleFiles = [
      [OUT_JSON, json],
      [OUT_MD, md],
    ]
      .filter(([path, content]) => !existsSync(path!) || readFileSync(path!, 'utf8') !== content)
      .map(([path]) => relative(repoRoot, path!));
    if (gaps.length + underived.length + conflicts.length + stale.length + unresolved.length + staleFiles.length > 0) {
      process.stderr.write(
        'provider-replace-branches: FAIL\n' +
          (gaps.length > 0
            ? 'A provider update() replaces the resource for a change cdkd diff shows as an\n' +
              'update, so a user approves a replacement they were never shown (#6656). Add a\n' +
              'replacement rule (src/analyzer/replacement-rules/rules.ts), update in place\n' +
              'where AWS allows it, or — when the read does not lead into the branch — a\n' +
              'NOT_A_TRIGGER entry with a reason in scripts/gen-provider-replace-branches.ts.\n' +
              gaps.map((g) => `  gap: ${g}\n`).join('')
            : '') +
          (underived.length > 0
            ? 'Replace sites whose guards read no property — record which changes reach them\n' +
              'in BRANCH_DISPOSITIONS:\n' +
              underived.map((u) => `  underived: ${u}\n`).join('')
            : '') +
          (conflicts.length > 0
            ? 'Sites whose BRANCH_DISPOSITIONS entry says no template change reaches them, while\n' +
              'their guards now read a property — re-examine them:\n' +
              conflicts.map((c) => `  conflict: ${c}\n`).join('')
            : '') +
          (stale.length > 0 ? 'Stale entries — delete them:\n' + stale.map((g) => `  stale: ${g}\n`).join('') : '') +
          (unresolved.length > 0
            ? 'update() reaches this.x() calls that resolve to nothing, so the code behind them is unseen:\n' +
              unresolved.map((u) => `  unresolved: ${u}\n`).join('')
            : '') +
          (staleFiles.length > 0
            ? 'Generated files are stale — run `vp run gen:provider-replace-branches`:\n' +
              staleFiles.map((f) => `  stale file: ${f}\n`).join('')
            : '')
      );
      process.exit(1);
    }
    process.stderr.write(
      `provider-replace-branches: OK — ${report.summary.sites} replace sites over ` +
        `${report.summary.types} types, ${report.summary.triggers} triggers, 0 gaps.\n`
    );
    return;
  }
  mkdirSync(dirname(OUT_JSON), { recursive: true });
  atomicWrite(OUT_JSON, json);
  atomicWrite(OUT_MD, md);
  process.stderr.write(
    `provider-replace-branches: wrote provider-replace-branches.{json,md} — ${report.summary.sites} ` +
      `sites, ${report.summary.triggers} triggers, ${report.summary.gap} gap(s), ` +
      `${report.summary.underived} underived.\n`
  );
}

const isMainModule = (): boolean => Boolean(process.argv[1]) && resolve(process.argv[1]!) === __filename;

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`provider-replace-branches: failed — ${(err as Error).message}\n`);
    process.exit(1);
  }
}
