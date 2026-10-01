/**
 * go-to-k/cdkd#4214: a rollback message line that names a `cdkd` command or a
 * `--flag` displays no untrusted value (go-to-k/cdkd#3950's S1 rule, judged
 * per line by `expectNoCommandBesideDisplay`). go-to-k/cdkd#4209 applied it to
 * the logical id of the three reverse-replacement refusals; this file drives
 * the other journal and state values on those lines — the resource type, the
 * unroutable reason's types, both physical ids, the name-holder diagnosis and
 * the provider's collision text — and the sibling messages in the same module
 * whose line names a command.
 *
 * Each value is planted as every paste payload family, and each message is
 * pasted to bash (and zsh where installed) at line, sentence, clause and
 * block granularity. A value the message DESCRIBES leaves nothing that runs
 * (`spansThatRun` empty); a value it still displays in a JSON boundary on a
 * line of its own is held to `expectOnlyDisplayResidual`.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import {
  refuseUnprovenReplaySecret,
  replayFailedOperations,
  replayRollback,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import type { ResourceState } from '../../../src/types/state.js';
import { awsSdkError } from '../_aws-sdk-error.js';
import {
  PASTE_PAYLOADS,
  expectNoCommandBesideDisplay,
  expectOnlyDisplayResidual,
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

type DeploymentEvent = Parameters<NonNullable<RollbackExecutorContext['recordEvent']>>[0];

const PAYLOADS = PASTE_PAYLOADS.map(({ value }) => value);
const QUEUE = 'AWS::SQS::Queue';

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: QUEUE,
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

function makeCtx(provider: Record<string, unknown>): {
  ctx: RollbackExecutorContext;
  lines: string[];
  events: DeploymentEvent[];
} {
  const lines: string[] = [];
  const events: DeploymentEvent[] = [];
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
  return {
    lines,
    events,
    ctx: {
      region: 'us-east-1',
      logger,
      providerRegistry: {
        getProviderFor: () => ({ provider }),
      } as unknown as RollbackExecutorContext['providerRegistry'],
      recordEvent: (e) => events.push(e),
    },
  };
}

/** The recorded refusal text, and the terminal failure line, of one run. */
function refusalOf(events: DeploymentEvent[], lines: string[], needle: string): string[] {
  const message = events.map((e) => e.error?.message ?? '').find((m) => m.includes(needle));
  const line = lines.find((l) => l.includes(needle));
  expect(message, `no recorded refusal holds ${needle}`).toBeDefined();
  expect(line, `no log line holds ${needle}`).toBeDefined();
  return [message!, line!];
}

/** A described value: the block rule holds, and nothing in the message runs. */
function expectDescribedAndInert(messages: readonly string[], value: string, dir: string): void {
  for (const message of messages) {
    expect(message, value).not.toContain(value);
    expectNoCommandBesideDisplay(message, value);
    expect(spansThatRun(message, dir), value).toEqual([]);
  }
}

