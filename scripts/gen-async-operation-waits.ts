/**
 * Codegen + CI critic: does every provider call that STARTS an asynchronous AWS
 * change wait for it as CloudFormation does? (issue
 * [#7132](https://github.com/go-to-k/cdkd/issues/7132))
 *
 * THE GAP THIS CLOSES
 * -------------------
 * A provider that sends a call which only starts a change (`StartSchemaCreation`,
 * an enable toggle, a create that answers in a transitional state) and returns
 * as if it were applied records the drift baseline before the change lands and
 * never reads the failure AWS reports later. Three `severity:high` findings
 * were each found one type at a time: #5737 (Lambda `CreateEventSourceMapping`,
 * `State: Creating`), #6778 (DynamoDB `UpdateContributorInsights`, `ENABLING`)
 * and #7127 (AppSync `StartSchemaCreation`, `PROCESSING`).
 *
 * THE POPULATION
 * --------------
 * Every `new <X>Command(` under `src/provisioning/providers/**` whose `<X>Command`
 * is imported from an `@aws-sdk/client-*` package, and whose operation is
 * asynchronous BY THE SDK MODEL (read from the installed
 * `node_modules/@aws-sdk/client-<svc>/dist-types` with the TypeScript compiler
 * API, never executed):
 *
 *   - `start-operation`: the operation name starts with `Start`;
 *   - `transitional-enum`: the command's output shape, at the top level or up
 *     to {@link WALK_DEPTH} structures below it (a member typed as a structure,
 *     or an array of one),
 *     has a member typed as an SDK string enum with a transitional value
 *     ({@link isTransitionalValue}: `*ING`, `PROCESSING`, anything containing
 *     `IN_PROGRESS` (`CREATE_IN_PROGRESS`) or starting or ending with
 *     `PENDING`, compared case- and separator-insensitively);
 *   - `state-string`: the same walk finds a member named `State` / `Status` /
 *     `*State` / `*Status` typed plain `string`. The SDK models some status
 *     members without an enum (Lambda's `EventSourceMappingConfiguration.State`,
 *     #5737), which the enum rule cannot see.
 *
 * Read operations (`Describe*`, `Get*`, `List*`, ...: {@link READ_PREFIXES}) are
 * left out: they start nothing; they are what a wait SENDS.
 *
 * BOUND: only `src/provisioning/providers/**` is read, so an asynchronous send
 * from a shared helper outside it (the final-snapshot `CreateSnapshot` /
 * `CreateClusterSnapshot` calls, Cloud Control) is not in the population. The
 * test names those sites (`OUT_OF_SCOPE_SEND_SITES`).
 *
 * BOUND: the walk is {@link WALK_DEPTH} structures deep, so a deeper status is
 * missed, and an operation whose output carries no status at all (a
 * `Modify*` answering `{}` while the change applies) is invisible to all three
 * rules. A waiter-only signal (the service ships `waitUntil*` for the
 * resource) is not used: it names a DESCRIBE operation, not the write.
 *
 * BOUND: the per-site check ({@link checkSendSites}) holds that the FUNCTION
 * holding each send (or one function it calls, or a direct caller) calls a
 * helper, not that the call runs after THIS send on every path. A generic
 * name another operation of the same function also calls (`waitForSettled`)
 * keeps passing if this operation's wait is deleted.
 *
 * CLASSIFICATION
 * --------------
 * By hand, in `src/provisioning/async-operation-waits.ts`, one row per
 * `<client>:<Operation>` (`appsync:StartSchemaCreation`): `waits` (the
 * helpers each sending provider unit calls, and the terminal failure statuses
 * it fails on), `no-wait-by-design` (the reason and its evidence) or
 * `unmeasured` (needs a CloudFormation A/B; #7132 tracks it).
 *
 * `--check` (CI) FAILS on a population row with no classification, on a
 * classification naming an operation no provider sends any more (or one the
 * rules no longer flag), on a `waits` row whose helpers a sending provider unit
 * no longer calls, on a SEND SITE of a `waits` operation that reaches none of
 * the row's helpers and is not in {@link SEND_SITE_EXEMPTIONS} (a second send
 * of an operation the unit already waits for elsewhere, added without a wait),
 * and on stale generated files. A provider UNIT is the
 * `<name>-provider.ts` file plus its `<name>/` companion directory.
 *
 *   node --experimental-strip-types scripts/gen-async-operation-waits.ts          # regenerate
 *   node --experimental-strip-types scripts/gen-async-operation-waits.ts --check  # critic
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// oxlint-disable-next-line import/no-named-as-default -- typescript-v6's default export IS the API namespace
import ts from 'typescript-v6';

import {
  ASYNC_OPERATION_CLASSIFICATION,
  type AsyncOperationVerdict,
} from '../src/provisioning/async-operation-waits.ts';
import { escapeCell } from './markdown-table.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const repoRoot = resolve(__dirname, '..');
export const PROVIDERS_DIR = resolve(repoRoot, 'src/provisioning/providers');
export const OUT_JSON = resolve(repoRoot, 'docs/_generated/async-operation-waits.json');
export const OUT_MD = resolve(repoRoot, 'docs/_generated/async-operation-waits.md');

/** Why the SDK model calls an operation asynchronous. */
export type AsyncSignal = 'start-operation' | 'transitional-enum' | 'state-string';

