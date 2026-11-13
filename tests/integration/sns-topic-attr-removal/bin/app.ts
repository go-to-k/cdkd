#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { SnsTopicAttrRemovalStack } from '../lib/sns-topic-attr-removal-stack.ts';

const app = new cdk.App();

new SnsTopicAttrRemovalStack(app, 'SnsTopicAttrRemovalStack', {
  description: 'cdkd SNS topic attribute removal (issue #6226)',
});
