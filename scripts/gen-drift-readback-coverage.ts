/**
 * Codegen + CI critic: can every SDK provider's drift readback return each
 * property it handles? (issue #6696)
 *
 * THE GAP THIS CLOSES
 * -------------------
 * `cdkd drift` compares a resource's baseline against what the provider's
 * `readCurrentState` returns. The deploy-time baseline (`observedProperties`)
 * is captured through the SAME readback, so a property the readback never
 * returns is absent on both sides and is never compared: drift reports "no
 * drift" for it whatever AWS holds (#6631: an ECR repository readback without
 * `RepositoryPolicyText`). Nothing reds on such an omission.
 *
 * CLASSIFICATION (per SDK provider type x handled top-level property)
 * -------------------------------------------------------------------
 * Every handled property the committed CFn schema does not mark read-only is
 * classified (what a template can set, and so what a baseline can hold); one
 * the schema capture does not list at all is classified too and marked
 * `outsideSchema`:
 *   - read      — the readback path NAMES it in an emit position (below).
 *   - unknown   — the provider's `getDriftUnknownPaths` declares the WHOLE
 *                 property unreadable (a top-level entry), so drift knows it
 *                 is not compared.
 *   - baseline  — a {@link DRIFT_READBACK_BASELINE} entry: a known gap with its
 *                 tracking issue, or a property with nothing to read back
 *                 (write-only, a cdkd-side input), with its reason.
 *   - gap       — none of the above. BLOCKS CI.
 * A type whose provider declares no `readCurrentState` is listed as
 * `no-readback`: drift already reports it as `drift unknown`, so none of its
 * properties is classified. A `this.x()` call the walk cannot resolve BLOCKS
 * CI: the code behind it is unseen.
 *
 * WHAT IS WALKED (offline, TypeScript AST)
 * ----------------------------------------
 * From `readCurrentState()`, transitively: `this.x` to class members and
 * resolvable base classes, companion-file `this:` functions
 * (`scripts/provider-companion-files.ts`), and any identifier resolving to a
 * module-level function or variable of its file or of a relative `import`
 * under `src/`. Not walked: other classes, `*.generated.ts` modules, the
 * declarative provider tables (`handledProperties`, ...), and type positions.
 * A class serving several types is narrowed per type through `if` / `?:` /
 * `switch` on `resourceType`, as `gen-update-path-coverage.ts` does.
 *
 * WHEN A NAME COUNTS (an emit position)
 * -------------------------------------
 * Only in the provider's OWN files: its file, its companion directory, and a
 * helper module beside it that only its own provider family imports. Other modules (a shared
 * settle / sibling-owned table, another provider) are followed to resolve
 * calls, but name properties of many types without returning them for this
 * one, so they credit nothing. There: an object-literal key (`{ Prop: v }`,
 * `{ Prop }`), an assignment target (`out.Prop = v`, `out['Prop'] = v`), or a
 * string literal anywhere else (a key table the readback iterates) — except
 * an object-literal key or string inside a `new XCommand(...)` request, a
 * string used to READ an element (`resp['Prop']`), a string argument of a
 * call named like warn / log / debug / record / settle / unsettled, and a
 * string compared with `===` / `!==`: each names a property without
 * returning it.
 *
 * BOUNDS
 * ------
 * Positions, not values: a name in an emit position need not reach the
 * returned bag (a key of an unrelated local, a nested member of the same
 * name, a string compared with `===`). So a `gap` is certain to be one — the
 * readback cannot spell the key — while a `read` is not proof the key comes
 * back. Only TOP-LEVEL properties are classified; a nested member a readback
 * drops is out of reach. A dispatch the walk does not narrow (an object-literal
 * table indexed by the type) credits every entry's names to every type.
 *
 * Writes `docs/_generated/drift-readback-coverage.{json,md}`; `--check` fails
 * on any `gap`, on an unresolved call, and on a stale baseline entry (one whose
 * property is no longer a gap), so a fix has to delete its entry.
 *
 * Usage:
 *   node --experimental-strip-types scripts/gen-drift-readback-coverage.ts          # write the matrix
 *   node --experimental-strip-types scripts/gen-drift-readback-coverage.ts --check  # fail on a gap
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// `typescript-v6` is an npm alias of typescript@6 (see gen-property-coverage.ts).
import ts from 'typescript-v6';
import { parseProviderSource } from './gen-property-coverage.ts';
import {
  ModuleIndex,
  branchReach,
  classMembers,
  endsClause,
  isResourceTypeOperand,
  type SourceHost,
} from './gen-update-path-coverage.ts';
import { escapeCell } from './markdown-table.ts';
export { ModuleIndex, type SourceHost };
import { companionFiles } from './provider-companion-files.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..');
const PROVIDERS_DIR = resolve(repoRoot, 'src/provisioning/providers');
const FIXTURE_DIR = resolve(repoRoot, 'tests/fixtures/cfn-schemas');
const OUT_JSON = resolve(repoRoot, 'docs/_generated/drift-readback-coverage.json');
const OUT_MD = resolve(repoRoot, 'docs/_generated/drift-readback-coverage.md');

export interface BaselineEntry {
  /** The open issue tracking the gap, when it is one to close. */
  readonly issue?: number;
  readonly reason: string;
}

