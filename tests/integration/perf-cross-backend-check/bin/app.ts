#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { PerfStack } from '../lib/perf-stack.ts';

// verify.sh names every stack per run, so each timed deploy is a first deploy.
const base = process.env.PERF_STACK_BASE;
if (!base) throw new Error('PERF_STACK_BASE must be set (verify.sh sets it per run)');
const count = Number(process.env.PERF_STACK_COUNT ?? '1');

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};
if (count <= 1) {
  new PerfStack(app, base, { env });
} else {
  for (let i = 1; i <= count; i++) new PerfStack(app, `${base}S${i}`, { env });
}
