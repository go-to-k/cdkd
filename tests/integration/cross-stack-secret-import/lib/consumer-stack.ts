import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { EXPORT_NAME, PARAMETER_NAME, REEXPORT_NAME } from './shared.ts';

/**
 * Consumer fixture for issue #1934.
 *
 * One SSM `String` parameter whose value is `Fn::ImportValue` of the producer's
 * secret-bearing export. SSM is the right sink for this test on two counts: it
 * is cheap, and its value is READABLE back in the clear, so `verify.sh` can
 * assert what cdkd actually shipped to AWS.
 *
 * PRE-FIX the resolver returned the exports-index value VERBATIM, so this
 * parameter's live value was the literal string
 * `{{resolve:secretsmanager:...:SecretString:password::}}` — a predictable
 * credential reference landing in a property, and for a real consumer (an RDS
 * `MasterUserPassword`, a container `Secrets` entry) a broken credential.
 * POST-FIX the imported value is re-resolved in the PRODUCER's region before it
 * is returned, so the parameter holds the plaintext while the consumer's own
 * state keeps the expression.
 */
export class ConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const importedSecret = cdk.Fn.importValue(EXPORT_NAME);

    new ssm.StringParameter(this, 'ImportedSecretParam', {
      parameterName: PARAMETER_NAME,
      stringValue: importedSecret,
      description:
        'Holds the value imported from the producer stack via Fn::ImportValue. ' +
        'Readable in the clear on purpose: it is what proves the consumer stopped ' +
        'shipping the literal dynamic-reference token to AWS (issue 1934).',
    });

    // RE-EXPORT, which makes this stack the MIDDLE of a three-stack chain
    // (issue #2146). Its declared `Value` is the `Fn::ImportValue` itself, so
    // this template carries no literal `{{resolve:` anywhere — and scrub's
    // producer-plaintext gate used to ask exactly this one template for one,
    // conclude the export could not be secret-bearing, and report the stack at
    // the end of the chain CLEAN over its surviving plaintext.
    //
    // cdkd persists this output REDACTED for the same reason the producer's is:
    // resolving the import records `plaintext -> {{resolve:...}}`, so both
    // `state.outputs` and the exports index hold the expression, which is what
    // the chain consumer reads back.
    new cdk.CfnOutput(this, 'ReexportedSecretOutput', {
      value: importedSecret,
      exportName: REEXPORT_NAME,
      description:
        'Re-exports the imported secret so a third stack can import it one hop ' +
        'further away. The middle link of the issue 2146 chain.',
    });
  }
}
