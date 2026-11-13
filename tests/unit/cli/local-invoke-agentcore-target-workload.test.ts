import { describe, expect, it } from 'vite-plus/test';

import { agentCoreTargetWorkload } from '../../../src/cli/commands/local-invoke-agentcore/command.js';

// go-to-k/cdkd#6150: the mixed-mode workload of an AgentCore Runtime target,
// found before full resolution so `--from-state` names follow THIS runtime's
// own `--env-vars` sentinels.

const runtime = (path: string) => ({
  Type: 'AWS::BedrockAgentCore::Runtime',
  Metadata: { 'aws:cdk:path': path },
  Properties: {
    AgentRuntimeName: 'agent',
    AgentRuntimeArtifact: { ContainerConfiguration: { ContainerUri: 'public.ecr.aws/x/y:latest' } },
    RoleArn: 'arn:aws:iam::123456789012:role/r',
    NetworkConfiguration: { NetworkMode: 'PUBLIC' },
  },
});

const stacks = [
  {
    stackName: 'AgentStack',
    displayName: 'AgentStack',
    region: 'us-east-1',
    template: {
      Resources: {
        AgentA1234: runtime('AgentStack/AgentA/Resource'),
        AgentB5678: runtime('AgentStack/AgentB/Resource'),
      },
    },
  },
] as never;

describe('agentCoreTargetWorkload', () => {
  it('names the targeted runtime by logical ID, with its aws:cdk:path', () => {
    expect(agentCoreTargetWorkload('AgentStack:AgentA1234', stacks)).toEqual({
      logicalId: 'AgentA1234',
      cdkPath: 'AgentStack/AgentA/Resource',
    });
    expect(agentCoreTargetWorkload('AgentStack/AgentA', stacks)?.logicalId).toBe('AgentA1234');
    expect(agentCoreTargetWorkload('AgentB5678', stacks)).toEqual({
      logicalId: 'AgentB5678',
      cdkPath: 'AgentStack/AgentB/Resource',
    });
  });

  it('a target naming no single runtime gives no workload (the run-wide routing applies)', () => {
    expect(agentCoreTargetWorkload('Nope', stacks)).toBeUndefined();
  });
});
