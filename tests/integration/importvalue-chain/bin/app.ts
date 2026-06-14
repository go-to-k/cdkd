#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StackA } from '../lib/stack-a.ts';
import { StackB } from '../lib/stack-b.ts';
import { StackC } from '../lib/stack-c.ts';

const app = new cdk.App();

const region = process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION ?? 'us-east-1';

const a = new StackA(app, 'CdkdImportChainA', {
  description: 'Chain head: exports ChainTopicArn (SNS topic ARN).',
  env: { region },
});

const b = new StackB(app, 'CdkdImportChainB', {
  description: 'Chain middle: imports ChainTopicArn, re-exports ChainDerivedValue.',
  env: { region },
});

const c = new StackC(app, 'CdkdImportChainC', {
  description: 'Chain tail: imports ChainDerivedValue from Stack B.',
  env: { region },
});

// `cdk.Fn.importValue` is a string-token shortcut that does NOT auto-propagate
// a CDK stack dependency (no JS Resource reference flows between the stacks —
// the import is a synth-time intrinsic). Without an explicit dependency, the
// CDK stack manifest reports no edge and cdkd's `deploy --all` DAG would
// parallelize the three stacks, racing each consumer's Fn::ImportValue resolve
// against producer state that has not been written yet. addDependency() forces
// the manifest to record A -> B -> C ordering so `deploy --all` is correct.
//
// The verify.sh error-path step ALSO deploys C alone against a fresh bucket
// (no A/B state) to assert cdkd surfaces a clear "export not found" error
// rather than silently resolving to a dangling token.
b.addDependency(a);
c.addDependency(b);
