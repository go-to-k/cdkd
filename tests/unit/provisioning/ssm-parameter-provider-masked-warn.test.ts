/**
 * Issue #2176 — `SSMParameterProvider`'s masked log sinks.
 *
 * This provider is the reference implementation of the one-masked-sink shape
 * (`.claude/rules/providers.md`), and it is the highest-value place to get it
 * right: `AWS::SSM::Parameter`'s `Value` IS the secret. `Value` itself reaches
 * no message site — checked on every path — but `Name` reaches five, including
 * a paste-ready `aws ssm delete-parameter --name <value>` remediation line,
 * and `Name` is as resolvable from a `{{resolve:...}}` reference as anything
 * else in the bag.
 *
 * Since issue [#3136](https://github.com/go-to-k/cdkd/issues/3136) that line
 * renders through `renderDisableCommand` and is no longer hand-quoted, so the
 * value is BARE when it needs no quoting. That issue's security review also
 * found the sink alone is not enough for it: `shellQuote` rewrites an inner
 * `'` to `'\''`, and a message-level masker matches by literal occurrence, so
 * a secret-bearing name carrying a quote would come through this sink in
 * plaintext. The renderer is handed the masker and SUPPRESSES the command for
 * such a name instead; `pasteable-command-hand-quoted-ids.test.ts` pins that.
 *
 * The sink was shipped unfenced in the first cut of #2176; a review found that
 * two `update()` sites had already drifted back onto the raw logger three lines
 * below the sink that was supposed to make that impossible. Hence this file.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy, debugSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: () => Promise.resolve({ Account: '111122223333' }) },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import {
  hasRedactedCause,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';

const RESOURCE_TYPE = 'AWS::SSM::Parameter';
/** A parameter Name that came out of a resolved dynamic reference. */
const SECRET_NAME = '/app/secret-parameter-name';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

const maskSecrets = createSecretMasker(bagOf(SECRET_NAME));

function allLines(): string {
  return [...warnSpy.mock.calls, ...debugSpy.mock.calls].map((c) => String(c[0])).join('\n');
}

describe('SSMParameterProvider masked log sinks (issue #2176)', () => {
  let provider: SSMParameterProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SSMParameterProvider();
  });

  // The partial-create cleanup warning these cases used to pin (its pasteable
  // `aws ssm delete-parameter` command, suppressed for a secret-bearing Name)
  // is gone: the tags ride on PutParameter (go-to-k/cdkd#4971), so no call
  // follows it whose failure needs a cleanup.

  it('masks the Name across EVERY create() line, not just the one under test', async () => {
    mockSend.mockResolvedValue({});

    await provider.create(
      'MyParam',
      RESOURCE_TYPE,
      { Name: SECRET_NAME, Type: 'String', Value: 'v' },
      { maskSecrets }
    );

    // The sink's whole promise is "a line added later is masked by
    // construction", so this asserts over the WHOLE transcript rather than one
    // known line — which is what would have caught the two update() sites that
    // drifted back onto the raw logger.
    expect(allLines()).not.toContain(SECRET_NAME);
    expect(allLines()).toContain(SECRET_MASK);
  });

  it('masks the Name across EVERY update() line — the sites that had drifted', async () => {
    mockSend.mockResolvedValue({ Parameter: { Version: 2 } });

    await provider.update(
      'MyParam',
      SECRET_NAME,
      RESOURCE_TYPE,
      { Name: SECRET_NAME, Type: 'String', Value: 'v2', Tags: [{ Key: 'k', Value: 'v' }] },
      { Name: SECRET_NAME, Type: 'String', Value: 'v1' },
      { maskSecrets }
    );

    expect(allLines()).not.toContain(SECRET_NAME);
    expect(allLines()).toContain(SECRET_MASK);
  });

  it('leaves a NON-secret Name alone — negative control', async () => {
    // Without this, a sink that blanked every line would pass the cases above.
    mockSend.mockResolvedValue({});

    await provider.create(
      'MyParam',
      RESOURCE_TYPE,
      { Name: '/app/ordinary-name', Type: 'String', Value: 'v' },
      { maskSecrets }
    );

    expect(allLines()).toContain('/app/ordinary-name');
  });

  it('behaves exactly as before when no context is supplied — the back-compatible default', async () => {
    // `create()` / `update()` are also reached from the import path, from
    // `cdkd drift --revert`, and from tests, and must not require the capability.
    mockSend.mockResolvedValue({});

    await provider.create('MyParam', RESOURCE_TYPE, {
      Name: SECRET_NAME,
      Type: 'String',
      Value: 'v',
    });

    expect(allLines()).toContain(SECRET_NAME);
  });
});

describe('a masked failure still classifies as retryable (issue #4244)', () => {
  /** A just-created KMS key PutParameter cannot see yet: `does not exist` is a retry-table entry. */
  const TRANSIENT = 'Key arn:aws:kms:us-east-1:111122223333:key/abcd does not exist';
  /** A recorded secret that spells part of that wording. */
  const retryMasker = createSecretMasker(bagOf('exist'));
  const retryable = (error: Error): boolean =>
    isRetryableTransientError(error, retryClassificationText(error));
  const failing = (message: string): Error =>
    Object.assign(new Error(message), {
      name: 'InvalidKeyId',
      $fault: 'client',
      $metadata: { httpStatusCode: 400 },
    });

  const SITES = [
    {
      site: 'create()',
      run: (masker: (t: string) => string) =>
        new SSMParameterProvider().create(
          'MyParam',
          RESOURCE_TYPE,
          { Name: '/app/plain', Type: 'String', Value: 'v' },
          { maskSecrets: masker }
        ),
    },
    {
      site: 'update()',
      run: (masker: (t: string) => string) =>
        new SSMParameterProvider().update(
          'MyParam',
          '/app/plain',
          RESOURCE_TYPE,
          { Name: '/app/plain', Type: 'String', Value: 'v2' },
          { Name: '/app/plain', Type: 'String', Value: 'v1' },
          { maskSecrets: masker }
        ),
    },
  ] as const;

  async function failureOf(run: () => Promise<unknown>): Promise<Error> {
    return run().then(
      () => {
        throw new Error('expected the operation to reject');
      },
      (e: unknown) => e as Error
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(SITES)('$site: the stamp keeps it retryable', async ({ run }) => {
    mockSend.mockRejectedValue(failing(TRANSIENT));
    const failure = await failureOf(() => run(retryMasker));
    // Premise: the mask cut the retry wording out of the message itself.
    expect(failure.message).not.toContain('does not exist');
    expect(isRetryableTransientError(failure, failure.message)).toBe(false);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(retryable(failure)).toBe(true);
  });

  it.each(SITES)('$site: a failure the mask left unchanged is not stamped', async ({ run }) => {
    mockSend.mockRejectedValue(failing('Bad request parameter'));
    const failure = await failureOf(() => run(retryMasker));
    expect(failure.message).toContain('Bad request parameter');
    expect(hasRedactedCause(failure)).toBe(false);
    expect(retryable(failure)).toBe(false);
  });
});
