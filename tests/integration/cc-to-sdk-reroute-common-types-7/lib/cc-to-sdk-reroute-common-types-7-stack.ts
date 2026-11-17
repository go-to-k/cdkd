import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';

/**
 * The value each routing phase declares on every resource under test.
 * Consecutive deploys must differ: one the differ calls NO_CHANGE never
 * provisions a resource, so it could not flip. verify.sh runs its `cdkd diff`
 * with `pinned`, because `seed` and `flip` declare the same value.
 */
const VALUE_BY_PHASE: Record<string, 'a' | 'b'> = {
  base: 'a',
  seed: 'b',
  pinned: 'a',
  flip: 'b',
};

/** The authorizer's cache TTL in each value: the mutable property it changes. */
const AUTHORIZER_TTL: Record<'a' | 'b', number> = { a: 300, b: 120 };

/**
 * physicalId-parity arm for issue 6490, batch 7: an
 * `AWS::ApiGateway::Authorizer`, an `AWS::ApiGateway::Stage` and an
 * `AWS::ApiGateway::Method`, each recorded `provisionedBy: 'cc-api'`, return
 * to the SDK provider without churn.
 *
 * covers: AWS::ApiGateway::Authorizer
 * covers: AWS::ApiGateway::Stage
 * covers: AWS::ApiGateway::Method
 *
 * The ids of two of them DIFFER between the layers (measured us-east-1,
 * 2026-11-17): Cloud Control records `<restApiId>|<authorizerId>` and
 * `<restApiId>|<stageName>`, the SDK provider the bare authorizer id and stage
 * name, and each exemption entry's normalizer keeps the bare part on the flip.
 * The Method's `<restApiId>|<resourceId>|<httpMethod>` is the same in both.
 *
 * The authorizer changes its AuthorizerResultTtlInSeconds, the stage and the
 * method their Description / OperationName. No resource under test is
 * referenced by another one, and each logical id is fixed. The REST API and
 * the Deployment stay on the SDK route and never change.
 *
 * The authorizer is a TOKEN authorizer whose URI names a function that does
 * not exist: API Gateway does not resolve it until a request is authorized,
 * and nothing calls the API.
 */
export class CcToSdkRerouteCommonTypes7Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_PHASE ?? 'base';
    const value = VALUE_BY_PHASE[phase] ?? 'a';
    // `removed`: the three resources under test leave the template while the
    // REST API stays, so their deletes run on the flipped records and each can
    // be probed gone with its parent still alive (a deleted API takes its
    // children with it, which would hide a delete sent to the wrong id).
    const removed = phase === 'removed';

    const api = new apigw.CfnRestApi(this, 'RerouteApi', {
      name: 'cdkd-reroute-common-types-7',
      description: 'cdkd sticky-CC reroute batch 7',
    });
    api.overrideLogicalId('RerouteApi');

    const deployment = new apigw.CfnDeployment(this, 'RerouteDeployment', {
      restApiId: api.ref,
      description: 'cdkd sticky-CC reroute batch 7',
    });
    deployment.overrideLogicalId('RerouteDeployment');

    new cdk.CfnOutput(this, 'RestApiId', { value: api.ref });
    new cdk.CfnOutput(this, 'RootResourceId', { value: api.attrRootResourceId });
    if (removed) return;

    const method = new apigw.CfnMethod(this, 'RerouteMethod', {
      restApiId: api.ref,
      resourceId: api.attrRootResourceId,
      httpMethod: 'GET',
      authorizationType: 'NONE',
      operationName: `phase-${value}`,
      integration: {
        type: 'MOCK',
        requestTemplates: { 'application/json': '{"statusCode": 200}' },
      },
      methodResponses: [{ statusCode: '200' }],
    });
    method.overrideLogicalId('RerouteMethod');

    // API Gateway refuses a deployment of an API with no method.
    deployment.addDependency(method);

    const stage = new apigw.CfnStage(this, 'RerouteStage', {
      restApiId: api.ref,
      stageName: 'reroute',
      deploymentId: deployment.ref,
      description: `phase-${value}`,
    });
    stage.overrideLogicalId('RerouteStage');

    const authorizer = new apigw.CfnAuthorizer(this, 'RerouteAuthorizer', {
      restApiId: api.ref,
      name: 'cdkd-reroute-ct7-authorizer',
      type: 'TOKEN',
      identitySource: 'method.request.header.Authorization',
      authorizerUri: `arn:${this.partition}:apigateway:${this.region}:lambda:path/2015-03-31/functions/arn:${this.partition}:lambda:${this.region}:${this.account}:function:cdkd-reroute-ct7-none/invocations`,
      authorizerResultTtlInSeconds: AUTHORIZER_TTL[value],
    });
    authorizer.overrideLogicalId('RerouteAuthorizer');

    new cdk.CfnOutput(this, 'StageRef', { value: stage.ref });
    new cdk.CfnOutput(this, 'AuthorizerRef', { value: authorizer.ref });
  }
}
