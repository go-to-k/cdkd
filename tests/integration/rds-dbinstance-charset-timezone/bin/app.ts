#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RdsDbInstanceCharsetTimezoneStack } from '../lib/rds-dbinstance-charset-timezone-stack.ts';

const app = new cdk.App();
new RdsDbInstanceCharsetTimezoneStack(app, 'CdkdRdsDbInstanceCharsetTimezoneExample', {
  description:
    'cdkd RDS DBInstance CharacterSetName / NcharCharacterSetName / Timezone integ probe (go-to-k/cdkd#5640)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
