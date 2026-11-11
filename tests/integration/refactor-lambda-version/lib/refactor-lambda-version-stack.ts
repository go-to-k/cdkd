import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#6097. Generation "a" (default) and generation "b"
 * (`CDKD_TEST_UPDATE=true`) differ only in the function's code and the mock
 * method's response. CDK derives the logical id of `fn.currentVersion` and of
 * the API's deployment from exactly those, so each gets a NEW logical id whose
 * own properties match the old one's. They are new resources, not renamed
 * ones: `cdkd refactor` must leave them, and `cdkd diff` must not suggest it.
 */
export class RefactorLambdaVersionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const gen = process.env.CDKD_TEST_UPDATE === 'true' ? 'b' : 'a';

    const fn = new lambda.Function(this, 'Fn', {
      functionName: 'cdkd-refactor-lambda-version-fn',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`exports.handler = async () => ({ code: '${gen}' });`),
    });
    new lambda.Alias(this, 'Live', { aliasName: 'live', version: fn.currentVersion });

    const api = new apigw.RestApi(this, 'Api', {
      restApiName: 'cdkd-refactor-lambda-version-api',
      cloudWatchRole: false,
      deployOptions: { stageName: 'live' },
    });
    api.root.addMethod(
      'GET',
      new apigw.MockIntegration({
        requestTemplates: { 'application/json': '{"statusCode": 200}' },
        integrationResponses: [
          { statusCode: '200', responseTemplates: { 'application/json': `{"code": "${gen}"}` } },
        ],
      }),
      { methodResponses: [{ statusCode: '200' }] }
    );
  }
}
