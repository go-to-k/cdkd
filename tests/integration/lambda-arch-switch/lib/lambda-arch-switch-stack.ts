import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

// cdkd Lambda architecture-switch integ probe.
//
// Phase 1 (base): x86_64.
// Phase 2 (CDKD_TEST_UPDATE=true): arm64, code unchanged.
//
// Architectures rides on UpdateFunctionCode (the Lambda API ties the
// instruction set to a code deployment), so an x86_64 -> arm64 switch with
// byte-identical code was previously silently dropped by cdkd's
// lambda-function-provider.update(): the deploy reported success while AWS
// kept the old architecture (and the next diff saw no change since state
// recorded the new value). CFn applies it in place ("Update requires: No
// interruption"). The fix fires UpdateFunctionCode with Architectures on an
// architecture change even when the code is unchanged; this fixture proves
// the switch actually reaches AWS (config AND runtime `process.arch`).
export class LambdaArchSwitchStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const toArm = process.env.CDKD_TEST_UPDATE === 'true';

    const fn = new lambda.Function(this, 'ArchFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      architecture: toArm ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64,
      code: lambda.Code.fromInline('exports.handler = async () => process.arch;'),
    });

    new cdk.CfnOutput(this, 'FnName', { value: fn.functionName });
  }
}
