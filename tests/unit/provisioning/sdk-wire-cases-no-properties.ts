import { REGION, setOutputOverrides, type TypeCase } from './sdk-wire-harness.js';
import { WaitConditionHandleProvider } from '../../../src/provisioning/providers/wait-condition-handle-provider.js';
import { WaitConditionProvider } from '../../../src/provisioning/providers/wait-condition-provider.js';
import type { WaitConditionSignalStore } from '../../../src/provisioning/wait-condition-signal-store.js';
import { AgentCoreBrowserProvider } from '../../../src/provisioning/providers/agentcore-browser-provider.js';
import { AgentCoreCodeInterpreterProvider } from '../../../src/provisioning/providers/agentcore-code-interpreter-provider.js';

/**
 * Wire cases for SDK provider classes that handle NO property (#3723): every
 * schema property of their type is read-only, so there is no bag to probe.
 * Each pins the calls `create({})` and `update({}, {})` make instead
 * (`TypeCase.noProperties`). Run by `sdk-wire-coverage-no-properties.test.ts`;
 * the ledger in `sdk-wire-coverage.test.ts` counts them as covered.
 */

const BROWSER_ARN = `arn:aws:bedrock-agentcore:${REGION}:aws:browser/aws.browser.v1`;
const CODE_INTERPRETER_ARN = `arn:aws:bedrock-agentcore:${REGION}:aws:code-interpreter/aws.codeinterpreter.v1`;

const NOTHING_TO_PROBE = { bags: [], exempt: {}, targets: [] };

const SIGNAL_KEY = 'wait-condition-signals/L-0f8fad5b-d9cb-469f-a165-70867728950e.json';
const SIGNAL_URL = `https://cdkd-state-123456789012.s3.us-east-1.amazonaws.com/${SIGNAL_KEY}?X-Amz-Signature=s`;
/** The state-bucket side of both wait-condition types, which a store unit test covers. */
const SIGNAL_STORE = {
  requireBucket: () => 'cdkd-state-123456789012',
  issueSignalUrl: async () => ({
    url: SIGNAL_URL,
    key: SIGNAL_KEY,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  }),
  readSignals: async () => [],
  deleteSignals: async () => undefined,
} as unknown as WaitConditionSignalStore;

export const CASES_NO_PROPERTIES: TypeCase[] = [
  {
    resourceType: 'AWS::CloudFormation::WaitConditionHandle',
    provider: () => new WaitConditionHandleProvider(SIGNAL_STORE),
    physicalId: SIGNAL_URL,
    createOnly: new Set(),
    ...NOTHING_TO_PROBE,
    noProperties: {
      reason:
        'the only schema property, Id, is read-only; the handle is a URL the state-bucket ' +
        'signal store signs (#6694), which sends no request',
      calls: { create: [], update: [] },
      createdId: SIGNAL_URL,
    },
  },
  {
    // Not a no-property type: its three properties drive the signal poll and
    // are never sent to AWS, so every one is exempt rather than probed.
    resourceType: 'AWS::CloudFormation::WaitCondition',
    provider: () => new WaitConditionProvider(SIGNAL_STORE),
    physicalId: 'cdkd-wait-condition-L',
    createOnly: new Set(),
    bags: [],
    exempt: {
      Handle: 'never sent: the signal URL the provider polls (#6694)',
      Count: 'never sent: how many signals the poll waits for (#6694)',
      Timeout: 'never sent: how long the poll waits (#6694)',
    },
    targets: [],
  },
  {
    resourceType: 'AWS::BedrockAgentCore::Browser',
    provider: () => new AgentCoreBrowserProvider(),
    physicalId: BROWSER_ARN,
    createOnly: new Set(),
    // The default browser answers with its ARN, which create records.
    arm: () => setOutputOverrides({ GetBrowserCommand: () => ({ browserArn: BROWSER_ARN }) }),
    ...NOTHING_TO_PROBE,
    noProperties: {
      reason: 'every schema property is read-only: create adopts the AWS-managed default browser',
      calls: { create: ['GetBrowserCommand /browsers/aws.browser.v1'], update: [] },
      createdId: BROWSER_ARN,
    },
  },
  {
    resourceType: 'AWS::BedrockAgentCore::CodeInterpreter',
    provider: () => new AgentCoreCodeInterpreterProvider(),
    physicalId: CODE_INTERPRETER_ARN,
    createOnly: new Set(),
    arm: () =>
      setOutputOverrides({
        GetCodeInterpreterCommand: () => ({ codeInterpreterArn: CODE_INTERPRETER_ARN }),
      }),
    ...NOTHING_TO_PROBE,
    noProperties: {
      reason:
        'every schema property is read-only: create adopts the AWS-managed default code interpreter',
      calls: {
        create: ['GetCodeInterpreterCommand /code-interpreters/aws.codeinterpreter.v1'],
        update: [],
      },
      createdId: CODE_INTERPRETER_ARN,
    },
  },
];
