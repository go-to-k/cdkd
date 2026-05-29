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
      // cdkd ships fail-closed-by-default on unverifiable AWS_IAM SigV4
      // (security review #484) with an opt-OUT flag, the opposite polarity of
      // cdk-local's warn-and-pass default + opt-IN `--strict-sigv4`. These two
      // fields make the shimmed sigv4-verify warn messages reference cdkd's
      // flag + advice instead of cdk-local's.
      sigV4StrictByDefault: true,
      sigV4OptFlag: '--allow-unverified-sigv4',
    });
  });
});
