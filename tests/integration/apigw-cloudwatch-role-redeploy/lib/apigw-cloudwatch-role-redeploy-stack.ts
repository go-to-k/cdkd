import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

/**
 * A user-reported shape (issue #5064): a `RestApi` with `cloudWatchRole: true`
 * makes an IAM role and an `AWS::ApiGateway::Account` pointing the account's
 * CloudWatch logging at it. CDK keeps that role on delete
 * (`cloudWatchRoleRemovalPolicy` defaults to RETAIN), so `cdkd destroy`
 * leaves it in AWS. A cdkd that generates the same role name on the next
 * deploy collides with it (`EntityAlreadyExists`); a cdkd whose fresh stack
 * gets a new lifetime generates a new name and deploys.
 *
 * covers: AWS::ApiGateway::RestApi, AWS::ApiGateway::Account, AWS::IAM::Role,
 * AWS::ApiGateway::Method, AWS::ApiGateway::Deployment, AWS::ApiGateway::Stage
 *
 * The role's removal policy is LEFT at CDK's default on purpose: the retained
 * role IS the test. verify.sh deletes every retained role by direct IAM calls
 * and puts the account's CloudWatch role setting back as it found it.
 */
export class ApigwCloudWatchRoleRedeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const api = new apigateway.RestApi(this, 'Api', {
      cloudWatchRole: true,
      deployOptions: { stageName: 'live' },
    });
    api.root.addMethod(
      'GET',
      new apigateway.MockIntegration({
        integrationResponses: [{ statusCode: '200' }],
        requestTemplates: { 'application/json': '{"statusCode": 200}' },
      }),
      { methodResponses: [{ statusCode: '200' }] }
    );
  }
}
