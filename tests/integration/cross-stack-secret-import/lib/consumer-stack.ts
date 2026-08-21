import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import {
  CONDITIONAL_EXPORT_NAME,
  EXPORT_NAME,
  PARAMETER_NAME,
  REEXPORT_NAME,
} from './shared.ts';

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
      // The DESCRIPTION carries the issue #2150 read, deliberately, so that arm
      // adds NO resource record to this stack: every existing assertion here
      // counts RESOURCE records (step 8 asserts exactly one is scrubbed), and a
      // second SSM parameter would have moved those counts for a reason
      // unrelated to what it tests.
      //
      // It is still a real cross-stack read -- the pre-pass walks the whole
      // Properties bag, so `Description` reaches `resolveImportValue` exactly as
      // `Value` does, records the producer, and puts the conditional export
      // through `producerPublishesSecretExpression`. Pre-#2150 that verdicted
      // `declared` off the UNTAKEN arm and refused the whole scrub with
      // `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT`, so step 8 -- which has nothing
      // to do with conditionals -- was the step that could no longer run.
      description: cdk.Fn.join('', [
        'Imported from the producer via Fn::ImportValue (issue 1934). Conditional ' +
          'export (issue 2150) resolved to: ',
        cdk.Fn.importValue(CONDITIONAL_EXPORT_NAME),
      ]),
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
