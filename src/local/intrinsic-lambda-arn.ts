/**
 * Shared resolver for CFn intrinsic shapes that show up wherever an API
 * Gateway construct references a Lambda function ARN — both
 * `Integration.Uri` (`route-discovery.ts`) and `AuthorizerUri`
 * (`authorizer-resolver.ts`). CDK 2.x synthesizes the same canonical
 * shapes across both call sites:
 *
 *   1. `{ Ref: <LambdaLogicalId> }` — rare, but accepted.
 *   2. `{ 'Fn::GetAtt': [<LambdaLogicalId>, 'Arn'] }` — common HTTP API
 *      shape.
 *   3. **REST v1 / HTTP API v2 invoke-ARN wrap**: `{ 'Fn::Join': ['',
 *      ['arn:', { Ref: 'AWS::Partition' }, ':apigateway:', { Ref:
 *      'AWS::Region' }, ':lambda:path/2015-03-31/functions/', { 'Fn::GetAtt':
 *      [<LambdaLogicalId>, 'Arn'] }, '/invocations']] }` — the shape both
 *      `apigateway.LambdaIntegration({proxy: true})` and
 *      `apigatewayv2-authorizers.HttpLambdaAuthorizer` synthesize.
 *   4. **`Fn::Sub` invoke-ARN** (issue #286 Gaps 3 / 4): hand-written /
 *      non-canonical CDK constructs may emit `Fn::Sub` instead of
 *      `Fn::Join`, e.g.
 *      `{ Fn::Sub: 'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${MyLambda.Arn}/invocations' }`
 *      (1-arg form, AWS-docs canonical) or
 *      `{ Fn::Sub: ['arn:...:${MyLambdaArn}/invocations', { MyLambdaArn:
 *      {Fn::GetAtt: [<LambdaLogicalId>, 'Arn']} }] }` (2-arg form, what
 *      CDK's `Fn.sub(template, vars)` synthesizes).
 *
 * Originally each call site (`route-discovery.ts` and
 * `authorizer-resolver.ts`) had its own near-identical ad-hoc resolver
 * that recognized cases 1-3; this module is the consolidated resolver
 * adding case 4 (Gaps 3 / 4 of #286). Same extraction pattern as PR #293
 * (`tryResolveImageFnJoin` in `src/local/intrinsic-image.ts`).
 *
 * The resolver is **pure-functional and synchronous** — it has no AWS
 * SDK dependencies, no deploy-state coupling, and returns a discriminated
 * union so each caller can wrap the unsupported case with its own error
 * class (`Error` for route-discovery, `RouteDiscoveryError` for
 * authorizer-resolver).
 */

/**
 * Outcome of attempting to resolve a Lambda ARN intrinsic. Discriminated
 * so the caller can route the resolved case to its existing happy path
 * and the unsupported case to its existing error path with the supplied
 * `detail` appended.
 */
export type LambdaArnResolveOutcome =
  | { kind: 'resolved'; logicalId: string }
  | { kind: 'unsupported'; detail: string };

/**
 * Marker substring that AWS's Lambda-integration invoke ARN always
 * contains. Matches the `:lambda:path/2015-03-31/functions/` segment AWS
 * documents at
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-set-up-lambda-proxy-integrations.html.
 * Used as the load-bearing signal that the surrounding `Fn::Join` /
 * `Fn::Sub` template is actually an invoke-ARN wrapper rather than an
 * unrelated intrinsic that happens to land on the same field.
 */
const INVOKE_ARN_MARKER = ':lambda:path/2015-03-31/functions/';

/**
 * Resolve a Lambda ARN intrinsic to the Lambda's logical ID. Accepts
 * every CDK 2.x-canonical shape (`Ref` / `Fn::GetAtt: [..., 'Arn']` /
 * `Fn::Join` invoke-ARN wrapper / `Fn::Sub` invoke-ARN wrapper).
 *
 * Returns `{kind: 'resolved', logicalId}` on success. Returns
 * `{kind: 'unsupported', detail}` for any other shape, where `detail`
 * names the surface-level problem (the caller's location prefix +
 * `shortJson` rendering is layered on top). Never throws.
 */
