import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DBProxyNotFoundFault } from '@aws-sdk/client-rds';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('@aws-sdk/client-rds', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-rds')>('@aws-sdk/client-rds');
  return {
    ...actual,
    RDSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

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

import { RDSDBProxyProvider } from '../../../src/provisioning/providers/rds-dbproxy-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors/marks.js';
import { getLogger } from '../../../src/utils/logger.js';
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';

const RESOURCE_TYPE = 'AWS::RDS::DBProxy';
const PROXY_NAME = 'AuroraProxy';
const PROXY_ARN = 'arn:aws:rds:us-east-1:123456789012:db-proxy:prx-aaaa';
const PROXY_ENDPOINT = 'auroraproxy.proxy-abcdef.us-east-1.rds.amazonaws.com';
const ROLE_ARN = 'arn:aws:iam::123456789012:role/AuroraProxyRole';

describe('RDSDBProxyProvider', () => {
  let provider: RDSDBProxyProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new RDSDBProxyProvider();
  });

  describe('handledProperties', () => {
    it('declares the user-controllable property set', () => {
      const handled = provider.handledProperties.get(RESOURCE_TYPE);
      expect(handled).toBeDefined();
      expect(Array.from(handled!).sort()).toEqual([
        'Auth',
        'DBProxyName',
        'DebugLogging',
        'DefaultAuthScheme',
        'EndpointNetworkType',
        'EngineFamily',
        'IdleClientTimeout',
        'RequireTLS',
        'RoleArn',
        'Tags',
        'TargetConnectionNetworkType',
        'VpcSecurityGroupIds',
        'VpcSubnetIds',
      ]);
    });
  });

  describe('create', () => {
    const validProps = {
      DBProxyName: PROXY_NAME,
      EngineFamily: 'MYSQL',
      Auth: [{ AuthScheme: 'SECRETS', SecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:db' }],
      RoleArn: ROLE_ARN,
      VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
    };

    it('creates and polls until available', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxy: { DBProxyName: PROXY_NAME } }) // CreateDBProxy
        .mockResolvedValueOnce({
          DBProxies: [
            {
              DBProxyName: PROXY_NAME,
              DBProxyArn: PROXY_ARN,
              Endpoint: PROXY_ENDPOINT,
              VpcId: 'vpc-xxx',
              Status: 'available',
            },
          ],
        }); // DescribeDBProxies

      const result = await provider.create('Proxy', RESOURCE_TYPE, validProps);

      expect(result.physicalId).toBe(PROXY_NAME);
      expect(result.attributes).toEqual({
        DBProxyArn: PROXY_ARN,
        Endpoint: PROXY_ENDPOINT,
        VpcId: 'vpc-xxx',
      });
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('CreateDBProxyCommand');
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('DescribeDBProxiesCommand');
    });

    it('rejects on missing EngineFamily', async () => {
      await expect(
        provider.create('Proxy', RESOURCE_TYPE, { ...validProps, EngineFamily: undefined })
      ).rejects.toThrow(/EngineFamily is required/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects on missing Auth', async () => {
      await expect(
        provider.create('Proxy', RESOURCE_TYPE, { ...validProps, Auth: [] })
      ).rejects.toThrow(/Auth \(at least one entry\) is required/);
    });

    // go-to-k/cdkd#2762: the three properties reach CreateDBProxy.
    const availableDescribe = {
      DBProxies: [
        {
          DBProxyName: PROXY_NAME,
          DBProxyArn: PROXY_ARN,
          Endpoint: PROXY_ENDPOINT,
          VpcId: 'vpc-xxx',
          Status: 'available',
        },
      ],
    };

    it('sends DefaultAuthScheme / EndpointNetworkType / TargetConnectionNetworkType on CreateDBProxy', async () => {
      mockSend.mockResolvedValueOnce({ DBProxy: {} }).mockResolvedValueOnce(availableDescribe);
      await provider.create('Proxy', RESOURCE_TYPE, {
        ...validProps,
        DefaultAuthScheme: 'NONE',
        EndpointNetworkType: 'DUAL',
        TargetConnectionNetworkType: 'IPV6',
      });
      const input = mockSend.mock.calls[0]![0].input;
      expect(input.DefaultAuthScheme).toBe('NONE');
      expect(input.EndpointNetworkType).toBe('DUAL');
      expect(input.TargetConnectionNetworkType).toBe('IPV6');
    });

    it('sends none of the three when the template omits them', async () => {
      mockSend.mockResolvedValueOnce({ DBProxy: {} }).mockResolvedValueOnce(availableDescribe);
      await provider.create('Proxy', RESOURCE_TYPE, validProps);
      const input = mockSend.mock.calls[0]![0].input;
      expect(input.DefaultAuthScheme).toBeUndefined();
      expect(input.EndpointNetworkType).toBeUndefined();
      expect(input.TargetConnectionNetworkType).toBeUndefined();
    });

    // AWS requires Auth only while DefaultAuthScheme is NONE or unset, so a
    // proxy with IAM_AUTH and no Auth deploys, as on CloudFormation.
    it.each([
      ['absent', undefined],
      ['empty', []],
    ])(
      'creates a proxy with DefaultAuthScheme IAM_AUTH and Auth %s, sending no Auth',
      async (_label, auth) => {
        mockSend.mockResolvedValueOnce({ DBProxy: {} }).mockResolvedValueOnce(availableDescribe);
        await provider.create('Proxy', RESOURCE_TYPE, {
          ...validProps,
          Auth: auth,
          DefaultAuthScheme: 'IAM_AUTH',
        });
        const input = mockSend.mock.calls[0]![0].input;
        expect(input.DefaultAuthScheme).toBe('IAM_AUTH');
        expect(input.Auth).toBeUndefined();
      }
    );

    it('still refuses a missing Auth before any call while DefaultAuthScheme is NONE', async () => {
      await expect(
        provider.create('Proxy', RESOURCE_TYPE, {
          ...validProps,
          Auth: undefined,
          DefaultAuthScheme: 'NONE',
        })
      ).rejects.toThrow(/Auth \(at least one entry\) is required .* while DefaultAuthScheme is NONE or unset/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects on missing RoleArn', async () => {
      await expect(
        provider.create('Proxy', RESOURCE_TYPE, { ...validProps, RoleArn: undefined })
      ).rejects.toThrow(/RoleArn is required/);
    });

    it('rejects on missing VpcSubnetIds', async () => {
      await expect(
        provider.create('Proxy', RESOURCE_TYPE, { ...validProps, VpcSubnetIds: [] })
      ).rejects.toThrow(/VpcSubnetIds/);
    });

    it('throws terminal failure when DBProxyStatus reports incompatible-network', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxy: { DBProxyName: PROXY_NAME } })
        .mockResolvedValueOnce({
          DBProxies: [{ Status: 'incompatible-network' }],
        });

      await expect(provider.create('Proxy', RESOURCE_TYPE, validProps)).rejects.toThrow(
        /terminal failure state: incompatible-network/
      );
    });
  });

  describe('update', () => {
    it('is a no-op when nothing changed (tag-diff short-circuits Describe)', async () => {
      const props = {
        Auth: [{ AuthScheme: 'SECRETS', SecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:db' }],
        RoleArn: ROLE_ARN,
        Tags: [{ Key: 'k', Value: 'v' }],
      };
      const result = await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, props, props);
      expect(result.physicalId).toBe(PROXY_NAME);
      expect(result.wasReplaced).toBe(false);
      // PR #400 review M1 fix: tag-map equality short-circuit means
      // no Describe is needed for the ARN cache.
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects when EngineFamily differs (immutable)', async () => {
      await expect(
        provider.update(
          'Proxy',
          PROXY_NAME,
          RESOURCE_TYPE,
          { EngineFamily: 'POSTGRESQL' },
          { EngineFamily: 'MYSQL' }
        )
      ).rejects.toThrow(/EngineFamily is immutable/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('rejects when VpcSubnetIds differs (immutable)', async () => {
      await expect(
        provider.update(
          'Proxy',
          PROXY_NAME,
          RESOURCE_TYPE,
          { VpcSubnetIds: ['subnet-new'] },
          { VpcSubnetIds: ['subnet-old'] }
        )
      ).rejects.toThrow(/VpcSubnetIds is immutable/);
    });

    // go-to-k/cdkd#2762: create-only in the CFn schema, no ModifyDBProxy member.
    it.each([
      ['EndpointNetworkType', 'DUAL', 'IPV4'],
      ['TargetConnectionNetworkType', 'IPV6', 'IPV4'],
    ])('rejects when %s differs (immutable), before any call', async (field, next, prev) => {
      await expect(
        provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, { [field]: next }, { [field]: prev })
      ).rejects.toThrow(new RegExp(`${field} is immutable`));
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each(['EndpointNetworkType', 'TargetConnectionNetworkType'])(
      'classifies a %s change as a replacement',
      (field) => {
        const registry = new ReplacementRulesRegistry();
        expect(registry.isClassified(RESOURCE_TYPE, field)).toBe(true);
        expect(registry.requiresReplacement(RESOURCE_TYPE, field, 'IPV4', 'IPV6')).toBe(true);
      }
    );

    it('sends a DefaultAuthScheme change on ModifyDBProxy', async () => {
      mockSend.mockResolvedValueOnce({ DBProxy: {} });
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        { DefaultAuthScheme: 'IAM_AUTH' },
        { DefaultAuthScheme: 'NONE' }
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyCommand');
      expect(mockSend.mock.calls[0]![0].input.DefaultAuthScheme).toBe('IAM_AUTH');
    });

    it('issues ModifyDBProxy when RoleArn changes', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxy: {} }) // ModifyDBProxy
        .mockResolvedValueOnce({ DBProxies: [{ DBProxyArn: PROXY_ARN }] }); // Describe for tag-arn
      const newRole = 'arn:aws:iam::123456789012:role/NewRole';
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        { RoleArn: newRole },
        { RoleArn: ROLE_ARN }
      );
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyCommand');
      expect(mockSend.mock.calls[0]![0].input.RoleArn).toBe(newRole);
    });

    it('translates VpcSecurityGroupIds → SecurityGroups in the ModifyDBProxy call', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxy: {} })
        .mockResolvedValueOnce({ DBProxies: [{ DBProxyArn: PROXY_ARN }] });
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        { VpcSecurityGroupIds: ['sg-new'] },
        { VpcSecurityGroupIds: ['sg-old'] }
      );
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyCommand');
      expect(mockSend.mock.calls[0]![0].input.SecurityGroups).toEqual(['sg-new']);
      expect(mockSend.mock.calls[0]![0].input.VpcSecurityGroupIds).toBeUndefined();
    });

    it('diffs Tags via AddTags/RemoveTags', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxies: [{ DBProxyArn: PROXY_ARN }] }) // Describe for tag-arn lookup
        .mockResolvedValueOnce({}) // RemoveTags
        .mockResolvedValueOnce({}); // AddTags
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        {
          Tags: [
            { Key: 'keep', Value: 'v' },
            { Key: 'new', Value: 'v' },
          ],
        },
        {
          Tags: [
            { Key: 'keep', Value: 'v' },
            { Key: 'removed', Value: 'v' },
          ],
        }
      );
      // Sequence: Describe -> Remove -> Add
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('DescribeDBProxiesCommand');
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('RemoveTagsFromResourceCommand');
      expect(mockSend.mock.calls[1]![0].input.TagKeys).toEqual(['removed']);
      expect(mockSend.mock.calls[2]![0].constructor.name).toBe('AddTagsToResourceCommand');
      expect(mockSend.mock.calls[2]![0].input.Tags).toEqual([{ Key: 'new', Value: 'v' }]);
    });

    // PR #400 review M2: tag-diff edge case tests.
    it('Tags diff: value change with same key issues Add only', async () => {
      mockSend
        .mockResolvedValueOnce({ DBProxies: [{ DBProxyArn: PROXY_ARN }] })
        .mockResolvedValueOnce({});
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        { Tags: [{ Key: 'env', Value: 'prod' }] },
        { Tags: [{ Key: 'env', Value: 'dev' }] }
      );
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('AddTagsToResourceCommand');
      expect(mockSend.mock.calls[1]![0].input.Tags).toEqual([{ Key: 'env', Value: 'prod' }]);
    });

    it('Tags diff: undefined-to-[] is no-op short-circuits Describe', async () => {
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        { Tags: [] },
        { Tags: undefined }
      );
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  // Issue #1160: ModifyDBProxy keeps an omitted setting, and CloudFormation
  // keeps RequireTLS / IdleClientTimeout / DebugLogging / VpcSecurityGroupIds
  // too (CFn A/B), so their removal sends nothing and WARNS. CloudFormation
  // SENDS an Auth removal and AWS refuses it while DefaultAuthScheme is NONE
  // or unset, so cdkd refuses that one before any call.
  describe('update: a removed property is kept and warned about (#1160)', () => {
    const warn = vi.mocked(getLogger().child('RDSDBProxyProvider').warn);
    const base = {
      EngineFamily: 'MYSQL',
      RoleArn: ROLE_ARN,
      VpcSubnetIds: ['subnet-aaa'],
    };
    const optional = {
      Auth: [{ AuthScheme: 'SECRETS', SecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:db' }],
      RequireTLS: true,
      IdleClientTimeout: 600,
      DebugLogging: true,
      VpcSecurityGroupIds: ['sg-aaa'],
    };

    beforeEach(() => {
      warn.mockReset();
    });

    const { Auth, ...keptByCfn } = optional;
    const withAuth = { ...base, Auth };

    it('sends no ModifyDBProxy for removals alone and names every removed property once, saying CloudFormation keeps them too', async () => {
      await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, withAuth, {
        ...withAuth,
        ...keptByCfn,
      });
      expect(mockSend).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe(
        'Proxy (AWS::RDS::DBProxy): properties RequireTLS, IdleClientTimeout, DebugLogging, VpcSecurityGroupIds were removed from the template and keep their current AWS value, as CloudFormation leaves them; ModifyDBProxy keeps a setting it is not sent. Declare the property with the value you want to change it.'
      );
    });

    it('words a single removal in the singular', async () => {
      await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, withAuth, {
        ...withAuth,
        DebugLogging: true,
      });
      expect(warn.mock.calls[0]![0]).toBe(
        'Proxy (AWS::RDS::DBProxy): property DebugLogging was removed from the template and keeps its current AWS value, as CloudFormation leaves it; ModifyDBProxy keeps a setting it is not sent. Declare the property with the value you want to change it.'
      );
    });

    const authRefusal =
      "Proxy (AWS::RDS::DBProxy): Auth was removed from the template, but AWS requires Auth while DefaultAuthScheme is NONE or unset, and CloudFormation's update fails on the same change. Declare Auth again; nothing was changed.";

    for (const [label, scheme] of [
      ['unset', undefined],
      ['NONE', 'NONE'],
    ] as const) {
      it(`refuses an Auth removal before any call when DefaultAuthScheme is ${label}`, async () => {
        const desired = {
          ...base,
          DebugLogging: false,
          ...(scheme !== undefined && { DefaultAuthScheme: scheme }),
        };
        const error = await provider
          .update('Proxy', PROXY_NAME, RESOURCE_TYPE, desired, { ...withAuth, DebugLogging: true })
          .then(
            () => undefined,
            (e: unknown) => e
          );
        expect(error).toBeInstanceOf(ProvisioningError);
        expect((error as Error).message).toBe(authRefusal);
        // Terminal: a retry would refuse the same template again.
        expect(isMarkedNonRetryable(error)).toBe(true);
        expect(mockSend).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
      });
    }

    it("follows the caller's removed set over the presence test", async () => {
      // The set says Auth was removed although both sides still declare it:
      // only a set-driven read refuses.
      await expect(
        provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, withAuth, withAuth, {
          removedProperties: new Set(['Auth']),
        })
      ).rejects.toThrow(authRefusal);
      expect(mockSend).not.toHaveBeenCalled();

      // The set is empty although the desired side dropped Auth: only a
      // presence-driven read refuses.
      await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, base, withAuth, {
        removedProperties: new Set(),
      });
      expect(mockSend).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('keeps Auth and warns, claiming nothing about CloudFormation, when DefaultAuthScheme is set', async () => {
      // CloudFormation's removal would be accepted here; cdkd sends no Auth
      // reset, so the proxy keeps its live Auth and the update warns.
      const desired = { ...base, DefaultAuthScheme: 'IAM_AUTH' };
      await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, desired, {
        ...desired,
        Auth,
        DebugLogging: true,
      });
      expect(mockSend).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe(
        'Proxy (AWS::RDS::DBProxy): properties Auth, DebugLogging were removed from the template; ModifyDBProxy keeps a setting it is not sent, so the proxy keeps its current value. Declare the property with the value you want to change it.'
      );
    });

    // go-to-k/cdkd#2762: DefaultAuthScheme is mutable and retained on removal;
    // CloudFormation's behavior there is unmeasured, so no claim about it.
    it('keeps a removed DefaultAuthScheme without a call and warns, claiming nothing about CloudFormation', async () => {
      await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, withAuth, {
        ...withAuth,
        DefaultAuthScheme: 'IAM_AUTH',
      });
      expect(mockSend).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe(
        'Proxy (AWS::RDS::DBProxy): property DefaultAuthScheme was removed from the template; ModifyDBProxy keeps a setting it is not sent, so the proxy keeps its current value. Declare the property with the value you want to change it.'
      );
    });

    // A removed DefaultAuthScheme is not sent, so the proxy keeps IAM_AUTH and
    // AWS does not require Auth: removing both is kept and warned, not refused.
    it('keeps both when Auth and a previous IAM_AUTH DefaultAuthScheme are removed together', async () => {
      await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, base, {
        ...withAuth,
        DefaultAuthScheme: 'IAM_AUTH',
      });
      expect(mockSend).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe(
        'Proxy (AWS::RDS::DBProxy): properties Auth, DefaultAuthScheme were removed from the template; ModifyDBProxy keeps a setting it is not sent, so the proxy keeps its current value. Declare the property with the value you want to change it.'
      );
    });

    it('still refuses removing Auth together with a previous NONE DefaultAuthScheme', async () => {
      await expect(
        provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, base, {
          ...withAuth,
          DefaultAuthScheme: 'NONE',
        })
      ).rejects.toThrow(authRefusal);
      expect(mockSend).not.toHaveBeenCalled();
    });

    // go-to-k/cdkd#2762: IAM_AUTH -> NONE on a proxy the template gives no Auth.
    const noneRefusal =
      'Proxy (AWS::RDS::DBProxy): the update leaves the proxy with no Auth while DefaultAuthScheme is NONE or unset, and AWS requires Auth then. Declare Auth; nothing was changed.';

    it.each([
      ['absent', undefined],
      ['null', null],
      ['empty', []],
    ])(
      'refuses a switch to DefaultAuthScheme NONE before any call when Auth is %s',
      async (_label, auth) => {
        const error = await provider
          .update(
            'Proxy',
            PROXY_NAME,
            RESOURCE_TYPE,
            { ...base, DefaultAuthScheme: 'NONE', ...(auth !== undefined && { Auth: auth }) },
            { ...base, DefaultAuthScheme: 'IAM_AUTH' }
          )
          .then(
            () => undefined,
            (e: unknown) => e
          );
        expect(error).toBeInstanceOf(ProvisioningError);
        expect((error as Error).message).toBe(noneRefusal);
        expect(isMarkedNonRetryable(error)).toBe(true);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    // The kept scheme requires Auth, and the template changes Auth to empty.
    it.each([
      ['NONE', 'NONE'],
      ['unset', undefined],
    ])(
      'refuses a change to an empty Auth before any call while DefaultAuthScheme is %s',
      async (_label, scheme) => {
        const withScheme = scheme !== undefined ? { DefaultAuthScheme: scheme } : {};
        await expect(
          provider.update(
            'Proxy',
            PROXY_NAME,
            RESOURCE_TYPE,
            { ...base, ...withScheme, Auth: [] },
            { ...withAuth, ...withScheme }
          )
        ).rejects.toThrow(noneRefusal);
        expect(mockSend).not.toHaveBeenCalled();
      }
    );

    it('does not refuse an empty Auth that is unchanged, or one under IAM_AUTH', async () => {
      // Unchanged: nothing is sent, so nothing for AWS to refuse.
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        { ...base, DefaultAuthScheme: 'NONE', Auth: [] },
        { ...base, DefaultAuthScheme: 'NONE', Auth: [] }
      );
      expect(mockSend).not.toHaveBeenCalled();
      // IAM_AUTH does not require Auth.
      mockSend.mockResolvedValueOnce({ DBProxy: {} });
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        { ...base, DefaultAuthScheme: 'IAM_AUTH', Auth: [] },
        { ...withAuth, DefaultAuthScheme: 'IAM_AUTH' }
      );
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyCommand');
    });

    it('sends a switch to DefaultAuthScheme NONE that declares Auth', async () => {
      mockSend.mockResolvedValueOnce({ DBProxy: {} });
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        { ...withAuth, DefaultAuthScheme: 'NONE' },
        { ...base, DefaultAuthScheme: 'IAM_AUTH' }
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      const input = mockSend.mock.calls[0]![0].input;
      expect(input.DefaultAuthScheme).toBe('NONE');
      expect(input.Auth).toEqual(Auth);
    });

    it('does not refuse the switch to NONE on a rollback replay or drift --revert', async () => {
      for (const context of [{ replayingState: true }, { desiredFromAwsReadback: true }]) {
        mockSend.mockReset();
        mockSend.mockRejectedValueOnce(new Error('AWS refused'));
        await expect(
          provider.update(
            'Proxy',
            PROXY_NAME,
            RESOURCE_TYPE,
            { ...base, DefaultAuthScheme: 'NONE' },
            { ...base, DefaultAuthScheme: 'IAM_AUTH' },
            context
          )
        ).rejects.not.toThrow(noneRefusal);
        expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyCommand');
      }
    });

    it('does not refuse an Auth removal on a rollback replay, and words it as the state being restored', async () => {
      await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, base, withAuth, {
        removedProperties: new Set(['Auth']),
        replayingState: true,
      });
      expect(mockSend).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain(' property Auth is absent from the state being restored;');
    });

    it('keeps Auth without a refusal or a warning on drift --revert (the real caller passes an empty removed set)', async () => {
      await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, base, withAuth, {
        removedProperties: new Set(),
        desiredFromAwsReadback: true,
      });
      expect(mockSend).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it('does not refuse on drift --revert even if a removed set named Auth (defensive guard; no real caller passes this)', async () => {
      await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, base, withAuth, {
        removedProperties: new Set(['Auth']),
        desiredFromAwsReadback: true,
      });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('passes a kept change through and omits the removed field from the call', async () => {
      mockSend.mockResolvedValueOnce({ DBProxy: {} });
      const newRole = 'arn:aws:iam::123456789012:role/NewRole';
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        { ...base, RoleArn: newRole, RequireTLS: false },
        { ...base, RequireTLS: true, IdleClientTimeout: 600 }
      );
      expect(mockSend).toHaveBeenCalledTimes(1);
      const input = mockSend.mock.calls[0]![0].input;
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyCommand');
      expect(input).toEqual({ DBProxyName: PROXY_NAME, RoleArn: newRole, RequireTLS: false });
      expect(Object.hasOwn(input, 'IdleClientTimeout')).toBe(false);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain(' property IdleClientTimeout was removed ');
    });

    it('warns only once the update succeeded, so a retried or failed update prints nothing', async () => {
      mockSend.mockRejectedValueOnce(new Error('ThrottlingException'));
      await expect(
        provider.update(
          'Proxy',
          PROXY_NAME,
          RESOURCE_TYPE,
          { ...base, RoleArn: 'arn:aws:iam::123456789012:role/NewRole' },
          { ...base, DebugLogging: true }
        )
      ).rejects.toThrow();
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyCommand');
      expect(warn).not.toHaveBeenCalled();
    });

    it('warns about nothing for a property neither side declared', async () => {
      await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, base, base);
      expect(mockSend).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });

    it("reads the caller's removed set, which is empty on drift --revert", async () => {
      // A readback previous side carries every setting the template never did.
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        base,
        { ...base, ...optional },
        { removedProperties: new Set(), desiredFromAwsReadback: true }
      );
      expect(mockSend).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();

      await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, base, { ...base, ...optional }, {
        removedProperties: new Set(['DebugLogging', 'Tags']),
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toContain(' property DebugLogging was removed ');
    });

    it('words a rollback revert as the state being restored', async () => {
      await provider.update(
        'Proxy',
        PROXY_NAME,
        RESOURCE_TYPE,
        base,
        { ...base, DebugLogging: true },
        { removedProperties: new Set(['DebugLogging']), replayingState: true }
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toBe(
        'Proxy (AWS::RDS::DBProxy): property DebugLogging is absent from the state being restored; ModifyDBProxy keeps a setting it is not sent, so the rollback leaves any value the failed deploy applied in place.'
      );
    });

    it('leaves the shared caller with nothing to warn about, so the line is never printed twice', () => {
      // The provider declares neither removalDefaults nor removalHandledInUpdate
      // (whose shared line would claim CloudFormation resets the value), so the
      // caller's own removal warning stays silent and this provider's is the only one.
      expect(
        prepareRemovalForUpdate(provider, RESOURCE_TYPE, base, { ...base, DebugLogging: true })
          .unhandled
      ).toEqual([]);
    });
  });

  describe('drift --revert round-trip', () => {
    it('identical readCurrentState shape on both sides → no SDK call', async () => {
      const observed = {
        DBProxyName: PROXY_NAME,
        EngineFamily: 'MYSQL',
        RoleArn: ROLE_ARN,
        VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
        VpcSecurityGroupIds: ['sg-aaa'],
        RequireTLS: true,
        IdleClientTimeout: 1800,
        DebugLogging: false,
        Auth: [
          {
            Description: undefined,
            UserName: undefined,
            AuthScheme: 'SECRETS',
            SecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:db',
            IAMAuth: 'DISABLED',
            ClientPasswordAuthType: undefined,
          },
        ],
        Tags: [{ Key: 'env', Value: 'prod' }],
      };
      const result = await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, observed, observed);
      expect(result.physicalId).toBe(PROXY_NAME);
      expect(result.wasReplaced).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('drift on RoleArn round-trips: ModifyDBProxy with the desired value', async () => {
      const observed = {
        EngineFamily: 'MYSQL',
        RoleArn: ROLE_ARN,
        VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
        Auth: [{ AuthScheme: 'SECRETS', SecretArn: 'arn:...' }],
      };
      const awsCurrent = { ...observed, RoleArn: 'arn:aws:iam::123456789012:role/Hijacked' };
      mockSend.mockResolvedValueOnce({ DBProxy: {} });
      await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, observed, awsCurrent);
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('ModifyDBProxyCommand');
      expect(mockSend.mock.calls[0]![0].input.RoleArn).toBe(ROLE_ARN);
    });

    it('drift on Tags round-trips: AddTags with desired tag', async () => {
      const observed = {
        EngineFamily: 'MYSQL',
        RoleArn: ROLE_ARN,
        VpcSubnetIds: ['subnet-aaa'],
        Auth: [{ AuthScheme: 'SECRETS', SecretArn: 'arn:...' }],
        Tags: [{ Key: 'env', Value: 'prod' }],
      };
      const awsCurrent = { ...observed, Tags: [{ Key: 'env', Value: 'hijacked' }] };
      mockSend
        .mockResolvedValueOnce({ DBProxies: [{ DBProxyArn: PROXY_ARN }] })
        .mockResolvedValueOnce({});
      await provider.update('Proxy', PROXY_NAME, RESOURCE_TYPE, observed, awsCurrent);
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('AddTagsToResourceCommand');
      expect(mockSend.mock.calls[1]![0].input.Tags).toEqual([{ Key: 'env', Value: 'prod' }]);
    });
  });

  describe('delete', () => {
    it('issues DeleteDBProxy and waits for full removal', async () => {
      mockSend
        .mockResolvedValueOnce({}) // DeleteDBProxy
        .mockRejectedValueOnce(
          new DBProxyNotFoundFault({ message: 'gone', $metadata: {} })
        ); // Describe (post-delete poll)

      await provider.delete('Proxy', PROXY_NAME, RESOURCE_TYPE, undefined, {
        expectedRegion: 'us-east-1',
      });

      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(mockSend.mock.calls[0]![0].constructor.name).toBe('DeleteDBProxyCommand');
      expect(mockSend.mock.calls[1]![0].constructor.name).toBe('DescribeDBProxiesCommand');
    });

    it('treats DBProxyNotFoundFault on DeleteDBProxy as idempotent (region matches)', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyNotFoundFault({ message: 'gone', $metadata: {} })
      );

      await expect(
        provider.delete('Proxy', PROXY_NAME, RESOURCE_TYPE, undefined, {
          expectedRegion: 'us-east-1',
        })
      ).resolves.not.toThrow();
    });

    it('rejects DELETE on region mismatch', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyNotFoundFault({ message: 'gone', $metadata: {} })
      );

      await expect(
        provider.delete('Proxy', PROXY_NAME, RESOURCE_TYPE, undefined, {
          expectedRegion: 'us-west-2', // client region is us-east-1
        })
      ).rejects.toThrow(ProvisioningError);
    });
  });

  describe('getAttribute', () => {
    it('returns Endpoint from DescribeDBProxies', async () => {
      mockSend.mockResolvedValueOnce({
        DBProxies: [
          { DBProxyArn: PROXY_ARN, Endpoint: PROXY_ENDPOINT, VpcId: 'vpc-xxx' },
        ],
      });

      const result = await provider.getAttribute(PROXY_NAME, RESOURCE_TYPE, 'Endpoint');
      expect(result).toBe(PROXY_ENDPOINT);
    });

    it('returns DBProxyArn', async () => {
      mockSend.mockResolvedValueOnce({
        DBProxies: [{ DBProxyArn: PROXY_ARN, Endpoint: PROXY_ENDPOINT }],
      });
      const result = await provider.getAttribute(PROXY_NAME, RESOURCE_TYPE, 'DBProxyArn');
      expect(result).toBe(PROXY_ARN);
    });

    it('caches per (physicalId, attribute)', async () => {
      mockSend.mockResolvedValueOnce({
        DBProxies: [{ DBProxyArn: PROXY_ARN, Endpoint: PROXY_ENDPOINT }],
      });
      await provider.getAttribute(PROXY_NAME, RESOURCE_TYPE, 'Endpoint');
      // Second call: cache hit, no SDK call.
      const result = await provider.getAttribute(PROXY_NAME, RESOURCE_TYPE, 'Endpoint');
      expect(result).toBe(PROXY_ENDPOINT);
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('returns undefined for unknown attribute', async () => {
      const result = await provider.getAttribute(PROXY_NAME, RESOURCE_TYPE, 'Unknown');
      expect(result).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('returns undefined when proxy is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyNotFoundFault({ message: 'gone', $metadata: {} })
      );
      const result = await provider.getAttribute(PROXY_NAME, RESOURCE_TYPE, 'Endpoint');
      expect(result).toBeUndefined();
    });
  });

  describe('readCurrentState', () => {
    it('reverse-maps DescribeDBProxies to CFn property shape', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBProxies: [
            {
              DBProxyName: PROXY_NAME,
              DBProxyArn: PROXY_ARN,
              EngineFamily: 'MYSQL',
              RoleArn: ROLE_ARN,
              VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
              VpcSecurityGroupIds: ['sg-aaa'],
              RequireTLS: true,
              IdleClientTimeout: 1800,
              DebugLogging: false,
              Auth: [
                {
                  AuthScheme: 'SECRETS',
                  SecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:db',
                  IAMAuth: 'DISABLED',
                },
              ],
            },
          ],
        })
        .mockResolvedValueOnce({ TagList: [{ Key: 'env', Value: 'prod' }] }); // ListTagsForResource

      const result = await provider.readCurrentState(PROXY_NAME);
      expect(result).toMatchObject({
        DBProxyName: PROXY_NAME,
        EngineFamily: 'MYSQL',
        RoleArn: ROLE_ARN,
        VpcSubnetIds: ['subnet-aaa', 'subnet-bbb'],
        VpcSecurityGroupIds: ['sg-aaa'],
        RequireTLS: true,
        IdleClientTimeout: 1800,
        DebugLogging: false,
        Tags: [{ Key: 'env', Value: 'prod' }],
      });
      expect((result as Record<string, unknown> | undefined)?.['Auth']).toEqual([
        {
          Description: undefined,
          UserName: undefined,
          AuthScheme: 'SECRETS',
          SecretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:db',
          IAMAuth: 'DISABLED',
          ClientPasswordAuthType: undefined,
        },
      ]);
      // No value AWS did not report is invented for the #2762 properties.
      expect(result).not.toHaveProperty('DefaultAuthScheme');
      expect(result).not.toHaveProperty('EndpointNetworkType');
      expect(result).not.toHaveProperty('TargetConnectionNetworkType');
    });

    it('reads DefaultAuthScheme / EndpointNetworkType / TargetConnectionNetworkType back (go-to-k/cdkd#2762)', async () => {
      mockSend
        .mockResolvedValueOnce({
          DBProxies: [
            {
              DBProxyName: PROXY_NAME,
              DBProxyArn: PROXY_ARN,
              DefaultAuthScheme: 'IAM_AUTH',
              EndpointNetworkType: 'DUAL',
              TargetConnectionNetworkType: 'IPV6',
            },
          ],
        })
        .mockResolvedValueOnce({ TagList: [] });

      const result = await provider.readCurrentState(PROXY_NAME);
      expect(result).toMatchObject({
        DefaultAuthScheme: 'IAM_AUTH',
        EndpointNetworkType: 'DUAL',
        TargetConnectionNetworkType: 'IPV6',
      });
    });

    it('returns RESOURCE_NOT_FOUND when proxy is gone', async () => {
      mockSend.mockRejectedValueOnce(
        new DBProxyNotFoundFault({ message: 'gone', $metadata: {} })
      );
      const result = await provider.readCurrentState(PROXY_NAME);
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });

    it('returns RESOURCE_NOT_FOUND when DescribeDBProxies lists no proxy', async () => {
      mockSend.mockResolvedValueOnce({ DBProxies: [] });
      const result = await provider.readCurrentState(PROXY_NAME);
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });
  });

  describe('import (explicit override + auto-lookup)', () => {
    it('returns the override when knownPhysicalId is supplied', async () => {
      mockSend.mockResolvedValueOnce({
        DBProxies: [{ DBProxyArn: PROXY_ARN, Endpoint: PROXY_ENDPOINT, VpcId: 'vpc-xxx' }],
      });
      const result = await provider.import({
        logicalId: 'Proxy',
        resourceType: RESOURCE_TYPE,
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
        knownPhysicalId: PROXY_NAME,
      });

      expect(result).toMatchObject({
        physicalId: PROXY_NAME,
        attributes: {
          DBProxyArn: PROXY_ARN,
          Endpoint: PROXY_ENDPOINT,
          VpcId: 'vpc-xxx',
        },
      });
    });

    // Issue #1134: the `aws:cdk:path` tag walk was removed. AWS rejects
    // `aws:`-prefixed tag writes, so that tag never exists on a real proxy
    // and the walk could never match. Without an explicit override or a
    // template `DBProxyName`, import returns null without any AWS call.
    it('returns null without listing when no explicit id or DBProxyName is available', async () => {
      const result = await provider.import({
        logicalId: 'Proxy',
        resourceType: RESOURCE_TYPE,
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {},
      } as never);

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('resolves from the template DBProxyName property', async () => {
      mockSend.mockResolvedValueOnce({
        DBProxies: [{ DBProxyArn: PROXY_ARN, Endpoint: PROXY_ENDPOINT, VpcId: 'vpc-xxx' }],
      });

      const result = await provider.import({
        logicalId: 'Proxy',
        resourceType: RESOURCE_TYPE,
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: { DBProxyName: PROXY_NAME },
      } as never);

      expect(result).toMatchObject({ physicalId: PROXY_NAME });
    });
  });
});
