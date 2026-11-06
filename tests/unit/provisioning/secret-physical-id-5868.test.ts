import { describe, it, expect } from 'vite-plus/test';
import {
  displayPhysicalId,
  maskedSecretSegment,
  secretPhysicalIdSegment,
  withSecretPhysicalIdMasked,
  withSecretPhysicalIdsMaskedInState,
} from '../../../src/provisioning/secret-physical-id.js';
import {
  journaledOrphanPrintingBag,
  orphanRecordsPrintingBag,
  secretNameNeedlesOf,
  secretNamePrintingBag,
} from '../../../src/deployment/secret-name-needles.js';
import { maskSecretsInText } from '../../../src/deployment/secret-redaction.js';
import type { ResourceState } from '../../../src/types/state.js';

// go-to-k/cdkd#5868: the one per-type declaration of a physical id that IS a
// bearer credential, and the needle and display arms built on it.

const API = 'abcdefghijklmnopqrstuvwxyz';
const KEY = 'da2-5868unitkeysecretvalue4321';
const ID = `${API}|${KEY}`;

describe('secretPhysicalIdSegment', () => {
  it('an AppSync ApiKey: the key segment only', () => {
    expect(secretPhysicalIdSegment('AWS::AppSync::ApiKey', ID)).toBe(KEY);
  });

  it('a malformed ApiKey id is secret WHOLE', () => {
    expect(secretPhysicalIdSegment('AWS::AppSync::ApiKey', KEY)).toBe(KEY);
    expect(secretPhysicalIdSegment('AWS::AppSync::ApiKey', `a|b|${KEY}`)).toBe(`a|b|${KEY}`);
    expect(secretPhysicalIdSegment('AWS::AppSync::ApiKey', '')).toBeUndefined();
    expect(secretPhysicalIdSegment('AWS::AppSync::ApiKey', undefined)).toBeUndefined();
  });

  it.each([
    // The PUBLIC half of an access key pair; the secret never is the id.
    ['AWS::IAM::AccessKey', 'AKIAIOSFODNN7EXAMPLE'],
    // A secret's id is its ARN, not its value.
    ['AWS::SecretsManager::Secret', 'arn:aws:secretsmanager:us-east-1:123456789012:secret:s-AbCdEf'],
    // Same shape, a type whose id is no credential.
    ['AWS::AppSync::DataSource', ID],
  ])('%s: undefined', (type, id) => {
    expect(secretPhysicalIdSegment(type, id)).toBeUndefined();
  });
});

describe('the ARN form a record imported before #5540 holds', () => {
  const arnId = (path: string): string => `arn:aws:appsync:us-east-1:123456789012:apis/${API}/${path}/${KEY}`;

  it.each(['apikeys', 'apikey'])('`%s/`: the key segment, not the whole ARN', (path) => {
    expect(secretPhysicalIdSegment('AWS::AppSync::ApiKey', arnId(path))).toBe(KEY);
    expect(displayPhysicalId('AWS::AppSync::ApiKey', arnId(path))).toBe(
      arnId(path).replace(KEY, '****4321')
    );
  });

  it("masks the key where the record's ApiKey attribute repeats it bare", () => {
    const record = {
      physicalId: arnId('apikeys'),
      resourceType: 'AWS::AppSync::ApiKey',
      properties: { ApiId: API },
      attributes: { ApiKey: KEY },
    };
    expect(JSON.stringify(withSecretPhysicalIdMasked(record))).not.toContain(KEY);
    // And the needle is the key itself, so a log line quoting it bare masks it.
    const needles = secretNameNeedlesOf('Key', record, undefined);
    expect(needles?.has(KEY)).toBe(true);
    expect(maskSecretsInText(`key ${KEY}`, secretNamePrintingBag('Key', { Key: record as never }))).toBe(
      'key ***'
    );
  });
});

