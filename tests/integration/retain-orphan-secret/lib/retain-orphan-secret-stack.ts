import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Does the rollback-orphan record (issue #2934) leak a secret into `state.json`?
 *
 * The record carries a whole `ResourceState` — `properties` and `attributes` —
 * on a NEW TOP-LEVEL field of the state document. Two facts make that the shape
 * of a disclosure rather than a bookkeeping detail:
 *
 *   - `redactStateForPersist` walks `resources` and `outputs`; everything else
 *     rides its `...state` spread UNTOUCHED, so a new top-level field is
 *     redacted only if someone wrote an arm for it;
 *   - the AUTOMATIC rollback captures the record from the IN-MEMORY map, which
 *     holds REAL resolved values by design.
 *
 * That is GHSA-p5qg-v9gv-hc7w's shape, one field over.
 *
 * ## The secret is created by the SCRIPT, never by this template
 *
 * The first version of this fixture seeded the canary with
 * `SecretValue.unsafePlainText(...)` inside a `secretsmanager.Secret`, and it
 * reported a leak that was not the feature's: `unsafePlainText` puts the
 * literal in the TEMPLATE, cdkd persists resolved template values, and the
 * plaintext therefore landed in that secret's OWN record — independently of
 * anything #2934 does. Redaction covers `{{resolve:...}}` dynamic references,
 * not a literal the author hard-coded, which is why the API is named "unsafe".
 *
 * So `verify.sh` creates the secret out of band and passes its NAME in. The
 * template then carries only the `{{resolve:secretsmanager:...}}` expression,
 * cdkd resolves it to real plaintext to call AWS, and the question the fixture
 * asks — does that plaintext come back out in the persisted record — is about
 * this feature alone.
 *
 * ## Why `AWS::SSM::Parameter`
 *
 * Four properties have to hold at once: its `Value` accepts a dynamic
 * reference, so plaintext genuinely reaches `properties`; `RemovalPolicy.RETAIN`
 * is honoured, so the rollback ORPHANS it and mints a record; its provider
 * implements `import()`, so the redeploy's ADOPTION path runs too; and it costs
 * nothing.
 *
 * Two modes, driven by `CDKD_TEST_SECRET_ORPHAN`:
 *
 *   - `fail`  — the parameter plus a queue whose `MessageRetentionPeriod` is
 *     out of range. `addDependency` makes the parameter exist BEFORE the queue
 *     fails; without it the DAG may fail the queue first, nothing is orphaned,
 *     and the run passes having measured nothing.
 *   - `fixed` — the same parameter, queue repaired. The redeploy that adopts.
 */
export class RetainOrphanSecretStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mode = process.env['CDKD_TEST_SECRET_ORPHAN'] ?? 'fixed';
    // Supplied by verify.sh, which created the secret. Absent during a bare
    // `cdk synth` outside the harness, where a placeholder keeps synthesis
    // working without inventing a reference to a secret that exists.
    const secretName = process.env['CDKD_TEST_SECRET_NAME'] ?? 'cdkd-placeholder-secret';

    const parameter = new ssm.StringParameter(this, 'OrphanedParameter', {
      // The raw dynamic-reference form, deliberately: it is the exact string
      // the template must carry and the persisted record must carry BACK.
      stringValue: `{{resolve:secretsmanager:${secretName}:SecretString}}`,
      description: 'Retain resource whose orphan record must not carry the plaintext',
    });
    parameter.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);

    const queue = new sqs.CfnQueue(this, 'Gate', {
      messageRetentionPeriod: mode === 'fail' ? 1 : 60,
    });
    // Ordering, not decoration: the parameter must EXIST before the queue
    // fails, or the rollback has nothing to orphan.
    queue.node.addDependency(parameter);

    new cdk.CfnOutput(this, 'ParameterName', { value: parameter.parameterName });
  }
}
