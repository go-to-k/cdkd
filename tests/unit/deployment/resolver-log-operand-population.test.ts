import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vite-plus/test';
import ts from 'typescript-v6';
import { RESOLVER_FAMILY } from '../_resolver-family.js';

/**
 * go-to-k/cdkd#7077: every OPERAND or RESULT a resolver log line prints goes
 * through `logOperand` (`intrinsic-resolver/masking-display.ts`), the one render
 * that masks by provenance a piece the value scan cannot (a 1-3 character
 * secret below `MIN_NEEDLE_LENGTH`).
 *
 * The population is every interpolation in every `logger.debug` / `info` /
 * `warn` / `error` call of the resolver family, read from the AST. Each one is
 * either a `logOperand(...)` call, a `const` bound to one (or to a template
 * whose interpolations pass), or an entry of {@link NOT_AN_OPERAND} with the
 * reason it is no resolved operand. A new site printing a value any other way
 * fails here, and so does an entry nothing uses any more.
 */

/**
 * Interpolations that print no resolved operand, by their source text
 * (whitespace collapsed), each with the reason.
 */
const NAME = 'a template NAME (a logical id, an attribute, a key): not a resolved operand';
const CONDITION = 'a condition name or verdict (a boolean, or a list of booleans)';
const PRODUCER = "a producer stack or region an export index / state listing names, not this resolution's operand";
const COUNT = 'a count, an attempt number or a duration';
const ERROR = 'an error class, remedy or refusal text built from names, masked beside the operands';
const NOT_AN_OPERAND: Readonly<Record<string, string>> = {
  'logRender(resolver, logicalId, context)': NAME,
  'displayMasked(resolver, logicalId, context)': NAME,
  'logRender(resolver, attributeName, context)': NAME,
  'displayMasked(resolver, attributeName, context)': NAME,
  'displayMasked(resolver, resourceType, context)': NAME,
  'logRender(this, key, context)': NAME,
  'maskInherited(name)': NAME,
  // `resolvePseudoParameter`'s own literal case label, never template text.
  logicalId: NAME,
  'maskInherited(ssmPath)': "the SSM path of a parameter's Default: template text, not a resolution",
  'displayMasked(resolver, origin, context)': 'a description of where a re-read value came from (names only)',
  'logRender(resolver, String(conditionName), context)': CONDITION,
  'displayMasked(resolver, String(conditionName), context)': CONDITION,
  'displayMasked(resolver, conditionName, context)': CONDITION,
  'displayMasked(resolver, name, maskingContext)': CONDITION,
  'context.conditions[conditionName]': CONDITION,
  'JSON.stringify(resolved1) === JSON.stringify(resolved2)': CONDITION,
  'results.every((r) => r === true)': CONDITION,
  'results.some((r) => r === true)': CONDITION,
  "results.join(', ')": CONDITION,
  '!resolved': CONDITION,
  'Boolean(resolved)': CONDITION,
  'Boolean(result)': CONDITION,
  'displayMasked(resolver, refStack, context)': PRODUCER,
  'displayMasked(resolver, lookupRegion, context)': PRODUCER,
  'displayMasked(resolver, entry.producerStack, context)': PRODUCER,
  'displayMasked(resolver, entry.producerRegion, context)': PRODUCER,
  'displayMasked(resolver, previewed.producerStack, context)': PRODUCER,
  'displayMasked(resolver, producerOutput.stackName, context)': PRODUCER,
  'cfnExport.exportingStackId': PRODUCER,
  'displayMasked(this, regionText, context)': 'a region the `producerRegions` option names (CLI input)',
  'displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })':
    'the RoleArn argument, refused unless it is a literal template string',
  'displayIdent(readRoleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS, })':
    'the lookup role ARN cdkd derives from the account id',
  'response.Account': "STS's own account id",
  'displayMasked(resolver, String(paramType), context)': 'the SSM parameter Type AWS returned',
  service: "the typed reference service ('ssm' | 'ssm-secure')",
  // An index over `AWS::StackId` only, gated on `loggedPosition === String(position)`.
  'selectIndexPosition(resolvedIndex)': 'a Select index no mask altered, over AWS::StackId only',
  SECRET_MASK: 'the mask itself',
  'allStacks.length': COUNT,
  'resolvedList.length': COUNT,
  attempts: COUNT,
  pending: COUNT,
  '(concurrentDrainCap.ms ?? DRAIN_AFTER_REJECTION_MS) / 1000': COUNT,
  read: 'the AWS API name the calling arm issued, a literal at every call site',
  "displaySafe(err instanceof Error && err.name ? err.name : 'Error', { asciiOnly: true }) .slice(0, 64) .trim() || 'Error'":
    ERROR,
  '(err as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata ?.httpStatusCode': ERROR,
  'described.detail': "STS GetCallerIdentity's failure text (no operand reaches the call)",
  reason: "the account-id fallback's reason, built from STS failure text",
  'message(failure.detail)': "EC2 DescribeAvailabilityZones' failure text, masked by the builder",
  'line(message)': "`retry.ts`'s own retry line over the masked request names",
  'staleRecordRemedy(resolver, healOutcome, context)': ERROR,
  'withheldRemedy(resolver, context)': ERROR,
  'displayMasked( resolver, subPlaceholderWarning(resolver, varNameStr, getAttError), context )': ERROR,
  'displayMasked( resolver, subPlaceholderWarning(resolver, varNameStr, refError), context )': ERROR,
  'displayMasked( resolver, `Unsupported dynamic reference service: ${displayMasked(resolver, nameLogText(String(service)), context)}`, context )':
    ERROR,
  'displayMasked( resolver, `Failed to evaluate condition ${name}: ${describeAwsFailure(error).detail}, assuming false`, maskingContext )':
    ERROR,
};

