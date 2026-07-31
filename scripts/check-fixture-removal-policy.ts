/**
 * Classifier for the integ-fixture "stateful L2 needs an explicit
 * removalPolicy" convention (issue #1326).
 *
 * Stateful CDK L2 constructs default to `RemovalPolicy.RETAIN`, which emits
 * `DeletionPolicy: Retain` into the synthesized template. Both CloudFormation
 * and cdkd honor it, so a fixture that omits the policy leaks the resource on
 * EVERY deploy/destroy cycle -- silently, because the destroy still reports
 * success. The originating incident: the `sqs-cloudwatch` fixture's Kinesis
 * `Stream` had no `removalPolicy`, and every benchmark variant synthing that
 * stack in us-west-2 leaked a billed PROVISIONED stream for a month (14
 * streams found by the 2026-07-31 /cleanup sweep; fixed in PR #1327).
 *
 * The lint requires each instantiation of a construct in STATEFUL_CONSTRUCTS
 * to do ONE of:
 *   - pass an explicit `removalPolicy` in its props object (any value --
 *     intentional RETAIN is fine, it just has to be a decision, not a default);
 *   - call `<target>.applyRemovalPolicy(...)` on the assigned variable /
 *     property elsewhere in the same file;
 *   - carry an `allow-default-removal-policy: <reason>` comment on the
 *     statement, for fixtures that intentionally exercise the default.
 *
 * L1 (`Cfn*`) constructs are out of scope: their template default is
 * `Delete`, so omitting the policy does not leak.
 *
 * This module is separate from the test so the classifier can be table-tested
 * against synthetic source shapes rather than only against today's tree.
 */

// `typescript-v6` is an npm alias of typescript@6: TypeScript 7's package no
// longer exports the stable compiler API from its root (see package.json).
import ts from 'typescript-v6';

/** module suffix (after `aws-cdk-lib/`) -> stateful L2 construct class names. */
export const STATEFUL_CONSTRUCTS: Record<string, readonly string[]> = {
  'aws-kinesis': ['Stream'],
  'aws-dynamodb': ['Table', 'TableV2'],
  'aws-s3': ['Bucket'],
  'aws-logs': ['LogGroup'],
  'aws-kms': ['Key'],
  'aws-rds': ['DatabaseInstance', 'DatabaseCluster'],
  'aws-efs': ['FileSystem'],
  'aws-opensearchservice': ['Domain'],
};

export const ALLOW_COMMENT = 'allow-default-removal-policy:';

export interface ConstructHit {
  /** e.g. `aws-kinesis.Stream` */
  construct: string;
  /** 1-based line of the `new` expression */
  line: number;
  compliant: boolean;
  via: 'removalPolicy-prop' | 'applyRemovalPolicy' | 'allow-comment' | null;
}

/** How a hit's constructor reference was written -- used for coverage floors. */
export interface ScanStats {
  hits: ConstructHit[];
  /** count of hits reached via `ns.Ctor` (namespace import) */
  viaNamespace: number;
  /** count of hits reached via bare `Ctor` (named import) */
  viaNamed: number;
  /** count of hits reached via `cdk.aws_x.Ctor` / `aws_x.Ctor` (barrel) */
  viaBarrel: number;
  /**
   * count of hits whose props argument was an identifier resolved to a
   * same-file variable (e.g. `new TableV2(this, 'T', tableProps)`) rather
   * than an inline object literal. The dynamodb-globaltable fixture uses this
   * shape; the first cut of this classifier flagged it as a false positive.
   */
  propsViaVariable: number;
}

const CDK_LIB = 'aws-cdk-lib';

