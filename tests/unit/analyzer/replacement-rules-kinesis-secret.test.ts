import { describe, it, expect } from 'vite-plus/test';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';

/**
 * Regression coverage for the missing-replacement-rule bug (bug-hunt 2026-06-29):
 * `AWS::Kinesis::Stream` and `AWS::SecretsManager::Secret` `Name` are immutable in
 * CloudFormation ("Update requires: Replacement"), but the registry had no rule
 * for either type, so it defaulted them to updateable. A rename was attempted as
 * an in-place update — AWS has no rename API, so the change was silently dropped
 * and cdkd's state diverged from AWS (deploy reported success; the resource kept
 * its old name). The fix adds replacement rules so a rename drives DELETE+CREATE.
 */
const KINESIS = 'AWS::Kinesis::Stream';
const SECRET = 'AWS::SecretsManager::Secret';

describe('ReplacementRulesRegistry — Kinesis Stream / SecretsManager Secret Name immutability', () => {
  const registry = new ReplacementRulesRegistry();

  it('requires replacement when Kinesis stream Name changes', () => {
    expect(registry.requiresReplacement(KINESIS, 'Name', 'stream-v1', 'stream-v2')).toBe(true);
  });

  it('requires replacement when Secret Name changes', () => {
    expect(registry.requiresReplacement(SECRET, 'Name', 'secret-v1', 'secret-v2')).toBe(true);
  });

  it.each(['RetentionPeriodHours', 'ShardCount', 'StreamModeDetails', 'StreamEncryption', 'Tags'])(
    'does NOT require replacement when Kinesis stream %s changes (in-place)',
    (prop) => {
      expect(registry.requiresReplacement(KINESIS, prop, 'old', 'new')).toBe(false);
    }
  );

  it.each(['Description', 'KmsKeyId', 'SecretString', 'GenerateSecretString', 'ReplicaRegions', 'Tags'])(
    'does NOT require replacement when Secret %s changes (in-place)',
    (prop) => {
      expect(registry.requiresReplacement(SECRET, prop, 'old', 'new')).toBe(false);
    }
  );
});