/** Every interpolation of a resolver log call, and how it classified. */
interface Site {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  readonly verdict: 'operand' | 'allowed' | 'unclassified';
}

/** Renders that quote or bound their FIRST argument and print nothing else of a value. */
const QUOTING_WRAPPERS = new Set(['quotedRender', 'asIsMessage']);

const ROOT = path.join(import.meta.dirname, '../../..');
const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error']);

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `logOperand(...)`, called bare. */
function isOperandCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'logOperand'
  );
}

/** Is `call` a log call: `<x>.logger.<m>(...)`, `logger.<m>(...)`? */
function isLogCall(call: ts.CallExpression, source: ts.SourceFile): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !LOG_METHODS.has(callee.name.text)) return false;
  return /(^|\.)logger$/.test(callee.expression.getText(source));
}

/** Scan one source text; `file` labels the sites. */
function scanLogOperands(file: string, text: string): Site[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  // Every `const <name> = <init>` in the file, by name.
  const bindings = new Map<string, ts.Expression[]>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const list = bindings.get(node.name.text) ?? [];
      list.push(node.initializer);
      bindings.set(node.name.text, list);
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const sites: Site[] = [];
  const record = (node: ts.Node, verdict: Site['verdict']): void => {
    sites.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      text: normalize(node.getText(source)),
      verdict,
    });
  };

  /** Classify one printed expression; `seen` stops a binding cycle. */
  const classify = (expr: ts.Expression, seen: Set<string>): void => {
    if (ts.isParenthesizedExpression(expr)) return classify(expr.expression, seen);
    if (isOperandCall(expr)) return record(expr, 'operand');
    const text = normalize(expr.getText(source));
    if (Object.hasOwn(NOT_AN_OPERAND, text)) return record(expr, 'allowed');
    if (
      ts.isNoSubstitutionTemplateLiteral(expr) ||
      ts.isStringLiteral(expr) ||
      ts.isNumericLiteral(expr)
    ) {
      return;
    }
    // A ternary prints one of its branches, never its condition.
    if (ts.isConditionalExpression(expr)) {
      classify(expr.whenTrue, seen);
      classify(expr.whenFalse, seen);
      return;
    }
    // A wrapper that bounds or quotes its first argument prints that argument.
    if (
      ts.isCallExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      QUOTING_WRAPPERS.has(expr.expression.text) &&
      expr.arguments[0] !== undefined
    ) {
      return classify(expr.arguments[0], seen);
    }
    if (ts.isTemplateExpression(expr)) {
      for (const span of expr.templateSpans) classify(span.expression, seen);
      return;
    }
    if (ts.isTaggedTemplateExpression(expr)) return classify(expr.template, seen);
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      classify(expr.left, seen);
      classify(expr.right, seen);
      return;
    }
    if (ts.isIdentifier(expr) && !seen.has(expr.text)) {
      const inits = bindings.get(expr.text);
      if (inits !== undefined) {
        const next = new Set(seen).add(expr.text);
        for (const init of inits) classify(init, next);
        return;
      }
    }
    record(expr, 'unclassified');
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isLogCall(node, source)) {
      for (const argument of node.arguments) classify(argument, new Set());
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return sites;
}

const SITES = RESOLVER_FAMILY.flatMap((file) =>
  scanLogOperands(file, readFileSync(path.join(ROOT, file), 'utf8'))
);

describe('every resolver log operand goes through logOperand (#7077)', () => {
  it('classifies every interpolation of every resolver log call', () => {
    const unclassified = SITES.filter((site) => site.verdict === 'unclassified').map(
      (site) => `${site.file}:${site.line}: ${site.text}`
    );
    expect(unclassified).toEqual([]);
  });

  it('keeps no allow-list entry that no site uses', () => {
    const used = new Set(SITES.filter((s) => s.verdict === 'allowed').map((s) => s.text));
    expect(Object.keys(NOT_AN_OPERAND).filter((key) => !used.has(key))).toEqual([]);
  });

  it('reads a population that cannot quietly empty', () => {
    // Literal floors, measured 2026-11-27: a scan that stopped reading a file
    // or a call shape would drop below them instead of passing on nothing.
    expect(SITES.filter((s) => s.verdict === 'operand').length).toBeGreaterThanOrEqual(80);
    expect(new Set(SITES.map((s) => s.file)).size).toBeGreaterThanOrEqual(20);
  });

  it('refuses a value printed any other way (the scanner itself)', () => {
    const verdicts = (body: string) =>
      scanLogOperands('probe.ts', body).map((site) => site.verdict);
    // A bare value, a log render of one, a binding of one, a `+` chain.
    expect(verdicts('resolver.logger.debug(`v ${value}`);')).toEqual(['unclassified']);
    expect(
      verdicts('resolver.logger.debug(`v ${logRender(resolver, value, context)}`);')
    ).toEqual(['unclassified']);
    expect(
      verdicts(
        'const shown = displayMasked(resolver, value, context);\nthis.logger.info(safeMsg`v ${shown}`);'
      )
    ).toEqual(['unclassified']);
    expect(verdicts("logger.warn('a ' + `${String(value)}`);")).toEqual(['unclassified']);
    // The chokepoint, called or bound.
    expect(verdicts('resolver.logger.debug(`v ${logOperand(resolver, v, c)}`);')).toEqual([
      'operand',
    ]);
    expect(
      verdicts('const shown = logOperand(resolver, v, c);\nresolver.logger.debug(`v ${shown}`);')
    ).toEqual(['operand']);
  });
});
