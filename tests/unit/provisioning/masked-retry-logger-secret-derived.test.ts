/**
 * Issue #2177 -- `isSecretDerivedValue`, the predicate `withDerivedNameMasks`
 * uses to decide which derived names become needles, shared by the IAM, S3 and
 * Glue providers. A previous value persisted as exactly the redaction mask
 * (`***`, e.g. a NoEcho custom-resource `GetAtt` leaf) counts as secret-derived.
 */
import { describe, it, expect } from 'vite-plus/test';

import {
  createMaskedLogSinks,
  isSecretDerivedValue,
  withDerivedNameMasks,
} from '../../../src/provisioning/masked-retry-logger.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';

const identity = (t: string): string => t;
const silent = { debug: (): void => undefined, warn: (): void => undefined };

describe('isSecretDerivedValue (issue #2177)', () => {
  it('counts a value persisted as exactly *** as secret-derived, and nothing that merely contains it', () => {
    expect(isSecretDerivedValue(SECRET_MASK, identity)).toBe(true);
    expect(isSecretDerivedValue(`x${SECRET_MASK}`, identity)).toBe(false);
  });

  it('counts a {{resolve: reference and a value the masker changes, and nothing else', () => {
    expect(isSecretDerivedValue('{{resolve:secretsmanager:s}}', identity)).toBe(true);
    expect(isSecretDerivedValue('abc', (t) => t.replace('abc', SECRET_MASK))).toBe(true);
    expect(isSecretDerivedValue('plain', identity)).toBe(false);
    expect(isSecretDerivedValue('', identity)).toBe(false);
    expect(isSecretDerivedValue(42, identity)).toBe(false);
  });
});

describe('withDerivedNameMasks with a *** previous value (issue #2177)', () => {
  it('adds the recorded name as a needle', () => {
    const sinks = withDerivedNameMasks(silent, createMaskedLogSinks(silent, undefined), [
      [SECRET_MASK, 'oldplainname'],
    ]);
    expect(sinks.mask('arn:.../oldplainname')).toBe(`arn:.../${SECRET_MASK}`);
  });
});
