/**
 * Issue go-to-k/cdkd#3909: the pasteable commands the malformed-record
 * refusals print carry the caller's `--profile` / resolved `--state-bucket` /
 * non-default `--state-prefix`, through the shared `pasteableCommand` gate with
 * `plainIdent` — so a pasted `cdkd state list --json` or `cdkd state show`
 * reads the bucket the refusing run read, and an account value that is not a
 * plain identifier is a described hole rather than an echoed one.
 *
 * The CLI wiring is pinned per call site in
 * `tests/unit/cli/destroy-runner-malformed-account-flags.test.ts`; this file
 * pins what the builders do with the context they are handed.
 */
import { describe, expect, it } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import { PASTE_PAYLOADS, spansThatRun, withPasteDir } from '../utils/paste-harness.js';
import { CONTENDED_CASE_TIMEOUT_MS } from '../../contended-case-timeout.js';
import {
  divergentRecordRegionRefusalMessage,
  malformedDestroyOrphansRefusalMessage,
  malformedDestroyOutputsRefusalMessage,
  malformedDestroyResourceEntriesRefusalMessage,
  malformedDestroyResourcesRefusalMessage,
  malformedImportUnrepairedEntriesRefusalMessage,
  malformedOrphansRefusalMessage,
  malformedOutputsRefusalMessage,
  malformedResourceEntriesRefusalMessage,
  malformedStateRefusalMessage,
} from '../../../src/state/malformed-resources-bag.js';
import type { LockRecoveryContext } from '../../../src/state/lock-contention-message.js';

const RECOVERY: LockRecoveryContext = {
  profile: 'prod',
  stateBucket: 'my-bucket',
  statePrefix: 'team-a',
};
const FLAGS = '--profile prod --state-bucket my-bucket --state-prefix team-a';

/** The two per-line DESTROY refusals, which share both arms' shape. */
const PER_LINE: Array<[string, (s: string, r: string, rec?: LockRecoveryContext) => string]> = [
  ['resources', malformedDestroyResourcesRefusalMessage],
  ['orphans', malformedDestroyOrphansRefusalMessage],
];

const divergent = (s: string, r: string, rec?: LockRecoveryContext): string =>
  divergentRecordRegionRefusalMessage(s, r, 'eu-west-1', 2, rec);

/** Every builder whose inspect command the context now qualifies, by name. */
const INSPECT_BUILDERS: Array<[string, (s: string, r: string, rec?: LockRecoveryContext) => string]> =
  [
    ['malformedStateRefusalMessage', malformedStateRefusalMessage],
    ['malformedOutputsRefusalMessage', malformedOutputsRefusalMessage],
    ['malformedOrphansRefusalMessage', malformedOrphansRefusalMessage],
    ['malformedDestroyOutputsRefusalMessage', malformedDestroyOutputsRefusalMessage],
    [
      'malformedResourceEntriesRefusalMessage',
      (s, r, rec) => malformedResourceEntriesRefusalMessage(s, r, ['Bad'], rec),
    ],
    [
      'malformedDestroyResourceEntriesRefusalMessage',
      (s, r, rec) => malformedDestroyResourceEntriesRefusalMessage(s, r, ['Bad'], rec),
    ],
    [
      'malformedImportUnrepairedEntriesRefusalMessage',
      (s, r, rec) => malformedImportUnrepairedEntriesRefusalMessage(s, r, ['Bad'], rec),
    ],
  ];

