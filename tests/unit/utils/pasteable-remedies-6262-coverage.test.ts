import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

import { buildProgram } from '../../../src/cli/program.js';
import { setPasteableRunFlags } from '../../../src/utils/pasteable-run-context.js';
import { parseBootstrapMarker } from '../../../src/assets/asset-storage/marker.js';
import {
  deployRepairCommand,
  diffCheckCommand,
  importRepairCommand,
} from '../../../src/cli/commands/export/composite-physical-id.js';
import { icebergTableInputRefusalMessage } from '../../../src/provisioning/providers/glue/shared.js';
import {
  refuseAmbiguousCreateAdopt,
  refuseExplicitNameHeld,
} from '../../../src/provisioning/providers/s3-bucket/adopt.js';
import { unroutableReplacementError } from '../../../src/deployment/rollback-executor/plan/classify.js';
import { warnIfPreV10BaselineGap } from '../../../src/cli/commands/drift/compare.js';
import { waitForApplied as neptuneWait } from '../../../src/provisioning/providers/neptune/waits.js';
import { waitForApplied as docdbWait } from '../../../src/provisioning/providers/docdb/wait.js';
import { warnIfUnfinished } from '../../../src/provisioning/providers/firehose/encryption.js';
import { recordRetainedForReadoption } from '../../../src/deployment/retained-readoption.js';
import { printStackShow } from '../../../src/cli/commands/state/show.js';
import { printStackResources } from '../../../src/cli/commands/state/resources.js';
import { refreshObservedForStack } from '../../../src/cli/commands/state/refresh-observed-stack.js';
import { runDriftForStack } from '../../../src/cli/commands/drift/detect.js';
import { applyTableTagsDiff } from '../../../src/provisioning/providers/s3-tables/tags.js';
import { verifyBucketExists } from '../../../src/state/s3-state-backend/state-record.js';
import { deleteByRecordedIdentity } from '../../../src/provisioning/providers/scheduler-schedule/delete.js';
import { confirmRecordedSchedule } from '../../../src/provisioning/providers/scheduler-schedule/update.js';
import { updateService } from '../../../src/provisioning/providers/ecs/service-update.js';
import { getSubnetAttribute } from '../../../src/provisioning/providers/ec2/subnet-attributes.js';
import { readUnsettled as dynamoReadUnsettled } from '../../../src/provisioning/providers/dynamodb-globaltable/read.js';
import { refuseUnprovenDriftSecret } from '../../../src/cli/commands/drift/secret-resolution.js';
import { recordedRuleIdIdentifier } from '../../../src/cli/commands/export/sg-ingress-rule-id.js';
import { unwrittenCreateOnlyRefusal } from '../../../src/deployment/deploy-engine/update/refusal-text.js';
import { settleUnsettledPrevious } from '../../../src/deployment/unsettled-convergence.js';
import { nestedChildWorkItem } from '../../../src/cli/commands/scrub/nested.js';
import { updateFileSystem } from '../../../src/provisioning/providers/efs/file-system.js';
import { diffAttributeBag } from '../../../src/provisioning/providers/elbv2/attributes.js';
import { wrapNotThisRepositoryError } from '../../../src/provisioning/providers/codecommit-repository/update.js';

/**
 * go-to-k/cdkd#6262, coverage lane: the remaining `cdkd ...` remedies each
 * carry the run's typed `--aws-emulator` and print unchanged without it. One
 * case per source file whose printed remedy no other test pins exactly.
 */
const EMU = 'https://127.0.0.1:4599';
const WITH = `--aws-emulator=${EMU}`;

beforeEach(() => {
  buildProgram();
  setPasteableRunFlags({});
});
afterEach(() => {
  setPasteableRunFlags({});
  vi.restoreAllMocks();
});

/** Run `render` with no flag, then with the emulator typed. */
function bothWays(render: () => string): { plain: string; emulated: string } {
  setPasteableRunFlags({});
  const plain = render();
  setPasteableRunFlags({ awsEmulator: EMU });
  const emulated = render();
  setPasteableRunFlags({});
  return { plain, emulated };
}

/** As {@link bothWays} for a renderer that awaits. */
async function bothWaysAsync(
  render: () => Promise<string>
): Promise<{ plain: string; emulated: string }> {
  setPasteableRunFlags({});
  const plain = await render();
  setPasteableRunFlags({ awsEmulator: EMU });
  const emulated = await render();
  setPasteableRunFlags({});
  return { plain, emulated };
}

