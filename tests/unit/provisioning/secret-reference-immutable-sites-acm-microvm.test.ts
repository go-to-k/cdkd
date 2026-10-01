/**
 * go-to-k/cdkd#4275, the ACM Certificate and Lambda MicroVM image rows: their
 * immutable-property guards, driven through each provider's real `update()`.
 *
 * The deploy engine hands `update()` the RESOLVED plaintext as the desired side
 * and the state record (which keeps a secret leaf as its `{{resolve:...}}`
 * reference) as the previous side. Before the fix the ACM provider silently
 * REPLACED a certificate whose DomainName / SubjectAlternativeNames / ... came
 * from a secret on every update, and the MicroVM image provider refused every
 * update of an image whose Name did. Neither physical id (an ARN) carries the
 * value, so both take the masker arm, gated on a create-only key.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => {
    const client = { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } };
    return { acm: client, lambdaMicrovms: client };
  },
}));

// The masker arm's create-only gate reads the engine's lookup; answered from
// the committed snapshot so no case reaches DescribeType.
vi.mock('../../../src/provisioning/create-only-properties.js', async () => {
  const { CREATE_ONLY_PATHS_SNAPSHOT } = await import(
    '../../../src/provisioning/create-only-snapshot.generated.js'
  );
  return {
    getCreateOnlyPropertyPaths: async (type: string) => CREATE_ONLY_PATHS_SNAPSHOT.get(type) ?? [],
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };
  child.child = vi.fn().mockReturnValue(child);
  return { getLogger: () => child };
});

import { ACMCertificateProvider } from '../../../src/provisioning/providers/acm-certificate-provider.js';
import { LambdaMicrovmImageProvider } from '../../../src/provisioning/providers/lambda-microvm-image-provider.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { createSecretMasker, SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { RecordedSecretValues } from '../../../src/deployment/secret-redaction.js';
import type { UpdateContext } from '../../../src/types/resource.js';

/** What the secret resolves to this deploy, and what state recorded instead. */
const NAME = 'resolved-secret.example.com';
const REF = '{{resolve:secretsmanager:name-secret:SecretString:name}}';
const OTHER = 'other-secret.example.com';

function bagOf(...values: string[]): RecordedSecretValues {
  return new Map(values.map((v) => [v, `{{resolve:secretsmanager:${v}}}`]));
}

/** The deploy's own masker: it knows every value this deploy resolved. */
const context: UpdateContext = { maskSecrets: createSecretMasker(bagOf(NAME, OTHER)) };
/** A context carrying no masker (a default parameter would swallow `undefined`). */
const NO_MASKER: UpdateContext = {};

const SENTINEL = 'SENTINEL-first-post-guard-aws-call';

const commandName = (command: unknown): string =>
  (command as { constructor: { name: string } }).constructor.name;

const sentCommands = (): string[] => mockSend.mock.calls.map((call) => commandName(call[0]));

/** `answers` names the commands that SUCCEED; every other one rejects. */
function fakeAws(answers: Record<string, unknown>): void {
  mockSend.mockImplementation(async (command: unknown) => {
    const name = commandName(command);
    if (name in answers) return answers[name];
    throw new Error(SENTINEL);
  });
}

async function outcome(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return 'resolved';
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSend.mockReset();
  resetIdempotencyTokensForTests();
});

