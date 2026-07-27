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
 *     for everything inside the try block;
 *   - a `.send(...)` reached with the flag CLEAR is an unwrapped AWS call (a
 *     gap);
 *   - a `this.someMethod(...)` call is followed into that method, inheriting
 *     the current flag — so a provider that wraps at the boundary and
 *     delegates the body to a private helper (the PR #1268 shape) classifies
 *     as covered, and a provider whose `update()` delegates to a helper that
 *     wraps internally (the `s3-tables` shape) does too.
 * Recursion is cycle-guarded and bounded to the class's own methods.
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
 * Reads `src/provisioning/providers/*.ts` via the TypeScript Compiler API.
 * Writes `docs/_generated/update-wrap-coverage.{json,md}`.
 *
 * CLASSIFICATION (per provider class that declares `update`)
 * -----------------------------------------------------------
 *   - no-aws          — `update()` reaches no AWS `send` (a pure no-op / diff-only
 *                       update). Nothing to wrap.
 *   - wrapped         — every reachable `send` is inside a ProvisioningError wrap.
 *   - gap             — at least one reachable `send` escapes unwrapped.
 *   - unguarded-wrap  — wrapped, but a `catch` that can capture a cdkd-typed
 *                       throw has no pass-through re-throw.
 * `--check` hard-fails on `gap` and `unguarded-wrap`.
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
const OUT_JSON = resolve(repoRoot, 'docs/_generated/update-wrap-coverage.json');
const OUT_MD = resolve(repoRoot, 'docs/_generated/update-wrap-coverage.md');

/**
 * cdkd error classes that a wrapping `catch` must re-throw untouched. Anything
 * deriving from `CdkdError` carries its own exit code / formatting, and
 * `ResourceUpdateNotSupportedError` is additionally matched BY CLASS by the
 * deploy engine, so re-labelling it breaks the replacement fallback.
 */
const TYPED_PASSTHROUGH_CLASSES: ReadonlySet<string> = new Set([
  'CdkdError',
  'ProvisioningError',
  'ResourceUpdateNotSupportedError',
]);

export interface AllowListEntry {
  readonly rationale: string;
}

/**
 * Provider classes the critic must not fail on.
 *
 * Two kinds of entry live here:
 *   - NOT-A-BUG: the analysis is over-strict for a legitimate shape.
 *   - KNOWN GAP: a real gap being worked off under a tracking issue.
 *
 * Every entry below is currently a KNOWN GAP tracked in #1270. They are
 * allow-listed rather than fixed in the critic's own PR so the tool lands
 * reviewable and immediately blocks NEW regressions, mirroring how
 * `gen-sdk-attr-coverage.ts` shipped with `AWS::Lambda::EventSourceMapping`
 * allow-listed against #1190 and then had the entry removed by the fix.
 * REMOVING AN ENTRY IS PART OF FIXING IT — the critic then verifies the fix
 * and prevents a re-regression.
 */
export const UPDATE_WRAP_ALLOW_LIST: ReadonlyMap<string, AllowListEntry> = new Map<
  string,
  AllowListEntry
>([
  ['AppSyncProvider', { rationale: 'KNOWN GAP tracked in #1270' }],
  ['EC2Provider', { rationale: 'KNOWN GAP tracked in #1270' }],
  ['ELBv2Provider', { rationale: 'KNOWN GAP tracked in #1270' }],
  ['FirehoseProvider', { rationale: 'KNOWN GAP tracked in #1270' }],
  ['KinesisStreamConsumerProvider', { rationale: 'KNOWN GAP tracked in #1270' }],
  ['LambdaMicrovmImageProvider', { rationale: 'KNOWN GAP tracked in #1270' }],
  ['RDSDBProxyEndpointProvider', { rationale: 'KNOWN GAP tracked in #1270' }],
  ['RDSDBProxyProvider', { rationale: 'KNOWN GAP tracked in #1270' }],
  ['RDSDBProxyTargetGroupProvider', { rationale: 'KNOWN GAP tracked in #1270' }],
  ['Route53Provider', { rationale: 'KNOWN GAP tracked in #1270' }],
  ['S3TablesProvider', { rationale: 'KNOWN GAP tracked in #1270' }],
]);

export type Bucket = 'no-aws' | 'wrapped' | 'gap' | 'unguarded-wrap' | 'allow-listed';

export interface ClassClassification {
  readonly file: string;
  readonly className: string;
  readonly bucket: Bucket;
  /** Method names, reachable from update(), holding an unwrapped `send`. */
  readonly unwrappedSendMethods: readonly string[];
  /** Methods whose wrapping catch can capture a typed throw with no pass-through. */
  readonly unguardedWrapMethods: readonly string[];
  readonly rationale?: string;
}

/** Does this catch clause construct-and-throw a ProvisioningError? */
function catchThrowsProvisioningError(clause: ts.CatchClause): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isThrowStatement(node) &&
      node.expression &&
      ts.isNewExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'ProvisioningError'
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(clause.block);
  return found;
}

/**
 * Does this catch clause re-throw cdkd-typed errors untouched? Matches the
 * `if (error instanceof <TypedClass>) throw error;` shape in any of its
 * spellings (block body, `else if` chain, `||`-joined instanceof tests).
 */
