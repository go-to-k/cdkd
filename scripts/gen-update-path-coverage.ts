/**
 * Codegen + CI critic: does every SDK provider's `update()` path reach each
 * property it handles? (issue #6611)
 *
 * THE GAP THIS CLOSES
 * -------------------
 * The most common `severity:high` class of late 2026-10 was an update that
 * silently never reaches AWS: the provider writes a property on create, the
 * diff shows the change, the deploy reports success, and AWS keeps the old
 * value (#5140, #5299, #5313, #5354, #5357, #5365, #5438, #5446). The property
 * coverage (`gen-property-coverage.ts`) records what create OR update writes,
 * so it cannot tell the update path apart.
 *
 * CLASSIFICATION (per SDK provider type x handled top-level property)
 * -------------------------------------------------------------------
 *   - update        — a read of the property on the `update()` path reaches
 *                     an EFFECT: it is sent, its change is refused
 *                     (`ResourceUpdateNotSupportedError`, which the deploy
 *                     engine turns into a replacement), or it is warned about.
 *                     The three are not told apart; each means the change is
 *                     not dropped silently.
 *   - replacement   — the diff replaces the resource for any change of it:
 *                     `replacementProperties` in cdkd's replacement rules
 *                     (`src/analyzer/replacement-rules/rules.ts`), or
 *                     create-only in the committed CFn schema while the rules
 *                     neither mark it updateable nor give it a conditional
 *                     predicate (`DiffCalculator`'s fallback order). A
 *                     CONDITIONAL replacement is not one: its in-place branch
 *                     still needs the update path.
 *   - allow-listed  — an {@link UPDATE_PATH_ALLOW_LIST} entry with its reason.
 *   - gap           — none of the above: a change would be dropped silently.
 *                     BLOCKS CI.
 * A `this.x()` call the walk cannot resolve also BLOCKS CI: the code behind it
 * is unseen, so the row's verdicts would rest on a partial read.
 *
 * WHAT IS WALKED (offline, TypeScript AST)
 * ----------------------------------------
 * From `update()`, transitively: `this.x` to class members and resolvable
 * base classes; `fn.call(this, ...)` and `this.x()` mixins to companion-file
 * `this:` functions (`scripts/provider-companion-files.ts`); any identifier
 * resolving to a module-level function or variable of its file, or to a
 * relative `import` under `src/`. Not walked: other classes (SDK clients, the
 * logger, `ReplacementRulesRegistry`), `*.generated.ts` modules, and the
 * declarative provider tables (DECLARATIVE_FIELDS), each of which names
 * properties without acting on them.
 *
 * WHEN A READ COUNTS (an effect position)
 * ---------------------------------------
 * A read is `<expr>.Prop`, `<expr>['Prop']`, a destructured `{ Prop }`, or the
 * string `'Prop'` anywhere but an object-literal key. It counts only in an
 * effect position:
 *   - inside a `new XCommand(...)`, `.send(...)`, `waitUntil*(...)`,
 *     `new ResourceUpdateNotSupportedError(...)` or `.warn(...)`;
 *   - in an argument a resolvable callee hands on to an effect itself (per
 *     PARAMETER, from the callee's own body), or any argument of a call that
 *     is a sink, takes a callback holding one, or is the value of an effect;
 *   - in the condition of an `if` / loop / `?:` / `&&` guarding a branch the
 *     type can take that sends or refuses — or warns, unless that branch is an
 *     early `return` (a "nothing to do" path);
 *   - in the value of a local that reaches an effect position (grown to a
 *     fixpoint), including a request local a helper fills: the parameter it
 *     binds is seeded as consumed in that helper;
 *   - for `const { a } = helper()`, only under the returned keys used.
 * A table under a negation in a guard (`!MUTABLE.has(key)`) and a string
 * compared with `!==` there name what the guarded refusal EXEMPTS: not reads.
 * So a property read only by change detection or validation (a `changed('X')`
 * flag that guards nothing that sends, a `typeof` refusal of a malformed
 * value) is a gap.
 *
 * A class handling several types is narrowed per type: an `if` / `switch` /
 * `?:` (through `&&` / `||`) comparing `resourceType` with an `'AWS::X::Y'`
 * literal walks only the branches the type can take, an early `return` on
 * such a test ends that type's walk of the block, and `TABLE[resourceType]` /
 * `MAP.get(resourceType)` over a literal keyed table walks only the entry.
 *
 * BOUNDS
 * ------
 * Positions, not values: a read in an effect position need not be what the
 * effect carries (a same-named field of an AWS response, a property only
 * interpolated into a warning). A call whose result an effect consumes walks
 * its callee whole. A callee's parameters are judged per call site but not
 * per path inside it. Only TOP-LEVEL properties are classified: a nested
 * member an update drops (#5365's replica settings) is out of reach; the
 * sdk-wire harness (`tests/unit/provisioning/sdk-wire-*.ts`) pins what a call
 * carries.
 *
 * Writes `docs/_generated/update-path-coverage.{json,md}`; `--check` fails on
 * any `gap` and on a stale allow-list entry (one whose property is no longer a
 * gap), so a fix has to delete its entry and the critic then pins it.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-update-path-coverage.ts          # write the matrix
 *   node --experimental-strip-types scripts/gen-update-path-coverage.ts --check  # fail on a gap
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// `typescript-v6` is an npm alias of typescript@6 — TS7 no longer ships the
// stable JS compiler API (see the note in gen-property-coverage.ts).
import ts from 'typescript-v6';
import { parseProviderSource } from './gen-property-coverage.ts';
import { escapeCell } from './markdown-table.ts';
import { companionFiles } from './provider-companion-files.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const PROVIDERS_DIR = resolve(repoRoot, 'src/provisioning/providers');
const FIXTURE_DIR = resolve(repoRoot, 'tests/fixtures/cfn-schemas');
const RULES_FILE = resolve(repoRoot, 'src/analyzer/replacement-rules/rules.ts');
const OUT_JSON = resolve(repoRoot, 'docs/_generated/update-path-coverage.json');
const OUT_MD = resolve(repoRoot, 'docs/_generated/update-path-coverage.md');

export interface AllowListEntry {
  readonly rationale: string;
}

/**
 * `AWS::X::Y#Prop` -> why the update path deliberately does not read it.
 * Every entry must still be a gap: `--check` refuses a stale one.
 *
 * Three kinds, each a change that has nothing to send:
 *   - DELETE-TIME input: read by `delete()` from the record, which the update
 *     rewrites, so the next delete honours the new value — as CloudFormation's
 *     delete handler reads its model.
 *   - CREATE-TIME input with no update member, where CloudFormation's update
 *     also leaves the resource as it is (measured where the reason says so).
 *   - REFUSED by a shape this walk cannot attribute to one property.
 */
const DELETE_TIME = (reader: string): AllowListEntry => ({
  rationale: `delete-time input: ${reader} reads it from the record the update rewrites`,
});
export const UPDATE_PATH_ALLOW_LIST: ReadonlyMap<string, AllowListEntry> = new Map<
  string,
  AllowListEntry
