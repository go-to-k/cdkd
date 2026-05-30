import { afterEach, describe, expect, it } from 'vite-plus/test';
import { getEmbedConfig, resetEmbedConfig } from 'cdk-local';
import { createLocalCommand } from '../../../src/cli/commands/local-invoke.js';

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
});