/** Operation-name prefixes that only read; they start no change. */
export const READ_PREFIXES = [
  'Describe',
  'Get',
  'List',
  'Search',
  'Query',
  'Scan',
  'Head',
  'Lookup',
  'BatchGet',
] as const;

/**
 * Values ending in `ING` that name no transition, compared after
 * {@link isTransitionalValue}'s normalization. Each was measured against the
 * population (#7132): it was the ONLY transitional-looking value flagging an
 * operation whose output it merely describes — a storage class (FSx
 * `INTELLIGENT_TIERING`, SSM `Intelligent-Tiering`), a throughput mode (EFS
 * `bursting`), a load balancer scheme (`internet-facing`), a steady state
 * (Pipes' requested `RUNNING`) or a replica's protection setting (EFS
 * `REPLICATING`). `WARNING` / `THROTTLING` are pre-emptive: a severity and an
 * error code. Any value ending in `STRING` (`SINGLE_STRING`) is a data type.
 */
const NON_TRANSITIONAL_ING = new Set([
  'WARNING',
  'THROTTLING',
  'INTELLIGENTTIERING',
  'BURSTING',
  'INTERNETFACING',
  'RUNNING',
  'REPLICATING',
]);

/** Whether an enum value names an in-progress state. */
export function isTransitionalValue(value: string): boolean {
  const v = value.toUpperCase().replace(/[^A-Z]/g, '');
  if (v.includes('INPROGRESS') || v.startsWith('PENDING') || v.endsWith('PENDING')) return true;
  if (v === 'PROCESSING') return true;
  return v.endsWith('ING') && !v.endsWith('STRING') && !NON_TRANSITIONAL_ING.has(v);
}

const STATE_MEMBER = /^(?:.*State|.*Status|state|status)$/;

/** One finding of the model walk, e.g. `status: SchemaStatus (PROCESSING)`. */
export interface AsyncEvidence {
  readonly signal: AsyncSignal;
  readonly detail: string;
}

/** One `new <X>Command(` site. */
export interface SendSite {
  readonly client: string;
  readonly operation: string;
  /** Repo-relative path of the sending file. */
  readonly file: string;
  /** Repo-relative path of the provider unit's root file. */
  readonly unit: string;
}

export interface PopulationRow {
  /** `<client>:<Operation>`, e.g. `appsync:StartSchemaCreation`. */
  readonly key: string;
  readonly client: string;
  readonly operation: string;
  readonly evidence: readonly AsyncEvidence[];
  /** Sorted, de-duplicated sending files. */
  readonly files: readonly string[];
  /** Sorted, de-duplicated provider units. */
  readonly units: readonly string[];
}

const rel = (p: string): string => relative(repoRoot, p).split(sep).join('/');

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkTs(path, out);
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      out.push(path);
    }
  }
  return out.sort();
}

/**
 * The provider unit a file belongs to: `providers/<name>/**` belongs to
 * `providers/<name>-provider.ts` when that file exists; any other file is its
 * own unit.
 */
export function unitOf(file: string): string {
  const r = relative(PROVIDERS_DIR, file).split(sep);
  if (r.length > 1) {
    const root = join(PROVIDERS_DIR, `${r[0]}-provider.ts`);
    if (existsSync(root)) return root;
  }
  return file;
}

/** Every file of a provider unit (the root plus its companion directory). */
export function unitFiles(unit: string): string[] {
  const m = /^(.+)-provider\.ts$/.exec(basename(unit));
  const files = [unit];
  if (m) {
    const dir = join(dirname(unit), m[1]!);
    if (existsSync(dir)) files.push(...walkTs(dir));
  }
  return files;
}

const parse = (file: string): ts.SourceFile =>
  ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);

/** Every `new <X>Command(` in one file whose class comes from an SDK client. */
export function collectSendSites(file: string): SendSite[] {
  return sendNodes(parse(file)).map(({ client, operation }) => ({
    client,
    operation,
    file: rel(file),
    unit: rel(unitOf(file)),
  }));
}

