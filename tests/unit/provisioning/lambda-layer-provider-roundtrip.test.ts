import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PublishLayerVersionCommand,
  DeleteLayerVersionCommand,
} from '@aws-sdk/client-lambda';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { LambdaLayerVersionProvider } from '../../../src/provisioning/providers/lambda-layer-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const LAYER_VERSION_ARN = 'arn:aws:lambda:us-east-1:123456789012:layer:my-layer:5';

describe('LambdaLayerVersionProvider read-update round-trip', () => {
  let provider: LambdaLayerVersionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaLayerVersionProvider();
  });

  it('round-trip on no-drift snapshot makes ZERO mutating SDK calls (immutable resource)', async () => {
    // Lambda layer versions are immutable on AWS. `cdkd drift --revert`
    // calls update(observed, observed) to push state values back into
    // AWS. For an immutable resource, the only "update" path AWS exposes
    // is publishing a new version — which on a no-drift round-trip is
    // pure leak (duplicate content, new ARN). The provider must reject
    // up front with ResourceUpdateNotSupportedError instead of firing
    // a PublishLayerVersionCommand.
    const observed = {
      LayerName: 'my-layer',
      Description: 'utility layer',
      CompatibleRuntimes: ['nodejs20.x'],
      CompatibleArchitectures: ['x86_64'],
      LicenseInfo: 'MIT',
    };

    await expect(
      provider.update(
        'MyLayer',
        LAYER_VERSION_ARN,
        'AWS::Lambda::LayerVersion',
        observed,
        observed
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    // Crucially: NO mutating Lambda SDK calls fired.
    const publishCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof PublishLayerVersionCommand
    );
    const deleteCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof DeleteLayerVersionCommand
    );
    expect(publishCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
  });

  it('round-trip with empty CompatibleRuntimes / CompatibleArchitectures absent makes ZERO mutating SDK calls', async () => {
    // Verifies the Class 2 guard: readCurrentState gates these arrays
    // on `length > 0`, so a layer with no runtimes / no architectures
    // produces a snapshot WITHOUT those keys (not `[]`). The round-trip
    // must still reject cleanly without sending an invalid empty-array
    // PublishLayerVersion input.
    const observed = {
      LayerName: 'my-layer',
      // CompatibleRuntimes / CompatibleArchitectures / Description /
      // LicenseInfo all absent — readCurrentState does not emit empty
      // placeholders for these.
    };

    await expect(
      provider.update(
        'MyLayer',
        LAYER_VERSION_ARN,
        'AWS::Lambda::LayerVersion',
        observed,
        observed
      )
    ).rejects.toBeInstanceOf(ResourceUpdateNotSupportedError);

    expect(
      mockSend.mock.calls.filter((c) => c[0] instanceof PublishLayerVersionCommand)
    ).toHaveLength(0);
  });

  it('error message names the resource type and points at --replace', async () => {
    // The user-facing message must direct users to the right escape
    // hatch (cdkd deploy --replace) rather than leaving them stuck on
    // an immutable update rejection.
    const observed = { LayerName: 'my-layer' };

    try {
      await provider.update(
        'MyLayer',
        LAYER_VERSION_ARN,
        'AWS::Lambda::LayerVersion',
        observed,
        observed
      );
      throw new Error('expected update() to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
      const e = err as ResourceUpdateNotSupportedError;
      expect(e.resourceType).toBe('AWS::Lambda::LayerVersion');
      expect(e.logicalId).toBe('MyLayer');
      expect(e.message).toContain('--replace');
    }
  });
});