describe('ACM Certificate: a secret-derived immutable value no longer REPLACES the certificate', () => {
  const TYPE = 'AWS::CertificateManager::Certificate';
  const CERT_ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333';

  /**
   * One update: a Tags change (the in-place work) plus `key` set to `desired`
   * / `previous`. An in-place update sends the tag call and resolves; a
   * replacement starts with `RequestCertificate`, which the fake rejects.
   */
  async function run(
    key: string,
    desired: unknown,
    previous: unknown,
    ctx: UpdateContext = context,
    extra: { desired?: Record<string, unknown>; previous?: Record<string, unknown> } = {}
  ): Promise<{ replaced: boolean; result: string }> {
    fakeAws({ AddTagsToCertificateCommand: {} });
    const base = { DomainName: 'plain.example.com', ValidationMethod: 'DNS' };
    const result = await outcome(
      new ACMCertificateProvider().update(
        'Cert',
        CERT_ARN,
        TYPE,
        { ...base, Tags: [{ Key: 'k', Value: 'new' }], ...extra.desired, [key]: desired },
        { ...base, Tags: [{ Key: 'k', Value: 'old' }], ...extra.previous, [key]: previous },
        ctx
      )
    );
    return { replaced: sentCommands().includes('RequestCertificateCommand'), result };
  }

  it('DomainName UNCHANGED: updated in place, never replaced', async () => {
    const { replaced, result } = await run('DomainName', NAME, REF);
    expect(replaced).toBe(false);
    expect(result).toBe('resolved');
    expect(sentCommands()).toEqual(['AddTagsToCertificateCommand']);
  });

  it('DomainName UNCHANGED inside literal text: updated in place', async () => {
    const { replaced } = await run('DomainName', `api.${NAME}`, `api.${REF}`);
    expect(replaced).toBe(false);
  });

  it('SubjectAlternativeNames with one secret-derived element: updated in place', async () => {
    const { replaced } = await run(
      'SubjectAlternativeNames',
      ['www.example.com', NAME],
      ['www.example.com', REF]
    );
    expect(replaced).toBe(false);
  });

  it('DomainValidationOptions with a secret-derived DomainName: updated in place', async () => {
    const { replaced } = await run(
      'DomainValidationOptions',
      [{ DomainName: NAME, HostedZoneId: 'Z1' }],
      [{ DomainName: REF, HostedZoneId: 'Z1' }]
    );
    expect(replaced).toBe(false);
  });

  it('CertificateAuthorityArn UNCHANGED: updated in place', async () => {
    const { replaced } = await run('CertificateAuthorityArn', NAME, REF);
    expect(replaced).toBe(false);
  });

  it('KeyAlgorithm UNCHANGED: updated in place', async () => {
    const { replaced } = await run('KeyAlgorithm', NAME, REF);
    expect(replaced).toBe(false);
  });

  it('RENAMED: a literal the masker never resolved still replaces', async () => {
    const { replaced } = await run('DomainName', 'literal.example.com', REF);
    expect(replaced).toBe(true);
  });

  it('PLAIN: an ordinary recorded value that differs still replaces', async () => {
    const { replaced } = await run('DomainName', NAME, 'old.example.com');
    expect(replaced).toBe(true);
  });

  it('a recorded *** still replaces: a mask says nothing about the value', async () => {
    const { replaced } = await run('DomainName', NAME, SECRET_MASK);
    expect(replaced).toBe(true);
  });

  it('no masker: still replaces', async () => {
    const { replaced } = await run('DomainName', NAME, REF, NO_MASKER);
    expect(replaced).toBe(true);
  });

  it('ValidationMethod is not a key the engine replaces on, so a secret-derived one still replaces', async () => {
    const { replaced } = await run('ValidationMethod', NAME, REF);
    expect(replaced).toBe(true);
  });

  it('an unchanged secret-derived DomainName does not hide a real change of a later key', async () => {
    const { replaced } = await run('DomainName', NAME, REF, context, {
      desired: { KeyAlgorithm: 'EC_prime256v1' },
      previous: { KeyAlgorithm: 'RSA_2048' },
    });
    expect(replaced).toBe(true);
  });
});

