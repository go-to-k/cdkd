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
const REMEDY = 'a cdkd-authored remedy or refusal sentence built from names';
const NOT_AN_OPERAND: Readonly<Record<string, string>> = {
  // go-to-k/cdkd#7105: thrown refusal messages.
  'get-azs.ts: masks.text(text)': "EC2 DescribeAvailabilityZones' failure text, with the request's region rewritten by its routed pair",
  'account-drain.ts: error.message': 'an AccountIdUnavailableError re-thrown as itself (STS text, no operand)',
  'getatt-heal.ts: error.message': "the account-id lookup's own refusal text (STS, no operand)",
  "cdkCrossAccountRefRefusal({ consumer: displayStackName(consumer), output: displayIdent(outputName), producer: displayStackName(stackName), region: displayIdent(region), producerAccount: shape.accountId, roleName: displayIdent(shape.roleName), consumerAccount: consumerStack.account, reason, noLookupRole: verdict.kind === 'generated', })": 'an app-scan refusal over LITERAL template strings (typeof-string-gated raw args), before any resolution',
  "cdkCrossAccountRefRefusal({ consumer: context.stackName ? logOperand(resolver, context.stackName, context, { render: (text) => displayMaskedIdent(resolver, text, context, STACK_REF_MAX_CODE_POINTS), }) : undefined, output: loggedOutputName, producer: loggedStackName, region: displayIdent(loggedRegion), producerAccount, roleName: displayIdent(ref.shape.roleName), consumerAccount: resolver.consumerAccount, reason, noLookupRole, })": 'its operand fields are the logOperand bindings above; the role name and accounts are literal RoleArn parts',
  'accountIdUnavailableMessage(reason)': "STS's account-id failure, no operand",
  'accountIdUnavailableMessage(`${reason}, and AWS_ACCOUNT_ID is not a 12-digit account id`)': "STS's account-id failure, no operand",
  'boundAltered(targetRegion ?? loggedTarget, displaySafe(stripControlChars(loggedTarget)), 64)': 'the region a region-scoped client set targets, already masked by its caller',
  'getatt-construct-compute.ts: resourceType': 'a resource TYPE',
  'staleRecordRemedy(resolver, vpcIdHealOutcome, context)': REMEDY,
  'displayMasked(resolver, resource.resourceType, context)': 'a resource TYPE',
  'resource.resourceType': 'a resource TYPE',
  'getatt-refusals.ts: defined': REMEDY,
  'endpointTheEngineLacks(resource, attributeName)': REMEDY,
  'getatt-refusals.ts: observed': 'a cdkd-authored sentence from an AWS state name or an error CLASS name',
  'getatt-refusals.ts: remedy': REMEDY,
  'unenrichedRemedy(resolver, resourceType, attributeName, healOutcome, context)': REMEDY,
  'getatt-refusals.ts: why': REMEDY,
  'describeAwsFailure(because).detail': "the dynamic-reference lookup's AWS failure, masked by the token's own pass",
  'param.type': 'the SSM parameter Type AWS returned',
  'log-twin-pass.ts: placeholder': 'an Fn::Sub placeholder the template spelled (`${Name}`), names only',
  'displayMasked(resolver, name)': 'a template PARAMETER name',
  'displayMasked(resolver, paramDef.Type)': 'a template parameter TYPE',
  'displaySafe(resolver.explicitRegion, { asciiOnly: true })': "the resolver's own region (operator --region or a state field)",
  'encodeURIComponent(title)': 'a cdkd-authored issue title',
  'ref-values.ts: key': 'a template object KEY, rendered quoted only when plain',
  'lacksRecordedRefArn(resource)': REMEDY,
  "proseQuoted(cdkdRemedy('cdkd deploy'))": 'a cdkd command',
  "proseQuoted(cdkdRemedy('cdkd import'))": 'a cdkd command',
  "proseQuoted(cdkdRemedy('cdkd state show', '--json'))": 'a cdkd command',
  'refs.ts: via': "the intrinsic's name ('Ref' | 'Fn::GetAtt')",
  'describeAvailableOutputs(resolver, Object.keys(cfnOutputs), context)': "the producer's OUTPUT NAMES",
  'describeAvailableOutputs(resolver, Object.keys(outputs), context)': "the producer's OUTPUT NAMES",
  'stack-output.ts: readRoleArn': 'the lookup role ARN cdkd derives from the account id',
  'stack-state.ts: UNSHOWABLE_VALUE': 'the description constant',
  'describeOperandShape(resolver, resolvedIndex, context)': 'routes its value through logOperand itself',
  'describeOperandShape(resolver, selectArgs, context)': 'routes its value through logOperand itself',
  'subTemplateKind(subArgs)': "the Fn::Sub argument's SHAPE",
  'subTemplateKind(templateString)': "the Fn::Sub argument's SHAPE",
  'logRender(resolver, logicalId, context)': NAME,
  'displayMasked(resolver, logicalId, context)': NAME,
  'logRender(resolver, attributeName, context)': NAME,
  'displayMasked(resolver, attributeName, context)': NAME,
  'displayMasked(resolver, resourceType, context)': NAME,
  'logRender(this, key, context)': NAME,
  'maskInherited(name)': NAME,
  // `resolvePseudoParameter`'s own literal case label, never template text.
  'refs.ts: logicalId': NAME,
  'maskInherited(ssmPath)': "the SSM path of a parameter's Default: template text, not a resolution",
  'displayMasked(resolver, origin, context)': 'a description of where a re-read value came from (names only)',
  'logRender(resolver, String(conditionName), context)': CONDITION,
  'displayMasked(resolver, String(conditionName), context)': CONDITION,
  'displayMasked(resolver, conditionName, context)': CONDITION,
  'displayMasked(resolver, name, maskingContext)': CONDITION,
  'context.conditions[conditionName]': CONDITION,
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
  'this.deps.resolverRegion': "the resolver's own region (operator --region or a state field)",
  'displaySafe(loggedTarget)': 'the region a region-scoped client set targets, display-safe',
  'displayIdent(roleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS })':
    'the RoleArn argument, refused unless it is a literal template string',
  'displayIdent(readRoleArn, { maxCodePoints: ROLE_ARN_MAX_CODE_POINTS, })':
    'the lookup role ARN cdkd derives from the account id',
  'response.Account': "STS's own account id",
  'displayMasked(resolver, String(paramType), context)': 'the SSM parameter Type AWS returned',
  'dynamic-ref-lookups.ts: service': "the typed reference service ('ssm' | 'ssm-secure')",
  // An index over `AWS::StackId` only, gated on `loggedPosition === String(position)`.
  'selectIndexPosition(resolvedIndex)': 'a Select index no mask altered, over AWS::StackId only',
  'base64.ts: SECRET_MASK': 'the mask itself',
  'allStacks.length': COUNT,
  'resolvedList.length': COUNT,
  'getatt-construct-compute.ts: attempts': COUNT,
  'getatt-construct-compute.ts: attempt': COUNT,
  'getatt-construct-core.ts: attempt': COUNT,
  'intrinsic-function-resolver.ts: pending': COUNT,
  '(concurrentDrainCap.ms ?? DRAIN_AFTER_REJECTION_MS) / 1000': COUNT,
  'getatt-refusals.ts: read': 'the AWS API name the calling arm issued, a literal at every call site',
  "displaySafe(err instanceof Error && err.name ? err.name : 'Error', { asciiOnly: true }) .slice(0, 64) .trim() || 'Error'":
    ERROR,
  '(err as { $metadata?: { httpStatusCode?: unknown } } | null)?.$metadata ?.httpStatusCode': ERROR,
  'described.detail': "STS GetCallerIdentity's failure text (no operand reaches the call)",
  'error.name': "a caught error's class name (`account-drain.ts`' account lookup)",
  'account-drain.ts: reason': "the account-id fallback's reason, built from STS failure text",
  'line(message)': "`retry.ts`'s own retry line over the masked request names",
  'staleRecordRemedy(resolver, healOutcome, context)': ERROR,
  'withheldRemedy(resolver, context)': ERROR,
  'displayMasked( resolver, subPlaceholderWarning(resolver, varNameStr, getAttError), context )': ERROR,
  'displayMasked( resolver, subPlaceholderWarning(resolver, varNameStr, refError), context )': ERROR,
  'displayMasked( resolver, `Unsupported dynamic reference service: ${logOperand(resolver, nameLogText(String(service)), context, { render: \'plain\' })}`, context )':
    'the service parsed off a token, its interpolation routed through logOperand',
  'displayMasked( resolver, `Failed to evaluate condition ${name}: ${describeAwsFailure(error).detail}, assuming false`, maskingContext )':
    ERROR,
};