/** The message a function that throws reports. */
function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('did not throw');
}

/** Everything a logger-taking function warned, joined. */
async function warned(
  run: (logger: { warn: (m: string) => void; debug: () => void; info: () => void }) => unknown
): Promise<string> {
  const lines: string[] = [];
  await run({ warn: (m: string) => lines.push(m), debug: () => {}, info: () => {} });
  return lines.join('\n');
}

function noopLogger() {
  return { warn() {}, info() {}, debug() {}, error() {}, setLevel() {} };
}

describe('bootstrap marker', () => {
  it.each([
    ['not valid JSON', () => parseBootstrapMarker('{', 'k')],
    ['missing fields', () => parseBootstrapMarker('{}', 'k')],
    [
      'invalid names',
      () =>
        parseBootstrapMarker(
          JSON.stringify({ assetBucket: 'X', containerRepo: 'Y', assetSupportVersion: 1 }),
          'k'
        ),
    ],
  ])('re-run bootstrap carries the flag (%s)', (_name, run) => {
    const { plain, emulated } = bothWays(() => thrown(run));
    expect(plain).toContain("Re-run 'cdkd bootstrap' for this region to rewrite it.");
    expect(emulated).toContain(`Re-run 'cdkd bootstrap ${WITH}' for this region to rewrite it.`);
  });
});

describe('export repair commands', () => {
  it('deployRepairCommand and diffCheckCommand carry the flag', () => {
    const deploy = bothWays(() => deployRepairCommand('S'));
    expect(deploy.plain).toBe('cdkd deploy S');
    expect(deploy.emulated).toBe(`cdkd deploy S ${WITH}`);
    const diff = bothWays(() => diffCheckCommand('S'));
    expect(diff.plain).toBe('cdkd diff S');
    expect(diff.emulated).toBe(`cdkd diff S ${WITH}`);
  });

  it('importRepairCommand keeps the --resource pair whole and appends the flag after --force', () => {
    const { plain, emulated } = bothWays(() => importRepairCommand('L'));
    expect(plain).toBe("cdkd import '<stack>' --resource L='<physicalId>' --force");
    expect(emulated).toBe(
      "cdkd import '<stack>' --resource L='<physicalId>' --force --aws-emulator=https://127.0.0.1:4599"
    );
    expect(bothWays(() => importRepairCommand('A=B')).plain).toBe(
      "cdkd import '<stack>' --resource '<logicalId>'='<physicalId>' --force"
    );
  });
});

describe('glue iceberg refusal', () => {
  it('names the deploy fix-forward with the flag', () => {
    const { plain, emulated } = bothWays(() =>
      icebergTableInputRefusalMessage('L', 'k', 'create-replay')
    );
    expect(plain).toContain("fix it forward with 'cdkd deploy' using the working shape below.");
    expect(emulated).toContain(
      `fix it forward with 'cdkd deploy ${WITH}' using the working shape below.`
    );
  });
});

describe('s3 bucket adoption refusals', () => {
  const self = { shown: (v: unknown) => String(v), shownMask: (s: string) => s } as never;

  it('refuseExplicitNameHeld names import with the flag', () => {
    const { plain, emulated } = bothWays(() =>
      thrown(() => refuseExplicitNameHeld.call(self, 'L', 'AWS::S3::Bucket', 'bk', { listed: true }))
    );
    expect(plain).toContain('adopt it with `cdkd import`, and re-run');
    expect(emulated).toContain(`adopt it with \`cdkd import ${WITH}\`, and re-run`);
  });

  it('refuseAmbiguousCreateAdopt names import with the flag', () => {
    const { plain, emulated } = bothWays(() =>
      thrown(() =>
        refuseAmbiguousCreateAdopt.call(
          self,
          'L',
          'AWS::S3::Bucket',
          'bk',
          'us-east-1',
          { preflight: 'region' },
          true
        )
      )
    );
    expect(plain).toContain('adopt it with `cdkd import` and re-run');
    expect(emulated).toContain(`adopt it with \`cdkd import ${WITH}\` and re-run`);
  });
});

