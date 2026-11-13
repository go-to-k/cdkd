#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NoechoRestapiBodyMacStack } from '../lib/noecho-restapi-body-mac-stack.ts';

const app = new cdk.App();
new NoechoRestapiBodyMacStack(app, 'CdkdNoechoRestapiBodyMac', {
  description: 'cdkd NoEcho value MACs on a RestApi Body integ (go-to-k/cdkd#6146)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
