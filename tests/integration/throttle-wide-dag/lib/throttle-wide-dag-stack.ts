import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';

/**
 * A deliberately WIDE stack that stresses the concurrency limiter, the
 * throttle/retry classifier, and the event-driven DAG executor at scale.
 *
 * The point is breadth, not feature coverage: ~100 cheap, fast, quota-friendly
 * resources created in a single deploy burst maximise the chance of hitting an
 * AWS throttle (`TooManyRequestsException` / `Rate exceeded`, surfaced as HTTP
 * 429). cdkd must RETRY a throttle (the `withRetry` 429 path) rather than treat
 * it as fatal. If a throttle is NOT retried, the deploy fails and verify.sh
 * reports it as a real finding.
 *
 * Resource mix (no VPC — every resource is a control-plane-only create):
 *   - ~80 `AWS::SSM::Parameter`  (highest create rate -> most likely to throttle)
 *   - ~10 `AWS::IAM::Role`
 *   - ~10 `AWS::SNS::Topic`
 *
 * DAG shape:
 *   - The bulk of the parameters are INDEPENDENT (one big ready-set the
 *     limiter must shed across `--concurrency` slots) — this is the throttle
 *     pressure.
 *   - A CHAINED subset gives the DAG real DEPTH: `Chain0 -> Chain1 -> ... -> ChainN`,
 *     where each `ChainK` parameter's Value embeds the previous parameter's
 *     name via `Fn::Sub` (an implicit Ref edge), so cdkd must schedule them in
 *     strict order while everything else runs in parallel. A scheduling bug
 *     (dispatching a child before its parent completes) would surface as a
 *     deploy ordering failure here.
 */
export class ThrottleWideDagStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const PARAM_COUNT = 80; // independent + chained SSM parameters
    const CHAIN_DEPTH = 10; // how many of the params form a serial chain
    const ROLE_COUNT = 10; // independent IAM roles
    const TOPIC_COUNT = 10; // independent SNS topics

    // --- Chained SSM parameters: DAG depth ---------------------------------
    // Chain0 has no dependency; ChainK (K>=1) references Chain(K-1) by name via
    // Fn::Sub so cdkd records a Ref edge and must serialize the chain.
    const chain: ssm.CfnParameter[] = [];
    for (let i = 0; i < CHAIN_DEPTH; i++) {
      const value =
        i === 0
          ? 'chain-root'
          : // Embeds the previous parameter's NAME (Ref) -> implicit DAG edge.
            cdk.Fn.sub('child-of-${PrevName}', { PrevName: chain[i - 1].ref });
      const param = new ssm.CfnParameter(this, `ChainParam${i}`, {
        name: `/${this.stackName}/chain/${i}`,
        type: 'String',
        value,
      });
      chain.push(param);
    }

    // --- Independent SSM parameters: throttle pressure ---------------------
    // The remaining parameters have no dependencies -> one large ready-set the
    // event-driven executor sheds across the `--concurrency` budget at once.
    const independentParamCount = PARAM_COUNT - CHAIN_DEPTH;
    for (let i = 0; i < independentParamCount; i++) {
      new ssm.CfnParameter(this, `WideParam${i}`, {
        name: `/${this.stackName}/wide/${i}`,
        type: 'String',
        value: `wide-value-${i}`,
      });
    }

    // --- Independent IAM roles ---------------------------------------------
    // IAM CreateRole is rate-limited too; bursting these alongside the SSM
    // burst broadens the throttle surface across two services.
    for (let i = 0; i < ROLE_COUNT; i++) {
      new iam.CfnRole(this, `WideRole${i}`, {
        roleName: `${this.stackName}-role-${i}`,
        assumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { Service: 'ssm.amazonaws.com' },
              Action: 'sts:AssumeRole',
            },
          ],
        },
      });
    }

    // --- Independent SNS topics --------------------------------------------
    for (let i = 0; i < TOPIC_COUNT; i++) {
      new sns.CfnTopic(this, `WideTopic${i}`, {
        topicName: `${this.stackName}-topic-${i}`,
      });
    }
  }
}
