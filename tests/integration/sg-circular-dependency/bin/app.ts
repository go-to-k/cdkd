#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SgCircularDependencyStack } from '../lib/sg-circular-dependency-stack.ts';

const app = new cdk.App();
new SgCircularDependencyStack(app, 'CdkdSgCircularExample', {
  description:
    'Integration test for circular Security Group references — SG-A allows ingress from SG-B AND SG-B allows ingress from SG-A. CDK emits the cross-references as standalone AWS::EC2::SecurityGroupIngress resources so the SGs can be created before the rules. Stresses cdkd: (1) the DAG builder must NOT see a false cycle (the ingress resources break it); (2) on destroy the ingress rules must be revoked BEFORE the SGs are deleted or AWS rejects the SG delete with DependencyViolation.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
