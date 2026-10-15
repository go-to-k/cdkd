/**
 * go-to-k/cdkd#4946: the mark a provider's `delete()` puts on the error it
 * throws once it has stripped the resource, and how the replacement verdict
 * reads it.
 */
import { describe, it, expect } from 'vite-plus/test';
import { isDeleteStarted, markDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { replacedDeleteFailureVerdict } from '../../../src/deployment/rollback-executor/replaced-survivor.js';
import { maskSecretsInError } from '../../../src/deployment/secret-redaction.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { awsSdkError } from '../_aws-sdk-error.js';

const refusal = (): Error => Object.assign(new Error('not authorized'), { name: 'AccessDenied' });

describe('markDeleteStarted / isDeleteStarted', () => {
  it('marks the error itself, non-enumerably, and returns it', () => {
    const error = refusal();
    const keys = Object.keys(error);
    const json = JSON.stringify(error);
    expect(isDeleteStarted(error)).toBe(false);
    expect(markDeleteStarted(error)).toBe(error);
    expect(isDeleteStarted(error)).toBe(true);
    expect(Object.keys(error)).toEqual(keys);
    expect(JSON.stringify(error)).toBe(json);
  });

  it('reads the mark anywhere on the bounded cause chain', () => {
    const inner = markDeleteStarted(refusal());
    const outer = new Error('outer', { cause: new Error('mid', { cause: inner }) });
    expect(isDeleteStarted(outer)).toBe(true);
    // Beyond the bound, a cycle, or no mark: false, never a throw.
    let deep: Error = markDeleteStarted(refusal());
    for (let i = 0; i < 12; i++) deep = new Error(`wrap ${i}`, { cause: deep });
    expect(isDeleteStarted(deep)).toBe(false);
    const cyclic = new Error('a') as Error & { cause?: unknown };
    cyclic.cause = cyclic;
    expect(isDeleteStarted(cyclic)).toBe(false);
    expect(isDeleteStarted(new Error('plain', { cause: refusal() }))).toBe(false);
  });

  it('leaves a primitive or frozen throw unmarked without throwing', () => {
    expect(markDeleteStarted('AccessDenied')).toBe('AccessDenied');
    expect(isDeleteStarted('AccessDenied')).toBe(false);
    expect(isDeleteStarted(undefined)).toBe(false);
    const frozen = Object.freeze(refusal());
    expect(markDeleteStarted(frozen)).toBe(frozen);
    expect(isDeleteStarted(frozen)).toBe(false);
  });

  it("survives maskSecretsInError's clone of the chain", () => {
    const aws = awsSdkError('User is not authorized to delete s3cr3tvalue.');
    const top = markDeleteStarted(
      new ProvisioningError(`Failed: ${aws.message}`, 'AWS::IAM::Role', 'Role', 'p', aws)
    );
    const masked = maskSecretsInError(top, new Map(), (t) => t.replace('s3cr3tvalue', '***'));
    expect(masked).not.toBe(top);
    expect(masked.message).not.toContain('s3cr3tvalue');
    expect(isDeleteStarted(masked)).toBe(true);
  });
});

describe('replacedDeleteFailureVerdict reads the mark (#4946)', () => {
  it('is unconfirmed for an outright refusal from a delete that had stripped the resource', () => {
    expect(replacedDeleteFailureVerdict(markDeleteStarted(refusal()))).toBe('unconfirmed');
    // A provider wrapper marked above the AWS refusal it carries as its cause.
    const wrapped = markDeleteStarted(
      new ProvisioningError('Failed to delete IAM role R: denied', 'AWS::IAM::Role', 'R', 'r', refusal())
    );
    expect(replacedDeleteFailureVerdict(wrapped)).toBe('unconfirmed');
    // An engine wrapper above a marked provider error.
    expect(replacedDeleteFailureVerdict(new Error('engine', { cause: wrapped }))).toBe('unconfirmed');
  });

  it('keeps an unmarked refusal kept', () => {
    expect(replacedDeleteFailureVerdict(refusal())).toBe('kept');
    expect(
      replacedDeleteFailureVerdict(
        new ProvisioningError('Failed to delete IAM role R: denied', 'AWS::IAM::Role', 'R', 'r', refusal())
      )
    ).toBe('kept');
  });
});
