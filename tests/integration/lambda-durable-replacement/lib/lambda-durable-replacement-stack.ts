import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Issue #1625: the `AWS::Lambda::Function` REPLACEMENT path, EXECUTED.
 *
 * `tests/unit/analyzer/replacement-rules-lambda-609-props.test.ts` pins the
 * CLASSIFICATION (`DurableConfig` is a presence TOGGLE, `TenancyConfig` is
 * create-only), and `tests/integration/lambda-config-field-removal` keeps both
 * properties present in BOTH of its phases on purpose — so nothing exercised
 * the deploy engine actually PERFORMING a Lambda replacement.
 *
 * Two phases:
 *   - baseline (no env)               — a function WITH `DurableConfig`
 *   - removal (CDKD_TEST_REMOVAL=true) — the same function WITHOUT it, which
 *     the registry classifies as a replacement
 *
 * The function's name is deliberately LEFT TO cdkd (no `functionName`), which
 * is the shape issue #1625 asked for — and the shape that showed the issue's
 * own premise to be wrong. cdkd generates `{stackName}-{logicalId}`
 * DETERMINISTICALLY (`generateResourceName`), so the replacement's create-first
 * attempt lands on the name the OLD function still holds: an unnamed Lambda
 * collides exactly like a pinned one, and the physical id is the same on both
 * sides of the replacement (so "assert the physical id changed" cannot be the
 * proof — see verify.sh for what is asserted instead).
 */
export class LambdaDurableReplacementStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const removal = process.env.CDKD_TEST_REMOVAL === 'true';

    const fn = new lambda.Function(this, 'DurableFn', {
      // No `functionName` on purpose — see the class docstring.
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({});'),
      // A per-phase description proves the REPLACEMENT applied the new
      // properties, not just that the old function survived: an in-place
      // update would change it too, but a skipped operation would not.
      description: removal ? 'cdkd-integ durable dropped' : 'cdkd-integ durable present',
    });

    if (!removal) {
      const cfnFn = fn.node.defaultChild as lambda.CfnFunction;
      // L1 override rather than an L2 prop: the removal phase drops the block
      // by simply not emitting it, which is the only shape that reaches the
      // presence-toggle replacement rule (a CHANGED value stays in-place).
      cfnFn.addPropertyOverride('DurableConfig', {
        ExecutionTimeout: 3600,
        RetentionPeriodInDays: 14,
      });
    }

    new cdk.CfnOutput(this, 'FunctionName', {
      value: fn.functionName,
      description: 'Generated Lambda function name (stable across the replacement)',
    });
  }
}
