#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SgCircularDependencyStack } from '../lib/sg-circular-dependency-stack.ts';
import { SgIngressExportStack } from '../lib/sg-ingress-export-stack.ts';
import { SgIngressAmbiguousStack } from '../lib/sg-ingress-ambiguous-stack.ts';

const app = new cdk.App();
new SgCircularDependencyStack(app, 'CdkdSgCircularExample', {
  description:
    'Integration test for circular Security Group references - SG-A allows ingress from SG-B AND SG-B allows ingress from SG-A. CDK emits the cross-references as standalone AWS::EC2::SecurityGroupIngress resources so the SGs can be created before the rules. Stresses cdkd: (1) the DAG builder must NOT see a false cycle (the ingress resources break it); (2) on destroy the ingress rules must be revoked BEFORE the SGs are deleted or AWS rejects the SG delete with DependencyViolation.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

new SgIngressExportStack(app, 'CdkdSgIngressExportExample', {
  description:
    'Export-arm companion for issue #1761 - the smallest stack that reaches an AWS::EC2::SecurityGroupIngress row in a `cdkd export` import plan (bare L1 VPC, no subnets / IGW / routes, plus the same SG-to-SG circular ingress pair). Proves cdkd records the sgr- rule id and that `cdkd export --dry-run` resolves the CloudFormation identifier from it. Also carries the issue #1791 healing arm - verify.sh strips attributes.Id off this stack state to reproduce a pre-#1761 write, then asserts the export path recovers the real sgr- id from AWS.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

new SgIngressAmbiguousStack(app, 'CdkdSgIngressAmbiguousExample', {
  description:
    'Ambiguity arm for issue #1791 - one AWS::EC2::SecurityGroupIngress declaring BOTH CidrIp and CidrIpv6, so AWS mints one sgr- rule per source and cdkd records no rule id at all. The export backfill must find TWO rules matching the composite physical id tuple and REFUSE naming both, instead of adopting either.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