export const baselineKey = (resourceType: string, prop: string): string =>
  `${resourceType}#${prop}`;

/**
 * `AWS::X::Y#Prop` -> why the readback does not return it. Every entry must
 * still be a gap: `--check` refuses a stale one, so closing a gap deletes its
 * entry. A known gap names its issue; an entry without one says why there is
 * nothing for a readback to return.
 */
export const DRIFT_READBACK_BASELINE: ReadonlyMap<string, BaselineEntry> = new Map<
  string,
  BaselineEntry
>([
  // ---- nothing to read back ----
  ...(
    [
      ['AWS::AutoScaling::AutoScalingGroup', 'SkipZonalShiftValidation'],
      ['AWS::Connect::Instance', 'DirectoryId'],
      ['AWS::EFS::FileSystem', 'BypassPolicyLockoutSafetyCheck'],
      ['AWS::Events::EventBus', 'EventSourceName'],
      ['AWS::Glue::Trigger', 'StartOnCreation'],
      ['AWS::RDS::DBCluster', 'MasterUserPassword'],
      ['AWS::RDS::DBInstance', 'MasterUserPassword'],
      ['AWS::Route53::RecordSet', 'Comment'],
      ['AWS::Route53::RecordSet', 'HostedZoneName'],
      ['AWS::StepFunctions::StateMachine', 'DefinitionS3Location'],
      ['AWS::StepFunctions::StateMachine', 'DefinitionSubstitutions'],
    ] as const
  ).map(([t, p]): [string, BaselineEntry] => [
    baselineKey(t, p),
    { reason: 'write-only in the CloudFormation registry schema: AWS never returns it' },
  ]),
  [
    'AWS::AutoScaling::AutoScalingGroup#DefaultCooldown',
    {
      reason:
        'a spelling of Cooldown outside the schema capture; the readback returns the live value as Cooldown',
    },
  ],
  [
    'AWS::BedrockAgentCore::Runtime#ClientToken',
    { reason: 'an idempotency token outside the schema capture: no read returns it' },
  ],
  [
    'AWS::RDS::DBInstance#MasterUserAuthenticationType',
    {
      reason:
        'no DescribeDBInstances member (the DBCluster getDriftUnknownPaths declares the same key unread)',
    },
  ],
  [
    'AWS::DocDB::DBCluster#MasterUserPassword',
    { reason: 'a password: DescribeDBClusters never returns it' },
  ],
  [
    'AWS::Route53::RecordSetGroup#Comment',
    { reason: 'the change-batch comment, kept by no record set: nothing returns it' },
  ],
  ...['ManageMasterUserPassword'].flatMap((p) =>
    ['AWS::RDS::DBCluster', 'AWS::RDS::DBInstance'].map((t): [string, BaselineEntry] => [
      baselineKey(t, p),
      { reason: 'no Describe field; its effect is MasterUserSecret, which is read back' },
    ])
  ),
  [
    'AWS::StepFunctions::StateMachine#DefinitionString',
    { reason: 'read back parsed, as Definition, which the captured baseline compares' },
  ],
  ...(['Count', 'Handle', 'Timeout'] as const).map((p): [string, BaselineEntry] => [
    `AWS::CloudFormation::WaitCondition#${p}`,
    { reason: 'cdkd-side input to the S3 signal poll: no AWS resource holds it' },
  ]),
  ...(
    [
      ['AWS::Lambda::Url', 'Qualifier'],
      ['AWS::S3Express::DirectoryBucket', 'LocationName'],
    ] as const
  ).map(([t, p]): [string, BaselineEntry] => [
    baselineKey(t, p),
    { reason: 'create-only and part of the physical id: it cannot change out of band' },
  ]),
]);

