// go-to-k/cdkd#5004: a real CloudFormation A/B showed CloudFormation KEEPS the
// live Description and KmsKeyId of an AWS::SecretsManager::Secret when they are
// removed from the template. UpdateSecret has merge semantics (an omitted member
// means "unchanged"), so cdkd must send neither member on a template removal.
// go-to-k/cdkd#1160: the same A/B for `Type` (a managed-external-secret partner
// type, `DatadogApiKey`) — CloudFormation updated the secret in place and KEPT
// the live Type when the template removed it, so cdkd sends no `Type` either.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateSecretCommand } from '@aws-sdk/client-secrets-manager';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    secretsManager: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { SecretsManagerSecretProvider } from '../../../src/provisioning/providers/secretsmanager-secret-provider.js';

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:0:secret:my-secret-AbCdEf';
const TYPE = 'AWS::SecretsManager::Secret';
const KEY = 'arn:aws:kms:us-east-1:0:key/abcd';

interface UpdateInput {
  Description?: string;
  KmsKeyId?: string;
  Type?: string;
}

function updateInput(): UpdateInput {
  const calls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateSecretCommand);
  expect(calls).toHaveLength(1);
  return calls[0]![0].input as UpdateInput;
}

describe('SecretsManagerSecretProvider update() removal (issues #5004, #1160)', () => {
  let provider: SecretsManagerSecretProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new SecretsManagerSecretProvider();
  });

  it('KEEPS Description and KmsKeyId when both are removed: neither member is sent', async () => {
    await provider.update(
      'L',
      SECRET_ARN,
      TYPE,
      { Name: 'my-secret' },
      { Name: 'my-secret', Description: 'old', KmsKeyId: KEY }
    );

    const input = updateInput();
    expect(input).not.toHaveProperty('Description');
    expect(input).not.toHaveProperty('KmsKeyId');
  });

  it('still sends a declared Description and KmsKeyId', async () => {
    await provider.update(
      'L',
      SECRET_ARN,
      TYPE,
      { Name: 'my-secret', Description: 'new', KmsKeyId: KEY },
      { Name: 'my-secret', Description: 'old' }
    );

    const input = updateInput();
    expect(input.Description).toBe('new');
    expect(input.KmsKeyId).toBe(KEY);
  });

  it('an explicit empty KmsKeyId against a customer key still clears it (the drift --revert shape)', async () => {
    await provider.update(
      'L',
      SECRET_ARN,
      TYPE,
      { Name: 'my-secret', KmsKeyId: '' },
      { Name: 'my-secret', KmsKeyId: KEY }
    );

    expect(updateInput().KmsKeyId).toBe('');
  });

  it('an empty KmsKeyId against an empty previous side sends nothing', async () => {
    await provider.update(
      'L',
      SECRET_ARN,
      TYPE,
      { Name: 'my-secret', KmsKeyId: '' },
      { Name: 'my-secret', KmsKeyId: '' }
    );

    expect(updateInput()).not.toHaveProperty('KmsKeyId');
  });

  it('KEEPS Type when it is removed: no Type member is sent (issue #1160)', async () => {
    await provider.update(
      'L',
      SECRET_ARN,
      TYPE,
      { Name: 'my-secret', Description: 'changed' },
      { Name: 'my-secret', Description: 'old', Type: 'DatadogApiKey' }
    );

    const input = updateInput();
    expect(input).not.toHaveProperty('Type');
    // The companion change still reaches UpdateSecret, so the omission is not
    // the call being skipped.
    expect(input.Description).toBe('changed');
  });

  it('still sends a declared Type (issue #1160)', async () => {
    await provider.update(
      'L',
      SECRET_ARN,
      TYPE,
      { Name: 'my-secret', Type: 'DatadogApiKey' },
      { Name: 'my-secret' }
    );

    expect(updateInput().Type).toBe('DatadogApiKey');
  });
});
