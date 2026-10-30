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
 * The function carries an EXPLICIT, per-run `functionName`
 * (`CDKD_TEST_FN_NAME`, set by verify.sh), so the replacement's create-first
 * attempt lands on the name the OLD function still holds, and the physical id
 * is the same on both sides of the replacement (so "assert the physical id
 * changed" cannot be the proof — see verify.sh for what is asserted instead).
 *
 * Issue #1625 asked for an UNNAMED function, and until go-to-k/cdkd#5064 phase
 * 2 that collided the same way, since cdkd generated the same name again. On a
 * stack with a stack instance id it no longer does: a replacement of an
 * un-named resource creates at the NEXT name generation, under a new name, so
 * nothing collides and neither the refusal nor `--replace`'s delete-first
 * would be reached. A declared name keeps today's same-name collision, which
 * is what this fixture exercises.
 */
export class LambdaDurableReplacementStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const removal = process.env.CDKD_TEST_REMOVAL === 'true';
    // Issue #3808's phase only: an explicit name ANOTHER function (created out
    // of band by verify.sh) already holds. `FunctionName` is create-only, so
    // this is a replacement whose create-first attempt collides with a
    // resource that is NOT the one being replaced.
    const heldName = process.env.CDKD_TEST_HELD_NAME;
    // The managed function's own declared name, per run (see the class
    // docstring). Required: without it the function is un-named and the
    // replacement under test never collides.
    const declaredName = process.env.CDKD_TEST_FN_NAME;
    if (declaredName === undefined || declaredName === '') {
      throw new Error('CDKD_TEST_FN_NAME must name the function (verify.sh sets it per run)');
    }

    const fn = new lambda.Function(this, 'DurableFn', {
      functionName: heldName !== undefined && heldName !== '' ? heldName : declaredName,
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
      description: 'Declared Lambda function name (stable across the replacement)',
    });
  }
}
