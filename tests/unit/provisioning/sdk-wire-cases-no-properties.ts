import { REGION, type TypeCase } from './sdk-wire-harness.js';
import { WaitConditionHandleProvider } from '../../../src/provisioning/providers/wait-condition-handle-provider.js';
import { AgentCoreBrowserProvider } from '../../../src/provisioning/providers/agentcore-browser-provider.js';
import { AgentCoreCodeInterpreterProvider } from '../../../src/provisioning/providers/agentcore-code-interpreter-provider.js';

/**
 * Wire cases for SDK provider classes that handle NO property (#3723): every
 * schema property of their type is read-only, so there is no bag to probe.
 * Each pins the calls `create({})` and `update({}, {})` make instead
 * (`TypeCase.noProperties`). Run by `sdk-wire-coverage-no-properties.test.ts`;
 * the ledger in `sdk-wire-coverage.test.ts` counts them as covered.
 */

const NOTHING_TO_PROBE = { bags: [], exempt: {}, targets: [] };

export const CASES_NO_PROPERTIES: TypeCase[] = [
  {
    resourceType: 'AWS::CloudFormation::WaitConditionHandle',
    provider: () => new WaitConditionHandleProvider(),
    physicalId: 'cdkd-wait-condition-handle-L',
    createOnly: new Set(),
    ...NOTHING_TO_PROBE,
    noProperties: {
      reason: 'the only schema property, Id, is read-only; the handle is a local placeholder',
      calls: { create: [], update: [] },
    },
  },
  {
    resourceType: 'AWS::BedrockAgentCore::Browser',
    provider: () => new AgentCoreBrowserProvider(),
    physicalId: `arn:aws:bedrock-agentcore:${REGION}:aws:browser/aws.browser.v1`,
    createOnly: new Set(),
    ...NOTHING_TO_PROBE,
    noProperties: {
      reason: 'every schema property is read-only: create adopts the AWS-managed default browser',
      calls: { create: ['GetBrowserCommand /browsers/aws.browser.v1'], update: [] },
    },
  },
  {
    resourceType: 'AWS::BedrockAgentCore::CodeInterpreter',
    provider: () => new AgentCoreCodeInterpreterProvider(),
    physicalId: `arn:aws:bedrock-agentcore:${REGION}:aws:code-interpreter/aws.codeinterpreter.v1`,
    createOnly: new Set(),
    ...NOTHING_TO_PROBE,
    noProperties: {
      reason:
        'every schema property is read-only: create adopts the AWS-managed default code interpreter',
      calls: {
        create: ['GetCodeInterpreterCommand /code-interpreters/aws.codeinterpreter.v1'],
        update: [],
      },
    },
  },
];