describe('the reverse-replacement refusals describe every untrusted value beside a command (go-to-k/cdkd#4214)', () => {
  it('UNROUTABLE: a payload resource type is described on the fix-forward line', async () => {
    for (const payload of PAYLOADS) {
      const { ctx, lines, events } = makeCtx({ create: vi.fn(), delete: vi.fn() });
      await replayRollback(
        [
          {
            logicalId: 'B',
            changeType: 'UPDATE',
            resourceType: payload,
            physicalId: 'phys-new',
            previousState: { ...res({ physicalId: 'phys-old', properties: { a: 1 } }), resourceType: '' },
          },
        ],
        { B: res({ physicalId: 'phys-new' }) },
        'S',
        ctx,
        { isInterrupted: () => false }
      );
      const messages = refusalOf(events, lines, 'Cannot reverse the replacement of B');
      expect(messages[0]).toContain(
        'Cannot reverse the replacement of B (a resource type that is not a plain identifier): '
      );
      expect(messages[0]).toContain('fix forward with cdkd deploy');
      withPasteDir((dir) => expectDescribedAndInert(messages, payload, dir));
    }
  }, 120_000);

  it("UNROUTABLE: the divergent-type reason describes both of the journal's types", async () => {
    for (const payload of PAYLOADS) {
      const { ctx, lines, events } = makeCtx({ create: vi.fn(), delete: vi.fn() });
      await replayRollback(
        [
          {
            logicalId: 'B',
            changeType: 'UPDATE',
            resourceType: QUEUE,
            physicalId: 'phys-new',
            previousResourceType: payload,
            previousState: res({ resourceType: `${payload}-2`, physicalId: 'phys-old', properties: { a: 1 } }),
          },
        ],
        { B: res({ physicalId: 'phys-new' }) },
        'S',
        ctx,
        { isInterrupted: () => false }
      );
      const messages = refusalOf(events, lines, 'two different types');
      expect(messages[0]).toContain(
        '(previousResourceType a resource type that is not a plain identifier, ' +
          'previousState.resourceType a resource type that is not a plain identifier)'
      );
      withPasteDir((dir) => expectDescribedAndInert(messages, payload, dir));
    }
  }, 120_000);

  it('UNROUTABLE: the nested-stack Type-change reason describes the old type', async () => {
    for (const payload of PAYLOADS) {
      const { ctx, lines, events } = makeCtx({ create: vi.fn(), delete: vi.fn() });
      await replayRollback(
        [
          {
            logicalId: 'B',
            changeType: 'UPDATE',
            resourceType: 'AWS::CloudFormation::Stack',
            physicalId: 'phys-new',
            previousResourceType: payload,
            previousState: res({ resourceType: payload, physicalId: 'phys-old', properties: { a: 1 } }),
          },
        ],
        { B: res({ resourceType: 'AWS::CloudFormation::Stack', physicalId: 'phys-new' }) },
        'S',
        ctx,
        { isInterrupted: () => false }
      );
      const messages = refusalOf(events, lines, 'it is a Type change between');
      expect(messages[0]).toContain(
        'it is a Type change between a resource type that is not a plain identifier and ' +
          'AWS::CloudFormation::Stack'
      );
      withPasteDir((dir) => expectDescribedAndInert(messages, payload, dir));
    }
  }, 120_000);

  it('the Retain collision refusal describes both physical ids and points at where they are', async () => {
    for (const payload of PAYLOADS) {
      const create = vi.fn().mockRejectedValue(awsSdkError('Queue already exists'));
      const { ctx, lines, events } = makeCtx({ create, delete: vi.fn() });
      await replayRollback(
        [
          {
            logicalId: 'B',
            changeType: 'UPDATE',
            resourceType: QUEUE,
            physicalId: payload,
            previousState: res({ physicalId: `${payload}-old`, properties: { QueueName: 'q', a: 1 } }),
          },
        ],
        {
          B: res({ physicalId: payload, properties: { QueueName: 'q', a: 2 }, updateReplacePolicy: 'Retain' }),
        },
        'S',
        ctx,
        { isInterrupted: () => false }
      );
      const messages = refusalOf(events, lines, 'UpdateReplacePolicy: Retain pins');
      expect(messages[0]).toContain(
        'the re-create of the old resource (a physical id that is not a plain identifier) collided ' +
          'with the name still held by the new one (a physical id that is not a plain identifier)'
      );
      expect(messages[0]).toContain(
        'A physical id is left out of the prose above: it is not a plain identifier — read it ' +
          'from the rollback journal or from the state record of the stack.'
      );
      expect(messages[0]).toMatch(/\nTo orphan it: cdkd rollback --orphan B$/);
      withPasteDir((dir) => expectDescribedAndInert(messages, payload, dir));
    }
  }, 120_000);

  it('CONTROL: plain physical ids stay shown, with no pointer', async () => {
    const create = vi.fn().mockRejectedValue(awsSdkError('Queue already exists'));
    const { ctx, events } = makeCtx({ create, delete: vi.fn() });
    const arn = 'arn:aws:sqs:us-east-1:123456789012:q-new';
    const url = 'https://sqs.us-east-1.amazonaws.com/123456789012/q-old';
    await replayRollback(
      [
        {
          logicalId: 'B',
          changeType: 'UPDATE',
          resourceType: QUEUE,
          physicalId: arn,
          previousState: res({ physicalId: url, properties: { QueueName: 'q', a: 1 } }),
        },
      ],
      { B: res({ physicalId: arn, properties: { QueueName: 'q', a: 2 }, updateReplacePolicy: 'Retain' }) },
      'S',
      ctx,
      { isInterrupted: () => false }
    );
    const message = events.map((e) => e.error?.message ?? '').find((m) => m.includes('Retain pins'));
    expect(message).toContain(`the re-create of the old resource (${url}) collided`);
    expect(message).toContain(`held by the new one (${arn}), and`);
    expect(message).not.toContain('A physical id is left out');
  });

  it("the name-holder refusal describes the old id, and puts the diagnosis and AWS's text on lines of their own", async () => {
    // Every remedy arm: the top-level one, a nested child's own rollback and a
    // nested child revert. Each clause sits on the line above the two
    // displays, so an apostrophe in any of them would pair with one inside a
    // JSON-quoted payload when the block is pasted.
    const arms = ['top', 'child-own', 'child-revert'] as const;
    for (const [payload, arm] of PAYLOADS.flatMap((p) => arms.map((a) => [p, a] as const))) {
      // The new queue holds a DIFFERENT name, so the holder is not proven and
      // the refusal quotes the new resource's (payload) id in its diagnosis.
      // The AWS text echoes the payload too.
      const create = vi.fn().mockRejectedValue(awsSdkError(`Queue ${payload} already exists`));
      const { ctx, lines, events } = makeCtx({ create, delete: vi.fn() });
      if (arm === 'child-revert') ctx.nestedChildRevert = true;
      if (arm === 'child-own') ctx.nestedChildStack = 'Top~Child';
      await replayRollback(
        [
          {
            logicalId: 'B',
            changeType: 'UPDATE',
            resourceType: QUEUE,
            physicalId: payload,
            previousState: res({ physicalId: `${payload}-old`, properties: { QueueName: 'q', a: 1 } }),
          },
        ],
        { B: res({ physicalId: payload, properties: { QueueName: 'q2', a: 2 } }) },
        'S',
        ctx,
        { isInterrupted: () => false }
      );
      const [message, line] = refusalOf(events, lines, 'another resource holds the colliding name');
      const rows = message.split('\n');
      expect(rows[0]).toContain(
        'the re-create of the old resource (a physical id that is not a plain identifier) collided ' +
          '(why is on the Collision diagnosis line below)'
      );
      expect(rows[0]).not.toContain(payload);
      // The premise: both lines of their own DO display the payload, in a
      // JSON boundary, and carry no command.
      const diagnosis = rows.find((r) => r.startsWith('Collision diagnosis: '));
      const collision = rows.find((r) => r.startsWith('Underlying collision: '));
      expect(diagnosis).toContain(JSON.stringify(payload).slice(1, -1));
      expect(collision).toContain(JSON.stringify(`Queue ${payload} already exists`));
      expect(rows.at(-1)).toBe(
        arm === 'child-revert'
          ? collision
          : arm === 'child-own'
            ? "To orphan it: cdkd rollback 'Top~Child' --stack-region us-east-1 --orphan B"
            : 'To orphan it: cdkd rollback --orphan B'
      );
      withPasteDir((dir) => {
        for (const m of [message, line]) expectOnlyDisplayResidual(m, dir, payload);
      });
    }
  }, 600_000);
});

