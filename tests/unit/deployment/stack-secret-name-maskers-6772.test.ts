/**
 * go-to-k/cdkd#6772: the stack-wide printing maskers a delete refusal naming a
 * sibling masks with. Each is ONE union over the delete's own bags and the
 * stack's secret-named records (go-to-k/cdkd#4049): a stack needle that
 * overlaps an own needle without containing it is masked with it in one pass,
 * never cutting it and printing its tail.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import { stackSecretNamesMasker } from '../../../src/deployment/secret-name-needles.js';
import { replayStackMask } from '../../../src/deployment/rollback-executor/replay-scope.js';
import { makePrintingBagOf } from '../../../src/cli/commands/destroy-runner/under-lock-steps.js';
import {
  SecretsRunState,
  stackSecretNameMasker,
} from '../../../src/deployment/deploy-engine/masking.js';
import {
  type RecordedSecretValues,
  recordLogOnlyValue,
} from '../../../src/deployment/secret-redaction.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

const REF = '{{resolve:secretsmanager:team:SecretString:profile::}}';
/** A retained profile named from a secret: its id is the needle. */
const PROFILE = 'S3CR3T';
/** A needle of the delete's OWN bag overlapping the profile's, not containing it. */
const OWN = 'CR3T-tail';

const records = (): Record<string, ResourceState> => ({
  Profile: {
    physicalId: PROFILE,
    resourceType: 'AWS::IAM::InstanceProfile',
    properties: { InstanceProfileName: REF },
    attributes: {},
    dependencies: [],
  },
});

const bagOf = (...needles: string[]): RecordedSecretValues => {
  const bag: RecordedSecretValues = new Map();
  for (const needle of needles) recordLogOnlyValue(bag, needle);
  return bag;
};

describe('stackSecretNamesMasker (cdkd rollback, a nested child revert)', () => {
  it("masks a record's secret-derived name after the replay dropped the record", () => {
    const resources = records();
    const maskerFor = stackSecretNamesMasker(resources, undefined);
    // The replay takes the record back before the refusal is worded.
    delete resources['Profile'];
    expect(maskerFor([])(`instance profile(s) ${PROFILE}`)).toBe('instance profile(s) ***');
    // Negative control: an ordinary name is left as it is.
    expect(maskerFor([])('plain-profile-name')).toBe('plain-profile-name');
  });

  it('judges the records as they were built, not as a replay rewrites them in place', () => {
    const resources = records();
    const maskerFor = stackSecretNamesMasker(resources, undefined);
    resources['Profile']!.properties = { InstanceProfileName: 'plain' };
    expect(maskerFor([])(PROFILE)).toBe('***');
  });

  it('reads the extra bags at each call', () => {
    const extra = bagOf();
    const mask = stackSecretNamesMasker({}, undefined, () => [extra])([]);
    expect(mask('later-name')).toBe('later-name');
    recordLogOnlyValue(extra, 'later-name');
    expect(mask('later-name')).toBe('***');
  });

  it("masks an op's own needle overlapping a stack needle in one pass (go-to-k/cdkd#4049)", () => {
    const mask = replayStackMask({
      ctx: { maskStackSecretNames: stackSecretNamesMasker(records(), undefined) },
      op: { logicalId: 'Role' },
      secrets: bagOf(OWN),
    });
    expect(mask?.(`profile(s) ${PROFILE}-tail end`)).toBe('profile(s) *** end');
  });

  it("replayStackMask unions the failed deploy's bag too", () => {
    const mask = replayStackMask({
      ctx: {
        maskStackSecretNames: stackSecretNamesMasker({}, undefined),
        logOnlyNeedlesFor: (logicalId) => (logicalId === 'Role' ? bagOf('deploy-value') : undefined),
      },
      op: { logicalId: 'Role' },
      secrets: bagOf(),
    });
    expect(mask?.('a deploy-value b')).toBe('a *** b');
  });
});

describe("cdkd destroy's stackMaskerFor", () => {
  const printingBagOf = () =>
    makePrintingBagOf({
      ctx: {} as never,
      state: {
        version: 8,
        stackName: 'TestStack',
        region: 'us-east-1',
        resources: records(),
        outputs: {},
        lastModified: 1,
      } as StackState,
      noEchoValues: undefined,
      stackName: 'TestStack',
      logger: { debug: vi.fn() } as never,
    });

  it("masks a retained sibling's name and an overlapping own needle in one pass (go-to-k/cdkd#4049)", () => {
    const mask = printingBagOf().stackMaskerFor([bagOf(OWN)]);
    expect(mask(`profile(s) ${PROFILE}-tail end`)).toBe('profile(s) *** end');
    expect(mask('plain-profile-name')).toBe('plain-profile-name');
  });
});

describe("a deploy's stackSecretNameMasker over the run's resolved bags", () => {
  it("masks a resolved secret overlapping a record's needle in one pass (go-to-k/cdkd#4049)", () => {
    const run = new SecretsRunState();
    run.preDeploySecretNamedRecords = bagOf(PROFILE);
    run.perResourceSecrets.set('Role', bagOf(OWN));
    expect(stackSecretNameMasker(run)(`profile(s) ${PROFILE}-tail end`)).toBe('profile(s) *** end');
  });

  it("masks the stack's NoEcho values and a replay's own bags", () => {
    const run = new SecretsRunState();
    run.fingerprintNoEchoValues = bagOf('noecho-value');
    expect(stackSecretNameMasker(run)('x noecho-value')).toBe('x ***');
    expect(stackSecretNameMasker(run, [bagOf('op-value')])('y op-value')).toBe('y ***');
  });
});
