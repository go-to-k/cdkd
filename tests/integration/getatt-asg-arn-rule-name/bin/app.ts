#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GetattAsgArnRuleNameStack } from '../lib/getatt-asg-arn-rule-name-stack.ts';

const app = new cdk.App();
new GetattAsgArnRuleNameStack(app, 'CdkdGetattAsgArnRuleNameExample', {
  description: 'cdkd Fn::GetAtt AutoScalingGroup AutoScalingGroupARN and Events Rule RuleName integ probe (issue #6242)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
