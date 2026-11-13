/**
 * go-to-k/cdkd#6139: `AWS::ApiGateway::RestApi` on the API Gateway SDK
 * provider. The update and removal semantics pinned here were measured
 * against CloudFormation's own handler (CFn A/B, us-east-1): no property is
 * create-only; a removed Description / MinimumCompressionSize /
 * ApiKeySourceType / DisableExecuteApiEndpoint / Policy is left live; a
 * removed BinaryMediaTypes is cleared; a removed EndpointConfiguration resets
 * the type to EDGE; a changed Body is put in `overwrite` mode unless `Mode`
 * says otherwise; a removed Body changes nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, mockS3Send, sentVia, warnSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockS3Send: vi.fn(),
  warnSpy: vi.fn(),
  sentVia: [] as Array<[string, 'shared' | 'create']>,
}));

vi.mock('../../../src/utils/aws-clients.js', () => {
  const config = { region: () => Promise.resolve('us-east-1') };
  return {
    getAwsClients: () => ({
      apiGateway: {
        config,
        send: (command: { constructor: { name: string } }) => {
          sentVia.push([command.constructor.name, 'shared']);
          return mockSend(command);
        },
      },
      s3: { send: (command: unknown) => mockS3Send(command) },
    }),
  };
});

vi.mock('@aws-sdk/client-api-gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-api-gateway')>();
  return {
    ...actual,
    APIGatewayClient: vi.fn().mockImplementation((options: { region?: unknown }) => ({
      config: {
        region: () => Promise.resolve(options.region),
        retryStrategy: async (): Promise<unknown> => ({
          acquireInitialRetryToken: async () => 'token',
          refreshRetryTokenForRetry: async () => 'retry-token',
          recordSuccess: () => undefined,
        }),
      },
      send: (command: { constructor: { name: string } }) => {
        sentVia.push([command.constructor.name, 'create']);
        return mockSend(command);
      },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { NotFoundException } from '@aws-sdk/client-api-gateway';
import {
  ApiGatewayProvider,
  resetApiGatewayCreateRetryStateForTests,
} from '../../../src/provisioning/providers/apigateway-provider.js';
import { isMarkedNotGone } from '../../../src/provisioning/not-gone.js';
import { restApiPatchOperations } from '../../../src/provisioning/providers/apigateway/rest-api.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { StackState } from '../../../src/types/state.js';

const TYPE = 'AWS::ApiGateway::RestApi';

type Sent = { constructor: { name: string }; input: Record<string, unknown> };
const sent = (name: string): Sent[] =>
  mockSend.mock.calls.map((c) => c[0] as Sent).filter((c) => c.constructor.name === name);
const names = (): string[] => mockSend.mock.calls.map((c) => (c[0] as Sent).constructor.name);

const notFound = (): Error =>
  new NotFoundException({ message: 'Invalid API identifier specified', $metadata: {} });

describe('ApiGatewayProvider: AWS::ApiGateway::RestApi (#6139)', () => {
  let provider: ApiGatewayProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    sentVia.length = 0;
    resetApiGatewayCreateRetryStateForTests();
    provider = new ApiGatewayProvider();
    mockSend.mockImplementation((command: Sent) => {
      switch (command.constructor.name) {
        case 'CreateRestApiCommand':
          return Promise.resolve({ id: 'api123', rootResourceId: 'root1', name: 'FromSpec' });
        case 'ImportRestApiCommand':
          // The import answers the endpoint type its parameter asked for.
          return Promise.resolve({
            id: 'api123',
            rootResourceId: 'root1',
            name: 'FromSpec',
            endpointConfiguration: {
              types: [
                ((command.input['parameters'] as Record<string, string> | undefined)?.[
                  'endpointConfigurationTypes'
                ] ?? 'EDGE') as string,
              ],
            },
          });
        case 'PutRestApiCommand':
          return Promise.resolve({ id: 'api123', rootResourceId: 'root1', name: 'SpecTitle' });
        case 'GetRestApiCommand':
          return Promise.resolve({ id: 'api123', rootResourceId: 'root1' });
        default:
          return Promise.resolve({});
      }
    });
  });

  describe('create', () => {
    it('sends every property in ONE CreateRestApi through the create client and records both attributes', async () => {
      const result = await provider.create('Api', TYPE, {
        Name: 'my-api',
        Description: 'd',
        Version: 'v1',
        BinaryMediaTypes: ['image/png'],
        MinimumCompressionSize: 100,
        ApiKeySourceType: 'AUTHORIZER',
        DisableExecuteApiEndpoint: true,
        EndpointConfiguration: {
          Types: ['PRIVATE'],
          VpcEndpointIds: ['vpce-1'],
          IpAddressType: 'dualstack',
        },
        Policy: { Version: '2012-10-17', Statement: [] },
        SecurityPolicy: 'SecurityPolicy_TLS13_1_3_2025_09',
        EndpointAccessMode: 'STRICT',
        Tags: [{ Key: 'k', Value: 'v' }],
      });

      expect(names()).toEqual(['CreateRestApiCommand']);
      expect(sentVia[0]).toEqual(['CreateRestApiCommand', 'create']);
      expect(sent('CreateRestApiCommand')[0]!.input).toEqual({
        name: 'my-api',
        description: 'd',
        version: 'v1',
        cloneFrom: undefined,
        binaryMediaTypes: ['image/png'],
        minimumCompressionSize: 100,
        apiKeySource: 'AUTHORIZER',
        disableExecuteApiEndpoint: true,
        endpointConfiguration: {
          types: ['PRIVATE'],
          vpcEndpointIds: ['vpce-1'],
          ipAddressType: 'dualstack',
        },
        policy: '{"Version":"2012-10-17","Statement":[]}',
        securityPolicy: 'SecurityPolicy_TLS13_1_3_2025_09',
        endpointAccessMode: 'STRICT',
        tags: { k: 'v' },
      });
      expect(result).toEqual({
        physicalId: 'api123',
        attributes: { RestApiId: 'api123', RootResourceId: 'root1' },
      });
    });

    it('refuses a missing Name with no body before any call', async () => {
      await expect(provider.create('Api', TYPE, { Description: 'd' })).rejects.toThrow(
        /Name is required/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('imports a Body with no Name (the definition names the API), then patches and tags', async () => {
      const body = { openapi: '3.0.1', info: { title: 'FromSpec', version: '1' }, paths: {} };
      await provider.create('Api', TYPE, {
        Body: body,
        FailOnWarnings: true,
        Parameters: { ignore: 'documentation' },
        EndpointConfiguration: { Types: ['REGIONAL'] },
        BinaryMediaTypes: ['image/png'],
        Tags: [{ Key: 'k', Value: 'v' }],
      });

      expect(names()).toEqual(['ImportRestApiCommand', 'UpdateRestApiCommand', 'TagResourceCommand']);
      expect(sentVia[0]).toEqual(['ImportRestApiCommand', 'create']);
      const imported = sent('ImportRestApiCommand')[0]!.input;
      expect(new TextDecoder().decode(imported['body'] as Uint8Array)).toBe(JSON.stringify(body));
      expect(imported['failOnWarnings']).toBe(true);
      // The endpoint type rides the import, so the API is never created EDGE and switched.
      expect(imported['parameters']).toEqual({
        ignore: 'documentation',
        endpointConfigurationTypes: 'REGIONAL',
      });
      expect(sent('UpdateRestApiCommand')[0]!.input['patchOperations']).toEqual([
        { op: 'add', path: '/binaryMediaTypes/image~1png' },
      ]);
      expect(sent('TagResourceCommand')[0]!.input).toEqual({
        resourceArn: 'arn:aws:apigateway:us-east-1::/restapis/api123',
        tags: { k: 'v' },
      });
    });

    it('after importing an S3 definition, adds the template types and removes none the definition set', async () => {
      mockS3Send.mockResolvedValue({
        Body: { transformToByteArray: () => Promise.resolve(new TextEncoder().encode('openapi: 3.0.1')) },
      });
      mockSend.mockImplementation((command: Sent) =>
        Promise.resolve(
          command.constructor.name === 'ImportRestApiCommand'
            ? { id: 'api123', rootResourceId: 'root1', name: 'n', binaryMediaTypes: ['image/gif'] }
            : {}
        )
      );
      await provider.create('Api', TYPE, {
        Name: 'n',
        BinaryMediaTypes: ['image/png'],
        BodyS3Location: { Bucket: 'b', Key: 'k' },
      });
      expect(sent('UpdateRestApiCommand')[0]!.input['patchOperations']).toEqual([
        { op: 'add', path: '/binaryMediaTypes/image~1png' },
      ]);
    });

    it('reads a BodyS3Location object the way CloudFormation does', async () => {
      mockS3Send.mockResolvedValue({
        Body: { transformToByteArray: () => Promise.resolve(new TextEncoder().encode('openapi: 3.0.1')) },
      });
      await provider.create('Api', TYPE, {
        Name: 'n',
        BodyS3Location: { Bucket: 'b', Key: 'k.yaml', Version: 'v7', ETag: 'e1' },
      });
      expect(mockS3Send.mock.calls[0]![0].input).toEqual({
        Bucket: 'b',
        Key: 'k.yaml',
        VersionId: 'v7',
        IfMatch: 'e1',
      });
      const imported = sent('ImportRestApiCommand')[0]!.input;
      expect(new TextDecoder().decode(imported['body'] as Uint8Array)).toBe('openapi: 3.0.1');
      // The import named it from the definition; the declared Name wins.
      expect(sent('UpdateRestApiCommand')[0]!.input['patchOperations']).toEqual([
        { op: 'replace', path: '/name', value: 'n' },
      ]);
    });

    it('CloneFrom with a body clones, then puts the body', async () => {
      await provider.create('Api', TYPE, { Name: 'n', CloneFrom: 'src1', Body: { openapi: '3.0.1' } });
      expect(names()).toEqual(['CreateRestApiCommand', 'PutRestApiCommand', 'UpdateRestApiCommand']);
      expect(sent('CreateRestApiCommand')[0]!.input['cloneFrom']).toBe('src1');
      const put = sent('PutRestApiCommand')[0]!.input;
      expect(put['mode']).toBe('overwrite');
      expect(new TextDecoder().decode(put['body'] as Uint8Array)).toBe('{"openapi":"3.0.1"}');
      // The put answered the definition's title: the declared Name is re-applied.
      expect(sent('UpdateRestApiCommand')[0]!.input['patchOperations']).toEqual([
        { op: 'replace', path: '/name', value: 'n' },
      ]);
    });

    it('CloneFrom with a body and Mode merge puts in merge mode', async () => {
      await provider.create('Api', TYPE, {
        Name: 'n',
        CloneFrom: 'src1',
        Mode: 'merge',
        Body: { openapi: '3.0.1' },
      });
      expect(sent('PutRestApiCommand')[0]!.input['mode']).toBe('merge');
    });

    it('after an import, patches the declared Policy and VPC endpoint ids the definition did not set', async () => {
      await provider.create('Api', TYPE, {
        Name: 'FromSpec',
        Body: { openapi: '3.0.1' },
        Policy: { Statement: [] },
        EndpointConfiguration: { Types: ['PRIVATE'], VpcEndpointIds: ['vpce-1'] },
      });
      expect(sent('ImportRestApiCommand')[0]!.input['parameters']).toEqual({
        endpointConfigurationTypes: 'PRIVATE',
      });
      expect(sent('UpdateRestApiCommand')[0]!.input['patchOperations']).toEqual([
        { op: 'replace', path: '/policy', value: '{"Statement":[]}' },
        { op: 'add', path: '/endpointConfiguration/vpcEndpointIds', value: 'vpce-1' },
      ]);
    });

    it('deletes the REST API a failing post-create step left, and re-throws the original error', async () => {
      mockSend.mockImplementation((command: Sent) => {
        if (command.constructor.name === 'ImportRestApiCommand') {
          return Promise.resolve({ id: 'api123', rootResourceId: 'root1' });
        }
        if (command.constructor.name === 'UpdateRestApiCommand') {
          return Promise.reject(
            Object.assign(new Error('Invalid patch path'), {
              name: 'BadRequestException',
              $fault: 'client',
              $metadata: { httpStatusCode: 400 },
            })
          );
        }
        return Promise.resolve({});
      });
      await expect(
        provider.create('Api', TYPE, { Name: 'n', Body: { openapi: '3.0.1' } })
      ).rejects.toThrow(/Failed to create API Gateway RestApi Api: BadRequestException/);
      expect(sent('DeleteRestApiCommand').map((c) => c.input)).toEqual([{ restApiId: 'api123' }]);
    });

    it('names the survivor when that cleanup fails too', async () => {
      mockSend.mockImplementation((command: Sent) => {
        switch (command.constructor.name) {
          case 'ImportRestApiCommand':
            return Promise.resolve({ id: 'api123', rootResourceId: 'root1' });
          case 'UpdateRestApiCommand':
          case 'DeleteRestApiCommand':
            return Promise.reject(
              Object.assign(new Error('nope'), { name: 'BadRequestException', $metadata: {} })
            );
          default:
            return Promise.resolve({});
        }
      });
      await expect(
        provider.create('Api', TYPE, { Name: 'n', Body: { openapi: '3.0.1' } })
      ).rejects.toThrow(/aws apigateway delete-rest-api --rest-api-id api123 --region us-east-1/);
    });

    it('deletes nothing when the create call itself fails', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('bad'), { name: 'BadRequestException', $metadata: {} })
      );
      await expect(provider.create('Api', TYPE, { Name: 'n' })).rejects.toThrow();
      expect(sent('DeleteRestApiCommand')).toHaveLength(0);
    });
  });

  describe('create: refusals, fallbacks and retry safety', () => {
    const transient500 = (): Error =>
      Object.assign(new Error('Internal server error'), {
        name: 'InternalServerError',
        $fault: 'server',
        $metadata: { httpStatusCode: 500 },
      });

    it('sends a text Body (JSON or YAML) byte for byte', async () => {
      const text = 'openapi: 3.0.1\ninfo:\n  title: T\n';
      await provider.create('Api', TYPE, { Body: text });
      const imported = sent('ImportRestApiCommand')[0]!.input;
      expect(new TextDecoder().decode(imported['body'] as Uint8Array)).toBe(text);
    });

    it('CloneFrom carries the tags on CreateRestApi and sends no TagResource', async () => {
      await provider.create('Api', TYPE, {
        Name: 'n',
        CloneFrom: 'src1',
        Body: { openapi: '3.0.1' },
        Tags: [{ Key: 'k', Value: 'v' }],
      });
      expect(names()).toEqual(['CreateRestApiCommand', 'PutRestApiCommand', 'UpdateRestApiCommand']);
      expect(sent('CreateRestApiCommand')[0]!.input['tags']).toEqual({ k: 'v' });
    });

    it.each([
      ['a Body that is neither an object nor text', { Name: 'n', Body: 42 }, /^Body of .* must be an OpenAPI definition/],
      ['a BodyS3Location without a Key', { Name: 'n', BodyS3Location: { Bucket: 'b' } }, /^BodyS3Location of .* must name a Bucket and a Key/],
    ])('refuses %s before any call, with its own message', async (_label, props, says) => {
      await expect(provider.create('Api', TYPE, props)).rejects.toThrow(says);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses an empty S3 definition before any API Gateway call', async () => {
      mockS3Send.mockResolvedValue({
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array()) },
      });
      await expect(
        provider.create('Api', TYPE, { Name: 'n', BodyS3Location: { Bucket: 'b', Key: 'k' } })
      ).rejects.toThrow(/^BodyS3Location of AWS::ApiGateway::RestApi Api \(s3:\/\/b\/k\) holds no definition/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a create answer with no id, and deletes nothing', async () => {
      mockSend.mockResolvedValue({});
      await expect(provider.create('Api', TYPE, { Name: 'n' })).rejects.toThrow(/answered no id/);
      expect(sent('DeleteRestApiCommand')).toHaveLength(0);
    });

    it('reads RootResourceId with GetRestApi when the create answer lacks it', async () => {
      mockSend.mockImplementation((command: Sent) =>
        Promise.resolve(
          command.constructor.name === 'GetRestApiCommand'
            ? { id: 'api123', rootResourceId: 'root9' }
            : { id: 'api123' }
        )
      );
      const result = await provider.create('Api', TYPE, { Name: 'n' });
      expect(names()).toEqual(['CreateRestApiCommand', 'GetRestApiCommand']);
      expect(result.attributes).toEqual({ RestApiId: 'api123', RootResourceId: 'root9' });
    });

    it('after a lost CreateRestApi answer, reports the API of the declared Name before creating again', async () => {
      mockSend.mockImplementationOnce(() => Promise.reject(transient500()));
      await expect(provider.create('Api', TYPE, { Name: 'mine' })).rejects.toThrow();
      mockSend.mockImplementation((command: Sent) =>
        Promise.resolve(
          command.constructor.name === 'GetRestApisCommand'
            ? {
                items: [
                  { id: 'orphanMine', name: 'mine', createdDate: new Date() },
                  { id: 'otherName', name: 'other', createdDate: new Date() },
                ],
              }
            : { id: 'api123', rootResourceId: 'root1' }
        )
      );
      await provider.create('Api', TYPE, { Name: 'mine' });
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('orphanMine');
      expect(warned).not.toContain('otherName');
    });

    it('after a create the SDK replayed inside its send, reports a duplicate but not the API it recorded', async () => {
      mockSend.mockImplementation((command: Sent) =>
        Promise.resolve(
          command.constructor.name === 'GetRestApisCommand'
            ? {
                items: [
                  { id: 'api123', name: 'mine', createdDate: new Date() },
                  { id: 'dup1', name: 'mine', createdDate: new Date() },
                ],
              }
            : { id: 'api123', rootResourceId: 'root1', $metadata: { attempts: 2 } }
        )
      );
      await provider.create('Api', TYPE, { Name: 'mine' });
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('dup1');
      // The id this create recorded is no candidate, wherever the list would put it.
      expect(warned).not.toMatch(/\bapi123\b/);
      expect(names()).toEqual(['CreateRestApiCommand', 'GetRestApisCommand']);
    });

    it('after a lost import of a YAML definition, says the window-only candidates may be another deploy\'s', async () => {
      mockSend.mockImplementationOnce(() => Promise.reject(transient500()));
      const props = { Body: 'openapi: 3.0.1\ninfo:\n  title: T\n' };
      await expect(provider.create('Api', TYPE, props)).rejects.toThrow();
      mockSend.mockImplementation((command: Sent) =>
        Promise.resolve(
          command.constructor.name === 'GetRestApisCommand'
            ? { items: [{ id: 'anyone', name: 'x', createdDate: new Date() }] }
            : { id: 'api123', rootResourceId: 'root1' }
        )
      );
      await provider.create('Api', TYPE, props);
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('anyone');
      expect(warned).toContain('can include another deploy or process');
    });

    it('after a lost ImportRestApi answer, reports the API named by the definition title before importing again', async () => {
      mockSend.mockImplementationOnce(() => Promise.reject(transient500()));
      const props = { Name: 'mine', Body: { openapi: '3.0.1', info: { title: 'T', version: '1' } } };
      await expect(provider.create('Api', TYPE, props)).rejects.toThrow();
      mockSend.mockImplementation((command: Sent) => {
        if (command.constructor.name === 'GetRestApisCommand') {
          return Promise.resolve({
            items: [
              { id: 'orphanT', name: 'T', createdDate: new Date() },
              { id: 'otherName', name: 'mine', createdDate: new Date() },
            ],
          });
        }
        return Promise.resolve({ id: 'api123', rootResourceId: 'root1', name: 'T' });
      });
      await provider.create('Api', TYPE, props);
      const warned = warnSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(warned).toContain('orphanT');
      expect(warned).not.toContain('otherName');
      expect(names().indexOf('GetRestApisCommand')).toBeLessThan(
        names().lastIndexOf('ImportRestApiCommand')
      );
    });
  });

  describe('update', () => {
    it('renames in place with one UpdateRestApi', async () => {
      const result = await provider.update(
        'Api',
        'api123',
        TYPE,
        { Name: 'b' },
        { Name: 'a' }
      );
      expect(names()).toEqual(['UpdateRestApiCommand']);
      expect(sent('UpdateRestApiCommand')[0]!.input).toEqual({
        restApiId: 'api123',
        patchOperations: [{ op: 'replace', path: '/name', value: 'b' }],
      });
      expect(result).toEqual({ physicalId: 'api123', wasReplaced: false });
    });

    it('applies CloudFormation removal semantics', async () => {
      await provider.update(
        'Api',
        'api123',
        TYPE,
        { Name: 'a' },
        {
          Name: 'a',
          Description: 'd',
          MinimumCompressionSize: 100,
          ApiKeySourceType: 'AUTHORIZER',
          DisableExecuteApiEndpoint: true,
          Policy: { Statement: [] },
          BinaryMediaTypes: ['image/png', 'image/gif'],
          EndpointConfiguration: { Types: ['REGIONAL'] },
          Tags: [{ Key: 'k', Value: 'v' }],
        }
      );
      expect(sent('UpdateRestApiCommand')[0]!.input['patchOperations']).toEqual([
        { op: 'remove', path: '/binaryMediaTypes/image~1png' },
        { op: 'remove', path: '/binaryMediaTypes/image~1gif' },
        { op: 'replace', path: '/endpointConfiguration/types/REGIONAL', value: 'EDGE' },
      ]);
      expect(sent('UntagResourceCommand')[0]!.input).toEqual({
        resourceArn: 'arn:aws:apigateway:us-east-1::/restapis/api123',
        tagKeys: ['k'],
      });
      expect(sent('PutRestApiCommand')).toHaveLength(0);
    });

    it('puts a changed Body in overwrite mode, then re-applies the declared properties the put clobbered', async () => {
      const result = await provider.update(
        'Api',
        'api123',
        TYPE,
        { Name: 'mine', BinaryMediaTypes: ['image/png'], Body: { paths: { '/c': {} } } },
        { Name: 'mine', BinaryMediaTypes: ['image/png'], Body: { paths: { '/b': {} } } }
      );
      expect(names()).toEqual(['PutRestApiCommand', 'UpdateRestApiCommand']);
      expect(sent('PutRestApiCommand')[0]!.input['mode']).toBe('overwrite');
      // The put answered name SpecTitle and no binary media types.
      expect(sent('UpdateRestApiCommand')[0]!.input['patchOperations']).toEqual([
        { op: 'replace', path: '/name', value: 'mine' },
        { op: 'add', path: '/binaryMediaTypes/image~1png' },
      ]);
      expect(result.attributes).toEqual({ RestApiId: 'api123', RootResourceId: 'root1' });
    });

    it('after a merge put, removes the binary media type the template dropped (the put keeps the old list)', async () => {
      mockSend.mockImplementation((command: Sent) =>
        Promise.resolve(
          command.constructor.name === 'PutRestApiCommand'
            ? { id: 'api123', name: 'a', binaryMediaTypes: ['image/png', 'image/jpeg'] }
            : {}
        )
      );
      await provider.update(
        'Api',
        'api123',
        TYPE,
        { Name: 'a', Mode: 'merge', Body: { a: 2 }, BinaryMediaTypes: ['image/png'] },
        { Name: 'a', Mode: 'merge', Body: { a: 1 }, BinaryMediaTypes: ['image/png', 'image/jpeg'] }
      );
      expect(sent('UpdateRestApiCommand')[0]!.input['patchOperations']).toEqual([
        { op: 'remove', path: '/binaryMediaTypes/image~1jpeg' },
      ]);
    });

    it('after an overwrite put of an S3 definition, keeps the type the definition set though the template dropped it', async () => {
      mockS3Send.mockResolvedValue({
        Body: { transformToByteArray: () => Promise.resolve(new TextEncoder().encode('openapi: 3.0.1')) },
      });
      mockSend.mockImplementation((command: Sent) =>
        Promise.resolve(
          command.constructor.name === 'PutRestApiCommand'
            ? { id: 'api123', name: 'a', binaryMediaTypes: ['image/gif'] }
            : {}
        )
      );
      await provider.update(
        'Api',
        'api123',
        TYPE,
        { Name: 'a', BodyS3Location: { Bucket: 'b', Key: 'v2' }, BinaryMediaTypes: [] },
        { Name: 'a', BodyS3Location: { Bucket: 'b', Key: 'v1' }, BinaryMediaTypes: ['image/gif'] }
      );
      expect(names()).toEqual(['PutRestApiCommand']);
    });

    it('forwards Mode merge', async () => {
      await provider.update(
        'Api',
        'api123',
        TYPE,
        { Name: 'SpecTitle', Mode: 'merge', Body: { a: 2 } },
        { Name: 'SpecTitle', Body: { a: 1 } }
      );
      expect(sent('PutRestApiCommand')[0]!.input['mode']).toBe('merge');
    });

    it('a Body differing from the record only by a resolved {{resolve:}} reference is not put again', async () => {
      await provider.update(
        'Api',
        'api123',
        TYPE,
        { Name: 'a', Description: 'new', Body: { key: 'plain-secret' } },
        { Name: 'a', Body: { key: '{{resolve:ssm:/k}}' } },
        { maskSecrets: (t: string) => t.replaceAll('plain-secret', '***') }
      );
      expect(names()).toEqual(['UpdateRestApiCommand']);
    });

    it('puts a Body the engine names as changed, though the record differs only by a reference (a re-pointed secret)', async () => {
      await provider.update(
        'Api',
        'api123',
        TYPE,
        { Name: 'a', Body: { key: 'plain-secret' } },
        { Name: 'a', Body: { key: '{{resolve:ssm:/k}}' } },
        {
          maskSecrets: (t: string) => t.replaceAll('plain-secret', '***'),
          changedProperties: new Set(['Body']),
        }
      );
      expect(names()).toContain('PutRestApiCommand');
    });

    it('does not re-put a Body the engine names changed only for a NoEcho value, and warns without the value', async () => {
      // go-to-k/cdkd#6146: the skipped key is reported, so the engine keeps
      // its previous NoEcho value MAC.
      const kept: string[] = [];
      await provider.update(
        'Api',
        'api123',
        TYPE,
        {
          Name: 'a',
          Description: 'new',
          Body: { paths: { '/a': { header: 'Bearer s3cr3t-value' } } },
        },
        { Name: 'a', Body: { paths: { '/a': { header: 'Bearer ***' } } } },
        {
          changedProperties: new Set(['Body', 'Description']),
          noEchoOnlyChangedProperties: new Set(['Body']),
          keptNoEchoOnlyProperty: (key: string) => kept.push(key),
        }
      );
      expect(names()).toEqual(['UpdateRestApiCommand']);
      expect(kept).toEqual(['Body']);
      const warned = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(warned.some((w) => /NoEcho parameter value.* is NOT applied/.test(w))).toBe(true);
      // The remedy is one a deploy of an SDK-managed record can take: no
      // recreate flag (`--recreate-via-sdk-provider` refuses an SDK record).
      expect(
        warned.some((w) => w.includes('change a part of the Body that is not masked') && w.includes('in the same deploy'))
      ).toBe(true);
      expect(warned.join('\n')).not.toContain('--recreate');
      expect(warned.join('\n')).not.toContain('s3cr3t-value');
    });

    it.each([
      ['a non-masked change beside a masked one', { key: 's3cr3t-value', paths: { '/b': {} } }, { key: '***', paths: { '/a': {} } }],
      ['a NoEcho value swapped for a dynamic reference', { key: 'resolved-secret' }, { key: '***' }],
      ['the same swap behind a literal prefix', { key: 'Bearer resolved-secret' }, { key: 'Bearer ***' }],
    ])('re-puts a Body the engine says moved as written: %s', async (_label, desired, previous) => {
      const kept: string[] = [];
      await provider.update(
        'Api',
        'api123',
        TYPE,
        { Name: 'a', Body: desired },
        { Name: 'a', Body: previous },
        {
          changedProperties: new Set(['Body']),
          noEchoOnlyChangedProperties: new Set(),
          keptNoEchoOnlyProperty: (key: string) => kept.push(key),
        }
      );
      expect(names()).toContain('PutRestApiCommand');
      expect(kept).toEqual([]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('re-puts when Mode changed too, though Body is NoEcho-only', async () => {
      await provider.update(
        'Api',
        'api123',
        TYPE,
        { Name: 'a', Mode: 'merge', Body: { key: 's3cr3t-value' } },
        { Name: 'a', Body: { key: '***' } },
        {
          changedProperties: new Set(['Body', 'Mode']),
          noEchoOnlyChangedProperties: new Set(['Body']),
        }
      );
      expect(names()).toContain('PutRestApiCommand');
    });

    it('puts no Body the engine does not name as changed', async () => {
      await provider.update(
        'Api',
        'api123',
        TYPE,
        { Name: 'a', Description: 'x', Body: { key: 'plain-secret' } },
        { Name: 'a', Body: { key: '{{resolve:ssm:/k}}' } },
        { changedProperties: new Set(['Description']) }
      );
      expect(names()).toEqual(['UpdateRestApiCommand']);
    });

    it('a Body removed from the template changes nothing', async () => {
      await provider.update('Api', 'api123', TYPE, { Name: 'a' }, { Name: 'a', Body: { a: 1 } });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('an unchanged Body is not put again', async () => {
      await provider.update(
        'Api',
        'api123',
        TYPE,
        { Name: 'a', Body: { a: 1 }, Description: 'x' },
        { Name: 'a', Body: { a: 1 } }
      );
      expect(names()).toEqual(['UpdateRestApiCommand']);
    });

    // go-to-k/cdkd#6141: the put would delete every resource the stack added
    // outside the definition. A Description- or Tags-only change, with the
    // engine's verdict (a deploy, a Cloud Control record's flip) or without it
    // (rollback, `drift --revert`), sends no put, whatever the key order.
    describe('a Body unchanged beside another change is not put (go-to-k/cdkd#6141)', () => {
      const body = { openapi: '3.0.1', info: { title: 'spec', version: '1' }, paths: { '/a': {} } };
      const reordered = { paths: { '/a': {} }, info: { version: '1', title: 'spec' }, openapi: '3.0.1' };
      it.each([
        ['the engine names Description', { changedProperties: new Set(['Description']) }],
        ['no engine verdict (rollback, drift --revert)', {}],
      ])('Description only: %s', async (_label, context) => {
        await provider.update(
          'Api',
          'api123',
          TYPE,
          { Description: 'after', Body: reordered },
          { Description: 'before', Body: body },
          context
        );
        expect(names()).toEqual(['UpdateRestApiCommand']);
        expect(sent('UpdateRestApiCommand')[0]!.input['patchOperations']).toEqual([
          { op: 'replace', path: '/description', value: 'after' },
        ]);
      });

      it('Tags only: no put and no patch', async () => {
        await provider.update(
          'Api',
          'api123',
          TYPE,
          { Body: body, Tags: [{ Key: 'k', Value: 'b' }] },
          { Body: body, Tags: [{ Key: 'k', Value: 'a' }] },
          { changedProperties: new Set(['Tags']) }
        );
        expect(names()).not.toContain('PutRestApiCommand');
        expect(names()).not.toContain('UpdateRestApiCommand');
      });
    });
  });

  describe('restApiPatchOperations', () => {
    it('after a body put, adds the template types to the definition types and removes none (CFn merges them)', () => {
      expect(
        restApiPatchOperations(
          { BinaryMediaTypes: ['image/png'] },
          { BinaryMediaTypes: ['image/gif'] },
          { BinaryMediaTypes: ['image/jpeg'] },
          'overwrite'
        )
      ).toEqual([{ op: 'add', path: '/binaryMediaTypes/image~1png' }]);
    });

    it('after a merge put, which keeps the old list, removes a type the template dropped', () => {
      expect(
        restApiPatchOperations(
          { BinaryMediaTypes: ['image/png'] },
          { BinaryMediaTypes: ['image/jpeg', 'image/png', 'image/gif'] },
          { BinaryMediaTypes: ['image/jpeg', 'image/png'] },
          'merge'
        )
      ).toEqual([{ op: 'remove', path: '/binaryMediaTypes/image~1jpeg' }]);
    });

    it('sends no remove for a dropped type that is no longer live', () => {
      expect(
        restApiPatchOperations(
          { BinaryMediaTypes: [] },
          { BinaryMediaTypes: ['image/png'] },
          { BinaryMediaTypes: ['image/png', 'image/gif'] }
        )
      ).toEqual([{ op: 'remove', path: '/binaryMediaTypes/image~1png' }]);
    });

    it('keeps a type a JSON-text definition declares when the template drops it', () => {
      expect(
        restApiPatchOperations(
          {
            BinaryMediaTypes: [],
            Body: JSON.stringify({ 'x-amazon-apigateway-binary-media-types': ['image/gif'] }),
          },
          { BinaryMediaTypes: ['image/gif', 'image/png'] },
          { BinaryMediaTypes: ['image/gif', 'image/png'] }
        )
      ).toEqual([{ op: 'remove', path: '/binaryMediaTypes/image~1png' }]);
    });

    it('without a put, keeps a type the definition declares when the template drops it', () => {
      expect(
        restApiPatchOperations(
          {
            BinaryMediaTypes: ['image/png'],
            Body: { 'x-amazon-apigateway-binary-media-types': ['image/gif'] },
          },
          { BinaryMediaTypes: ['image/png', 'image/gif', 'image/jpeg'] },
          { BinaryMediaTypes: ['image/png', 'image/gif', 'image/jpeg'] }
        )
      ).toEqual([{ op: 'remove', path: '/binaryMediaTypes/image~1jpeg' }]);
    });

    it('PRIVATE to REGIONAL sends only the type change: API Gateway drops the VPC endpoint ids itself (measured)', () => {
      expect(
        restApiPatchOperations(
          { EndpointConfiguration: { Types: ['REGIONAL'] } },
          { EndpointConfiguration: { Types: ['PRIVATE'], VpcEndpointIds: ['vpce-1'] } },
          { EndpointConfiguration: { Types: ['PRIVATE'], VpcEndpointIds: ['vpce-1'] } }
        )
      ).toEqual([
        { op: 'replace', path: '/endpointConfiguration/types/PRIVATE', value: 'REGIONAL' },
      ]);
    });

    it('adds and removes VPC endpoint ids on a private API', () => {
      expect(
        restApiPatchOperations(
          { EndpointConfiguration: { Types: ['PRIVATE'], VpcEndpointIds: ['vpce-2'] } },
          { EndpointConfiguration: { Types: ['PRIVATE'], VpcEndpointIds: ['vpce-1'] } },
          { EndpointConfiguration: { Types: ['PRIVATE'], VpcEndpointIds: ['vpce-1'] } }
        )
      ).toEqual([
        { op: 'add', path: '/endpointConfiguration/vpcEndpointIds', value: 'vpce-2' },
        { op: 'remove', path: '/endpointConfiguration/vpcEndpointIds', value: 'vpce-1' },
      ]);
    });

    it('an API created without an EndpointConfiguration is EDGE', () => {
      expect(
        restApiPatchOperations({ EndpointConfiguration: { Types: ['REGIONAL'] } }, {}, {})
      ).toEqual([{ op: 'replace', path: '/endpointConfiguration/types/EDGE', value: 'REGIONAL' }]);
    });

    it('puts endpoint operations last (an endpoint change is applied asynchronously)', () => {
      const ops = restApiPatchOperations(
        { Description: 'x', EndpointConfiguration: { Types: ['REGIONAL'] } },
        { EndpointConfiguration: { Types: ['EDGE'] } },
        {}
      );
      expect(ops.map((o) => o.path)).toEqual(['/description', '/endpointConfiguration/types/EDGE']);
    });
  });

  describe('delete', () => {
    it('deletes by the physical id', async () => {
      await provider.delete('Api', 'api123', TYPE, {});
      expect(sent('DeleteRestApiCommand').map((c) => c.input)).toEqual([{ restApiId: 'api123' }]);
    });

    it('treats NotFound as already deleted in the expected region', async () => {
      mockSend.mockRejectedValueOnce(notFound());
      await expect(
        provider.delete('Api', 'api123', TYPE, {}, { expectedRegion: 'us-east-1' })
      ).resolves.toBeUndefined();
    });

    it('marks a failure that only spells NotFound as not gone', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('nope'), { name: 'StageNotFound', $metadata: {} })
      );
      const thrown = await provider.delete('Api', 'api123', TYPE, {}).catch((e: unknown) => e);
      expect(isMarkedNotGone(thrown)).toBe(true);
    });

    it('refuses NotFound from another region than the recorded one', async () => {
      mockSend.mockRejectedValueOnce(notFound());
      await expect(
        provider.delete('Api', 'api123', TYPE, {}, { expectedRegion: 'eu-west-1' })
      ).rejects.toThrow();
    });
  });

  describe('attributes, drift and import', () => {
    it('resolves RestApiId from the physical id and RootResourceId live', async () => {
      await expect(provider.getAttribute('api123', TYPE, 'RestApiId')).resolves.toBe('api123');
      await expect(provider.getAttribute('api123', TYPE, 'RootResourceId')).resolves.toBe('root1');
    });

    it('reads the live API back in CFn shape, folding the policy and dropping aws: tags', async () => {
      mockSend.mockResolvedValueOnce({
        id: 'api123',
        name: 'n',
        description: 'd',
        binaryMediaTypes: ['image/png'],
        apiKeySource: 'HEADER',
        disableExecuteApiEndpoint: false,
        endpointConfiguration: { types: ['REGIONAL'], ipAddressType: 'ipv4' },
        policy:
          '{\\"Version\\":\\"2012-10-17\\",\\"Statement\\":[{\\"Effect\\":\\"Allow\\",\\"Resource\\":\\"arn:aws:execute-api:us-east-1:123456789012:api123\\/*\\"}]}',
        tags: { k: 'v', 'aws:cloudformation:stack-name': 's' },
      });
      const state = await provider.readCurrentState('api123', 'Api', TYPE, {
        Policy: {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Resource: 'execute-api:/*' }],
        },
      });
      expect(state).toEqual({
        Name: 'n',
        Description: 'd',
        BinaryMediaTypes: ['image/png'],
        ApiKeySourceType: 'HEADER',
        DisableExecuteApiEndpoint: false,
        EndpointConfiguration: { Types: ['REGIONAL'], IpAddressType: 'ipv4' },
        Policy: {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Resource: 'execute-api:/*' }],
        },
        Tags: [{ Key: 'k', Value: 'v' }],
      });
      expect(provider.getDriftUnknownPaths(TYPE)).toEqual([
        'Body',
        'BodyS3Location',
        'CloneFrom',
        'FailOnWarnings',
        'Mode',
        'Parameters',
      ]);
    });

    it('leaves the definition-declared binary media types out of the read-back unless the template declares them', async () => {
      mockSend.mockResolvedValueOnce({
        id: 'api123',
        name: 'n',
        binaryMediaTypes: ['image/gif', 'image/png', 'image/jpeg'],
      });
      const state = (await provider.readCurrentState('api123', 'Api', TYPE, {
        BinaryMediaTypes: ['image/png', 'image/jpeg'],
        Body: { 'x-amazon-apigateway-binary-media-types': ['image/gif', 'image/jpeg'] },
      })) as Record<string, unknown>;
      expect(state['BinaryMediaTypes']).toEqual(['image/png', 'image/jpeg']);
      expect(provider.getDriftUnorderedPaths(TYPE)).toEqual(['BinaryMediaTypes']);
    });

    it('compares only the declared binary media types for a definition it cannot read (BodyS3Location)', async () => {
      mockSend.mockResolvedValueOnce({ id: 'api123', binaryMediaTypes: ['image/gif', 'image/png'] });
      const state = (await provider.readCurrentState('api123', 'Api', TYPE, {
        BinaryMediaTypes: ['image/png'],
        BodyS3Location: { Bucket: 'b', Key: 'k' },
      })) as Record<string, unknown>;
      expect(state['BinaryMediaTypes']).toEqual(['image/png']);
    });

    it('compares only the declared binary media types for a YAML definition', async () => {
      mockSend.mockResolvedValueOnce({ id: 'api123', binaryMediaTypes: ['image/gif', 'image/png'] });
      const state = (await provider.readCurrentState('api123', 'Api', TYPE, {
        BinaryMediaTypes: ['image/png'],
        Body: 'openapi: 3.0.1\nx-amazon-apigateway-binary-media-types: [image/gif]\n',
      })) as Record<string, unknown>;
      expect(state['BinaryMediaTypes']).toEqual(['image/png']);
    });

    it('compares a Policy written as JSON text as the parsed document', () => {
      expect(
        provider.canonicalizeDriftProperties(TYPE, { Policy: '{"Version":"2012-10-17"}' })
      ).toEqual({ Policy: { Version: '2012-10-17' } });
    });

    it('imports an explicit id with both attributes, and answers null for an unknown one', async () => {
      await expect(
        provider.import({
          logicalId: 'Api',
          resourceType: TYPE,
          stackName: 's',
          region: 'us-east-1',
          properties: {},
          knownPhysicalId: 'api123',
        })
      ).resolves.toEqual({
        physicalId: 'api123',
        attributes: { RestApiId: 'api123', RootResourceId: 'root1' },
      });
      mockSend.mockRejectedValueOnce(notFound());
      await expect(
        provider.import({
          logicalId: 'Api',
          resourceType: TYPE,
          stackName: 's',
          region: 'us-east-1',
          properties: {},
          knownPhysicalId: 'nope',
        })
      ).resolves.toBeNull();
    });
  });

  it('a Name change is an in-place update, not a replacement (CloudFormation renames in place)', async () => {
    const state: StackState = {
      version: 1,
      stackName: 'S',
      resources: {
        Api: { physicalId: 'api123', resourceType: TYPE, properties: { Name: 'a' }, attributes: {} },
      },
      outputs: {},
      lastModified: 0,
    };
    const changes = await new DiffCalculator().calculateDiff(state, {
      Resources: { Api: { Type: TYPE, Properties: { Name: 'b' } } },
    });
    const change = changes.get('Api');
    expect(change?.changeType).toBe('UPDATE');
    expect(change?.propertyChanges?.find((p) => p.path === 'Name')?.requiresReplacement).toBe(false);
  });
});
