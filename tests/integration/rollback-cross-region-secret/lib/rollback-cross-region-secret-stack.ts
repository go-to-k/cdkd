import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Cross-region SECRET rollback-replay fixture — issue
 * [#2057](https://github.com/go-to-k/cdkd/issues/2057).
 *
 * THE DEFECT. Since issue #1934 a cross-stack consumer re-resolves a redacted
 * `{{resolve:...}}` value in the PRODUCER's region, then records the
 * PRODUCER's spelling of the expression into its OWN `state.json`. That
 * spelling carries no region. `replayRollback` rebuilds its resolver from the
 * consumer's region alone, so a rollback re-resolved the producer's reference
 * LOCALLY and wrote whatever a same-named secret holds in the consumer's
 * region onto a live resource. Silent, and on the recovery path.
 *
 * WHY THE TWO REGIONS MUST HOLD DIFFERENT VALUES. A SecureString parameter (or
 * a Secrets Manager secret) of the same NAME in two regions is two independent
 * values — that is the entire premise. If the fixture seeded one value, or the
 * same value twice, a correct resolution and a wrong-region one would be
 * indistinguishable and the run would pass vacuously. verify.sh seeds
 * DIFFERENT values out of band and asserts both are really `SecureString`
 * before deploying anything.
 *
 * WHY SSM SecureString RATHER THAN SECRETS MANAGER. cdkd treats an `ssm`
 * reference to a `SecureString` exactly like a `secretsmanager` one — it is
 * redacted into state and re-resolved on replay (issue #1901) — and an SSM
 * parameter has no deletion cooldown, so repeated integ runs cannot collide on
 * the name (a Secrets Manager secret force-deleted at teardown can still
 * refuse a same-name create for a while). It also lands squarely on the arm
 * this fixture is for: an `ssm` dynamic reference takes a parameter NAME and
 * can never be an ARN, so it is ALWAYS region-less — the exact shape that
 * cannot be disambiguated from the expression alone.
 *
 * TOPOLOGY (driven by verify.sh):
 *
 *   PRODUCER `CdkdRbXregionProducer` in us-west-2
 *     - `ProducerProbe`, an ordinary SSM String parameter, so the stack has a
 *       resource of its own.
 *     - `CfnOutput` `SharedSecret`, whose value is the SecureString dynamic
 *       reference. cdkd resolves it in us-west-2 and (PR #1899) persists the
 *       output REDACTED — `state.outputs.SharedSecret` holds the expression.
 *
 *   CONSUMER `CdkdRbXregionConsumer` in us-east-1
 *     - `SecretEcho`, an SSM String parameter whose `Value` is
 *       `Fn::GetStackOutput` of the producer's `SharedSecret` WITH an explicit
 *       `Region: us-west-2`. The cross-region read resolves the secret in
 *       us-west-2, so the live parameter carries the PRODUCER region's value
 *       while the consumer's state record carries the region-less expression
 *       and `outputReads[].sourceRegion == us-west-2`.
 *     - Its `Description` is `MARKER_VALUE` (default `v1`). Changing it is what
 *       makes the v2 deploy an UPDATE of this resource, so the rollback journal
 *       records a revert op whose previous properties carry the expression.
 *       `SSMParameterProvider.update` re-sends `Value` on every `PutParameter`
 *       (Overwrite: true), so the replay's re-resolved value IS written to the
 *       live parameter — which is why a wrong-region resolution is a wrong
 *       WRITE and not merely a wrong log line.
 *     - `FailingQueue`, an SQS queue with an out-of-range
 *       `messageRetentionPeriod` (valid range [60, 1209600]), added only when
 *       `INJECT_FAIL=true` and depending on `SecretEcho` so the echo UPDATE
 *       completes first. AWS rejects `CreateQueue`, the deploy fails, and
 *       `--no-rollback` leaves a journal behind for `cdkd rollback`. Same
 *       injection idiom as `tests/integration/rollback-command`.
 *
 * WHAT THE ROLLBACK MUST DO. Refuse the replay of `SecretEcho` (exit 2,
 * journal preserved) and leave the live parameter holding the PRODUCER's
 * value. Pre-fix it "succeeds" and overwrites that parameter with the
 * CONSUMER region's secret — which is the assertion verify.sh keys on.
 */

export const PRODUCER_STACK_NAME = 'CdkdRbXregionProducer';
export const CONSUMER_STACK_NAME = 'CdkdRbXregionConsumer';
export const PRODUCER_REGION = 'us-west-2';
export const CONSUMER_REGION = 'us-east-1';
export const PRODUCER_OUTPUT_NAME = 'SharedSecret';

/** Seeded out of band by verify.sh in BOTH regions, with DIFFERENT values. */
export const SHARED_SECURE_PARAM_NAME = '/cdkd/rollback-xregion/shared-secret';
export const PRODUCER_PROBE_PARAM_NAME = '/cdkd/rollback-xregion/producer-probe';
export const CONSUMER_ECHO_PARAM_NAME = '/cdkd/rollback-xregion/echo';

/**
 * The consumer's OWN, region-LESS secret reference (issue
 * [#2109](https://github.com/go-to-k/cdkd/issues/2109)).
 *
 * `cdkd scrub` builds its plaintext -> expression needle map by resolving the
 * TEMPLATE, so it can only classify a reference that is a LITERAL
 * `{{resolve:...}}` there. `SecretEcho`'s value is an `Fn::GetStackOutput`
 * intrinsic, which carries no such literal -- and the producer stack, which
 * does carry one, has no cross-stack read on record for the classifier to call
 * foreign. So neither stack on its own puts the LITERAL and the EVIDENCE in the
 * same place, and a scrub arm dropped on either would pass with the fix
 * reverted.
 *
 * This parameter closes that: it lives in the CONSUMER (whose state records
 * `outputReads[].sourceRegion = us-west-2`) and its value is the region-LESS
 * expression, so the pre-pass classifies a real token against real foreign
 * evidence and must REFUSE rather than resolve it locally.
 */
export const CONSUMER_LOCAL_SECRET_PARAM_NAME = '/cdkd/rollback-xregion/local-secret';
/**
 * The echo parameter's value with `WITH_XREGION` off — an ordinary local
 * literal carrying no dynamic reference at all, so the deploy records no
 * cross-stack read and `state.outputReads` stays absent.
 */
export const LOCAL_LITERAL_VALUE = 'local-literal-no-cross-region-read';
/** The dynamic reference itself — region-LESS, which is the whole point. */
export const SHARED_SECRET_EXPRESSION = `{{resolve:ssm:${SHARED_SECURE_PARAM_NAME}}}`;

export class RbXregionProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'rollback-cross-region-secret');

    new ssm.StringParameter(this, 'ProducerProbe', {
      parameterName: PRODUCER_PROBE_PARAM_NAME,
      stringValue: 'producer-probe (rollback cross-region secret fixture)',
      description: 'Created by tests/integration/rollback-cross-region-secret (producer)',
    });

    // The secret-bearing output. cdkd resolves the reference in the PRODUCER's
    // region and persists the OUTPUT redacted, so `state.outputs.SharedSecret`
    // is the expression rather than either region's plaintext.
    new cdk.CfnOutput(this, PRODUCER_OUTPUT_NAME, {
      value: SHARED_SECRET_EXPRESSION,
      description:
        'SecureString dynamic reference, resolved in the producer region and consumed cross-region',
    });
  }
}

