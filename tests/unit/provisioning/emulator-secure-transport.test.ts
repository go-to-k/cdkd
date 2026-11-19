import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

const warn = vi.fn();
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ warn, debug: vi.fn(), info: vi.fn(), error: vi.fn() }),
}));

import { setAwsEndpointOverrideSource } from '../../../src/utils/aws-client-defaults.js';
import {
  isInsecureTransportDeny,
  policyDocumentForEmulator,
  serializeResourcePolicy,
} from '../../../src/provisioning/emulator-secure-transport.js';

const EMULATOR = { endpoint: 'https://127.0.0.1:9297' };

// The statement aws-cdk-lib's `enforceSSL: true` emits.
const ENFORCE_SSL = {
  Action: 'sqs:*',
  Condition: { Bool: { 'aws:SecureTransport': 'false' } },
  Effect: 'Deny',
  Principal: { AWS: '*' },
  Resource: 'arn:aws:sqs:us-east-1:000000000000:q',
};
const ALLOW_EVENTS = {
  Action: 'sqs:SendMessage',
  Effect: 'Allow',
  Principal: { Service: 'events.amazonaws.com' },
  Resource: 'arn:aws:sqs:us-east-1:000000000000:q',
};
const DOC = { Version: '2012-10-17', Statement: [ENFORCE_SSL, ALLOW_EVENTS] };

afterEach(() => {
  setAwsEndpointOverrideSource(undefined);
  warn.mockReset();
});

describe('isInsecureTransportDeny', () => {
  it.each([
    ['the enforceSSL statement', ENFORCE_SSL],
    ['a boolean false', { ...ENFORCE_SSL, Condition: { Bool: { 'aws:SecureTransport': false } } }],
    ['a one-element array', { ...ENFORCE_SSL, Condition: { Bool: { 'aws:SecureTransport': ['false'] } } }],
    ['BoolIfExists and a lower-case key', { ...ENFORCE_SSL, Condition: { BoolIfExists: { 'aws:securetransport': 'FALSE' } } }],
    [
      'other conditions beside it',
      { ...ENFORCE_SSL, Condition: { Bool: { 'aws:SecureTransport': 'false' }, StringEquals: { 'aws:SourceAccount': '1' } } },
    ],
  ])('matches %s', (_label, statement) => {
    expect(isInsecureTransportDeny(statement)).toBe(true);
  });

  it.each([
    ['an Allow', { ...ENFORCE_SSL, Effect: 'Allow' }],
    ['the value true', { ...ENFORCE_SSL, Condition: { Bool: { 'aws:SecureTransport': 'true' } } }],
    ['both values', { ...ENFORCE_SSL, Condition: { Bool: { 'aws:SecureTransport': ['false', 'true'] } } }],
    ['the Null operator', { ...ENFORCE_SSL, Condition: { Null: { 'aws:SecureTransport': 'false' } } }],
    ['another key', { ...ENFORCE_SSL, Condition: { Bool: { 'aws:MultiFactorAuthPresent': 'false' } } }],
    ['no condition', { ...ENFORCE_SSL, Condition: undefined }],
    ['a non-object', 'Deny'],
  ])('leaves %s alone', (_label, statement) => {
    expect(isInsecureTransportDeny(statement)).toBe(false);
  });
});

describe('policyDocumentForEmulator', () => {
  it('returns the document itself without --aws-emulator', () => {
    expect(policyDocumentForEmulator(DOC, 'AWS::SQS::QueuePolicy', 'P')).toBe(DOC);
    expect(warn).not.toHaveBeenCalled();
  });

  it('drops the enforceSSL Deny under --aws-emulator and warns naming the resource', () => {
    setAwsEndpointOverrideSource(() => EMULATOR);
    expect(policyDocumentForEmulator(DOC, 'AWS::SQS::QueuePolicy', 'QPolicy')).toEqual({
      Version: '2012-10-17',
      Statement: [ALLOW_EVENTS],
    });
    expect(DOC.Statement).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('a Deny statement on aws:SecureTransport out of QPolicy (AWS::SQS::QueuePolicy)');
  });

  it('parses a string document', () => {
    setAwsEndpointOverrideSource(() => EMULATOR);
    expect(policyDocumentForEmulator(JSON.stringify(DOC), 'AWS::SNS::TopicPolicy', 'T')).toEqual({
      Version: '2012-10-17',
      Statement: [ALLOW_EVENTS],
    });
  });

  it.each([
    ['no matching statement', { Statement: [ALLOW_EVENTS] }],
    ['a single Statement object', { Statement: ENFORCE_SSL }],
    ['an unparseable string', '{not json'],
  ])('returns the document unchanged for %s', (_label, document) => {
    setAwsEndpointOverrideSource(() => EMULATOR);
    expect(policyDocumentForEmulator(document, 'AWS::S3::BucketPolicy', 'B')).toBe(document);
    expect(warn).not.toHaveBeenCalled();
  });

  // A policy of only the enforceSSL Deny denies every request on the emulator
  // (an SQS event source mapping's receive among them), so none is sent.
  it.each([
    ['an object', { Statement: [ENFORCE_SSL] }],
    ['a string', JSON.stringify({ Statement: [ENFORCE_SSL] })],
  ])('sends no policy for %s holding only the Deny, warning so', (_label, document) => {
    setAwsEndpointOverrideSource(() => EMULATOR);
    expect(policyDocumentForEmulator(document, 'AWS::SQS::QueuePolicy', 'Q')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('so no policy is set');
  });

  it('keeps a policy of only the Deny against AWS', () => {
    const document = { Statement: [ENFORCE_SSL] };
    expect(policyDocumentForEmulator(document, 'AWS::SQS::QueuePolicy', 'Q')).toBe(document);
  });
});

describe('serializeResourcePolicy', () => {
  it('passes a string through and stringifies an object off the emulator', () => {
    expect(serializeResourcePolicy('{"a":1}', 'AWS::SQS::QueuePolicy', 'P')).toBe('{"a":1}');
    expect(serializeResourcePolicy(DOC, 'AWS::SQS::QueuePolicy', 'P')).toBe(JSON.stringify(DOC));
  });

  it('sends the filtered document under --aws-emulator', () => {
    setAwsEndpointOverrideSource(() => EMULATOR);
    expect(JSON.parse(serializeResourcePolicy(DOC, 'AWS::S3::BucketPolicy', 'B')!)).toEqual({
      Version: '2012-10-17',
      Statement: [ALLOW_EVENTS],
    });
  });
});
