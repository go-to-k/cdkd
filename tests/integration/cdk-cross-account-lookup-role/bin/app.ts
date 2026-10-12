#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  CONSUMER_PARAM,
  CONSUMER_STACK,
  DENIED_CONSUMER_PARAM,
  DENIED_CONSUMER_STACK,
  DENIED_PRODUCER_PARAM,
  DENIED_PRODUCER_STACK,
  LookupConsumerStack,
  LookupProducerStack,
  NO_LOOKUP_CONSUMER_PARAM,
  NO_LOOKUP_CONSUMER_STACK,
  NO_LOOKUP_PRODUCER_PARAM,
  NO_LOOKUP_PRODUCER_STACK,
  PRODUCER_OUTPUT,
  PRODUCER_STACK,
  SECRET_CONSUMER_PARAM,
  SECRET_CONSUMER_STACK,
  SECRET_OUTPUT,
  addRealGeneratedPair,
} from '../lib/cdk-cross-account-lookup-role-stack.ts';

// verify.sh passes the account it runs in; the stacks pin it explicitly, as a
// cross-account app must (aws-cdk-lib compares the two environments).
const account = process.env.CDKD_XACC_ACCOUNT ?? '';
if (!/^\d{12}$/.test(account)) {
  throw new Error('CDKD_XACC_ACCOUNT must be the 12-digit account verify.sh runs in');
}
const region = process.env.CDK_DEFAULT_REGION ?? 'us-east-1';
// An account no deploy here can reach: the producer of the refusal arms.
const FAKE_PRODUCER_ACCOUNT = '111111111111';
if (account === FAKE_PRODUCER_ACCOUNT) {
  throw new Error(`the fixture's fake producer account ${FAKE_PRODUCER_ACCOUNT} is this account`);
}

const app = new cdk.App();
const env = { account, region };

switch (process.env.CDKD_XACC_MODE ?? 'success') {
  case 'success':
    new LookupProducerStack(app, PRODUCER_STACK, {
      env,
      runToken: process.env.CDKD_XACC_RUN_TOKEN ?? 'no-run-token',
    });
    new LookupConsumerStack(app, CONSUMER_STACK, {
      env,
      paramName: CONSUMER_PARAM,
      outputName: PRODUCER_OUTPUT,
    });
    new LookupConsumerStack(app, SECRET_CONSUMER_STACK, {
      env,
      paramName: SECRET_CONSUMER_PARAM,
      outputName: SECRET_OUTPUT,
    });
    break;
  case 'denied':
    addRealGeneratedPair(app, {
      producerId: DENIED_PRODUCER_STACK,
      consumerId: DENIED_CONSUMER_STACK,
      producerParam: DENIED_PRODUCER_PARAM,
      consumerParam: DENIED_CONSUMER_PARAM,
      producerEnv: { account: FAKE_PRODUCER_ACCOUNT, region },
      consumerEnv: env,
    });
    break;
  case 'no-lookup':
    addRealGeneratedPair(app, {
      producerId: NO_LOOKUP_PRODUCER_STACK,
      consumerId: NO_LOOKUP_CONSUMER_STACK,
      producerParam: NO_LOOKUP_PRODUCER_PARAM,
      consumerParam: NO_LOOKUP_CONSUMER_PARAM,
      producerEnv: { account: FAKE_PRODUCER_ACCOUNT, region },
      consumerEnv: env,
      producerSynthesizer: new cdk.CliCredentialsStackSynthesizer(),
    });
    break;
  default:
    throw new Error(`unknown CDKD_XACC_MODE '${process.env.CDKD_XACC_MODE}'`);
}