describe('the DESTROY withhold arms carry the account on the listing and the inspect line (go-to-k/cdkd#3909)', () => {
  for (const [label, build] of PER_LINE) {
    it(`${label}: the withhold arm prints the listing as its own line, then the inspect line`, () => {
      const text = build('S ', 'us-east-1', RECOVERY);
      const lines = text.split('\n');
      expect(lines.slice(1)).toEqual([
        `Find the exact name: cdkd state list --json ${FLAGS}`,
        `Inspect the record: cdkd state show '<stack>' --stack-region '<region>' --json ${FLAGS}`,
      ]);
      // The prose points at that LINE, and names no listing command itself —
      // a command in prose quotes cannot carry a value safely.
      expect(lines[0]).toContain("with the 'Find the exact name' command below");
      expect(lines[0]).not.toContain("'cdkd state list --json'");
    });

    it(`${label}: the exact arm qualifies the inspect command AND the drop template`, () => {
      const text = build('S', 'us-east-1', RECOVERY);
      expect(text.split('\n').slice(1)).toEqual([
        `Inspect the record: cdkd state show S --stack-region us-east-1 --json ${FLAGS}`,
        `Drop the record: cdkd state orphan '<stack>' --stack-region '<region>' ${FLAGS}`,
      ]);
      // The key-confirming listing is named in prose; it says to carry the flags.
      expect(text).toContain(
        "Confirm the key with 'cdkd state list --long' run with the same account flags as the " +
          'command lines below'
      );
    });

    it(`${label}: CONTROL — with no account flag the text is byte-identical to the unqualified one`, () => {
      for (const name of ['S', 'S '])
        for (const rec of [{}, { statePrefix: 'cdkd' }, { profile: '', stateBucket: '' }]) {
          expect(build(name, 'us-east-1', rec), JSON.stringify(rec)).toBe(
            build(name, 'us-east-1')
          );
        }
      // ...and that unqualified text still names the listing in prose.
      expect(build('S ', 'us-east-1')).toContain("'cdkd state list --json', which writes each");
    });
  }

  it('divergent region: the withhold arm moves both commands onto lines of their own', () => {
    const text = divergent('S ', 'us-east-1', RECOVERY);
    expect(text.split('\n').slice(1)).toEqual([
      `Find the exact name: cdkd state list --json ${FLAGS}`,
      `Inspect it with: cdkd state show '<stack>' --stack-region '<region>' --json ${FLAGS}`,
    ]);
    // The prose points at that LINE and names no flagless listing itself.
    expect(text.split('\n')[0]).toContain("with the 'Find the exact name' command below");
    expect(text.split('\n')[0]).not.toContain("'cdkd state list --json'");
    // Unqualified, it keeps its one-line shape.
    expect(divergent('S ', 'us-east-1')).not.toContain('\n');
    expect(divergent('S ', 'us-east-1', {})).toBe(divergent('S ', 'us-east-1'));
  });

  it('divergent region: the exact arm still ends on the drop template, now qualified', () => {
    const text = divergent('S', 'us-east-1', RECOVERY);
    expect(text.endsWith(`: cdkd state orphan '<stack>' --stack-region '<region>' ${FLAGS}`)).toBe(
      true
    );
  });

  it('an EMPTY prefix selects a different key space, so it rides as a literal', () => {
    const text = malformedDestroyResourcesRefusalMessage('S ', 'us-east-1', {
      stateBucket: 'b',
      statePrefix: '',
    });
    expect(text).toContain(`Find the exact name: cdkd state list --json --state-bucket b --state-prefix ''`);
  });
});