/** Every interpolation of a resolver log call, and how it classified. */
interface Site {
  readonly file: string;
  readonly line: number;
  readonly text: string;
  /** The allow-list key that admitted it. */
  readonly key?: string;
  readonly verdict: 'operand' | 'allowed' | 'unclassified';
}

/** Renders that quote or bound their FIRST argument and print nothing else of a value. */
const QUOTING_WRAPPERS = new Set(['quotedRender', 'asIsMessage', 'displayIdent', 'shellBoundedDisplay']);

/** Helpers taking `[raw, <render>]` pairs that rewrite an error's text. */
const MASK_PAIR_HELPERS = new Set(['maskStateReadError', 'namedRequestMasks', 'positionalNameMask']);

const ROOT = path.join(import.meta.dirname, '../../..');
const LOG_METHODS = new Set(['debug', 'info', 'warn', 'error']);

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `logOperand(...)`, called bare. */
function isOperandCall(node: ts.Node): boolean {
  return (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'logOperand'
  );
}

/**
 * Is `call` a log call? `<x>.logger.<m>(...)`, `logger.<m>(...)`, a logger
 * GETTER (`this.deps.logger().<m>(...)`) and a `getLogger()` chain
 * (`getLogger().child('X').<m>(...)`).
 */
function isLogCall(call: ts.CallExpression, source: ts.SourceFile): boolean {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !LOG_METHODS.has(callee.name.text)) return false;
  // Whitespace stripped: a chain is often formatted across lines.
  const receiver = callee.expression.getText(source).replace(/\s+/g, '');
  return /(^|\.)logger(\(\))?$/.test(receiver) || /(^|\.)getLogger\(\)(\.child\([^)]*\))?$/.test(receiver);
}

