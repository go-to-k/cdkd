#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { MacroExpansionStack } from '../lib/macro-expansion-stack.ts';

const app = new cdk.App();

new MacroExpansionStack(app, 'CdkdMacroExpansionExample', {
  description:
    'End-to-end real-AWS test fixture for cdkd CloudFormation macro / Fn::Transform support (Issue #463). Declares Transform: AWS::Serverless-2016-10-31 + a single AWS::Serverless::Function that cdkd expands via a transient CFn changeset before deploying.',
  env: {
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
  },
});
