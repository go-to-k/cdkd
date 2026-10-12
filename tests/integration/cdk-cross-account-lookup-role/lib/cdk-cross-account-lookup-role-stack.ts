import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * The cross-account `Fn::GetStackOutput` the AWS CDK generates, read by cdkd
 * through the producer account's CDK lookup role (issue #4808).
 *
 * aws-cdk-lib answers a cross-account reference by adding a role to the
 * producer (`<Producer>PublishGetStackOutputRole...`, trusting only the
 * consumer account's CloudFormation execution role, allowed only
 * `cloudformation:DescribeStacks`) and writing the consumer's value as
 * `Fn::GetStackOutput` with that role as `RoleArn`. cdkd does not use the
 * execution role, so it reads the producer's cdkd state through the producer
 * artifact's `lookupRole` instead, or refuses naming both remedies.
 *
 * A real cross-account pair needs two accounts, so the stacks here cover the
 * three single-account arms verify.sh drives (selected by `CDKD_XACC_MODE`):
 *
 * - `success`: the generated SHAPE, hand-written inside one account. The
 *   producer declares the role exactly as aws-cdk-lib does (explicit RoleName,
 *   `Fn::Sub` cfn-exec-role trust, a DescribeStacks-only `AWS::IAM::Policy`),
 *   and the consumer writes `cdk.Fn.getStackOutput(..., Fn::Join over
 *   AWS::Partition)`. cdkd must detect it and read through
 *   `cdk-hnb659fds-lookup-role-<account>-<region>`. A second consumer reads an
 *   output carrying a dynamic reference and must still be refused as a
 *   cross-account secret.
 * - `denied`: the REAL generated reference (a plain cross-stack reference
 *   between two environments), the producer in a fake account. The lookup role
 *   cannot be assumed, so the consumer deploy is refused with both remedies.
 * - `no-lookup`: the same, with a producer whose synthesizer names no lookup
 *   role (`CliCredentialsStackSynthesizer`), refused by the deploy pre-flight
 *   before any lock, asset or resource.
 *
 * covers: AWS::IAM::Role
 * covers: AWS::IAM::Policy
 * covers: AWS::SSM::Parameter
 */

/** The bootstrap qualifier every role name below assumes (the CDK default). */
const QUALIFIER = 'hnb659fds';

export const PRODUCER_STACK = 'CdkdXaccLookupProducer';
export const CONSUMER_STACK = 'CdkdXaccLookupConsumer';
export const SECRET_CONSUMER_STACK = 'CdkdXaccLookupSecretConsumer';
export const DENIED_PRODUCER_STACK = 'CdkdXaccDeniedProducer';
export const DENIED_CONSUMER_STACK = 'CdkdXaccDeniedConsumer';
export const NO_LOOKUP_PRODUCER_STACK = 'CdkdXaccNoLookupProducer';
export const NO_LOOKUP_CONSUMER_STACK = 'CdkdXaccNoLookupConsumer';

/** The generated role's name, as aws-cdk-lib spells it: `<Producer>PublishGetStackOutputRole`. */
export const READER_ROLE_NAME = `${PRODUCER_STACK}PublishGetStackOutputRole`;
export const PRODUCER_OUTPUT = 'ProducerValue';
export const SECRET_OUTPUT = 'SecretValue';

const PARAM_PREFIX = '/cdkd/cdk-cross-account-lookup-role';
export const PRODUCER_PARAM = `${PARAM_PREFIX}/producer`;
export const SEED_PARAM = `${PARAM_PREFIX}/seed`;
export const CONSUMER_PARAM = `${PARAM_PREFIX}/consumer`;
export const SECRET_CONSUMER_PARAM = `${PARAM_PREFIX}/secret-consumer`;
export const DENIED_PRODUCER_PARAM = `${PARAM_PREFIX}/denied-producer`;
export const DENIED_CONSUMER_PARAM = `${PARAM_PREFIX}/denied-consumer`;
export const NO_LOOKUP_PRODUCER_PARAM = `${PARAM_PREFIX}/no-lookup-producer`;
export const NO_LOOKUP_CONSUMER_PARAM = `${PARAM_PREFIX}/no-lookup-consumer`;

