import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Declare the HOST architecture on every function in this fixture (the shape
 * `tests/integration/local-invoke/lib/local-invoke-stack.ts` set, fenced by
 * `tests/unit/scripts/integ-fixture-host-architecture.test.ts`): a function
 * with no `architecture` is `X86_64`, which runs emulated on an arm64 host.
 */
const HOST_ARCHITECTURE =
  process.arch === 'arm64' ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64;

export interface MarkerStackProps extends cdk.StackProps {
  /** Returned by the handler, so a response names the stack it came from. */
  marker: string;
}

/**
 * One inline Lambda whose response carries this stack's marker, fronted by a
 * Function URL so `cdkd local start-api` can serve it too.
 */
export class MarkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MarkerStackProps) {
    super(scope, id, props);

    const handler = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: HOST_ARCHITECTURE,
      handler: 'index.handler',
      code: lambda.Code.fromInline(
        `exports.handler = async () => ({ marker: ${JSON.stringify(props.marker)} });`
      ),
      timeout: cdk.Duration.seconds(10),
    });
    handler.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });
  }
}