/** {@link collectSendSites}, keeping each `new` expression. */
function sendNodes(sf: ts.SourceFile): { client: string; operation: string; node: ts.Node }[] {
  const imported = new Map<string, { client: string; name: string }>();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const m = /^@aws-sdk\/client-([a-z0-9-]+)$/.exec(stmt.moduleSpecifier.text);
    const named = stmt.importClause?.namedBindings;
    if (!m || !named || !ts.isNamedImports(named)) continue;
    for (const el of named.elements) {
      const name = (el.propertyName ?? el.name).text;
      if (name.endsWith('Command')) imported.set(el.name.text, { client: m[1]!, name });
    }
  }
  const sites: { client: string; operation: string; node: ts.Node }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const hit = imported.get(node.expression.text);
      if (hit) {
        sites.push({ client: hit.client, operation: hit.name.slice(0, -'Command'.length), node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

/** The parts of one SDK client's model the walk reads. */
export interface SdkModel {
  /** enum name -> its string values. */
  readonly enums: ReadonlyMap<string, readonly string[]>;
  /** interface name -> member name -> unwrapped type node. */
  readonly interfaces: ReadonlyMap<string, ReadonlyMap<string, ts.TypeNode | undefined>>;
}

const unwrapOptional = (node: ts.TypeNode | undefined): ts.TypeNode | undefined => {
  if (node && ts.isUnionTypeNode(node)) {
    const rest = node.types.filter(
      (t) =>
        t.kind !== ts.SyntaxKind.UndefinedKeyword &&
        !(ts.isLiteralTypeNode(t) && t.literal.kind === ts.SyntaxKind.NullKeyword)
    );
    return rest.length === 1 ? rest[0] : node;
  }
  return node;
};

function collectInterfaces(
  sf: ts.SourceFile,
  into: Map<string, Map<string, ts.TypeNode | undefined>>
): void {
  for (const stmt of sf.statements) {
    if (!ts.isInterfaceDeclaration(stmt)) continue;
    const members = into.get(stmt.name.text) ?? new Map<string, ts.TypeNode | undefined>();
    for (const m of stmt.members) {
      if (ts.isPropertySignature(m) && (ts.isIdentifier(m.name) || ts.isStringLiteral(m.name))) {
        members.set(m.name.text, unwrapOptional(m.type));
      }
    }
    into.set(stmt.name.text, members);
  }
}

const modelCache = new Map<string, SdkModel>();

/** Read `@aws-sdk/client-<client>`'s model typings. */
export function loadSdkModel(client: string): SdkModel {
  const cached = modelCache.get(client);
  if (cached) return cached;
  const modelsDir = join(repoRoot, 'node_modules', `@aws-sdk/client-${client}`, 'dist-types/models');
  if (!existsSync(modelsDir)) throw new Error(`@aws-sdk/client-${client}: no dist-types/models`);
  const enums = new Map<string, string[]>();
  const interfaces = new Map<string, Map<string, ts.TypeNode | undefined>>();
  for (const f of readdirSync(modelsDir).sort()) {
    if (!f.endsWith('.d.ts')) continue;
    const sf = parse(join(modelsDir, f));
    collectInterfaces(sf, interfaces);
    for (const stmt of sf.statements) {
      // `export declare const X: { readonly A: "a"; ... }`
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !d.type || !ts.isTypeLiteralNode(d.type)) continue;
          const values: string[] = [];
          for (const m of d.type.members) {
            const t = ts.isPropertySignature(m) ? m.type : undefined;
            if (t && ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) values.push(t.literal.text);
          }
          if (values.length > 0) enums.set(d.name.text, values);
        }
      }
      // `export type X = "a" | "b"` (older generator output)
      if (ts.isTypeAliasDeclaration(stmt) && ts.isUnionTypeNode(stmt.type)) {
        const values = stmt.type.types.flatMap((t) =>
          ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? [t.literal.text] : []
        );
        if (values.length > 0 && !enums.has(stmt.name.text)) enums.set(stmt.name.text, values);
      }
    }
  }
  const model = { enums, interfaces };
  modelCache.set(client, model);
  return model;
}

/** The members of `<Operation>CommandOutput`, flattened over its base interfaces. */
export function outputMembers(
  client: string,
  operation: string,
  model: SdkModel
): Map<string, ts.TypeNode | undefined> {
  const file = join(
    repoRoot,
    'node_modules',
    `@aws-sdk/client-${client}`,
    'dist-types/commands',
    `${operation}Command.d.ts`
  );
  if (!existsSync(file)) throw new Error(`@aws-sdk/client-${client}: no ${operation}Command.d.ts`);
  const sf = parse(file);
  const out = new Map<string, ts.TypeNode | undefined>();
  const own = new Map<string, Map<string, ts.TypeNode | undefined>>();
  collectInterfaces(sf, own);
  const name = `${operation}CommandOutput`;
  for (const stmt of sf.statements) {
    if (!ts.isInterfaceDeclaration(stmt) || stmt.name.text !== name) continue;
    for (const clause of stmt.heritageClauses ?? []) {
      for (const t of clause.types) {
        if (!ts.isIdentifier(t.expression)) continue;
        for (const [k, v] of model.interfaces.get(t.expression.text) ?? []) out.set(k, v);
      }
    }
  }
  for (const [k, v] of own.get(name) ?? []) out.set(k, v);
  return out;
}

const refName = (node: ts.TypeNode | undefined): string | undefined =>
  node && ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)
    ? node.typeName.text
    : undefined;

