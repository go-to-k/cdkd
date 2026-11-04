import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../../../src/cli/program.js';
import {
  resetS3ClientDefaults,
  s3AddressingDecision,
  s3ClientDefaults,
} from '../../../src/utils/s3-client-defaults.js';
import { getLogger } from '../../../src/utils/logger.js';

describe('CLI profile propagation', () => {
  const originalProfile = process.env['AWS_PROFILE'];

  afterEach(() => {
    if (originalProfile === undefined) {
      delete process.env['AWS_PROFILE'];
    } else {
      process.env['AWS_PROFILE'] = originalProfile;
    }
  });

  it('sets AWS_PROFILE before a nested command action runs', async () => {
    delete process.env['AWS_PROFILE'];
    const program = buildProgram();
    let observedProfile: string | undefined;

    program
      .command('profile-test')
      .option('--profile <profile>')
      .action(() => {
        observedProfile = process.env['AWS_PROFILE'];
      });

    await program.parseAsync(['node', 'cdkd', 'profile-test', '--profile', 'test-profile']);

    expect(observedProfile).toBe('test-profile');
  });

  it('sets AWS_PROFILE when --profile belongs to the parent command', async () => {
    delete process.env['AWS_PROFILE'];
    const program = buildProgram();
    let observedProfile: string | undefined;
    const parent = program.command('profile-parent').option('--profile <profile>');

    parent.command('profile-child').action(() => {
      observedProfile = process.env['AWS_PROFILE'];
    });

    await program.parseAsync([
      'node',
      'cdkd',
      'profile-parent',
      '--profile',
      'test-profile',
      'profile-child',
    ]);

    expect(observedProfile).toBe('test-profile');
  });

  it('leaves an existing AWS_PROFILE untouched when --profile is not passed', async () => {
    process.env['AWS_PROFILE'] = 'preset-profile';
    const program = buildProgram();
    let observedProfile: string | undefined;

    program
      .command('profile-test')
      .option('--profile <profile>')
      .action(() => {
        observedProfile = process.env['AWS_PROFILE'];
      });

    await program.parseAsync(['node', 'cdkd', 'profile-test']);

    expect(observedProfile).toBe('preset-profile');
  });

  it('overrides an existing AWS_PROFILE with the --profile flag', async () => {
    process.env['AWS_PROFILE'] = 'preset-profile';
    const program = buildProgram();
    let observedProfile: string | undefined;

    program
      .command('profile-test')
      .option('--profile <profile>')
      .action(() => {
        observedProfile = process.env['AWS_PROFILE'];
      });

    await program.parseAsync(['node', 'cdkd', 'profile-test', '--profile', 'flag-profile']);

    expect(observedProfile).toBe('flag-profile');
  });

  it('resolves the S3 addressing style AFTER mirroring --profile, before the action runs (#5745)', async () => {
    const savedConfig = process.env['AWS_CONFIG_FILE'];
    const savedEndpoint = process.env['AWS_ENDPOINT_URL_S3'];
    const savedGlobal = process.env['AWS_ENDPOINT_URL'];
    const savedIgnore = process.env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'];
    delete process.env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'];
    const savedForce = process.env['CDK_S3_FORCE_PATH_STYLE'];
    delete process.env['CDK_S3_FORCE_PATH_STYLE'];
    delete process.env['AWS_PROFILE'];
    delete process.env['AWS_ENDPOINT_URL_S3'];
    delete process.env['AWS_ENDPOINT_URL'];
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-program-5745-'));
    process.env['AWS_CONFIG_FILE'] = join(dir, 'config');
    // Only the PROFILE carries the override, so the answer depends on the
    // mirror running first.
    writeFileSync(join(dir, 'config'), '[profile emu]\nendpoint_url = http://s3:4566\n');
    resetS3ClientDefaults();
    try {
      const program = buildProgram();
      let observed: ReturnType<typeof s3AddressingDecision> | undefined;
      program
        .command('s3-test')
        .option('--profile <profile>')
        .action(() => {
          observed = s3AddressingDecision();
        });
      await program.parseAsync(['node', 'cdkd', 's3-test', '--profile', 'emu']);
      expect(observed).toMatchObject({ source: 'resolved', forcePathStyle: true });
    } finally {
      resetS3ClientDefaults();
      if (savedConfig === undefined) delete process.env['AWS_CONFIG_FILE'];
      else process.env['AWS_CONFIG_FILE'] = savedConfig;
      if (savedEndpoint !== undefined) process.env['AWS_ENDPOINT_URL_S3'] = savedEndpoint;
      if (savedGlobal !== undefined) process.env['AWS_ENDPOINT_URL'] = savedGlobal;
      if (savedIgnore !== undefined) process.env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'] = savedIgnore;
      if (savedForce !== undefined) process.env['CDK_S3_FORCE_PATH_STYLE'] = savedForce;
    }
  });

  it("points the resolver's debug lines at cdkd's logger (#5745)", async () => {
    const savedEndpoint = process.env['AWS_ENDPOINT_URL_S3'];
    const savedIgnore = process.env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'];
    delete process.env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'];
    const savedForce = process.env['CDK_S3_FORCE_PATH_STYLE'];
    delete process.env['CDK_S3_FORCE_PATH_STYLE'];
    process.env['AWS_ENDPOINT_URL_S3'] = 'http://s3:4566';
    resetS3ClientDefaults();
    const debug = vi.spyOn(getLogger(), 'debug').mockImplementation(() => {});
    try {
      const program = buildProgram();
      program.command('s3-log-test').action(() => {
        s3ClientDefaults();
      });
      await program.parseAsync(['node', 'cdkd', 's3-log-test']);
      expect(
        debug.mock.calls.some(([m]) => String(m).includes('S3 path-style addressing enabled'))
      ).toBe(true);
    } finally {
      debug.mockRestore();
      resetS3ClientDefaults();
      if (savedEndpoint === undefined) delete process.env['AWS_ENDPOINT_URL_S3'];
      else process.env['AWS_ENDPOINT_URL_S3'] = savedEndpoint;
      if (savedIgnore !== undefined) process.env['AWS_IGNORE_CONFIGURED_ENDPOINT_URLS'] = savedIgnore;
      if (savedForce !== undefined) process.env['CDK_S3_FORCE_PATH_STYLE'] = savedForce;
    }
  });
});
