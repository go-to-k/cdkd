import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateSecretCommand,
  UpdateSecretCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ReplicateSecretToRegionsCommand,
  RemoveRegionsFromReplicationCommand,
} from '@aws-sdk/client-secrets-manager';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    secretsManager: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
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

describe('SecretsManagerSecretProvider read-update round-trip', () => {
  let provider: SecretsManagerSecretProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new SecretsManagerSecretProvider();
  });

  it('Class 2 — empty-string KmsKeyId placeholder is sanitized away on round-trip', async () => {
    // Mechanical guard for Class 2 placeholder regression. See
    // docs/provider-rules.md#readcurrentstate-for-drift-detection.
    //
    // readCurrentState emits `KmsKeyId: ''` as a placeholder for "no
    // customer-managed KMS key" (so the comparator's top-level walk can
    // detect a console-side KmsKeyId set: state '' vs AWS '<arn>').
    // `cdkd drift --revert` round-trips that placeholder back through
    // update() (via buildRevertNewProperties' "AWS-current base" — the
    // AWS-current value is itself the same '' placeholder when no key
    // is set). AWS UpdateSecret rejects an empty-string KmsKeyId as an
    // invalid ARN; the write layer must sanitize it to undefined so the
    // wire payload omits the field entirely.
    const observed = {
      Name: 'my-secret',
      Description: '',
      KmsKeyId: '',
      ReplicaRegions: [] as Array<Record<string, unknown>>,
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    await provider.update('L', SECRET_ARN, 'AWS::SecretsManager::Secret', observed, observed);

    // The sole UpdateSecret call must NOT carry an empty-string KmsKeyId.
    const updateCalls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateSecretCommand);
    for (const call of updateCalls) {
      const input = call[0].input as { KmsKeyId?: string };
      expect(input.KmsKeyId).toBeUndefined();
    }
  });

  it('round-trip on no-drift snapshot triggers no Tag/Replica AWS calls', async () => {
    // Stronger assertion for diff-based mutations: state == AWS implies
    // update() must not fan out to TagResource / UntagResource /
    // ReplicateSecretToRegions / RemoveRegionsFromReplication. (The
    // single base UpdateSecret call is allowed — UpdateSecret with only
    // SecretId is an AWS-side no-op and matches existing update() shape.)
    const observed = {
      Name: 'my-secret',
      Description: 'human-readable',
      KmsKeyId: 'arn:aws:kms:us-east-1:0:key/abcd',
      ReplicaRegions: [{ Region: 'us-west-2', KmsKeyId: 'alias/aws/secretsmanager' }],
      Tags: [{ Key: 'k', Value: 'v' }],
    };

    await provider.update('L', SECRET_ARN, 'AWS::SecretsManager::Secret', observed, observed);

    const tagCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof TagResourceCommand || c[0] instanceof UntagResourceCommand
    );
    expect(tagCalls).toHaveLength(0);

    const replicaCalls = mockSend.mock.calls.filter(
      (c) =>
        c[0] instanceof ReplicateSecretToRegionsCommand ||
        c[0] instanceof RemoveRegionsFromReplicationCommand
    );
    expect(replicaCalls).toHaveLength(0);
  });

  it('round-trip on no-description / no-KMS / no-replicas snapshot succeeds without rejection-shape input', async () => {
    // Bare-minimum secret (every optional field is the readCurrentState
    // placeholder). The round-trip must not push any rejection-shape
    // value to AWS — empty strings on Description/KmsKeyId, and empty
    // arrays on ReplicaRegions/Tags must all be treated correctly:
    //   - Description: '' is acceptable to UpdateSecret (clears desc).
    //   - KmsKeyId: '' MUST be sanitized away (Class 2 — covered above).
    //   - ReplicaRegions: [] / Tags: [] are diff-equal with previous,
    //     so no Replica/Tag calls should fire.
    const observed = {
      Name: 'minimal-secret',
      Description: '',
      KmsKeyId: '',
      ReplicaRegions: [] as Array<Record<string, unknown>>,
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    await provider.update('L', SECRET_ARN, 'AWS::SecretsManager::Secret', observed, observed);

    // Only an UpdateSecret-with-just-SecretId is allowed.
    const updateCalls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateSecretCommand);
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0]![0].input as Record<string, unknown>;
    expect(input['SecretId']).toBe(SECRET_ARN);
    expect(input['KmsKeyId']).toBeUndefined();

    // No tag / replica fan-out.
    const tagCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof TagResourceCommand || c[0] instanceof UntagResourceCommand
    );
    expect(tagCalls).toHaveLength(0);
    const replicaCalls = mockSend.mock.calls.filter(
      (c) =>
        c[0] instanceof ReplicateSecretToRegionsCommand ||
        c[0] instanceof RemoveRegionsFromReplicationCommand
    );
    expect(replicaCalls).toHaveLength(0);
  });

  it('Type is forwarded to CreateSecret when present', async () => {
    mockSend.mockResolvedValueOnce({
      ARN: SECRET_ARN,
    });

    await provider.create('L', 'AWS::SecretsManager::Secret', {
      Name: 'partner-secret',
      SecretString: '{"foo":"bar"}',
      Type: 'urn:partner:example',
    });

    const createCalls = mockSend.mock.calls.filter((c) => c[0] instanceof CreateSecretCommand);
    expect(createCalls).toHaveLength(1);
    const input = createCalls[0]![0].input as { Type?: string };
    expect(input.Type).toBe('urn:partner:example');
  });

  it('Type omitted from CreateSecret when absent (ordinary secret)', async () => {
    mockSend.mockResolvedValueOnce({
      ARN: SECRET_ARN,
    });

    await provider.create('L', 'AWS::SecretsManager::Secret', {
      Name: 'ordinary-secret',
      SecretString: '{"foo":"bar"}',
    });

    const createCalls = mockSend.mock.calls.filter((c) => c[0] instanceof CreateSecretCommand);
    expect(createCalls).toHaveLength(1);
    const input = createCalls[0]![0].input as { Type?: string };
    expect(input.Type).toBeUndefined();
  });

  it('Type is forwarded to UpdateSecret when present', async () => {
    await provider.update(
      'L',
      SECRET_ARN,
      'AWS::SecretsManager::Secret',
      { Name: 'partner-secret', Type: 'urn:partner:v2' },
      { Name: 'partner-secret', Type: 'urn:partner:v1' }
    );

    const updateCalls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateSecretCommand);
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0]![0].input as { Type?: string };
    expect(input.Type).toBe('urn:partner:v2');
  });

  it('Type omitted from UpdateSecret when absent', async () => {
    await provider.update(
      'L',
      SECRET_ARN,
      'AWS::SecretsManager::Secret',
      { Name: 'ordinary-secret' },
      { Name: 'ordinary-secret' }
    );

    const updateCalls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateSecretCommand);
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0]![0].input as { Type?: string };
    expect(input.Type).toBeUndefined();
  });

  it('Description="" reaches UpdateSecret (clear-the-description must not be silently dropped)', async () => {
    // Truthy-gate guard: `if (properties['Description']) ...` would
    // silently drop a user-intended `Description: ''` (clear). The fix
    // is `!== undefined`, so '' must reach the wire. This is the
    // semantic difference vs KmsKeyId (which AWS rejects on empty
    // string and must therefore be sanitized away).
    const previous = {
      Name: 'my-secret',
      Description: 'old description',
      KmsKeyId: '',
      ReplicaRegions: [] as Array<Record<string, unknown>>,
      Tags: [] as Array<{ Key: string; Value: string }>,
    };
    const next = {
      ...previous,
      Description: '',
    };

    await provider.update('L', SECRET_ARN, 'AWS::SecretsManager::Secret', next, previous);

    const updateCalls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateSecretCommand);
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0]![0].input as Record<string, unknown>;
    expect(input['Description']).toBe('');
  });
});