>([
  ['AWS::AppConfig::Environment#DeletionProtectionCheck', DELETE_TIME('DeleteEnvironment (#5875)')],
  ['AWS::ECR::Repository#EmptyOnDelete', DELETE_TIME("DeleteRepository's force flag (#1340)")],
  ['AWS::KMS::Key#PendingWindowInDays', DELETE_TIME('ScheduleKeyDeletion')],
  [
    'AWS::ApiGateway::RestApi#CloneFrom',
    {
      rationale:
        'create-time input: CreateRestApi clones from it and no UpdateRestApi patch path takes it; ' +
        'CloudFormation documents No interruption (unmeasured)',
    },
  ],
  [
    'AWS::CodeCommit::Repository#Code',
    {
      rationale:
        'create-time seed commit: CloudFormation documents that Code is used only at creation and ' +
        'ignored on update',
    },
  ],
  ...['RestoreToTime', 'RestoreType', 'UseLatestRestorableTime'].map(
    (p): [string, AllowListEntry] => [
      `AWS::DocDB::DBCluster#${p}`,
      {
        rationale:
          "restore-time input read by the create alone; CloudFormation's update sends nothing for it " +
          '(measured, #5628)',
      },
    ]
  ),
  ...['Domain', 'PublicIpv4Pool'].map((p): [string, AllowListEntry] => [
    `AWS::EC2::EIP#${p}`,
    {
      rationale:
        'no EC2 call moves an allocated address; CloudFormation neither replaces nor changes it ' +
        '(measured, #5449)',
    },
  ]),
  ...['AdditionalInfo', 'PropagateTagsToVolumeOnCreation'].map((p): [string, AllowListEntry] => [
    `AWS::EC2::Instance#${p}`,
    {
      rationale: 'applied at launch only; a change to a running instance changes nothing (measured, #5630)',
    },
  ]),
  [
    'AWS::Events::EventBus#EventSourceName',
    {
      rationale:
        'create-time partner-source binding: UpdateEventBus has no such member; CloudFormation ' +
        'documents No interruption (unmeasured)',
    },
  ],
  [
    'AWS::Glue::Trigger#StartOnCreation',
    {
      rationale:
        'create-time action: TriggerUpdate has no such member; CloudFormation documents No ' +
        'interruption (unmeasured)',
    },
  ],
  [
    'AWS::RDS::DBCluster#MasterUsername',
    {
      rationale:
        'ModifyDBCluster has no such member; CloudFormation completes the update in place and keeps ' +
        'the old user (measured, #5467)',
    },
  ],
  [
    'AWS::ECS::TaskDefinition#TrustedExecutionConfiguration',
    {
      rationale:
        "refused: updateTaskDefinition refuses every changed key but Tags through a loop over the bag's " +
        'keys, which names no property (#6301)',
    },
  ],
  [
    'AWS::CloudFormation::Stack#TemplateURL',
    {
      rationale:
        "informational: the update deploys the child from the assembly's local template " +
        "(Metadata['aws:asset:path']), so a changed child template is applied without reading the URL",
    },
  ],
  [
    'AWS::Glue::SecurityConfiguration#EncryptionConfiguration',
    {
      rationale:
        'refused: the update refuses every change with ResourceUpdateNotSupportedError, as Glue has no ' +
        'UpdateSecurityConfiguration',
    },
  ],
]);

export const allowKey = (resourceType: string, prop: string): string => `${resourceType}#${prop}`;

// ---------------------------------------------------------------------------
// Module index: the declarations an identifier in walked code can resolve to.
// ---------------------------------------------------------------------------

interface ModuleInfo {
  readonly file: string;
  readonly sf: ts.SourceFile;
  /** Module-level function / variable declarations by name. */
  readonly decls: Map<string, ts.Node>;
  /** Local import name -> the resolved module file and the imported name. */
  readonly imports: Map<string, { file: string; name: string }>;
}

/** A source loader, injectable so unit tests run on in-memory files. */
export interface SourceHost {
  read(file: string): string | null;
}

const diskHost: SourceHost = {
  read: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null),
};

/** `./x.js` from `from` -> the `.ts` file it names, or null outside the host. */
function resolveImport(from: string, spec: string, host: SourceHost): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(from), spec);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    `${base}.ts`,
    join(base.replace(/\.js$/, ''), 'index.ts'),
  ];
  for (const c of candidates) if (host.read(c) !== null) return c;
  return null;
}

export class ModuleIndex {
  private readonly cache = new Map<string, ModuleInfo | null>();
  private readonly host: SourceHost;
  constructor(host: SourceHost = diskHost) {
    this.host = host;
  }

  get(file: string): ModuleInfo | null {
    if (this.cache.has(file)) return this.cache.get(file)!;
    const text = this.host.read(file);
    if (text === null) {
      this.cache.set(file, null);
      return null;
    }
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const decls = new Map<string, ts.Node>();
    const imports = new Map<string, { file: string; name: string }>();
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) decls.set(stmt.name.text, stmt);
      else if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name)) decls.set(d.name.text, d);
        }
      } else if (ts.isClassDeclaration(stmt) && stmt.name) decls.set(stmt.name.text, stmt);
      else if (
        ts.isImportDeclaration(stmt) &&
        ts.isStringLiteral(stmt.moduleSpecifier) &&
        stmt.importClause &&
        !stmt.importClause.isTypeOnly
      ) {
        const target = resolveImport(file, stmt.moduleSpecifier.text, this.host);
        if (target === null) continue;
        const bindings = stmt.importClause.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            if (el.isTypeOnly) continue;
            imports.set(el.name.text, {
              file: target,
              name: (el.propertyName ?? el.name).text,
            });
          }
        }
      } else if (
        ts.isExportDeclaration(stmt) &&
        stmt.moduleSpecifier &&
        ts.isStringLiteral(stmt.moduleSpecifier) &&
        stmt.exportClause &&
        ts.isNamedExports(stmt.exportClause)
      ) {
        // `export { a as b } from './x.js'`: a re-export is resolvable through.
        const target = resolveImport(file, stmt.moduleSpecifier.text, this.host);
        if (target === null) continue;
        for (const el of stmt.exportClause.elements) {
          imports.set(el.name.text, { file: target, name: (el.propertyName ?? el.name).text });
        }
      }
    }
    const info: ModuleInfo = { file, sf, decls, imports };
    this.cache.set(file, info);
    return info;
  }

  /** The declaration `name` resolves to in `file`, following imports. */
  resolve(file: string, name: string, depth = 0): { file: string; node: ts.Node } | null {
    if (depth > 8) return null;
    const mod = this.get(file);
    if (!mod) return null;
    const local = mod.decls.get(name);
    if (local) return { file, node: local };
    const imp = mod.imports.get(name);
    if (imp) return this.resolve(imp.file, imp.name, depth + 1);
    return null;
  }
}

// ---------------------------------------------------------------------------
// The update-path walk.
// ---------------------------------------------------------------------------

/**
 * Is `e` the resource type under update — the `resourceType` parameter (or a
 * `type` alias)? Narrowing keys on this name only: an `'AWS::X::Y'` compared
 * with anything else (a referenced resource's `Type`) says nothing about which
 * type this update serves, and narrowing on it would skip a live branch.
 */
function isResourceTypeOperand(e: ts.Expression): boolean {
  const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
  return name === 'resourceType' || name === 'type';
}

/** The `'AWS::X::Y'` literal the resource type is compared against, with polarity. */
function typeComparison(expr: ts.Expression): { literal: string; equal: boolean } | null {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isBinaryExpression(e)) return null;
  const op = e.operatorToken.kind;
  const equal =
    op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
  const notEqual =
    op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
  if (!equal && !notEqual) return null;
  for (const [lit, other] of [
    [e.left, e.right],
    [e.right, e.left],
  ] as const) {
    if (
      ts.isStringLiteralLike(lit) &&
      /^AWS::[\w]+::[\w]+$/.test(lit.text) &&
      isResourceTypeOperand(other)
    ) {
      return { literal: lit.text, equal };
    }
  }
  return null;
}

/**
 * Which branches of a condition the type under classification can take, or
 * null when the condition does not test the resource type. `&&` / `||` chains
 * narrow through a resource-type comparison in either operand.
 */
function branchReach(
  expr: ts.Expression,
  resourceType: string
): { then: boolean; else: boolean } | null {
  let e = expr;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  const cmp = typeComparison(e);
  if (cmp) {
    const match = (cmp.literal === resourceType) === cmp.equal;
    return { then: match, else: !match };
  }
  if (!ts.isBinaryExpression(e)) return null;
  const op = e.operatorToken.kind;
  if (op !== ts.SyntaxKind.AmpersandAmpersandToken && op !== ts.SyntaxKind.BarBarToken) return null;
  const left = branchReach(e.left, resourceType);
  const right = branchReach(e.right, resourceType);
  if (!left && !right) return null;
  const any = { then: true, else: true };
  const l = left ?? any;
  const r = right ?? any;
  return op === ts.SyntaxKind.AmpersandAmpersandToken
    ? { then: l.then && r.then, else: l.else || r.else }
    : { then: l.then || r.then, else: l.else && r.else };
}