describe('codecommit not-this-repository refusal', () => {
  const self = {} as never;
  const render = (which: 'recorded-name' | 'desired-name') => () =>
    wrapNotThisRepositoryError.call(self, 'L', 'AWS::CodeCommit::Repository', 'p', which).message;

  it('carries the flag on the re-adopt and orphan commands', () => {
    const recorded = bothWays(render('recorded-name'));
    expect(recorded.plain).toContain('re-adopt it under its new name with cdkd import (--resource');
    expect(recorded.emulated).toContain(
      `re-adopt it under its new name with cdkd import ${WITH} (--resource`
    );
    expect(recorded.plain).toContain("cdkd orphan '<constructPath>'");
    expect(recorded.emulated).toContain(`cdkd orphan '<constructPath>' ${WITH}`);

    const desired = bothWays(render('desired-name'));
    expect(desired.plain).toContain("cdkd orphan '<constructPath>'");
    expect(desired.emulated).toContain(`cdkd orphan '<constructPath>' ${WITH}`);
  });
});

describe('rollback plan classify', () => {
  it('unroutableReplacementError carries the flag on deploy and the orphan line', () => {
    const { plain, emulated } = bothWays(
      () =>
        unroutableReplacementError({ logicalId: 'L', resourceType: 'AWS::X::Y' } as never, 'why', {
          region: 'us-east-1',
        } as never).message
    );
    expect(plain).toContain('fix forward with cdkd deploy, or leave');
    expect(emulated).toContain(`fix forward with cdkd deploy ${WITH}, or leave`);
    expect(plain).toContain('To orphan it: cdkd rollback --orphan L');
    expect(emulated).toContain(`To orphan it: cdkd rollback ${WITH} --orphan L`);
  });
});

describe('drift compare', () => {
  it('warnIfPreV10BaselineGap re-run import carries the flag', async () => {
    const state = {
      version: 9,
      stackName: 'S',
      region: 'us-east-1',
      resources: {
        N: { physicalId: 'p', resourceType: 'AWS::SQS::Queue', properties: {} },
      },
      outputs: {},
      lastModified: 0,
    };
    const outcomes = [{ kind: 'clean', logicalId: 'N', resourceType: 'AWS::SQS::Queue' }];
    const { plain, emulated } = await bothWaysAsync(() =>
      warned((logger) => warnIfPreV10BaselineGap(state as never, outcomes as never, logger as never))
    );
    expect(plain).toContain("Re-run 'cdkd import' for this stack to put the record right.");
    expect(emulated).toContain(
      `Re-run 'cdkd import ${WITH}' for this stack to put the record right.`
    );
  });
});

describe('provider settle warnings', () => {
  it('neptune waitForApplied points at drift --accept with the flag', async () => {
    const { plain, emulated } = await bothWaysAsync(() =>
      warned((logger) =>
        neptuneWait.call(
          { logger, pollUntilSettled: async () => false } as never,
          'L',
          'x',
          async () => true
        )
      )
    );
    expect(plain).toContain('Once it applies, run cdkd drift --accept.');
    expect(emulated).toContain(`Once it applies, run cdkd drift --accept ${WITH}.`);
  });

  it('docdb waitForApplied points at drift --accept with the flag', async () => {
    const { plain, emulated } = await bothWaysAsync(() =>
      warned((logger) =>
        docdbWait.call({ logger } as never, 'L', new Map([['k', () => false]]), async () => 1, 0)
      )
    );
    expect(plain).toContain('Once it applies, run cdkd drift --accept.');
    expect(emulated).toContain(`Once it applies, run cdkd drift --accept ${WITH}.`);
  });

  it('firehose warnIfUnfinished names drift / --revert / --accept with the flag', async () => {
    const run = (markUnsettled: (() => void) | undefined) => () =>
      warned(async (logger) => {
        await warnIfUnfinished
          .call(
            { logger } as never,
            'L',
            'StartDeliveryStreamEncryption',
            markUnsettled,
            async () => {
              throw new Error('x');
            }
          )
          .catch(() => undefined);
      });
    const unmarked = await bothWaysAsync(run(undefined));
    expect(unmarked.plain).toContain(
      "Run 'cdkd drift' to compare, then 'cdkd drift --revert' to apply the recorded setting or 'cdkd drift --accept' to record"
    );
    expect(unmarked.emulated).toContain(
      `Run 'cdkd drift ${WITH}' to compare, then 'cdkd drift --revert ${WITH}' to apply the recorded setting or 'cdkd drift --accept ${WITH}' to record`
    );
    const marked = await bothWaysAsync(run(() => {}));
    expect(marked.plain).toContain("run 'cdkd drift --accept' once");
    expect(marked.emulated).toContain(`run 'cdkd drift --accept ${WITH}' once`);
  });
});

