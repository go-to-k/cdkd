#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { GetattRdsDocdbAttributesStack } from '../lib/getatt-rds-docdb-attributes-stack.ts';

const app = new cdk.App();
new GetattRdsDocdbAttributesStack(app, 'CdkdGetattRdsDocdbAttributesExample', {
  description:
    'cdkd Fn::GetAtt RDS DBInstance / DBCluster and DocumentDB DBCluster read-only attributes integ probe (issue #6242)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
