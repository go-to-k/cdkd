/**
 * Issue #2177 — the Secrets Manager slice: `create()` / `update()` log and
 * refuse through ONE masked sink set per operation.
 *
 * The provider's own log lines reach no engine sink, and the physical id it
 * prints is an ARN embedding the secret's `Name`. A `Name` resolved from a
 * `{{resolve:secretsmanager:...}}` reference therefore printed in plaintext,
 * and a short one survived the engine's message-level mask on a thrown
 * message too (the substring arm skips needles under `MIN_NEEDLE_LENGTH`).
 *
 * The secrets are sized for the arm each case must isolate:
 *
 *  - `TINY` (2 characters) is below both the masker's substring floor and the
 *    provider's 3-character needle floor, and appears in no fixed wording, so
 *    on a line cdkd writes ONLY the whole-value arm -- a raw `v(...)` over the
 *    name or an ARN naming it -- can remove it;
 *  - `SHORT` (3 characters) is below the masker's substring floor but at the
 *    needle floor, so it discriminates the needle on AWS echo text;
 *  - `LONG` is caught by the message-level mask alone; it is the control that
 *    the sinks do not break the ordinary path.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, warnSpy, debugSpy } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warnSpy: vi.fn(),
  debugSpy: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    secretsManager: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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
  return { getLogger: () => ({ child: () => childLogger }) };
});

import {
  CreateSecretCommand,
  ReplicateSecretToRegionsCommand,
  TagResourceCommand,
  UpdateSecretCommand,
} from '@aws-sdk/client-secrets-manager';
import { SecretsManagerSecretProvider } from '../../../src/provisioning/providers/secretsmanager-secret-provider.js';
import { createSecretMasker } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';

const TYPE = 'AWS::SecretsManager::Secret';
const TINY = 'qx';
const SHORT = 'q7z';
const LONG = 'db-master-credentials';
const ROTATED_OLD = 'jv';

const arnOf = (name: string): string =>
  `arn:aws:secretsmanager:us-east-1:123456789012:secret:${name}-AbCdEf`;

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

const maskSecrets = createSecretMasker(bagOf(TINY, SHORT, LONG));

/** A marker masker: a line routed through the sinks STARTS with the marker. */
const MARK = '[masked]';
const markingMasker = (text: string): string => (text.startsWith(MARK) ? text : MARK + text);

function transcript(): string {
  return [...debugSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0])).join('\n');
}

function debugLines(): string[] {
  return debugSpy.mock.calls.map((c) => String(c[0]));
}

async function thrown(run: () => Promise<unknown>): Promise<Error> {
  const err = await run().then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  return err as Error;
}

/** Answers CreateSecret with the ARN of `name`, every other command with `{}`. */
function answerCreateWith(name: string): void {
  mockSend.mockImplementation(async (cmd: unknown) =>
    cmd instanceof CreateSecretCommand ? { ARN: arnOf(name) } : {}
  );
}