/** The structure an output member points to: `X`, `X[]` or `Array<X>`. */
const structureName = (node: ts.TypeNode | undefined): string | undefined => {
  if (!node) return undefined;
  if (ts.isArrayTypeNode(node)) return refName(node.elementType);
  const r = refName(node);
  if (r === 'Array' && ts.isTypeReferenceNode(node)) return refName(node.typeArguments?.[0]);
  return r;
};

/**
 * How many structures below the output the walk descends. Two reaches a
 * status held in a list of structures that each carry a state structure
 * (ELBv2 `LoadBalancers[].State.Code`, EC2 `Instances[].State.Name`); one
 * missed 20 operations (#7132 review). A deeper walk is unmeasured.
 */
export const WALK_DEPTH = 2;

/** Every signal the model walk finds for one operation's output. */
export function asyncEvidence(client: string, operation: string): AsyncEvidence[] {
  const evidence: AsyncEvidence[] = [];
  if (operation.startsWith('Start')) evidence.push({ signal: 'start-operation', detail: operation });
  const model = loadSdkModel(client);
  const inspect = (path: string, member: string, type: ts.TypeNode | undefined): void => {
    const r = refName(type);
    const values = r ? model.enums.get(r) : undefined;
    if (values) {
      const transitional = values.filter(isTransitionalValue);
      if (transitional.length > 0) {
        evidence.push({
          signal: 'transitional-enum',
          detail: `${path}${member}: ${r} (${transitional.join(', ')})`,
        });
      }
    } else if (type?.kind === ts.SyntaxKind.StringKeyword && STATE_MEMBER.test(member)) {
      evidence.push({ signal: 'state-string', detail: `${path}${member}: string` });
    }
  };
  const walk = (
    path: string,
    members: ReadonlyMap<string, ts.TypeNode | undefined>,
    depth: number
  ): void => {
    for (const [member, type] of members) {
      inspect(path, member, type);
      if (depth >= WALK_DEPTH) continue;
      const nested = structureName(type);
      const shape = nested ? model.interfaces.get(nested) : undefined;
      if (shape) walk(`${path}${member}.`, shape, depth + 1);
    }
  };
  walk('', outputMembers(client, operation, model), 0);
  return evidence;
}

/** Every send site under the providers directory. */
export function collectAllSendSites(): SendSite[] {
  return walkTs(PROVIDERS_DIR).flatMap(collectSendSites);
}

/**
 * Every asynchronous send under `src/provisioning/**` OUTSIDE `providers/`,
 * as `<file> <client>:<Operation>`. Not classified: the test names them
 * (`OUT_OF_SCOPE_SEND_SITES`) so a new one is a decision, not an accident.
 */
export function collectOutOfScopeAsyncSends(): string[] {
  const root = resolve(repoRoot, 'src/provisioning');
  const files = walkTs(root).filter((f) => !f.startsWith(PROVIDERS_DIR + sep));
  const out = new Set<string>();
  for (const site of files.flatMap(collectSendSites)) {
    if (isRead(site.operation)) continue;
    if (asyncEvidence(site.client, site.operation).length === 0) continue;
    out.add(`${site.file} ${site.client}:${site.operation}`);
  }
  return [...out].sort();
}

const isRead = (operation: string): boolean =>
  READ_PREFIXES.some((p) => operation.startsWith(p) && /^[A-Z]/.test(operation.slice(p.length)));

/** The population: every sent, non-read operation with at least one signal. */
export function buildPopulation(sites: readonly SendSite[] = collectAllSendSites()): PopulationRow[] {
  const byKey = new Map<string, SendSite[]>();
  for (const s of sites) {
    if (isRead(s.operation)) continue;
    const key = `${s.client}:${s.operation}`;
    byKey.set(key, [...(byKey.get(key) ?? []), s]);
  }
  const rows: PopulationRow[] = [];
  for (const [key, group] of byKey) {
    const { client, operation } = group[0]!;
    const evidence = asyncEvidence(client, operation);
    if (evidence.length === 0) continue;
    rows.push({
      key,
      client,
      operation,
      evidence,
      files: [...new Set(group.map((s) => s.file))].sort(),
      units: [...new Set(group.map((s) => s.unit))].sort(),
    });
  }
  return rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** The name of the function-like member or declaration a node sits in. */
const enclosingName = (node: ts.Node): string | undefined => {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (
      (ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isPropertyDeclaration(n)) &&
      n.name &&
      (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))
    ) {
      return n.name.text;
    }
  }
  return undefined;
};

const isFunctionLike = (n: ts.Node): boolean =>
  ts.isFunctionDeclaration(n) ||
  ts.isMethodDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n);

/** The innermost function-like node holding `node`. */
const enclosingFunction = (node: ts.Node): ts.Node | undefined => {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) if (isFunctionLike(n)) return n;
  return undefined;
};

/** Whether a node constructs `new <name>(...)` (by its local import name). */
const constructs = (node: ts.Node, name: string): boolean =>
  ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name;

/**
 * Whether a function of the unit that sends `new <operation>Command(` also
 * constructs `new <pollCommand>(` (an inline poll loop, e.g. RDS proxy
 * `create()` polling `DescribeDBProxiesCommand`), in the SAME function body.
 */
