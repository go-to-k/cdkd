import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { buildProgram } from '../../../src/cli/program.js';
import { parseStatePrefix } from '../../../src/cli/options.js';
import {
  pasteableRunFlags,
  pasteableVerbFlags,
  setPasteableRunFlags,
  setPasteableVerbFlags,
} from '../../../src/utils/pasteable-run-context.js';
import { pasteableCommand } from '../../../src/utils/pasteable-command.js';
import { setPasteableAwsProfile } from '../../../src/utils/pasteable-aws-profile.js';
import { StackTerminationProtectionError } from '../../../src/utils/error-handler.js';
import { rerunRollback } from '../../../src/cli/commands/rollback.js';
import { forceQuitReleaseCommand } from '../../../src/cli/commands/deploy.js';
import { buildForceUnlockCommand } from '../../../src/state/lock-contention-message.js';

/**
 * go-to-k/cdkd#4177: every pasteable `cdkd ...` hint carries the run's
 * explicitly typed `--profile` / `--state-bucket` / `--state-prefix` (and a
 * refusing `--role-arn` hole), limited to the flags the hinted subcommand
 * parses. Process state, so every case starts and ends cleared.
 */
beforeEach(() => {
  setPasteableRunFlags({});
  setPasteableVerbFlags(undefined);
});
afterEach(() => {
  setPasteableRunFlags({});
  setPasteableVerbFlags(undefined);
  setPasteableAwsProfile(undefined);
});

const stack = [{ value: 'MyStack', hole: 'stack' }] as const;

describe('without a built program or recorded flags', () => {
  it('adds nothing when no verb table is registered', () => {
    setPasteableRunFlags({ profile: 'prod', stateBucket: 'b' });
    expect(pasteableCommand('cdkd state orphan', stack).command).toBe('cdkd state orphan MyStack');
  });

  it('adds nothing when the run typed no flag', () => {
    buildProgram();
    expect(pasteableCommand('cdkd state orphan', stack).command).toBe('cdkd state orphan MyStack');
  });
});

describe('the verb table is read off the real Commander tree', () => {
  it('knows every verb a src hint names, so none silently loses its flags', () => {
    buildProgram();
    const verbs = new Set<string>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts')) {
          for (const m of readFileSync(full, 'utf8').matchAll(/pasteableCommand\(\s*'(cdkd [a-z -]+)'/g)) {
            verbs.add(m[1]!);
          }
        }
      }
    };
    walk('src');
    // Floor: the census found 17 distinct verbs; a broken scan must not pass.
    // It sees only a LITERAL first argument: a site passing the verb through a
    // variable (`destroy-runner.ts`'s `hintCommand`) is covered only while its
    // verbs are also spelled literally somewhere, as they are today.
    expect(verbs.size).toBeGreaterThanOrEqual(16);
    const unknown = [...verbs].filter((v) => pasteableVerbFlags(v) === undefined);
    expect(unknown).toEqual([]);
  });

  it('records the state flags where the command declares them', () => {
    buildProgram();
    const orphan = pasteableVerbFlags('cdkd state orphan');
    expect(orphan?.has('--profile')).toBe(true);
    expect(orphan?.has('--state-bucket')).toBe(true);
  });
});

