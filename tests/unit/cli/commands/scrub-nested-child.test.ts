import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * `cdkd scrub` reaches a nested-stack CHILD's `{parent}~{Child}` record through
 * its parent (go-to-k/cdkd#2252).
 *
 * The child's template spells a secret-fed parameter as `{Ref: <Param>}`, so
 * re-resolving the child alone records NO needle: before this, scrub never
 * visited the record at all, and `--dry-run --fail` exited 0 over a child that
 * a pre-#1903 binary had written with the decrypted secret. The needle source
 * is the PARENT's resolution of the child's `Parameters` block, handed down as
 * the child resolver's `inheritedSecrets` — so these cases run the REAL
 * resolver (only the SDK clients are faked), because the recording they rely
 * on happens inside it.
 */

const { secretValues, sends, FakeSecretsManagerClient, FakeStsClient } = vi.hoisted(() => {
  const secretValues = new Map<string, string>();
  const sends: Array<{ command: string; input: unknown }> = [];
  class FakeSecretsManagerClient {
    readonly config = { region: (): Promise<string> => Promise.resolve('us-east-1') };
    send(command: { input?: { SecretId?: string }; constructor: { name: string } }): Promise<unknown> {
      sends.push({ command: command.constructor.name, input: command.input });
      const value = secretValues.get(command.input?.SecretId ?? '');
      if (value === undefined) {
        return Promise.reject(
          Object.assign(new Error("Secrets Manager can't find the specified secret."), {
            name: 'ResourceNotFoundException',
          })
        );
      }
      return Promise.resolve({ SecretString: value });
    }
    destroy(): void {}
  }
  class FakeStsClient {
    readonly config = { region: (): Promise<string> => Promise.resolve('us-east-1') };
    send(): Promise<unknown> {
      return Promise.resolve({ Account: '111122223333', Arn: 'arn:aws:iam::111122223333:root' });
    }
    destroy(): void {}
  }
  return { secretValues, sends, FakeSecretsManagerClient, FakeStsClient };
});

vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  SecretsManagerClient: FakeSecretsManagerClient,
}));
vi.mock('@aws-sdk/client-sts', async (importOriginal) => ({
  ...((await importOriginal()) as object),
  STSClient: FakeStsClient,
}));

const logLines: string[] = [];
vi.mock('../../../../src/utils/logger.js', () => {
  const push =
    (level: string) =>
    (...args: unknown[]): void =>
      void logLines.push(`${level} ${args.map(String).join(' ')}`);
  const fake = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    setLevel: (): void => {},
    child: (): unknown => fake,
  };
  return { getLogger: () => fake };
});

const synthStacks = vi.hoisted(() => [] as unknown[]);
vi.mock('../../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockImplementation(() => Promise.resolve({ stacks: synthStacks })),
    expandMacrosForStacks: vi.fn().mockResolvedValue(undefined),
  })),
  synthesisStatusMessage: () => 'synthesizing',
}));
vi.mock('../../../../src/cli/config-loader.js', () => ({
  resolveApp: () => 'node app.js',
  resolveStateBucketWithDefault: () => Promise.resolve('cdkd-state-bucket'),
}));
vi.mock('../../../../src/utils/role-arn.js', () => ({ applyRoleArnIfSet: vi.fn() }));

/** The state bucket: `<stack>|<region>` -> the stored record. */
const stateStore = vi.hoisted(() => new Map<string, unknown>());
const stateBackend = vi.hoisted(() => ({
  getState: vi.fn(),
  saveState: vi.fn(),
  listStacks: vi.fn(),
}));
vi.mock('../../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => stateBackend),
}));
const lockCalls = vi.hoisted(() => [] as string[]);
vi.mock('../../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLockWithRetry: vi.fn().mockImplementation((stack: string) => {
      lockCalls.push(stack);
      return Promise.resolve(undefined);
    }),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock('../../../../src/state/export-index-store.js', () => ({
  // No exports in these fixtures, so the region's index object does not exist.
  ExportIndexStore: vi.fn().mockImplementation(() => ({
    readPersistedEntries: vi.fn().mockResolvedValue(undefined),
    patchEntry: vi.fn().mockResolvedValue(true),
  })),
}));

import { resetAwsClients } from '../../../../src/utils/aws-clients.js';
import { resetAccountInfoCache } from '../../../../src/deployment/intrinsic-function-resolver.js';
import { clearRecordedSecretExpressions } from '../../../../src/deployment/secret-redaction.js';
import { scrubCommand, ScrubNeededError } from '../../../../src/cli/commands/scrub.js';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

const REGION = 'us-east-1';
const DB_PASSWORD = 'nested-child-db-password-2252';
const SECRET_EXPR = '{{resolve:secretsmanager:app/db:SecretString:password}}';
/** An unrelated secret, the grandchild's own, to prove each level keeps its bag. */
const API_KEY = 'grandchild-api-key-2252';
const API_EXPR = '{{resolve:secretsmanager:app/api:SecretString:key}}';
/** A SUB-FLOOR pin, reachable only through the object-spelled frame carry (#3062). */
const PIN = 'q7';
const PIN_EXPR = '{{resolve:secretsmanager:app/pin:SecretString:pin}}';

const PARENT = 'ParentStack';
const CHILD = `${PARENT}~ChildStack`;
const GRANDCHILD = `${CHILD}~GrandStack`;

let assemblyDir: string;

