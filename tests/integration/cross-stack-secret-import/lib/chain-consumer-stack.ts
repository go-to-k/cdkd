import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { CHAIN_PARAMETER_NAME, REEXPORT_NAME } from './shared.ts';

/**
 * The stack at the END of the re-export chain (issue
 * [#2146](https://github.com/go-to-k/cdkd/issues/2146)).
 *
 * It imports the CONSUMER's re-export, so the secret reaches it two hops from
 * the stack that declares the `{{resolve:secretsmanager:...}}` expression:
 *
 *   Producer  --(export of a {{resolve:...}} expression)-->
 *   Consumer  --(re-export of what it imported)-->
 *   ChainConsumer
 *
 * WHY IT IS THE DISCRIMINATING SHAPE. `cdkd scrub <this stack>` reads its
 * recorded producer — the CONSUMER — and asks whether THAT template declares
 * the export from a `{{resolve:` expression. It does not: its output IS the
 * import. Pre-#2146 the verdict was therefore `no`, the pre-pass returned early,
 * and with the middle stack's own state still holding a plaintext this stack was
 * reported clean over state that still held that plaintext too — the #2133
 * silent success reached through a re-export instead of a direct import.
 *
 * SSM again, for the reasons the consumer's own parameter gives: cheap, and
 * readable back in the clear so `verify.sh` can assert what cdkd shipped.
 */
export class ChainConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new ssm.StringParameter(this, 'ChainedSecretParam', {
      parameterName: CHAIN_PARAMETER_NAME,
      stringValue: cdk.Fn.importValue(REEXPORT_NAME),
      description:
        'Holds the value imported from the consumer stack, which itself imported ' +
        'it from the producer. Readable in the clear on purpose: it is what proves ' +
        'the whole chain resolved (issue 2146).',
    });
  }
}