describe('a refused account value is a described hole, never echoed (go-to-k/cdkd#3909)', () => {
  const REFUSED: Array<[string, LockRecoveryContext, string, string]> = [
    // [label, context, the hole it prints, the reason clause]
    ['a non-plain profile', { profile: 'my profile' }, `--profile '<profile>'`, 'is not a plain identifier'],
    // Exact but not plain: the `plainIdent` arm, which the altered row
    // below cannot reach (the gate reports `altered` first).
    ['a non-plain bucket', { stateBucket: 'bkt zq' }, `--state-bucket '<bucket>'`, 'is not a plain identifier'],
    ['a too-long profile', { profile: 'p'.repeat(1153) }, `--profile '<profile>'`, 'is too long to print'],
    ['an altered bucket', { stateBucket: 'b\u001bx' }, `--state-bucket '<bucket>'`, 'does not render exactly'],
    ['an option-shaped profile', { profile: '--all' }, `--profile '<profile>'`, "begins with a '-'"],
    ['a non-plain prefix', { statePrefix: 'pfx zq' }, `--state-prefix '<prefix>'`, 'is not a plain identifier'],
  ];
  const ALL = [
    ...PER_LINE.flatMap(([l, b]) => [
      [`${l} withhold`, (rec: LockRecoveryContext) => b('S ', 'us-east-1', rec)],
      [`${l} exact`, (rec: LockRecoveryContext) => b('S', 'us-east-1', rec)],
    ]),
    ['divergent withhold', (rec: LockRecoveryContext) => divergent('S ', 'us-east-1', rec)],
    ['divergent exact', (rec: LockRecoveryContext) => divergent('S', 'us-east-1', rec)],
    ...INSPECT_BUILDERS.flatMap(([l, b]) => [
      [`${l} named`, (rec: LockRecoveryContext) => b('S', 'us-east-1', rec)],
      [`${l} no identity`, (rec: LockRecoveryContext) => b('', 'us-east-1', rec)],
    ]),
  ] as Array<[string, (rec: LockRecoveryContext) => string]>;

  for (const [label, rec, hole, reason] of REFUSED) {
    for (const [site, build] of ALL) {
      it(`${site}: ${label}`, () => {
        const text = build(rec);
        const raw = rec.profile ?? rec.stateBucket ?? rec.statePrefix!;
        expect(text).not.toContain(raw);
        expect(text).toContain(hole);
        const flag = hole.slice(0, hole.indexOf(' '));
        expect(text).toContain(`The '${flag}' value this run was given ${reason}`);
        // The sentence explains the hole BEFORE the command carrying it.
        expect(text.indexOf(`The '${flag}' value`)).toBeLessThan(text.indexOf(hole));
      });
    }
  }

  it('two refused values: each is named with its own reason, and the holes are plural', () => {
    for (const [site, build] of ALL) {
      const text = build({ profile: 'my profile', stateBucket: 'b\u001bx' });
      expect(text, site).toContain(
        "The '--profile' value this run was given is not a plain identifier"
      );
      expect(text, site).toMatch(
        /, and the '--state-bucket' value this run was given does not render exactly/
      );
      expect(text, site).toContain('quoted holes in their place');
      expect(text, site).toContain(`--profile '<profile>' --state-bucket '<bucket>'`);
    }
  });

  it('a withheld name beginning with - keeps its no-fill rule, then explains the account hole', () => {
    const text = malformedStateRefusalMessage('-x y', 'us-east-1', { profile: 'my profile' });
    const noFill = text.indexOf('Do not fill the stack hole');
    const account = text.indexOf("The '--profile' value this run was given");
    expect(noFill).toBeGreaterThan(-1);
    expect(account).toBeGreaterThan(noFill);
    expect(text.endsWith(`--json --profile '<profile>'`)).toBe(true);
  });

  it('CONTROL: a plain account names no reason', () => {
    for (const [site, build] of ALL) {
      expect(build(RECOVERY), site).not.toContain('value this run was given');
    }
  });

  it('no span of any qualified message RUNS when pasted, whatever the account values hold', () => {
    // Every account slot carries the payload at once, and the inspect family is
    // driven through ONE builder: they share `inspectGate` / `inspectClause`,
    // so more builders buy bash spawns, not coverage.
    const sites = ALL.filter(
      ([site]) => !site.startsWith('malformed') || site.startsWith('malformedStateRefusalMessage')
    );
    withPasteDir((dir) => {
      let messages = 0;
      for (const { value } of PASTE_PAYLOADS) {
        const rec = { profile: value, stateBucket: value, statePrefix: value };
        for (const [site, build] of sites) {
          messages++;
          expect(spansThatRun(build(rec), dir), `${site} ${JSON.stringify(rec)}`).toEqual([]);
        }
      }
      expect(messages).toBe(PASTE_PAYLOADS.length * 8);
    });
  }, CONTENDED_CASE_TIMEOUT_MS);

  it('every command line pastes as the literal argv it spells — holes included', () => {
    const lines = [
      ...PER_LINE.flatMap(([, b]) => [b('S ', 'us-east-1', { profile: 'my profile', stateBucket: 'b' }), b('S', 'us-east-1', RECOVERY)]),
      divergent('S ', 'us-east-1', RECOVERY),
    ]
      .flatMap((m) => m.split('\n').slice(1))
      .map((l) => l.slice(l.indexOf(': ') + 2));
    expect(lines.length).toBeGreaterThanOrEqual(6);
    for (const line of lines) {
      const r = spawnSync('bash', ['-c', `cdkd() { printf '%s\\n' "$@"; }; ${line}`], {
        encoding: 'utf8',
      });
      expect(r.status, line).toBe(0);
      // Quote-aware split of the printed line, holes as literal arguments.
      const words = [...line.matchAll(/'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2]!);
      expect(r.stdout.split('\n').slice(0, -1), line).toEqual(words.slice(1));
    }
  });
});

describe('the inspect-command family carries the account too (go-to-k/cdkd#3909)', () => {
  for (const [label, build] of INSPECT_BUILDERS) {
    it(`${label}: the command it ends on carries the flags`, () => {
      expect(build('S', 'us-east-1', RECOVERY).endsWith(
        `cdkd state show S --stack-region us-east-1 --json ${FLAGS}`
      )).toBe(true);
      // No identity: the template is qualified too — the identity is the hole,
      // not the account.
      expect(build('', 'us-east-1', RECOVERY).endsWith(
        `cdkd state show '<stack>' --stack-region '<region>' --json ${FLAGS}`
      )).toBe(true);
    });

    it(`${label}: a withheld name's listing pointer says to carry the same flags`, () => {
      const text = build('a b', 'us-east-1', RECOVERY);
      expect(text).toContain(
        "Take the values from 'cdkd state list --json' run with the same account flags as the " +
          'command at the end of this line, which writes each name raw'
      );
      // CONTROL: unqualified, the pointer is the bare listing.
      expect(build('a b', 'us-east-1')).toContain(
        "Take the values from 'cdkd state list --json', which writes each name raw"
      );
      expect(build('a b', 'us-east-1', {})).toBe(build('a b', 'us-east-1'));
    });
  }

  it('the legacy Object key names a slash prefix, and holes one with a non-plain segment', () => {
    const key = (statePrefix: string): string =>
      /^Object key: (.*)$/m.exec(malformedStateRefusalMessage('S', undefined, { statePrefix }))![1]!;
    expect(key('org/cdkd')).toBe('org/cdkd/S/state.json');
    // A segment the command lines hole is not echoed on this line either.
    expect(key(`p';x`)).toBe(`'<prefix>/S/state.json'`);
    expect(key('a b/c')).toBe(`'<prefix>/S/state.json'`);
    const holed = malformedStateRefusalMessage('S', undefined, { statePrefix: `p';x` });
    expect(holed).not.toContain(`p';x`);
    // ...and the sentence says why the key shows a hole, without the value.
    expect(holed).toContain(
      "one of its '/'-separated parts is not a plain identifier, so the key shows the hole"
    );
    // An EMPTY prefix is a real key space and keeps its own spelling.
    expect(key('')).toBe('/S/state.json');
  });

  it('the region-less legacy arm is untouched: it names the bucket on its own line, as before', () => {
    const text = malformedStateRefusalMessage('S', undefined, RECOVERY);
    expect(text).not.toContain('Inspect it with:');
    expect(text).not.toContain('--json');
    expect(text).toMatch(/^State bucket: my-bucket$/m);
  });
});