// ---------------------------------------------------------------------------
// The readback walk.
// ---------------------------------------------------------------------------

/** Is `n` the name an identifier DECLARES (not a reference to resolve)? */
function isDeclarationName(n: ts.Identifier): boolean {
  const p = n.parent;
  if (!p) return false;
  if (
    (ts.isVariableDeclaration(p) ||
      ts.isParameter(p) ||
      ts.isFunctionDeclaration(p) ||
      ts.isFunctionExpression(p) ||
      ts.isBindingElement(p) ||
      ts.isPropertyAssignment(p) ||
      ts.isPropertyDeclaration(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isClassDeclaration(p)) &&
    (p as { name?: ts.Node }).name === n
  ) {
    return true;
  }
  if (ts.isPropertyAccessExpression(p) && p.name === n) return true;
  if (ts.isBindingElement(p) && p.propertyName === n) return true;
  return false;
}

/** Is `node` inside a `new XCommand(...)` request (an argument, at any depth)? */
function inCommandRequest(node: ts.Node): boolean {
  for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
    if (ts.isNewExpression(cur) && ts.isIdentifier(cur.expression) && /Command$/.test(cur.expression.text)) {
      return true;
    }
    if (ts.isFunctionLike(cur) || ts.isBlock(cur)) return false;
  }
  return false;
}

/** Is `n` the target of an assignment (`x = ...`, `x ??= ...`)? */
function isAssignmentTarget(n: ts.Node): boolean {
  const p = n.parent;
  return (
    p !== undefined &&
    ts.isBinaryExpression(p) &&
    p.left === n &&
    p.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    p.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  );
}

/** The text of a property name a readback can emit, or null. */
function nameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) {
    return name.expression.text;
  }
  return null;
}

export interface WalkInput {
  readonly cls: ts.ClassDeclaration;
  readonly file: string;
  readonly companions: ReadonlyMap<string, { file: string; fn: ts.FunctionDeclaration }>;
  readonly index: ModuleIndex;
  /**
   * The provider's OWN files (its file and its companion directory): names
   * are taken only there. Other modules are followed to resolve calls, but a
   * shared helper (a settle, warn or sibling-owned table) names properties of
   * many types without returning any of them for this one.
   */
  readonly ownFiles?: { has(f: string): boolean };
}

/** A call whose string arguments name a property it reports on, not one it returns. */
const REPORTING_CALLEE = /warn|log|debug|record|settle|unsettled/i;

function calleeName(call: ts.CallExpression): string | null {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return null;
}

export interface ReadbackWalk {
  /** False when neither the class nor a resolvable base declares `readCurrentState`. */
  readonly hasReadback: boolean;
  /** Every name the readback path spells in an emit position. */
  readonly names: ReadonlySet<string>;
  /** Top-level properties `getDriftUnknownPaths` declares unreadable whole. */
  readonly unknown: ReadonlySet<string>;
  /** `this.x(...)` calls on the readback path that resolve to nothing. */
  readonly unresolved: ReadonlySet<string>;
}

