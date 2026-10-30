import { describe, expect, it } from 'vite-plus/test';
import {
  apiGatewayV2DefinitionObject,
  isApiGatewayV2Import,
  splitApiGatewayV2ImportPatch,
} from '../../../src/provisioning/apigwv2-body-import-patch.js';
import type { JsonPatchOp } from '../../../src/provisioning/json-patch-generator.js';

const TYPE = 'AWS::ApiGatewayV2::Api';
const BODY_V1 = { openapi: '3.0.1', info: { title: 't', version: '1.0' }, paths: {} };
const BODY_V2 = { ...BODY_V1, info: { ...BODY_V1.info, description: 'edited' } };

describe('splitApiGatewayV2ImportPatch (go-to-k/cdkd#5260)', () => {
  it('drops every import-key op from the Cloud Control patch and keeps the rest', () => {
    const patch: JsonPatchOp[] = [
      { op: 'add', path: '/Body', value: BODY_V2 },
      { op: 'add', path: '/BasePath', value: 'split' },
      { op: 'add', path: '/FailOnWarnings', value: true },
      { op: 'add', path: '/BodyS3Location', value: { Bucket: 'b', Key: 'k' } },
      { op: 'replace', path: '/Description', value: 'd' },
    ];
    const { rest } = splitApiGatewayV2ImportPatch(patch, { Body: BODY_V1 }, { Body: BODY_V2 });
    expect(rest).toEqual([{ op: 'replace', path: '/Description', value: 'd' }]);
  });

  it('asks for a reimport carrying the definition text when Body changed', () => {
    const { reimport } = splitApiGatewayV2ImportPatch([], { Body: BODY_V1 }, { Body: BODY_V2 });
    expect(reimport).toEqual({
      body: JSON.stringify(BODY_V2),
      fromS3: false,
      bodyS3Location: undefined,
      basePath: undefined,
      failOnWarnings: undefined,
    });
  });

  it('passes a string Body through as it is', () => {
    const text = JSON.stringify(BODY_V2);
    const { reimport } = splitApiGatewayV2ImportPatch([], { Body: 'old' }, { Body: text });
    expect(reimport?.body).toBe(text);
  });

  it.each([
    ['BasePath', { Body: BODY_V1, BasePath: 'ignore' }, { Body: BODY_V1, BasePath: 'split' }],
    ['FailOnWarnings', { Body: BODY_V1 }, { Body: BODY_V1, FailOnWarnings: false }],
  ])('a %s change alone reimports the unchanged definition', (_key, previous, desired) => {
    const { reimport } = splitApiGatewayV2ImportPatch([], previous, desired);
    expect(reimport?.body).toBe(JSON.stringify(BODY_V1));
  });

  it.each([
    [true, true],
    ['true', true],
    [false, false],
    ['false', false],
    ['yes', undefined],
  ] as const)('reads FailOnWarnings %j as %j', (spelled, read) => {
    const { reimport } = splitApiGatewayV2ImportPatch(
      [],
      { Body: BODY_V1 },
      { Body: BODY_V2, FailOnWarnings: spelled }
    );
    expect(reimport?.failOnWarnings).toBe(read);
  });

  it('marks a BodyS3Location definition', () => {
    const { reimport } = splitApiGatewayV2ImportPatch(
      [],
      { BodyS3Location: { Bucket: 'b', Key: 'v1' } },
      { BodyS3Location: { Bucket: 'b', Key: 'v2' } }
    );
    expect(reimport).toMatchObject({
      fromS3: true,
      body: undefined,
      bodyS3Location: { Bucket: 'b', Key: 'v2' },
    });
  });

  it('re-sends a declared Description the patch has no op on, only beside a reimport', () => {
    const withDesc = splitApiGatewayV2ImportPatch(
      [],
      { Body: BODY_V1, Description: 'declared' },
      { Body: BODY_V2, Description: 'declared' }
    );
    expect(withDesc.rest).toEqual([{ op: 'add', path: '/Description', value: 'declared' }]);

    const changedDesc: JsonPatchOp = { op: 'replace', path: '/Description', value: 'new' };
    const ownOp = splitApiGatewayV2ImportPatch(
      [changedDesc],
      { Body: BODY_V1, Description: 'old' },
      { Body: BODY_V2, Description: 'new' }
    );
    expect(ownOp.rest).toEqual([changedDesc]);

    const noReimport = splitApiGatewayV2ImportPatch(
      [],
      { Body: BODY_V1, Description: 'declared' },
      { Body: BODY_V1, Description: 'declared' }
    );
    expect(noReimport.rest).toEqual([]);
  });

  it('asks for no reimport when no import key changed', () => {
    const { reimport } = splitApiGatewayV2ImportPatch(
      [{ op: 'add', path: '/Body', value: BODY_V1 }],
      { Body: BODY_V1, Description: 'a' },
      { Body: BODY_V1, Description: 'b' }
    );
    expect(reimport).toBeUndefined();
  });
});

describe('isApiGatewayV2Import (go-to-k/cdkd#5260)', () => {
  it('holds for the Api type importing through Body or BodyS3Location only', () => {
    expect(isApiGatewayV2Import(TYPE, { Body: BODY_V1 })).toBe(true);
    expect(isApiGatewayV2Import(TYPE, { BodyS3Location: { Bucket: 'b', Key: 'k' } })).toBe(true);
    expect(isApiGatewayV2Import(TYPE, { Name: 't', ProtocolType: 'HTTP' })).toBe(false);
    expect(isApiGatewayV2Import('AWS::ApiGatewayV2::Stage', { Body: BODY_V1 })).toBe(false);
  });
});

describe('apiGatewayV2DefinitionObject (go-to-k/cdkd#5264)', () => {
  it('reads the CloudFormation shape, empty Version / Etag as absent', () => {
    expect(apiGatewayV2DefinitionObject({ Bucket: 'b', Key: 'k' })).toEqual({
      bucket: 'b',
      key: 'k',
      version: undefined,
      etag: undefined,
    });
    expect(
      apiGatewayV2DefinitionObject({ Bucket: 'b', Key: 'k', Version: 'v', Etag: '"e"' })
    ).toEqual({ bucket: 'b', key: 'k', version: 'v', etag: '"e"' });
    expect(apiGatewayV2DefinitionObject({ Bucket: 'b', Key: 'k', Version: '', Etag: '' })).toEqual(
      { bucket: 'b', key: 'k', version: undefined, etag: undefined }
    );
  });

  it.each([
    ['a string', 's3://b/k'],
    ['null', null],
    ['an array', [{ Bucket: 'b', Key: 'k' }]],
    ['no Key', { Bucket: 'b' }],
    ['an empty Bucket', { Bucket: '', Key: 'k' }],
    ['a numeric Version', { Bucket: 'b', Key: 'k', Version: 3 }],
    ['an object Etag', { Bucket: 'b', Key: 'k', Etag: {} }],
  ])('refuses %s', (_label, location) => {
    expect(apiGatewayV2DefinitionObject(location)).toBeUndefined();
  });
});
