#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { StageAssetsStage } from '../lib/stage-assets-stage.ts';

const app = new cdk.App();

// The whole point of the fixture: the asset-bearing stack is declared inside
// a `cdk.Stage`, NOT at the app root. `cdk synth` then stages the assets into
// the app's `cdk.out` while the Stage's asset manifest lands in
// `cdk.out/assembly-<Stage>/`, so the manifest's `source.path` is
// `../asset.<hash>` (issue go-to-k/cdkd#3489).
new StageAssetsStage(app, 'CdkdStageAssets', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