describe('retained re-adoption', () => {
  it('a failed record write names import with the flag', async () => {
    const backend = {
      loadRetainedRecord: async () => null,
      saveRetainedResources: async () => {
        throw new Error('boom');
      },
      ensureRetainedTombstone: async () => undefined,
    };
    const { plain, emulated } = await bothWaysAsync(() =>
      warned((logger) =>
        recordRetainedForReadoption(
          backend as never,
          'S',
          'us-east-1',
          [{ logicalId: 'L' }] as never,
          logger as never
        )
      )
    );
    expect(plain).toContain("adopt a kept one with 'cdkd import'.");
    expect(emulated).toContain(`adopt a kept one with 'cdkd import ${WITH}'.`);
  });
});

describe('state commands: no state found', () => {
  const stateBackend = {
    listStacks: async () => [{ stackName: 'S', region: 'us-east-1' }],
    getState: async () => null,
  } as never;
  const noState = {
    bucket: 'b',
    prefix: 'cdkd',
    stateBackend,
    lockManager: { getLockInfo: async () => null },
  } as never;
  const options = { json: false, showNested: false, statePrefix: 'cdkd', verbose: false } as never;
  const message = (run: () => Promise<unknown>) => async () =>
    run().then(
      () => 'did not throw',
      (e: Error) => e.message
    );

  it.each([
    ['state show', () => printStackShow('S', options, noState)],
    ['state resources', () => printStackResources('S', options, noState)],
    [
      'state refresh-observed',
      () =>
        refreshObservedForStack(
          'S',
          'us-east-1',
          stateBackend,
          {} as never,
          {} as never,
          { dryRun: true, logger: noopLogger() as never }
        ),
    ],
    [
      'drift',
      () =>
        runDriftForStack(
          'S',
          'us-east-1',
          stateBackend,
          {} as never,
          {} as never,
          (async () => undefined) as never,
          'refuse',
          (() => undefined) as never,
          {} as never
        ),
    ],
  ])('%s points at state list with the flag', async (_name, run) => {
    const { plain, emulated } = await bothWaysAsync(message(run));
    expect(plain).toContain("Run 'cdkd state list' to see available stacks.");
    expect(emulated).toContain(`Run 'cdkd state list ${WITH}' to see available stacks.`);
  });
});