/** Walk `readCurrentState()` (and `getDriftUnknownPaths()`) of one class for one type. */
export function walkReadback(input: WalkInput, resourceType: string): ReadbackWalk {
  const { cls, file, companions, index } = input;
  const members = classMembers(cls, file, index);
  const fallbackOwn = new Set([file, ...[...companions.values()].map((c) => c.file)]);
  const ownFiles = input.ownFiles ?? fallbackOwn;
  // A mixin provider installs companion-file `this:` functions on its
  // prototype (`ec2/drift.ts`), so a companion of the name is the method.
  const memberOrCompanion = (name: string): { node: ts.Node; file: string } | undefined => {
    const member = members.get(name);
    if (member) return member;
    const comp = companions.get(name);
    return comp?.fn.body ? { node: comp.fn.body, file: comp.file } : undefined;
  };
  const entry = memberOrCompanion('readCurrentState');
  const unresolved = new Set<string>();
  const names = new Set<string>();
  const unknown = new Set<string>();
  if (!entry) return { hasReadback: false, names, unknown, unresolved };
  // The method itself is the provider's, wherever a base class declares it.
  const isOwn = (f: string): boolean => f === entry.file || ownFiles.has(f);

  const resolveTarget = (n: ts.Node, nodeFile: string): { node: ts.Node; file: string } | null => {
    if (ts.isPropertyAccessExpression(n) && n.expression.kind === ts.SyntaxKind.ThisKeyword) {
      const member = members.get(n.name.text);
      if (member) return member;
      const comp = companions.get(n.name.text);
      return comp?.fn.body ? { node: comp.fn.body, file: comp.file } : null;
    }
    if (ts.isIdentifier(n) && !isDeclarationName(n)) {
      const hit = index.resolve(nodeFile, n.text);
      // Another CLASS is infrastructure (an SDK client, the logger), and a
      // GENERATED module names every type's properties: neither is followed.
      if (hit && !ts.isClassDeclaration(hit.node) && !hit.file.endsWith('.generated.ts')) {
        return ts.isFunctionDeclaration(hit.node)
          ? hit.node.body
            ? { node: hit.node.body, file: hit.file }
            : null
          : ts.isVariableDeclaration(hit.node)
            ? hit.node.initializer
              ? { node: hit.node.initializer, file: hit.file }
              : null
            : hit;
      }
    }
    return null;
  };

  const walk = (root: ts.Node, rootFile: string, take: (name: string) => void): void => {
    const seen = new Set<ts.Node>();
    const queue: Array<{ node: ts.Node; file: string }> = [{ node: root, file: rootFile }];
    const visit = (n: ts.Node, f: string): void => {
      const onName = (name: string): void => {
        if (isOwn(f)) take(name);
      };
      if (ts.isTypeNode(n) || ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) return;
      if (ts.isIfStatement(n) || ts.isConditionalExpression(n)) {
        const condition = ts.isIfStatement(n) ? n.expression : n.condition;
        const reach = branchReach(condition, resourceType);
        if (reach) {
          visit(condition, f);
          const [whenTrue, whenFalse] = ts.isIfStatement(n)
            ? [n.thenStatement, n.elseStatement]
            : [n.whenTrue, n.whenFalse];
          if (reach.then) visit(whenTrue, f);
          if (reach.else && whenFalse) visit(whenFalse, f);
          return;
        }
      }
      // `if (resourceType === X) return ...;` ends the walk of its block for
      // X, and the code after it is another type's: a statement list stops at
      // an if whose only taken arm ends the clause.
      if (ts.isBlock(n) || ts.isSourceFile(n)) {
        for (const st of n.statements) {
          visit(st, f);
          if (!ts.isIfStatement(st)) continue;
          const reach = branchReach(st.expression, resourceType);
          if (!reach) continue;
          if (reach.then && !reach.else && endsClause([st.thenStatement])) break;
          if (reach.else && !reach.then && st.elseStatement && endsClause([st.elseStatement])) break;
        }
        return;
      }
      if (ts.isSwitchStatement(n) && isResourceTypeOperand(n.expression)) {
        const clauses = n.caseBlock.clauses;
        const literalOf = (c: ts.CaseOrDefaultClause): string | null =>
          ts.isCaseClause(c) && ts.isStringLiteralLike(c.expression) && /^AWS::/.test(c.expression.text)
            ? c.expression.text
            : null;
        if (clauses.some((c) => literalOf(c) !== null)) {
          let start = clauses.findIndex((c) => literalOf(c) === resourceType);
          if (start < 0) start = clauses.findIndex((c) => ts.isDefaultClause(c));
          for (let i = start; start >= 0 && i < clauses.length; i++) {
            for (const st of clauses[i]!.statements) visit(st, f);
            if (endsClause(clauses[i]!.statements)) break;
          }
          return;
        }
      }
      // ---- names in an emit position ----
      if (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) {
        const t = nameText(n.name);
        if (t !== null && !inCommandRequest(n)) onName(t);
      } else if (ts.isPropertyAccessExpression(n) && isAssignmentTarget(n)) {
        onName(n.name.text);
      } else if (ts.isStringLiteralLike(n) && !inCommandRequest(n)) {
        const p = n.parent;
        const isElementRead =
          ts.isElementAccessExpression(p) && p.argumentExpression === n && !isAssignmentTarget(p);
        const isImport = ts.isImportDeclaration(p) || ts.isExportDeclaration(p);
        const isKey = ts.isPropertyAssignment(p) && p.name === n;
        // A string a reporting call takes, or one compared, names a property
        // without putting it in the returned bag.
        const isReported =
          ts.isCallExpression(p) &&
          p.arguments.includes(n as ts.Expression) &&
          REPORTING_CALLEE.test(calleeName(p) ?? '');
        const isCompared =
          ts.isBinaryExpression(p) &&
          [
            ts.SyntaxKind.EqualsEqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsEqualsToken,
            ts.SyntaxKind.EqualsEqualsToken,
            ts.SyntaxKind.ExclamationEqualsToken,
          ].includes(p.operatorToken.kind);
        if (!isElementRead && !isImport && !isKey && !isReported && !isCompared) onName(n.text);
      }
      // ---- calls and references to follow ----
      const target = resolveTarget(n, f);
      if (target) {
        if (!seen.has(target.node)) {
          seen.add(target.node);
          queue.push(target);
        }
      } else if (
        ts.isPropertyAccessExpression(n) &&
        n.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isCallExpression(n.parent) &&
        n.parent.expression === n
      ) {
        unresolved.add(n.name.text);
      }
      ts.forEachChild(n, (c) => visit(c, f));
    };
    seen.add(root);
    while (queue.length > 0) {
      const next = queue.shift()!;
      visit(next.node, next.file);
    }
  };

  walk(entry.node, entry.file, (name) => names.add(name));
  const unknownMember = memberOrCompanion('getDriftUnknownPaths');
  if (unknownMember) {
    walk(unknownMember.node, unknownMember.file, (name) => {
      if (/^[A-Z][A-Za-z0-9]*$/.test(name)) unknown.add(name);
    });
  }
  return { hasReadback: true, names, unknown, unresolved };
}

