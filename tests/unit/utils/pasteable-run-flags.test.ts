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
import { pasteableCommand, proseQuoted } from '../../../src/utils/pasteable-command.js';
import { missingStateBucketRemedy } from '../../../src/utils/missing-state-bucket-remedy.js';
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
      // an escaped newline inside a literal reads as the break it prints
      .replace(/\\n/g, ' ')
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
  'import|publish-assets|force-unlock|export|' +
  // `state` and `local` only with a subcommand: a bare "cdkd state" is the noun.
  'state (?:info|browse|list|resources|show|orphan|destroy|migrate|refresh-observed)|local [a-z-]+)';

/**
 * A `cdkd <verb>` spelled as a literal right after a cue (go-to-k/cdkd#6262):
 * an imperative word in any case (`run`, `re-run`, `retry`, `try`, `use`,
 * `with`, `via`, `then`, `inspect`, `check`), a list joiner naming a SECOND
 * command (`or`, `,`, `/`), a `: ` or `? ` (a label, or a ternary arm picking
 * the literal), or a `- ` bullet, then an optional quote or escaped backtick.
 * Such a remedy prints without the run's typed `--aws-emulator` /
 * `--profile` / `--state-bucket`, so a pasted one under `--aws-emulator`
 * reaches real AWS.
 */
const REMEDY_LITERAL = new RegExp(
  `(?:\\b(?i:run|re-run|rerun|retry|try|use|with|via|then|inspect|check|or)|[:?,/]|(?:^|\\s)-)` +
    `\\s+(?:\\\\?[\`'"])?cdkd ${REMEDY_VERB}\\b` +
    // A command spelled with a flag or an interpolated argument is one to run
    // whatever word precedes it (`records it for \`cdkd rollback --revert-failed\``).
    `|cdkd ${REMEDY_VERB}(?= --[a-z]| \\$\\{)`,
  'g'
);

/**
 * An object key whose value is a verb the code passes ON, not prose:
 * `{ command: 'cdkd destroy' }`. A `: ` cue after one of these is no remedy.
 */
const VERB_VALUED_KEY = /\b(?:command|rerunCommand|deployCommand)\s*$/;

