/**
 * go-to-k/cdkd#7061 slice (c): the secret-path snapshot generator, offline.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';
import {
  buildSnapshot,
  extractSecretPaths,
  isSampledSecretName,
  secretNamedPaths,
  serializeSnapshot,
  SNAPSHOT_PATH,
} from '../../../scripts/refresh-registry-secret-paths.ts';
import { isSensitiveAttributeName } from '../../../src/utils/stringify.js';

const SCHEMA = {
  typeName: 'AWS::Test::Thing',
  properties: {
    MasterUserPassword: { type: 'string' },
    SecretArn: { type: 'string' },
    Name: { type: 'string' },
    Auth: { $ref: '#/definitions/Auth' },
    Users: { type: 'array', items: { $ref: '#/definitions/User' } },
    Loop: { $ref: '#/definitions/Loop' },
    Chained: { $ref: '#/definitions/Alias' },
    Either: { oneOf: [{ $ref: '#/definitions/Auth' }, { type: 'object', properties: { ClientSecret: { type: 'string' } } }] },
  },
  definitions: {
    Auth: { type: 'object', properties: { AuthToken: { type: 'string' }, Mode: { type: 'string' } } },
    User: { type: 'object', properties: { PrivateKey: { type: 'string' } } },
    Loop: { type: 'object', properties: { Next: { $ref: '#/definitions/Loop' }, Credentials: { type: 'string' } } },
    Alias: { $ref: '#/definitions/User' },
  },
  writeOnlyProperties: ['/properties/MasterUserPassword', '/properties/Auth/AuthToken'],
};

describe('refresh-registry-secret-paths (#7061)', () => {
  it('selects a name by the runtime heuristic as it is, or the sampling-only extras', () => {
    for (const name of ['MasterUserPassword', 'ClientSecret', 'Credentials']) {
      expect(isSensitiveAttributeName(name)).toBe(true);
      expect(isSampledSecretName(name)).toBe(true);
    }
    // Sampling only: the runtime heuristic is not widened.
    for (const name of ['AuthToken', 'PrivateKey', 'KeyMaterial', 'Passphrase', 'ApiKey']) {
      expect(isSensitiveAttributeName(name)).toBe(false);
      expect(isSampledSecretName(name)).toBe(true);
    }
    // An identifier the runtime heuristic leaves out stays out.
    expect(isSampledSecretName('SecretArn')).toBe(false);
    expect(isSampledSecretName('Name')).toBe(false);
  });

  it('walks $ref definitions (chained too), oneOf branches, array items and a cycle', () => {
    expect(secretNamedPaths(SCHEMA)).toEqual([
      ['Auth', 'AuthToken'],
      ['Chained', 'PrivateKey'],
      ['Either', 'AuthToken'],
      ['Either', 'ClientSecret'],
      // The cycle stops at the definition it re-enters.
      ['Loop', 'Credentials'],
      ['MasterUserPassword'],
      ['Users', '*', 'PrivateKey'],
    ]);
  });

  it('parses writeOnlyProperties with the runtime pointer parse', () => {
    expect(extractSecretPaths(JSON.stringify(SCHEMA))?.writeOnly).toEqual([
      ['Auth', 'AuthToken'],
      ['MasterUserPassword'],
    ]);
    expect(extractSecretPaths(JSON.stringify({ typeName: 'AWS::Test::None', properties: { Name: {} } }))).toBeUndefined();
  });

  it('refuses a truncated bundle', () => {
    expect(() => buildSnapshot(new Map([['a.json', JSON.stringify(SCHEMA)]]))).toThrow(/refusing to write a truncated snapshot/);
  });

  it('the committed snapshot is in the serialized form, one type per line', () => {
    const text = readFileSync(SNAPSHOT_PATH, 'utf8');
    const parsed = JSON.parse(text);
    expect(serializeSnapshot(parsed)).toBe(text);
    expect(Object.keys(parsed.types).length).toBeGreaterThanOrEqual(500);
    expect(SNAPSHOT_PATH).toBe(join(import.meta.dirname, '..', '..', 'fixtures', 'cfn-registry-secret-paths.json'));
  });
});