/** `new <X>Error(...)`: an error whose message a refusal throws. */
function isErrorConstruction(node: ts.Node): node is ts.NewExpression {
  return (
    ts.isNewExpression(node) && ts.isIdentifier(node.expression) && /Error$/.test(node.expression.text)
  );
}

/** A bare identifier: allow-listed only with its file named (`<basename>: <name>`). */
const isBareIdentifier = (text: string): boolean => /^[A-Za-z_$][\w$]*$/.test(text);

/**
 * The initializer of the `const` an identifier at `use` refers to: the
 * nearest enclosing block, function or file declaring it. `undefined` when
 * the name is a parameter, a `let` / `var`, or declared nowhere in scope.
 */
function constInitializerFor(use: ts.Identifier): ts.Expression | undefined | 'unresolved' {
  for (let node: ts.Node | undefined = use.parent; node !== undefined; node = node.parent) {
    if (ts.isFunctionLike(node)) {
      if (node.parameters.some((p) => ts.isIdentifier(p.name) && p.name.text === use.text)) {
        return 'unresolved';
      }
    }
    const statements = ts.isBlock(node) || ts.isSourceFile(node) ? node.statements : undefined;
    for (const statement of statements ?? []) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== use.text) continue;
        const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
        return isConst && declaration.initializer ? declaration.initializer : 'unresolved';
      }
    }
  }
  return 'unresolved';
}

