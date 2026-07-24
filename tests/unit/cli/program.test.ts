import { afterEach, describe, expect, it } from 'vite-plus/test';
import { buildProgram } from '../../../src/cli/program.js';

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
});
