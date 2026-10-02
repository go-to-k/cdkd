/**
 * Issue #2075 — the RUNTIME twin of `scripts/check-provider-error-cause.ts`'s
 * cause-composer registry.
 *
 * The critic accepts a call to a REGISTERED composer as a threaded cause
 * without reading the composer's body. This file is what earns that trust: for
 * every registered composer, a cause DERIVED by it and wrapped in a `CdkdError`
 * must still classify the way the original does under all three classifiers
 * that walk `.cause`. The same harness run over an inert composer
 * (`new Error(err.message)`) must fail every case, so a pass here is a verdict
 * about the composer and not about the harness.
 */
import { describe, expect, it } from 'vite-plus/test';

import { CAUSE_COMPOSERS } from '../../../scripts/check-provider-error-cause.ts';
import {
  isMarkedNonRetryable,
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
} from '../../../src/deployment/retryable-errors.js';
import { maskSecretsInError } from '../../../src/deployment/secret-redaction.js';
import { redactedDockerCause } from '../../../src/utils/docker-cmd.js';
import { AssetError, normalizeAwsError } from '../../../src/utils/error-handler.js';

const SECRET = 'hunter2-composer-secret';

interface Composer {
  /** Shapes the input so the composer takes its DERIVING arm, not identity. */
  readonly prepare: (inner: Error) => Error;
  readonly derive: (inner: Error) => Error | undefined;
  /** Signals this composer's deriving arm can be handed; default all. */
  readonly signals?: readonly Signal[];
}

/** One entry per registered composer — the registry is compared against this. */
const COMPOSERS: Record<string, Composer> = {
  redactedDockerCause: {
    prepare: (inner) => inner,
    derive: (inner) => redactedDockerCause(inner, ['push', 'repo:tag']),
  },
  normalizeAwsError: {
    // Only the SDK's synthetic `Unknown` is rewritten; anything else is
    // returned by identity, which would prove nothing about the rewrite.
    prepare: (inner) => {
      inner.name = 'Unknown';
      inner.message = 'UnknownError';
      return inner;
    },
    derive: (inner) => normalizeAwsError(inner, { bucket: 'state-bucket', operation: 'PutObject' }),
    // Its deriving arm needs `name: 'Unknown'`, which is never a throttle
    // NAME, so the name-only signal cannot reach that arm at all.
    signals: ['throttling', 'transient', 'non-retryable'],
  },
  maskSecretsInError: {
    // A bag with nothing to mask is returned by identity, so the message
    // carries the secret and the composer must CLONE.
    prepare: (inner) => {
      inner.message = `${inner.message} ${SECRET}`;
      return inner;
    },
    derive: (inner) => maskSecretsInError(
        inner,
        // plaintext -> the `{{resolve:...}}` expression it came from
        new Map([[SECRET, '{{resolve:secretsmanager:db:SecretString:password}}']])
      ),
  },
};

const INERT: Composer = {
  prepare: (inner) => inner,
  derive: (inner) => new Error(inner.message),
};

type Signal = 'throttling' | 'throttling-by-name' | 'transient' | 'non-retryable';

function failure(signal: Signal): Error {
  const inner = new Error('upstream failure') as Error & Record<string, unknown>;
  if (signal === 'throttling') inner.$metadata = { httpStatusCode: 429 };
  // The realistic AWS throttle: a throttle NAME on an HTTP 400, which only
  // `isThrottlingError`'s name arm can see.
  if (signal === 'throttling-by-name') {
    inner.name = 'ThrottlingException';
    inner.$metadata = { httpStatusCode: 400 };
  }
  if (signal === 'transient') inner.$metadata = { httpStatusCode: 503 };
  if (signal === 'non-retryable') {
    inner.$metadata = { httpStatusCode: 400 };
    markNonRetryable(inner);
  }
  return inner;
}

const CLASSIFIER: Record<Signal, (error: unknown) => boolean> = {
  throttling: isThrottlingError,
  'throttling-by-name': isThrottlingError,
  transient: isTransientServerError,
  'non-retryable': isMarkedNonRetryable,
};

const SIGNALS: readonly Signal[] = [
  'throttling',
  'throttling-by-name',
  'transient',
  'non-retryable',
];

/** The classifier verdict through a wrapper whose cause the composer derived. */
function verdict(composer: Composer, signal: Signal): { derived: boolean; classified: boolean } {
  const inner = composer.prepare(failure(signal));
  // The original must carry the signal, or the case could not fail.
  expect(CLASSIFIER[signal](inner)).toBe(true);
  const cause = composer.derive(inner);
  const wrapper = new AssetError('wrapped failure', cause);
  return { derived: cause !== inner, classified: CLASSIFIER[signal](wrapper) };
}

describe('registered cause composers keep the classifier verdict (issue #2075)', () => {
  it('has a case for EVERY registered composer, and none that is not registered', () => {
    expect(Object.keys(COMPOSERS).sort()).toEqual([...CAUSE_COMPOSERS.keys()].sort());
  });

  for (const [name, composer] of Object.entries(COMPOSERS)) {
    for (const signal of composer.signals ?? SIGNALS) {
      it(`${name}: a ${signal} failure still classifies through the derived cause`, () => {
        const { derived, classified } = verdict(composer, signal);
        // The DERIVING arm ran: an identity return would pass for any composer.
        expect(derived).toBe(true);
        expect(classified).toBe(true);
      });
    }
  }

  it('maskSecretsInError: the derived cause carries no plaintext secret', () => {
    const composer = COMPOSERS['maskSecretsInError'];
    if (!composer) throw new Error('maskSecretsInError case missing');
    const inner = composer.prepare(failure('transient'));
    expect(inner.message).toContain(SECRET);
    const cause = composer.derive(inner);
    expect(cause?.message).not.toContain(SECRET);
  });

  it('the harness FAILS an inert composer on every signal (negative control)', () => {
    for (const signal of SIGNALS) {
      const { derived, classified } = verdict(INERT, signal);
      expect(derived).toBe(true);
      expect(classified, signal).toBe(false);
    }
  });

  it('the harness FAILS a dropped cause on every signal (negative control)', () => {
    for (const signal of SIGNALS) {
      expect(CLASSIFIER[signal](new AssetError('wrapped failure')), signal).toBe(false);
    }
  });
});
