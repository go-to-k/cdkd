import { Command } from 'commander';
import { describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdkd#6150: `local start-cloudfront` hands cdk-local cdkd's ONE
// `--from-state` factory; the engine asks it for real-AWS names for the S3
// origins it reads on the host (`behavior.realAwsOnly`, go-to-k/cdk-local#892),
// and the factory honours that (`tests/unit/local/mixed-mode-state.test.ts`).
// This pins the command's wiring.

const captured = vi.hoisted(() => ({ opts: undefined as unknown }));
vi.mock('cdk-local', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cdk-local')>();
  return {
    ...actual,
    createLocalStartCloudFrontCommand: (opts: unknown) => {
      captured.opts = opts;
      return new Command('start-cloudfront');
    },
  };
});

import { createLocalStartCloudFrontCommand } from '../../../src/cli/commands/local-start-cloudfront.js';
import { cdkdExtraStateProviders } from '../../../src/cli/commands/local-state-source.js';

describe('local start-cloudfront state providers', () => {
  it("passes cdkd's --from-state factory, which takes cdk-local's behavior (realAwsOnly)", () => {
    createLocalStartCloudFrontCommand();
    const providers = (captured.opts as { extraStateProviders: unknown }).extraStateProviders;
    expect(providers).toBe(cdkdExtraStateProviders);
  });
});