/** Does a case clause's statement list end the switch (a braced body included)? */
function endsClause(statements: ts.NodeArray<ts.Statement> | readonly ts.Statement[]): boolean {
  const last = statements[statements.length - 1];
  if (!last) return false;
  if (ts.isBlock(last)) return endsClause(last.statements);
  // `if (...) return a; else return b;`: ends only when BOTH arms do.
  if (ts.isIfStatement(last)) {
    return (
      last.elseStatement !== undefined &&
      endsClause([last.thenStatement]) &&
      endsClause([last.elseStatement])
    );
  }
  return ts.isBreakStatement(last) || ts.isReturnStatement(last) || ts.isThrowStatement(last);
}

/**
 * Is `this.x` invoked or handed on as a function here: `this.x()`, or
 * `this.x.call(...)` / `.apply(...)` / `.bind(...)`?
 */
function isInvokedOrBound(n: ts.PropertyAccessExpression): boolean {
  const p = n.parent;
  if (ts.isCallExpression(p) && p.expression === n) return true;
  return (
    ts.isPropertyAccessExpression(p) &&
    p.expression === n &&
    ['call', 'apply', 'bind'].includes(p.name.text)
  );
}

/** Is `node` an object-literal KEY (a name, not a read)? */
function isObjectLiteralKey(node: ts.Node): boolean {
  const p = node.parent;
  if (!p) return false;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p)) && p.name === node) return true;
  if (ts.isPropertyDeclaration(p) && p.name === node) return true;
  return false;
}

export interface WalkInput {
  readonly cls: ts.ClassDeclaration;
  readonly file: string;
  /** `this:`-typed companion functions by name, with their file. */
  readonly companions: ReadonlyMap<string, { file: string; fn: ts.FunctionDeclaration }>;
  readonly index: ModuleIndex;
}

export interface WalkOutput {
  /** Every name the update path reads (see the file header). */
  readonly reads: ReadonlySet<string>;
  /** False when neither the class nor a resolvable base declares `update`. */
  readonly hasUpdate: boolean;
  /**
   * `this.x(...)` calls reached from `update()` that resolve to no member, no
   * base-class member and no companion function. What runs behind one is
   * invisible, so a property read only there would be a false gap — and, the
   * other way, a confident classification would rest on code never seen.
   */
  readonly unresolved: ReadonlySet<string>;
}

/**
 * Provider fields that DECLARE property names rather than act on them: the
 * coverage tables (`handledProperties` lists every property, and two update
 * paths iterate it for a no-op check) and the removal tables, which assert
 * what update() does on a removal. Walking one would count every name it
 * lists as read, so a claim would stand in for the code it describes.
 */
const DECLARATIVE_FIELDS: ReadonlySet<string> = new Set([
  'handledProperties',
  'unhandledByDesign',
  'removalDefaults',
  'removalHandledInUpdate',
]);

/**
 * The callable / initialised members of `cls` and of every base class it
 * `extends` that resolves through the module index, nearest declaration
 * first, each with the file its body must resolve identifiers in.
 */
function classMembers(
  cls: ts.ClassDeclaration,
  file: string,
  index: ModuleIndex
): Map<string, { node: ts.Node; file: string }> {
  const out = new Map<string, { node: ts.Node; file: string }>();
  let current: { cls: ts.ClassDeclaration; file: string } | null = { cls, file };
  for (let depth = 0; current && depth < 8; depth++) {
    for (const m of current.cls.members) {
      if (!m.name || !ts.isIdentifier(m.name) || out.has(m.name.text)) continue;
      if (DECLARATIVE_FIELDS.has(m.name.text)) continue;
      const body =
        ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m)
          ? m.body
          : ts.isPropertyDeclaration(m)
            ? m.initializer
            : undefined;
      if (body) out.set(m.name.text, { node: body, file: current.file });
    }
    const ext: ts.HeritageClause | undefined = current.cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword);
    const base: ts.Expression | undefined = ext?.types[0]?.expression;
    const hit: { file: string; node: ts.Node } | null =
      base && ts.isIdentifier(base) ? index.resolve(current.file, base.text) : null;
    current = hit && ts.isClassDeclaration(hit.node) ? { cls: hit.node, file: hit.file } : null;
  }
  return out;
}

/** What a subtree can do, following the calls it makes. */
interface Effect {
  /** Sends to AWS (`new XCommand`, `.send`, `waitUntil*`) or refuses (`ResourceUpdateNotSupportedError`). */
  readonly hard: boolean;
  /** Warns (`.warn(...)`, `replayWarn(...)`, a local `warn(...)`). */
  readonly warn: boolean;
}
const NO_EFFECT: Effect = { hard: false, warn: false };
const orEffect = (a: Effect, b: Effect): Effect => ({ hard: a.hard || b.hard, warn: a.warn || b.warn });

/** The sink a call or `new` is, if any. */
function sinkOf(n: ts.Node): Effect | null {
  if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) {
    const name = n.expression.text;
    if (/Command$/.test(name) || name === 'ResourceUpdateNotSupportedError') {
      return { hard: true, warn: false };
    }
  }
  if (ts.isCallExpression(n)) {
    const callee = n.expression;
    const name = ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : ts.isIdentifier(callee)
        ? callee.text
        : null;
    if (name === 'send' && ts.isPropertyAccessExpression(callee)) return { hard: true, warn: false };
    if (name !== null && /^waitUntil[A-Z]/.test(name)) return { hard: true, warn: false };
    if (name === 'warn' || name === 'replayWarn') return { hard: false, warn: true };
  }
  return null;
}

/** Does a statement list end by leaving the function (an early `return`)? */
function exitsEarly(node: ts.Node): boolean {
  const statements = ts.isBlock(node) ? node.statements : [node as ts.Statement];
  const last = statements[statements.length - 1];
  return last !== undefined && ts.isReturnStatement(last);
}

/** The local variable / parameter an assignment target or receiver is rooted in. */
function rootName(e: ts.Expression): string | null {
  let cur: ts.Expression = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur) || ts.isAsExpression(cur)) {
      cur = cur.expression;
    } else if (ts.isPropertyAccessExpression(cur) || ts.isElementAccessExpression(cur)) {
      cur = cur.expression;
    } else break;
  }
  return ts.isIdentifier(cur) ? cur.text : null;
}

/** Names a binding (identifier or destructuring pattern) introduces. */
function boundNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((el) => (ts.isOmittedExpression(el) ? [] : boundNames(el.name)));
}

const isAssignment = (n: ts.Node): n is ts.BinaryExpression =>
  ts.isBinaryExpression(n) &&
  n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
  n.operatorToken.kind <= ts.SyntaxKind.LastAssignment;

/** A mutating call on a local collection: `ops.push(x)`, `m.set(k, v)`, `Object.assign(t, x)`. */
function mutatedRoot(n: ts.CallExpression): string | null {
  const callee = n.expression;
  if (!ts.isPropertyAccessExpression(callee)) return null;
  if (['push', 'unshift', 'set', 'add', 'splice'].includes(callee.name.text)) {
    return rootName(callee.expression);
  }
  if (callee.name.text === 'assign' && callee.expression.getText() === 'Object' && n.arguments[0]) {
    return rootName(n.arguments[0]);
  }
  return null;
}

