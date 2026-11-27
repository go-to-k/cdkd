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
 *   - `transitional-enum`: the command's output shape, at the top level or one
 *     structure below it (a member typed as a structure, or an array of one),
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
 * `CreateClusterSnapshot` calls, Cloud Control) is not in the population.
 *
 * BOUND: the walk is one structure deep, so a status two levels down is
 * missed, and an operation whose output carries no status at all (a
 * `Modify*` answering `{}` while the change applies) is invisible to all three
 * rules. A waiter-only signal (the service ships `waitUntil*` for the
 * resource) is not used: it names a DESCRIBE operation, not the write.
 * Measured on the #7132 review, a two-level walk adds about 20 operations
 * (ELBv2 `CreateLoadBalancer`'s `LoadBalancers[].State.Code`, RDS
 * `RegisterDBProxyTargets`, EMR `PutAutoScalingPolicy`, EC2 `RunInstances` /
 * `StopInstances`, ...), left for #7132.
 *
 * BOUND: the helper check is a REFERENCE check: it holds that the provider
 * unit still names a helper, not that the helper runs after THIS operation. A
 * generic name another operation of the same unit also calls
 * (`waitForSettled`) keeps passing if this operation's wait is deleted.
 *
 * CLASSIFICATION
 * --------------
 * By hand, in `src/provisioning/async-operation-waits.ts`, one row per
 * `<client>:<Operation>` (`appsync:StartSchemaCreation`): `waits` (the helper
 * helpers each sending provider unit references, and the terminal failure
 * statuses it fails on), `no-wait-by-design` (the reason and its evidence) or
 * `unmeasured` (needs a CloudFormation A/B; #7132 tracks it).
 *
 * `--check` (CI) FAILS on a population row with no classification, on a
 * classification naming an operation no provider sends any more (or one the
 * rules no longer flag), on a `waits` row whose helper a sending provider unit
 * no longer references, and on stale generated files. A provider UNIT is the
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
  const sf = parse(file);
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
  const sites: SendSite[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const hit = imported.get(node.expression.text);
      if (hit) {
        sites.push({
          client: hit.client,
          operation: hit.name.slice(0, -'Command'.length),
          file: rel(file),
          unit: rel(unitOf(file)),
        });
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
  for (const [member, type] of outputMembers(client, operation, model)) {
    inspect('', member, type);
    const nested = structureName(type);
    const shape = nested ? model.interfaces.get(nested) : undefined;
    for (const [inner, innerType] of shape ?? []) inspect(`${member}.`, inner, innerType);
  }
  return evidence;
}

/** Every send site under the providers directory. */
export function collectAllSendSites(): SendSite[] {
  return walkTs(PROVIDERS_DIR).flatMap(collectSendSites);
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

/** Whether any file of the unit names `identifier` as an identifier token. */
export function unitReferences(unit: string, identifier: string): boolean {
  return unitFiles(resolve(repoRoot, unit)).some((file) => {
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(node) && node.text === identifier) found = true;
      else ts.forEachChild(node, visit);
    };
    visit(parse(file));
    return found;
  });
}

export interface Findings {
  readonly unclassified: readonly string[];
  readonly stale: readonly string[];
  readonly missingHelper: readonly string[];
}

export function checkClassification(
  population: readonly PopulationRow[],
  classification: Readonly<Record<string, AsyncOperationVerdict>> = ASYNC_OPERATION_CLASSIFICATION
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
      const hits = verdict.helpers.filter((h) => unitReferences(unit, h));
      for (const h of hits) named.add(h);
      if (hits.length === 0) {
        missingHelper.push(`${row.key}: ${unit} references none of ${verdict.helpers.join(', ')}`);
      }
    }
    for (const h of verdict.helpers) {
      if (!named.has(h)) missingHelper.push(`${row.key}: no sending provider references ${h}`);
    }
  }
  return { unclassified, stale, missingHelper };
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
  section('`waits` rows whose helper a sending provider no longer references:', findings.missingHelper);
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
