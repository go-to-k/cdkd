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

/**
 * `source` with comment lines dropped and literal splits joined, so a split
 * spelling reads as one: an inlined literal (`${'cdkd deploy'}`), a literal
 * concatenation across `+` and line breaks, and any run of whitespace. Cheap,
 * not a parser: it sees literals only, which is the shape a hand-written
 * remedy takes.
 */
function flattenSource(source: string): string {
  return (
    source
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n')
      // `${'cdkd deploy'}` -> cdkd deploy
      .replace(/\$\{\s*(['"`])([^'"`]*)\1\s*\}/g, '$2')
      // 'a ' + 'b', across line breaks -> a b
      .replace(/(['"`])\s*\+\s*(['"`])/g, '')
      .replace(/\s+/g, ' ')
  );
}

/** True when `source` spells a `cdkd deploy --replace` remedy as literals (#6245's fence). */
function replaceLiteralIn(source: string): boolean {
  return /cdkd deploy --replace(?!\\?`? would)/.test(flattenSource(source));
}

/**
 * Every Commander verb a remedy can name. A NEW top-level command is added
 * here by hand; the `knows every verb` case above catches one a converted
 * remedy names but the CLI does not declare.
 */
const REMEDY_VERB =
  '(?:bootstrap|synth|list|deploy|diff|drift|destroy|rollback|scrub|events|gc|orphan|refactor|' +
  'import|publish-assets|force-unlock|export|state(?: [a-z-]+)?|local(?: [a-z-]+)?)';

/**
 * A `cdkd <verb>` spelled as a literal right after an imperative cue — `run`,
 * `re-run`, `retry`, `use`, `with`, `via`, `then`, `inspect`, `check`, or a
 * `: ` (go-to-k/cdkd#6262). Such a remedy prints without the run's typed
 * `--aws-emulator` / `--profile` / `--state-bucket`, so a pasted one under
 * `--aws-emulator` reaches real AWS. A `: ` followed by a QUOTE is an object
 * key (`{ command: 'cdkd destroy' }`), not prose, so it is not a cue.
 */
const REMEDY_LITERAL = new RegExp(
  `(?:\\b(?:[Rr]un|[Rr]e-run|[Rr]erun|[Rr]etry|[Uu]se|[Ww]ith|[Vv]ia|[Tt]hen|[Ii]nspect|[Cc]heck)` +
    `\\s+[\`'"]?|:\\s+)cdkd ${REMEDY_VERB}\\b`,
  'g'
);

/** The normalised context of every {@link REMEDY_LITERAL} hit in `source`. */
function remedyLiteralsIn(source: string): string[] {
  const flat = flattenSource(source);
  return [...flat.matchAll(REMEDY_LITERAL)].map((m) =>
    flat.slice(Math.max(0, m.index - 80), m.index + m[0].length + 40)
  );
}

/**
 * Cued mentions that are NOT a command to paste, each `[file, a substring of
 * the hit's normalised context, why]`. An entry must match exactly one hit, so
 * a stale one fails too. Keep it small: when in doubt, build the command with
 * `cdkdRemedy` — that is byte-identical when the run typed no flag.
 */
const DESCRIPTIVE_REMEDY_MENTIONS: ReadonlyArray<readonly [string, string, string]> = [
  // --help / option / usage text: read in the help screen, where no run flag exists.
  ['src/cli/commands/destroy.ts', 'already-destroyed stack: cdkd events prune', '--help text'],
  ['src/cli/commands/force-unlock.ts', 'Usage: cdkd force-unlock', 'a usage line'],
  ['src/cli/commands/local-invoke.ts', 'already deployed via cdkd deploy.', 'option help'],
  ['src/cli/commands/local-start-api.ts', 'already deployed via cdkd deploy. Mirrors', 'option help'],
  ['src/cli/commands/orphan.ts', "behavior, use 'cdkd state orphan <stack>'", '--help text'],
  ['src/cli/commands/state/destroy.ts', "orphan'.\" ) .argument", '.description text'],
  ['src/cli/commands/state/destroy.ts', "orphan'.\", ].join", '--help text'],
  ['src/cli/commands/state/refresh-observed.ts', 'Run cdkd scrub first on state', '.description text'],
  ['src/cli/options.ts', "this region is opted in via 'cdkd bootstrap'", 'option help'],
  ['src/cli/options.ts', "not yet opted in via 'cdkd bootstrap'", 'option help'],
  // Not a command at all: "cdkd state" is the noun, "cdkd state's" a possessive.
  ['src/cli/commands/export/composite-id-shapes.ts', "VPCGatewayAttachment: cdkd state's", 'noun'],
  ['src/cli/commands/export/composite-id-shapes.ts', "AWS::EC2::Route: cdkd state's", 'noun'],
  ['src/cli/commands/retire-cfn-stack/prepare.ts', 'written yet: cdkd state and', 'noun'],
  // Describes what a command does or did, or forbids running it.
  ['src/cli/commands/bootstrap.ts', 'You can now use cdkd deploy with:', 'lead-in to the flag lines below'],
  ['src/cli/commands/export/per-stack-phases.ts', 'Do NOT run cdkd destroy on the tree', 'a prohibition'],
  ['src/cli/commands/import/stack-state.ts', 'as imported: cdkd rollback leaves', 'describes rollback'],
  ['src/cli/commands/local-state-loader.ts', "Was it deployed via 'cdkd deploy'?", 'a question'],
  ['src/local/mixed-mode-state.ts', "Was it deployed via 'cdkd deploy'", 'a regex stripping that question'],
  ['src/deployment/cc-pending-requests.ts', 'deploy created: cdkd destroy, cdkd rollback', 'lists what settles the entry'],
  ['src/provisioning/providers/custom-resource/delete-skip-reasons.ts', "Do not drop this record with 'cdkd state orphan'", 'a prohibition'],
  ['src/provisioning/providers/docdb/cluster-update.ts', 'cdkd drift --revert does not change', 'describes revert'],
  ['src/state/malformed-resources-bag/properties.ts', "Do NOT run 'cdkd deploy' against", 'a prohibition'],
  // Points at the deliberately unfilled template printed on its own line below
  // (`.claude/rules/state-malformed-containers.md`).
  ['src/state/malformed-resources-bag/orphans-container.ts', "run 'cdkd state orphan' against the stack", 'names the template below'],
  ['src/state/malformed-resources-bag/resources.ts', "run 'cdkd state orphan' against the stack", 'names the template below'],
];

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
          for (const m of readFileSync(full, 'utf8').matchAll(
            /(?:pasteableCommand|cdkdRemedy)\(\s*'(cdkd [a-z -]+)'/g
          )) {
            verbs.add(m[1]!);
          }
        }
      }
    };
    walk('src');
    // Floor: the census found 17 distinct verbs; a broken scan must not pass.
    // It sees only a LITERAL first argument: a site passing the verb through a
    // variable (`destroy-runner/under-lock-steps.ts`'s `hintCommand`) is covered only while its
    // verbs are also spelled literally somewhere, as they are today.
    expect(verbs.size).toBeGreaterThanOrEqual(16);
    const unknown = [...verbs].filter((v) => pasteableVerbFlags(v) === undefined);
    expect(unknown).toEqual([]);
  });

  it('spells no replacement remedy as a literal, so none loses --aws-emulator (#6245)', () => {
    // A `cdkd deploy --replace` the operator is told to RUN goes through
    // `deployReplaceCommand`, which appends the run's flags. Comment lines and
    // the descriptive "`cdkd deploy --replace` would ..." clauses are exempt.
    //
    // Each file is NORMALISED first, so a split spelling is caught too: an
    // inlined literal (`${'cdkd deploy'}`), a literal concatenation across `+`
    // and line breaks, and any run of whitespace. Cheap, not a parser: it
    // sees literals only, which is the shape a hand-written remedy takes.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts') && replaceLiteralIn(readFileSync(full, 'utf8'))) {
          offenders.push(full);
        }
      }
    };
    walk('src');
    expect(offenders).toEqual([]);
  });

  it('the replacement-remedy fence sees split spellings (probe)', () => {
    const caught = [
      "const a = 'Re-deploy with cdkd deploy --replace.';",
      'const a = `Re-deploy with ${"cdkd deploy"} --replace.`;',
      "const a = 'Re-deploy with cdkd deploy ' + '--replace.';",
      "const a = 'Re-deploy with cdkd deploy ' +\n  '--replace.';",
      "const a = 'Re-deploy with cdkd  deploy   --replace.';",
      'const a = "cdkd deploy" + " --replace";',
    ];
    for (const src of caught) expect(replaceLiteralIn(src), src).toBe(true);
    const passed = [
      "// Re-deploy with cdkd deploy --replace.",
      " * `cdkd deploy --replace` in a doc comment",
      "const a = `\\`cdkd deploy --replace\\` would refuse the same way`;",
      "const a = `Re-deploy with ${deployReplaceCommand()}.`;",
      "const a = cdkdRemedy('cdkd deploy', '--replace');",
    ];
    for (const src of passed) expect(replaceLiteralIn(src), src).toBe(false);
  });

  it('spells no other cdkd remedy as a literal, so none loses --aws-emulator (#6262)', () => {
    const unexplained: string[] = [];
    const used = new Map<number, number>();
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts')) {
          const file = full.split(path.sep).join('/');
          for (const hit of remedyLiteralsIn(readFileSync(full, 'utf8'))) {
            const i = DESCRIPTIVE_REMEDY_MENTIONS.findIndex(
              ([f, snippet]) => f === file && hit.includes(snippet)
            );
            if (i === -1) unexplained.push(`${file}: ${hit}`);
            else used.set(i, (used.get(i) ?? 0) + 1);
          }
        }
      }
    };
    walk('src');
    expect(unexplained).toEqual([]);
    // Each allowlisted mention matches exactly one hit: a stale entry, or one
    // broad enough to hide a second literal, fails.
    const misfit = DESCRIPTIVE_REMEDY_MENTIONS.flatMap(([f, s], i) =>
      used.get(i) === 1 ? [] : [`${f}: ${s} (${used.get(i) ?? 0} hits)`]
    );
    expect(misfit).toEqual([]);
  });

  it('the remedy fence sees each cue and a split spelling, and skips built commands (probe)', () => {
    const caught = [
      "const a = `Re-run 'cdkd bootstrap' for this region.`;",
      "const a = 'drop it with `cdkd orphan <construct path>` and deploy';",
      "const a = 'Run cdkd drift ' + '--revert to restore it.';",
      "const a = 'Clear it with ' +\n  'cdkd force-unlock.';",
      'const a = `Destroy the consumer first: cdkd destroy x`;',
      "const a = 'use cdkd state  show to see it';",
      "const a = 'then re-run cdkd refactor.';",
      "const a = 'adopt it with cdkd import';",
      "const a = 'Check it with cdkd drift.';",
      "const a = `run ${'cdkd rollback'} --revert-failed`;",
    ];
    for (const src of caught) expect(remedyLiteralsIn(src), src).toHaveLength(1);
    const passed = [
      "// Re-run 'cdkd bootstrap' for this region.",
      " * run `cdkd drift --revert` in a doc comment",
      "const a = `Re-run '${cdkdRemedy('cdkd bootstrap')}' for this region.`;",
      "const a = pasteableCommand('cdkd rollback', [{ value: s, hole: 'stack' }]).command;",
      "watchCommandInterrupt({ command: 'cdkd destroy' });",
      "const a = 'the entry cdkd destroy keeps retrying';",
    ];
    for (const src of passed) expect(remedyLiteralsIn(src), src).toEqual([]);
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

  it('carries a typed --aws-emulator, so a pasted hint talks to the same emulator (#6138)', () => {
    setPasteableRunFlags({ awsEmulator: 'https://127.0.0.1:9331' });
    expect(pasteableCommand('cdkd state orphan', stack).command).toBe(
      'cdkd state orphan MyStack --aws-emulator=https://127.0.0.1:9331'
    );
    setPasteableRunFlags({ awsEmulator: true });
    expect(pasteableCommand('cdkd state orphan', stack).command).toBe(
      'cdkd state orphan MyStack --aws-emulator'
    );
    setPasteableRunFlags({ awsEmulator: 'https://127.0.0.1:9331;rm' });
    expect(pasteableCommand('cdkd state orphan', stack).command).toBe(
      "cdkd state orphan MyStack --aws-emulator='<url>'"
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
