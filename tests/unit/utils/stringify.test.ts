import { describe, it, expect } from 'vite-plus/test';
import { stringifyValue, stringifyAttributeForLog } from '../../../src/utils/stringify.js';

describe('stringifyAttributeForLog', () => {
  it('redacts credential-bearing attribute names (issue #1323)', () => {
    expect(stringifyAttributeForLog('SecretAccessKey', 'wJalrXUtnFEMI/K7MDENG')).toBe(
      '<redacted>'
    );
    expect(stringifyAttributeForLog('MasterUserPassword', 'hunter2')).toBe('<redacted>');
    expect(stringifyAttributeForLog('SecretString', 's3cr3t')).toBe('<redacted>');
  });

  it('renders non-sensitive attribute values verbatim', () => {
    expect(stringifyAttributeForLog('Arn', 'arn:aws:iam::1:user/x')).toBe('arn:aws:iam::1:user/x');
    expect(stringifyAttributeForLog('Endpoint.Port', 3306)).toBe('3306');
  });

  it('does not redact identifier attributes that merely mention "secret"', () => {
    expect(stringifyAttributeForLog('SecretArn', 'arn:aws:secretsmanager:us-east-1:1:secret/x')).toBe(
      'arn:aws:secretsmanager:us-east-1:1:secret/x'
    );
    expect(stringifyAttributeForLog('MasterUserSecret.SecretArn', 'arn:aws:...')).toBe(
      'arn:aws:...'
    );
  });
});

describe('stringifyValue', () => {
  it('renders primitives and objects stably', () => {
    expect(stringifyValue('s')).toBe('s');
    expect(stringifyValue(1)).toBe('1');
    expect(stringifyValue(null)).toBe('null');
    expect(stringifyValue({ a: 1 })).toBe('{"a":1}');
    expect(stringifyValue(undefined)).toBe('undefined');
  });
});
