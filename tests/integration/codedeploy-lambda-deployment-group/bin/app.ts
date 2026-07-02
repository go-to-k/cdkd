#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CodedeployLambdaDeploymentGroupStack } from '../lib/codedeploy-lambda-deployment-group-stack.ts';

const app = new cdk.App();
new CodedeployLambdaDeploymentGroupStack(app, 'CdkdCodedeployLambdaDeploymentGroupExample', {
  description: 'cdkd CodeDeploy Lambda canary deployment group deploy + UPDATE + destroy integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