// ---------------------------------------------------------------------------
// Classification.
// ---------------------------------------------------------------------------

export type Status = 'read' | 'unknown' | 'baseline' | 'gap';

export interface PropertyRow {
  readonly property: string;
  readonly status: Status;
  readonly issue?: number;
  readonly reason?: string;
  /** The committed CFn schema capture does not list it (still classified). */
  readonly outsideSchema?: true;
}

export interface TypeRow {
  readonly resourceType: string;
  readonly file: string;
  readonly className: string;
  /** False: the provider declares no `readCurrentState`; `properties` is empty. */
  readonly hasReadback: boolean;
  readonly properties: readonly PropertyRow[];
  /** See {@link ReadbackWalk.unresolved}. A non-empty list BLOCKS CI. */
  readonly unresolved: readonly string[];
}

export interface SchemaFacts {
  readonly properties: ReadonlySet<string>;
  readonly readOnly: ReadonlySet<string>;
}

export interface ClassifyInput {
  readonly file: string;
  readonly companions: readonly string[];
  readonly index: ModuleIndex;
  readonly schema: (resourceType: string) => SchemaFacts | null;
  readonly baseline?: ReadonlyMap<string, BaselineEntry>;
  readonly displayFile?: string;
  /** {@link helperFamilies} over the providers directory; absent: no helper is own. */
  readonly helperFamilies?: ReadonlyMap<string, string | null>;
}

/** The family of a provider facade: the first segment of its stem (`docdb-subnet-group` -> `docdb`). */
export function providerFamily(providerFile: string): string {
  return basename(providerFile).replace(/-provider\.ts$/, '').split('-')[0]!;
}