describe('SecretsManagerSecretProvider create() masking (#2177)', () => {
  let provider: SecretsManagerSecretProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SecretsManagerSecretProvider();
  });

  it('masks a 2-character secret Name inside the returned ARN (whole-value ARN arm)', async () => {
    answerCreateWith(TINY);
    await provider.create('Secret', TYPE, { Name: TINY, SecretString: 'v' }, { maskSecrets });
    expect(transcript()).not.toContain(TINY);
    expect(debugLines()).toContain('Successfully created secret Secret: ***');
  });

  it('masks a long secret Name inside the returned ARN', async () => {
    answerCreateWith(LONG);
    await provider.create('Secret', TYPE, { Name: LONG, SecretString: 'v' }, { maskSecrets });
    expect(transcript()).not.toContain(LONG);
    expect(debugLines()).toContain('Successfully created secret Secret: ***');
  });

  it('masks a 3-character secret Name that an AWS error quotes back (needle arm)', async () => {
    mockSend.mockRejectedValue(new Error(`The operation failed because the secret ${SHORT} already exists.`));
    const err = await thrown(() =>
      provider.create('Secret', TYPE, { Name: SHORT, SecretString: 'v' }, { maskSecrets })
    );
    expect(err.message).toBe(
      'Failed to create secret Secret: The operation failed because the secret *** already exists.'
    );
  });

  it('masks the ARN of a 2-character secret Name that a CreateSecret failure quotes back', async () => {
    // No pair names the ARN before CreateSecret answers, and the name is below
    // the needle floor: only the in-text ARN arm can mask it.
    mockSend.mockRejectedValue(new Error(`Conflict on ${arnOf(TINY)}.`));
    const err = await thrown(() =>
      provider.create('Secret', TYPE, { Name: TINY, SecretString: 'v' }, { maskSecrets })
    );
    expect(err.message).toBe('Failed to create secret Secret: Conflict on ***.');
    // The cause is threaded UNMASKED, so the retry classifiers still read it.
    expect((err.cause as Error).message).toContain(arnOf(TINY));
  });

  /** The create-failure message for AWS text `aws`, with `TINY` as the secret Name. */
  async function createFailureFor(aws: string): Promise<string> {
    mockSend.mockRejectedValue(new Error(aws));
    const err = await thrown(() =>
      provider.create('Secret', TYPE, { Name: TINY, SecretString: 'v' }, { maskSecrets })
    );
    return err.message.replace('Failed to create secret Secret: ', '');
  }

  it.each([
    ['JSON-quoted, beside another suffixed token', `{"SecretId":"${arnOf(TINY)}","Other":"a-bcdefg"}`, '{"SecretId":"***","Other":"a-bcdefg"}'],
    ['comma-joined with an ordinary ARN', `${arnOf(TINY)},${arnOf('plain-name')}`, `***,${arnOf('plain-name')}`],
    // The run's character class stops at `,`: wider, the ordinary ARN's run
    // would swallow the secret one after it and print it.
    ['after an ordinary ARN', `${arnOf('plain-name')},${arnOf(TINY)}`, `${arnOf('plain-name')},***`],
    // The rest of a name-legal run goes with the ARN: it may hold a longer
    // secret, and over-masking is the safe direction.
    ['followed by a path that is legal in a name', `${arnOf(TINY)}/version-AbCdEf`, '***'],
    ['followed by a second suffix', `${arnOf(TINY)}-ZZZZZZ.`, '***.'],
  ])('masks a quoted secret ARN %s, and only that ARN', async (_shape, aws, masked) => {
    expect(await createFailureFor(aws)).toBe(masked);
  });

  it('masks the quoted ARN even when another bag secret equals part of its fixed text', async () => {
    // A secret equal to `secret`, run first, would rewrite the ARN's own
    // wording and defeat the arm; the arm runs on the raw text instead.
    mockSend.mockRejectedValue(new Error(`on ${arnOf(TINY)} end`));
    const err = await thrown(() =>
      provider.create(
        'Secret',
        TYPE,
        { Name: TINY, SecretString: 'v' },
        { maskSecrets: createSecretMasker(bagOf(TINY, 'secret')) }
      )
    );
    expect(err.message).not.toContain(`${TINY}-`);
    expect(err.message).toMatch(/: on \*\*\* end$/);
  });

  it('keeps a token that only LOOKS like the secret ARN (a 7-character suffix)', async () => {
    const lookalike = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${TINY}-AbCdEfg`;
    expect(await createFailureFor(`Bad id ${lookalike}.`)).toBe(`Bad id ${lookalike}.`);
  });

  it('restores a long trailing run of dots in linear time', async () => {
    const dots = '.'.repeat(100_000);
    const started = Date.now();
    expect(await createFailureFor(`${arnOf(TINY)}${dots}a`)).toBe('***');
    expect(await createFailureFor(`${arnOf(TINY)}${dots}`)).toBe(`***${dots}`);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('scans a long run with no whitespace in linear time', async () => {
    const run = 'arn:a:secretsmanager:::secret:'.repeat(30_000);
    const started = Date.now();
    expect(await createFailureFor(run)).toBe(run);
    // Generous: the quadratic scan this pins took seconds at a third of this size.
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('keeps a 2-character secret that occurs in cdkd wording from masking that wording', async () => {
    // `se` is in `secret`: below the needle floor it is no needle, so the fixed
    // wording survives while the ARN naming it is masked whole.
    const masker = createSecretMasker(bagOf('se'));
    answerCreateWith('se');
    await provider.create('Secret', TYPE, { Name: 'se', SecretString: 'v' }, { maskSecrets: masker });
    expect(debugLines()).toEqual(
      expect.arrayContaining(['Creating secret Secret', 'Successfully created secret Secret: ***'])
    );
  });

  it('masks the AWS error text RAW, so a whole-value 2-character echo is caught', async () => {
    mockSend.mockRejectedValue(new Error(TINY));
    const err = await thrown(() =>
      provider.create('Secret', TYPE, { Name: 'plain-name', SecretString: 'v' }, { maskSecrets })
    );
    expect(err.message).toBe('Failed to create secret Secret: ***');
  });

  it('keeps the ARN of an ordinary Name intact (no over-masking)', async () => {
    answerCreateWith('plain-name');
    await provider.create('Secret', TYPE, { Name: 'plain-name', SecretString: 'v' }, { maskSecrets });
    expect(debugLines()).toContain(`Successfully created secret Secret: ${arnOf('plain-name')}`);
  });

  it('logs unmasked when no masker is supplied (the back-compatible default)', async () => {
    answerCreateWith(TINY);
    await provider.create('Secret', TYPE, { Name: TINY, SecretString: 'v' });
    expect(debugLines()).toContain(`Successfully created secret Secret: ${arnOf(TINY)}`);
  });

  it('routes every create line, the no-value warning included, through the sink', async () => {
    answerCreateWith('plain-name');
    await provider.create('Secret', TYPE, { Name: 'plain-name' }, { maskSecrets: markingMasker });
    const lines = [...debugSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0]));
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(lines.filter((l) => !l.startsWith(MARK))).toEqual([]);
  });
});

describe('SecretsManagerSecretProvider update() masking (#2177)', () => {
  let provider: SecretsManagerSecretProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SecretsManagerSecretProvider();
    mockSend.mockResolvedValue({});
  });

  /** An update that walks every logging arm: tags, replicas, success. */
  async function fullUpdate(
    name: unknown,
    previousName: unknown,
    arnName: string,
    masker: (t: string) => string = maskSecrets
  ): Promise<void> {
    await provider.update(
      'Secret',
      arnOf(arnName),
      TYPE,
      {
        Name: name,
        SecretString: 'v',
        Tags: [{ Key: 'k', Value: 'v2' }],
        ReplicaRegions: [{ Region: 'us-west-2' }],
      },
      { Name: previousName, SecretString: 'v', Tags: [{ Key: 'k', Value: 'v1' }] },
      { maskSecrets: masker }
    );
    // The arms under test really ran.
    expect(mockSend.mock.calls.some((c) => c[0] instanceof TagResourceCommand)).toBe(true);
    expect(mockSend.mock.calls.some((c) => c[0] instanceof ReplicateSecretToRegionsCommand)).toBe(
      true
    );
  }

  it('masks the physical id on every line when the desired Name is a 2-character secret', async () => {
    await fullUpdate(TINY, TINY, TINY);
    expect(transcript()).not.toContain(TINY);
    expect(debugLines()).toEqual(
      expect.arrayContaining([
        'Updating secret Secret: ***',
        'Updated tags for secret ***',
        'Updated replica regions for secret ***',
      ])
    );
  });

  it('masks a ROTATED recorded name the deploy has no plaintext for (previous Name is a reference)', async () => {
    // The recorded ARN names the OLD secret value, which is in no bag of this
    // deploy; state kept the Name as its reference. The desired Name is an
    // ordinary one, so only the PREVIOUS value can mark the ARN secret.
    await fullUpdate('plain-name', '{{resolve:secretsmanager:old-name}}', ROTATED_OLD);
    expect(transcript()).not.toContain(ROTATED_OLD);
    expect(transcript()).not.toContain(arnOf(ROTATED_OLD));
    expect(debugLines()).toContain('Updating secret Secret: ***');
  });

  it('masks a recorded name whose previous Name was persisted as the bare mask', async () => {
    await fullUpdate('plain-name', '***', ROTATED_OLD);
    expect(transcript()).not.toContain(ROTATED_OLD);
    expect(debugLines()).toContain('Updating secret Secret: ***');
  });

  it('keeps an ordinary physical id intact (no over-masking)', async () => {
    await fullUpdate('plain-name', 'plain-name', 'plain-name');
    expect(debugLines()).toContain(`Updating secret Secret: ${arnOf('plain-name')}`);
    expect(debugLines()).toContain(`Updated tags for secret ${arnOf('plain-name')}`);
  });

  it('logs unmasked when no masker is supplied', async () => {
    await provider.update(
      'Secret',
      arnOf(TINY),
      TYPE,
      { Name: TINY, SecretString: 'v' },
      { Name: TINY, SecretString: 'v' }
    );
    expect(debugLines()).toContain(`Updating secret Secret: ${arnOf(TINY)}`);
  });

  it('masks a 3-character secret name an UpdateSecret failure quotes back', async () => {
    mockSend.mockRejectedValue(new Error(`Secret ${SHORT} is scheduled for deletion.`));
    const err = await thrown(() =>
      provider.update(
        'Secret',
        arnOf(SHORT),
        TYPE,
        { Name: SHORT, SecretString: 'new' },
        { Name: SHORT, SecretString: 'old' },
        { maskSecrets }
      )
    );
    expect(err.message).toBe('Failed to update secret Secret: Secret *** is scheduled for deletion.');
    // The cause is threaded UNMASKED, so the retry classifiers still read it.
    expect((err.cause as Error).message).toContain(SHORT);
  });

  it('masks a rotated name an UpdateSecret failure quotes back as a full ARN', async () => {
    mockSend.mockRejectedValue(new Error(`Access denied to ${arnOf(ROTATED_OLD)}`));
    const err = await thrown(() =>
      provider.update(
        'Secret',
        arnOf(ROTATED_OLD),
        TYPE,
        { Name: 'plain-name', SecretString: 'new' },
        { Name: '{{resolve:secretsmanager:old-name}}', SecretString: 'old' },
        { maskSecrets }
      )
    );
    expect(err.message).not.toContain(ROTATED_OLD);
    expect(err.message).toBe('Failed to update secret Secret: Access denied to ***');
  });

  it('masks the full ARN of a 2-character secret Name an UpdateSecret failure quotes back', async () => {
    // Below the needle floor, the name alone is no needle: the ARN built from
    // it is, so AWS text quoting the ARN is still masked. The record carries
    // no Name (an imported record, say), so only the DESIRED Name can mark it.
    mockSend.mockRejectedValue(new Error(`Access denied to ${arnOf(TINY)}`));
    const err = await thrown(() =>
      provider.update(
        'Secret',
        arnOf(TINY),
        TYPE,
        { Name: TINY, SecretString: 'new' },
        { SecretString: 'old' },
        { maskSecrets }
      )
    );
    expect(err.message).toBe('Failed to update secret Secret: Access denied to ***');
  });

  it('masks a ROTATED 3+ character recorded name an UpdateSecret failure quotes back bare', async () => {
    // The old plaintext is in no bag of this deploy: only the name segment cut
    // from the recorded ARN, as a needle, can mask it.
    mockSend.mockRejectedValue(new Error('Secret old-db-name is scheduled for deletion.'));
    const err = await thrown(() =>
      provider.update(
        'Secret',
        arnOf('old-db-name'),
        TYPE,
        { Name: 'plain-name', SecretString: 'new' },
        { Name: '{{resolve:secretsmanager:old-name}}', SecretString: 'old' },
        { maskSecrets }
      )
    );
    expect(err.message).toBe('Failed to update secret Secret: Secret *** is scheduled for deletion.');
  });

  it('masks AWS text that is exactly a ROTATED 2-character recorded name (whole-value name arm)', async () => {
    mockSend.mockRejectedValue(new Error(ROTATED_OLD));
    const err = await thrown(() =>
      provider.update(
        'Secret',
        arnOf(ROTATED_OLD),
        TYPE,
        { Name: 'plain-name', SecretString: 'new' },
        { Name: '{{resolve:secretsmanager:old-name}}', SecretString: 'old' },
        { maskSecrets }
      )
    );
    expect(err.message).toBe('Failed to update secret Secret: ***');
  });

  it('masks a longer bag secret whole rather than split it at the ARN arm', async () => {
    // `qx-AbCdEf-more` is a secret of this deploy's bag, not a name this
    // operation interpolates. The ARN arm, keyed on the desired Name `qx`,
    // matches its first `qx-AbCdEf`: masking only that would print `-more`,
    // so the arm masks the WHOLE name-legal run.
    const longer = `${TINY}-AbCdEf-more`;
    mockSend.mockRejectedValue(new Error(`Denied: ${arnOf(longer)}.`));
    const err = await thrown(() =>
      provider.update(
        'Secret',
        'arn:aws:secretsmanager:us-east-1:123456789012:secret:unrelated-QwErTy',
        TYPE,
        { Name: TINY, SecretString: 'new' },
        { SecretString: 'old' },
        { maskSecrets: createSecretMasker(bagOf(TINY, longer)) }
      )
    );
    expect(err.message).not.toContain('more');
    expect(err.message).toBe('Failed to update secret Secret: Denied: ***.');
  });

  it('routes every update line through the sink: tag warning and generate-skip warning included', async () => {
    await provider.update(
      'Secret',
      arnOf('plain-name'),
      TYPE,
      // A malformed, CHANGED GenerateSecretString on a state-borne bag warn-skips.
      { Name: 'plain-name', GenerateSecretString: 'not-an-object', Tags: [] },
      // An unreadable recorded Tags owes the tag-plan warning.
      { Name: 'plain-name', GenerateSecretString: { PasswordLength: 16 }, Tags: 'unreadable' },
      { maskSecrets: markingMasker, replayingState: true }
    );
    expect(mockSend.mock.calls.some((c) => c[0] instanceof UpdateSecretCommand)).toBe(true);
    const warns = warnSpy.mock.calls.map((c) => String(c[0]));
    // The skip warning and the tag-plan warning; the retain helper's drop
    // warning is not interpolating a bag value and stays on the plain logger.
    expect(warns.filter((l) => l.startsWith(MARK)).length).toBe(2);
    expect(warns.some((l) => l.includes('No new secret value is generated'))).toBe(true);
    expect(warns.some((l) => l.includes('recorded Tags'))).toBe(true);
    expect(debugLines().filter((l) => !l.startsWith(MARK))).toEqual([]);
  });

  it('masks the template-path refusal text RAW before it joins the sentence', async () => {
    const err = await thrown(() =>
      provider.update(
        'Secret',
        arnOf(TINY),
        TYPE,
        { Name: TINY, GenerateSecretString: 'not-an-object' },
        { Name: TINY, GenerateSecretString: { PasswordLength: 16 } },
        { maskSecrets: markingMasker }
      )
    );
    expect(err.message.startsWith(MARK)).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();
  });
});