/** The normalised context of every {@link REMEDY_LITERAL} hit in `source`. */
function remedyLiteralsIn(source: string): string[] {
  const flat = flattenSource(source);
  return [...flat.matchAll(REMEDY_LITERAL)]
    .filter((m) => !(m[0].startsWith(':') && VERB_VALUED_KEY.test(flat.slice(0, m.index))))
    .filter((m) => {
      // A whole-literal verb passed as an ARGUMENT (`withheldTargetClause(b, 'stack',
      // 'cdkd destroy')`) is a verb a builder receives, not prose.
      const q = /^,\s+(['"`])cdkd /.exec(m[0]);
      return !(q && flat[m.index + m[0].length] === q[1]);
    })
    .map((m) => flat.slice(Math.max(0, m.index - 80), m.index + m[0].length + 40));
}

/**
 * True when `source` wraps a BUILT command in prose quotes or backticks
 * (`'${cdkdRemedy(...)}'`). A run flag's quoted hole (`--role-arn
 * '<role-arn>'`) closes such a wrapper; `proseQuoted` decides on the final
 * string instead (go-to-k/cdkd#6262).
 */
function wrappedBuiltCommandIn(source: string): boolean {
  return /(?:['"]|\\`)\$\{\s*(?:cdkdRemedy|pasteableCommand|deployReplaceCommand|importRemedyCommand)\(/.test(
    source
  );
}

/**
 * Files whose fence hits are all mentions, not commands to paste: `[file, hits,
 * why]`. A file's hit count must equal `hits` EXACTLY, so a new literal remedy
 * added to a listed file fails as surely as one in an unlisted file, and a
 * stale count fails too. When in doubt, build the command with `cdkdRemedy`.
 */
const DESCRIPTIVE_REMEDY_MENTIONS: ReadonlyArray<readonly [string, number, string]> = [
  // --help / option / `.description` / Usage text: read where no run flag exists.
  ['src/cli/commands/destroy.ts', 1, '--help text'],
  ['src/cli/commands/force-unlock.ts', 1, 'a usage line'],
  ['src/cli/commands/local-invoke.ts', 1, 'option help'],
  ['src/cli/commands/local-start-api.ts', 4, 'option help'],
  ['src/cli/commands/local-start-api/command.ts', 1, "an elided '...' example in a hint"],
  ['src/cli/commands/orphan.ts', 1, '--help text'],
  ['src/cli/commands/state/destroy.ts', 2, '.description / --help text'],
  ['src/cli/commands/state/refresh-observed.ts', 2, 'a usage line and .description text'],
  ['src/cli/options.ts', 2, 'option help'],
  // A label, a prompt name, or a log line naming the running command.
  ['src/cli/commands/bootstrap-destroy.ts', 2, "the running command's own log lines"],
  ['src/cli/commands/bootstrap.ts', 1, 'lead-in to the flag lines below'],
  ['src/cli/commands/import/nested.ts', 4, 'error-message label naming the running mode'],
  ['src/cli/commands/rollback-drop-failed.ts', 1, 'names the confirmation prompt'],
  ['src/cli/commands/state-refresh-observed.ts', 1, 'names the confirmation prompt'],
  ['src/local/invoke-agentcore-watch-loop.ts', 1, 'log prefix'],
  ['src/local/mixed-mode-state.ts', 1, 'a regex stripping a question'],
  ['src/cli/commands/local-state-loader.ts', 1, 'a question'],
  // A verb a builder receives (`command: x ? 'cdkd state destroy' : 'cdkd destroy'`).
  ['src/cli/commands/destroy-runner/under-lock-steps.ts', 2, 'ternary verb value for a builder'],
  // Describes what a command does or did, or forbids running it.
  ['src/analyzer/refactor-pairing.ts', 1, 'describes refactor'],
  ['src/cli/commands/export/command.ts', 1, 'a prohibition'],
  ['src/cli/commands/export/import-plan.ts', 1, 'names what wrote a record'],
  ['src/cli/commands/export/per-stack-loop.ts', 1, 'subject of a sentence'],
  ['src/cli/commands/export/per-stack-phases.ts', 1, 'a prohibition'],
  ['src/cli/commands/import/stack-state.ts', 1, 'describes rollback'],
  ['src/cli/commands/refactor/plan.ts', 1, 'describes diff and deploy'],
  ['src/cli/commands/scrub/stack-rewrite.ts', 1, 'describes diff'],
  ['src/deployment/custom-resource-service-token.ts', 1, 'describes deploy'],
  ['src/deployment/deploy-engine/name-collision.ts', 1, 'describes destroy'],
  [
    'src/deployment/deploy-engine/update-replace/create-first.ts',
    4,
    "'`cdkd deploy --replace` would ...' clauses, which #6245's fence exempts too",
  ],
  ['src/deployment/deploy-engine/update-in-place.ts', 1, 'names what refused'],
  ['src/deployment/nested-child-journal.ts', 1, 'a recorded reason'],
  ['src/deployment/rollback-executor/journaled-orphans.ts', 1, 'describes rollback / destroy'],
  ['src/deployment/rollback-executor/messages.ts', 1, 'describes rollback --orphan'],
  ['src/deployment/rollback-executor/replay-props.ts', 1, 'names what wrote a record'],
  ['src/local/ecs-task-resolver/target.ts', 1, 'states what the commands honor'],
  ['src/provisioning/composite-id.ts', 1, 'names where the record is kept'],
  ['src/provisioning/redacted-delete-address.ts', 1, 'names where the record is kept'],
  ['src/provisioning/providers/rds-dbproxy-targetgroup/delete.ts', 1, 'names where the record is kept'],
  ['src/provisioning/providers/custom-resource/delete-skip-reasons.ts', 2, 'a prohibition; when cdkd re-resolves'],
  ['src/provisioning/providers/custom-resource/delete.ts', 1, 'names what wrote a record'],
  ['src/provisioning/providers/docdb/cluster-update.ts', 1, 'describes drift --revert'],
  ['src/provisioning/providers/dynamodb-table/index-warnings.ts', 2, 'describes drift --revert'],
  ['src/provisioning/providers/iam-managed-policy/update.ts', 1, 'describes drift --accept'],
  ['src/provisioning/providers/iam-policy/update.ts', 1, 'describes drift --revert'],
  ['src/provisioning/providers/iam-role/update.ts', 1, 'describes drift --accept'],
  ['src/provisioning/providers/rds/calls.ts', 1, 'describes drift --revert'],
  ['src/provisioning/region-check.ts', 1, 'describes a run shape'],
  ['src/state/malformed-resources-bag/orphan-records.ts', 1, 'describes rollback'],
  ['src/state/malformed-resources-bag/properties.ts', 3, 'a prohibition; describes drift / deploy'],
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
          const hits = remedyLiteralsIn(readFileSync(full, 'utf8'));
          const i = DESCRIPTIVE_REMEDY_MENTIONS.findIndex(([f]) => f === file);
          if (i !== -1) used.set(i, hits.length);
          else unexplained.push(...hits.map((hit) => `${file}: ${hit}`));
        }
      }
    };
    walk('src');
    expect(unexplained).toEqual([]);
    // Each listed file has exactly its count of hits: a new literal in it, or a
    // stale count, fails.
    const misfit = DESCRIPTIVE_REMEDY_MENTIONS.flatMap(([f, n], i) =>
      used.get(i) === n ? [] : [`${f}: expected ${n} hits, found ${used.get(i) ?? 0}`]
    );
    expect(misfit).toEqual([]);
  });

  it('wraps no built command in prose quotes or backticks (#6262)', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.ts') && wrappedBuiltCommandIn(readFileSync(full, 'utf8'))) {
          offenders.push(full);
        }
      }
    };
    walk('src');
    expect(offenders).toEqual([]);
    // probe
    expect(wrappedBuiltCommandIn("x = `Re-run '${cdkdRemedy('cdkd bootstrap')}' now`;")).toBe(true);
    expect(wrappedBuiltCommandIn('x = `adopt it with \\`${cdkdRemedy(\'cdkd import\')}\\``;')).toBe(true);
    expect(wrappedBuiltCommandIn("x = `Re-run ${proseQuoted(cdkdRemedy('cdkd bootstrap'))} now`;")).toBe(
      false
    );
  });

  it('proseQuoted keeps the wrapper only around a command with no quote character', () => {
    expect(proseQuoted('cdkd bootstrap')).toBe("'cdkd bootstrap'");
    expect(proseQuoted('cdkd bootstrap', '`')).toBe('`cdkd bootstrap`');
    expect(proseQuoted("cdkd bootstrap --role-arn '<role-arn>'")).toBe(
      "cdkd bootstrap --role-arn '<role-arn>'"
    );
  });

  it('a prose-quoted remedy stays pasteable with --role-arn typed (#6262 M1)', () => {
    buildProgram();
    setPasteableRunFlags({ roleArn: true, profile: 'a b' });
    expect(missingStateBucketRemedy('it')).toBe(
      "Run cdkd bootstrap --profile '<profile>' --role-arn '<role-arn>' to create it."
    );
    setPasteableRunFlags({});
    expect(missingStateBucketRemedy('it')).toBe("Run 'cdkd bootstrap' to create it.");
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
      // an escaped backtick after the cue
      'const a = `adopt it with \\`cdkd import\\` now`;',
      // a literal \n before the cue
      "const a = '\\nRun cdkd diff to confirm';",
      // an uppercase cue
      "const a = 'RE-RUN cdkd refactor';",
      "const a = 'Try cdkd drift first';",
      // a bullet
      "const a = '  - cdkd state show x';",
      // an object key that is prose, not a verb-valued key
      "const a = { instead: 'cdkd local start-api x' };",
      // a ternary arm
      "const c = x ? 'cdkd state destroy' : y;",
      // a flag-carrying or interpolated command after any word
      "const a = 'the journal records it for `cdkd rollback --revert-failed`.';",
      'const a = `confirm, and cdkd drift ${id} shows it`;',
    ];
    for (const src of caught) expect(remedyLiteralsIn(src), src).toHaveLength(1);
    // the second command of a list is a hit of its own
    for (const src of [
      "const a = 'Run cdkd deploy, or cdkd destroy to clean up';",
      "const a = 're-run cdkd destroy / cdkd state destroy to finish';",
      "const a = 'Use cdkd deploy, cdkd destroy';",
    ]) {
      expect(remedyLiteralsIn(src), src).toHaveLength(2);
    }
    const passed = [
      "// Re-run 'cdkd bootstrap' for this region.",
      " * run `cdkd drift --revert` in a doc comment",
      "const a = `Re-run '${cdkdRemedy('cdkd bootstrap')}' for this region.`;",
      "const a = pasteableCommand('cdkd rollback', [{ value: s, hole: 'stack' }]).command;",
      "watchCommandInterrupt({ command: 'cdkd destroy' });",
      "const a = 'the entry cdkd destroy keeps retrying';",
      // a whole-literal verb handed to a builder, and the noun "cdkd state"
      "withheldTargetClause(built, 'stack', 'cdkd destroy');",
      "const a = 'Nothing written: cdkd state and the stack are unchanged';",
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