describe('provider and backend refusals', () => {
  it('s3 tables tag update names orphan with the flag', async () => {
    const self = {
      logger: noopLogger(),
      resolveTableParts: async () => ({ tableBucketARN: 'arn:b', namespace: 'n', name: 't' }),
      lookupTableArn: async () => undefined,
    };
    const { plain, emulated } = await bothWaysAsync(() =>
      applyTableTagsDiff
        .call(self as never, 'L', 'p', 'AWS::S3Tables::Table', [], [{ Key: 'a', Value: 'b' }], undefined)
        .then(
          () => 'did not throw',
          (e: Error) => e.message
        )
    );
    expect(plain).toContain("Clean up with: cdkd orphan '<constructPath>'");
    expect(emulated).toContain(`Clean up with: cdkd orphan '<constructPath>' ${WITH}`);
  });

  it('a missing state bucket names bootstrap with the flag', async () => {
    const self = {
      logger: noopLogger(),
      config: { bucket: 'bk' },
      ensureClientForBucket: async () => undefined,
      ownerParam: async () => ({}),
      s3Client: {
        send: async () => {
          throw Object.assign(new Error('nf'), { name: 'NotFound' });
        },
      },
    };
    const { plain, emulated } = await bothWaysAsync(() =>
      verifyBucketExists.call(self as never).then(
        () => 'did not throw',
        (e: Error) => e.message
      )
    );
    expect(plain).toContain("Run 'cdkd bootstrap' to create it, or specify an existing bucket via");
    expect(emulated).toContain(
      `Run 'cdkd bootstrap ${WITH}' to create it, or specify an existing bucket via`
    );
  });

  it('a secret-derived schedule without a region names orphan with the flag', async () => {
    const { plain, emulated } = await bothWaysAsync(() =>
      warned((logger) =>
        deleteByRecordedIdentity.call(
          { logger } as never,
          'L',
          'p',
          'AWS::Scheduler::Schedule',
          { creation: 'c', targetArn: 't', roleArn: 'r' },
          undefined
        )
      )
    );
    expect(plain).toContain('then drop the record with \'cdkd orphan\'.');
    expect(emulated).toContain(`then drop the record with 'cdkd orphan ${WITH}'.`);
  });

  it('a schedule edited outside cdkd names the orphan command with the flag', async () => {
    const self = {
      readIdentity: async () => ({ creation: 'c', targetArn: 'other', roleArn: 'r' }),
      refuseUnconfirmed: (...args: unknown[]) => {
        throw new Error(String(args[5]));
      },
    };
    const { plain, emulated } = await bothWaysAsync(() =>
      confirmRecordedSchedule
        .call(
          self as never,
          'L',
          'p',
          'AWS::Scheduler::Schedule',
          undefined,
          { creation: 'c', targetArn: 't', roleArn: 'r' },
          (text: string) => text
        )
        .then(
          () => 'did not throw',
          (e: Error) => e.message
        )
    );
    expect(plain).toContain("drop the record with cdkd orphan '<constructPath>' and deploy again");
    expect(emulated).toContain(
      `drop the record with cdkd orphan '<constructPath>' ${WITH} and deploy again`
    );
  });

  it('an ecs launch type change under drift --revert names drift --accept with the flag', async () => {
    const log = { debug() {}, info() {}, warn() {}, error() {} };
    const { plain, emulated } = await bothWaysAsync(() =>
      updateService
        .call(
          { getClient: () => ({}) } as never,
          'L',
          'arn:svc',
          'AWS::ECS::Service',
          { LaunchType: 'EC2' },
          { LaunchType: 'FARGATE' },
          log as never,
          true,
          false
        )
        .then(
          () => 'did not throw',
          (e: Error) => e.message
        )
    );
    expect(plain).toContain('or run cdkd drift --accept to keep the live value');
    expect(emulated).toContain(`or run cdkd drift --accept ${WITH} to keep the live value`);
  });
});

describe('provider read refusals', () => {
  it('a subnet whose IPv6 block is still associating names orphan with the flag', async () => {
    const self = {
      ec2Client: {
        send: async () => ({
          Subnets: [{ Ipv6CidrBlockAssociationSet: [{ Ipv6CidrBlockState: { State: 'associating' } }] }],
        }),
      },
    };
    const { plain, emulated } = await bothWaysAsync(() =>
      getSubnetAttribute.call(self as never, 'subnet-0abc', 'Ipv6CidrBlocks').then(
        () => 'did not throw',
        (e: Error) => e.message
      )
    );
    expect(plain).toContain('run cdkd orphan again once it is associated');
    expect(emulated).toContain(`run cdkd orphan ${WITH} again once it is associated`);
  });

  it('a global table with unkeyed live entries names drift with the flag', async () => {
    const live = { GlobalSecondaryIndexes: [{ IndexName: 'a' }, {}] };
    const self = { logger: noopLogger(), readCurrentState: async () => live };
    const { plain, emulated } = await bothWaysAsync(() =>
      warned((logger) =>
        dynamoReadUnsettled.call(
          { ...self, logger } as never,
          'tbl',
          'L',
          'AWS::DynamoDB::GlobalTable',
          new Set(['GlobalSecondaryIndexes']),
          { GlobalSecondaryIndexes: [{ IndexName: 'a' }] },
          { GlobalSecondaryIndexes: [{ IndexName: 'a' }] }
        )
      )
    );
    expect(plain).toContain("Check it with 'cdkd drift'.");
    expect(emulated).toContain(`Check it with 'cdkd drift ${WITH}'.`);
  });
});