/** Scan one source text; `file` labels the sites. */
function scanLogOperands(file: string, text: string): Site[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const basename = path.basename(file);

  const sites: Site[] = [];
  const record = (node: ts.Node, verdict: Site['verdict'], key?: string): void => {
    sites.push({
      ...(key !== undefined && { key }),
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
    // A file-qualified entry first, for any text; an unqualified one only for
    // a text that is no bare identifier.
    const qualified = `${basename}: ${text}`;
    if (Object.hasOwn(NOT_AN_OPERAND, qualified)) return record(expr, 'allowed', qualified);
    if (!isBareIdentifier(text) && Object.hasOwn(NOT_AN_OPERAND, text)) {
      return record(expr, 'allowed', text);
    }
    if (
      ts.isNoSubstitutionTemplateLiteral(expr) ||
      ts.isStringLiteral(expr) ||
      ts.isNumericLiteral(expr)
    ) {
      return;
    }
    // A TYPE name or a COUNT prints nothing of the value it describes.
    if (
      ts.isTypeOfExpression(expr) ||
      (ts.isPropertyAccessExpression(expr) && expr.name.text === 'length')
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
    // `<render>.slice(...)` prints a cut of the render: classify the render.
    if (
      ts.isCallExpression(expr) &&
      ts.isPropertyAccessExpression(expr.expression) &&
      expr.expression.name.text === 'slice'
    ) {
      return classify(expr.expression.expression, seen);
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
    // A call to a LOCAL message builder (`const message = (t) => \`...\``)
    // prints its body: classify the body, so a binding inside it is read
    // rather than hidden behind the call (go-to-k/cdkd#7105 review).
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && !seen.has(expr.expression.text)) {
      const init = constInitializerFor(expr.expression);
      if (init !== 'unresolved' && init !== undefined && ts.isArrowFunction(init) && !ts.isBlock(init.body)) {
        return classify(init.body, new Set(seen).add(expr.expression.text));
      }
    }
    if (ts.isIdentifier(expr) && !seen.has(expr.text)) {
      const init = constInitializerFor(expr);
      if (init !== 'unresolved' && init !== undefined) {
        return classify(init, new Set(seen).add(expr.text));
      }
    }
    record(expr, 'unclassified');
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isLogCall(node, source)) {
      for (const argument of node.arguments) classify(argument, new Set());
    }
    // go-to-k/cdkd#7105: a thrown refusal's MESSAGE prints at default
    // verbosity (and lands in the journal's `error.message`): its first
    // argument is held to the same rule as a log line's.
    if (isErrorConstruction(node) && node.arguments?.[0] !== undefined) {
      classify(node.arguments[0], new Set());
    }
    // A request-mask pair `[raw, <render>]` rewrites another module's error
    // text: its render is held to the same rule (go-to-k/cdkd#7105 review).
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      MASK_PAIR_HELPERS.has(node.expression.text)
    ) {
      for (const argument of node.arguments) {
        if (!ts.isArrayLiteralExpression(argument)) continue;
        for (const pair of argument.elements) {
          if (ts.isArrayLiteralExpression(pair) && pair.elements[1] !== undefined) {
            classify(pair.elements[1], new Set());
          }
        }
      }
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

  it('names the file of every allow-listed bare identifier', () => {
    expect(Object.keys(NOT_AN_OPERAND).filter(isBareIdentifier)).toEqual([]);
  });

  it('keeps no allow-list entry that no site uses', () => {
    const used = new Set(SITES.filter((s) => s.verdict === 'allowed').map((s) => s.key));
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
    // A logger getter and a `getLogger()` chain are log calls too.
    expect(verdicts('this.deps.logger().warn(`v ${value}`);')).toEqual(['unclassified']);
    expect(verdicts("getLogger().child('R').debug(`v ${value}`);")).toEqual(['unclassified']);
    // A local message builder is read through, and a mask pair's render is classified.
    expect(
      verdicts('const shown = displayMasked(r, v, c);\nconst msg = (t) => `x ${shown} ${t}`;\nthrow new Error(msg(\'a\'));')
    ).toEqual(['unclassified', 'unclassified']);
    expect(verdicts('namedRequestMasks(r, [[raw, displayMasked(r, raw, c)]], c);')).toEqual(['unclassified']);
    // A thrown refusal's message too (go-to-k/cdkd#7105).
    expect(verdicts('throw markNonRetryable(new Error(`v ${value}`));')).toEqual(['unclassified']);
    expect(verdicts('throw new IntrinsicResolutionRefusalError(`v ${logOperand(r, v, c)}`);')).toEqual([
      'operand',
    ]);
    expect(verdicts("getLogger()\n  .child('R')\n  .debug(`v ${value}`);")).toEqual(['unclassified']);
    // A binding is resolved in ITS scope: another function's `const` of the
    // same name, a parameter, or a reassignable `let` classifies nothing.
    expect(
      verdicts(
        'function a() { const v = logOperand(r, x, c); }\nfunction b(v) { logger.debug(`${v}`); }'
      )
    ).toEqual(['unclassified']);
    expect(
      verdicts('let v = logOperand(r, x, c);\nv = raw;\nlogger.debug(`${v}`);')
    ).toEqual(['unclassified']);
    // The chokepoint, called or bound.
    expect(verdicts('resolver.logger.debug(`v ${logOperand(resolver, v, c)}`);')).toEqual([
      'operand',
    ]);
    expect(
      verdicts('const shown = logOperand(resolver, v, c);\nresolver.logger.debug(`v ${shown}`);')
    ).toEqual(['operand']);
  });
});
