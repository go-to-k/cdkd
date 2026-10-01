/**
 * go-to-k/cdkd#4265: the residual sites of go-to-k/cdkd#3950's S1 rule (a line
 * that displays an untrusted value carries no pasteable command or flag)
 * after go-to-k/cdkd#4214. The final-snapshot refusals and the delete-skip
 * sentence are fixed in their BUILDERS, so every caller is covered, the
 * deploy engine's included; the name-holder diagnosis loses its apostrophes,
 * which paired with a JSON-quoted name on the `Collision diagnosis:` line.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import {
  ccRoutedFinalSnapshotError,
  unsupportedFinalSnapshotError,
} from '../../../src/provisioning/final-snapshot.js';
import { deleteSkippedMessage, UNSPECIFIED_SKIP_REASON } from '../../../src/deployment/delete-outcome.js';
import {
  replayFailedOperations,
  replayRollback,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { physicalIdShownBesideCommand } from '../../../src/utils/pasteable-command.js';
import { awsSdkError } from '../_aws-sdk-error.js';
import { reverseReplacementNewHoldsName } from '../../../src/deployment/replacement-name-holder.js';
import { withStackName } from '../../../src/provisioning/resource-name.js';
import type { ResourceState } from '../../../src/types/state.js';
import {
  PASTE_PAYLOADS,
  expectNoCommandBesideDisplay,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';

vi.mock('../../../src/deployment/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/deployment/retry.js')>();
  return { ...actual, withRetry: vi.fn((fn: () => Promise<unknown>) => fn()) };
});

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ secretsManager: { send: vi.fn() }, ssm: { send: vi.fn() } }),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const PAYLOADS = PASTE_PAYLOADS.map(({ value }) => value);

/** A described value: the block rule holds, and nothing in the text runs. */
function expectDescribedAndInert(text: string, value: string, dir: string): void {
  expect(text, value).not.toContain(value);
  expectNoCommandBesideDisplay(text, value);
  expect(spansThatRun(text, dir), value).toEqual([]);
}

describe('the final-snapshot refusals describe a non-plain id or type in the builder (go-to-k/cdkd#4265)', () => {
  const builders = [
    ['cc-routed', ccRoutedFinalSnapshotError],
    ['unsupported', unsupportedFinalSnapshotError],
  ] as const;

  it('a payload logical id or resource type is described beside the aws command and --skip-final-snapshot', () => {
    withPasteDir((dir) => {
      for (const [label, build] of builders) {
        for (const payload of PAYLOADS) {
          const byId = build(payload, 'AWS::RDS::DBInstance', '--skip-final-snapshot').message;
          expect(byId, `${label} id`).toContain(
            'a logical id that is not a plain identifier (AWS::RDS::DBInstance) has DeletionPolicy: Snapshot'
          );
          expect(byId).toContain('--skip-final-snapshot');
          expectDescribedAndInert(byId, payload, dir);
          const byType = build('Db', payload, '--skip-final-snapshot').message;
          expect(byType, `${label} type`).toContain(
            'Db (a resource type that is not a plain identifier) has DeletionPolicy: Snapshot'
          );
          expectDescribedAndInert(byType, payload, dir);
        }
      }
    });
  }, 120_000);

  it('CONTROL: a plain id and type print as before, and a hyphenated cdkd id stays named', () => {
    for (const [, build] of builders) {
      expect(build('Db', 'AWS::RDS::DBInstance', '--skip-final-snapshot').message).toMatch(
        /^Db \(AWS::RDS::DBInstance\) has DeletionPolicy: Snapshot/
      );
      expect(build('My-Db', 'Custom::My-Thing', '--skip-final-snapshot').message).toMatch(
        /^My-Db \(Custom::My-Thing\) has DeletionPolicy: Snapshot/
      );
    }
  });

  it('an already-described value is not described twice', () => {
    // The rollback executor used to pass described values; a description fed
    // back in must come out as itself, not as a description of a description.
    for (const [, build] of builders) {
      const message = build(
        'a logical id that is not a plain identifier',
        'a resource type that is not a plain identifier',
        '--skip-final-snapshot'
      ).message;
      expect(message).toMatch(
        /^a logical id that is not a plain identifier \(a resource type that is not a plain identifier\) has/
      );
    }
  });
});

