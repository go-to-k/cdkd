/**
 * go-to-k/cdkd#6962 (rule 3 of #6940, measured): AWS refuses
 * `CreateAgentRuntimeEndpoint` while the runtime is `CREATING`
 * (`ConflictException: Agent version 1 must be in READY status`). Under
 * `--no-wait` a Cloud-Control-routed `AWS::BedrockAgentCore::RuntimeEndpoint`
 * create or update therefore waits for its runtime's deferred readiness first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockCloudControlSend = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCloudControlSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudFormation: { send: vi.fn() },
  }),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: (): unknown => child,
  };
  return { getLogger: () => child };
});

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { awaitRefusalEdgeTarget } from '../../../src/provisioning/deferred-refusal-edges.js';
import {
  withDeferredReadinessScope,
  type DeferredReadinessScope,
} from '../../../src/provisioning/deferred-readiness.js';

const ENDPOINT = 'AWS::BedrockAgentCore::RuntimeEndpoint';
const RUNTIME_ID = 'cdkdprobe_rt-AbCdEf1234';

function scope(
  awaitDeferredResource: DeferredReadinessScope['awaitDeferredResource'],
  resourceType = ENDPOINT
): DeferredReadinessScope {
  return {
    logicalId: 'Endpoint',
    resourceType,
    deferred: new Map(),
    awaitUpstreamReadiness: async () => undefined,
    awaitUpstreamReadinessRaw: async () => undefined,
    awaitDeferredResource,
  };
}

describe('refusal edges awaited under --no-wait (#6962)', () => {
  beforeEach(() => {
    mockCloudControlSend.mockReset();
    process.env['CDKD_NO_WAIT'] = 'true';
  });
  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  it("a runtime endpoint waits for its runtime's deferred readiness, by id", async () => {
    const asked: string[] = [];
    await withDeferredReadinessScope(
      scope((physicalId) => {
        asked.push(physicalId);
        return Promise.resolve();
      }),
      () => awaitRefusalEdgeTarget('Endpoint', ENDPOINT, { AgentRuntimeId: RUNTIME_ID, Name: 'live' })
    );
    expect(asked).toStrictEqual([RUNTIME_ID]);
  });

  it('an ARN-shaped runtime reference is tried by its last segment too', async () => {
    const asked: string[] = [];
    await withDeferredReadinessScope(
      scope((physicalId) => {
        asked.push(physicalId);
        return physicalId === RUNTIME_ID ? Promise.resolve() : undefined;
      }),
      () =>
        awaitRefusalEdgeTarget('Endpoint', ENDPOINT, {
          AgentRuntimeId: `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${RUNTIME_ID}`,
        })
    );
    expect(asked).toStrictEqual([
      `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${RUNTIME_ID}`,
      RUNTIME_ID,
    ]);
  });

  it('the default mode, and another type, wait for nothing', async () => {
    const lookup = vi.fn(() => Promise.resolve());
    delete process.env['CDKD_NO_WAIT'];
    await withDeferredReadinessScope(scope(lookup), () =>
      awaitRefusalEdgeTarget('Endpoint', ENDPOINT, { AgentRuntimeId: RUNTIME_ID })
    );
    process.env['CDKD_NO_WAIT'] = 'true';
    await withDeferredReadinessScope(scope(lookup, 'AWS::SQS::Queue'), () =>
      awaitRefusalEdgeTarget('Endpoint', 'AWS::SQS::Queue', { AgentRuntimeId: RUNTIME_ID })
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("Cloud Control's create of the endpoint sends nothing until the runtime is ready", async () => {
    const order: string[] = [];
    mockCloudControlSend.mockImplementation(async () => {
      order.push('cloud control call');
      throw new Error('stop here');
    });
    const provider = new CloudControlProvider();
    await withDeferredReadinessScope(
      scope(
        () =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              order.push('runtime ready');
              resolve();
            }, 10)
          )
      ),
      () =>
        provider.create('Endpoint', ENDPOINT, { AgentRuntimeId: RUNTIME_ID, Name: 'live' }).catch(() => undefined)
    );
    expect(order[0]).toBe('runtime ready');
    expect(order).toContain('cloud control call');
  });

  it("Cloud Control's update of the endpoint waits too (a new runtime version)", async () => {
    const order: string[] = [];
    mockCloudControlSend.mockImplementation(async () => {
      order.push('cloud control call');
      throw new Error('stop here');
    });
    const provider = new CloudControlProvider();
    await withDeferredReadinessScope(
      scope(
        () =>
          new Promise<void>((resolve) =>
            setTimeout(() => {
              order.push('runtime ready');
              resolve();
            }, 10)
          )
      ),
      () =>
        provider
          .update(
            'Endpoint',
            'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/x/runtime-endpoint/live',
            ENDPOINT,
            { AgentRuntimeId: RUNTIME_ID, Name: 'live', AgentRuntimeVersion: '2' },
            { AgentRuntimeId: RUNTIME_ID, Name: 'live', AgentRuntimeVersion: '1' }
          )
          .catch(() => undefined)
    );
    expect(order[0]).toBe('runtime ready');
  });
});
