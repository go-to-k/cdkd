import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

// go-to-k/cdkd#6246: under `--aws-emulator`, a destroy that read no CDK app
// would run its custom resources' Delete handlers in AWS Emulator's own
// runtime (which fails CDK's providers) and then delete the handler functions,
// so the advised `cdkd destroy` from the app could no longer run them. Every
// target, nested stacks included, is checked before the first one is touched.

const wiring = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveWorkloadAwsWiring: () => wiring.value,
}));
const assembly = vi.hoisted(() => ({ stacks: [] as unknown[] }));
vi.mock('../../../src/synthesis/synthesized-stacks.js', () => ({
  synthesizedStacks: () => assembly.stacks,
}));

const { setLocalCustomResourceRuntimeEnabled } =
  await import('../../../src/local/custom-resource-runtime-gate.js');
const { refuseCustomResourcesWithoutApp, customResourcesWithoutAppMessage, runsInLocalRuntime } =
  await import('../../../src/cli/commands/destroy-runner/emulator-custom-resources.js');
const { CdkdError } = await import('../../../src/utils/error-handler.js');

const ACCOUNT = '000000000000';
const LAMBDA = `arn:aws:lambda:us-east-1:${ACCOUNT}:function:Handler`;

const row = (resourceType: string, serviceToken?: string) => ({
  physicalId: 'phys',
  resourceType,
  properties: serviceToken === undefined ? {} : { ServiceToken: serviceToken },
  attributes: {},
  dependencies: [],
});

function stateWith(stackName: string, resources: Record<string, ReturnType<typeof row>>): StackState {
  return {
    version: 15,
    stackName,
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 1,
  } as StackState;
}

const records = new Map<string, StackState>();
const getState = vi.fn(async (stackName: string, _region: string) => {
  const state = records.get(stackName);
  return state === undefined ? null : { state };
});

function check(stackNames: string[], account: string | undefined = ACCOUNT) {
  return refuseCustomResourcesWithoutApp(
    stackNames.map((stackName) => ({ stackName, region: 'us-east-1' })),
    { getState, callerAccount: async () => account }
  );
}

async function refusal(stackNames: string[]): Promise<string> {
  const err = await check(stackNames).then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(CdkdError);
  return (err as Error).message;
}

beforeEach(() => {
  records.clear();
  getState.mockClear();
  wiring.value = { mode: 'emulator' };
  assembly.stacks = [];
  setLocalCustomResourceRuntimeEnabled(true, 'state destroy');
  records.set(
    'MineStack',
    stateWith('MineStack', {
      PutParam: row('Custom::AWS', LAMBDA),
      MyRes: row('AWS::CloudFormation::CustomResource', LAMBDA),
      Handler: row('AWS::Lambda::Function'),
    })
  );
  records.set('Plain', stateWith('Plain', { Handler: row('AWS::Lambda::Function') }));
});