describe('the delete-skip sentence shows only plain values (go-to-k/cdkd#4265)', () => {
  // The callers' own clauses: the flag-naming ones, and the deploy engine's
  // `'cdkd deploy'` suffix, all on the same line as the three values.
  const clauses = [
    'during the --replace delete-first fallback',
    'during --recreate-via-cc-api',
    'while deleting the partially-created resource (--revert-failed)',
  ];
  const suffix = ". Its cdkd state record was KEPT, so the next 'cdkd deploy' re-attempts the delete.";

  it('a payload logical id, physical id or reason is described beside every flag clause', () => {
    withPasteDir((dir) => {
      for (const payload of PAYLOADS) {
        for (const clause of clauses) {
          for (const [field, args] of [
            ['id', [payload, 'arn:aws:sqs:us-east-1:1:q', 'no properties in state — Delete handler not invoked']],
            ['physicalId', ['Q', payload, 'no properties in state — Delete handler not invoked']],
            ['reason', ['Q', 'arn:aws:sqs:us-east-1:1:q', payload]],
          ] as const) {
            const line = deleteSkippedMessage(args[0], args[1], args[2], clause) + suffix;
            expect(line, `${field} ${clause}`).toContain(
              field === 'id'
                ? 'cdkd did not confirm a logical id that is not a plain identifier ('
                : field === 'physicalId'
                  ? '(a physical id that is not a plain identifier) was deleted'
                  : 'so it may still exist: a reason that cannot be shown safely here'
            );
            expectDescribedAndInert(line, payload, dir);
          }
        }
      }
    });
  }, 240_000);

  it("CONTROL: cdkd's own reasons, a nested stack's reason and a plain ARN are shown", () => {
    for (const reason of [
      'no properties in state — Delete handler not invoked',
      'nested stack Parent~Child skipped 2 resource(s)',
      'nested stack Parent~Child skipped 2 operation(s) of its revert',
      'the current value of the secret names a user outside the group — the value may have rotated',
      UNSPECIFIED_SKIP_REASON,
    ]) {
      expect(deleteSkippedMessage('My-Q', 'arn:aws:sqs:us-east-1:1:q', reason, 'while x')).toBe(
        `cdkd did not confirm My-Q (arn:aws:sqs:us-east-1:1:q) was deleted while x, so it may still exist: ${reason}`
      );
    }
  });

  it("every exported skip reason of cdkd's own is shown, not described", async () => {
    // Derived from the source tree, so a new constant joins on its own; the
    // literal floor below fails if the scan stops finding them.
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = join(__dirname, '../../../src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.ts') && /export const [A-Z_]+_SKIP_REASON\b/.test(readFileSync(full, 'utf8')))
          files.push(full);
      }
    };
    walk(root);
    const reasons: Array<[string, string]> = [];
    for (const file of files) {
      const mod = (await import(file)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        if (name.endsWith('_SKIP_REASON') && typeof value === 'string') {
          reasons.push([`${relative(root, file)}:${name}`, value]);
        }
      }
    }
    expect(reasons.length).toBeGreaterThanOrEqual(23);
    for (const [where, reason] of reasons) {
      expect(deleteSkippedMessage('Q', 'p', reason, 'x'), where).toContain(`may still exist: ${reason}`);
    }
  });

  it('a value with a leading -, = or ~, or a leading ~ in the reason, is described', () => {
    // `x=~` and `a:~` are plain to `displayIdent`, but bash expands the `~`.
    for (const id of ['-phys', '=phys', '~phys', 'x=~', 'PATH=a:~']) {
      expect(deleteSkippedMessage('Q', id, 'r', 'x'), id).toContain(
        '(a physical id that is not a plain identifier)'
      );
    }
    expect(deleteSkippedMessage('Q', 'p', '~root owns it', 'x')).toContain(
      'a reason that cannot be shown safely here'
    );
  });

  it("a nested-stack skip reason built from a hostile child name leaves no clause that runs (security review of #4297)", () => {
    // What the nested-stack provider now builds for a state key
    // `Child. touch OWNED`: the name is described, so no `. ` inside the
    // reason starts a clause of the planter's words.
    const reason = 'nested stack a stack name that is not a plain identifier was interrupted';
    const line =
      deleteSkippedMessage('Child', 'arn:cdkd-local:us-east-1:1:nested-stack/P/C', reason, 'while removing it from the template') +
      ". Its cdkd state record was KEPT, so the next 'cdkd deploy' re-attempts the delete.";
    expect(line).toContain(`may still exist: ${reason}`);
    withPasteDir((dir) => expect(spansThatRun(line, dir)).toEqual([]));
  });

  it('the rollback --revert-failed delete-skip line describes a payload reason end to end', async () => {
    for (const payload of PAYLOADS) {
      const lines: string[] = [];
      const push = (m: unknown): void => {
        lines.push(String(m));
      };
      const logger = {
        debug: vi.fn(),
        info: vi.fn(push),
        warn: vi.fn(push),
        error: vi.fn(push),
        setLevel: vi.fn(),
        child: () => logger,
      } as unknown as RollbackExecutorContext['logger'];
      const del = vi.fn().mockResolvedValue({ outcome: 'skipped', reason: payload });
      const ctx: RollbackExecutorContext = {
        region: 'us-east-1',
        logger,
        providerRegistry: {
          getProviderFor: () => ({ provider: { delete: del } }),
        } as unknown as RollbackExecutorContext['providerRegistry'],
      };
      const failed: FailedOperation[] = [
        {
          logicalId: 'B',
          changeType: 'CREATE',
          resourceType: 'AWS::SQS::Queue',
          physicalId: 'phys-B',
          attemptedProperties: {},
        },
      ];
      const state: Record<string, ResourceState> = {
        B: {
          physicalId: 'phys-B',
          resourceType: 'AWS::SQS::Queue',
          properties: {},
          attributes: {},
          dependencies: [],
        },
      };
      await replayFailedOperations(failed, state, 'S', ctx);
      expect(del).toHaveBeenCalled();
      const line = lines.find((l) => l.includes('did not confirm'));
      expect(line, payload).toContain('(--revert-failed), so it may still exist: a reason that cannot be shown');
      withPasteDir((dir) => expectDescribedAndInert(line!, payload, dir));
    }
  }, 120_000);
});