function writeTemplate(name: string, template: CloudFormationTemplate): string {
  const file = path.join(assemblyDir, name);
  fs.writeFileSync(file, JSON.stringify(template));
  return file;
}

function nestedRow(
  assetPath: string,
  parameters: Record<string, unknown>
): Record<string, unknown> {
  return {
    Type: 'AWS::CloudFormation::Stack',
    Properties: { TemplateURL: 'https://example.invalid/child.json', Parameters: parameters },
    Metadata: { 'aws:asset:path': assetPath },
  };
}

/** The child: one consumer of the parameter, one bystander, one output. */
function childTemplate(
  extraResources: Record<string, unknown> = {},
  extraOutputs: Record<string, unknown> = {}
): CloudFormationTemplate {
  return {
    Parameters: { DbPassword: { Type: 'String' } },
    Resources: {
      Fn: {
        Type: 'AWS::Lambda::Function',
        Properties: { Environment: { Variables: { PW: { Ref: 'DbPassword' } } } },
      },
      // Never references the parameter, but its literal CONTAINS the
      // plaintext. The needle is recorded per consuming resource (issue
      // #2087), so this literal must survive.
      Bystander: {
        Type: 'AWS::SSM::Parameter',
        Properties: { Value: `prefix-${DB_PASSWORD}-suffix` },
      },
      ...extraResources,
    },
    Outputs: { PwOut: { Value: { Ref: 'DbPassword' } }, ...extraOutputs },
  } as CloudFormationTemplate;
}

function parentStack(
  resources: Record<string, unknown>,
  nestedTemplates: Record<string, string>
): Record<string, unknown> {
  return {
    stackName: PARENT,
    displayName: PARENT,
    artifactId: PARENT,
    dependencyNames: [],
    region: REGION,
    template: { Resources: resources },
    nestedTemplates,
  };
}

function record(
  stackName: string,
  resources: StackState['resources'],
  outputs: Record<string, unknown> = {}
): StackState {
  return {
    version: 10,
    region: REGION,
    stackName,
    resources,
    outputs,
    lastModified: 0,
  } as StackState;
}

/** The parent's record: the nested row, as a post-#1903 parent already stores it. */
function parentRecord(parameters: Record<string, unknown> = { DbPassword: SECRET_EXPR }): StackState {
  return record(PARENT, {
    ChildStack: {
      physicalId: `arn:cdkd-local:${REGION}:111122223333:nested-stack/${PARENT}/ChildStack`,
      resourceType: 'AWS::CloudFormation::Stack',
      properties: { TemplateURL: 'https://example.invalid/child.json', Parameters: parameters },
      attributes: {},
    },
  });
}

/** The child's record as a PRE-#1903 binary wrote it: plaintext everywhere. */
function leakyChildRecord(): StackState {
  return record(
    CHILD,
    {
      Fn: {
        physicalId: 'child-fn',
        resourceType: 'AWS::Lambda::Function',
        properties: { Environment: { Variables: { PW: DB_PASSWORD } } },
        attributes: {},
      },
      Bystander: {
        physicalId: 'bystander',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Value: `prefix-${DB_PASSWORD}-suffix` },
        attributes: {},
      },
    },
    { PwOut: DB_PASSWORD }
  );
}

function seed(stackName: string, state: StackState): void {
  stateStore.set(`${stackName}|${REGION}`, structuredClone(state));
}

function stored(stackName: string): StackState | undefined {
  return stateStore.get(`${stackName}|${REGION}`) as StackState | undefined;
}

function savedNames(): string[] {
  return stateBackend.saveState.mock.calls.map((c) => c[0] as string);
}

async function run(stacks: string[], extra: Record<string, unknown> = {}): Promise<unknown> {
  try {
    await scrubCommand(stacks, {
      output: 'cdk.out',
      statePrefix: 'cdkd',
      verbose: false,
      ...extra,
    } as never);
    return undefined;
  } catch (err) {
    return err;
  }
}

beforeEach(() => {
  assemblyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdkd-scrub-nested-'));
  stateStore.clear();
  secretValues.clear();
  secretValues.set('app/db', JSON.stringify({ password: DB_PASSWORD }));
  secretValues.set('app/api', JSON.stringify({ key: API_KEY }));
  secretValues.set('app/pin', JSON.stringify({ pin: PIN }));
  sends.length = 0;
  logLines.length = 0;
  lockCalls.length = 0;
  synthStacks.length = 0;
  process.env['AWS_REGION'] = REGION;
  resetAwsClients();
  resetAccountInfoCache();
  clearRecordedSecretExpressions();
  stateBackend.getState.mockReset().mockImplementation((stack: string, region: string) => {
    const state = stateStore.get(`${stack}|${region}`);
    return Promise.resolve(
      state === undefined ? null : { state: structuredClone(state), etag: `etag-${stack}` }
    );
  });
  stateBackend.saveState
    .mockReset()
    .mockImplementation((stack: string, region: string, state: StackState) => {
      stateStore.set(`${stack}|${region}`, structuredClone(state));
      return Promise.resolve('etag-next');
    });
  stateBackend.listStacks.mockReset().mockResolvedValue([]);
});

afterEach(() => {
  fs.rmSync(assemblyDir, { recursive: true, force: true });
  resetAwsClients();
  clearRecordedSecretExpressions();
  delete process.env['AWS_REGION'];
});

