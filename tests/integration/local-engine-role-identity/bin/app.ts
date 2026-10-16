#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  LocalEngineRoleIdentityAppStack,
  LocalEngineRoleIdentityRoleStack,
} from '../lib/local-engine-role-identity-stack.ts';

const app = new cdk.App();

// `-c part=role` / `-c part=app` synthesizes one half only; no `part` gives both.
// verify.sh passes it because cdk-local's Lambda Function URL origin boot cannot
// resolve its function in a multi-stack app ("missing a stack prefix").
const part = app.node.tryGetContext('part');

// Deployed by verify.sh (the only stack that is).
if (part !== 'app') {
  new LocalEngineRoleIdentityRoleStack(app, 'CdkdLocalEngineRoleIdentityRole', {
    description:
      'Deployed half of the local-engine-role-identity integ: a no-permission role plus one SSM parameter',
  });
}

// Never deployed: only synthesized, for the four engine commands to read.
if (part !== 'role') {
  new LocalEngineRoleIdentityAppStack(app, 'CdkdLocalEngineRoleIdentityApp', {
    // A concrete env makes the ECS secret's ValueFrom a literal ARN: the
    // emulator drops an intrinsic-valued one without --from-state.
    env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
    description:
      'Synth-only half of the local-engine-role-identity integ: one workload per engine command',
  });
}
