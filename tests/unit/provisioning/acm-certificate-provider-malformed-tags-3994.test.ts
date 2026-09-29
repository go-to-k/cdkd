import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  AddTagsToCertificateCommand,
  RemoveTagsFromCertificateCommand,
  RequestCertificateCommand,
} from '@aws-sdk/client-acm';

// go-to-k/cdkd#3994: the ACM Certificate Tags diff read a malformed side as
// empty, so a malformed DESIRED Tags (a rollback / drift --revert desired bag)
// untagged every recorded key.

const mockSend = vi.fn();
const warn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    acm: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { ACMCertificateProvider } from '../../../src/provisioning/providers/acm-certificate-provider.js';
import { resetIdempotencyTokensForTests } from '../../../src/provisioning/providers/idempotency-token.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  PROVIDER_MALFORMED_DESIRED,
  PROVIDER_MALFORMED_RECORDED,
  TAG_FIXTURE,
} from './tag-list-fixtures.js';

const TYPE = 'AWS::CertificateManager::Certificate';
const ARN = 'arn:aws:acm:us-east-1:123456789012:certificate/abc123';
const BASE = { DomainName: 'example.com', ValidationMethod: 'DNS' };
const RECORDED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'drop', Value: 'x' },
];
const DESIRED = [
  { Key: 'keep', Value: 'same' },
  { Key: 'add', Value: '' },
];

function commands(): unknown[] {
  return mockSend.mock.calls.map((c) => c[0]);
}

async function refusal(run: () => Promise<unknown>): Promise<Error> {
  const err = await run().then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  expect(isMarkedNonRetryable(err)).toBe(true);
  const msg = (err as Error).message;
  expect(msg).not.toContain(TAG_FIXTURE.NEEDLE);
  expect(msg).not.toContain('issue3994/tags');
  return err as Error;
}

describe('ACMCertificateProvider Certificate Tags (go-to-k/cdkd#3994)', () => {
  let provider: ACMCertificateProvider;
  let originalNoWait: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    originalNoWait = process.env['CDKD_NO_WAIT'];
    process.env['CDKD_NO_WAIT'] = 'true';
    resetIdempotencyTokensForTests();
    mockSend.mockImplementation(async (cmd: unknown) =>
      cmd instanceof RequestCertificateCommand ? { CertificateArn: ARN } : {}
    );
    provider = new ACMCertificateProvider();
  });

  afterEach(() => {
    if (originalNoWait === undefined) delete process.env['CDKD_NO_WAIT'];
    else process.env['CDKD_NO_WAIT'] = originalNoWait;
  });

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on update before any call',
    async (_label, tags) => {
      const err = await refusal(() =>
        provider.update(
          'C',
          ARN,
          TYPE,
          { ...BASE, CertificateTransparencyLoggingPreference: 'DISABLED', Tags: tags },
          { ...BASE, Tags: RECORDED }
        )
      );
      expect(err.message).toContain(`desired Tags of ${TYPE} C`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_DESIRED)(
    'refuses a desired %s on create before any call',
    async (_label, tags) => {
      const err = await refusal(() => provider.create('C', TYPE, { ...BASE, Tags: tags }));
      expect(err.message).toContain(`Tags of ${TYPE} C`);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it.each(PROVIDER_MALFORMED_RECORDED)(
    'applies a recorded %s ADD-only: tags every desired key, untags nothing',
    async (_label, recorded) => {
      await provider.update('C', ARN, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: recorded });
      expect(commands().some((c) => c instanceof RemoveTagsFromCertificateCommand)).toBe(false);
      const add = commands().filter(
        (c) => c instanceof AddTagsToCertificateCommand
      ) as AddTagsToCertificateCommand[];
      expect(add.map((c) => c.input)).toEqual([{ CertificateArn: ARN, Tags: DESIRED }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('removed no tag'));
      // Names the LOGICAL id, never an ARN / URL / physical name.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${TYPE} C is not`));
      expect(String(warn.mock.calls[0]?.[0])).not.toContain(TAG_FIXTURE.NEEDLE);
    }
  );

  it('diffs a valid pair into exact Remove / Add calls', async () => {
    await provider.update('C', ARN, TYPE, { ...BASE, Tags: DESIRED }, { ...BASE, Tags: RECORDED });
    const tagCalls = commands().filter(
      (c) => c instanceof AddTagsToCertificateCommand || c instanceof RemoveTagsFromCertificateCommand
    ) as Array<AddTagsToCertificateCommand | RemoveTagsFromCertificateCommand>;
    expect(tagCalls.map((c) => [c.constructor.name, c.input])).toEqual([
      ['RemoveTagsFromCertificateCommand', { CertificateArn: ARN, Tags: [{ Key: 'drop' }] }],
      ['AddTagsToCertificateCommand', { CertificateArn: ARN, Tags: [{ Key: 'add', Value: '' }] }],
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('never untags a recorded secret-derived key', async () => {
    await provider.update(
      'C',
      ARN,
      TYPE,
      { ...BASE, Tags: [] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, ...RECORDED] }
    );
    const remove = commands().filter(
      (c) => c instanceof RemoveTagsFromCertificateCommand
    ) as RemoveTagsFromCertificateCommand[];
    expect(remove.map((c) => c.input.Tags)).toEqual([[{ Key: 'keep' }, { Key: 'drop' }]]);
  });

  it('warns about a recorded secret-derived key it cannot remove', async () => {
    await provider.update(
      'C',
      ARN,
      TYPE,
      { ...BASE, Tags: [{ Key: 'keep', Value: 'same' }] },
      { ...BASE, Tags: [{ Key: TAG_FIXTURE.SECRET_REF, Value: 'v' }, { Key: 'keep', Value: 'same' }] }
    );
    const warned = warn.mock.calls.map((c) => String(c[0]));
    expect(warned).toContainEqual(
      expect.stringContaining(`${TYPE} C holds 1 key(s) derived from a dynamic reference`)
    );
    expect(warned.join('\n')).not.toContain('issue3994/tags');
    const sent = [mockSend].flatMap((m) =>
      m.mock.calls.map((c) => (c[0] as object).constructor.name)
    );
    expect(sent.filter((n) => /Untag|RemoveTags|DeleteTags/.test(n))).toEqual([]);
  });

  it('requests the certificate with the desired tags', async () => {
    await provider.create('C', TYPE, { ...BASE, Tags: DESIRED });
    const req = commands().find(
      (c) => c instanceof RequestCertificateCommand
    ) as RequestCertificateCommand;
    expect(req.input.Tags).toEqual(DESIRED);
  });

  it('requests the certificate with no Tags field when Tags is absent', async () => {
    await provider.create('C', TYPE, { ...BASE });
    const req = commands().find(
      (c) => c instanceof RequestCertificateCommand
    ) as RequestCertificateCommand;
    expect(req.input.Tags).toBeUndefined();
  });
});