export function unitPollsInline(unit: string, operation: string, pollCommand: string): boolean {
  return unitFiles(resolve(repoRoot, unit)).some((file) => {
    const sends = new Set<ts.Node>();
    const polls = new Set<ts.Node>();
    const visit = (node: ts.Node): void => {
      const fn = enclosingFunction(node);
      if (fn && constructs(node, `${operation}Command`)) sends.add(fn);
      if (fn && constructs(node, pollCommand)) polls.add(fn);
      ts.forEachChild(node, visit);
    };
    visit(parse(file));
    return [...sends].some((fn) => polls.has(fn));
  });
}

/**
 * Whether any file of the unit CALLS `helper`: `helper(...)`, `this.helper(...)`,
 * `x.helper(...)`, or `helper.call(...)` / `.apply(...)`. A declaration, an
 * import, a reference passed without a call and a self-delegation (a member
 * named `helper` whose body calls `helper.call(this, ...)`) do not count: each
 * survives deleting every real wait (#7132 review).
 */
export function unitCalls(unit: string, helper: string): boolean {
  return unitFiles(resolve(repoRoot, unit)).some((file) => unitCallsInFile(file, helper));
}

/** {@link unitCalls} for one file (repo-relative or absolute). */
export function unitCallsInFile(file: string, helper: string): boolean {
  {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const direct =
          (ts.isIdentifier(callee) && callee.text === helper) ||
          (ts.isPropertyAccessExpression(callee) && callee.name.text === helper);
        const viaCall =
          ts.isPropertyAccessExpression(callee) &&
          (callee.name.text === 'call' || callee.name.text === 'apply') &&
          ((ts.isIdentifier(callee.expression) && callee.expression.text === helper) ||
            (ts.isPropertyAccessExpression(callee.expression) &&
              callee.expression.name.text === helper));
        if ((direct || viaCall) && enclosingName(node) !== helper) {
          found = true;
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(parse(resolve(repoRoot, file)));
    return found;
  }
}

const P = 'src/provisioning/providers/';
const FAILED_CREATE = 'the failed-create cleanup delete does not wait (the row note)';
const FLIP_SITE =
  'a DeletionProtection flip around a delete does not wait after the call (the row note)';

/**
 * Send sites of a `waits` operation that reach none of the row's helpers
 * ({@link checkSendSites}), as `<client>:<Operation> <file> <function>` (the
 * outermost named function holding the send) -> why the site does not wait
 * there. Each names exactly ONE site: a second send in the same function, or an
 * exempted site that now reaches a helper, fails the check. Measured on the
 * tree at the #7132 per-site check; keep it minimal.
 */
export const SEND_SITE_EXEMPTIONS: Readonly<Record<string, string>> = {
  [`bedrock-agentcore-control:DeleteAgentRuntime ${P}agentcore-runtime/wait.ts retireFailedRuntimeCreate`]:
    FAILED_CREATE,
  [`docdb:ModifyDBCluster ${P}docdb/cluster-create.ts sendRestoreFollowUp`]:
    'the restore follow-up waits through waitForClusterAvailable, a helper the row does not list',
  [`docdb:ModifyDBCluster ${P}docdb/cluster-delete.ts deleteDBCluster`]: FLIP_SITE,
  [`docdb:ModifyDBCluster ${P}docdb/cluster-delete.ts deleteDBClusterOnce`]: FLIP_SITE,
  [`dynamodb:DeleteTable ${P}dynamodb-globaltable/create-commit.ts createPhaseCommit`]: FAILED_CREATE,
  [`dynamodb:DeleteTable ${P}dynamodb-globaltable/create-support.ts rollBackCreatedVectorTable`]:
    FAILED_CREATE,
  [`dynamodb:DeleteTable ${P}dynamodb-table/create.ts rollBackCreatedTable`]: FAILED_CREATE,
  [`ec2:TerminateInstances ${P}ec2/instance-create.ts createInstance`]:
    'the failed-launch cleanup waits (waitForFailedLaunchTerminated) only when a volume attach was issued (#5630; the row note)',
  [`ecs:DeleteService ${P}ecs/service-create-ambiguous.ts settle`]: FAILED_CREATE,
  [`ecs:DeleteService ${P}ecs/service-create.ts createService`]: FAILED_CREATE,
  [`ecs:UpdateService ${P}ecs/service-delete.ts deleteService`]:
    'the scale-down before a delete does not wait; the delete waits for INACTIVE (the row note)',
  [`fsx:DeleteFileSystem ${P}fsx-filesystem/create.ts create`]: FAILED_CREATE,
  [`lambda:UpdateFunctionConfiguration ${P}lambda-function/delete.ts deleteImpl`]:
    'the VPC detach before a delete waits through waitForLambdaUpdateCompleted, a helper the row does not list',
  [`neptune:ModifyDBCluster ${P}neptune/cluster-delete.ts deleteDBCluster`]: FLIP_SITE,
  [`neptune:ModifyDBCluster ${P}neptune/cluster-delete.ts deleteDBClusterOnce`]: FLIP_SITE,
  [`neptune:ModifyDBInstance ${P}neptune/instance.ts deleteDBInstance`]: FLIP_SITE,
  [`neptune:ModifyDBInstance ${P}neptune/instance.ts deleteDBInstanceOnce`]: FLIP_SITE,
  [`rds:DeleteDBCluster ${P}rds/cluster-create.ts createDBCluster`]: FAILED_CREATE,
  [`rds:DeleteDBInstance ${P}rds/cluster-create.ts createDBCluster`]:
    "the failed-create cleanup of the express-configuration writer does not wait (the row note)",
  [`rds:DeleteDBInstance ${P}rds/express-writer.ts deleteExpressWriter`]:
    'an express-configuration writer delete does not wait (the row note)',
  [`rds:ModifyDBCluster ${P}rds/cluster-delete.ts deleteDBCluster`]: FLIP_SITE,
  [`rds:ModifyDBCluster ${P}rds/cluster-delete.ts deleteDBClusterOnce`]: FLIP_SITE,
  [`rds:ModifyDBInstance ${P}rds/instance-delete.ts deleteDBInstance`]: FLIP_SITE,
  [`rds:ModifyDBInstance ${P}rds/instance-delete.ts deleteDBInstanceOnce`]: FLIP_SITE,
};

const isFunctionValue = (e: ts.Expression | undefined): boolean =>
  e !== undefined && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));