export interface ProducerProps extends cdk.StackProps {
  /** A per-run token, so a stale record cannot satisfy the value assertion. */
  readonly runToken: string;
}

/** `success` producer: the generated reader role, written by hand in one account. */
export class LookupProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ProducerProps) {
    super(scope, id, props);
    const account = this.account;
    const region = this.region;

    const value = new ssm.CfnParameter(this, 'ProducerParam', {
      type: 'String',
      name: PRODUCER_PARAM,
      value: `cdk-cross-account-lookup-role ${props.runToken}`,
    });
    // The shape `createGetStackOutputRole` writes: RoleName explicit, every
    // trust principal an `Fn::Sub` of a CloudFormation execution role.
    const role = new iam.CfnRole(this, 'PublishGetStackOutputRole', {
      roleName: READER_ROLE_NAME,
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              AWS: {
                'Fn::Sub': `arn:\${AWS::Partition}:iam::${account}:role/cdk-${QUALIFIER}-cfn-exec-role-${account}-${region}`,
              },
            },
            Action: ['sts:AssumeRole'],
          },
        ],
      },
    });
    new iam.CfnPolicy(this, 'PublishGetStackOutputPolicy', {
      policyName: `${PRODUCER_STACK}PublishGetStackOutputPolicy`,
      roles: [role.ref],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: 'cloudformation:DescribeStacks',
            Resource: cdk.Fn.join('', [
              'arn:',
              cdk.Aws.PARTITION,
              `:cloudformation:${region}:${account}:stack/${PRODUCER_STACK}/*`,
            ]),
          },
        ],
      },
    });

    new cdk.CfnOutput(this, PRODUCER_OUTPUT, { value: value.attrValue });
    // A dynamic reference to a SecureString verify.sh creates (with a
    // non-secret value): cdkd persists the output as its redacted expression,
    // which is what the cross-account secret refusal keys on. A plain `ssm:`
    // reference would be resolved and stored as a literal.
    new cdk.CfnOutput(this, SECRET_OUTPUT, { value: `{{resolve:ssm-secure:${SEED_PARAM}}}` });
  }
}

/** The `RoleArn` aws-cdk-lib writes without `@aws-cdk/core:enablePartitionLiterals`. */
function generatedRoleArn(account: string): string {
  return cdk.Fn.join('', ['arn:', cdk.Aws.PARTITION, `:iam::${account}:role/${READER_ROLE_NAME}`]);
}

export interface ConsumerProps extends cdk.StackProps {
  readonly paramName: string;
  readonly outputName: string;
}

/** `success` consumers: `cdk.Fn.getStackOutput` with the generated `RoleArn`. */
export class LookupConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ConsumerProps) {
    super(scope, id, props);
    new ssm.CfnParameter(this, 'ConsumerParam', {
      type: 'String',
      name: props.paramName,
      value: cdk.Fn.getStackOutput(
        PRODUCER_STACK,
        props.outputName,
        this.region,
        generatedRoleArn(this.account)
      ),
    });
  }
}

export interface RealPairProps {
  readonly producerId: string;
  readonly consumerId: string;
  readonly producerParam: string;
  readonly consumerParam: string;
  readonly producerEnv: cdk.Environment;
  readonly consumerEnv: cdk.Environment;
  readonly producerSynthesizer?: cdk.IStackSynthesizer;
}

/**
 * `denied` / `no-lookup`: the REAL generated reference. A plain cross-stack
 * reference between two environments is what makes aws-cdk-lib generate it.
 */
export function addRealGeneratedPair(app: cdk.App, props: RealPairProps): void {
  const producer = new cdk.Stack(app, props.producerId, {
    env: props.producerEnv,
    ...(props.producerSynthesizer ? { synthesizer: props.producerSynthesizer } : {}),
  });
  const value = new ssm.CfnParameter(producer, 'ProducerParam', {
    type: 'String',
    name: props.producerParam,
    value: 'never-deployed',
  });
  const consumer = new cdk.Stack(app, props.consumerId, { env: props.consumerEnv });
  new ssm.CfnParameter(consumer, 'ConsumerParam', {
    type: 'String',
    name: props.consumerParam,
    value: value.attrValue,
  });
}
