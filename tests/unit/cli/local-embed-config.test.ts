import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { getEmbedConfig, resetEmbedConfig } from 'cdk-local';
import { createLocalCommand } from '../../../src/cli/commands/local-invoke.js';
import { getLogger } from '../../../src/utils/logger.js';

// Verifies that building the `cdkd local` command tree installs cdkd's
// branding into cdk-local's process-wide embed-config, so the re-export
// shims (runtime-image / websocket-* / layer-arn-materializer / ...) render
// `cdkd local` / `cdkd-local-*` instead of cdk-local's `cdkl` defaults.
describe('cdkd local embed-config branding', () => {
  afterEach(() => {
    // The config is process-wide module state in cdk-local's bundle; restore
    // the defaults so this file does not leak cdkd branding into other tests.
    resetEmbedConfig();
  });

  it('falls back to cdk-local defaults before the local command tree is built', () => {
    resetEmbedConfig();
    const cfg = getEmbedConfig();
    expect(cfg.cliName).toBe('cdkl');
    expect(cfg.resourceNamePrefix).toBe('cdkl');
  });

  it('installs cdkd branding when createLocalCommand runs', () => {
    resetEmbedConfig();
    createLocalCommand();
    expect(getEmbedConfig()).toEqual({
      logger: expect.any(Object),
      cliName: 'cdkd local',
      binaryName: 'cdkd',
      productName: 'cdkd',
      resourceNamePrefix: 'cdkd-local',
      awsBindMountPath: '/cdkd-aws',
      envPrefix: 'CDKD',
      // cdkd follows cdk-local's SigV4 default: warn-and-pass on unverifiable
      // AWS_IAM SigV4, opt IN to fail-closed via `--strict-sigv4`. These two
      // fields tell the shimmed sigv4-verify warn messages to keep cdkd's
      // cliName / binaryName branding while referencing the upstream flag.
      sigV4StrictByDefault: false,
      sigV4OptFlag: '--strict-sigv4',
    });
  });

  it("routes cdk-local's own log lines through cdkd's logger (go-to-k/cdkd#2429)", () => {
    resetEmbedConfig();
    createLocalCommand();
    const host = getEmbedConfig().logger;
    expect(host).toBeDefined();
    const info = vi.spyOn(getLogger(), 'info').mockImplementation(() => undefined);
    const setLevel = vi.spyOn(getLogger(), 'setLevel');
    const before = getLogger().getLevel();
    try {
      host!.info('Building container image (platform=linux/amd64)...');
      expect(info).toHaveBeenCalledWith('Building container image (platform=linux/amd64)...');
      // cdk-local's `--verbose` level raise reaches cdkd's logger, and its level
      // reads come back from it.
      host!.setLevel('debug');
      expect(setLevel).toHaveBeenCalledWith('debug');
      expect(host!.getLevel()).toBe('debug');
    } finally {
      getLogger().setLevel(before);
      vi.restoreAllMocks();
    }
  });

  describe('bridge fallback (go-to-k/cdkd#4967 security review)', () => {
    it("falls back to stderr, display-safe, when cdkd's logger throws on an arg", () => {
      resetEmbedConfig();
      createLocalCommand();
      const host = getEmbedConfig().logger!;
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;
      try {
        expect(() => host.info('line with a BigInt arg\u001b[2K', 1n)).not.toThrow();
        expect(() => host.warn('line with a circular arg', circular)).not.toThrow();
        const said = err.mock.calls.map((c) => String(c[0]));
        expect(said.some((l) => l.startsWith('line with a BigInt arg'))).toBe(true);
        expect(said.join('\n')).not.toContain('\u001b');
        expect(said.some((l) => l.includes('line with a circular arg'))).toBe(true);
        // Never cdk-local's own console path, which writes info to stdout.
        expect(info).not.toHaveBeenCalled();
        expect(out).not.toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    });

    it('drops a fallen-back debug line unless cdkd is at debug, and drops the args', () => {
      resetEmbedConfig();
      createLocalCommand();
      const host = getEmbedConfig().logger!;
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const before = getLogger().getLevel();
      try {
        // The suppression branch is reached only on a fallback; a re-entry
        // (a debug line logged while an info line is being forwarded) is one.
        getLogger().setLevel('info');
        const inner = vi.spyOn(getLogger(), 'info').mockImplementation(() => {
          host.debug('withheld detail');
        });
        host.info('outer');
        expect(inner).toHaveBeenCalledTimes(1);
        expect(err).not.toHaveBeenCalled();
        inner.mockRestore();
        getLogger().setLevel('debug');
        host.debug('withheld detail', { secret: 'ARG-SENTINEL' }, 1n);
        const said = err.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
        expect(said).toContain('withheld detail');
        expect(said).not.toContain('ARG-SENTINEL');
      } finally {
        getLogger().setLevel(before);
        vi.restoreAllMocks();
      }
    });

    it('does not recurse when a line re-enters the bridge', () => {
      resetEmbedConfig();
      createLocalCommand();
      const host = getEmbedConfig().logger!;
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      // cdkd's logger calling back into the bridge (e.g. a sink that logs
      // through cdk-local): the inner call must not forward again.
      const inner = vi.spyOn(getLogger(), 'info').mockImplementation((m: string) => {
        host.info(`inner: ${m}`);
      });
      try {
        expect(() => host.info('outer')).not.toThrow();
        expect(inner).toHaveBeenCalledTimes(1);
        expect(err.mock.calls.map((c) => String(c[0]))).toContain('inner: outer');
      } finally {
        vi.restoreAllMocks();
      }
    });
  });
});