describe('the display helpers', () => {
  it('mask a malformed id WHOLE, and never rewrite an object key', () => {
    // A malformed id that is also a substring of a record key (`attributes`).
    const record = {
      physicalId: 'tribu',
      resourceType: 'AWS::AppSync::ApiKey',
      properties: {},
      attributes: { Echo: 'tribu' },
    };
    expect(displayPhysicalId('AWS::AppSync::ApiKey', 'tribu')).toBe('****ribu');
    const shown = withSecretPhysicalIdMasked(record);
    expect(shown.physicalId).toBe('****ribu');
    expect(shown.attributes).toEqual({ Echo: '****ribu' });
    expect(Object.keys(shown)).toEqual(['physicalId', 'resourceType', 'properties', 'attributes']);
  });

  it("render the key as `****last4`, as AppSync's maskedApiKeyId does", () => {
    expect(maskedSecretSegment(KEY)).toBe('****4321');
    expect(displayPhysicalId('AWS::AppSync::ApiKey', ID)).toBe(`${API}|****4321`);
    expect(displayPhysicalId('AWS::AppSync::DataSource', ID)).toBe(ID);
  });

  it('mask a record copy (id and every leaf echoing the key), never the record', () => {
    const record: ResourceState = {
      physicalId: ID,
      resourceType: 'AWS::AppSync::ApiKey',
      properties: { ApiId: API },
      attributes: { ApiKey: KEY, Arn: `arn:x:apis/${API}/apikeys/${KEY}` },
      dependencies: [],
    };
    const shown = withSecretPhysicalIdMasked(record);
    expect(JSON.stringify(shown)).not.toContain(KEY);
    expect(shown.physicalId).toBe(`${API}|****4321`);
    expect(record.physicalId).toBe(ID);
    expect(record.attributes!['ApiKey']).toBe(KEY);
    const state = { resources: { Key: record }, orphans: [{ logicalId: 'O', state: record }] };
    expect(JSON.stringify(withSecretPhysicalIdsMaskedInState(state))).not.toContain(KEY);
    expect(JSON.stringify(state)).toContain(KEY);
  });
});

describe('the needle arm (secretNameNeedlesOf)', () => {
  const record = (resourceType: string): ResourceState => ({
    physicalId: ID,
    resourceType,
    properties: { ApiId: API },
    attributes: {},
    dependencies: [],
  });
  const line = `Deleting old Key (${ID}); GraphQLApi ${API}`;

  it.each([
    ['an AppSync ApiKey', 'AWS::AppSync::ApiKey', true],
    ['negative control, an AppSync DataSource', 'AWS::AppSync::DataSource', false],
  ])('adds the key segment, never the apiId: %s', (_l, type, masked) => {
    const needles = secretNameNeedlesOf('Key', record(type), undefined);
    expect(needles?.has(KEY) ?? false).toBe(masked);
    expect(needles?.has(API) ?? false).toBe(false);
    expect(needles?.has(ID) ?? false).toBe(false);
  });

  it.each([
    ['an AppSync ApiKey', 'AWS::AppSync::ApiKey', true],
    ['negative control, an AppSync DataSource', 'AWS::AppSync::DataSource', false],
  ])("cdkd destroy's per-resource printing bag: %s", (_l, type, masked) => {
    const out = maskSecretsInText(line, secretNamePrintingBag('Key', { Key: record(type) }));
    expect(out.includes(KEY)).toBe(!masked);
    expect(out).toContain(API);
  });

  it.each([
    ['an AppSync ApiKey', 'AWS::AppSync::ApiKey', true],
    ['negative control, an AppSync DataSource', 'AWS::AppSync::DataSource', false],
  ])("the orphan listing's bag (state.orphans): %s", (_l, type, masked) => {
    const out = maskSecretsInText(
      line,
      orphanRecordsPrintingBag([{ logicalId: 'Key', orphanedAt: 1, state: record(type) }])
    );
    expect(out.includes(KEY)).toBe(!masked);
    expect(out).toContain(API);
  });

  it.each([
    ['an AppSync ApiKey', 'AWS::AppSync::ApiKey', true],
    ['negative control, an AppSync DataSource', 'AWS::AppSync::DataSource', false],
  ])("a journaled orphan's bag (cdkd rollback's replay listing): %s", (_l, type, masked) => {
    const op = { logicalId: 'Key', resourceType: type, physicalId: ID, attemptedProperties: { ApiId: API } };
    const out = maskSecretsInText(line, journaledOrphanPrintingBag([op], {}));
    expect(out.includes(KEY)).toBe(!masked);
    expect(out).toContain(API);
  });
});