function catchHasTypedPassthrough(clause: ts.CatchClause): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isIfStatement(node)) {
      const mentionsTyped = (n: ts.Node): boolean => {
        if (
          ts.isBinaryExpression(n) &&
          n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword &&
          ts.isIdentifier(n.right) &&
          TYPED_PASSTHROUGH_CLASSES.has(n.right.text)
        ) {
          return true;
        }
        let hit = false;
        ts.forEachChild(n, (c) => {
          if (mentionsTyped(c)) hit = true;
        });
        return hit;
      };
      const rethrows = (n: ts.Node): boolean => {
        if (ts.isThrowStatement(n)) return true;
        let hit = false;
        ts.forEachChild(n, (c) => {
          if (rethrows(c)) hit = true;
        });
        return hit;
      };
      if (mentionsTyped(node.expression) && rethrows(node.thenStatement)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(clause.block);
  return found;
}

/** Is this call an AWS SDK `*.send(...)` invocation? */
function isSendCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'send'
  );
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
function throwsTypedError(
  node: ts.Node,
  methods: ReadonlyMap<string, ts.MethodDeclaration>,
  seen: Set<string> = new Set()
): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (
      ts.isThrowStatement(n) &&
      n.expression &&
      ts.isNewExpression(n.expression) &&
      ts.isIdentifier(n.expression.expression) &&
      n.expression.expression.text === 'ResourceUpdateNotSupportedError'
    ) {
      found = true;
      return;
    }
    const callee = thisMethodCallName(n);
    if (callee !== null && !seen.has(callee)) {
      seen.add(callee);
      const target = methods.get(callee);
      if (target?.body && throwsTypedError(target.body, methods, seen)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

export interface WalkResult {
  readonly unwrappedSendMethods: Set<string>;
  readonly unguardedWrapMethods: Set<string>;
  readonly sawAnySend: boolean;
}

/**
 * Walk one provider class from `update()`, following `this.x()` edges and
 * tracking whether the current position is inside a ProvisioningError wrap.
 *
 * Exported so unit tests can drive it with synthetic classes.
 */
export function analyzeClass(cls: ts.ClassDeclaration): WalkResult | null {
  const methods = new Map<string, ts.MethodDeclaration>();
  for (const member of cls.members) {
    if (ts.isMethodDeclaration(member) && ts.isIdentifier(member.name)) {
      methods.set(member.name.text, member);
    }
  }
  const update = methods.get('update');
  if (!update?.body) return null;

  const unwrappedSendMethods = new Set<string>();
  const unguardedWrapMethods = new Set<string>();
  let sawAnySend = false;
  // A method can be reached both protected and unprotected; key the visited
  // set on both so we do not miss the unprotected reachability.
  const visited = new Set<string>();

  const walkMethod = (name: string, method: ts.MethodDeclaration, protectedHere: boolean): void => {
    const key = `${name}:${protectedHere}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (!method.body) return;

    const walk = (node: ts.Node, isProtected: boolean): void => {
      if (ts.isTryStatement(node)) {
        const clause = node.catchClause;
        const wraps = clause ? catchThrowsProvisioningError(clause) : false;
        if (wraps && clause) {
          // A wrap that can capture a typed throw MUST pass it through.
          if (!catchHasTypedPassthrough(clause) && throwsTypedError(node.tryBlock, methods)) {
            unguardedWrapMethods.add(name);
          }
        }
        walk(node.tryBlock, isProtected || wraps);
        if (clause) walk(clause.block, isProtected);
        if (node.finallyBlock) walk(node.finallyBlock, isProtected);
        return;
      }

      if (isSendCall(node)) {
        sawAnySend = true;
        if (!isProtected) unwrappedSendMethods.add(name);
        // Still descend: arguments can contain further calls.
      }

      const callee = thisMethodCallName(node);
      if (callee !== null) {
        const target = methods.get(callee);
        if (target) walkMethod(callee, target, isProtected);
      }

      ts.forEachChild(node, (child) => walk(child, isProtected));
    };

    walk(method.body, protectedHere);
  };

  walkMethod('update', update, false);
  return { unwrappedSendMethods, unguardedWrapMethods, sawAnySend };
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
        const allow = allowList.get(className);
        const unwrapped = [...result.unwrappedSendMethods].sort((a, b) => a.localeCompare(b));
        const unguarded = [...result.unguardedWrapMethods].sort((a, b) => a.localeCompare(b));

        const offending = unwrapped.length > 0 || unguarded.length > 0;
        let bucket: Bucket;
        // An allow-listed class stays VISIBLE as `allow-listed` rather than
        // being relabelled `wrapped` — the matrix must keep documenting the
        // known gap, it just must not fail CI. A clean allow-listed class
        // classifies normally so a stale entry is easy to spot.
        if (offending && allow) bucket = 'allow-listed';
        else if (unwrapped.length > 0) bucket = 'gap';
        else if (unguarded.length > 0) bucket = 'unguarded-wrap';
        else if (!result.sawAnySend) bucket = 'no-aws';
        else bucket = 'wrapped';

        out.push({
          file: fileName,
          className,
          bucket,
          unwrappedSendMethods: unwrapped,
          unguardedWrapMethods: unguarded,
          ...(allow ? { rationale: allow.rationale } : {}),
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
    },
    classes: sorted,
  };
}

export function findGaps(report: UpdateWrapCoverageReport): readonly ClassClassification[] {
  return report.classes.filter((c) => c.bucket === 'gap' || c.bucket === 'unguarded-wrap');
}

function renderMarkdown(report: UpdateWrapCoverageReport): string {
  const lines: string[] = [];
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