export class RbXregionConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'rollback-cross-region-secret');

    const markerValue = process.env.MARKER_VALUE ?? 'v1';

    // L1 so the logical id is exactly `SecretEcho`, and because
    // `Fn::GetStackOutput` has no typed helper in aws-cdk-lib — it is injected
    // with addPropertyOverride, matching the getstackoutput-crossregion and
    // cross-stack-references fixtures.
    const echo = new ssm.CfnParameter(this, 'SecretEcho', {
      type: 'String',
      name: CONSUMER_ECHO_PARAM_NAME,
      value: LOCAL_LITERAL_VALUE,
      // The v1 -> v2 delta. An UPDATE of THIS resource is what puts a revert op
      // carrying the region-less expression into the rollback journal.
      description: `cross-region secret echo (${markerValue})`,
    });

    // Unconditional, unlike the two env-gated resources below: every arm of this
    // fixture wants it present, and it never changes between v1 and v2 so it
    // contributes no rollback op. See CONSUMER_LOCAL_SECRET_PARAM_NAME for why
    // it has to live in the CONSUMER specifically.
    new ssm.CfnParameter(this, 'LocalSecretEcho', {
      type: 'String',
      name: CONSUMER_LOCAL_SECRET_PARAM_NAME,
      value: SHARED_SECRET_EXPRESSION,
      description: 'region-less secret reference resolved by the CONSUMER itself',
    });

    // `WITH_XREGION` decides whether this deploy reads across the region
    // boundary AT ALL, and that gate is what lets verify.sh drive the two
    // materially different arms:
    //
    //  - ARM A: the read is established by a SUCCESSFUL deploy, then a later
    //    deploy fails. The producer region is already on record when the
    //    rollback runs.
    //  - ARM B: the read is INTRODUCED BY THE FAILING DEPLOY ITSELF. This is
    //    the reachable case, and the one a green ARM A coexisted with a
    //    completely inert fix for: a rollback journal exists only after a
    //    failed deploy, and every non-success state save used to persist the
    //    PRE-deploy `outputReads` snapshot, so the read this deploy just made
    //    was never recorded and the refusal had no evidence to fire on.
    if (process.env.WITH_XREGION === 'true') {
      echo.addPropertyOverride('Value', {
        'Fn::GetStackOutput': {
          StackName: PRODUCER_STACK_NAME,
          OutputName: PRODUCER_OUTPUT_NAME,
          Region: PRODUCER_REGION,
        },
      });
    }

    if (process.env.INJECT_FAIL === 'true') {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: `${this.stackName}-failing-queue`,
        messageRetentionPeriod: 9999999,
      });
      failing.node.addDependency(echo);
    }
  }
}
