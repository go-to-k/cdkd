#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RefShapeVectorNamespaceAttachmentStack } from '../lib/ref-shape-vector-namespace-attachment-stack.ts';

const app = new cdk.App();
new RefShapeVectorNamespaceAttachmentStack(app, 'CdkdRefShapeVectorNamespaceAttachmentExample', {
  description:
    'cdkd Ref of S3Vectors VectorBucket / AppSync GraphQLApi / S3Tables Namespace / EC2 VPCGatewayAttachment integ probe (issue #6243)',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
