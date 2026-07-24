#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RollbackSqsCooldownStack } from '../lib/rollback-sqs-cooldown-stack.ts';

const app = new cdk.App();

new RollbackSqsCooldownStack(app, 'CdkdRollbackSqsCooldownExample', {
  description:
    'cdkd rollback SQS cooldown integ — reverse-replacement re-create through the ~60s QueueDeletedRecently window (#1206) and the failed-only journal retention cycle after a clean automatic rollback (#1208); env-gated via QUEUE_SUFFIX / INJECT_FAIL',
});
