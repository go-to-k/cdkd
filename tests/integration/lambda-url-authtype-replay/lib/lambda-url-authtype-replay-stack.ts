import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * Issue #1654 — real-AWS coverage for the `AWS::Lambda::Url` `AuthType`
 * warn-and-SUBSTITUTE arms and the `effectiveProperties` they answer with.
 *
 * Why this cannot be a unit test: the whole failure mode is about what a real
 * deploy WRITES INTO STATE for a call that was substituted or omitted, what the
 * NEXT read-side run then sees, and — the part that actually matters — what
 * AUTH the live function URL is left with. A mocked Lambda client agrees with
 * whatever wire assumption the test author had.
 *
 * Why a dedicated fixture rather than extending `cloudfront-function-url`:
 * that fixture also creates an `AWS::Lambda::Url`, but with `AuthType: NONE`,
 * and its subject is the `Lambda::Permission` `InvokedViaFunctionUrl` backfill.
 * Bolting an auth-type sequence onto it would blur what it tests, and a
 * regression here is a PUBLIC ENDPOINT — it deserves its own assertions.
 *
 * Environment knobs (all read at synth time, mirroring the `rollback-command`
 * fixture's `MARKER_VALUE` / `REPLACE_SUFFIX` / `INJECT_FAIL` shape):
 *
 *   AUTHTYPE_JUNK=true  Render `AuthType` as a malformed value so the update
 *                       path's guard fires. See the note on the override below
 *                       for why it is an ARRAY and not a string.
 *   URL_TARGET=b        Point the URL at the SECOND function. `TargetFunctionArn`
 *                       is create-only on `AWS::Lambda::Url`, so this forces a
 *                       REPLACEMENT — the setup for the reverse-replacement
 *                       rollback that exercises the create-path replay warning.
 *   INJECT_FAIL=true    Add a resource AWS rejects, depending on everything
 *                       else, so the deploy fails AFTER the replacement landed
 *                       and leaves a rollback journal.
 */
export class LambdaUrlAuthTypeReplayStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'lambda-url-authtype-replay');

    // Inline code on purpose: this fixture has nothing to say about asset
    // publishing, and an inline function keeps the deploy to seconds.
    const makeFn = (constructId: string): lambda.Function =>
      new lambda.Function(this, constructId, {
        runtime: lambda.Runtime.NODEJS_20_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline(
          'export const handler = async () => ({ statusCode: 200, body: "ok" });'
        ),
        timeout: cdk.Duration.seconds(10),
      });

    const fnA = makeFn('UrlFnA');
    const fnB = makeFn('UrlFnB');

    const target = process.env.URL_TARGET === 'b' ? fnB : fnA;

    // L1 rather than `fn.addFunctionUrl(...)`: the L2 takes a typed
    // `FunctionUrlAuthType` enum, and the point of the junk phase is to put a
    // value on the wire that the enum cannot express.
    const url = new lambda.CfnUrl(this, 'FnUrl', {
      targetFunctionArn: target.functionArn,
      authType: 'AWS_IAM',
    });

    if (process.env.AUTHTYPE_JUNK === 'true') {
      // An ARRAY, deliberately, and chosen over the more obvious spellings:
      //
      //   - a `Fn::Join` over a pseudo-parameter (what the DynamoDB
      //     GlobalTable fixture uses for its malformed blocks) resolves to a
      //     NON-EMPTY STRING, which `requireConfigString` ACCEPTS — it guards
      //     the SHAPE, not the enum membership — so the guard would never fire
      //     and the deploy would fail at AWS instead;
      //   - `''` and `{}` are the canonical malformed shapes but both are at
      //     risk of being pruned during synth, which would silently turn this
      //     phase into a no-op that still passes its "deploy succeeded" check.
      //
      // A non-empty array survives synth untouched, carries no intrinsic key
      // for cdkd's resolver to fold, and is exactly the "mis-nested template
      // value" shape `malformedShapeDetail` names.
      //
      // `addPropertyOverride` rather than a prop: it writes into the raw
      // overrides, which are applied AFTER the generated L1 validator, so a
      // value the validator would reject still reaches the template.
      url.addPropertyOverride('AuthType', ['AWS_IAM']);
    }

    if (process.env.INJECT_FAIL === 'true') {
      // Copied from the `rollback-command` fixture: AWS rejects a
      // `MessageRetentionPeriod` of 9999999, and the DependsOn guarantees the
      // URL work completes first so the journal records a real replacement.
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: `${this.stackName}-failing-queue`,
        messageRetentionPeriod: 9999999,
      });
      failing.node.addDependency(url);
    }

    new cdk.CfnOutput(this, 'UrlFnAName', { value: fnA.functionName });
    new cdk.CfnOutput(this, 'UrlFnBName', { value: fnB.functionName });
    new cdk.CfnOutput(this, 'FnUrlValue', { value: url.attrFunctionUrl });
  }
}