export function resolveLambdaArnIntrinsic(value: unknown): LambdaArnResolveOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'unsupported', detail: 'expected an object intrinsic' };
  }

  const obj = value as Record<string, unknown>;

  // Case 1: { Ref: <LambdaLogicalId> }
  if ('Ref' in obj && typeof obj['Ref'] === 'string') {
    return { kind: 'resolved', logicalId: obj['Ref'] };
  }

  // Case 2: { Fn::GetAtt: [<LambdaLogicalId>, 'Arn'] }
  if ('Fn::GetAtt' in obj) {
    const arg = obj['Fn::GetAtt'];
    if (Array.isArray(arg) && arg.length === 2 && typeof arg[0] === 'string' && arg[1] === 'Arn') {
      return { kind: 'resolved', logicalId: arg[0] };
    }
    return { kind: 'unsupported', detail: "Fn::GetAtt must be [<LambdaLogicalId>, 'Arn']" };
  }

  // Case 3: Fn::Join invoke-ARN wrapper.
  if ('Fn::Join' in obj) {
    const join = obj['Fn::Join'];
    if (Array.isArray(join) && join.length === 2 && Array.isArray(join[1])) {
      // First element is the separator; the second is the parts list.
      // `parts.join('')` should look like the invoke-ARN template; we
      // verify by looking for the AWS-documented marker in any string
      // entry, then pluck the GetAtt logical ID out of the parts list.
      const parts = join[1] as unknown[];
      const literalParts = parts.filter((p): p is string => typeof p === 'string').join('');
      if (literalParts.includes(INVOKE_ARN_MARKER)) {
        for (const p of parts) {
          if (p && typeof p === 'object' && !Array.isArray(p)) {
            const inner = p as Record<string, unknown>;
            const arg = inner['Fn::GetAtt'];
            if (
              Array.isArray(arg) &&
              arg.length === 2 &&
              typeof arg[0] === 'string' &&
              arg[1] === 'Arn'
            ) {
              return { kind: 'resolved', logicalId: arg[0] };
            }
          }
        }
        return {
          kind: 'unsupported',
          detail:
            "Fn::Join invoke-ARN wrapper does not contain a { Fn::GetAtt: [<LambdaLogicalId>, 'Arn'] } element",
        };
      }
    }
    return { kind: 'unsupported', detail: 'Fn::Join does not look like an invoke-ARN wrapper' };
  }

  // Case 4: Fn::Sub invoke-ARN wrapper (Gaps 3 / 4 of #286).
  if ('Fn::Sub' in obj) {
    return resolveFnSubInvokeArn(obj['Fn::Sub']);
  }

  return {
    kind: 'unsupported',
    detail:
      "expected { Ref: <LambdaLogicalId> }, { 'Fn::GetAtt': [<LambdaLogicalId>, 'Arn'] }, the REST v1 invoke-ARN Fn::Join wrapper, or the Fn::Sub invoke-ARN wrapper",
  };
}

/**
 * Match the canonical Fn::Sub invoke-ARN shape:
 *
 *   - 1-arg form (AWS-docs canonical):
 *     `{ Fn::Sub: 'arn:aws:apigateway:${AWS::Region}:lambda:path/2015-03-31/functions/${MyLambda.Arn}/invocations' }`
 *     The `${MyLambda.Arn}` placeholder names the Lambda logical id
 *     directly inside the template.
 *
 *   - 2-arg form (what CDK's `Fn.sub(template, vars)` synthesizes):
 *     `{ Fn::Sub: ['arn:...:${MyLambdaArn}/invocations', { MyLambdaArn:
 *     {Fn::GetAtt: [<LambdaLogicalId>, 'Arn']} }] }`
 *     The var map's value is the `Fn::GetAtt: [..., 'Arn']` shape we
 *     can resolve.
 *
 * Both forms require the invoke-ARN marker substring to keep the
 * resolver narrow — a Fn::Sub against an arbitrary template is NOT
 * accepted (matches the pre-PR rejection message intent).
 */
