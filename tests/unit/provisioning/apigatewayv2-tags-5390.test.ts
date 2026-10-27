import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateApiCommand,
  CreateStageCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateApiCommand,
  UpdateStageCommand,
} from '@aws-sdk/client-apigatewayv2';

const mockSend = vi.fn();
let clientRegion = 'us-east-1';
const warn = vi.fn();

vi.mock('@aws-sdk/client-apigatewayv2', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    ApiGatewayV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve(clientRegion) },
    })),
  };
});

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

import { ApiGatewayV2Provider } from '../../../src/provisioning/providers/apigatewayv2-provider.js';

const API_TYPE = 'AWS::ApiGatewayV2::Api';
const STAGE_TYPE = 'AWS::ApiGatewayV2::Stage';
const API_ID = 'abcd1234';
const API_ARN = `arn:aws:apigateway:us-east-1::/apis/${API_ID}`;
const STAGE_ARN = `arn:aws:apigateway:us-east-1::/apis/${API_ID}/stages/prod`;

function sent<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map((c) => c[0]).filter((cmd): cmd is T => cmd instanceof ctor);
}

function tagCalls(): Array<{ op: string; input: Record<string, unknown> }> {
  return mockSend.mock.calls
    .map((c) => c[0])
    .filter((cmd) => cmd instanceof TagResourceCommand || cmd instanceof UntagResourceCommand)
    .map((cmd) => ({
      op: cmd instanceof TagResourceCommand ? 'tag' : 'untag',
      input: (cmd as unknown as { input: Record<string, unknown> }).input,
    }));
}

/**
 * go-to-k/cdkd#5390. `AWS::ApiGatewayV2::Api.Tags` and `::Stage.Tags` are a
 * key -> value MAP (aws-cdk-lib emits `TagType.MAP`). The create path read only
 * a `{Key,Value}[]` list, so every CloudFormation-shaped template created an
 * untagged API / stage, and the update path never tagged or untagged at all.
 */
