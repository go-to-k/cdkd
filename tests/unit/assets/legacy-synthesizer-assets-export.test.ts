import { describe, it, expect, vi } from 'vite-plus/test';

// Issue #6421: `cdkd export` binds a LegacyStackSynthesizer stack's asset
// parameters through `bindLegacyStackAssetParameters`, from a lazily-built
// asset-mode context (no STS / marker read for any other stack).

const contextFactory = vi.hoisted(() => vi.fn());
vi.mock('../../../src/assets/asset-redirect.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/assets/asset-redirect.js')>()),
  createLazyAssetModeContext: contextFactory,
}));

import { bindLegacyStackAssetParameters } from '../../../src/assets/legacy-synthesizer-assets.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const template = (): CloudFormationTemplate =>
  ({
    Parameters: { BucketP: { Type: 'String' }, KeyP: { Type: 'String' }, HashP: { Type: 'String' } },
    Resources: {},
  }) as CloudFormationTemplate;

describe('bindLegacyStackAssetParameters', () => {
  it('binds the region-mode values into the template, suppressing the legacy notice', async () => {
    contextFactory.mockReturnValue({
      accountId: async () => '123456789012',
      resolveMode: async () => ({ mode: 'cdkd-assets', marker: { assetBucket: 'cdkd-b' } }),
    });
    const t = template();
    await bindLegacyStackAssetParameters(
      {
        stackName: 'S',
        template: t,
        legacyAssets: {
          assemblyDir: '/x',
          entries: [
            {
              packaging: 'zip',
              id: 'h',
              path: 'asset.h',
              sourceHash: 'h',
              s3BucketParameter: 'BucketP',
              s3KeyParameter: 'KeyP',
              artifactHashParameter: 'HashP',
            },
          ],
        },
      },
      'us-east-1',
      { stateBackend: {} as never, stsRegion: 'us-east-1' }
    );
    expect(t.Parameters!['BucketP']!.Default).toBe('cdkd-b');
    expect(t.Parameters!['KeyP']!.Default).toBe('||h.zip');
    expect(contextFactory).toHaveBeenCalledWith(
      expect.objectContaining({ suppressLegacyNotice: true, stsRegion: 'us-east-1' })
    );
  });

  it('builds no context for a stack without legacy entries', async () => {
    contextFactory.mockClear();
    await bindLegacyStackAssetParameters({ stackName: 'S', template: template() }, 'us-east-1', {
      stateBackend: {} as never,
      stsRegion: 'us-east-1',
    });
    expect(contextFactory).not.toHaveBeenCalled();
  });
});