describe('the name-holder diagnosis carries no apostrophe (go-to-k/cdkd#4265)', () => {
  const ask = (over: Partial<Parameters<typeof reverseReplacementNewHoldsName>[0]>) =>
    reverseReplacementNewHoldsName({
      oldResourceType: 'AWS::SQS::Queue',
      newResourceType: 'AWS::SQS::Queue',
      requested: { QueueName: 'q' },
      recorded: { QueueName: 'q' },
      observed: undefined,
      physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/q',
      ...over,
    });
  const diagnosisOf = (verdict: ReturnType<typeof ask>): string => {
    expect(verdict.holds).toBe(false);
    return verdict.holds ? '' : verdict.diagnosis;
  };

  it('the generated-name arm', () => {
    const d = diagnosisOf(
      ask({ requested: {}, generated: { QueueName: 'S-Q' }, recorded: { QueueName: 'other' }, physicalId: 'x' })
    );
    expect(d).toContain('the cdkd naming rule generates QueueName "S-Q"');
    expect(d).not.toContain("'");
  });

  it('the rewritten-name arm', () => {
    const d = withStackName('Stk', () =>
      diagnosisOf(
        ask({
          oldResourceType: 'AWS::IAM::Role',
          newResourceType: 'AWS::IAM::Role',
          requested: { RoleName: 'MyRole' },
          recorded: { RoleName: 'myrole' },
          logicalId: 'MyRole',
          physicalId: 'AROAEXAMPLE123',
        })
      )
    );
    expect(d).toContain('the provider of this type rewrites the names it sends');
    expect(d).not.toContain("'");
  });
});