describe('rendering', () => {
  beforeEach(() => {
    buildProgram();
  });

  it('appends the typed profile, bucket and a CLI prefix, in order', () => {
    setPasteableRunFlags({ profile: 'prod', stateBucket: 'my-bucket', statePrefix: 'team/cdkd' });
    expect(
      pasteableCommand('cdkd state orphan', [
        ...stack,
        { flag: '--stack-region', value: 'us-east-1', hole: 'region' },
      ]).command
    ).toBe(
      'cdkd state orphan MyStack --stack-region us-east-1 --profile prod --state-bucket my-bucket --state-prefix team/cdkd'
    );
  });

  it("prints an explicitly empty prefix as '' (it keys a real key space)", () => {
    setPasteableRunFlags({ statePrefix: '' });
    expect(pasteableCommand('cdkd state orphan', stack).command).toBe(
      "cdkd state orphan MyStack --state-prefix ''"
    );
  });

  it('prints the refusing role-arn hole, never the ARN', () => {
    setPasteableRunFlags({ roleArn: true });
    expect(pasteableCommand('cdkd state orphan', stack).command).toBe(
      "cdkd state orphan MyStack --role-arn '<role-arn>'"
    );
  });

  it.each([
    ['--profile', { profile: 'a b' }, "'<profile>'"],
    ['--profile', { profile: 'x;y' }, "'<profile>'"],
    ['--profile', { profile: '-x' }, "'<profile>'"],
    ['--profile', { profile: 'p\u001bq' }, "'<profile>'"],
    ['--state-bucket', { stateBucket: 'b`id`' }, "'<bucket>'"],
    ['--state-prefix', { statePrefix: 'p$(id)' }, "'<prefix>'"],
  ] as const)('holes a %s value that is not inert in a shell (%j)', (flag, flags, hole) => {
    setPasteableRunFlags(flags);
    expect(pasteableCommand('cdkd state orphan', stack).command).toBe(
      `cdkd state orphan MyStack ${flag} ${hole}`
    );
  });

  it.each([
    ['an invisible format character', 'prod\u200b'],
    ['a length past the cap', 'p'.repeat(1200)],
  ])('holes a profile holding %s', (_what, profile) => {
    setPasteableRunFlags({ profile });
    expect(pasteableCommand('cdkd state orphan', stack).command).toBe(
      "cdkd state orphan MyStack --profile '<profile>'"
    );
  });

  it("does not duplicate an explicit empty prefix passed as a literal (malformed-bag shape)", () => {
    setPasteableRunFlags({ statePrefix: '' });
    expect(
      pasteableCommand('cdkd state list', [{ literal: '--json' }, { literal: "--state-prefix ''" }])
        .command
    ).toBe("cdkd state list --json --state-prefix ''");
  });

  it('keeps a non-ASCII profile, quoted', () => {
    setPasteableRunFlags({ profile: 'prod-é' });
    expect(pasteableCommand('cdkd state orphan', stack).command).toBe(
      "cdkd state orphan MyStack --profile 'prod-é'"
    );
  });

  it('never adds a flag the hinted subcommand does not parse (bootstrap has no --state-prefix)', () => {
    setPasteableRunFlags({ profile: 'prod', stateBucket: 'b', statePrefix: 'p' });
    expect(pasteableVerbFlags('cdkd bootstrap')?.has('--state-prefix')).toBe(false);
    expect(pasteableCommand('cdkd bootstrap').command).toBe(
      'cdkd bootstrap --profile prod --state-bucket b'
    );
  });

  it('does not duplicate a flag the caller already passed (force-unlock)', () => {
    setPasteableRunFlags({ profile: 'prod', stateBucket: 'b' });
    const cmd = buildForceUnlockCommand('MyStack', 'us-east-1', {
      profile: 'prod',
      stateBucket: 'b',
    });
    expect(cmd.match(/--profile/g)).toHaveLength(1);
    expect(cmd.match(/--state-bucket/g)).toHaveLength(1);
  });

  it('does not duplicate a flag the caller passed as an argument (orphan refusal shape)', () => {
    setPasteableRunFlags({ profile: 'prod', stateBucket: 'b' });
    expect(
      pasteableCommand('cdkd state orphan', [
        ...stack,
        { flag: '--profile', value: 'other', hole: 'profile' },
      ]).command
    ).toBe('cdkd state orphan MyStack --profile other --state-bucket b');
  });

  it('reaches the error-handler family (cdkd destroy retry line)', () => {
    setPasteableRunFlags({ profile: 'prod', stateBucket: 'b' });
    expect(new StackTerminationProtectionError('MyStack').message).toContain(
      'Retry with: cdkd destroy MyStack --profile prod --state-bucket b'
    );
  });

  it("reaches deploy's force-quit Release line", () => {
    expect(forceQuitReleaseCommand()).toBe(
      "cdkd force-unlock '<stackName>' --stack-region '<region>'"
    );
    setPasteableRunFlags({ profile: 'prod', stateBucket: 'b' });
    expect(forceQuitReleaseCommand()).toBe(
      "cdkd force-unlock '<stackName>' --stack-region '<region>' --profile prod --state-bucket b"
    );
  });

  it('reaches the CLI family (cdkd rollback re-run line)', () => {
    setPasteableRunFlags({ profile: 'prod', stateBucket: 'b' });
    expect(rerunRollback('MyStack')).toContain(
      'Re-run with: cdkd rollback MyStack --profile prod --state-bucket b'
    );
  });
});

describe("the CLI's preAction hook records only what was typed", () => {
  function runForceUnlock(argv: string[]): void {
    const program = buildProgram();
    const cmd = program.commands.find((c) => c.name() === 'force-unlock');
    if (!cmd) throw new Error('no force-unlock command');
    cmd.action(() => {});
    program.parse(['force-unlock', 'MyStack', ...argv], { from: 'user' });
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('records typed flags, and a typed --state-prefix only', () => {
    runForceUnlock(['--profile', 'prod', '--state-bucket', 'b', '--state-prefix', 'p']);
    expect(pasteableRunFlags()).toEqual({
      profile: 'prod',
      stateBucket: 'b',
      statePrefix: 'p',
      roleArn: false,
    });
  });

  it('records a typed --role-arn as true (the value itself is never kept)', () => {
    runForceUnlock(['--role-arn', 'arn:aws:iam::123456789012:role/x']);
    expect(pasteableRunFlags().roleArn).toBe(true);
    expect(JSON.stringify(pasteableRunFlags())).not.toContain('123456789012');
  });

  it("refuses a '<prefix>' placeholder pasted back as --state-prefix, so the hole fails closed", () => {
    expect(() => runForceUnlock(['--state-prefix', '<prefix>'])).toThrow(/cannot contain/);
    expect(parseStatePrefix('')).toBe('');
    expect(parseStatePrefix(' team/a ')).toBe(' team/a ');
  });

  it('records no prefix when it came from its default, and clears stale flags', () => {
    setPasteableRunFlags({ profile: 'stale', stateBucket: 'stale', statePrefix: 'stale' });
    vi.stubEnv('CDKD_STATE_BUCKET', 'from-env');
    vi.stubEnv('AWS_PROFILE', 'from-env');
    vi.stubEnv('CDKD_ROLE_ARN', 'arn:aws:iam::123456789012:role/from-env');
    runForceUnlock([]);
    expect(pasteableRunFlags()).toEqual({
      profile: undefined,
      stateBucket: undefined,
      statePrefix: undefined,
      roleArn: false,
    });
  });
});