describe('remaining resolver and refusal texts', () => {
  const settled = <T>(run: () => Promise<T> | T) => async () =>
    Promise.resolve()
      .then(run)
      .then(
        () => 'did not throw',
        (e: Error) => e.message
      );

  it('an unproven drift secret region names drift with the flag', () => {
    const { plain, emulated } = bothWays(() =>
      thrown(() =>
        refuseUnprovenDriftSecret(
          '{{resolve:secretsmanager:my-secret:SecretString:k}}',
          'P',
          'L',
          'us-east-1',
          { complete: false, regions: new Set<string>() } as never
        )
      )
    );
    expect(plain).toContain("then re-run 'cdkd drift'.");
    expect(emulated).toContain(`then re-run 'cdkd drift ${WITH}'.`);
  });

  it('a security-group rule without a recorded id names export with the flag', () => {
    const identifier = recordedRuleIdIdentifier();
    const { plain, emulated } = bothWays(() =>
      thrown(() =>
        identifier.resolve({
          logicalId: 'L',
          physicalId: 'sg-0abc|tcp|80|80',
          attributes: {},
        } as never)
      )
    );
    expect(plain).toContain('then re-run cdkd export. In both cases');
    expect(emulated).toContain(`then re-run cdkd export ${WITH}. In both cases`);
  });

  it('a create-only key the provider now writes names import with the flag', () => {
    const { plain, emulated } = bothWays(() =>
      unwrittenCreateOnlyRefusal({
        logicalId: 'L',
        resourceType: 'AWS::X::Y',
        unwritten: ['P'],
        routeDriving: [],
        nested: false,
        nowWritten: ['P'],
        evidence: ['P'],
      })
    );
    expect(plain).toContain('resource instead: cdkd import with --resource');
    expect(emulated).toContain(`resource instead: cdkd import ${WITH} with --resource`);
  });

  it('an unsettled resource refusal names drift --accept with the flag', async () => {
    const provider = {
      unsettledInTransition: async () => new Set(['P']),
      readCurrentState: async () => ({}),
    };
    const { plain, emulated } = await bothWaysAsync(
      settled(() =>
        settleUnsettledPrevious({
          provider: provider as never,
          logicalId: 'L',
          physicalId: 'p',
          resourceType: 'AWS::X::Y',
          recordedProperties: {},
          names: new Set(['P']),
          previous: {},
        })
      )
    );
    expect(plain).toContain("run 'cdkd drift --accept' once it has.");
    expect(emulated).toContain(`run 'cdkd drift --accept ${WITH}' once it has.`);
  });

  it('a nested scrub child with no template names scrub with the flag', async () => {
    const parent = { stackName: 'P', artifactId: 'P', nestedTemplates: {} } as never;
    const { plain, emulated } = await bothWaysAsync(async () => {
      const item = nestedChildWorkItem(parent, 'us-east-1', {
        stackName: 'P~C',
        logicalId: 'C',
      } as never);
      const loaded = (await item.load()) as unknown as { nestedChild?: { refusal?: string } };
      return loaded.nestedChild?.refusal ?? 'no refusal';
    });
    expect(plain).toContain('that emits it, then re-run cdkd scrub.');
    expect(emulated).toContain(`that emits it, then re-run cdkd scrub ${WITH}.`);
  });
});

describe('provider state-replay warnings', () => {
  it('an efs state replay with no throughput value names drift with the flag', async () => {
    const { plain, emulated } = await bothWaysAsync(() =>
      warned((log) =>
        updateFileSystem.call(
          {} as never,
          'L',
          'fs-1',
          'AWS::EFS::FileSystem',
          { ThroughputMode: 'provisioned' },
          { ThroughputMode: 'bursting' },
          log as never,
          true
        )
      )
    );
    expect(plain).toContain('run cdkd drift to see it.');
    expect(emulated).toContain(`run cdkd drift ${WITH} to see it.`);
  });

  it('an elbv2 revert that leaves a key in place names drift --accept with the flag', async () => {
    const self = {
      logger: noopLogger(),
      normalizeAttributes: (value: unknown) => value,
      diffAttributes: (
        _desired: unknown,
        _previous: unknown,
        removal: (key: string, value: string) => string | undefined
      ) => {
        removal('some.key', 'v');
        return [];
      },
    };
    const { plain, emulated } = await bothWaysAsync(() =>
      warned((logger) =>
        diffAttributeBag.call(
          { ...self, logger } as never,
          'LoadBalancerAttributes',
          'L',
          [],
          [],
          () => undefined,
          true,
          undefined
        )
      )
    );
    expect(plain).toContain("run 'cdkd drift --accept' to record it");
    expect(emulated).toContain(`run 'cdkd drift --accept ${WITH}' to record it`);
  });
});