describe('the delete-skip sentence on a command-free line shows the physical id (orchestrator review of #4297)', () => {
  it('commandFreeLine shows a composite or hostile id bounded by displayIdent, never described', () => {
    for (const id of ['Z123|www.example.com|A', 'x$(touch OWNED)', 'arn:aws:sqs:us-east-1:1:q']) {
      const line = deleteSkippedMessage('Q', id, 'r', 'while cleaning up the replaced resource', {
        commandFreeLine: true,
      });
      expect(line, id).not.toContain('not a plain identifier');
      expect(line, id).toContain(
        id === 'arn:aws:sqs:us-east-1:1:q' ? `(${id})` : `(${JSON.stringify(id)})`
      );
    }
    // Without the option the composite id is described, as beside a command.
    expect(deleteSkippedMessage('Q', 'Z123|www.example.com|A', 'r', 'x')).toContain(
      '(a physical id that is not a plain identifier)'
    );
  });
});

describe('one predicate decides whether a physical id is shown beside a command (orchestrator review of #4297)', () => {
  it('both callers follow physicalIdShownBesideCommand', () => {
    for (const id of ['arn:aws:sqs:us-east-1:1:q', 'x=~', 'PATH=a:~', '-x', '=x', '~x', '#x', 'a b', 'Z1|n|A']) {
      const shown = physicalIdShownBesideCommand(id);
      const line = deleteSkippedMessage('Q', id, 'r', 'x');
      expect(line, id).toContain(shown === undefined ? '(a physical id that is not a plain identifier)' : `(${shown})`);
    }
    // The mask arm, used by the rollback refusals.
    expect(physicalIdShownBesideCommand('a***b', { maskToken: '***' })).toBe('"a***b"');
    expect(physicalIdShownBesideCommand('a***b')).toBeUndefined();
    expect(physicalIdShownBesideCommand('~***', { maskToken: '***' })).toBeUndefined();
  });

  it('the rollback Retain refusal now refuses a medial =~ physical id too', async () => {
    const create = vi.fn().mockRejectedValue(awsSdkError('Queue already exists'));
    const events: Array<{ error?: { message?: string } }> = [];
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      setLevel: vi.fn(),
      child: () => logger,
    } as unknown as RollbackExecutorContext['logger'];
    const ctx: RollbackExecutorContext = {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProviderFor: () => ({ provider: { create, delete: vi.fn() } }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
      recordEvent: (e) => events.push(e),
    };
    const res = (over: Partial<ResourceState>): ResourceState => ({
      physicalId: 'p',
      resourceType: 'AWS::SQS::Queue',
      properties: {},
      attributes: {},
      dependencies: [],
      ...over,
    });
    await replayRollback(
      [
        {
          logicalId: 'B',
          changeType: 'UPDATE',
          resourceType: 'AWS::SQS::Queue',
          physicalId: 'x=~',
          previousState: res({ physicalId: 'phys-old', properties: { QueueName: 'q', a: 1 } }),
        },
      ],
      { B: res({ physicalId: 'x=~', properties: { QueueName: 'q', a: 2 }, updateReplacePolicy: 'Retain' }) },
      'S',
      ctx,
      { isInterrupted: () => false }
    );
    const message = events.map((e) => e.error?.message ?? '').find((m) => m.includes('Retain pins'));
    expect(message).toContain('held by the new one (a physical id that is not a plain identifier)');
  });
});

