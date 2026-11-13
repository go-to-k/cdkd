import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdkd#6150 (maintainer "Plan A"): under --aws-emulator with no state
// source, template env values that reference a resource are dropped; after the
// per-variable warnings, ONE hint names the way to read them. The text and the
// once-per-process gate are cdk-local's (`takeAwsEmulatorStateSourceHint`,
// shared with its engine commands), so cdkd asks for it and never prints twice.

const warn = vi.hoisted(() => vi.fn());
const take = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const leaf = { info: vi.fn(), debug: vi.fn(), warn, error: vi.fn(), child: () => leaf };
  return { ...actual, getLogger: () => leaf };
});
vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  takeAwsEmulatorStateSourceHint: take,
}));

import { setActiveWorkloadAwsWiring, type WorkloadAwsWiring } from 'cdk-local/internal';
import { warnAwsEmulatorStateSourceHint } from '../../../src/local/local-aws-wiring.js';

afterEach(() => {
  setActiveWorkloadAwsWiring(undefined);
  warn.mockReset();
  take.mockReset();
});

describe('the --aws-emulator state-source hint', () => {
  it("prints cdk-local's hint once: cdk-local's gate answers once per process", () => {
    setActiveWorkloadAwsWiring({ mode: 'emulator', dispose: () => {} } as unknown as WorkloadAwsWiring);
    take.mockReturnValueOnce('HINT').mockReturnValue(undefined);
    warnAwsEmulatorStateSourceHint(2, false);
    warnAwsEmulatorStateSourceHint(3, false);
    expect(warn.mock.calls).toEqual([['HINT']]);
  });

  it('does not even ask with a state source or with nothing dropped (the gate is not consumed)', () => {
    warnAwsEmulatorStateSourceHint(2, true);
    warnAwsEmulatorStateSourceHint(0, false);
    expect(take).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("cdk-local's hint text under cdkd's embed config, unmocked", () => {
  it('names `cdkd deploy --aws-emulator` (the deployCommand cdkd passes), and answers exactly once', async () => {
    const actual = await vi.importActual<typeof import('cdk-local/internal')>('cdk-local/internal');
    const { resetEmbedConfig } = await import('cdk-local');
    const { createLocalCommand } = await import('../../../src/cli/commands/local-invoke.js');
    createLocalCommand();
    actual.setActiveWorkloadAwsWiring({ mode: 'emulator', dispose: () => {} } as unknown as WorkloadAwsWiring);
    try {
      const text = actual.takeAwsEmulatorStateSourceHint() ?? '';
      expect(text).toContain('`cdkd deploy --aws-emulator`');
      expect(text).not.toContain('cdkd local deploy');
      expect(text).toContain('--from-cfn-stack');
      expect(text).toContain('--env-vars');
      expect(actual.takeAwsEmulatorStateSourceHint()).toBeUndefined();
    } finally {
      actual.setActiveWorkloadAwsWiring(undefined);
      resetEmbedConfig();
    }
  });
});