/** Walk `update()` of one class for one resource type. */
export function walkUpdatePath(input: WalkInput, resourceType: string): WalkOutput {
  const { cls, file, companions, index } = input;
  const members = classMembers(cls, file, index);
  const update = members.get('update');
  const unresolved = new Set<string>();
  if (!update) return { reads: new Set(), hasUpdate: false, unresolved };

  const reads = new Set<string>();

  /** The declaration a callee or reference resolves to, with its file. */
  const resolveTarget = (n: ts.Node, nodeFile: string): { node: ts.Node; file: string } | null => {
    if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const member = members.get(n.name.text);
      if (member) return member;
      const comp = companions.get(n.name.text);
      return comp?.fn.body ? { node: comp.fn.body, file: comp.file } : null;
    }
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'call' &&
      n.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword
    ) {
      let target: ts.Expression = n.expression.expression;
      while (ts.isParenthesizedExpression(target)) target = target.expression;
      if (ts.isExpressionWithTypeArguments(target)) target = target.expression;
      if (ts.isIdentifier(target)) {
        const comp = companions.get(target.text);
        if (comp?.fn.body) return { node: comp.fn.body, file: comp.file };
      }
      return null;
    }
    if (ts.isIdentifier(n) && !isDeclarationName(n)) {
      const hit = index.resolve(nodeFile, n.text);
      // Another CLASS is not followed: those are the infrastructure an update
      // uses (SDK clients, the logger, `ReplacementRulesRegistry`, whose rules
      // table names nearly every property), and a `this` in one is not the
      // provider's. Nor a GENERATED module: `property-coverage.generated.ts`
      // and `create-only-snapshot.generated.ts` name every type's properties.
      if (hit && !ts.isClassDeclaration(hit.node) && !hit.file.endsWith('.generated.ts')) return hit;
    }
    return null;
  };

  // ---- what a subtree can do (memoized per declaration) ----
  const effectMemo = new Map<ts.Node, Effect>();
  const effectOf = (node: ts.Node, nodeFile: string, locals?: Map<string, ts.Node>): Effect => {
    let acc = NO_EFFECT;
    const seen = new Set<ts.Node>();
    const visitE = (n: ts.Node, f: string, loc: Map<string, ts.Node> | undefined): void => {
      if (acc.hard && acc.warn) return;
      const sink = sinkOf(n);
      if (sink) acc = orEffect(acc, sink);
      const follow = (target: ts.Node, tf: string): void => {
        if (seen.has(target)) return;
        seen.add(target);
        acc = orEffect(acc, declEffect(target, tf));
      };
      const target = resolveTarget(n, f);
      if (target && (ts.isCallExpression(n.parent) || ts.isCallExpression(n))) follow(target.node, target.file);
      // A local closure called by name: `const apply = async () => send(...)`.
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && loc?.has(n.expression.text)) {
        follow(loc.get(n.expression.text)!, f);
      }
      ts.forEachChild(n, (c) => visitE(c, f, loc));
    };
    visitE(node, nodeFile, locals);
    return acc;
  };
  const declEffect = (decl: ts.Node, declFile: string): Effect => {
    const cached = effectMemo.get(decl);
    if (cached) return cached;
    effectMemo.set(decl, NO_EFFECT); // cycle guard
    const e = effectOf(decl, declFile, localDeclarations(decl));
    effectMemo.set(decl, e);
    return e;
  };

  // ---- the reading walk ----
  type Mode = 'effect' | 'plain';
  const walked = new Map<ts.Node, Set<string>>();
  const NO_SEED: ReadonlySet<string> = new Set();

  // Which parameters of a callee its own body hands to an effect (memoized;
  // `null` while being computed, read as "all", so a cycle can only add reads).
  const paramMemo = new Map<string, ReadonlySet<string> | null>();
  const nodeIds = new Map<ts.Node, number>();
  const consumedParams = (
    target: { node: ts.Node; file: string },
    seed: ReadonlySet<string>
  ): ReadonlySet<string> | null => {
    if (!nodeIds.has(target.node)) nodeIds.set(target.node, nodeIds.size);
    const memoKey = `${nodeIds.get(target.node)}|${[...seed].sort().join(',')}`;
    if (paramMemo.has(memoKey)) return paramMemo.get(memoKey)!;
    paramMemo.set(memoKey, null);
    const fn = signatureOf(target.node);
    const unit = makeUnit(target.node, target.file, 'plain', seed);
    unit.settle();
    const names = new Set(
      (fn?.parameters ?? []).flatMap((p) => boundNames(p.name)).filter((n) => unit.consumed.has(n))
    );
    paramMemo.set(memoKey, names);
    return names;
  };

  const walkUnit = (root: ts.Node, rootFile: string, mode: Mode, seed: ReadonlySet<string> = NO_SEED): void => {
    const key = `${mode}|${[...seed].sort().join(',')}`;
    const keys = walked.get(root) ?? new Set<string>();
    if (keys.has(key) || keys.has('effect|')) return;
    keys.add(key);
    walked.set(root, keys);
    const unit = makeUnit(root, rootFile, mode, seed);
    unit.settle();
    unit.run(false);
  };

  function makeUnit(
    root: ts.Node,
    rootFile: string,
    mode: Mode,
    seed: ReadonlySet<string>
  ): { consumed: Set<string>; settle: () => void; run: (collect: boolean) => void } {
    const locals = localDeclarations(root);
    const requestLocals = requestDeclarations(root);
    const subtreeEffect = (n: ts.Node): Effect => effectOf(n, rootFile, locals);
    // A guarded block counts when it sends or refuses, or warns without being
    // an early-exit "nothing to do" path.
    const guards = (n: ts.Node | undefined): boolean => {
      if (!n) return false;
      const e = subtreeEffect(n);
      return e.hard || (e.warn && !exitsEarly(n));
    };

    // Locals whose value reaches an effect, grown to a fixpoint.
    const consumed = new Set<string>([...seed].filter((k) => !k.startsWith(RETURN_KEY)));
    const returnKeysFor = new Map<ts.CallExpression, Set<string>>();
    const run = (collect: boolean): void => {
      const visit = (n: ts.Node, eff: boolean, cond: boolean, neg: boolean): void => {
        // Per-type narrowing.
        if (ts.isIfStatement(n)) {
          const reach = branchReach(n.expression, resourceType);
          // The condition counts when a branch this type can take has an effect.
          const condEff =
            eff ||
            ((!reach || reach.then) && guards(n.thenStatement)) ||
            ((!reach || reach.else) && guards(n.elseStatement));
          visit(n.expression, condEff, true, false);
          if (!reach || reach.then) visit(n.thenStatement, eff, false, false);
          if ((!reach || reach.else) && n.elseStatement) visit(n.elseStatement, eff, false, false);
          return;
        }
        if (ts.isConditionalExpression(n)) {
          const reach = branchReach(n.condition, resourceType);
          visit(n.condition, eff || guards(n.whenTrue) || guards(n.whenFalse), true, false);
          if (!reach || reach.then) visit(n.whenTrue, eff, false, false);
          if (!reach || reach.else) visit(n.whenFalse, eff, false, false);
          return;
        }
        if (ts.isSwitchStatement(n)) {
          const clauses = n.caseBlock.clauses;
          const literalOf = (c: ts.CaseOrDefaultClause): string | null =>
            ts.isCaseClause(c) && ts.isStringLiteralLike(c.expression) && /^AWS::/.test(c.expression.text)
              ? c.expression.text
              : null;
          if (isResourceTypeOperand(n.expression) && clauses.some((c) => literalOf(c) !== null)) {
            // Enter at the matching label (or `default` when none matches) and
            // fall through until a clause ends in break / return / throw.
            let start = clauses.findIndex((c) => literalOf(c) === resourceType);
            if (start < 0) start = clauses.findIndex((c) => ts.isDefaultClause(c));
            if (start >= 0) {
              for (let i = start; i < clauses.length; i++) {
                const c = clauses[i]!;
                visitStatements(c.statements, eff);
                if (endsClause(c.statements)) break;
              }
            }
            return;
          }
          const anyEffect = clauses.some((c) => guards(ts.factory.createBlock(c.statements)));
          visit(n.expression, eff || anyEffect, true, false);
          for (const c of clauses) {
            if (ts.isCaseClause(c)) visit(c.expression, eff || guards(ts.factory.createBlock(c.statements)), true, false);
            visitStatements(c.statements, eff);
          }
          return;
        }
        if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n)) {
          visitStatements(n.statements, eff);
          return;
        }
        if (
          ts.isForOfStatement(n) ||
          ts.isForInStatement(n) ||
          ts.isWhileStatement(n) ||
          ts.isDoStatement(n) ||
          ts.isForStatement(n)
        ) {
          const loopVars =
            (ts.isForOfStatement(n) || ts.isForInStatement(n)) && ts.isVariableDeclarationList(n.initializer)
              ? n.initializer.declarations.flatMap((d) => boundNames(d.name))
              : [];
          const headerEff = eff || guards(n.statement) || loopVars.some((v) => consumed.has(v));
          if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
            visit(n.expression, headerEff, true, false);
            visit(n.initializer, headerEff, false, false);
          } else if (ts.isForStatement(n)) {
            if (n.initializer) visit(n.initializer, headerEff, false, false);
            if (n.condition) visit(n.condition, headerEff, true, false);
            if (n.incrementor) visit(n.incrementor, eff, false, false);
          } else {
            visit(n.expression, headerEff, true, false);
          }
          visit(n.statement, eff, false, false);
          return;
        }
        if (ts.isPrefixUnaryExpression(n) && n.operator === ts.SyntaxKind.ExclamationToken) {
          visit(n.operand, eff, cond, !neg);
          return;
        }
        if (ts.isBinaryExpression(n)) {
          const op = n.operatorToken.kind;
          if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
            // `cond && doIt()`: the left side guards the right.
            visit(n.left, eff || guards(n.right), cond || guards(n.right), neg);
            visit(n.right, eff, cond, neg);
            return;
          }
          if (
            cond &&
            (op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken)
          ) {
            visit(n.left, eff, cond, !neg);
            visit(n.right, eff, cond, !neg);
            return;
          }
          if (isAssignment(n)) {
            const target = rootName(n.left);
            visit(n.left, eff, false, false);
            visit(n.right, eff || (target !== null && consumed.has(target)), false, false);
            if (collect && eff && target) consumed.add(target);
            return;
          }
        }
        if (ts.isVariableDeclaration(n)) {
          const names = boundNames(n.name);
          const live = eff || names.some((v) => consumed.has(v));
          // `const { a, b } = helper(...)` with only `a` used: the helper's
          // returned `a` is what reaches an effect, not everything it reads.
          const call = n.initializer ? unwrapCall(n.initializer) : undefined;
          if (!eff && call && ts.isObjectBindingPattern(n.name)) {
            const keys = new Set<string>();
            for (const el of n.name.elements) {
              const key = el.propertyName ?? el.name;
              if (
                (ts.isIdentifier(key) || ts.isStringLiteralLike(key)) &&
                boundNames(el.name).some((v) => consumed.has(v))
              ) {
                keys.add(key.text);
              }
            }
            returnKeysFor.set(call, keys);
            visit(n.initializer!, false, false, false);
            visitBinding(n.name, eff);
            return;
          }
          if (n.initializer) visit(n.initializer, live, false, false);
          // A destructuring read counts only for a binding whose value is used.
          if (!ts.isIdentifier(n.name)) visitBinding(n.name, eff);
          return;
        }
        if (ts.isReturnStatement(n)) {
          if (!n.expression) return;
          const keys = [...seed].filter((k) => k.startsWith(RETURN_KEY)).map((k) => k.slice(RETURN_KEY.length));
          if (!eff && mode !== 'effect' && keys.length > 0) {
            let e: ts.Expression = n.expression;
            while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isAwaitExpression(e)) e = e.expression;
            if (ts.isObjectLiteralExpression(e)) {
              for (const prop of e.properties) {
                const name = prop.name && (ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) ? prop.name.text : null;
                const live = name !== null && keys.includes(name);
                if (ts.isShorthandPropertyAssignment(prop)) visit(prop.name, live, false, false);
                else if (ts.isPropertyAssignment(prop)) visit(prop.initializer, live, false, false);
                else visit(prop, true, false, false);
              }
              return;
            }
            const call = unwrapCall(e);
            if (call) {
              returnKeysFor.set(call, new Set(keys));
              visit(n.expression, false, false, false);
              return;
            }
          }
          visit(n.expression, eff || mode === 'effect' || keys.length > 0, false, false);
          return;
        }
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === 'get' &&
          n.arguments.length === 1
        ) {
          // `TABLE.get(resourceType)`: only this type's entry.
          const entry = keyedEntry(n.expression.expression, n.arguments[0]!, rootFile);
          if (entry) {
            if (!collect) walkUnit(entry.node, entry.file, eff ? 'effect' : 'plain');
            return;
          }
        }
        if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
          const sink = sinkOf(n);
          const target = resolveTarget(ts.isCallExpression(n) ? n.expression : n, rootFile) ??
            (ts.isCallExpression(n) ? resolveTarget(n, rootFile) : null);
          const local =
            ts.isCallExpression(n) && ts.isIdentifier(n.expression) ? locals.get(n.expression.text) : undefined;
          const calleeEffect = target
            ? declEffect(target.node, target.file)
            : local
              ? effectOf(local, rootFile, locals)
              : NO_EFFECT;
          const mutated = ts.isCallExpression(n) ? mutatedRoot(n) : null;
          const args = n.arguments ?? [];
          // The arguments count when the call sends, refuses or warns: itself,
          // through its callee, through a callback handed to it (`diff(prev.X,
          // next.X, (cfg) => put(cfg))`), or by filling a request a send
          // consumes (`fill(input, properties)` before `send(new X(input))`).
          const composesEffect = args.some((a) => {
            const e = subtreeEffect(a);
            return e.hard || e.warn;
          });
          const base =
            eff || sink !== null || (mutated !== null && consumed.has(mutated)) || composesEffect;
          // Per argument, through the callee's own use of the parameter it binds:
          // a flag handed to a sending function counts only if that function's
          // body hands its parameter on to the send.
          const calleeUnit = target ?? (local ? { node: local, file: rootFile } : null);
          const fn = calleeUnit ? signatureOf(calleeUnit.node) : undefined;
          const viaCall =
            ts.isCallExpression(n) &&
            ts.isPropertyAccessExpression(n.expression) &&
            n.expression.name.text === 'call' &&
            n.arguments[0]?.kind === ts.SyntaxKind.ThisKeyword;
          const offset = viaCall ? 1 : 0;
          const params = (fn?.parameters ?? []).filter(
            (p) => !(ts.isIdentifier(p.name) && p.name.text === 'this')
          );
          const paramAt = (i: number): ts.ParameterDeclaration | undefined => {
            const j = i - offset;
            if (j < 0) return undefined;
            const last = params[params.length - 1];
            return params[j] ?? (last?.dotDotDotToken ? last : undefined);
          };
          // A request local handed in is filled there: seed its parameter.
          const seedNames = new Set<string>();
          for (const k of returnKeysFor.get(n as ts.CallExpression) ?? []) seedNames.add(RETURN_KEY + k);
          args.forEach((a, i) => {
            const param = paramAt(i);
            const fills =
              ts.isIdentifier(a) && ((requestLocals.has(a.text) && consumed.has(a.text)) || seed.has(a.text));
            if (fills && param) {
              for (const name of boundNames(param.name)) seedNames.add(name);
            }
            // A delegator forwarding a seeded rest parameter (`...args`)
            // seeds every parameter from there on.
            if (ts.isSpreadElement(a) && ts.isIdentifier(a.expression) && seed.has(a.expression.text)) {
              for (let j = i - offset; j < params.length; j++) {
                if (j >= 0) for (const name of boundNames(params[j]!.name)) seedNames.add(name);
              }
            }
          });
          const argEffAt = (i: number): boolean => {
            if (base) return true;
            if (viaCall && i === 0) return false;
            if (!calleeUnit || !fn) return calleeEffect.hard || calleeEffect.warn;
            const used = consumedParams(calleeUnit, seedNames);
            if (used === null) return true;
            const a = args[i];
            const param = paramAt(i);
            if ((a && ts.isSpreadElement(a)) || !param) return used.size > 0;
            return boundNames(param.name).some((name) => used.has(name));
          };
          if (collect && local && eff && ts.isIdentifier((n as ts.CallExpression).expression)) {
            consumed.add(((n as ts.CallExpression).expression as ts.Identifier).text);
          }
          visit(n.expression, eff, cond, neg);
          args.forEach((a, i) => visit(a, argEffAt(i), false, false));
          if (!collect && target) {
            walkUnit(target.node, target.file, eff || composesEffect ? 'effect' : 'plain', seedNames);
          }
          if (ts.isPropertyAccessExpression(n.expression) && n.expression.expression.kind === ts.SyntaxKind.ThisKeyword && !target && isInvokedOrBound(n.expression) && !collect) {
            unresolved.add(n.expression.name.text);
          }
          return;
        }
        if (ts.isFunctionLike(n) && n !== root) {
          // A closure: its body is reached when it is called (a consumed local)
          // or when it sits in an effect position (a callback handed to a send).
          const declName =
            ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name) ? n.parent.name.text : null;
          const body = (n as ts.FunctionLikeDeclaration).body;
          if (body) visit(body, eff || (declName !== null && consumed.has(declName)), false, false);
          return;
        }

        // Reads, and the references that make a local consumed.
        if (ts.isIdentifier(n) && !isDeclarationName(n)) {
          if (collect && eff) consumed.add(n.text);
          if (!collect) {
            const target = resolveTarget(n, rootFile);
            // A table under a negation in a guard (`!MUTABLE.has(key)`) names the
            // properties the guarded refusal EXEMPTS, which is no read of them.
            if (target) walkUnit(target.node, target.file, eff && !(cond && neg) ? 'effect' : 'plain');
          }
        } else if (ts.isPropertyAccessExpression(n)) {
          if (!collect && eff) reads.add(n.name.text);
          if (n.expression.kind === ts.SyntaxKind.ThisKeyword) {
            const target = resolveTarget(n, rootFile);
            if (target && !collect) walkUnit(target.node, target.file, eff ? 'effect' : 'plain');
            else if (!target && isInvokedOrBound(n) && !collect) unresolved.add(n.name.text);
            return;
          }
          visit(n.expression, eff, cond, neg);
          return;
        } else if (ts.isElementAccessExpression(n)) {
          if (!collect && eff && ts.isStringLiteralLike(n.argumentExpression)) {
            reads.add(n.argumentExpression.text);
          }
          // `TABLE[resourceType]`: only this type's entry.
          const entry = keyedEntry(n.expression, n.argumentExpression, rootFile);
          if (entry) {
            if (!collect) walkUnit(entry.node, entry.file, eff ? 'effect' : 'plain');
            return;
          }
          visit(n.expression, eff, cond, neg);
          visit(n.argumentExpression, eff, cond, neg);
          return;
        } else if (ts.isShorthandPropertyAssignment(n)) {
          if (!collect && eff) reads.add(n.name.text);
          if (collect && eff) consumed.add(n.name.text);
        } else if (ts.isStringLiteralLike(n) && !isObjectLiteralKey(n)) {
          if (!collect && eff && !(cond && neg)) reads.add(n.text);
        }
        ts.forEachChild(n, (c) => visit(c, eff, cond, neg));
      };

      // Statements in order, with early-return narrowing: after
      // `if (resourceType === 'A') return ...;` the rest is not type A's.
      const visitStatements = (statements: readonly ts.Statement[], eff: boolean): void => {
        for (const st of statements) {
          visit(st, eff, false, false);
          if (ts.isIfStatement(st) && !st.elseStatement) {
            const reach = branchReach(st.expression, resourceType);
            if (reach && reach.then && !reach.else && endsClause([st.thenStatement])) return;
          }
        }
      };
      const visitBinding = (pattern: ts.BindingPattern, eff: boolean): void => {
        for (const el of pattern.elements) {
          if (ts.isOmittedExpression(el)) continue;
          if (ts.isObjectBindingPattern(pattern)) {
            const key = el.propertyName ?? el.name;
            const live = eff || boundNames(el.name).some((v) => consumed.has(v));
            if (live && !collect && (ts.isIdentifier(key) || ts.isStringLiteralLike(key))) reads.add(key.text);
          }
          if (!ts.isIdentifier(el.name)) visitBinding(el.name, eff);
        }
      };
      // `.get(resourceType)` on a keyed table: only this type's entry.
      const visitRootBody = (): void => {
        const body = ts.isFunctionLike(root) ? (root as ts.FunctionLikeDeclaration).body : root;
        if (body) visit(body, mode === 'effect', false, false);
      };
      visitRootBody();
    };
    const settle = (): void => {
      for (let i = 0; i < 8; i++) {
        const before = consumed.size;
        run(true);
        if (consumed.size === before) break;
      }
    };
    return { consumed, settle, run };
  }

  /** `TABLE[resourceType]` / `TABLE.get(resourceType)` on a literal keyed table -> the entry. */
  const keyedEntry = (
    table: ts.Expression,
    key: ts.Expression,
    nodeFile: string
  ): { node: ts.Node; file: string } | null => {
    if (!isResourceTypeOperand(key) || !ts.isIdentifier(table)) return null;
    const hit = resolveTarget(table, nodeFile);
    if (!hit || !ts.isVariableDeclaration(hit.node) || !hit.node.initializer) return null;
    let init: ts.Expression = hit.node.initializer;
    while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) {
      init = init.expression;
    }
    // `new Map([['AWS::X::Y', value], ...])`.
    if (
      ts.isNewExpression(init) &&
      ts.isIdentifier(init.expression) &&
      init.expression.text === 'Map' &&
      init.arguments?.[0] &&
      ts.isArrayLiteralExpression(init.arguments[0])
    ) {
      const entries = init.arguments[0].elements.filter(ts.isArrayLiteralExpression);
      const keyed = entries.filter(
        (e) => e.elements[0] && ts.isStringLiteralLike(e.elements[0]) && /^AWS::/.test(e.elements[0].text)
      );
      if (keyed.length === 0 || keyed.length !== entries.length) return null;
      const match = keyed.find((e) => (e.elements[0] as ts.StringLiteralLike).text === resourceType);
      return { node: match?.elements[1] ?? ts.factory.createNull(), file: hit.file };
    }
    if (ts.isObjectLiteralExpression(init)) {
      for (const p of init.properties) {
        if (
          ts.isPropertyAssignment(p) &&
          (ts.isStringLiteralLike(p.name) || ts.isIdentifier(p.name)) &&
          p.name.text === resourceType
        ) {
          return { node: p.initializer, file: hit.file };
        }
      }
      return /^AWS::/.test(
        init.properties.map((p) => (p.name && ts.isStringLiteralLike(p.name) ? p.name.text : '')).join('')
      )
        ? { node: ts.factory.createNull(), file: hit.file }
        : null;
    }
    return null;
  };

  walkUnit(update.node, update.file, 'plain');
  return { reads, hasUpdate: true, unresolved };
}

