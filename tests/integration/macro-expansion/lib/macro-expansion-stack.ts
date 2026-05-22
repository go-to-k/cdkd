import * as cdk from 'aws-cdk-lib';
import * as sam from 'aws-cdk-lib/aws-sam';
import { Construct } from 'constructs';

/**
 * Issue #463 macro-expansion fixture stack.
 *
 * Declares `Transform: ['AWS::Serverless-2016-10-31']` (the SAM macro)
 * via `Stack.addTransform()` and a single `AWS::Serverless::Function`
 * resource (CDK's `aws-cdk-lib/aws-sam.CfnFunction` L1) with inline
 * Node.js handler code. CDK synthesizes this verbatim — neither cdk
 * nor cdkd expands the SAM macro client-side; CFn does that
 * server-side. cdkd detects the Transform at synthesis time and
 * routes the template through `src/synthesis/macro-expander.ts`
 * (transient `CreateChangeSet` → `GetTemplate Processed` →
 * `DeleteChangeSet` + `DeleteStack`) BEFORE the analyzer /
 * provisioner pipeline runs.
 *
 * Post-expansion the SAM macro emits an `AWS::Lambda::Function` + a
 * matching `AWS::IAM::Role` (with the `AWSLambdaBasicExecutionRole`
 * managed policy attachment), both of which cdkd's existing native
 * SDK providers handle. The integ asserts the resulting AWS-side
 * Lambda exists, can be invoked, and returns `statusCode: 200`.
 *
 * The fixture is intentionally minimal: a single function with no
 * VPC, no env vars, no event sources. Real SAM templates can carry
 * Api / Table / Layer / etc.; the minimal shape is enough to prove
 * the round-trip end-to-end without bloating the integ test budget.
 */
export class MacroExpansionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Declare the SAM transform on the stack. CDK propagates this to
    // the synthesized template's top-level `Transform: ['...']`. cdkd's
    // `containsMacro` detects this and triggers the round-trip.
    this.addTransform('AWS::Serverless-2016-10-31');

    // Auto-generated function name — cdkd's SDK provider for
    // AWS::Lambda::Function handles `FunctionName: undefined` correctly
    // (auto-generates a deterministic StackName-LogicalId-hash name).
    new sam.CfnFunction(this, 'HelloFunction', {
      runtime: 'nodejs20.x',
      handler: 'index.handler',
      inlineCode:
        'exports.handler = async () => ({ statusCode: 200, body: JSON.stringify({ msg: "hello from cdkd macro-expansion integ" }) });',
      timeout: 10,
      memorySize: 128,
    });

    // Output the function's logical id so verify.sh can resolve the
    // physical AWS function name via `cdkd state show`.
    new cdk.CfnOutput(this, 'FunctionLogicalId', {
      description: 'Logical ID of the AWS::Lambda::Function created by macro expansion (sam.CfnFunction emits this as the same logical ID)',
      value: 'HelloFunction',
    });
  }
}