/**
 * Each helper module beside the provider facades (`docdb-shared.ts`) -> the
 * one provider family whose files import it, or null when its importers span
 * several families (`db-associated-roles.ts`) or are no provider's files. A
 * provider's file is its facade or a file of its companion directory.
 */
export function helperFamilies(
  providerFiles: readonly string[],
  companionsOf: (providerFile: string) => readonly string[],
  index: ModuleIndex
): Map<string, string | null> {
  const families = new Map<string, Set<string>>();
  for (const pf of providerFiles) {
    const root = dirname(pf);
    for (const f of [pf, ...companionsOf(pf)]) {
      for (const imp of index.get(f)?.imports.values() ?? []) {
        if (dirname(imp.file) !== root || imp.file.endsWith('-provider.ts')) continue;
        const set = families.get(imp.file) ?? new Set<string>();
        set.add(providerFamily(pf));
        families.set(imp.file, set);
      }
    }
  }
  return new Map([...families].map(([h, set]) => [h, set.size === 1 ? [...set][0]! : null]));
}

/**
 * A predicate for the files whose names count for the provider at `file`: the
 * file, its companion directory, and a helper beside it that only its own
 * family imports — never another provider's facade or companion directory, a
 * helper several families share, nor a module outside the directory.
 */
function providerOwnFiles(
  file: string,
  companions: readonly string[],
  families: ReadonlyMap<string, string | null>
): { has(f: string): boolean } {
  const own = new Set([file, ...companions]);
  const family = providerFamily(file);
  return { has: (f) => own.has(f) || families.get(f) === family };
}

