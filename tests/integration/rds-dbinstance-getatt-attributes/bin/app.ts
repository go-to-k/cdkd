#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RdsDbinstanceGetattAttributesStack } from '../lib/rds-dbinstance-getatt-attributes-stack.ts';

const app = new cdk.App();
new RdsDbinstanceGetattAttributesStack(app, 'CdkdRdsDbinstanceGetattAttributesExample', {
  description:
    'cdkd Fn::GetAtt RDS DBInstance DbiResourceId / Endpoint.HostedZoneId / CertificateDetails integ probe (issue #6242)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
