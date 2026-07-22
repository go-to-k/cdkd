import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';
import {
  CreateMicrovmImageCommand,
  GetMicrovmImageCommand,
  UpdateMicrovmImageCommand,
  DeleteMicrovmImageCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-lambda-microvms';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambdaMicrovms: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
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

import { LambdaMicrovmImageProvider } from '../../../src/provisioning/providers/lambda-microvm-image-provider.js';

const TYPE = 'AWS::Lambda::MicrovmImage';
const ARN = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:my-image';
const BASE = 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1';
const ROLE = 'arn:aws:iam::123456789012:role/MicrovmBuildRole';

function callsOfType(klass: { new (...args: any[]): any }): any[] {
  return mockSend.mock.calls
    .filter((call) => call[0].constructor.name === klass.name)
    .map((call) => call[0]);
}

function notFound(): ResourceNotFoundException {
  return new ResourceNotFoundException({ message: 'not found', $metadata: {} });
}

function minimalProps(): Record<string, unknown> {
  return {
    Name: 'my-image',
    BaseImageArn: BASE,
    BuildRoleArn: ROLE,
    CodeArtifact: { Uri: 's3://my-bucket/app.zip' },
  };
}

describe('LambdaMicrovmImageProvider', () => {
  let provider: LambdaMicrovmImageProvider;
  let originalNoWait: string | undefined;

  beforeEach(() => {
    mockSend.mockReset();
    originalNoWait = process.env['CDKD_NO_WAIT'];
    delete process.env['CDKD_NO_WAIT'];
    // Fast polling for tests.
    process.env['CDKD_MICROVM_IMAGE_POLL_INTERVAL_MS'] = '1';
    process.env['CDKD_MICROVM_IMAGE_POLL_ATTEMPTS'] = '10';
    provider = new LambdaMicrovmImageProvider();
  });

  afterEach(() => {
    if (originalNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = originalNoWait;
    delete process.env['CDKD_MICROVM_IMAGE_POLL_INTERVAL_MS'];
    delete process.env['CDKD_MICROVM_IMAGE_POLL_ATTEMPTS'];
  });

  describe('create', () => {
    it('creates with the minimal property set and returns the ARN as physicalId', async () => {
      mockSend.mockResolvedValueOnce({ imageArn: ARN, state: 'CREATING' }); // Create
      mockSend.mockResolvedValueOnce({ state: 'CREATED' }); // Get poll

      const result = await provider.create('MyImage', TYPE, minimalProps());

      expect(result.physicalId).toBe(ARN);
      expect(result.attributes).toMatchObject({ ImageArn: ARN, State: 'CREATED' });

      const req = callsOfType(CreateMicrovmImageCommand)[0].input;
      expect(req.name).toBe('my-image');
      expect(req.baseImageArn).toBe(BASE);
      expect(req.buildRoleArn).toBe(ROLE);
      expect(req.codeArtifact).toEqual({ uri: 's3://my-bucket/app.zip' });
      // No optional fields on a minimal create.
      expect(req.tags).toBeUndefined();
      expect(req.logging).toBeUndefined();
    });

    it('translates every CFn-shaped optional property to the SDK shape', async () => {
      mockSend.mockResolvedValueOnce({ imageArn: ARN, state: 'CREATING' });
      mockSend.mockResolvedValueOnce({ state: 'CREATED' });

      await provider.create('MyImage', TYPE, {
        ...minimalProps(),
        BaseImageVersion: '1.0',
        Description: 'my image',
        Logging: { CloudWatch: { LogGroup: '/my/lg', LogStream: 'build' } },
        EgressNetworkConnectors: ['connector-a'],
        CpuConfigurations: [{ Architecture: 'ARM_64' }],
        Resources: [{ MinimumMemoryInMiB: 4096 }],
        AdditionalOsCapabilities: ['ALL'],
        Hooks: {
          Port: 8080,
          MicrovmImageHooks: { Ready: 'ENABLED', ReadyTimeoutInSeconds: 120 },
        },
        EnvironmentVariables: [{ Key: 'FOO', Value: 'bar' }],
        Tags: [{ Key: 'team', Value: 'infra' }],
      });

      const req = callsOfType(CreateMicrovmImageCommand)[0].input;
      expect(req.baseImageVersion).toBe('1.0');
      expect(req.description).toBe('my image');
      expect(req.logging).toEqual({ cloudWatch: { logGroup: '/my/lg', logStream: 'build' } });
      expect(req.egressNetworkConnectors).toEqual(['connector-a']);
      expect(req.cpuConfigurations).toEqual([{ architecture: 'ARM_64' }]);
      expect(req.resources).toEqual([{ minimumMemoryInMiB: 4096 }]);
      expect(req.additionalOsCapabilities).toEqual(['ALL']);
      expect(req.hooks).toEqual({
        port: 8080,
        microvmImageHooks: { ready: 'ENABLED', readyTimeoutInSeconds: 120 },
      });
      expect(req.environmentVariables).toEqual({ FOO: 'bar' });
      expect(req.tags).toEqual({ team: 'infra' });
    });

    it('maps a partial Logging.CloudWatch (LogGroup only) without a LogStream', async () => {
      mockSend.mockResolvedValueOnce({ imageArn: ARN, state: 'CREATING' });
      mockSend.mockResolvedValueOnce({ state: 'CREATED' });

      await provider.create('MyImage', TYPE, {
        ...minimalProps(),
        Logging: { CloudWatch: { LogGroup: '/only/group' } },
      });

      expect(callsOfType(CreateMicrovmImageCommand)[0].input.logging).toEqual({
        cloudWatch: { logGroup: '/only/group' },
      });
    });

    it('filters out a Resources entry missing a numeric MinimumMemoryInMiB', async () => {
      mockSend.mockResolvedValueOnce({ imageArn: ARN, state: 'CREATING' });
      mockSend.mockResolvedValueOnce({ state: 'CREATED' });

      await provider.create('MyImage', TYPE, {
        ...minimalProps(),
        Resources: [{ MinimumMemoryInMiB: 4096 }, { NotMemory: 1 }],
      });

      // The malformed entry is dropped rather than sent as NaN.
      expect(callsOfType(CreateMicrovmImageCommand)[0].input.resources).toEqual([
        { minimumMemoryInMiB: 4096 },
      ]);
    });

    it('maps Logging { Disabled: true } to the tagged-union { disabled: {} }', async () => {
      mockSend.mockResolvedValueOnce({ imageArn: ARN, state: 'CREATING' });
      mockSend.mockResolvedValueOnce({ state: 'CREATED' });

      await provider.create('MyImage', TYPE, { ...minimalProps(), Logging: { Disabled: true } });

      expect(callsOfType(CreateMicrovmImageCommand)[0].input.logging).toEqual({ disabled: {} });
    });

    it('throws when a required property is missing', async () => {
      const { Name, ...rest } = minimalProps();
      void Name;
      await expect(provider.create('MyImage', TYPE, rest)).rejects.toThrow(/Name is required/);
      expect(callsOfType(CreateMicrovmImageCommand)).toHaveLength(0);
    });

    it('polls GetMicrovmImage until CREATED', async () => {
      mockSend.mockResolvedValueOnce({ imageArn: ARN, state: 'CREATING' }); // Create
      mockSend.mockResolvedValueOnce({ state: 'CREATING' }); // poll 1
      mockSend.mockResolvedValueOnce({ state: 'CREATED' }); // poll 2

      const result = await provider.create('MyImage', TYPE, minimalProps());

      expect(result.physicalId).toBe(ARN);
      expect(callsOfType(GetMicrovmImageCommand)).toHaveLength(2);
    });

    it('throws on CREATE_FAILED', async () => {
      mockSend.mockResolvedValueOnce({ imageArn: ARN, state: 'CREATING' });
      mockSend.mockResolvedValueOnce({ state: 'CREATE_FAILED' });

      await expect(provider.create('MyImage', TYPE, minimalProps())).rejects.toThrow(
        /CREATE_FAILED/
      );
    });

    it('skips the poll when CDKD_NO_WAIT=true', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      mockSend.mockResolvedValueOnce({ imageArn: ARN, state: 'CREATING' });

      const result = await provider.create('MyImage', TYPE, minimalProps());

      expect(result.physicalId).toBe(ARN);
      expect(callsOfType(GetMicrovmImageCommand)).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('issues UpdateMicrovmImage on a build-affecting change and polls until UPDATED', async () => {
      mockSend.mockResolvedValueOnce({}); // Update
      mockSend.mockResolvedValueOnce({ state: 'UPDATING' }); // poll 1
      mockSend.mockResolvedValueOnce({ state: 'UPDATED' }); // poll 2

      const prev = minimalProps();
      const next = { ...minimalProps(), Description: 'changed' };
      const result = await provider.update('MyImage', ARN, TYPE, next, prev);

      expect(result.wasReplaced).toBe(false);
      expect(result.physicalId).toBe(ARN);
      const req = callsOfType(UpdateMicrovmImageCommand)[0].input;
      expect(req.imageIdentifier).toBe(ARN);
      expect(req.name).toBeUndefined(); // update input has no name field
      expect(req.description).toBe('changed');
      // Always sends environmentVariables so removal is applied, not dropped.
      expect(req.environmentVariables).toEqual({});
    });

    it('reconciles a tags-only change via Tag/UntagResource WITHOUT an image rebuild', async () => {
      mockSend.mockResolvedValueOnce({}); // UntagResource
      mockSend.mockResolvedValueOnce({}); // TagResource
      mockSend.mockResolvedValueOnce({ state: 'CREATED' }); // GetMicrovmImage (no rebuild)

      const prev = { ...minimalProps(), Tags: [{ Key: 'env', Value: 'dev' }, { Key: 'old', Value: 'x' }] };
      const next = { ...minimalProps(), Tags: [{ Key: 'env', Value: 'prod' }] };
      const result = await provider.update('MyImage', ARN, TYPE, next, prev);

      expect(result.wasReplaced).toBe(false);
      expect(callsOfType(UpdateMicrovmImageCommand)).toHaveLength(0); // no rebuild
      const untag = callsOfType(UntagResourceCommand)[0].input;
      expect(untag.Resource).toBe(ARN);
      expect(untag.TagKeys).toEqual(['old']);
      const tag = callsOfType(TagResourceCommand)[0].input;
      expect(tag.Tags).toEqual({ env: 'prod' });
    });

    it('clears environmentVariables when the last one is removed (sends {})', async () => {
      mockSend.mockResolvedValueOnce({}); // Update
      mockSend.mockResolvedValueOnce({ state: 'UPDATED' }); // poll

      const prev = { ...minimalProps(), EnvironmentVariables: [{ Key: 'FOO', Value: 'bar' }] };
      const next = { ...minimalProps(), EnvironmentVariables: [] };
      await provider.update('MyImage', ARN, TYPE, next, prev);

      expect(callsOfType(UpdateMicrovmImageCommand)[0].input.environmentVariables).toEqual({});
    });

    it('refuses a create-only Name change in place', async () => {
      const prev = minimalProps();
      const next = { ...minimalProps(), Name: 'renamed' };
      await expect(provider.update('MyImage', ARN, TYPE, next, prev)).rejects.toThrow(
        /create-only/
      );
      expect(callsOfType(UpdateMicrovmImageCommand)).toHaveLength(0);
    });

    it('throws when a required build property is missing on a build-affecting update', async () => {
      const prev = minimalProps();
      const next: Record<string, unknown> = { ...minimalProps(), Description: 'changed' };
      delete next['BaseImageArn'];
      await expect(provider.update('MyImage', ARN, TYPE, next, prev)).rejects.toThrow(
        /BaseImageArn.*required/
      );
    });
  });

  describe('delete', () => {
    it('deletes then polls until the image is gone', async () => {
      mockSend.mockResolvedValueOnce({ imageIdentifier: ARN, state: 'DELETING' }); // Delete
      mockSend.mockResolvedValueOnce({ state: 'DELETING' }); // poll 1
      mockSend.mockRejectedValueOnce(notFound()); // poll 2 -> gone

      await provider.delete('MyImage', ARN, TYPE, undefined, { expectedRegion: 'us-east-1' });

      expect(callsOfType(DeleteMicrovmImageCommand)).toHaveLength(1);
      expect(callsOfType(GetMicrovmImageCommand).length).toBeGreaterThanOrEqual(1);
    });

    it('treats NotFound on the delete call as idempotent success', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(
        provider.delete('MyImage', ARN, TYPE, undefined, { expectedRegion: 'us-east-1' })
      ).resolves.toBeUndefined();
      expect(callsOfType(GetMicrovmImageCommand)).toHaveLength(0);
    });

    it('throws on DELETE_FAILED', async () => {
      mockSend.mockResolvedValueOnce({ imageIdentifier: ARN, state: 'DELETING' });
      mockSend.mockResolvedValueOnce({ state: 'DELETE_FAILED' });

      await expect(provider.delete('MyImage', ARN, TYPE)).rejects.toThrow(/DELETE_FAILED/);
    });

    it('refuses to treat NotFound as success when the client region does not match', async () => {
      mockSend.mockRejectedValueOnce(notFound()); // Delete -> NotFound
      // client region is us-east-1 (mock), expectedRegion is eu-west-1 -> mismatch
      await expect(
        provider.delete('MyImage', ARN, TYPE, undefined, { expectedRegion: 'eu-west-1' })
      ).rejects.toThrow();
    });
  });

  describe('getAttribute', () => {
    it('returns ImageArn from the physicalId without an API call', async () => {
      expect(await provider.getAttribute(ARN, TYPE, 'ImageArn')).toBe(ARN);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('reads State and version attributes via GetMicrovmImage', async () => {
      mockSend.mockResolvedValue({
        state: 'CREATED',
        latestActiveImageVersion: '1.0',
      });
      expect(await provider.getAttribute(ARN, TYPE, 'State')).toBe('CREATED');
      expect(await provider.getAttribute(ARN, TYPE, 'LatestActiveImageVersion')).toBe('1.0');
    });

    it('serializes CreatedAt / UpdatedAt Date attributes to ISO strings', async () => {
      const created = new Date('2026-07-22T00:00:00.000Z');
      mockSend.mockResolvedValue({ state: 'CREATED', createdAt: created, updatedAt: created });
      expect(await provider.getAttribute(ARN, TYPE, 'CreatedAt')).toBe('2026-07-22T00:00:00.000Z');
      expect(await provider.getAttribute(ARN, TYPE, 'UpdatedAt')).toBe('2026-07-22T00:00:00.000Z');
    });

    it('returns undefined for an unknown attribute', async () => {
      mockSend.mockResolvedValue({ state: 'CREATED' });
      expect(await provider.getAttribute(ARN, TYPE, 'Nope')).toBeUndefined();
    });
  });
});
