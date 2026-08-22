/**
 * Issue #2176 — `SSMParameterProvider`'s masked log sinks.
 *
 * This provider is the reference implementation of the one-masked-sink shape
 * (`.claude/rules/providers.md`), and it is the highest-value place to get it
 * right: `AWS::SSM::Parameter`'s `Value` IS the secret. `Value` itself reaches
 * no message site — checked on every path — but `Name` reaches five, including
 * a paste-ready `aws ssm delete-parameter --name '<value>'` remediation line,
 * and `Name` is as resolvable from a `{{resolve:...}}` reference as anything
 * else in the bag.
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

  it('masks the parameter Name in the cleanup-failure warn AND its paste-ready command', async () => {
    mockSend.mockResolvedValueOnce({}); // PutParameter
    mockSend.mockRejectedValueOnce(new Error('AddTags boom')); // AddTagsToResource
    mockSend.mockRejectedValueOnce(new Error('DeleteParameter also failed')); // cleanup

    await expect(
      provider.create(
        'MyParam',
        RESOURCE_TYPE,
        { Name: SECRET_NAME, Type: 'String', Value: 'v', Tags: [{ Key: 'k', Value: 'v' }] },
        { maskSecrets }
      )
    ).rejects.toThrow('AddTags boom');

    const warnMsg = String(warnSpy.mock.calls[0]?.[0]);
    // POSITIVE marker first: "the plaintext is absent" is equally true of a
    // warning that never fired, or one that dropped the name entirely.
    expect(warnMsg).toContain('aws ssm delete-parameter --name');
    expect(warnMsg).toContain(SECRET_MASK);
    expect(warnMsg).not.toContain(SECRET_NAME);
  });

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
