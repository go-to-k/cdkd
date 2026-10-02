import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Integ fixture for issue #4383: a `--recreate-via-cc-api` target's same-stack
 * readers are re-provisioned against the id the recreate mints.
 *
 * The target is an HTTP API, whose `ApiId` AWS assigns, so a destroy + create
 * comes back under a NEW physical id (a name-addressed type such as a
 * fixed-name topic keeps its id and could not witness this). Two SSM
 * parameters hold that id, one through `Ref` and one through
 * `Fn::GetAtt ApiId`. The template never changes, so before the fix both
 * readers diffed NO_CHANGE, were never re-provisioned, and kept the deleted
 * API's id in AWS and in state after a green deploy.
 *
 * covers: AWS::ApiGatewayV2::Api
 * covers: AWS::SSM::Parameter
 */
export class RecreateTargetReadersStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const api = new apigwv2.CfnApi(this, 'ReaderTargetApi', {
      name: `${this.stackName}-api`,
      protocolType: 'HTTP',
    });

    new ssm.CfnParameter(this, 'ApiIdByRef', {
      name: `${this.stackName}-api-id-ref`,
      type: 'String',
      value: api.ref,
    });

    new ssm.CfnParameter(this, 'ApiIdByGetAtt', {
      name: `${this.stackName}-api-id-getatt`,
      type: 'String',
      value: api.attrApiId,
    });
  }
}