/** The name of a named function: a declaration, a method, or a function-valued field or variable. */
const functionName = (n: ts.Node): string | undefined => {
  if ((ts.isMethodDeclaration(n) || ts.isFunctionDeclaration(n)) && n.name && ts.isIdentifier(n.name)) {
    return n.name.text;
  }
  if (
    (ts.isPropertyDeclaration(n) || ts.isVariableDeclaration(n)) &&
    ts.isIdentifier(n.name) &&
    isFunctionValue(n.initializer)
  ) {
    return n.name.text;
  }
  return undefined;
};

/** One named function of a provider unit. */
interface UnitFunction {
  readonly name: string;
  readonly node: ts.Node;
  /** Not nested in another named function: a class member or a module-level function. */
  readonly outer: boolean;
  /** Every callee name in the body, as {@link unitCallsInFile} reads one, plus `new:<X>`. */
  readonly calls: ReadonlySet<string>;
  /** Callees this analysis resolves to a unit function: `f(`, `this.f(`, `f.call(` / `.apply(`. */
  readonly refs: ReadonlySet<string>;
}

function unitFunctions(sf: ts.SourceFile): UnitFunction[] {
  const out: UnitFunction[] = [];
  const bodyCalls = (body: ts.Node): { calls: Set<string>; refs: Set<string> } => {
    const calls = new Set<string>();
    const refs = new Set<string>();
    const visit = (n: ts.Node): void => {
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression)) calls.add(`new:${n.expression.text}`);
      if (ts.isCallExpression(n)) {
        let e = n.expression;
        if (ts.isPropertyAccessExpression(e) && (e.name.text === 'call' || e.name.text === 'apply')) {
          e = e.expression;
        }
        if (ts.isIdentifier(e)) {
          calls.add(e.text);
          refs.add(e.text);
        } else if (ts.isPropertyAccessExpression(e)) {
          calls.add(e.name.text);
          if (e.expression.kind === ts.SyntaxKind.ThisKeyword) refs.add(e.name.text);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return { calls, refs };
  };
  const walk = (n: ts.Node, nested: boolean): void => {
    const name = functionName(n);
    if (name !== undefined) out.push({ name, node: n, outer: !nested, ...bodyCalls(n) });
    ts.forEachChild(n, (c) => walk(c, nested || name !== undefined));
  };
  walk(sf, false);
  return out;
}

export interface SendSiteFindings {
  /** Send sites of a `waits` operation the check read. */
  readonly checked: number;
  /** Sites reaching none of the row's helpers, with no exemption. */
  readonly uncovered: readonly string[];
  /** Exemptions naming no uncovered site, or more than one. */
  readonly staleExemptions: readonly string[];
}

/**
 * Per SEND SITE of a `waits` operation: does the send reach one of the row's
 * helpers? A site is covered when a named function holding it
 *   - is itself one of the helpers (the send is the helper's own), or
 *   - calls a helper, directly or through ONE unit function it calls
 *     (`create` -> `this.settledStatus` -> `waitForRuntimeReady`); or
 * when a unit function calling the outermost one (a `send*` wrapper's caller)
 * is a helper or calls one, directly or through one unit function. Deeper
 * reach was measured to cover failed-create cleanup deletes that do not wait
 * (#7132), so it stops there. A helper named `<X>Command` counts as the
 * function constructing `new <X>(`.
 *
 * BOUND: coverage is per FUNCTION, not per path: a function that waits after
 * one send covers a second send of the same operation in it.
 */
export function checkSendSites(
  population: readonly PopulationRow[],
  classification: Readonly<Record<string, AsyncOperationVerdict>> = ASYNC_OPERATION_CLASSIFICATION,
  exemptions: Readonly<Record<string, string>> = SEND_SITE_EXEMPTIONS
): SendSiteFindings {
  const unitCache = new Map<string, { sfs: Map<string, ts.SourceFile>; fns: UnitFunction[] }>();
  const unitOfRow = (unit: string): { sfs: Map<string, ts.SourceFile>; fns: UnitFunction[] } => {
    let u = unitCache.get(unit);
    if (!u) {
      const sfs = new Map(unitFiles(resolve(repoRoot, unit)).map((f) => [rel(f), parse(f)] as const));
      u = { sfs, fns: [...sfs.values()].flatMap(unitFunctions) };
      unitCache.set(unit, u);
    }
    return u;
  };
  let checked = 0;
  const unexempted: string[] = [];
  const hits = new Map<string, number>();
  for (const row of population) {
    const verdict = classification[row.key];
    if (verdict?.verdict !== 'waits') continue;
    const isHelper = (c: string): boolean =>
      verdict.helpers.some((h) => (h.endsWith('Command') ? c === `new:${h}` : c === h));
    for (const unit of row.units) {
      const { sfs, fns } = unitOfRow(unit);
      const outerByName = new Map<string, UnitFunction[]>();
      for (const f of fns) {
        if (f.outer) outerByName.set(f.name, [...(outerByName.get(f.name) ?? []), f]);
      }
      const reaches = (f: UnitFunction, skip: ReadonlySet<UnitFunction>): boolean =>
        [...f.calls].some(isHelper) ||
        [...f.refs].some((r) =>
          (outerByName.get(r) ?? []).some((g) => !skip.has(g) && [...g.calls].some(isHelper))
        );
      for (const [file, sf] of sfs) {
        if (!row.files.includes(file)) continue;
        for (const site of sendNodes(sf)) {
          if (`${site.client}:${site.operation}` !== row.key) continue;
          checked++;
          const chain = fns.filter((f) => {
            for (let p = site.node.parent; p; p = p.parent) if (p === f.node) return true;
            return false;
          });
          const outer = chain.find((f) => f.outer);
          const skip = new Set(chain);
          const covered =
            chain.some((f) => isHelper(f.name) || reaches(f, skip)) ||
            (outer !== undefined &&
              fns.some(
                (c) => !skip.has(c) && c.refs.has(outer.name) && (isHelper(c.name) || reaches(c, skip))
              ));
          if (covered) continue;
          const label = `${row.key} ${file} ${outer?.name ?? '<module>'}`;
          if (label in exemptions) hits.set(label, (hits.get(label) ?? 0) + 1);
          else {
            const line = sf.getLineAndCharacterOfPosition(site.node.getStart()).line + 1;
            unexempted.push(`${row.key}: ${file}:${line} (${outer?.name ?? '<module>'}) reaches none of ${verdict.helpers.join(', ')}`);
          }
        }
      }
    }
  }
  const staleExemptions = Object.keys(exemptions)
    .filter((k) => hits.get(k) !== 1)
    .map((k) => `${k}: exempts ${hits.get(k) ?? 0} uncovered sites, not 1`)
    .sort();
  return { checked, uncovered: unexempted.sort(), staleExemptions };
}

export interface Findings {
  readonly unclassified: readonly string[];
  readonly stale: readonly string[];
  readonly missingHelper: readonly string[];
  /** Send sites reaching no helper of their `waits` row, and exemptions that name no such site. */
  readonly uncoveredSites: readonly string[];
}

export function checkClassification(
  population: readonly PopulationRow[],
  classification: Readonly<Record<string, AsyncOperationVerdict>> = ASYNC_OPERATION_CLASSIFICATION,
  exemptions: Readonly<Record<string, string>> = SEND_SITE_EXEMPTIONS
): Findings {
  const keys = new Set(population.map((r) => r.key));
  const unclassified = population.filter((r) => !(r.key in classification)).map((r) => r.key);
  const stale = Object.keys(classification)
    .filter((k) => !keys.has(k))
    .sort();
  const missingHelper: string[] = [];
  for (const row of population) {
    const verdict = classification[row.key];
    if (verdict?.verdict !== 'waits') continue;
    const named = new Set<string>();
    for (const unit of row.units) {
      // A helper named `<X>Command` is an INLINE poll: the describe command
      // must be constructed in the same function as the send.
      const hits = verdict.helpers.filter((h) =>
        h.endsWith('Command') ? unitPollsInline(unit, row.operation, h) : unitCalls(unit, h)
      );
      for (const h of hits) named.add(h);
      if (hits.length === 0) {
        missingHelper.push(`${row.key}: ${unit} calls none of ${verdict.helpers.join(', ')}`);
      }
    }
    for (const h of verdict.helpers) {
      if (!named.has(h)) missingHelper.push(`${row.key}: no sending provider calls ${h}`);
    }
  }
  const sites = checkSendSites(population, classification, exemptions);
  return { unclassified, stale, missingHelper, uncoveredSites: [...sites.uncovered, ...sites.staleExemptions] };
}

export function renderJson(
  population: readonly PopulationRow[],
  classification: Readonly<Record<string, AsyncOperationVerdict>> = ASYNC_OPERATION_CLASSIFICATION
): string {
  const rows = population.map((r) => ({ ...r, classification: classification[r.key] ?? null }));
  const counts: Record<string, number> = {};
  for (const r of rows) {
    const v = r.classification?.verdict ?? 'unclassified';
    counts[v] = (counts[v] ?? 0) + 1;
  }
  return `${JSON.stringify({ issue: 7132, total: rows.length, counts, rows }, null, 2)}\n`;
}

export function renderMarkdown(
  population: readonly PopulationRow[],
  classification: Readonly<Record<string, AsyncOperationVerdict>> = ASYNC_OPERATION_CLASSIFICATION
): string {
  const lines = [
    '---',
    'title: "Asynchronous provider operations"',
    'unlisted: true',
    '---',
    '',
    '# Asynchronous provider operations',
    '',
    '<!-- AUTO-GENERATED by scripts/gen-async-operation-waits.ts — DO NOT EDIT BY HAND. -->',
    '<!-- Regenerate: `vp run gen:async-operation-waits`. -->',
    '',
    'Every SDK command a provider sends whose operation the SDK model marks as asynchronous',
    '(issue [#7132](https://github.com/go-to-k/cdkd/issues/7132)), with its hand classification',
    'from `src/provisioning/async-operation-waits.ts`.',
    '',
  ];
  const counts = new Map<string, number>();
  for (const r of population) {
    const v = classification[r.key]?.verdict ?? 'unclassified';
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  lines.push(
    `Total: ${population.length} (${[...counts]
      .sort()
      .map(([k, n]) => `${k} ${n}`)
      .join(', ')}).`,
    '',
    '| Operation | Signal | Verdict | Detail | Providers |',
    '| --- | --- | --- | --- | --- |'
  );
  for (const r of population) {
    const c = classification[r.key];
    const detail =
      c === undefined
        ? ''
        : c.verdict === 'waits'
          ? `${c.helpers.map((h) => `\`${h}\``).join(' / ')}; fails on ${c.failureStatuses.join(', ') || '(none: times out only)'}${
              c.note ? `; ${c.note}` : ''
            }`
          : c.reason;
    lines.push(
      `| ${escapeCell(r.key)} | ${escapeCell(r.evidence.map((e) => e.detail).join('; '))} | ${
        c?.verdict ?? 'unclassified'
      } | ${escapeCell(detail)} | ${escapeCell(r.units.map((u) => basename(u)).join(', '))} |`
    );
  }
  return `${lines.join('\n')}\n`;
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function main(): void {
  const check = process.argv.includes('--check');
  const population = buildPopulation();
  const json = renderJson(population);
  const md = renderMarkdown(population);
  if (!check) {
    mkdirSync(dirname(OUT_JSON), { recursive: true });
    atomicWrite(OUT_JSON, json);
    atomicWrite(OUT_MD, md);
  }
  const findings = checkClassification(population);
  const problems: string[] = [];
  const section = (head: string, items: readonly string[]): void => {
    if (items.length > 0) problems.push(head, ...items.map((i) => `  ${i}`));
  };
  section(
    'Asynchronous operations with no row — classify each in src/provisioning/async-operation-waits.ts:',
    findings.unclassified
  );
  section('Rows for an operation no provider sends (or no rule flags) any more — delete them:', findings.stale);
  section('`waits` rows whose helper a sending provider no longer calls:', findings.missingHelper);
  section(
    'Send sites of a `waits` operation that reach none of its helpers — wait there, or exempt the site in SEND_SITE_EXEMPTIONS with its reason:',
    findings.uncoveredSites
  );
  if (check) {
    const stale =
      !existsSync(OUT_JSON) ||
      readFileSync(OUT_JSON, 'utf8') !== json ||
      !existsSync(OUT_MD) ||
      readFileSync(OUT_MD, 'utf8') !== md;
    if (stale) {
      problems.push(
        'docs/_generated/async-operation-waits.{json,md} are stale — run `vp run gen:async-operation-waits` and commit.'
      );
    }
  }
  if (problems.length > 0) {
    // Write mode WARNS and exits 0, like the generators beside it in
    // `gen:all-matrices`; `--check` is the CI failure.
    process.stderr.write(`async-operation-waits: ${check ? 'FAIL' : 'WARN'}\n${problems.join('\n')}\n`);
    if (check) process.exit(1);
    return;
  }
  process.stderr.write(`async-operation-waits: OK — ${population.length} asynchronous operations classified.\n`);
}

if (Boolean(process.argv[1]) && resolve(process.argv[1]!) === __filename) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`async-operation-waits: failed — ${(err as Error).message}\n`);
    process.exit(1);
  }
}
