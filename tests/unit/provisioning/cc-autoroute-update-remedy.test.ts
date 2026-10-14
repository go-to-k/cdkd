import { describe, it, expect } from 'vite-plus/test';
import { ccAutoRouteUpdateFailureRemedy } from '../../../src/provisioning/cc-autoroute-update-remedy.js';
import { isNotFoundMessage } from '../../../src/provisioning/cloud-control-provider.js';
import { isRetryableTransientError } from '../../../src/deployment/retryable-errors.js';
import { isNameCollisionError } from '../../../src/deployment/retryable-errors.js';

describe('ccAutoRouteUpdateFailureRemedy (#4904)', () => {
  it('names both flags with every auto-routed property', () => {
    const note = ccAutoRouteUpdateFailureRemedy('MyTopic', 'AWS::SNS::Topic', ['A', 'B']);
    expect(note).toContain('does not handle A, B');
    expect(note).toContain('--recreate-via-cc-api MyTopic');
    expect(note).toContain('--prefer-sdk-route AWS::SNS::Topic:A,AWS::SNS::Topic:B');
    expect(note).toContain('without sending those properties');
  });

  it('says "that property" for one', () => {
    expect(ccAutoRouteUpdateFailureRemedy('X', 'AWS::S::T', ['P'])).toContain(
      'without sending that property'
    );
  });

  it('replaces values that are not plain identifiers with placeholders', () => {
    const note = ccAutoRouteUpdateFailureRemedy('a b;rm', 'AWS::S::T$(x)', ['P q']);
    expect(note).toContain('--recreate-via-cc-api <logicalId>');
    expect(note).toContain('--prefer-sdk-route <Type>:<Property>');
    expect(note).not.toContain('rm');
    expect(note).not.toContain('$(x)');
  });

  it('trips none of the matchers that read the message it is appended to', () => {
    const note = ccAutoRouteUpdateFailureRemedy('MyTopic', 'AWS::SNS::Topic', ['ArchivePolicy']);
    const full = `UPDATE failed for MyTopic: Model validation failed${note}`;
    expect(isNotFoundMessage(note)).toBe(false);
    expect(isNotFoundMessage(full)).toBe(false);
    expect(isNameCollisionError(full)).toBe(false);
    expect(isRetryableTransientError(new Error(full), full)).toBe(false);
  });
});
