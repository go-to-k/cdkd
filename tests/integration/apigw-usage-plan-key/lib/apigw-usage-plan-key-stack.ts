import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigw from 'aws-cdk-lib/aws-apigateway';

/**
 * API Gateway "rate-limit my API" pattern: RestApi + UsagePlan + ApiKey +
 * UsagePlanKey. `AWS::ApiGateway::UsagePlanKey` has a compound CC
 * primaryIdentifier (`<UsagePlanId>|<KeyId>`) and `AWS::ApiGateway::ApiKey`'s
 * `Ref` returns only the key id — so this exercises cdkd's compound-id
 * `resolveRefValue` handling end-to-end (the `ApiGateway::Model` /
 * `::RequestValidator` Ref bug class). Confirmed CLEAN by a /hunt-bugs sweep;
 * this fixture is the regression guard.
 */
export class ApigwUsagePlanKeyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const api = new apigw.RestApi(this, 'Api', { restApiName: `${this.stackName}-api` });
    api.root.addMethod(
      'GET',
      new apigw.MockIntegration({
        integrationResponses: [{ statusCode: '200' }],
        requestTemplates: { 'application/json': '{"statusCode":200}' },
      }),
      { methodResponses: [{ statusCode: '200' }] }
    );

    const key = api.addApiKey('Key', { apiKeyName: `${this.stackName}-key` });
    const plan = api.addUsagePlan('Plan', {
      name: `${this.stackName}-plan`,
      throttle: { rateLimit: 50, burstLimit: 5 },
    });
    plan.addApiKey(key);
    plan.addApiStage({ stage: api.deploymentStage });

    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
  }
}
