// go-to-k/cdkd#5004: a real CloudFormation A/B showed CloudFormation KEEPS the
// live Description and KmsKeyId of an AWS::SecretsManager::Secret when they are
// removed from the template. UpdateSecret has merge semantics (an omitted member
// means "unchanged"), so cdkd must send neither member on a template removal.
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

function updateInput(): { Description?: string; KmsKeyId?: string } {
  const calls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateSecretCommand);
  expect(calls).toHaveLength(1);
  return calls[0]![0].input as { Description?: string; KmsKeyId?: string };
}

describe('SecretsManagerSecretProvider update() removal (issue #5004)', () => {
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
});