describe('Lambda MicroVM image: a secret-derived Name no longer refuses the update', () => {
  const TYPE = 'AWS::Lambda::MicrovmImage';
  const IMAGE_ARN = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:img-1';
  const REFUSAL = 'Name is create-only';

  /**
   * One update: a Description change (the rebuild) plus `Name`. A passing
   * guard reaches `UpdateMicrovmImage`, which the fake rejects with the
   * sentinel; a refusal never sends it.
   */
  function run(desired: unknown, previous: unknown, ctx: UpdateContext = context) {
    fakeAws({});
    const base = {
      BaseImageArn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1',
      BuildRoleArn: 'arn:aws:iam::123456789012:role/Build',
      CodeArtifact: { Uri: 's3://bucket/code.zip' },
    };
    return outcome(
      new LambdaMicrovmImageProvider().update(
        'Image',
        IMAGE_ARN,
        TYPE,
        { ...base, Description: 'new', Name: desired },
        { ...base, Description: 'old', Name: previous },
        ctx
      )
    );
  }

  it('UNCHANGED: a recorded reference resolving to the current value lets the update through', async () => {
    expect(await run(NAME, REF)).toContain(SENTINEL);
    expect(sentCommands()).toEqual(['UpdateMicrovmImageCommand']);
  });

  it('RENAMED: a literal the masker never resolved is still refused', async () => {
    expect(await run('literal-name', REF)).toContain(REFUSAL);
    expect(sentCommands()).toEqual([]);
  });

  it('PLAIN: an ordinary recorded value that differs is still refused', async () => {
    expect(await run('new-name', 'old-name')).toContain(REFUSAL);
  });

  it('a recorded *** is still refused: a mask says nothing about the value', async () => {
    expect(await run(NAME, SECRET_MASK)).toContain(REFUSAL);
  });

  it('no masker: the desired value cannot be shown secret-derived, so it is refused', async () => {
    expect(await run(NAME, REF, NO_MASKER)).toContain(REFUSAL);
  });

  it('the refusal masks a resolved secret value it would otherwise print', async () => {
    const message = await run(NAME, SECRET_MASK);
    expect(message).toContain(REFUSAL);
    expect(message).not.toContain(NAME);
  });
});

describe('a reference re-pointed at a DIFFERENT secret is accepted at the provider', () => {
  // The masker arm proves only that the desired value is still secret-derived,
  // not that it is the SAME reference: `OTHER` (another secret this deploy
  // resolved) passes against a recorded `REF`. The ENGINE owns that refusal:
  // a re-pointed reference changes the template's spelling of a create-only
  // key, so the diff routes it to REPLACEMENT before `update()` runs. Pinned
  // here so a change to `unchangedBehindSecretReference` that starts or stops
  // accepting it shows up at both providers.
  it('ACM is not replaced and the MicroVM image is not refused', async () => {
    fakeAws({ AddTagsToCertificateCommand: {} });
    const certBase = { ValidationMethod: 'DNS' };
    const certResult = await outcome(
      new ACMCertificateProvider().update(
        'Cert',
        'arn:aws:acm:us-east-1:123456789012:certificate/11111111-2222-3333',
        'AWS::CertificateManager::Certificate',
        { ...certBase, DomainName: OTHER, Tags: [{ Key: 'k', Value: 'new' }] },
        { ...certBase, DomainName: REF, Tags: [{ Key: 'k', Value: 'old' }] },
        context
      )
    );
    expect(certResult).toBe('resolved');
    expect(sentCommands()).not.toContain('RequestCertificateCommand');

    mockSend.mockReset();
    fakeAws({});
    const imageBase = {
      BaseImageArn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1',
      BuildRoleArn: 'arn:aws:iam::123456789012:role/Build',
      CodeArtifact: { Uri: 's3://bucket/code.zip' },
    };
    const imageResult = await outcome(
      new LambdaMicrovmImageProvider().update(
        'Image',
        'arn:aws:lambda:us-east-1:123456789012:microvm-image:img-1',
        'AWS::Lambda::MicrovmImage',
        { ...imageBase, Description: 'new', Name: OTHER },
        { ...imageBase, Description: 'old', Name: REF },
        context
      )
    );
    expect(imageResult).not.toContain('Name is create-only');
    expect(imageResult).toContain(SENTINEL);
  });
});