describe('ApiGatewayV2 Api / Stage Tags (#5390)', () => {
  let provider: ApiGatewayV2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
    clientRegion = 'us-east-1';
    provider = new ApiGatewayV2Provider();
  });

  describe('create', () => {
    it('sends a map-shaped Api Tags on CreateApi, aws: keys dropped', async () => {
      mockSend.mockResolvedValueOnce({ ApiId: API_ID, ApiEndpoint: 'https://x' });
      mockSend.mockResolvedValue({});

      await provider.create('Api', API_TYPE, {
        Name: 'n',
        ProtocolType: 'HTTP',
        Tags: { k1: 'v1', k2: 'v2', 'aws:cdk:path': 'S/Api' },
      });

      expect(sent(CreateApiCommand)[0]!.input.Tags).toEqual({ k1: 'v1', k2: 'v2' });
    });

    it('still accepts a hand-authored {Key,Value} list on CreateApi', async () => {
      mockSend.mockResolvedValueOnce({ ApiId: API_ID, ApiEndpoint: 'https://x' });
      mockSend.mockResolvedValue({});

      await provider.create('Api', API_TYPE, {
        Name: 'n',
        ProtocolType: 'HTTP',
        Tags: [{ Key: 'k1', Value: 'v1' }],
      });

      expect(sent(CreateApiCommand)[0]!.input.Tags).toEqual({ k1: 'v1' });
    });

    it('sends no Tags member when the template declares none', async () => {
      mockSend.mockResolvedValueOnce({ ApiId: API_ID, ApiEndpoint: 'https://x' });
      mockSend.mockResolvedValue({});

      await provider.create('Api', API_TYPE, { Name: 'n', ProtocolType: 'HTTP' });

      expect(sent(CreateApiCommand)[0]!.input.Tags).toBeUndefined();
    });

    it('sends a map-shaped Stage Tags on CreateStage', async () => {
      mockSend.mockResolvedValue({});

      await provider.create('Stage', STAGE_TYPE, {
        ApiId: API_ID,
        StageName: 'prod',
        Tags: { k1: 'v1', k2: 'v2' },
      });

      expect(sent(CreateStageCommand)[0]!.input.Tags).toEqual({ k1: 'v1', k2: 'v2' });
    });

    it.each([
      ['a string', 'k1=v1'],
      ['a map with a non-scalar value', { k1: { nested: 'v' } }],
    ])('refuses %s as Tags before any call', async (_label, tags) => {
      await expect(
        provider.create('Stage', STAGE_TYPE, { ApiId: API_ID, StageName: 'prod', Tags: tags })
      ).rejects.toThrow(/Tags of AWS::ApiGatewayV2::Stage Stage is not a map/);
      await expect(
        provider.create('Api', API_TYPE, { Name: 'n', ProtocolType: 'HTTP', Tags: tags })
      ).rejects.toThrow(/Tags of AWS::ApiGatewayV2::Api Api is not a map/);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('update (Api)', () => {
    const base = { Name: 'n', ProtocolType: 'HTTP' };

    it('a tags-only add tags the API by its ARN and sends no UpdateApi', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'Api',
        API_ID,
        API_TYPE,
        { ...base, Tags: { k1: 'v1', k2: 'v2' } },
        { ...base }
      );

      expect(sent(UpdateApiCommand)).toHaveLength(0);
      expect(tagCalls()).toEqual([
        { op: 'tag', input: { ResourceArn: API_ARN, Tags: { k1: 'v1', k2: 'v2' } } },
      ]);
    });

    it('a changed value is re-tagged and a dropped key is untagged; unchanged keys are not sent', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'Api',
        API_ID,
        API_TYPE,
        { ...base, Tags: { k1: 'v1x', k3: 'same' } },
        { ...base, Tags: { k1: 'v1', k2: 'v2', k3: 'same' } }
      );

      expect(tagCalls()).toEqual([
        { op: 'untag', input: { ResourceArn: API_ARN, TagKeys: ['k2'] } },
        { op: 'tag', input: { ResourceArn: API_ARN, Tags: { k1: 'v1x' } } },
      ]);
    });

    it('removing the whole Tags block untags every recorded key', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'Api',
        API_ID,
        API_TYPE,
        { ...base },
        { ...base, Tags: { k1: 'v1', k2: 'v2' } }
      );

      expect(tagCalls()).toEqual([
        { op: 'untag', input: { ResourceArn: API_ARN, TagKeys: ['k1', 'k2'] } },
      ]);
    });

    it('tags beside an UpdateApi when another member changed too', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'Api',
        API_ID,
        API_TYPE,
        { ...base, Description: 'd2', Tags: { k1: 'v1' } },
        { ...base, Description: 'd1' }
      );

      expect(sent(UpdateApiCommand)).toHaveLength(1);
      expect(tagCalls()).toEqual([
        { op: 'tag', input: { ResourceArn: API_ARN, Tags: { k1: 'v1' } } },
      ]);
    });

    it('sends no tag call when Tags is unchanged', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'Api',
        API_ID,
        API_TYPE,
        { ...base, Description: 'd2', Tags: { k1: 'v1' } },
        { ...base, Description: 'd1', Tags: { k1: 'v1' } }
      );

      expect(sent(UpdateApiCommand)).toHaveLength(1);
      expect(tagCalls()).toEqual([]);
    });

    it('builds the ARN in the client region partition', async () => {
      clientRegion = 'cn-north-1';
      mockSend.mockResolvedValue({});

      await provider.update('Api', API_ID, API_TYPE, { ...base, Tags: { k1: 'v1' } }, { ...base });

      expect(tagCalls()[0]!.input.ResourceArn).toBe(
        `arn:aws-cn:apigateway:cn-north-1::/apis/${API_ID}`
      );
    });

    it('refuses a malformed desired Tags before any call', async () => {
      await expect(
        provider.update('Api', API_ID, API_TYPE, { ...base, Tags: 'k1' }, { ...base })
      ).rejects.toThrow(/desired Tags of AWS::ApiGatewayV2::Api Api is not a map/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('an unreadable recorded Tags untags nothing, applies the desired tags and warns', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'Api',
        API_ID,
        API_TYPE,
        { ...base, Tags: { k1: 'v1' } },
        { ...base, Tags: 'garbage' }
      );

      expect(tagCalls()).toEqual([
        { op: 'tag', input: { ResourceArn: API_ARN, Tags: { k1: 'v1' } } },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/recorded Tags .* removed no tag/));
    });

    it('counts only the tags it sends in the unreadable-record warning (no aws: key)', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'Api',
        API_ID,
        API_TYPE,
        { ...base, Tags: { k1: 'v1', 'aws:cdk:path': 'S/Api' } },
        { ...base, Tags: 'garbage' }
      );

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('applied the 1 desired tag(s)'));
    });
  });

  describe('update (Stage)', () => {
    const base = { ApiId: API_ID, StageName: 'prod' };

    it('a tags-only change tags and untags the stage by its ARN and sends no UpdateStage', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'Stage',
        'prod',
        STAGE_TYPE,
        { ...base, Tags: { k1: 'v1x' } },
        { ...base, Tags: { k1: 'v1', k2: 'v2' } }
      );

      expect(sent(UpdateStageCommand)).toHaveLength(0);
      expect(tagCalls()).toEqual([
        { op: 'untag', input: { ResourceArn: STAGE_ARN, TagKeys: ['k2'] } },
        { op: 'tag', input: { ResourceArn: STAGE_ARN, Tags: { k1: 'v1x' } } },
      ]);
    });

    it('removing the whole Tags block untags every recorded key', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'Stage',
        'prod',
        STAGE_TYPE,
        { ...base },
        { ...base, Tags: { k1: 'v1', k2: 'v2' } }
      );

      expect(tagCalls()).toEqual([
        { op: 'untag', input: { ResourceArn: STAGE_ARN, TagKeys: ['k1', 'k2'] } },
      ]);
    });

    it('tags after UpdateStage when another member changed too', async () => {
      mockSend.mockResolvedValue({});

      await provider.update(
        'Stage',
        'prod',
        STAGE_TYPE,
        { ...base, Description: 'd2', Tags: { k1: 'v1' } },
        { ...base, Description: 'd1' }
      );

      const ops = mockSend.mock.calls.map((c) => (c[0] as object).constructor);
      expect(ops).toEqual([UpdateStageCommand, TagResourceCommand]);
      expect(tagCalls()[0]!.input).toEqual({ ResourceArn: STAGE_ARN, Tags: { k1: 'v1' } });
    });

    it('refuses a malformed desired Tags before any call', async () => {
      await expect(
        provider.update(
          'Stage',
          'prod',
          STAGE_TYPE,
          { ...base, Description: 'd2', Tags: { k1: ['v'] } },
          { ...base, Description: 'd1' }
        )
      ).rejects.toThrow(/desired Tags of AWS::ApiGatewayV2::Stage Stage is not a map/);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('drift baseline written before #5390 (canonicalizeDriftPair)', () => {
    const aws = { Name: 'n', Tags: {} };

    it('completes a legacy list-shaped Api baseline with the declared tags, so the missing tags drift', async () => {
      const baseline = { Name: 'n', Tags: [] };
      const out = await provider.canonicalizeDriftPair(API_TYPE, baseline, aws, {
        Name: 'n',
        Tags: { k1: 'v1', k2: 'v2' },
      });
      expect(out.baseline).toEqual({ Name: 'n', Tags: { k1: 'v1', k2: 'v2' } });
      expect(out.aws).toBe(aws);
    });

    it('re-shapes a legacy Api list when the template declares no Tags', async () => {
      const out = await provider.canonicalizeDriftPair(
        API_TYPE,
        { Name: 'n', Tags: [{ Key: 'k1', Value: 'v1' }] },
        aws,
        { Name: 'n' }
      );
      expect(out.baseline['Tags']).toEqual({ k1: 'v1' });
    });

    it('completes a Stage baseline with no Tags when the template declares them', async () => {
      const baseline = { ApiId: API_ID, StageName: 'prod' };
      const out = await provider.canonicalizeDriftPair(STAGE_TYPE, baseline, { Tags: {} }, {
        ApiId: API_ID,
        StageName: 'prod',
        Tags: { k1: 'v1' },
      });
      expect(out.baseline).toEqual({ ...baseline, Tags: { k1: 'v1' } });
    });

    it('normalizes a hand-written {Key,Value} Stage list on the properties baseline to the map', async () => {
      const tags = [{ Key: 'k1', Value: 'v1' }];
      const baseline = { ApiId: API_ID, StageName: 'prod', Tags: tags };
      const out = await provider.canonicalizeDriftPair(STAGE_TYPE, baseline, { Tags: { k1: 'v1' } }, {
        ApiId: API_ID,
        StageName: 'prod',
        Tags: tags,
      });
      expect(out.baseline).toEqual({ ...baseline, Tags: { k1: 'v1' } });
    });

    it.each([
      [
        'a Stage list baseline whose value embeds a dynamic reference',
        STAGE_TYPE,
        { Tags: [{ Key: 'k1', Value: 'x-{{resolve:ssm:/p}}-y' }] },
        { Tags: [{ Key: 'k1', Value: 'x-{{resolve:ssm:/p}}-y' }] },
      ],
      [
        'a legacy Api baseline whose declared value embeds a dynamic reference',
        API_TYPE,
        { Tags: [] },
        { Tags: { k1: 'x-{{resolve:ssm:/p}}-y' } },
      ],
      [
        'a legacy Api baseline whose declared key embeds a dynamic reference',
        API_TYPE,
        { Tags: [] },
        { Tags: { 'x-{{resolve:ssm:/p}}-y': 'v' } },
      ],
      ['a current map-shaped Api baseline', API_TYPE, { Tags: { k1: 'v1' } }, { Tags: { k1: 'v1' } }],
      ['a Stage whose template declares no Tags', STAGE_TYPE, { StageName: 'prod' }, { StageName: 'prod' }],
      ['a Stage baseline that already holds Tags', STAGE_TYPE, { Tags: {} }, { Tags: { k1: 'v1' } }],
      ['another type', 'AWS::ApiGatewayV2::Route', { Tags: [] }, { Tags: { k1: 'v1' } }],
      [
        'a legacy Stage baseline whose declared VALUE is a dynamic reference',
        STAGE_TYPE,
        { StageName: 'prod' },
        { Tags: { Env: '{{resolve:secretsmanager:s:SecretString:k}}', Team: 'x' } },
      ],
      [
        'a legacy Api baseline whose declared value is the mask',
        API_TYPE,
        { Tags: [] },
        { Tags: { Env: '***' } },
      ],
      [
        'a legacy baseline whose declared key is a dynamic reference',
        API_TYPE,
        { Tags: [] },
        { Tags: { '{{resolve:secretsmanager:s:SecretString:k}}': 'v' } },
      ],
    ])('leaves %s untouched (identity)', async (_label, type, baseline, properties) => {
      const out = await provider.canonicalizeDriftPair(type, baseline, aws, properties);
      expect(out.baseline).toBe(baseline);
      expect(out.aws).toBe(aws);
    });
  });
});