describe('SecretsManagerSecretProvider #1160 reset-on-removal', () => {
  // UpdateSecret has merge semantics (absent input field = "no change"),
  // while CloudFormation resets a template-removed property to its default.
  // Removal must therefore send the explicit clear sentinel. Live-probed
  // 2026-07-27 (us-east-1): UpdateSecret accepts `Description: ''` and
  // `KmsKeyId: ''` (the latter documented as "use the AWS managed key
  // aws/secretsmanager"), and DescribeSecret OMITS both fields afterwards,
  // so the resets are drift-clean.
  let provider: SecretsManagerSecretProvider;

  const CUSTOMER_KEY = 'arn:aws:kms:us-east-1:0:key/11111111-2222-3333-4444-555555555555';

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new SecretsManagerSecretProvider();
  });

  async function updateInput(
    next: Record<string, unknown>,
    previous: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    await provider.update('L', SECRET_ARN, 'AWS::SecretsManager::Secret', next, previous);
    const updateCalls = mockSend.mock.calls.filter((c) => c[0] instanceof UpdateSecretCommand);
    expect(updateCalls).toHaveLength(1);
    return updateCalls[0]![0].input as Record<string, unknown>;
  }

  it('Description present before, absent now -> explicit "" reset in UpdateSecret input', async () => {
    const input = await updateInput(
      { Name: 'my-secret' },
      { Name: 'my-secret', Description: 'old description' }
    );
    expect(input['Description']).toBe('');
  });

  it('KmsKeyId (customer key) present before, absent now -> explicit "" reset (revert to aws/secretsmanager)', async () => {
    const input = await updateInput(
      { Name: 'my-secret' },
      { Name: 'my-secret', KmsKeyId: CUSTOMER_KEY }
    );
    expect(input['KmsKeyId']).toBe('');
  });

  it('never-present Description / KmsKeyId stay absent from the UpdateSecret input', async () => {
    const input = await updateInput({ Name: 'my-secret' }, { Name: 'my-secret' });
    expect('Description' in input).toBe(false);
    expect('KmsKeyId' in input).toBe(false);
  });

  it('mixed: kept Description passes through unchanged while removed KmsKeyId resets', async () => {
    const input = await updateInput(
      { Name: 'my-secret', Description: 'kept description' },
      { Name: 'my-secret', Description: 'kept description', KmsKeyId: CUSTOMER_KEY }
    );
    expect(input['Description']).toBe('kept description');
    expect(input['KmsKeyId']).toBe('');
  });

  it('placeholder-only previous KmsKeyId ("" = no customer key) fires NO reset on removal', async () => {
    // previousProperties carrying the readCurrentState `''` placeholder means
    // the secret never had a customer key — a reset would be a pointless
    // write. The placeholder is normalized to "absent" on both sides.
    const input = await updateInput(
      { Name: 'my-secret' },
      { Name: 'my-secret', KmsKeyId: '' }
    );
    expect('KmsKeyId' in input).toBe(false);
  });

  it('customer KmsKeyId kept on both sides still passes through (removal logic does not clobber)', async () => {
    const input = await updateInput(
      { Name: 'my-secret', KmsKeyId: CUSTOMER_KEY },
      { Name: 'my-secret', KmsKeyId: CUSTOMER_KEY }
    );
    expect(input['KmsKeyId']).toBe(CUSTOMER_KEY);
  });
});