export function classifyFile(input: ClassifyInput): TypeRow[] {
  const { file, index, schema } = input;
  const baseline = input.baseline ?? DRIFT_READBACK_BASELINE;
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
  const ownFiles = providerOwnFiles(file, input.companions, input.helperFamilies ?? new Map());
  const visit = (n: ts.Node): void => {
    if (ts.isClassDeclaration(n) && n.name) {
      const handled = parseProviderSource(n.getText(), file).handled;
      for (const [resourceType, props] of handled) {
        const facts = schema(resourceType);
        // Fail closed: a type without a committed schema would drop out unseen.
        if (!facts) {
          throw new Error(`${resourceType} (${input.displayFile ?? file}) has no CFn schema fixture`);
        }
        const walk = walkReadback({ cls: n, file, companions, index, ownFiles }, resourceType);
        const sorted = [...props]
          .filter((p) => !facts.readOnly.has(p))
          .sort((a, b) => a.localeCompare(b));
        // A handled name the committed schema capture does not list (newer
        // than the capture, or a cdkd-side input) is classified all the same,
        // marked, so removing its emit still fails the check.
        const classifyOne = (p: string): PropertyRow => {
          if (walk.names.has(p)) return { property: p, status: 'read' };
          if (walk.unknown.has(p)) return { property: p, status: 'unknown' };
          const b = baseline.get(baselineKey(resourceType, p));
          if (!b) return { property: p, status: 'gap' };
          return {
            property: p,
            status: 'baseline',
            ...(b.issue !== undefined ? { issue: b.issue } : {}),
            reason: b.reason,
          };
        };
        const properties: PropertyRow[] = walk.hasReadback
          ? sorted.map((p): PropertyRow => {
              const row = classifyOne(p);
              return facts.properties.has(p) ? row : { ...row, outsideSchema: true };
            })
          : [];
        rows.push({
          resourceType,
          file: input.displayFile ?? file,
          className: n.name.text,
          hasReadback: walk.hasReadback,
          properties,
          unresolved: [...walk.unresolved].sort((a, b) => a.localeCompare(b)),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return rows;
}

export interface DriftReadbackCoverageReport {
  readonly summary: {
    readonly types: number;
    readonly noReadback: number;
    readonly properties: number;
    readonly read: number;
    readonly unknown: number;
    readonly baseline: number;
    readonly gap: number;
    readonly outsideSchema: number;
  };
  readonly types: readonly TypeRow[];
}

export function buildReport(rows: readonly TypeRow[]): DriftReadbackCoverageReport {
  const sorted = [...rows].sort((a, b) => a.resourceType.localeCompare(b.resourceType));
  const all = sorted.flatMap((r) => r.properties);
  const count = (s: Status): number => all.filter((p) => p.status === s).length;
  return {
    summary: {
      types: sorted.length,
      noReadback: sorted.filter((r) => !r.hasReadback).length,
      properties: all.length,
      read: count('read'),
      unknown: count('unknown'),
      baseline: count('baseline'),
      gap: count('gap'),
      outsideSchema: all.filter((p) => p.outsideSchema).length,
    },
    types: sorted,
  };
}

export function findGaps(report: DriftReadbackCoverageReport): string[] {
  return report.types.flatMap((t) =>
    t.properties.filter((p) => p.status === 'gap').map((p) => baselineKey(t.resourceType, p.property))
  );
}

export function findUnresolved(report: DriftReadbackCoverageReport): string[] {
  return report.types.flatMap((t) =>
    t.unresolved.map((u) => `${t.className} (${t.resourceType}): this.${u}()`)
  );
}

/** Baseline keys that no longer name a `baseline` row. */
export function findStaleBaselineEntries(
  report: DriftReadbackCoverageReport,
  baseline: ReadonlyMap<string, BaselineEntry> = DRIFT_READBACK_BASELINE
): string[] {
  const live = new Set(
    report.types.flatMap((t) =>
      t.properties
        .filter((p) => p.status === 'baseline')
        .map((p) => baselineKey(t.resourceType, p.property))
    )
  );
  return [...baseline.keys()].filter((k) => !live.has(k)).sort();
}

function loadSchema(resourceType: string): SchemaFacts | null {
  const path = join(FIXTURE_DIR, `${resourceType.replace(/::/g, '-')}.json`);
  if (!existsSync(path)) return null;
  const f = JSON.parse(readFileSync(path, 'utf8')) as {
    properties: string[];
    readOnlyProperties: string[];
  };
  return { properties: new Set(f.properties), readOnly: new Set(f.readOnlyProperties) };
}

const diskHost: SourceHost = {
  read: (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null),
};

/** The matrix as `gen:drift-readback-coverage` builds it from the real tree. */
export function loadReport(host: SourceHost = diskHost): DriftReadbackCoverageReport {
  const index = new ModuleIndex(host);
  const rows: TypeRow[] = [];
  const files = readdirSync(PROVIDERS_DIR)
    .sort()
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.endsWith('.test.ts'))
    .map((name) => join(PROVIDERS_DIR, name));
  const families = helperFamilies(
    files.filter((f) => f.endsWith('-provider.ts')),
    companionFiles,
    index
  );
  for (const file of files) {
    rows.push(
      ...classifyFile({
        file,
        companions: companionFiles(file),
        index,
        schema: loadSchema,
        displayFile: relative(repoRoot, file),
        helperFamilies: families,
      })
    );
  }
  return buildReport(rows);
}

function renderMarkdown(report: DriftReadbackCoverageReport): string {
  const s = report.summary;
  const lines: string[] = [
    '---',
    'title: "Drift readback property coverage matrix"',
    'unlisted: true',
    '---',
    '',
    '# SDK-provider drift readback property coverage matrix',
    '',
    '<!-- AUTO-GENERATED by scripts/gen-drift-readback-coverage.ts — DO NOT EDIT BY HAND. -->',
    '<!-- Regenerate: `vp run gen:drift-readback-coverage`. -->',
    '',
    'For every SDK provider type and every top-level property its `handledProperties` ' +
      'declares that the CloudFormation schema does not mark read-only, whether the ' +
      "provider's `readCurrentState` can return it. The deploy-time drift baseline is " +
      'captured through the same readback, so a property it never returns is never ' +
      'compared, and `cdkd drift` reports no drift for it whatever AWS holds (issue #6696).',
    '',
    '## Summary',
    '',
    `- SDK provider types: **${s.types}** (without a readback, reported as \`drift unknown\`: **${s.noReadback}**)`,
    `- Handled properties classified: **${s.properties}**`,
    `- Named on the readback path: **${s.read}**`,
    `- Declared unreadable by \`getDriftUnknownPaths\`: **${s.unknown}**`,
    `- In the committed baseline (does NOT block CI): **${s.baseline}**`,
    `- Classified though the schema capture does not list them: **${s.outsideSchema}**`,
    `- **Gaps (blocks CI): ${s.gap}**`,
    '',
    '## Gaps and baseline entries',
    '',
  ];
  const flagged = report.types.flatMap((t) =>
    t.properties.filter((p) => p.status === 'gap' || p.status === 'baseline').map((p) => ({ t, p }))
  );
  if (flagged.length === 0) {
    lines.push('None. Every classified property is named on its readback path.', '');
  } else {
    lines.push('| Type | Property | Status | Issue | Reason |', '| --- | --- | --- | --- | --- |');
    for (const { t, p } of flagged) {
      lines.push(
        `| \`${t.resourceType}\` | \`${p.property}\` | ${p.status} | ${p.issue !== undefined ? `#${p.issue}` : ''} | ${escapeCell(p.reason ?? '')} |`
      );
    }
    lines.push('');
  }
  const noReadback = report.types.filter((t) => !t.hasReadback);
  lines.push('## Types without a readback', '');
  if (noReadback.length === 0) lines.push('None.', '');
  else {
    lines.push('| Type | Provider |', '| --- | --- |');
    for (const t of noReadback) lines.push(`| \`${t.resourceType}\` | \`${t.className}\` |`);
    lines.push('');
  }
  lines.push('## Full classification', '', '| Type | Provider | Read | Declared unreadable |', '| --- | --- | --- | --- |');
  for (const t of report.types.filter((r) => r.hasReadback)) {
    const names = (st: Status): string =>
      t.properties
        .filter((p) => p.status === st)
        .map((p) => p.property)
        .join(', ');
    lines.push(
      `| \`${t.resourceType}\` | \`${t.className}\` | ${escapeCell(names('read'))} | ${escapeCell(names('unknown'))} |`
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
    const stale = findStaleBaselineEntries(report);
    const unresolved = findUnresolved(report);
    if (gaps.length > 0 || stale.length > 0 || unresolved.length > 0) {
      process.stderr.write(
        'drift-readback-coverage: FAIL\n' +
          (gaps.length > 0
            ? "A handled property the drift readback never returns is never compared: the\n" +
              'deploy-time baseline is captured through the same readback, so `cdkd drift`\n' +
              'reports no drift for it whatever AWS holds (#6696). Return it from\n' +
              'readCurrentState, declare it in getDriftUnknownPaths when AWS cannot return\n' +
              'it, OR add a DRIFT_READBACK_BASELINE entry (with its issue) in\n' +
              'scripts/gen-drift-readback-coverage.ts.\n' +
              gaps.map((g) => `  gap: ${g}\n`).join('')
            : '') +
          (stale.length > 0
            ? 'DRIFT_READBACK_BASELINE entries that are no longer gaps — delete them:\n' +
              stale.map((g) => `  stale: ${g}\n`).join('')
            : '') +
          (unresolved.length > 0
            ? 'readCurrentState() reaches this.x() calls that resolve to no member, base-class\n' +
              'member or companion function, so the code behind them is unseen:\n' +
              unresolved.map((u) => `  unresolved: ${u}\n`).join('')
            : '')
      );
      process.exit(1);
    }
    process.stderr.write(
      `drift-readback-coverage: OK — ${report.summary.properties} handled properties over ` +
        `${report.summary.types} types, 0 gaps (${report.summary.baseline} in the baseline).\n`
    );
    return;
  }
  mkdirSync(dirname(OUT_JSON), { recursive: true });
  atomicWrite(OUT_JSON, JSON.stringify(report, null, 2) + '\n');
  atomicWrite(OUT_MD, renderMarkdown(report) + '\n');
  process.stderr.write(
    `drift-readback-coverage: wrote drift-readback-coverage.{json,md} — ${report.summary.properties} ` +
      `properties, ${report.summary.read} read, ${report.summary.unknown} declared unreadable, ` +
      `${report.summary.baseline} baseline, ${report.summary.gap} gap(s).\n`
  );
}

const isMainModule = (): boolean =>
  Boolean(process.argv[1]) && resolve(process.argv[1]!) === __filename;

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`drift-readback-coverage: failed — ${(err as Error).message}\n`);
    process.exit(1);
  }
}