function resolveFnSubInvokeArn(arg: unknown): LambdaArnResolveOutcome {
  let template: string | undefined;
  let varMap: Record<string, unknown> | undefined;

  if (typeof arg === 'string') {
    template = arg;
  } else if (Array.isArray(arg) && arg.length === 2 && typeof arg[0] === 'string') {
    template = arg[0];
    if (arg[1] && typeof arg[1] === 'object' && !Array.isArray(arg[1])) {
      varMap = arg[1] as Record<string, unknown>;
    } else {
      return {
        kind: 'unsupported',
        detail: 'Fn::Sub second argument must be a { varName: intrinsic } map',
      };
    }
  } else {
    return {
      kind: 'unsupported',
      detail:
        'Fn::Sub must be either a template string or [template, { var: intrinsic }] (got non-canonical arg)',
    };
  }

  if (!template.includes(INVOKE_ARN_MARKER)) {
    return {
      kind: 'unsupported',
      detail: 'Fn::Sub template does not look like an invoke-ARN wrapper',
    };
  }

  // Find the ${...} placeholder that names the Lambda function ARN.
  // Two sub-shapes:
  //   (a) `${LogicalId.Arn}` — 1-arg form references the resource directly
  //       via CFn's implicit `Fn::GetAtt`.
  //   (b) `${VarName}` — 2-arg form references a key of varMap; the
  //       value must be `Fn::GetAtt: [<LambdaLogicalId>, 'Arn']`.
  //
  // The invoke-ARN template only has one placeholder in the
  // `:functions/<placeholder>/invocations` slot; AWS's documented form
  // also uses `${AWS::Region}` / `${AWS::Partition}` pseudo-parameter
  // refs in earlier slots, but those are NOT the lambda reference and
  // do not look like `${X.Arn}` or appear in the var map.
  const placeholderRe = /\$\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = placeholderRe.exec(template)) !== null) {
    const key = match[1]!;

    // Pseudo-parameter refs (`AWS::Region` / `AWS::Partition` / etc.) —
    // skip; these aren't the lambda placeholder.
    if (key.startsWith('AWS::')) continue;

    // Sub-shape (a): `${LogicalId.Arn}`.
    const dot = key.indexOf('.');
    if (dot > 0 && dot < key.length - 1) {
      const logicalId = key.slice(0, dot);
      const attr = key.slice(dot + 1);
      if (attr === 'Arn') {
        return { kind: 'resolved', logicalId };
      }
      // `${X.SomeOtherAttr}` doesn't look like a Lambda ARN reference;
      // skip to the next placeholder.
      continue;
    }

    // Sub-shape (b): `${VarName}` against the var map.
    if (varMap && key in varMap) {
      const v = varMap[key];
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const inner = v as Record<string, unknown>;
        const getAtt = inner['Fn::GetAtt'];
        if (
          Array.isArray(getAtt) &&
          getAtt.length === 2 &&
          typeof getAtt[0] === 'string' &&
          getAtt[1] === 'Arn'
        ) {
          return { kind: 'resolved', logicalId: getAtt[0] };
        }
      }
      // Var map entry didn't resolve to a `Fn::GetAtt: [..., 'Arn']`
      // shape; try the next placeholder before giving up.
      continue;
    }
  }

  return {
    kind: 'unsupported',
    detail:
      "Fn::Sub invoke-ARN template did not contain a recognizable ${LogicalId.Arn} placeholder or matching var-map entry with Fn::GetAtt: [..., 'Arn']",
  };
}