/**
 * Locals a unit builds a request in: `const input = { ... }` / `[]` /
 * `new Map()`. Only such a local, handed to a helper and later consumed by an
 * effect, makes that helper a request filler; a parameter forwarded to a
 * delegate does not (every update delegates its `logicalId`).
 */
function requestDeclarations(root: ts.Node): Set<string> {
  const out = new Set<string>();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      let init: ts.Expression = n.initializer;
      while (ts.isAsExpression(init) || ts.isSatisfiesExpression(init) || ts.isParenthesizedExpression(init)) {
        init = init.expression;
      }
      if (
        ts.isObjectLiteralExpression(init) ||
        ts.isArrayLiteralExpression(init) ||
        (ts.isNewExpression(init) && ts.isIdentifier(init.expression) && ['Map', 'Set'].includes(init.expression.text))
      ) {
        out.add(n.name.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

/** A seed entry naming a returned object key the caller consumes. */
const RETURN_KEY = 'return:';

/** The call an initializer or return value is (through `await`, parens, `as`). */
function unwrapCall(e: ts.Expression): ts.CallExpression | undefined {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isAwaitExpression(cur)) {
    cur = cur.expression;
  }
  return ts.isCallExpression(cur) ? cur : undefined;
}

/** The function a resolved unit (a body, a declaration, a closure) is the body of. */
function signatureOf(node: ts.Node): ts.SignatureDeclaration | undefined {
  if (ts.isFunctionLike(node)) return node;
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isFunctionLike(node.initializer)) {
    return node.initializer;
  }
  if (ts.isBlock(node) && node.parent && ts.isFunctionLike(node.parent)) return node.parent;
  return undefined;
}

/** The local `const name = <function>` declarations directly inside a unit. */
function localDeclarations(root: ts.Node): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  const visit = (n: ts.Node): void => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))
    ) {
      out.set(n.name.text, n.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(root);
  return out;
}

function isDeclarationName(n: ts.Identifier): boolean {
  const p = n.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return true;
  if (
    (ts.isFunctionDeclaration(p) ||
      ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isClassDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isBindingElement(p)) &&
    (p as { name?: ts.Node }).name === n
  ) {
    return true;
  }
  return ts.isImportSpecifier(p) || ts.isImportClause(p);
}

// ---------------------------------------------------------------------------
// Replacement rules (parsed, not imported: the script stays bootstrap-free).
// ---------------------------------------------------------------------------

export interface RuleSets {
  readonly replacement: ReadonlySet<string>;
  readonly updateable: ReadonlySet<string>;
  readonly conditional: ReadonlySet<string>;
}

/**
 * `this.rules.set('AWS::X::Y', { replacementProperties: new Set([...]),
 * updateableProperties: new Set([...]), conditionalReplacements: new Map([[...]]) })`
 * per type. A `rules.set` this cannot read REFUSES: a silently missed
 * `replacementProperties` would only hide gaps, but a missed `updateable`
 * entry would invent replacements and hide real gaps too.
 */
export function parseReplacementRules(source: string): Map<string, RuleSets> {
  const sf = ts.createSourceFile('rules.ts', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const out = new Map<string, RuleSets>();
  const strings = (e: ts.Expression | undefined, kind: 'Set' | 'Map'): Set<string> => {
    const s = new Set<string>();
    if (!e) return s;
    if (!ts.isNewExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== kind) {
      throw new Error(`replacement rules: expected new ${kind}(...) at ${e.getText().slice(0, 60)}`);
    }
    const arr = e.arguments?.[0];
    if (arr === undefined) return s;
    // `new Map(['A', 'B'].map((p) => [p, predicate]))`: the keys are the array's.
    if (
      kind === 'Map' &&
      ts.isCallExpression(arr) &&
      ts.isPropertyAccessExpression(arr.expression) &&
      arr.expression.name.text === 'map' &&
      ts.isArrayLiteralExpression(arr.expression.expression)
    ) {
      for (const el of arr.expression.expression.elements) {
        if (!ts.isStringLiteralLike(el)) {
          throw new Error(`replacement rules: non-literal entry ${el.getText().slice(0, 60)}`);
        }
        s.add(el.text);
      }
      return s;
    }
    if (!ts.isArrayLiteralExpression(arr)) {
      throw new Error(`replacement rules: non-literal ${kind} at ${e.getText().slice(0, 60)}`);
    }
    for (const el of arr.elements) {
      const key = kind === 'Map' && ts.isArrayLiteralExpression(el) ? el.elements[0] : el;
      if (!key || !ts.isStringLiteralLike(key)) {
        throw new Error(`replacement rules: non-literal entry ${el.getText().slice(0, 60)}`);
      }
      s.add(key.text);
    }
    return s;
  };
  const visit = (n: ts.Node): void => {
    if (
      ts.isCallExpression(n) &&
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'set' &&
      n.expression.expression.getText() === 'this.rules'
    ) {
      const [typeArg, ruleArg] = n.arguments;
      if (!typeArg || !ts.isStringLiteralLike(typeArg) || !ruleArg || !ts.isObjectLiteralExpression(ruleArg)) {
        throw new Error(`replacement rules: unreadable rules.set at ${n.getText().slice(0, 80)}`);
      }
      const prop = (name: string): ts.Expression | undefined => {
        for (const p of ruleArg.properties) {
          if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === name) {
            return p.initializer;
          }
        }
        return undefined;
      };
      for (const p of ruleArg.properties) {
        if (
          !ts.isPropertyAssignment(p) ||
          !ts.isIdentifier(p.name) ||
          !['replacementProperties', 'updateableProperties', 'conditionalReplacements'].includes(
            p.name.text
          )
        ) {
          throw new Error(`replacement rules: unmodelled member in ${typeArg.text}: ${p.getText().slice(0, 60)}`);
        }
      }
      out.set(typeArg.text, {
        replacement: strings(prop('replacementProperties'), 'Set'),
        updateable: strings(prop('updateableProperties'), 'Set'),
        conditional: strings(prop('conditionalReplacements'), 'Map'),
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (out.size === 0) throw new Error('replacement rules: parsed zero rules.set calls');
  return out;
}

// ---------------------------------------------------------------------------
// Classification.
// ---------------------------------------------------------------------------

export type Status = 'update' | 'replacement' | 'allow-listed' | 'gap';

export interface PropertyRow {
  readonly property: string;
  readonly status: Status;
  /** For `replacement`: `rule` (replacementProperties) or `create-only` (schema). */
  readonly via?: 'rule' | 'create-only';
  readonly rationale?: string;
}

export interface TypeRow {
  readonly resourceType: string;
  readonly file: string;
  readonly className: string;
  readonly properties: readonly PropertyRow[];
  /**
   * Handled names the committed schema lists as no writable top-level
   * property (absent, or read-only): a template cannot change one, so it is
   * not classified, but it is counted rather than dropped unseen.
   */
  readonly outsideSchema: readonly string[];
  /** See {@link WalkOutput.unresolved}. A non-empty list BLOCKS CI. */
  readonly unresolved: readonly string[];
}

export interface SchemaFacts {
  readonly properties: ReadonlySet<string>;
  readonly readOnly: ReadonlySet<string>;
  readonly createOnly: ReadonlySet<string>;
}

export function classifyProperty(
  resourceType: string,
  prop: string,
  reads: ReadonlySet<string>,
  rules: RuleSets | undefined,
  schema: SchemaFacts,
  allowList: ReadonlyMap<string, AllowListEntry>
): PropertyRow {
  // The diff decides a replacement before update() runs, so it is checked first.
  if (rules?.replacement.has(prop)) return { property: prop, status: 'replacement', via: 'rule' };
  if (
    schema.createOnly.has(prop) &&
    !(rules?.updateable.has(prop) ?? false) &&
    !(rules?.conditional.has(prop) ?? false)
  ) {
    return { property: prop, status: 'replacement', via: 'create-only' };
  }
  if (reads.has(prop)) return { property: prop, status: 'update' };
  const allow = allowList.get(allowKey(resourceType, prop));
  if (allow) return { property: prop, status: 'allow-listed', rationale: allow.rationale };
  return { property: prop, status: 'gap' };
}

export interface ClassifyInput {
  readonly file: string;
  /** The provider's companion files (`scripts/provider-companion-files.ts`). */
  readonly companions: readonly string[];
  readonly index: ModuleIndex;
  readonly rules: ReadonlyMap<string, RuleSets>;
  readonly schema: (resourceType: string) => SchemaFacts | null;
  readonly allowList?: ReadonlyMap<string, AllowListEntry>;
  /** The repo-relative name rows carry. */
  readonly displayFile?: string;
}

/** Classify every (type, handled property) of every class in one provider file. */
export function classifyFile(input: ClassifyInput): TypeRow[] {
  const { file, index, rules, schema } = input;
  const allowList = input.allowList ?? UPDATE_PATH_ALLOW_LIST;
  const sf = index.get(file)?.sf;
  if (!sf) throw new Error(`cannot read provider file ${input.displayFile ?? file}`);
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
  const rows: TypeRow[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isClassDeclaration(n) && n.name) {
      const handled = parseProviderSource(n.getText(), file).handled;
      for (const [resourceType, props] of handled) {
        const facts = schema(resourceType);
        // Fail closed: a type without a committed schema would drop out with
        // every gap it has (scripts/refresh-cfn-schemas.mjs captures one).
        if (!facts) {
          throw new Error(`${resourceType} (${input.displayFile ?? file}) has no CFn schema fixture`);
        }
        const walk = walkUpdatePath({ cls: n, file, companions, index }, resourceType);
        // Fail closed: a provider class whose update() cannot be found would
        // otherwise drop out of the matrix, and its gaps with it.
        if (!walk.hasUpdate) {
          throw new Error(
            `${n.name.text} (${input.displayFile ?? file}) handles ${resourceType} but no update() ` +
              'is declared on it or on a base class this script can resolve'
          );
        }
        const typeRules = rules.get(resourceType);
        const inSchema = (p: string): boolean => facts.properties.has(p) && !facts.readOnly.has(p);
        const sorted = [...props].sort((a, b) => a.localeCompare(b));
        const properties = sorted
          .filter(inSchema)
          .map((p) => classifyProperty(resourceType, p, walk.reads, typeRules, facts, allowList));
        rows.push({
          resourceType,
          file: input.displayFile ?? file,
          className: n.name.text,
          properties,
          outsideSchema: sorted.filter((p) => !inSchema(p)),
          unresolved: [...walk.unresolved].sort((a, b) => a.localeCompare(b)),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return rows;
}

export interface UpdatePathCoverageReport {
  readonly summary: {
    readonly types: number;
    readonly properties: number;
    readonly update: number;
    readonly replacement: number;
    readonly allowListed: number;
    readonly gap: number;
    readonly outsideSchema: number;
  };
  readonly types: readonly TypeRow[];
}

export function buildReport(rows: readonly TypeRow[]): UpdatePathCoverageReport {
  const sorted = [...rows].sort((a, b) => a.resourceType.localeCompare(b.resourceType));
  const all = sorted.flatMap((r) => r.properties);
  const count = (s: Status): number => all.filter((p) => p.status === s).length;
  return {
    summary: {
      types: sorted.length,
      properties: all.length,
      update: count('update'),
      replacement: count('replacement'),
      allowListed: count('allow-listed'),
      gap: count('gap'),
      outsideSchema: sorted.reduce((n, r) => n + r.outsideSchema.length, 0),
    },
    types: sorted,
  };
}

export function findGaps(report: UpdatePathCoverageReport): string[] {
  return report.types.flatMap((t) =>
    t.properties.filter((p) => p.status === 'gap').map((p) => allowKey(t.resourceType, p.property))
  );
}

/** `Class (Type): callee` for every unresolved `this.x()` call. BLOCKS CI. */
export function findUnresolved(report: UpdatePathCoverageReport): string[] {
  return report.types.flatMap((t) =>
    t.unresolved.map((u) => `${t.className} (${t.resourceType}): this.${u}()`)
  );
}

/** Allow-list keys that no longer name an `allow-listed` row. */
export function findStaleAllowEntries(
  report: UpdatePathCoverageReport,
  allowList: ReadonlyMap<string, AllowListEntry> = UPDATE_PATH_ALLOW_LIST
): string[] {
  const live = new Set(
    report.types.flatMap((t) =>
      t.properties
        .filter((p) => p.status === 'allow-listed')
        .map((p) => allowKey(t.resourceType, p.property))
    )
  );
  return [...allowList.keys()].filter((k) => !live.has(k)).sort();
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

/** The matrix as `gen:update-path-coverage` builds it from the real tree. */
export function loadReport(host: SourceHost = diskHost): UpdatePathCoverageReport {
  const index = new ModuleIndex(host);
  const rules = parseReplacementRules(readFileSync(RULES_FILE, 'utf8'));
  const rows: TypeRow[] = [];
  for (const name of readdirSync(PROVIDERS_DIR).sort()) {
    if (!name.endsWith('.ts') || name.endsWith('.d.ts') || name.endsWith('.test.ts')) continue;
    const file = join(PROVIDERS_DIR, name);
    rows.push(
      ...classifyFile({
        file,
        companions: companionFiles(file),
        index,
        rules,
        schema: loadSchema,
        displayFile: relative(repoRoot, file),
      })
    );
  }
  return buildReport(rows);
}

function renderMarkdown(report: UpdatePathCoverageReport): string {
  const s = report.summary;
  const lines: string[] = [
    '---',
    'title: "Update-path property coverage matrix"',
    'unlisted: true',
    '---',
    '',
    '# SDK-provider update-path property coverage matrix',
    '',
    '<!-- AUTO-GENERATED by scripts/gen-update-path-coverage.ts — DO NOT EDIT BY HAND. -->',
    '<!-- Regenerate: `vp run gen:update-path-coverage`. -->',
    '',
    'For every SDK provider type and every top-level property its `handledProperties` ' +
      'declares, whether a change of that property reaches AWS on an update: a read of it ' +
      'on the `update()` path reaches a send, a refusal (a replacement) or a warning ' +
      '(`update`), or the diff replaces the resource for it (`replacement`). A property ' +
      'in neither is a change the deploy would report applied while AWS keeps the old ' +
      'value (issue #6611).',
    '',
    '## Summary',
    '',
    `- SDK provider types: **${s.types}**`,
    `- Handled properties classified: **${s.properties}**`,
    `- Read on the update path: **${s.update}**`,
    `- Replacement: **${s.replacement}**`,
    `- Allow-listed (does NOT block CI): **${s.allowListed}**`,
    `- Handled names outside the schema's writable properties (not classified): **${s.outsideSchema}**`,
    `- **Gaps (blocks CI): ${s.gap}**`,
    '',
  ];
  const flagged = report.types.flatMap((t) =>
    t.properties
      .filter((p) => p.status === 'gap' || p.status === 'allow-listed')
      .map((p) => ({ t, p }))
  );
  lines.push('## Gaps and allow-listed properties', '');
  if (flagged.length === 0) {
    lines.push('None. Every handled property is read on the update path or replaces.', '');
  } else {
    lines.push('| Type | Property | Status | Provider | Rationale |', '| --- | --- | --- | --- | --- |');
    for (const { t, p } of flagged) {
      lines.push(
        `| \`${t.resourceType}\` | \`${p.property}\` | ${p.status} | \`${t.className}\` | ${escapeCell(p.rationale ?? '')} |`
      );
    }
    lines.push('');
  }
  lines.push('## Full classification', '', '| Type | Provider | Update | Replacement |', '| --- | --- | --- | --- |');
  for (const t of report.types) {
    const names = (pred: (p: PropertyRow) => boolean): string =>
      t.properties
        .filter(pred)
        .map((p) => p.property)
        .join(', ');
    lines.push(
      `| \`${t.resourceType}\` | \`${t.className}\` | ${escapeCell(names((p) => p.status === 'update'))} | ${escapeCell(
        names((p) => p.status === 'replacement')
      )} |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function main(): void {
  const report = loadReport();
  if (process.argv.includes('--check')) {
    const gaps = findGaps(report);
    const stale = findStaleAllowEntries(report);
    const unresolved = findUnresolved(report);
    if (gaps.length > 0 || stale.length > 0 || unresolved.length > 0) {
      process.stderr.write(
        'update-path-coverage: FAIL\n' +
          (gaps.length > 0
            ? 'A handled property that update() never reads and that does not replace is a\n' +
              'change the deploy reports applied while AWS keeps the old value (#6611).\n' +
              'Send it from update() only when it changed, refuse it with\n' +
              'ResourceUpdateNotSupportedError, add a replacement rule, OR add an\n' +
              'UPDATE_PATH_ALLOW_LIST entry with a reason in scripts/gen-update-path-coverage.ts.\n' +
              gaps.map((g) => `  gap: ${g}\n`).join('')
            : '') +
          (stale.length > 0
            ? 'UPDATE_PATH_ALLOW_LIST entries that are no longer gaps — delete them:\n' +
              stale.map((g) => `  stale: ${g}\n`).join('')
            : '') +
          (unresolved.length > 0
            ? 'update() reaches this.x() calls that resolve to no member, base-class member or\n' +
              'companion function, so the code behind them is unseen — make them resolvable:\n' +
              unresolved.map((u) => `  unresolved: ${u}\n`).join('')
            : '')
      );
      process.exit(1);
    }
    process.stderr.write(
      `update-path-coverage: OK — ${report.summary.properties} handled properties over ` +
        `${report.summary.types} types, 0 gaps (${report.summary.allowListed} allow-listed).\n`
    );
    return;
  }
  mkdirSync(dirname(OUT_JSON), { recursive: true });
  atomicWrite(OUT_JSON, JSON.stringify(report, null, 2) + '\n');
  atomicWrite(OUT_MD, renderMarkdown(report) + '\n');
  process.stderr.write(
    `update-path-coverage: wrote update-path-coverage.{json,md} — ${report.summary.properties} ` +
      `properties, ${report.summary.update} update, ${report.summary.replacement} replacement, ` +
      `${report.summary.allowListed} allow-listed, ${report.summary.gap} gap(s).\n`
  );
}

const isMainModule = (): boolean =>
  Boolean(process.argv[1]) && resolve(process.argv[1]!) === __filename;

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`update-path-coverage: failed — ${(err as Error).message}\n`);
    process.exit(1);
  }
}
