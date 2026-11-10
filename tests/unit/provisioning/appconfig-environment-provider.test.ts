import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, mockStsSend } = vi.hoisted(() => ({ mockSend: vi.fn(), mockStsSend: vi.fn() }));

vi.mock('@aws-sdk/client-appconfig', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    AppConfigClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ sts: { send: mockStsSend } }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import {
  CreateEnvironmentCommand,
  DeleteEnvironmentCommand,
  GetEnvironmentCommand,
} from '@aws-sdk/client-appconfig';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../src/provisioning/register-providers.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';
import { AppConfigEnvironmentProvider } from '../../../src/provisioning/providers/appconfig-environment-provider.js';

const providerClasses = await loadProviderClasses();
const TYPE = 'AWS::AppConfig::Environment';
const ID = 'app123|env456';

const inputOf = (n: number): Record<string, unknown> =>
  (mockSend.mock.calls[n]![0] as { input: Record<string, unknown> }).input;

describe('AppConfigEnvironmentProvider', () => {
  let provider: AppConfigEnvironmentProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockStsSend.mockReset();
    provider = new AppConfigEnvironmentProvider();
  });

  describe('delete (go-to-k/cdkd#5875)', () => {
    it.each(['BYPASS', 'APPLY', 'ACCOUNT_DEFAULT'])(
      'forwards the recorded DeletionProtectionCheck %s',
      async (value) => {
        mockSend.mockResolvedValueOnce({});
        await provider.delete('Env', ID, TYPE, { DeletionProtectionCheck: value });
        expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(DeleteEnvironmentCommand);
        expect(inputOf(0)).toEqual({
          ApplicationId: 'app123',
          EnvironmentId: 'env456',
          DeletionProtectionCheck: value,
        });
      }
    );

    it('omits DeletionProtectionCheck when unset', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.delete('Env', ID, TYPE, { Name: 'x' });
      expect(inputOf(0)).toEqual({ ApplicationId: 'app123', EnvironmentId: 'env456' });
    });

    it('omits an unrecognised DeletionProtectionCheck value', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.delete('Env', ID, TYPE, { DeletionProtectionCheck: 'MAYBE' });
      expect(inputOf(0)).not.toHaveProperty('DeletionProtectionCheck');
    });

    it('treats an already-deleted environment as success', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' })
      );
      await expect(provider.delete('Env', ID, TYPE, {})).resolves.toBeUndefined();
    });

    it('wraps any other failure', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('boom'), { name: 'BadRequestException' })
      );
      await expect(provider.delete('Env', ID, TYPE, {})).rejects.toThrow(
        /Failed to delete AppConfig Environment Env/
      );
    });

    it('refuses a physical id that is not <appId>|<envId>', async () => {
      await expect(provider.delete('Env', 'nopipe', TYPE, {})).rejects.toThrow(/not "<Application/);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('create', () => {
    it('returns the Cloud Control compatible id and maps the properties', async () => {
      mockSend.mockResolvedValueOnce({ Id: 'env456' });
      const result = await provider.create('Env', TYPE, {
        ApplicationId: 'app123',
        Name: 'prod',
        Description: 'd',
        Monitors: [{ AlarmArn: 'arn:alarm', AlarmRoleArn: 'arn:role' }],
        Tags: [{ Key: 'k', Value: 'v' }],
        DeletionProtectionCheck: 'BYPASS',
      });
      expect(result).toEqual({ physicalId: ID, attributes: { EnvironmentId: 'env456' } });
      expect(inputOf(0)).toEqual({
        ApplicationId: 'app123',
        Name: 'prod',
        Description: 'd',
        Monitors: [{ AlarmArn: 'arn:alarm', AlarmRoleArn: 'arn:role' }],
        Tags: { k: 'v' },
      });
    });

    it('refuses a missing Name before any call', async () => {
      await expect(provider.create('Env', TYPE, { ApplicationId: 'app123' })).rejects.toThrow(
        /required/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('omits an empty Monitors list and sends a CreateEnvironmentCommand', async () => {
      mockSend.mockResolvedValueOnce({ Id: 'env456' });
      await provider.create('Env', TYPE, { ApplicationId: 'app123', Name: 'prod', Monitors: [] });
      expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(CreateEnvironmentCommand);
      expect(inputOf(0)).toEqual({ ApplicationId: 'app123', Name: 'prod' });
    });

    it('fails when CreateEnvironment returns no Id', async () => {
      mockSend.mockResolvedValueOnce({});
      await expect(
        provider.create('Env', TYPE, { ApplicationId: 'app123', Name: 'prod' })
      ).rejects.toThrow(/Failed to create AppConfig Environment Env/);
    });
  });

  describe('update', () => {
    it('updates in place and clears a removed Description and Monitors', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await provider.update(
        'Env',
        ID,
        TYPE,
        { ApplicationId: 'app123', Name: 'prod2' },
        {
          ApplicationId: 'app123',
          Name: 'prod',
          Description: 'old',
          Monitors: [{ AlarmArn: 'arn:alarm' }],
        }
      );
      expect(result.wasReplaced).toBe(false);
      expect(inputOf(0)).toEqual({
        ApplicationId: 'app123',
        EnvironmentId: 'env456',
        Name: 'prod2',
        Description: '',
        Monitors: [],
      });
    });

    it('makes no STS or tagging call when the tags did not change', async () => {
      mockSend.mockResolvedValue({});
      await provider.update(
        'Env',
        ID,
        TYPE,
        { Name: 'prod2', Tags: [{ Key: 'k', Value: 'v' }] },
        { Name: 'prod', Tags: [{ Key: 'k', Value: 'v' }] }
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockStsSend).not.toHaveBeenCalled();
    });

    it('applies the tag diff against the environment ARN', async () => {
      mockSend.mockResolvedValue({});
      mockStsSend.mockResolvedValueOnce({ Account: '111122223333' });
      await provider.update(
        'Env',
        ID,
        TYPE,
        { Name: 'prod', Tags: [{ Key: 'new', Value: '1' }] },
        { Name: 'prod', Tags: [{ Key: 'old', Value: '1' }] }
      );
      const arn = 'arn:aws:appconfig:us-east-1:111122223333:application/app123/environment/env456';
      expect(inputOf(1)).toEqual({ ResourceArn: arn, TagKeys: ['old'] });
      expect(inputOf(2)).toEqual({ ResourceArn: arn, Tags: { new: '1' } });
    });
  });
});

describe('AppConfigEnvironmentProvider wiring and failure handling', () => {
  let provider: AppConfigEnvironmentProvider;
  beforeEach(() => {
    mockSend.mockReset();
    provider = new AppConfigEnvironmentProvider();
  });

  it('is the provider registered for AWS::AppConfig::Environment', () => {
    const registry = new ProviderRegistry();
    registerAllProviders(registry, providerClasses);
    expect(registry.getProvider(TYPE)).toBeInstanceOf(AppConfigEnvironmentProvider);
  });

  it('handles every property the type documents, DeletionProtectionCheck included', () => {
    expect([...provider.handledProperties.get(TYPE)!].sort()).toEqual([
      'ApplicationId',
      'DeletionProtectionCheck',
      'Description',
      'Monitors',
      'Name',
      'Tags',
    ]);
  });

  it('reduces an SDK-authored AccessDenied to its class and the verbose pointer', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('User: arn:aws:sts::111122223333:assumed-role/r/s is denied'), {
        name: 'AccessDeniedException',
        $fault: 'client',
        $metadata: { httpStatusCode: 403 },
      })
    );
    const error = await provider.delete('Env', ID, TYPE, {}).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(VERBOSE_POINTER);
    expect((error as Error).message).not.toContain('assumed-role');
  });

  it('refuses a delete recorded in another region instead of reporting it deleted', async () => {
    mockSend.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { name: 'ResourceNotFoundException' })
    );
    await expect(
      provider.delete('Env', ID, TYPE, {}, { expectedRegion: 'eu-west-1' })
    ).rejects.toThrow(/eu-west-1/);
  });

  it('refuses an update recorded in another region before any call', async () => {
    await expect(
      provider.update('Env', ID, TYPE, { Name: 'a' }, { Name: 'a' }, { expectedRegion: 'eu-west-1' })
    ).rejects.toThrow(/eu-west-1/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('refuses malformed Tags before any call', async () => {
    await expect(
      provider.create('Env', TYPE, { ApplicationId: 'a', Name: 'n', Tags: 'nope' })
    ).rejects.toThrow(/Tags/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  describe('records written before the SDK provider existed (go-to-k/cdkd#6065 M1)', () => {
    // A destroy passes no properties, so only the unconditional 'cc-broken'
    // sticky exemption moves a `provisionedBy: 'cc-api'` Environment record to
    // the provider that forwards DeletionProtectionCheck. Deleting the table
    // entry sends these back to Cloud Control and fails this test.
    it('routes a cc-api record to the SDK provider on destroy', () => {
      const registry = new ProviderRegistry();
      registerAllProviders(registry, providerClasses);
      const decision = registry.getProviderFor({ resourceType: TYPE, provisionedBy: 'cc-api' });
      expect(decision.provisionedBy).toBe('sdk');
      expect(decision.provider).toBeInstanceOf(AppConfigEnvironmentProvider);
    });

    it('keeps the cc-api record on the SDK provider even when a pin is passed', () => {
      const registry = new ProviderRegistry();
      registerAllProviders(registry, providerClasses);
      const decision = registry.getProviderFor({
        resourceType: TYPE,
        provisionedBy: 'cc-api',
        forceCcApi: true,
      });
      expect(decision.provisionedBy).toBe('sdk');
    });
  });

  describe('import', () => {
    it('adopts an explicit <appId>|<envId> that exists', async () => {
      mockSend.mockResolvedValueOnce({});
      const result = await provider.import({
        logicalId: 'Env',
        resourceType: TYPE,
        stackName: 's',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: ID,
      });
      expect(result).toEqual({ physicalId: ID, attributes: { EnvironmentId: 'env456' } });
      expect(inputOf(0)).toEqual({ ApplicationId: 'app123', EnvironmentId: 'env456' });
    });

    it('rethrows an import failure that is not a not-found', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('denied'), {
          name: 'AccessDeniedException',
          $fault: 'client',
          $metadata: { httpStatusCode: 403 },
        })
      );
      await expect(
        provider.import({
          logicalId: 'Env',
          resourceType: TYPE,
          stackName: 's',
          region: 'us-east-1',
          properties: {},
          knownPhysicalId: ID,
        })
      ).rejects.toMatchObject({ name: 'AccessDeniedException' });
      expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(GetEnvironmentCommand);
    });

    it('returns null without an explicit id, or when the environment is gone', async () => {
      const base = {
        logicalId: 'Env',
        resourceType: TYPE,
        stackName: 's',
        region: 'us-east-1',
        properties: {},
      };
      expect(await provider.import(base)).toBeNull();
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('x'), { name: 'ResourceNotFoundException' })
      );
      expect(await provider.import({ ...base, knownPhysicalId: ID })).toBeNull();
    });
  });
});
