/**
 * go-to-k/cdkd#2762: `AWS::BedrockAgentCore::Runtime`'s
 * RequestHeaderConfiguration / FilesystemConfigurations /
 * CapacityProviderConfiguration / PlatformVersion / Tags reach AWS through the
 * SDK provider instead of routing the resource to Cloud Control.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateAgentRuntimeCommand,
  GetAgentRuntimeCommand,
  ListTagsForResourceCommand,
  ResourceNotFoundException,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

const mockSend = vi.fn();
const warn = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    bedrockAgentCoreControl: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warn(...args),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import {
  AgentCoreRuntimeProvider,
  CREATE_TAG_RETRY_DELAYS_MS,
} from '../../../src/provisioning/providers/agentcore-runtime-provider.js';
import {
  createdBeforeFailure,
  isAuxiliaryFailure,
} from '../../../src/provisioning/auxiliary-failure.js';

const TYPE = 'AWS::BedrockAgentCore::Runtime';
const ID = 'runtime-1';
const ARN = `arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/${ID}`;
const BASE = {
  AgentRuntimeName: 'my_runtime',
  RoleArn: 'arn:aws:iam::123456789012:role/r',
  AgentRuntimeArtifact: { ContainerConfiguration: { ContainerUri: 'uri' } },
};
const NEW_FIELDS = {
  RequestHeaderConfiguration: {
    RequestHeaderAllowlist: ['X-Amzn-Bedrock-AgentCore-Runtime-Custom-A'],
  },
  FilesystemConfigurations: [{ SessionStorage: { MountPath: '/mnt/session' } }],
  CapacityProviderConfiguration: { CapacityProviderArn: 'arn:cp' },
  PlatformVersion: '1.0',
};
const SDK_NEW_FIELDS = {
  requestHeaderConfiguration: {
    requestHeaderAllowlist: ['X-Amzn-Bedrock-AgentCore-Runtime-Custom-A'],
  },
  filesystemConfigurations: [{ sessionStorage: { mountPath: '/mnt/session' } }],
  capacityProviderConfiguration: { capacityProviderArn: 'arn:cp' },
  platformVersion: '1.0',
};

function commandsSent(): unknown[] {
  return mockSend.mock.calls.map((c) => c[0]);
}

function inputOf<T>(ctor: new (...args: never[]) => T): Record<string, unknown> {
  const cmd = commandsSent().find((c) => c instanceof ctor) as { input: Record<string, unknown> };
  expect(cmd, ctor.name).toBeDefined();
  return cmd.input;
}

const sleeps: number[] = [];

function countOf<T>(ctor: new (...args: never[]) => T): number {
  return commandsSent().filter((c) => c instanceof ctor).length;
}

describe('AgentCoreRuntimeProvider go-to-k/cdkd#2762 backfill', () => {
  let provider: AgentCoreRuntimeProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    // Drain any `*Once` primer a failed case left, so one red stays one red.
    mockSend.mockReset();
    provider = new AgentCoreRuntimeProvider();
    sleeps.length = 0;
    (provider as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => {
      sleeps.push(ms);
    };
  });

  it('declares the five properties handled', () => {
    const handled = provider.handledProperties.get(TYPE)!;
    for (const p of [...Object.keys(NEW_FIELDS), 'Tags']) expect(handled.has(p), p).toBe(true);
  });

  describe('create', () => {
    it('sends the four fields camelCased and Tags as a map with keys verbatim', async () => {
      mockSend
        .mockResolvedValueOnce({ agentRuntimeId: ID, agentRuntimeArn: ARN })
        .mockResolvedValueOnce({ tags: { Env: 'dev', lowerKey: 'v', 'Cost-Center': '5433' } });
      await provider.create('L', TYPE, {
        ...BASE,
        ...NEW_FIELDS,
        Tags: { Env: 'dev', lowerKey: 'v', 'Cost-Center': 5433 },
      });
      const input = inputOf(CreateAgentRuntimeCommand);
      expect(input).toMatchObject(SDK_NEW_FIELDS);
      // A tag value CloudFormation would coerce reaches AWS as a string.
      expect(input['tags']).toEqual({ Env: 'dev', lowerKey: 'v', 'Cost-Center': '5433' });
      // The created runtime kept them: read back, and no TagResource.
      expect(inputOf(ListTagsForResourceCommand)).toEqual({ resourceArn: ARN });
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(commandsSent().some((c) => c instanceof TagResourceCommand)).toBe(false);
    });

    // Observed on real AWS (go-to-k/cdkd#2762 integ): CreateAgentRuntime was
    // sent the tags (CloudTrail) and the runtime answered ListTagsForResource
    // with {} both right after the create and once READY.
    it('sets with TagResource the declared tags the new runtime does not carry', async () => {
      mockSend
        .mockResolvedValueOnce({ agentRuntimeId: ID, agentRuntimeArn: ARN })
        .mockResolvedValueOnce({ tags: { Kept: 'k', Changed: 'other' } })
        .mockResolvedValueOnce({});
      const result = await provider.create('L', TYPE, {
        ...BASE,
        Tags: { Kept: 'k', Changed: 'mine', Lost: 'l' },
      });
      expect(result.physicalId).toBe(ID);
      expect(inputOf(TagResourceCommand)).toEqual({
        resourceArn: ARN,
        tags: { Changed: 'mine', Lost: 'l' },
      });
      expect(mockSend).toHaveBeenCalledTimes(3);
    });

    it('sets every declared tag when the read-back fails', async () => {
      mockSend
        .mockResolvedValueOnce({ agentRuntimeId: ID, agentRuntimeArn: ARN })
        .mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }))
        .mockResolvedValueOnce({});
      await provider.create('L', TYPE, { ...BASE, Tags: { A: '1', B: '2' } });
      expect(inputOf(TagResourceCommand)).toEqual({ resourceArn: ARN, tags: { A: '1', B: '2' } });
    });

    // A transient failure of a post-create tag call is retried in place: the
    // engine's retry would replay CreateAgentRuntime into a name collision.
    it('retries a read-after-create not-found on ListTagsForResource without re-creating', async () => {
      mockSend
        .mockResolvedValueOnce({ agentRuntimeId: ID, agentRuntimeArn: ARN })
        .mockRejectedValueOnce(new ResourceNotFoundException({ message: 'not yet', $metadata: {} }))
        .mockResolvedValueOnce({ tags: {} })
        .mockResolvedValueOnce({});
      const result = await provider.create('L', TYPE, { ...BASE, Tags: { A: '1' } });
      expect(result.physicalId).toBe(ID);
      expect(countOf(CreateAgentRuntimeCommand)).toBe(1);
      expect(countOf(ListTagsForResourceCommand)).toBe(2);
      expect(inputOf(TagResourceCommand)).toEqual({ resourceArn: ARN, tags: { A: '1' } });
      expect(sleeps).toEqual([CREATE_TAG_RETRY_DELAYS_MS[0]]);
    });

    it('retries a throttled TagResource without re-creating', async () => {
      mockSend
        .mockResolvedValueOnce({ agentRuntimeId: ID, agentRuntimeArn: ARN })
        .mockResolvedValueOnce({ tags: {} })
        .mockRejectedValueOnce(
          Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException', $metadata: {} })
        )
        .mockResolvedValueOnce({});
      await provider.create('L', TYPE, { ...BASE, Tags: { A: '1' } });
      expect(countOf(CreateAgentRuntimeCommand)).toBe(1);
      expect(countOf(TagResourceCommand)).toBe(2);
    });

    it('fails at once on a non-transient TagResource failure', async () => {
      mockSend
        .mockResolvedValueOnce({ agentRuntimeId: ID, agentRuntimeArn: ARN })
        .mockResolvedValueOnce({ tags: {} })
        .mockRejectedValueOnce(
          Object.assign(new Error('bad tag'), { name: 'ValidationException', $metadata: {} })
        );
      await expect(provider.create('L', TYPE, { ...BASE, Tags: { A: '1' } })).rejects.toThrow(
        /Failed to create BedrockAgentCore Runtime L/
      );
      expect(countOf(TagResourceCommand)).toBe(1);
      expect(sleeps).toEqual([]);
    });

    it('gives up after the bounded retries on a persistent not-found', async () => {
      mockSend.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof CreateAgentRuntimeCommand) return { agentRuntimeId: ID, agentRuntimeArn: ARN };
        if (cmd instanceof ListTagsForResourceCommand) return { tags: {} };
        throw new ResourceNotFoundException({ message: 'gone', $metadata: {} });
      });
      const err = await provider.create('L', TYPE, { ...BASE, Tags: { A: '1' } }).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(createdBeforeFailure(err, 'L', TYPE)).toBe(ID);
      expect(countOf(TagResourceCommand)).toBe(CREATE_TAG_RETRY_DELAYS_MS.length + 1);
      expect(sleeps).toEqual([...CREATE_TAG_RETRY_DELAYS_MS]);
      expect(countOf(CreateAgentRuntimeCommand)).toBe(1);
    });

    it('reads no tags back for a runtime declaring none', async () => {
      mockSend.mockResolvedValueOnce({ agentRuntimeId: ID, agentRuntimeArn: ARN });
      await provider.create('L', TYPE, { ...BASE });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('marks a failed post-create TagResource as created-before-failure and auxiliary', async () => {
      const tagFailure = Object.assign(new Error('Resource already exists'), {
        name: 'ValidationException',
        $fault: 'client',
        $metadata: {},
      });
      mockSend
        .mockResolvedValueOnce({ agentRuntimeId: ID, agentRuntimeArn: ARN })
        .mockResolvedValueOnce({ tags: {} })
        .mockRejectedValueOnce(tagFailure);
      const err = await provider.create('L', TYPE, { ...BASE, Tags: { A: '1' } }).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Failed to create BedrockAgentCore Runtime L/);
      expect(createdBeforeFailure(err, 'L', TYPE)).toBe(ID);
      expect(isAuxiliaryFailure(err)).toBe(true);
    });

    it('marks nothing when CreateAgentRuntime itself fails', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('bad'), { name: 'ValidationException', $metadata: {} })
      );
      const err = await provider.create('L', TYPE, { ...BASE, Tags: { A: '1' } }).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(createdBeforeFailure(err, 'L', TYPE)).toBeUndefined();
      expect(isAuxiliaryFailure(err)).toBe(false);
    });

    it('accepts a hand-written {Key, Value} tag list', async () => {
      mockSend
        .mockResolvedValueOnce({ agentRuntimeId: ID, agentRuntimeArn: ARN })
        .mockResolvedValueOnce({ tags: { Env: 'dev' } });
      await provider.create('L', TYPE, { ...BASE, Tags: [{ Key: 'Env', Value: 'dev' }] });
      expect(inputOf(CreateAgentRuntimeCommand)['tags']).toEqual({ Env: 'dev' });
    });

    it('refuses a reserved aws: tag key before any call, as AWS would', async () => {
      await expect(
        provider.create('L', TYPE, { ...BASE, Tags: { Env: 'dev', 'aws:x': 'y' } })
      ).rejects.toThrow(/Tags of AWS::BedrockAgentCore::Runtime L holds a reserved aws: key/);
      await expect(
        provider.update('L', ID, TYPE, { ...BASE, Tags: { 'aws:x': 'y' } }, { ...BASE })
      ).rejects.toThrow(/desired Tags .* reserved aws: key.*was not updated/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('sends no tags member and none of the four fields when the template declares none', async () => {
      mockSend.mockResolvedValueOnce({ agentRuntimeId: ID, agentRuntimeArn: ARN });
      await provider.create('L', TYPE, { ...BASE });
      const input = inputOf(CreateAgentRuntimeCommand);
      for (const k of [...Object.keys(SDK_NEW_FIELDS), 'tags']) expect(k in input, k).toBe(false);
    });

    it('refuses a malformed Tags before any call', async () => {
      await expect(
        provider.create('L', TYPE, { ...BASE, Tags: { Env: { nested: 'x' } } })
      ).rejects.toThrow(/Tags of AWS::BedrockAgentCore::Runtime L is not a map/);
      await expect(provider.create('L', TYPE, { ...BASE, Tags: 'x' })).rejects.toThrow(
        /is not a map/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('sends the four fields on the full-replace call and omits each once removed', async () => {
      mockSend.mockResolvedValue({ agentRuntimeId: ID, agentRuntimeArn: ARN });
      await provider.update('L', ID, TYPE, { ...BASE, ...NEW_FIELDS }, { ...BASE });
      expect(inputOf(UpdateAgentRuntimeCommand)).toMatchObject(SDK_NEW_FIELDS);

      mockSend.mockClear();
      await provider.update('L', ID, TYPE, { ...BASE }, { ...BASE, ...NEW_FIELDS });
      const input = inputOf(UpdateAgentRuntimeCommand);
      for (const k of Object.keys(SDK_NEW_FIELDS)) expect(k in input, k).toBe(false);
      // UpdateAgentRuntime takes no tags.
      expect('tags' in input).toBe(false);
      mockSend.mockReset();
    });

    it('leaves the readCurrentState placeholders off the wire (a drift --revert round-trip)', async () => {
      mockSend.mockResolvedValueOnce({ agentRuntimeId: ID, agentRuntimeArn: ARN });
      await provider.update(
        'L',
        ID,
        TYPE,
        {
          ...BASE,
          RequestHeaderConfiguration: {},
          FilesystemConfigurations: [],
          CapacityProviderConfiguration: {},
          PlatformVersion: '',
          Tags: {},
        },
        { ...BASE, Tags: {} }
      );
      const input = inputOf(UpdateAgentRuntimeCommand);
      for (const k of Object.keys(SDK_NEW_FIELDS)) expect(k in input, k).toBe(false);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('untags removed keys and tags new or changed ones on the response ARN', async () => {
      mockSend.mockResolvedValue({ agentRuntimeId: ID, agentRuntimeArn: ARN });
      await provider.update(
        'L',
        ID,
        TYPE,
        { ...BASE, Tags: { Keep: 'same', Changed: 'new', Added: 'a' } },
        { ...BASE, Tags: { Keep: 'same', Changed: 'old', Gone: 'g', 'aws:x': 'y' } }
      );
      expect(inputOf(UntagResourceCommand)).toEqual({ resourceArn: ARN, tagKeys: ['Gone'] });
      expect(inputOf(TagResourceCommand)).toEqual({
        resourceArn: ARN,
        tags: { Changed: 'new', Added: 'a' },
      });
      expect(commandsSent().some((c) => c instanceof GetAgentRuntimeCommand)).toBe(false);
      mockSend.mockReset();
    });

    it('sends no tag call when Tags is unchanged', async () => {
      mockSend.mockResolvedValueOnce({ agentRuntimeId: ID, agentRuntimeArn: ARN });
      await provider.update('L', ID, TYPE, { ...BASE, Tags: { A: '1' } }, { ...BASE, Tags: { A: '1' } });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('reads the ARN with GetAgentRuntime when the update response lacks it', async () => {
      mockSend
        .mockResolvedValueOnce({ agentRuntimeId: ID })
        .mockResolvedValueOnce({ agentRuntimeId: ID, agentRuntimeArn: ARN })
        .mockResolvedValueOnce({});
      await provider.update('L', ID, TYPE, { ...BASE, Tags: { A: '1' } }, { ...BASE });
      expect(commandsSent()[1]).toBeInstanceOf(GetAgentRuntimeCommand);
      expect(inputOf(TagResourceCommand)).toEqual({ resourceArn: ARN, tags: { A: '1' } });
    });

    it('refuses a malformed desired Tags before any call', async () => {
      await expect(
        provider.update('L', ID, TYPE, { ...BASE, Tags: ['x'] }, { ...BASE })
      ).rejects.toThrow(/desired Tags of AWS::BedrockAgentCore::Runtime L is not a map/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('never untags a recorded key that holds a dynamic reference', async () => {
      mockSend.mockResolvedValue({ agentRuntimeId: ID, agentRuntimeArn: ARN });
      await provider.update(
        'L',
        ID,
        TYPE,
        { ...BASE, Tags: { A: '1' } },
        { ...BASE, Tags: { A: '1', '{{resolve:secretsmanager:s:SecretString:k}}': 'v' } }
      );
      expect(commandsSent().some((c) => c instanceof UntagResourceCommand)).toBe(false);
      expect(commandsSent().some((c) => c instanceof TagResourceCommand)).toBe(false);
      mockSend.mockReset();
    });

    it('routes a failed TagResource through the masker', async () => {
      mockSend
        .mockResolvedValueOnce({ agentRuntimeId: ID, agentRuntimeArn: ARN })
        .mockRejectedValueOnce(new Error('tag value s3cr3t-plain rejected'));
      const err = await provider
        .update('L', ID, TYPE, { ...BASE, Tags: { A: 's3cr3t-plain' } }, { ...BASE }, {
          maskSecrets: (t: string) => t.replaceAll('s3cr3t-plain', '***'),
        })
        .then(
          () => undefined,
          (e: unknown) => e as Error
        );
      expect(err?.message).toMatch(/Failed to update BedrockAgentCore Runtime L/);
      expect(err?.message).not.toContain('s3cr3t-plain');
    });

    it('untags nothing and warns when the recorded Tags is unreadable', async () => {
      mockSend.mockResolvedValue({ agentRuntimeId: ID, agentRuntimeArn: ARN });
      await provider.update('L', ID, TYPE, { ...BASE, Tags: { A: '1' } }, { ...BASE, Tags: 'junk' });
      expect(commandsSent().some((c) => c instanceof UntagResourceCommand)).toBe(false);
      expect(inputOf(TagResourceCommand)).toEqual({ resourceArn: ARN, tags: { A: '1' } });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/recorded Tags .* not a list/));
      mockSend.mockReset();
    });
  });
});
