#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { AlbListenerRuleUpdateStack } from '../lib/alb-listener-rule-update-stack.ts';

const app = new cdk.App();
new AlbListenerRuleUpdateStack(app, 'CdkdAlbListenerRuleUpdateExample', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
