import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * State schema v10 -> v11 migration fixture (issues #4043 / #2449).
 *
 * v11 persists a `NoEcho: true` template parameter's value as `***`
 * (`ResourceState.noEchoLeaves` names the coordinates) and a custom resource's
 * declared `NoEcho` attributes by name (`ResourceState.noEchoAttributeNames`).
 * A v10 binary (the npm pin in verify.sh) writes every one of these in the
 * clear; the first v11 deploy must rewrite them WITHOUT updating or replacing
 * anything, using the stored plaintext as the migration witness.
 *
 * Every input is an ENVIRONMENT variable verify.sh sets per phase, read here
 * at synth time, so the v10 and the v11 binary synthesize the same template
 * from the same env:
 *
 *   CDKD_V11_TOKEN          TokenParam's Default (a distinctive per-run value)
 *   CDKD_V11_SHORT          ShortParam's Default (3 characters: no needle can
 *                           key it, only the positional arm masks it)
 *   CDKD_V11_TOPIC_NAME     TopicParam's Default (the SNS topic's create-only
 *                           TopicName)
 *   CDKD_V11_CR_SEED        the NoEcho custom resource's Seed property
 *   CDKD_V11_ADD_DEPENDENT  `1` adds a dependent reading the custom resource's
 *                           declared-NoEcho attribute (#2449's refusal)
 *   CDKD_V11_PARAM_CR       `1` adds ParamCr, a custom resource reading
 *                           TokenParam (review round 9): removing it must SKIP
 *                           the delete (its record holds `***`), so its
 *                           handler never writes the delete marker
 *
 * The SSM parameters and the topic are L1 constructs so the property bags are
 * exactly what verify.sh asserts on, by coordinate.
 */
export class SchemaV10ToV11MigrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const required = (name: string): string => {
      const value = process.env[name];
      if (value === undefined || value === '') {
        throw new Error(`${name} must be set (verify.sh sets it for every phase)`);
      }
      return value;
    };

    const token = new cdk.CfnParameter(this, 'TokenParam', {
      type: 'String',
      noEcho: true,
      default: required('CDKD_V11_TOKEN'),
    });
    const short = new cdk.CfnParameter(this, 'ShortParam', {
      type: 'String',
      noEcho: true,
      default: required('CDKD_V11_SHORT'),
    });
    const topicName = new cdk.CfnParameter(this, 'TopicParam', {
      type: 'String',
      noEcho: true,
      default: required('CDKD_V11_TOPIC_NAME'),
    });
    // The negative control: an ordinary parameter stays in the clear.
    const plain = new cdk.CfnParameter(this, 'PlainParam', {
      type: 'String',
      default: 'schema-v11-plain-control',
    });

    const prefix = '/cdkd-integ/schema-v10-to-v11';

    // Updatable, readable: the readback settles it on every v11 deploy.
    new ssm.CfnParameter(this, 'TokenProbe', {
      name: `${prefix}/token`,
      type: 'String',
      value: token.valueAsString,
    });
    // A 3-character value: masked by POSITION only.
    new ssm.CfnParameter(this, 'ShortProbe', {
      name: `${prefix}/short`,
      type: 'String',
      value: short.valueAsString,
    });
    new ssm.CfnParameter(this, 'PlainProbe', {
      name: `${prefix}/plain`,
      type: 'String',
      value: plain.valueAsString,
    });

    // Create-only: v11 never replaces it on a readback's word (maintainer
    // decision 1 on #4043), and the migration deploy must not replace it.
    new sns.CfnTopic(this, 'NamedTopic', { topicName: topicName.valueAsString });

    new cdk.CfnOutput(this, 'TokenOut', { value: token.valueAsString });

    // A custom resource answering `NoEcho: true` (issue #2274; its declared
    // attribute names are persisted from v11, issue #2449). The simple-handler
    // response shape, as in custom-resource-getatt-data.
    const handler = new lambda.Function(this, 'NoEchoCrHandler', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  if (event.RequestType === 'Delete') {
    // ParamCr only: a Delete that reaches the handler writes this marker,
    // which verify.sh asserts is NEVER written (cdkd skips that delete).
    const marker = (event.ResourceProperties || {}).MarkerName;
    if (marker) {
      const { SSMClient, PutParameterCommand } = require('@aws-sdk/client-ssm');
      await new SSMClient({}).send(
        new PutParameterCommand({ Name: marker, Value: 'delete-reached-handler', Type: 'String', Overwrite: true })
      );
    }
    return { Status: 'SUCCESS', PhysicalResourceId: event.PhysicalResourceId || 'cr-v11' };
  }
  const seed = (event.ResourceProperties || {}).Seed || 'noseed';
  return {
    PhysicalResourceId: 'cr-v11-' + seed,
    // An inert literal, distinctive per seed so verify.sh can grep for it.
    Data: { Secret: 'cdkdv11crsecret' + seed },
    NoEcho: true,
  };
};
`),
    });
    const markerName = `${prefix}/param-cr-delete-marker`;
    handler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ssm:PutParameter'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: markerName.slice(1),
          }),
        ],
      })
    );
    const cr = new cdk.CustomResource(this, 'NoEchoCr', {
      serviceToken: handler.functionArn,
      properties: { Seed: required('CDKD_V11_CR_SEED') },
    });

    if (process.env.CDKD_V11_ADD_DEPENDENT === '1') {
      // Added in a LATER deploy while the custom resource is unchanged: its
      // record holds `***` for `Secret`, which it declared NoEcho, so cdkd
      // refuses this create with the exact declared-attribute remedy.
      new ssm.CfnParameter(this, 'CrDependent', {
        name: `${prefix}/cr-dependent`,
        type: 'String',
        value: cr.getAttString('Secret'),
      });
    }

    if (process.env.CDKD_V11_PARAM_CR === '1') {
      // A custom resource reading the NoEcho parameter: its record holds `***`
      // at `Token`, named in `noEchoLeaves`, so its Delete is skipped rather
      // than sent the mask (maintainer decision, #4043 round 8).
      new cdk.CustomResource(this, 'ParamCr', {
        serviceToken: handler.functionArn,
        properties: { Token: token.valueAsString, MarkerName: markerName },
      });
    }
  }
}