describe('cdkd scrub - nested-stack child records (go-to-k/cdkd#2252)', () => {
  function standardApp(): void {
    const childPath = writeTemplate('ChildStack.nested.template.json', childTemplate());
    synthStacks.push(
      parentStack(
        { ChildStack: nestedRow('ChildStack.nested.template.json', { DbPassword: SECRET_EXPR }) },
        { ChildStack: childPath }
      )
    );
  }

  it('rewrites the plaintext a pre-#1903 binary left in the CHILD record, through the parent', async () => {
    standardApp();
    seed(PARENT, parentRecord());
    seed(CHILD, leakyChildRecord());

    const err = await run([PARENT]);

    expect(err).toBeUndefined();
    const child = stored(CHILD)!;
    expect(child.resources['Fn']!.properties).toEqual({
      Environment: { Variables: { PW: SECRET_EXPR } },
    });
    expect(child.outputs).toEqual({ PwOut: SECRET_EXPR });
    // The child's own lock, under the key a child deploy locks — not the parent's.
    expect(lockCalls).toEqual([PARENT, CHILD]);
    expect(logLines.join('\n')).toContain(`Scrubbed 2 resource record(s) in ${CHILD}`);
  });

  it('keeps an UNRELATED literal in a resource that never consumed the parameter (issue #2087)', async () => {
    standardApp();
    seed(PARENT, parentRecord());
    seed(CHILD, leakyChildRecord());

    await run([PARENT]);

    expect(stored(CHILD)!.resources['Bystander']!.properties).toEqual({
      Value: `prefix-${DB_PASSWORD}-suffix`,
    });
  });

  it('turns --dry-run --fail RED over a leaky child record, which it used to report clean', async () => {
    standardApp();
    seed(PARENT, parentRecord());
    seed(CHILD, leakyChildRecord());

    const err = await run([PARENT], { dryRun: true, fail: true });

    expect(err).toBeInstanceOf(ScrubNeededError);
    expect(stateBackend.saveState).not.toHaveBeenCalled();
    expect(lockCalls).toEqual([]);
    expect(logLines.join('\n')).toContain(`Would scrub 2 resource record(s) in ${CHILD}`);
  });

  it('reports an already-clean child clean, and writes nothing (negative control)', async () => {
    standardApp();
    seed(PARENT, parentRecord());
    const clean = leakyChildRecord();
    clean.resources['Fn']!.properties = { Environment: { Variables: { PW: SECRET_EXPR } } };
    clean.outputs = { PwOut: SECRET_EXPR };
    seed(CHILD, clean);

    const err = await run([PARENT], { dryRun: true, fail: true });

    expect(err).toBeUndefined();
    expect(logLines.join('\n')).toContain(`No plaintext secrets found in ${CHILD}`);
  });

  it('never prints the inherited plaintext', async () => {
    standardApp();
    seed(PARENT, parentRecord());
    seed(CHILD, leakyChildRecord());

    await run([PARENT], { dryRun: true });

    expect(logLines.join('\n')).not.toContain(DB_PASSWORD);
  });

  it('walks every level: a grandchild is scrubbed with the child it inherits from', async () => {
    const grandPath = writeTemplate('GrandStack.nested.template.json', {
      Parameters: { Pw: { Type: 'String' } },
      Resources: {
        Grand: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Environment: { Variables: { PW: { Ref: 'Pw' }, KEY: API_EXPR } },
          },
        },
      },
    } as CloudFormationTemplate);
    const childPath = writeTemplate(
      'ChildStack.nested.template.json',
      childTemplate({
        GrandStack: nestedRow(path.basename(grandPath), { Pw: { Ref: 'DbPassword' } }),
      })
    );
    synthStacks.push(
      parentStack(
        { ChildStack: nestedRow(path.basename(childPath), { DbPassword: SECRET_EXPR }) },
        { ChildStack: childPath }
      )
    );
    seed(PARENT, parentRecord());
    const child = leakyChildRecord();
    child.resources['GrandStack'] = {
      physicalId: `arn:cdkd-local:${REGION}:111122223333:nested-stack/${CHILD}/GrandStack`,
      resourceType: 'AWS::CloudFormation::Stack',
      properties: {
        TemplateURL: 'https://example.invalid/child.json',
        Parameters: { Pw: DB_PASSWORD },
      },
      attributes: {},
    };
    seed(CHILD, child);
    seed(
      GRANDCHILD,
      record(GRANDCHILD, {
        Grand: {
          physicalId: 'grand-fn',
          resourceType: 'AWS::Lambda::Function',
          properties: { Environment: { Variables: { PW: DB_PASSWORD, KEY: API_KEY } } },
          attributes: {},
        },
      })
    );

    const err = await run([PARENT]);

    expect(err).toBeUndefined();
    expect(stored(GRANDCHILD)!.resources['Grand']!.properties).toEqual({
      Environment: { Variables: { PW: SECRET_EXPR, KEY: API_EXPR } },
    });
    // The child's own nested row, which carried the plaintext as a parameter.
    expect(stored(CHILD)!.resources['GrandStack']!.properties['Parameters']).toEqual({
      Pw: SECRET_EXPR,
    });
    expect(lockCalls).toEqual([PARENT, CHILD, GRANDCHILD]);
  });

  it('repairs an OBJECT-spelled parameter the frame carry covers (the #3062 residual)', async () => {
    const framed = { 'Fn::Join': ['', ['port:', PIN_EXPR]] };
    const childPath = writeTemplate('ChildStack.nested.template.json', {
      Parameters: { Port: { Type: 'String' } },
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { Environment: { Variables: { PORT: { Ref: 'Port' } } } },
        },
      },
    } as CloudFormationTemplate);
    synthStacks.push(
      parentStack(
        { ChildStack: nestedRow(path.basename(childPath), { Port: framed }) },
        { ChildStack: childPath }
      )
    );
    seed(PARENT, parentRecord({ Port: `port:${PIN}` }));
    seed(
      CHILD,
      record(CHILD, {
        Fn: {
          physicalId: 'child-fn',
          resourceType: 'AWS::Lambda::Function',
          properties: { Environment: { Variables: { PORT: `port:${PIN}` } } },
          attributes: {},
        },
      })
    );

    const err = await run([PARENT]);

    expect(err).toBeUndefined();
    expect(stored(CHILD)!.resources['Fn']!.properties).toEqual({
      Environment: { Variables: { PORT: `port:${PIN_EXPR}` } },
    });
  });

  it('keeps each child leaf on ITS OWN parameter expression when two share a value (issue #2291)', async () => {
    // Two spellings of one secret: the plaintext-keyed bag collapses them, and
    // only the per-parameter associations the child bag inherits can say which
    // `{Ref}` came from which.
    const STAGED_EXPR = '{{resolve:secretsmanager:app/db:SecretString:password:AWSCURRENT}}';
    const childPath = writeTemplate('ChildStack.nested.template.json', {
      Parameters: { A: { Type: 'String' }, B: { Type: 'String' } },
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { Environment: { Variables: { A: { Ref: 'A' }, B: { Ref: 'B' } } } },
        },
      },
      // The OUTPUTS pass needs the same associations on its own bag.
      Outputs: { OA: { Value: { Ref: 'A' } }, OB: { Value: { Ref: 'B' } } },
    } as CloudFormationTemplate);
    synthStacks.push(
      parentStack(
        { ChildStack: nestedRow(path.basename(childPath), { A: SECRET_EXPR, B: STAGED_EXPR }) },
        { ChildStack: childPath }
      )
    );
    seed(PARENT, parentRecord({ A: SECRET_EXPR, B: STAGED_EXPR }));
    seed(
      CHILD,
      record(CHILD, {
        Fn: {
          physicalId: 'child-fn',
          resourceType: 'AWS::Lambda::Function',
          properties: { Environment: { Variables: { A: DB_PASSWORD, B: DB_PASSWORD } } },
          attributes: {},
        },
      }, { OA: DB_PASSWORD, OB: DB_PASSWORD })
    );

    const err = await run([PARENT]);

    expect(err).toBeUndefined();
    expect(stored(CHILD)!.resources['Fn']!.properties).toEqual({
      Environment: { Variables: { A: SECRET_EXPR, B: STAGED_EXPR } },
    });
    expect(stored(CHILD)!.outputs).toEqual({ OA: SECRET_EXPR, OB: STAGED_EXPR });
  });

  it('scrubs a child whose row passes NO Parameters, and reports it clean when it is', async () => {
    const childPath = writeTemplate('ChildStack.nested.template.json', {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { Environment: { Variables: { KEY: API_EXPR } } },
        },
      },
    } as CloudFormationTemplate);
    synthStacks.push(
      parentStack(
        {
          ChildStack: {
            Type: 'AWS::CloudFormation::Stack',
            Properties: { TemplateURL: 'https://example.invalid/child.json' },
            Metadata: { 'aws:asset:path': path.basename(childPath) },
          },
        },
        { ChildStack: childPath }
      )
    );
    seed(PARENT, parentRecord({}));
    seed(
      CHILD,
      record(CHILD, {
        Fn: {
          physicalId: 'child-fn',
          resourceType: 'AWS::Lambda::Function',
          properties: { Environment: { Variables: { KEY: API_KEY } } },
          attributes: {},
        },
      })
    );

    const err = await run([PARENT]);

    expect(err).toBeUndefined();
    expect(stored(CHILD)!.resources['Fn']!.properties).toEqual({
      Environment: { Variables: { KEY: API_EXPR } },
    });
  });

  it('REFUSES a child whose row names no template file, only when its record exists', async () => {
    // The template declares the row, but the synth output indexed no file for it.
    synthStacks.push(
      parentStack(
        { ChildStack: nestedRow('ChildStack.nested.template.json', { DbPassword: SECRET_EXPR }) },
        {}
      )
    );
    seed(PARENT, parentRecord());
    seed(CHILD, leakyChildRecord());

    const err = await run([PARENT], { dryRun: true, fail: true });

    expect((err as { exitCode?: number }).exitCode).toBe(2);
    expect(logLines.join('\n')).toContain('names no template file for its row');
  });

  it('does not refuse a template-less row whose child never had a record', async () => {
    synthStacks.push(
      parentStack(
        { ChildStack: nestedRow('ChildStack.nested.template.json', { DbPassword: SECRET_EXPR }) },
        {}
      )
    );
    seed(PARENT, parentRecord());

    const err = await run([PARENT], { dryRun: true, fail: true });

    expect(err).toBeUndefined();
  });

  it('REFUSES a child record no row reaches: the parent record is gone (state orphan)', async () => {
    standardApp();
    seed(CHILD, leakyChildRecord());
    seed(GRANDCHILD, record(GRANDCHILD, {}));
    stateBackend.listStacks.mockResolvedValue([
      { stackName: CHILD, region: REGION },
      { stackName: GRANDCHILD, region: REGION },
      // Another region's record and an unrelated stack are not this parent's.
      { stackName: CHILD, region: 'eu-west-1' },
      { stackName: 'OtherStack', region: REGION },
    ]);

    const err = await run([PARENT], { dryRun: true, fail: true });

    expect((err as { exitCode?: number }).exitCode).toBe(2);
    expect((err as Error).message).toContain(CHILD);
    const log = logLines.join('\n');
    expect(log).toContain(`Scrub of ${CHILD} failed`);
    expect(log).toContain(`Scrub of ${GRANDCHILD} failed`);
    // The cause names what is actually missing: the PARENT's record.
    expect(log).toContain(`${PARENT} has no state record`);
    // The grandchild is named ONCE, by its own parent's failure arm.
    expect(log.split(`Scrub of ${GRANDCHILD} failed`).length - 1).toBe(1);
    expect(log).toContain(`the scrub of ${CHILD}, which deploys it, failed`);
    expect(log).not.toContain('No plaintext secrets found in any target stack state');
  });

  it('REFUSES the whole run when the nested records cannot be listed', async () => {
    standardApp();
    seed(PARENT, parentRecord());
    seed(CHILD, leakyChildRecord());
    stateBackend.listStacks.mockRejectedValue(new Error('AccessDenied: ListBucket'));

    const err = await run([PARENT]);

    expect((err as { exitCode?: number }).exitCode).toBe(2);
    expect(logLines.join('\n')).toContain('their state records could not be listed');
    // The reachable child was still scrubbed; only the unreached set is unknown.
    expect(stored(CHILD)!.outputs).toEqual({ PwOut: SECRET_EXPR });
  });

  it('names a nested record under a stack whose own scrub FAILED', async () => {
    standardApp();
    seed(PARENT, parentRecord());
    seed(CHILD, leakyChildRecord());
    const realGetState = stateBackend.getState.getMockImplementation()!;
    stateBackend.getState.mockImplementation((stack: string, region: string) =>
      stack === PARENT ? Promise.reject(new Error('throttled')) : realGetState(stack, region)
    );
    stateBackend.listStacks.mockResolvedValue([
      { stackName: PARENT, region: REGION },
      { stackName: CHILD, region: REGION },
    ]);

    const err = await run([PARENT], { dryRun: true, fail: true });

    expect((err as { exitCode?: number }).exitCode).toBe(2);
    const log = logLines.join('\n');
    expect(log).toContain(`Scrub of ${CHILD} failed`);
    expect(log).toContain(`the scrub of ${PARENT}, which deploys it, failed`);
    // A live child under a transiently failed parent is never told to delete itself.
    expect(log).toContain(`Fix the failure reported for ${PARENT} and re-run cdkd scrub.`);
    expect(log).not.toContain('cdkd state destroy');
  });

  it('REFUSES a child record whose row both the template and the record dropped', async () => {
    synthStacks.push(parentStack({}, {}));
    seed(PARENT, record(PARENT, {}));
    seed(CHILD, leakyChildRecord());
    stateBackend.listStacks.mockResolvedValue([
      { stackName: PARENT, region: REGION },
      { stackName: CHILD, region: REGION },
    ]);

    const err = await run([PARENT], { dryRun: true, fail: true });

    expect((err as { exitCode?: number }).exitCode).toBe(2);
    expect(logLines.join('\n')).toContain(`Scrub of ${CHILD} failed`);
    expect(logLines.join('\n')).toContain('no nested-stack row');
  });

  it('leaves a record a reached row covers to that row, and a same-named APP stack alone', async () => {
    standardApp();
    synthStacks.push({
      stackName: `${PARENT}~Prebuilt`,
      displayName: `${PARENT}~Prebuilt`,
      artifactId: 'Prebuilt',
      dependencyNames: [],
      region: REGION,
      template: { Resources: {} },
    });
    seed(PARENT, parentRecord());
    seed(CHILD, leakyChildRecord());
    // A RECORD for the app stack, so mistaking it for an unreached child
    // would refuse it rather than skip it.
    seed(`${PARENT}~Prebuilt`, record(`${PARENT}~Prebuilt`, {}));
    stateBackend.listStacks.mockResolvedValue([
      { stackName: PARENT, region: REGION },
      { stackName: CHILD, region: REGION },
      { stackName: `${PARENT}~Prebuilt`, region: REGION },
    ]);

    const err = await run([PARENT]);

    expect(err).toBeUndefined();
    expect(logLines.join('\n')).not.toContain('failed');
  });

  it('masks an inherited plaintext in an error escaping a child scrub', async () => {
    standardApp();
    seed(PARENT, parentRecord());
    const realGetState = stateBackend.getState.getMockImplementation()!;
    stateBackend.getState.mockImplementation((stack: string, region: string) =>
      stack === CHILD
        ? Promise.reject(new Error(`read failed near ${DB_PASSWORD}`))
        : realGetState(stack, region)
    );

    const err = await run([PARENT]);

    expect((err as { exitCode?: number }).exitCode).toBe(2);
    const log = logLines.join('\n');
    expect(log).toContain(`Scrub of ${CHILD} failed`);
    expect(log).not.toContain(DB_PASSWORD);
  });

  it('warns about a child-spelled pattern even when another pattern matched', async () => {
    standardApp();
    seed(PARENT, parentRecord());

    await run([PARENT, CHILD]);

    expect(logLines.join('\n')).toContain(
      `matched no stack and was NOT scrubbed. A nested stack is scrubbed with its parent: name ${PARENT}`
    );
  });

  it("repairs the PARENT row's Outputs.<Name> attribute holding a child-sourced plaintext (issue #3961)", async () => {
    // The child's OWN secret, published as an output. `buildOutputsAttributes`
    // copied it into the parent row's attributes; a record from before #1899
    // holds it there in plaintext, and the parent's own bag has no needle for it.
    const childPath = writeTemplate(
      'ChildStack.nested.template.json',
      childTemplate({}, { ApiOut: { Value: API_EXPR } })
    );
    synthStacks.push(
      parentStack(
        { ChildStack: nestedRow(path.basename(childPath), { DbPassword: SECRET_EXPR }) },
        { ChildStack: childPath }
      )
    );
    const parent = parentRecord();
    parent.resources['ChildStack']!.attributes = {
      'Outputs.PwOut': DB_PASSWORD,
      'Outputs.ApiOut': API_KEY,
      // A plain output the child's needles do not match stays as it is.
      'Outputs.Plain': 'not-a-secret',
    };
    seed(PARENT, parent);
    const child = leakyChildRecord();
    child.outputs = { PwOut: DB_PASSWORD, ApiOut: API_KEY, Plain: 'not-a-secret' };
    seed(CHILD, child);

    const err = await run([PARENT]);

    expect(err).toBeUndefined();
    // `Plain` is not declared by the child's template and no pass rewrote it,
    // so the child's own scrub DROPS it (go-to-k/cdkd#4120). The parent row's
    // copy is not the child's output bag, and stays as it is.
    expect(stored(CHILD)!.outputs).toEqual({
      PwOut: SECRET_EXPR,
      ApiOut: API_EXPR,
    });
    expect(stored(PARENT)!.resources['ChildStack']!.attributes).toEqual({
      'Outputs.PwOut': SECRET_EXPR,
      'Outputs.ApiOut': API_EXPR,
      'Outputs.Plain': 'not-a-secret',
    });
    expect(JSON.stringify(stored(PARENT))).not.toContain(API_KEY);
    // The parent is locked AGAIN, for the row rewrite, after the child ran.
    expect(lockCalls).toEqual([PARENT, CHILD, PARENT]);
    expect(logLines.join('\n')).toContain(
      // ONE: the parameter-fed `PwOut` was already rewritten by the parent's own pass.
      `Scrubbed 1 nested-stack output attribute(s) in ${PARENT} (row ChildStack), from ${CHILD}'s outputs`
    );
  });

  describe('the parent-row repair (issue #3961)', () => {
    function appWithChildSecretOutput(): void {
      const childPath = writeTemplate(
        'ChildStack.nested.template.json',
        childTemplate({}, { ApiOut: { Value: API_EXPR } })
      );
      synthStacks.push(
        parentStack(
          { ChildStack: nestedRow(path.basename(childPath), { DbPassword: SECRET_EXPR }) },
          { ChildStack: childPath }
        )
      );
    }
    function cleanChild(): StackState {
      const child = leakyChildRecord();
      child.resources['Fn']!.properties = { Environment: { Variables: { PW: SECRET_EXPR } } };
      child.outputs = { PwOut: SECRET_EXPR, ApiOut: API_EXPR, Embedded: API_EXPR };
      return child;
    }

    it('rewrites each of two outputs resolving to ONE plaintext onto its OWN expression', async () => {
      // Two version stages of one secret: the plaintext-keyed bag collapses
      // them, and only the child's positioned output pass can tell them apart.
      const STAGED_API_EXPR = '{{resolve:secretsmanager:app/api:SecretString:key:AWSCURRENT}}';
      const childPath = writeTemplate(
        'ChildStack.nested.template.json',
        childTemplate({}, { Cur: { Value: API_EXPR }, Staged: { Value: STAGED_API_EXPR } })
      );
      synthStacks.push(
        parentStack(
          { ChildStack: nestedRow(path.basename(childPath), { DbPassword: SECRET_EXPR }) },
          { ChildStack: childPath }
        )
      );
      const parent = parentRecord();
      parent.resources['ChildStack']!.attributes = {
        'Outputs.PwOut': SECRET_EXPR,
        'Outputs.Cur': API_KEY,
        'Outputs.Staged': API_KEY,
      };
      seed(PARENT, parent);
      const child = cleanChild();
      child.outputs = { PwOut: SECRET_EXPR, Cur: API_KEY, Staged: API_KEY };
      seed(CHILD, child);

      const err = await run([PARENT]);

      expect(err).toBeUndefined();
      expect(stored(CHILD)!.outputs).toEqual({
        PwOut: SECRET_EXPR,
        Cur: API_EXPR,
        Staged: STAGED_API_EXPR,
      });
      expect(stored(PARENT)!.resources['ChildStack']!.attributes).toEqual({
        'Outputs.PwOut': SECRET_EXPR,
        'Outputs.Cur': API_EXPR,
        'Outputs.Staged': STAGED_API_EXPR,
      });
    });

    it('turns --dry-run --fail RED when ONLY the parent attribute holds the plaintext', async () => {
      appWithChildSecretOutput();
      const parent = parentRecord();
      parent.resources['ChildStack']!.attributes = {
        'Outputs.PwOut': SECRET_EXPR,
        'Outputs.ApiOut': API_KEY,
      };
      seed(PARENT, parent);
      seed(CHILD, cleanChild());

      const err = await run([PARENT], { dryRun: true, fail: true });

      expect(err).toBeInstanceOf(ScrubNeededError);
      expect(stateBackend.saveState).not.toHaveBeenCalled();
      expect(lockCalls).toEqual([]);
      const log = logLines.join('\n');
      expect(log).toContain(`Would scrub 1 nested-stack output attribute(s) in ${PARENT}`);
      // The parent's own line does not claim the record clean ahead of that.
      expect(log).not.toContain(`No plaintext secrets found in ${PARENT}\n`);
      expect(log).toContain(
        `No plaintext secrets found in ${PARENT}'s own records; its nested-stack output attributes are checked after each nested stack`
      );
    });

    it('labels a failed parent-row repair apart from the parent scrub, once', async () => {
      appWithChildSecretOutput();
      const parent = parentRecord();
      parent.resources['ChildStack']!.attributes = {
        'Outputs.PwOut': SECRET_EXPR,
        'Outputs.ApiOut': API_KEY,
      };
      seed(PARENT, parent);
      seed(CHILD, cleanChild());
      const realGetState = stateBackend.getState.getMockImplementation()!;
      let parentReads = 0;
      stateBackend.getState.mockImplementation((stack: string, region: string) => {
        if (stack === PARENT && ++parentReads > 1) return Promise.reject(new Error('throttled'));
        return realGetState(stack, region);
      });

      const err = await run([PARENT]);

      expect((err as { exitCode?: number }).exitCode).toBe(2);
      expect((err as Error).message).toContain(`${PARENT} (nested-stack output attributes)`);
      expect((err as Error).message).not.toContain(`${PARENT}, `);
    });

    it('leaves an attribute that does not redact to the child output EXACTLY, and takes no lock', async () => {
      appWithChildSecretOutput();
      const parent = parentRecord();
      parent.resources['ChildStack']!.attributes = {
        'Outputs.PwOut': SECRET_EXPR,
        // Carries no plaintext this run recorded. The child's own POSITIONED
        // pass would write the expression over any value at this position; the
        // parent attribute is not positioned, so it must be left.
        'Outputs.ApiOut': 'unrelated-value',
        // Embeds the plaintext, but is not EXACTLY what the output resolves to.
        'Outputs.Embedded': `prefix-${API_KEY}`,
        // A name the child's outputs do not carry at all.
        'Outputs.Gone': API_KEY,
      };
      seed(PARENT, parent);
      seed(CHILD, cleanChild());

      const err = await run([PARENT]);

      expect(err).toBeUndefined();
      expect(stored(PARENT)!.resources['ChildStack']!.attributes).toEqual({
        'Outputs.PwOut': SECRET_EXPR,
        'Outputs.ApiOut': 'unrelated-value',
        'Outputs.Embedded': `prefix-${API_KEY}`,
        'Outputs.Gone': API_KEY,
      });
      expect(lockCalls).toEqual([PARENT, CHILD]);
      const log = logLines.join('\n');
      expect(log).not.toContain('Scrubbed 1 nested-stack output attribute(s)');
      // Not rewritten, but REPORTED: both still hold a recorded plaintext.
      expect(log).toContain(
        `2 nested-stack output attribute(s) in ${PARENT} (row ChildStack) (Outputs.Embedded, Outputs.Gone) hold a plaintext`
      );
      expect(log).not.toContain('Outputs.ApiOut)');
      expect(log).not.toContain(API_KEY);
    });

    it('never "repairs" an attribute that already IS the expression (clean record, collapsed stages)', async () => {
      // Two stages of one secret on a CLEAN child and parent: the bag keeps one
      // expression, no output changed, so the other stage has no recorded pair.
      const STAGED_API_EXPR = '{{resolve:secretsmanager:app/api:SecretString:key:AWSCURRENT}}';
      const childPath = writeTemplate(
        'ChildStack.nested.template.json',
        childTemplate({}, { Cur: { Value: API_EXPR }, Staged: { Value: STAGED_API_EXPR } })
      );
      synthStacks.push(
        parentStack(
          { ChildStack: nestedRow(path.basename(childPath), { DbPassword: SECRET_EXPR }) },
          { ChildStack: childPath }
        )
      );
      const parent = parentRecord();
      parent.resources['ChildStack']!.attributes = {
        'Outputs.PwOut': SECRET_EXPR,
        'Outputs.Cur': API_EXPR,
        'Outputs.Staged': STAGED_API_EXPR,
      };
      seed(PARENT, parent);
      const child = cleanChild();
      child.outputs = { PwOut: SECRET_EXPR, Cur: API_EXPR, Staged: STAGED_API_EXPR };
      seed(CHILD, child);

      expect(await run([PARENT], { dryRun: true, fail: true })).toBeUndefined();
      expect(await run([PARENT])).toBeUndefined();

      expect(stateBackend.saveState).not.toHaveBeenCalled();
      expect(lockCalls).toEqual([PARENT, CHILD]);
      expect(logLines.join('\n')).not.toContain('nested-stack output attribute(s)');
    });

    it('never "repairs" a clean attribute when the child secret is unreadable', async () => {
      appWithChildSecretOutput();
      secretValues.delete('app/api');
      const parent = parentRecord();
      parent.resources['ChildStack']!.attributes = {
        'Outputs.PwOut': SECRET_EXPR,
        'Outputs.ApiOut': API_EXPR,
      };
      seed(PARENT, parent);
      seed(CHILD, cleanChild());

      await run([PARENT], { dryRun: true, fail: true });
      await run([PARENT]);

      expect(stateBackend.saveState).not.toHaveBeenCalled();
      expect(logLines.join('\n')).not.toContain('nested-stack output attribute(s)');
    });

    it('turns --dry-run --fail RED over an attribute it can report but not rewrite', async () => {
      appWithChildSecretOutput();
      const parent = parentRecord();
      parent.resources['ChildStack']!.attributes = {
        'Outputs.PwOut': SECRET_EXPR,
        'Outputs.Gone': API_KEY,
      };
      seed(PARENT, parent);
      seed(CHILD, cleanChild());

      const err = await run([PARENT], { dryRun: true, fail: true });

      expect(err).toBeInstanceOf(ScrubNeededError);
      expect(logLines.join('\n')).not.toContain('No plaintext secrets found in any target stack state');

      // A REAL run cannot fix it either, so --fail exits non-zero there too.
      logLines.length = 0;
      expect(await run([PARENT], { fail: true })).toBeInstanceOf(ScrubNeededError);
    });
  });

  it('REFUSES a child whose row the parent template dropped, when its record exists', async () => {
    synthStacks.push(parentStack({}, {}));
    seed(PARENT, parentRecord());
    seed(CHILD, leakyChildRecord());

    const err = await run([PARENT], { dryRun: true, fail: true });

    expect((err as { exitCode?: number }).exitCode).toBe(2);
    expect((err as Error).message).toContain(CHILD);
    const log = logLines.join('\n');
    expect(log).toContain(`Scrub of ${CHILD} failed`);
    expect(log).toContain('was NOT examined');
    expect(log).toContain('no longer declares');
    expect(log).not.toContain(`No plaintext secrets found in any target stack state`);
  });

  it('does NOT refuse the same shape when the child never had a record', async () => {
    synthStacks.push(parentStack({}, {}));
    seed(PARENT, parentRecord());

    const err = await run([PARENT], { dryRun: true, fail: true });

    expect(err).toBeUndefined();
    expect(logLines.join('\n')).not.toContain('failed');
    // And takes no lock for a child that does not exist.
    expect(lockCalls).toEqual([]);
  });

  it('REFUSES a child whose parameters cannot be resolved rather than reporting it clean', async () => {
    standardApp();
    secretValues.delete('app/db');
    seed(PARENT, parentRecord());
    seed(CHILD, leakyChildRecord());

    const err = await run([PARENT], { dryRun: true, fail: true });

    expect((err as { exitCode?: number }).exitCode).toBe(2);
    const log = logLines.join('\n');
    expect(log).toContain(`Scrub of ${CHILD} failed`);
    expect(log).toContain('could not be resolved to the values a deploy would hand it');
    expect(log).not.toContain(`No plaintext secrets found in ${CHILD}`);
  });

  it('REFUSES a child whose row the parent record lost, when its record exists', async () => {
    standardApp();
    seed(PARENT, record(PARENT, {}));
    seed(CHILD, leakyChildRecord());

    const err = await run([PARENT], { dryRun: true, fail: true });

    expect((err as { exitCode?: number }).exitCode).toBe(2);
    expect(logLines.join('\n')).toContain('has no record of the nested-stack row that deploys it');
  });

  it('REFUSES a child whose own parameter declaration rejects the inherited value, masked', async () => {
    // A `Number`-typed parameter would COERCE the inherited secret out of the
    // string-keyed redaction model, which the resolver refuses; scrub must not
    // fall back to an empty parameter bag and report the child clean.
    const childPath = writeTemplate('ChildStack.nested.template.json', {
      ...childTemplate(),
      Parameters: { DbPassword: { Type: 'Number' } },
    } as CloudFormationTemplate);
    synthStacks.push(
      parentStack(
        { ChildStack: nestedRow(path.basename(childPath), { DbPassword: SECRET_EXPR }) },
        { ChildStack: childPath }
      )
    );
    seed(PARENT, parentRecord());
    seed(CHILD, leakyChildRecord());

    const err = await run([PARENT], { dryRun: true, fail: true });

    expect((err as { exitCode?: number }).exitCode).toBe(2);
    const log = logLines.join('\n');
    expect(log).toContain('its Parameters could not be resolved against its own template');
    expect(log).not.toContain(DB_PASSWORD);
  });

  it('refuses the whole stack over a cyclic nested template tree', async () => {
    const childPath = writeTemplate('ChildStack.nested.template.json', {
      Resources: { Again: nestedRow('ChildStack.nested.template.json', {}) },
    } as unknown as CloudFormationTemplate);
    synthStacks.push(
      parentStack(
        { ChildStack: nestedRow(path.basename(childPath), {}) },
        { ChildStack: childPath }
      )
    );
    seed(PARENT, parentRecord({}));

    const err = await run([PARENT]);

    expect((err as { exitCode?: number }).exitCode).toBe(2);
    expect(logLines.join('\n')).toContain('contains a cycle');
    expect(lockCalls).toEqual([]);
  });

  it('points a pattern spelling a child state name at its parent', async () => {
    standardApp();

    const err = await run([CHILD]);

    expect((err as Error).message).toContain(
      `A nested stack is scrubbed with its parent: name ${PARENT} instead`
    );
  });

  it('names the child it writes, and nothing else, in the saved set', async () => {
    standardApp();
    seed(PARENT, parentRecord());
    seed(CHILD, leakyChildRecord());

    await run([PARENT]);

    // The parent's record already held the expression, so only the child moved.
    expect(savedNames()).toEqual([CHILD]);
  });
});