export function scanFixtureSource(fileName: string, source: string): ScanStats {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);

  // Import bindings ------------------------------------------------------
  const nsAliases = new Map<string, string>(); // local ns -> module suffix
  const namedCtors = new Map<string, { module: string; name: string }>();
  const barrelNs = new Set<string>(); // `import * as cdk from 'aws-cdk-lib'`
  const barrelNamed = new Map<string, string>(); // local -> module suffix (aws_s3 etc.)

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const spec = stmt.moduleSpecifier.text;
    const clause = stmt.importClause;
    if (!clause?.namedBindings) continue;

    if (spec === CDK_LIB) {
      if (ts.isNamespaceImport(clause.namedBindings)) {
        barrelNs.add(clause.namedBindings.name.text);
      } else {
        for (const el of clause.namedBindings.elements) {
          const exported = (el.propertyName ?? el.name).text;
          if (exported.startsWith('aws_')) {
            barrelNamed.set(el.name.text, exported.replace(/^aws_/, 'aws-'));
          }
        }
      }
      continue;
    }

    if (!spec.startsWith(`${CDK_LIB}/`)) continue;
    const module = spec.slice(CDK_LIB.length + 1);
    if (!(module in STATEFUL_CONSTRUCTS)) continue;

    if (ts.isNamespaceImport(clause.namedBindings)) {
      nsAliases.set(clause.namedBindings.name.text, module);
    } else {
      for (const el of clause.namedBindings.elements) {
        const exported = (el.propertyName ?? el.name).text;
        if (STATEFUL_CONSTRUCTS[module].includes(exported)) {
          namedCtors.set(el.name.text, { module, name: exported });
        }
      }
    }
  }

  // Constructor-reference resolution ------------------------------------
  type Resolved = { construct: string; shape: 'namespace' | 'named' | 'barrel' };
  const resolveCtor = (expr: ts.Expression): Resolved | null => {
    if (ts.isIdentifier(expr)) {
      const named = namedCtors.get(expr.text);
      return named ? { construct: `${named.module}.${named.name}`, shape: 'named' } : null;
    }
    if (!ts.isPropertyAccessExpression(expr)) return null;
    const ctor = expr.name.text;
    const qualifier = expr.expression;
    if (ts.isIdentifier(qualifier)) {
      const module = nsAliases.get(qualifier.text) ?? barrelNamed.get(qualifier.text);
      if (module && STATEFUL_CONSTRUCTS[module]?.includes(ctor)) {
        const shape = nsAliases.has(qualifier.text) ? 'namespace' : 'barrel';
        return { construct: `${module}.${ctor}`, shape };
      }
      return null;
    }
    // `cdk.aws_s3.Bucket`
    if (
      ts.isPropertyAccessExpression(qualifier) &&
      ts.isIdentifier(qualifier.expression) &&
      barrelNs.has(qualifier.expression.text) &&
      qualifier.name.text.startsWith('aws_')
    ) {
      const module = qualifier.name.text.replace(/^aws_/, 'aws-');
      if (STATEFUL_CONSTRUCTS[module]?.includes(ctor)) {
        return { construct: `${module}.${ctor}`, shape: 'barrel' };
      }
    }
    return null;
  };

  // Compliance helpers ---------------------------------------------------
  const objectHasRemovalPolicy = (obj: ts.ObjectLiteralExpression): boolean =>
    obj.properties.some(
      (p) =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        ts.isIdentifier(p.name) &&
        p.name.text === 'removalPolicy',
    );

  /** Resolve `const tableProps = { ... }` for a props-identifier argument. */
  const resolvePropsVariable = (name: string): ts.ObjectLiteralExpression | null => {
    let found: ts.ObjectLiteralExpression | null = null;
    const walk = (node: ts.Node): void => {
      if (found) return;
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        found = node.initializer;
        return;
      }
      ts.forEachChild(node, walk);
    };
    walk(sf);
    return found;
  };

  const hasRemovalPolicyProp = (node: ts.NewExpression): { ok: boolean; viaVariable: boolean } => {
    const props = node.arguments?.[2];
    if (!props) return { ok: false, viaVariable: false };
    if (ts.isObjectLiteralExpression(props)) {
      return { ok: objectHasRemovalPolicy(props), viaVariable: false };
    }
    if (ts.isIdentifier(props)) {
      const obj = resolvePropsVariable(props.text);
      if (obj) return { ok: objectHasRemovalPolicy(obj), viaVariable: true };
    }
    return { ok: false, viaVariable: false };
  };

  /** LHS text (`fileSystem`, `this.bucket`, ...) the new-expression is assigned to. */
  const assignmentTarget = (node: ts.NewExpression): string | null => {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.text;
    }
    if (
      ts.isBinaryExpression(parent) &&
      parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      parent.right === node
    ) {
      return parent.left.getText(sf);
    }
    return null;
  };

  const callsApplyRemovalPolicy = (target: string): boolean => {
    // Escape regex metacharacters that can appear in a member LHS (`this.x`).
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^\\w.])${escaped}\\.applyRemovalPolicy\\s*\\(`).test(source);
  };

  const hasAllowComment = (node: ts.NewExpression): boolean => {
    // Leading comments attach to the enclosing STATEMENT, not the new-expr.
    let stmt: ts.Node = node;
    while (stmt.parent && !ts.isSourceFile(stmt.parent) && !ts.isBlock(stmt.parent)) {
      stmt = stmt.parent;
    }
    const ranges = ts.getLeadingCommentRanges(source, stmt.getFullStart()) ?? [];
    if (ranges.some((r) => source.slice(r.pos, r.end).includes(ALLOW_COMMENT))) return true;
    // Same-line trailing comment.
    const lineEnd = source.indexOf('\n', node.getStart(sf));
    const lineText = source.slice(node.getStart(sf), lineEnd === -1 ? undefined : lineEnd);
    return lineText.includes(ALLOW_COMMENT);
  };

  // Walk ------------------------------------------------------------------
  const stats: ScanStats = {
    hits: [],
    viaNamespace: 0,
    viaNamed: 0,
    viaBarrel: 0,
    propsViaVariable: 0,
  };
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node)) {
      const resolved = resolveCtor(node.expression);
      if (resolved) {
        if (resolved.shape === 'namespace') stats.viaNamespace++;
        else if (resolved.shape === 'named') stats.viaNamed++;
        else stats.viaBarrel++;

        const propCheck = hasRemovalPolicyProp(node);
        if (propCheck.viaVariable) stats.propsViaVariable++;
        let via: ConstructHit['via'] = null;
        if (propCheck.ok) {
          via = 'removalPolicy-prop';
        } else {
          const target = assignmentTarget(node);
          if (target && callsApplyRemovalPolicy(target)) via = 'applyRemovalPolicy';
          else if (hasAllowComment(node)) via = 'allow-comment';
        }
        stats.hits.push({
          construct: resolved.construct,
          line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
          compliant: via !== null,
          via,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return stats;
}
