#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Route53ResolverRuleStack } from '../lib/route53resolver-rule-stack.ts';

const app = new cdk.App();
new Route53ResolverRuleStack(app, 'CdkdRoute53ResolverRuleExample', {
  description: 'cdkd Route 53 Resolver rule DomainName change replaces the rule (issue #7070)',
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