describe('sibling messages in the rollback executor keep untrusted values off a command line (go-to-k/cdkd#4214)', () => {
  it("the per-op failure line's head describes a payload logical id", async () => {
    for (const payload of PAYLOADS) {
      const { ctx, lines } = makeCtx({ create: vi.fn(), delete: vi.fn() });
      await replayRollback(
        [
          {
            logicalId: payload,
            changeType: 'UPDATE',
            resourceType: QUEUE,
            physicalId: 'phys-new',
            previousState: { ...res({ physicalId: 'phys-old', properties: { a: 1 } }), resourceType: '' },
          },
        ],
        { [payload]: res({ physicalId: 'phys-new' }) },
        'S',
        ctx,
        { isInterrupted: () => false }
      );
      const line = lines.find((l) => l.includes('Rollback failed for'));
      expect(line).toContain('Rollback failed for a logical id that is not a plain identifier (UPDATE): ');
      withPasteDir((dir) => expectDescribedAndInert([line!], payload, dir));
    }
  }, 120_000);

  it("the name-idempotent adopt warning describes the live resource's physical id", async () => {
    for (const payload of PAYLOADS) {
      const create = vi.fn().mockResolvedValue({ physicalId: payload, attributes: {} });
      const { ctx, lines } = makeCtx({ create, delete: vi.fn() });
      const type = 'AWS::Some::NamedType';
      await replayRollback(
        [
          {
            logicalId: 'B',
            changeType: 'UPDATE',
            resourceType: type,
            physicalId: payload,
            previousState: res({ resourceType: type, physicalId: 'phys-old', properties: { a: 1 } }),
          },
        ],
        { B: res({ resourceType: type, physicalId: payload, properties: { a: 2 } }) },
        'S',
        ctx
      );
      const warn = lines.find((l) => l.includes('the re-create returned the LIVE new'));
      expect(warn).toContain('LIVE new resource (a physical id that is not a plain identifier)');
      expect(warn).toContain("run 'cdkd deploy' to reconcile");
      expect(warn).toContain('A physical id is left out of the prose above');
      withPasteDir((dir) => expectDescribedAndInert([warn!], payload, dir));
    }
  }, 120_000);

  it('the failed Type-change skip describes both types beside `cdkd drift` / `cdkd deploy`', async () => {
    for (const payload of PAYLOADS) {
      const { ctx, lines } = makeCtx({ update: vi.fn() });
      const failed: FailedOperation[] = [
        {
          logicalId: 'B',
          changeType: 'UPDATE',
          resourceType: QUEUE,
          physicalId: 'phys',
          previousState: res({ resourceType: payload, physicalId: 'phys', properties: { a: 1 } }),
          attemptedProperties: { a: 2 },
        },
      ];
      await replayFailedOperations(failed, { B: res({ properties: { a: 2 } }) }, 'S', ctx);
      const warn = lines.find((l) => l.includes('cannot revert failed UPDATE of B in place'));
      expect(warn).toContain(
        'Type change (a resource type that is not a plain identifier -> AWS::SQS::Queue)'
      );
      withPasteDir((dir) => expectDescribedAndInert([warn!], payload, dir));
    }
  }, 120_000);

  it('the unrestorable-baseline refusals describe a payload logical id beside their `cdkd` remedy', async () => {
    for (const payload of PAYLOADS) {
      // The SKIP warn: no `properties` bag at all.
      const { ctx: skipCtx, lines: skipLines } = makeCtx({ update: vi.fn() });
      const { properties: _dropped, ...bagless } = res({ physicalId: 'phys' });
      await replayRollback(
        [
          {
            logicalId: payload,
            changeType: 'UPDATE',
            resourceType: QUEUE,
            physicalId: 'phys',
            previousState: bagless as ResourceState,
          },
        ],
        { [payload]: res({ physicalId: 'phys', properties: { a: 1 } }) },
        'S',
        skipCtx
      );
      const warn = skipLines.find((l) => l.includes('has no `properties` bag'));
      expect(warn).toContain('Cannot restore a logical id that is not a plain identifier');
      expect(warn).toContain('`cdkd deploy`');
      // The THROW: a bag that is not one.
      const { ctx: throwCtx, lines: throwLines } = makeCtx({ update: vi.fn() });
      await replayRollback(
        [
          {
            logicalId: payload,
            changeType: 'UPDATE',
            resourceType: QUEUE,
            physicalId: 'phys',
            previousState: { ...res({ physicalId: 'phys' }), properties: 'abc' } as unknown as ResourceState,
          },
        ],
        { [payload]: res({ physicalId: 'phys', properties: { a: 1 } }) },
        'S',
        throwCtx
      );
      const thrown = throwLines.find((l) => l.includes('not a property bag'));
      expect(thrown).toContain('Cannot roll a logical id that is not a plain identifier back');
      withPasteDir((dir) => expectDescribedAndInert([warn!, thrown!], payload, dir));
    }
  }, 120_000);

  it('the redacted-baseline refusal describes a payload logical id (it printed it raw)', async () => {
    for (const payload of PAYLOADS) {
      const { ctx, lines } = makeCtx({ update: vi.fn() });
      const type = 'AWS::SSM::Parameter';
      await replayRollback(
        [
          {
            logicalId: payload,
            changeType: 'UPDATE',
            resourceType: type,
            physicalId: 'phys',
            previousState: res({ resourceType: type, properties: { Name: '/app/t', Value: SECRET_MASK } }),
          },
        ],
        { [payload]: res({ resourceType: type, properties: { Name: '/app/t', Value: 'other' } }) },
        'S',
        ctx
      );
      const line = lines.find((l) => l.includes('holds the redaction mask'));
      expect(line).toContain('Cannot roll a logical id that is not a plain identifier back');
      expect(line).toContain("'cdkd deploy'");
      withPasteDir((dir) => expectDescribedAndInert([line!], payload, dir));
    }
  }, 120_000);

  it('the unproven-region secret refusal describes a payload logical id, property path and secret name', () => {
    const execCtx = {
      region: 'us-east-1',
      producerRegionsIncomplete: true,
    } as unknown as RollbackExecutorContext;
    withPasteDir((dir) => {
      for (const payload of PAYLOADS) {
        for (const [leafName, path, id] of [
          ['prod/db', 'Props.Secret', payload],
          ['prod/db', payload, 'Idp'],
          [payload, 'Props.Secret', 'Idp'],
        ] as const) {
          let message = '';
          try {
            refuseUnprovenReplaySecret(
              `{{resolve:secretsmanager:${leafName}:SecretString:password}}`,
              path,
              id,
              execCtx
            );
          } catch (error) {
            message = (error as Error).message;
          }
          if (leafName === payload && message === '') {
            // A name the reference grammar does not parse is never refused
            // here, so it cannot reach the message at all.
            continue;
          }
          expect(message, `${leafName} / ${path} / ${id}`).toContain('cannot re-resolve the secret reference');
          expect(message).toContain("re-run 'cdkd rollback'");
          expectDescribedAndInert([message], payload, dir);
        }
      }
      // CONTROL: plain values keep their spelling.
      let plain = '';
      try {
        refuseUnprovenReplaySecret(
          '{{resolve:secretsmanager:prod/db:SecretString:password}}',
          'Props.Secret',
          'Idp',
          execCtx
        );
      } catch (error) {
        plain = (error as Error).message;
      }
      expect(plain).toContain(
        "Rollback of Idp property 'Props.Secret' cannot re-resolve the secret reference 'prod/db'"
      );
      expect(plain).toContain("another region than 'us-east-1'");
    });
  }, 120_000);

  it('the region-ambiguous secret refusal describes a payload logical id, property path and secret name (review of #4270)', async () => {
    const IDP = 'AWS::Cognito::UserPoolIdentityProvider';
    const cases = PAYLOADS.flatMap((payload) => [
      { payload, id: payload, key: 'client_secret', secret: 'prod/db' },
      { payload, id: 'Idp', key: payload, secret: 'prod/db' },
      { payload, id: 'Idp', key: 'client_secret', secret: payload },
    ]);
    let reached = 0;
    for (const { payload, id, key, secret } of cases) {
      const update = vi.fn();
      const { ctx, lines } = makeCtx({ update });
      ctx.importedProducerRegions = ['eu-west-1'];
      const expr = `{{resolve:secretsmanager:${secret}:SecretString:password}}`;
      await replayRollback(
        [
          {
            logicalId: id,
            changeType: 'UPDATE',
            resourceType: IDP,
            physicalId: 'phys',
            previousState: res({
              resourceType: IDP,
              properties: { ProviderDetails: { client_id: 'pub', [key]: expr } },
            }),
          },
        ],
        {
          [id]: res({
            resourceType: IDP,
            properties: { ProviderDetails: { client_id: 'pub-2', [key]: expr } },
          }),
        },
        'S',
        ctx
      );
      const line = lines.find((l) => l.includes('cannot re-resolve the secret reference'));
      // A secret name the reference grammar does not parse is never refused
      // here, so it cannot reach the message.
      if (line === undefined && secret === payload) continue;
      expect(update, `${id} / ${key} / ${secret}`).not.toHaveBeenCalled();
      expect(line, `${id} / ${key} / ${secret}`).toContain('across a region boundary');
      expect(line).toContain("re-run 'cdkd rollback'");
      reached++;
      withPasteDir((dir) => expectDescribedAndInert([line!], payload, dir));
    }
    // The logical id and property path arms reach it for every family.
    expect(reached).toBeGreaterThanOrEqual(PAYLOADS.length * 2);

    // The region arms: a payload producer region on record and a payload
    // consumer region (review of #4270). `~root` and `a[0]` are plain to the
    // wider property-path rule, so they pin the region's own gate.
    for (const payload of [...PAYLOADS, '~root', 'a[0]']) {
      for (const arm of ['producer', 'consumer'] as const) {
        const update = vi.fn();
        const { ctx, lines } = makeCtx({ update });
        ctx.importedProducerRegions = [arm === 'producer' ? payload : 'eu-west-1'];
        if (arm === 'consumer') ctx.region = payload;
        const expr = '{{resolve:secretsmanager:prod/db:SecretString:password}}';
        await replayRollback(
          [
            {
              logicalId: 'Idp',
              changeType: 'UPDATE',
              resourceType: IDP,
              physicalId: 'phys',
              previousState: res({
                resourceType: IDP,
                properties: { ProviderDetails: { client_id: 'pub', client_secret: expr } },
              }),
            },
          ],
          {
            Idp: res({
              resourceType: IDP,
              properties: { ProviderDetails: { client_id: 'pub-2', client_secret: expr } },
            }),
          },
          'S',
          ctx
        );
        const line = lines.find((l) => l.includes('cannot re-resolve the secret reference'));
        expect(line, `${arm} ${payload}`).toContain('a region that is not a plain identifier');
        withPasteDir((dir) => expectDescribedAndInert([line!], payload, dir));
      }
    }
  }, 240_000);

  it('CONTROL: a property path with array indexes stays shown in the secret refusal', () => {
    const execCtx = {
      region: 'us-east-1',
      producerRegionsIncomplete: true,
    } as unknown as RollbackExecutorContext;
    let message = '';
    try {
      refuseUnprovenReplaySecret(
        '{{resolve:secretsmanager:prod/db:SecretString:password}}',
        'ContainerDefinitions[0].Secrets[1].ValueFrom',
        'Task',
        execCtx
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("property 'ContainerDefinitions[0].Secrets[1].ValueFrom'");

    // ...and a path of indexes past the identifier cap is described.
    let long = '';
    try {
      refuseUnprovenReplaySecret(
        '{{resolve:secretsmanager:prod/db:SecretString:password}}',
        `a${'[0]'.repeat(100)}`,
        'Task',
        execCtx
      );
    } catch (error) {
      long = (error as Error).message;
    }
    expect(long).toContain('property a property path that is not a plain identifier');
  });

  it('the cc-routed final-snapshot refusal describes a payload logical id', async () => {
    const type = 'AWS::RDS::DBInstance';
    for (const payload of PAYLOADS) {
      const del = vi.fn();
      const { ctx, lines } = makeCtx({ delete: del });
      await replayRollback(
        [{ logicalId: payload, changeType: 'CREATE', resourceType: type, physicalId: 'phys' }],
        { [payload]: res({ resourceType: type, deletionPolicy: 'Snapshot', provisionedBy: 'cc-api' }) },
        'S',
        ctx
      );
      expect(del).not.toHaveBeenCalled();
      const line = lines.find((l) => l.includes('managed via the Cloud Control API route'));
      expect(line).toContain(
        'a logical id that is not a plain identifier (AWS::RDS::DBInstance) has DeletionPolicy: Snapshot'
      );
      expect(line).toContain('--skip-final-snapshot');
      withPasteDir((dir) => expectDescribedAndInert([line!], payload, dir));
    }
  }, 120_000);

  it('CONTROL: a masked physical id past the cap is described, not cut', async () => {
    const create = vi.fn().mockRejectedValue(awsSdkError('Queue already exists'));
    const { ctx, events } = makeCtx({ create, delete: vi.fn() });
    // Each part is under the role-ARN cap, the whole is over it.
    const longMasked = `${'a'.repeat(400)}${SECRET_MASK}${'b'.repeat(400)}`;
    await replayRollback(
      [
        {
          logicalId: 'B',
          changeType: 'UPDATE',
          resourceType: QUEUE,
          physicalId: longMasked,
          previousState: res({ physicalId: `x${SECRET_MASK}`, properties: { QueueName: 'q', a: 1 } }),
        },
      ],
      { B: res({ physicalId: longMasked, properties: { QueueName: 'q', a: 2 }, updateReplacePolicy: 'Retain' }) },
      'S',
      ctx,
      { isInterrupted: () => false }
    );
    const message = events.map((e) => e.error?.message ?? '').find((m) => m.includes('Retain pins'));
    expect(message).toContain(`the re-create of the old resource ("x${SECRET_MASK}") collided`);
    expect(message).toContain('held by the new one (a physical id that is not a plain identifier)');
    expect(message).not.toContain('[cut:');
  });

  it("the failed-op `Rollback failed for failed-op` head describes a payload logical id (orchestrator review of #4270)", async () => {
    for (const payload of PAYLOADS) {
      const update = vi.fn().mockRejectedValue(new Error('cdkd deploy would fix this'));
      const { ctx, lines } = makeCtx({ update });
      const failed: FailedOperation[] = [
        {
          logicalId: payload,
          changeType: 'UPDATE',
          resourceType: QUEUE,
          physicalId: 'phys',
          previousState: res({ physicalId: 'phys', properties: { a: 1 } }),
          attemptedProperties: { a: 2 },
        },
      ];
      await replayFailedOperations(failed, { [payload]: res({ properties: { a: 2 } }) }, 'S', ctx);
      const line = lines.find((l) => l.includes('Rollback failed for failed-op'));
      expect(line, payload).toContain(
        'Rollback failed for failed-op a logical id that is not a plain identifier (UPDATE): '
      );
      withPasteDir((dir) => expectDescribedAndInert([line!], payload, dir));
    }
  }, 120_000);

  it("the name-idempotent adopt warning describes a payload logical id and type (orchestrator review of #4270)", async () => {
    for (const payload of PAYLOADS) {
      for (const arm of ['id', 'type'] as const) {
        const create = vi.fn().mockResolvedValue({ physicalId: 'phys-new', attributes: {} });
        const { ctx, lines } = makeCtx({ create, delete: vi.fn() });
        const id = arm === 'id' ? payload : 'B';
        const type = arm === 'type' ? payload : 'AWS::Some::NamedType';
        await replayRollback(
          [
            {
              logicalId: id,
              changeType: 'UPDATE',
              resourceType: type,
              physicalId: 'phys-new',
              previousState: res({ resourceType: type, physicalId: 'phys-old', properties: { a: 1 } }),
            },
          ],
          { [id]: res({ resourceType: type, physicalId: 'phys-new', properties: { a: 2 } }) },
          'S',
          ctx
        );
        const warn = lines.find((l) => l.includes('the re-create returned the LIVE new'));
        expect(warn, `${arm} ${payload}`).toContain(
          arm === 'id'
            ? 'a logical id that is not a plain identifier (AWS::Some::NamedType): '
            : 'B (a resource type that is not a plain identifier): '
        );
        withPasteDir((dir) => expectDescribedAndInert([warn!], payload, dir));
      }
    }
  }, 120_000);

  it('the failed Type-change skip describes a payload logical id (orchestrator review of #4270)', async () => {
    for (const payload of PAYLOADS) {
      const { ctx, lines } = makeCtx({ update: vi.fn() });
      const failed: FailedOperation[] = [
        {
          logicalId: payload,
          changeType: 'UPDATE',
          resourceType: QUEUE,
          physicalId: 'phys',
          previousState: res({ resourceType: 'AWS::SNS::Topic', physicalId: 'phys', properties: { a: 1 } }),
          attemptedProperties: { a: 2 },
        },
      ];
      await replayFailedOperations(failed, { [payload]: res({ properties: { a: 2 } }) }, 'S', ctx);
      const warn = lines.find((l) => l.includes('in place — it was a Type change'));
      expect(warn, payload).toContain(
        'cannot revert failed UPDATE of a logical id that is not a plain identifier in place'
      );
      withPasteDir((dir) => expectDescribedAndInert([warn!], payload, dir));
    }
  }, 120_000);

  it('the unproven-region secret refusal describes a payload consumer region (orchestrator review of #4270)', () => {
    withPasteDir((dir) => {
      for (const payload of [...PAYLOADS, '~root', 'a[0]']) {
        let message = '';
        try {
          refuseUnprovenReplaySecret(
            '{{resolve:secretsmanager:prod/db:SecretString:password}}',
            'Props.Secret',
            'Idp',
            { region: payload, producerRegionsIncomplete: true } as unknown as RollbackExecutorContext
          );
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message, payload).toContain('another region than a region that is not a plain identifier.');
        expect(message, payload).not.toMatch(/\w's /);
        expectDescribedAndInert([message], payload, dir);
      }
    });
  }, 120_000);

  it('CONTROL: a physical id with a leading -, = or ~ is described, not shown', async () => {
    for (const lead of ['-', '=', '~']) {
      const create = vi.fn().mockRejectedValue(awsSdkError('Queue already exists'));
      const { ctx, events } = makeCtx({ create, delete: vi.fn() });
      const id = `${lead}phys-new`;
      await replayRollback(
        [
          {
            logicalId: 'B',
            changeType: 'UPDATE',
            resourceType: QUEUE,
            physicalId: id,
            previousState: res({ physicalId: 'phys-old', properties: { QueueName: 'q', a: 1 } }),
          },
        ],
        { B: res({ physicalId: id, properties: { QueueName: 'q', a: 2 }, updateReplacePolicy: 'Retain' }) },
        'S',
        ctx,
        { isInterrupted: () => false }
      );
      const message = events.map((e) => e.error?.message ?? '').find((m) => m.includes('Retain pins'));
      expect(message, lead).toContain('held by the new one (a physical id that is not a plain identifier)');
      expect(message, lead).not.toContain(id);
    }
  });

  it('the failed-op head describes a payload change type (code review of #4270)', async () => {
    for (const payload of PAYLOADS) {
      // An unknown change type routes to the UPDATE arm; the provider throws.
      const update = vi.fn().mockRejectedValue(new Error('boom'));
      const { ctx, lines } = makeCtx({ update });
      const failed = [
        {
          logicalId: 'B',
          changeType: payload,
          resourceType: QUEUE,
          physicalId: 'phys',
          previousState: res({ physicalId: 'phys', properties: { a: 1 } }),
          attemptedProperties: { a: 2 },
        },
      ] as unknown as FailedOperation[];
      await replayFailedOperations(failed, { B: res({ properties: { a: 2 } }) }, 'S', ctx);
      const line = lines.find((l) => l.includes('Rollback failed for failed-op'));
      expect(line, payload).toContain(
        'Rollback failed for failed-op B (a change type that is not a plain identifier): '
      );
      withPasteDir((dir) => expectDescribedAndInert([line!], payload, dir));
    }
  }, 120_000);

  it("the failed Type-change skip describes the op's own payload type (code review of #4270)", async () => {
    for (const payload of PAYLOADS) {
      const { ctx, lines } = makeCtx({ update: vi.fn() });
      const failed: FailedOperation[] = [
        {
          logicalId: 'B',
          changeType: 'UPDATE',
          resourceType: payload,
          physicalId: 'phys',
          previousState: res({ resourceType: QUEUE, physicalId: 'phys', properties: { a: 1 } }),
          attemptedProperties: { a: 2 },
        },
      ];
      await replayFailedOperations(
        failed,
        { B: res({ resourceType: payload, properties: { a: 2 } }) },
        'S',
        ctx
      );
      const warn = lines.find((l) => l.includes('in place — it was a Type change'));
      expect(warn, payload).toContain(
        'Type change (AWS::SQS::Queue -> a resource type that is not a plain identifier)'
      );
      withPasteDir((dir) => expectDescribedAndInert([warn!], payload, dir));
    }
  }, 120_000);

  it("UNROUTABLE: the nested-stack Type-change reason describes the op's own payload type (code review of #4270)", async () => {
    for (const payload of PAYLOADS) {
      const { ctx, lines, events } = makeCtx({ create: vi.fn(), delete: vi.fn() });
      const stack = 'AWS::CloudFormation::Stack';
      await replayRollback(
        [
          {
            logicalId: 'B',
            changeType: 'UPDATE',
            resourceType: payload,
            physicalId: 'phys-new',
            previousResourceType: stack,
            previousState: res({ resourceType: stack, physicalId: 'phys-old', properties: { a: 1 } }),
          },
        ],
        { B: res({ resourceType: payload, physicalId: 'phys-new' }) },
        'S',
        ctx,
        { isInterrupted: () => false }
      );
      const messages = refusalOf(events, lines, 'it is a Type change between');
      expect(messages[0]).toContain(
        'it is a Type change between AWS::CloudFormation::Stack and a resource type that is not a plain identifier'
      );
      withPasteDir((dir) => expectDescribedAndInert(messages, payload, dir));
    }
  }, 120_000);

  it('the name-holder refusal describes a payload resource type on its head (code review of #4270)', async () => {
    for (const payload of PAYLOADS) {
      const create = vi.fn().mockRejectedValue(awsSdkError('Resource already exists'));
      const { ctx, lines, events } = makeCtx({ create, delete: vi.fn() });
      await replayRollback(
        [
          {
            logicalId: 'B',
            changeType: 'UPDATE',
            resourceType: payload,
            physicalId: 'phys-new',
            previousState: res({ resourceType: payload, physicalId: 'phys-old', properties: { a: 1 } }),
          },
        ],
        { B: res({ resourceType: payload, physicalId: 'phys-new', properties: { a: 2 } }) },
        'S',
        ctx,
        { isInterrupted: () => false }
      );
      const [message, line] = refusalOf(events, lines, 'Collision diagnosis:');
      expect(message.split('\n')[0]).toContain(
        'Cannot reverse the replacement of B (a resource type that is not a plain identifier): '
      );
      expect(message.split('\n')[0]).not.toContain(payload);
      withPasteDir((dir) => {
        for (const m of [message, line]) expectOnlyDisplayResidual(m, dir, payload);
      });
    }
  }, 240_000);

  it('the Retain refusal head cannot carry a payload type: an unproven holder refuses first (code review of #4270)', async () => {
    // The Retain arm runs only once `reverseReplacementNewHoldsName` proves
    // the new resource holds the name, which needs a type it knows. A type
    // that is not plain is never one, so the name-holder refusal (whose head
    // is pinned above) fires instead, even with Retain on the new copy.
    for (const payload of PAYLOADS) {
      const create = vi.fn().mockRejectedValue(awsSdkError('Resource already exists'));
      const { ctx, events } = makeCtx({ create, delete: vi.fn() });
      await replayRollback(
        [
          {
            logicalId: 'B',
            changeType: 'UPDATE',
            resourceType: payload,
            physicalId: 'phys-new',
            previousState: res({ resourceType: payload, physicalId: 'phys-old', properties: { QueueName: 'q' } }),
          },
        ],
        {
          B: res({
            resourceType: payload,
            physicalId: 'phys-new',
            properties: { QueueName: 'q', a: 2 },
            updateReplacePolicy: 'Retain',
          }),
        },
        'S',
        ctx,
        { isInterrupted: () => false }
      );
      const messages = events.map((e) => e.error?.message ?? '').filter((m) => m !== '');
      expect(messages.some((m) => m.includes('Collision diagnosis:')), payload).toBe(true);
      expect(messages.some((m) => m.includes('UpdateReplacePolicy: Retain pins')), payload).toBe(false);
    }
  });

  it('the unsupported final-snapshot refusal describes a payload logical id and type', async () => {
    for (const payload of PAYLOADS) {
      const del = vi.fn();
      const { ctx, lines } = makeCtx({ delete: del });
      await replayRollback(
        [{ logicalId: payload, changeType: 'CREATE', resourceType: payload, physicalId: 'phys' }],
        { [payload]: res({ resourceType: payload, deletionPolicy: 'Snapshot' }) },
        'S',
        ctx
      );
      expect(del).not.toHaveBeenCalled();
      const line = lines.find((l) => l.includes('has DeletionPolicy: Snapshot, but'));
      expect(line).toContain(
        'a logical id that is not a plain identifier (a resource type that is not a plain identifier) ' +
          'has DeletionPolicy: Snapshot'
      );
      expect(line).toContain('--skip-final-snapshot');
      withPasteDir((dir) => expectDescribedAndInert([line!], payload, dir));
    }
  }, 120_000);

  it('the re-create failure and the Retain survivor warning name no command beside their values', async () => {
    for (const payload of PAYLOADS) {
      // Collision, delete-new-first, then the re-create fails: the resource
      // is absent, and the line carries the provider's text and the new id.
      const create = vi
        .fn()
        .mockRejectedValueOnce(awsSdkError('Queue already exists'))
        .mockRejectedValue(new Error(`Rate exceeded for ${payload}`));
      const { ctx, lines } = makeCtx({ create, delete: vi.fn().mockResolvedValue(undefined) });
      await replayRollback(
        [
          {
            logicalId: 'B',
            changeType: 'UPDATE',
            resourceType: QUEUE,
            physicalId: payload,
            previousState: res({ physicalId: 'phys-old', properties: { QueueName: 'q', a: 1 } }),
          },
        ],
        { B: res({ physicalId: payload, properties: { QueueName: 'q', a: 2 } }) },
        'S',
        ctx,
        { isInterrupted: () => false }
      );
      const failed = lines.find((l) => l.includes('was already deleted'));
      expect(failed).toContain('fix forward by re-deploying the stack.');
      expectNoCommandBesideDisplay(failed!, payload);

      // The readopt arm's Retain survivor warning.
      const { ctx: rCtx, lines: rLines } = makeCtx({ delete: vi.fn() });
      await replayRollback(
        [
          {
            logicalId: payload,
            changeType: 'UPDATE',
            resourceType: QUEUE,
            physicalId: payload,
            previousState: res({ physicalId: 'phys-old', properties: { a: 1 } }),
            oldResourceRetained: true,
          },
        ],
        { [payload]: res({ physicalId: payload, properties: { a: 2 }, updateReplacePolicy: 'Retain' }) },
        'S',
        rCtx
      );
      const warn = rLines.find((l) => l.includes('has UpdateReplacePolicy: Retain'));
      expect(warn).toContain('and destroying the stack will not remove it');
      expectNoCommandBesideDisplay(warn!, payload);
    }
  });
});
