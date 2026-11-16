#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Ec2InstanceVolumeAttachmentDriftStack } from '../lib/ec2-instance-volume-attachment-drift-stack.ts';

const app = new cdk.App();
new Ec2InstanceVolumeAttachmentDriftStack(app, 'CdkdEc2InstanceVolumeAttachmentDrift', {
  description: 'cdkd EC2 Instance + sibling VolumeAttachment drift integ',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