describe('the rollback executor marks its own refusals for the events replay (orchestrator review of #4297)', () => {
  const run = async (
    provider: Record<string, unknown>,
    previousState: ResourceState
  ): Promise<Array<{ error?: { message?: string; ownLines?: boolean } }>> => {
    const events: Array<{ error?: { message?: string; ownLines?: boolean } }> = [];
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      setLevel: vi.fn(),
      child: () => logger,
    } as unknown as RollbackExecutorContext['logger'];
    await replayRollback(
      [
        {
          logicalId: 'B',
          changeType: 'UPDATE',
          resourceType: 'AWS::SQS::Queue',
          physicalId: 'phys-new',
          previousState,
        },
      ],
      {
        B: {
          physicalId: 'phys-new',
          resourceType: 'AWS::SQS::Queue',
          properties: { a: 2 },
          attributes: {},
          dependencies: [],
        },
      },
      'S',
      {
        region: 'us-east-1',
        logger,
        providerRegistry: {
          getProviderFor: () => ({ provider }),
        } as unknown as RollbackExecutorContext['providerRegistry'],
        recordEvent: (e) => events.push(e),
      },
      { isInterrupted: () => false }
    );
    return events.filter((e) => e.error !== undefined);
  };

  it('an own refusal carries ownLines: true', async () => {
    // No old type recorded: the unroutable refusal, one of the three own ones.
    const failed = await run({ create: vi.fn(), delete: vi.fn() }, {
      physicalId: 'phys-old',
      resourceType: '',
      properties: { a: 1 },
      attributes: {},
      dependencies: [],
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error!.message).toContain('Cannot reverse the replacement of B');
    expect(failed[0]!.error!.ownLines).toBe(true);
  });

  it("a provider's error, newline and all, carries no marker", async () => {
    const update = vi
      .fn()
      .mockRejectedValue(new Error('handler said no\nTo orphan it: cdkd rollback --orphan Victim'));
    const failed = await run({ update }, {
      physicalId: 'phys-new',
      resourceType: 'AWS::SQS::Queue',
      properties: { a: 1 },
      attributes: {},
      dependencies: [],
    });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error!.message).toContain('handler said no');
    expect(failed[0]!.error!.ownLines).toBeUndefined();
  });
});

describe('every skipped reason a provider builds reaches the allow-list as cdkd prose (orchestrator review of #4297)', () => {
  it("each `outcome: 'skipped'` site uses an exported *_SKIP_REASON or the nested-stack template", async () => {
    // A LITERAL scan: a producer that builds the outcome through a variable,
    // or passes a delegate's result straight through, is not seen. The
    // allow-list fails closed on CHARACTERS only, so no shell meta reaches the
    // line either way; but a state fragment made of allowed characters alone
    // (`Child. touch OWNED`) is shown, and a selection starting at its `. `
    // runs its words. So a new producer passes any state-sourced fragment
    // through `plainOrDescribed` (see `PLAIN_SKIP_REASON`'s doc in
    // `delete-outcome.ts`), and this scan is the net for the literal ones.
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const root = join(__dirname, '../../../src');
    const sites: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.ts')) continue;
        const lines = readFileSync(full, 'utf8').split('\n');
        lines.forEach((line, i) => {
          // Comments, and the type declaration itself, are not sites.
          if (/^\s*(\*|\/\/|\/\*)/.test(line) || !/outcome:\s*["'`]skipped["'`]/.test(line)) return;
          if (/readonly outcome:/.test(line)) return;
          // The reason sits on the same line or one of the next three.
          const window = lines.slice(i, i + 4).join(' ');
          const reason = /reason:\s*(`[^`]*`|[^,}]+)/.exec(window)?.[1]?.trim() ?? '';
          sites.push(`${relative(root, full)}:${i + 1} ${reason}`);
        });
      }
    };
    walk(root);
    const offenders = sites.filter(
      (site) =>
        !/ [A-Z_]+_SKIP_REASON$/.test(site) &&
        !/ `nested stack \$\{plainOrDescribed\(childStackName, 'stack name'\)\} \$\{causes\.join\(' and '\)\}`$/.test(site)
    );
    expect(offenders).toEqual([]);
    expect(sites.length).toBeGreaterThanOrEqual(23);
  });
});
