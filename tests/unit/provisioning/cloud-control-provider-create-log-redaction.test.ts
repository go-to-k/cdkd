import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Shared debug spy so we can assert on the CREATE-path `DesiredState` log line.
// The provider builds its logger via getLogger().child(...), so the child's
// debug must be the shared spy.
const mockCcSend = vi.fn();
const mockDebug = vi.fn();
const mockCfnSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCcSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudFormation: { send: mockCfnSend },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: mockDebug,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return { child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';

describe('CloudControlProvider create-path DesiredState log redaction (GHSA sibling of the update-path masking)', () => {
  beforeEach(() => {
    mockCcSend.mockReset();
    mockDebug.mockReset();
    mockCfnSend.mockReset();
    // DescribeType (write-only / read-only lookups): a schema declaring none.
    mockCfnSend.mockResolvedValue({ Schema: JSON.stringify({}) });
  });

  it('logs top-level property KEYS only on create, never a resolved secret value', async () => {
    // A CC-routed resource with no SDK provider may carry a resolved
    // {{resolve:secretsmanager:...}} value in its properties; the create-path
    // DesiredState debug log must not echo it. The log fires (synchronously)
    // BEFORE the CreateResourceCommand send, so a rejected send still exercises
    // it — no need to mock the full success poll.
    const secretValue = 'super-secret-resolved-pw-123';
    mockCcSend.mockRejectedValue(new Error('CreateResource boom (log already fired)'));

    const provider = new CloudControlProvider();
    await provider
      .create('MySecretRes', 'AWS::SomeCc::Type', {
        ClientSecret: secretValue,
        PublicId: 'public-value',
      })
      .catch(() => undefined);

    const desiredLog = mockDebug.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('DesiredState for MySecretRes'));

    // The log exists, names the KEYS (so it is still useful for debugging)...
    expect(desiredLog).toBeDefined();
    expect(desiredLog).toContain('ClientSecret');
    expect(desiredLog).toContain('PublicId');
    // ...and NEVER contains the resolved secret value. Non-vacuous: without the
    // keys-only masking the whole `desiredState` JSON (incl. the secret) was
    // logged, so this line would fail.
    expect(desiredLog).not.toContain(secretValue);
    // Hard invariant: the secret appears in NO debug line at all.
    expect(mockDebug.mock.calls.map((c) => String(c[0])).join('\n')).not.toContain(secretValue);
  });

  // Both debug lines go through the caller's masker BEFORE the stringify
  // (issue #5894). A key or path holds no resolved value, so the masker here
  // treats a KEY as the recorded secret purely to make its application
  // observable. The key carries a quote and a newline: the provider's id-log
  // sink also masks the FINISHED line, which recognises a plain alphanumeric
  // key even after the stringify, but not one the stringify has escaped.
  const SECRET_KEY = 'Recorded"Secret\nKey';
  const maskKey = (text: string): string => text.split(SECRET_KEY).join('***');

  it('routes the create-path keys through the caller masker (issue #5894)', async () => {
    mockCcSend.mockRejectedValue(new Error('CreateResource boom (log already fired)'));

    await new CloudControlProvider()
      .create(
        'MaskedKeysRes',
        'AWS::SomeCc::Type',
        { [SECRET_KEY]: 'v', PublicId: 'public-value' },
        { maskSecrets: maskKey }
      )
      .catch(() => undefined);

    const desiredLog = mockDebug.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('DesiredState for MaskedKeysRes'));
    expect(desiredLog).toBe('DesiredState for MaskedKeysRes: keys=["***","PublicId"]');
  });

  it('routes the update-path patch paths through the caller masker (issue #5894)', async () => {
    mockCcSend.mockRejectedValue(new Error('UpdateResource boom (log already fired)'));

    await new CloudControlProvider()
      .update(
        'MaskedPatchRes',
        'masked-patch-id',
        'AWS::SomeCc::Type',
        { [SECRET_KEY]: 'new', PublicId: 'same' },
        { [SECRET_KEY]: 'old', PublicId: 'same' },
        { maskSecrets: maskKey }
      )
      .catch(() => undefined);

    const patchLog = mockDebug.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('patch operations for MaskedPatchRes'));
    expect(patchLog).toBe(
      'Generated 1 patch operations for MaskedPatchRes: [{"op":"replace","path":"/***"}]'
    );
  });
});