describe('refuseCustomResourcesWithoutApp (#6246)', () => {
  it.each(['state destroy', 'destroy'])('%s: refused, naming the stack and its custom resources', async (command) => {
    setLocalCustomResourceRuntimeEnabled(true, command);
    const message = await refusal(['MineStack']);
    expect(message).toContain('stack MineStack (PutParam, MyRes)');
    expect(message).toContain('Nothing was deleted.');
    expect(message).toContain('--no-local-custom-resources');
    expect(message.trimEnd().split('\n').at(-1)).toBe(
      "Run from the app's directory: cdkd destroy MineStack"
    );
  });

  it("a nested child's custom resources refuse the TOP-LEVEL stack, by its name", async () => {
    records.set(
      'Parent',
      stateWith('Parent', {
        Nested: row('AWS::CloudFormation::Stack'),
        Bucket: row('AWS::S3::Bucket'),
      })
    );
    records.set(
      'Parent~Nested',
      stateWith('Parent~Nested', {
        Deeper: row('AWS::CloudFormation::Stack'),
        PutParam: row('Custom::AWS', LAMBDA),
      })
    );
    records.set('Parent~Nested~Deeper', stateWith('Parent~Nested~Deeper', { Cr: row('Custom::X', LAMBDA) }));
    const message = await refusal(['Parent']);
    expect(message).toContain(
      'stack Parent (Cr in nested stack Parent~Nested~Deeper, PutParam in nested stack Parent~Nested)'
    );
    expect(message.trimEnd().split('\n').at(-1)).toBe("Run from the app's directory: cdkd destroy Parent");
    expect(getState).toHaveBeenCalledWith('Parent~Nested', 'us-east-1');
  });

  it('a nested child named directly is named by its top-level stack, which cdkd destroy addresses', async () => {
    records.set('Parent~Child', stateWith('Parent~Child', { Cr: row('Custom::X', LAMBDA) }));
    const message = await refusal(['Parent~Child']);
    expect(message).toContain('stack Parent (Cr in nested stack Parent~Child)');
    expect(message.trimEnd().split('\n').at(-1)).toBe(
      "Run from the app's directory: cdkd destroy Parent"
    );
  });

  it('every target is checked: the refusal names each stack holding custom resources', async () => {
    records.set('Other', stateWith('Other', { Cr: row('Custom::X', LAMBDA) }));
    const message = await refusal(['Plain', 'MineStack', 'Other']);
    expect(message).toContain('stacks MineStack (PutParam, MyRes); Other (Cr)');
    expect(message).not.toContain('Plain');
    expect(message.trimEnd().split('\n').at(-1)).toBe(
      "Run from the app's directory: cdkd destroy MineStack Other"
    );
  });

  it('an SNS-backed or another account\'s custom resource is not refused', async () => {
    records.set(
      'MineStack',
      stateWith('MineStack', {
        Sns: row('Custom::X', `arn:aws:sns:us-east-1:${ACCOUNT}:topic`),
        Foreign: row('Custom::X', 'arn:aws:lambda:us-east-1:111111111111:function:Imported'),
        NoToken: row('Custom::X'),
      })
    );
    await expect(check(['MineStack'])).resolves.toBeUndefined();
  });

  it.each<[string, () => void]>([
    ['with --no-local-custom-resources', () => setLocalCustomResourceRuntimeEnabled(false, 'state destroy')],
    ['when the app was synthesized', () => (assembly.stacks = [{ stackName: 'MineStack' }])],
    ['off the emulator', () => (wiring.value = undefined)],
    ['under rollback', () => setLocalCustomResourceRuntimeEnabled(true, 'rollback')],
  ])('not refused %s, and no record is read', async (_label, arrange) => {
    arrange();
    await expect(check(['MineStack'])).resolves.toBeUndefined();
    expect(getState).not.toHaveBeenCalled();
  });

  it('not refused with no custom resources, or no record', async () => {
    await expect(check(['Plain', 'Missing'])).resolves.toBeUndefined();
  });
});

describe('runsInLocalRuntime', () => {
  it.each<[unknown, string | undefined, boolean]>([
    [LAMBDA, ACCOUNT, true],
    [`${LAMBDA}:live`, ACCOUNT, true],
    [LAMBDA, undefined, true],
    ['arn:aws:lambda:us-east-1:111111111111:function:H', ACCOUNT, false],
    [`arn:aws:sns:us-east-1:${ACCOUNT}:t`, ACCOUNT, false],
    [{ 'Fn::GetAtt': ['H', 'Arn'] }, ACCOUNT, false],
  ])('%o in %s -> %s', (token, account, expected) => {
    expect(runsInLocalRuntime(token, account)).toBe(expected);
  });
});

describe('customResourcesWithoutAppMessage', () => {
  it('names five custom resources and counts the rest', () => {
    const message = customResourcesWithoutAppMessage([
      { stackName: 'S', customResources: ['A', 'B', 'C', 'D', 'E', 'F', 'G'] },
    ]);
    expect(message).toContain('(A, B, C, D, E and 2 more)');
  });

  it('a stack name that is not a plain identifier is a hole, explained', () => {
    const message = customResourcesWithoutAppMessage([
      { stackName: '$(rm -rf x)', customResources: ['A'] },
    ]);
    expect(message).not.toContain('$(rm');
    expect(message).toContain('a stack name that is not a plain identifier');
    expect(message.trimEnd().split('\n').at(-1)).toBe(
      "Run from the app's directory: cdkd destroy '<stack>'"
    );
  });
});
