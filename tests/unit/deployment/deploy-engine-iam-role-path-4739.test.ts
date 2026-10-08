/**
 * go-to-k/cdkd#4739: an `AWS::IAM::Role` `Path` change is createOnly, so a
 * deploy must REPLACE the role through the engine's create-first replacement
 * and its guards. The registry classified `Path` as updateable, so the engine
 * called the provider's `update()`, whose own re-create asked for the name the
 * live role still holds and failed `EntityAlreadyExists` with none of the
 * name-collision refusal's guidance.
 *
 * Driven through `DeployEngine.deploy` with the REAL `DiffCalculator` (and so
 * the real replacement registry), `DagBuilder` and `IntrinsicFunctionResolver`;
 * only the providers are doubles.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';
import { awsSdkError } from '../_aws-sdk-error.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const renderer = {
  isActive: () => false,
  start: () => false,
  stop: vi.fn(),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  updateTaskLabel: vi.fn(),
  printAbove: (write: () => void) => write(),
};
vi.mock('../../../src/utils/live-renderer.js', () => ({ getLiveRenderer: () => renderer }));

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('./_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const STACK = 'IamPathStack';
const REGION = 'us-east-1';
const ACCOUNT = '123456789012';
const ROLE = 'AWS::IAM::Role';
const FN = 'AWS::Lambda::Function';
const TRUST = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }],
};
/** The name cdkd derives for a role the template does not name. */
const GENERATED = `${STACK}-Role`;
const arnOf = (path: string, name: string): string =>
  `arn:aws:iam::${ACCOUNT}:role${path}${name}`;
/**
 * The name the role provider sends: the stack-prefixed template name (the
 * default user-supplied-name prefix), or the generated one.
 */
const sentName = (props: Record<string, unknown>): string =>
  typeof props['RoleName'] === 'string' ? `${STACK}-${props['RoleName']}` : GENERATED;

type Provider = Record<'create' | 'update' | 'delete' | 'getAttribute', ReturnType<typeof vi.fn>>;

describe('DeployEngine - an IAM role Path change replaces the role (go-to-k/cdkd#4739)', () => {
  let sdk: Provider;
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  /** The role names IAM holds: CreateRole is refused for one of them. */
  let held: Set<string>;
  let calls: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    held = new Set();
    calls = [];
    sdk = {
      // A double of IAM's own uniqueness rule: a role name is taken whatever
      // its path, and the role comes back under the path it was created with.
      create: vi.fn((logicalId: string, _type: string, props: Record<string, unknown>) => {
        calls.push(`create ${logicalId}`);
        if (logicalId !== 'Role') return Promise.resolve({ physicalId: `${logicalId}-new`, attributes: {} });
        const name = sentName(props);
        if (held.has(name)) {
          return Promise.reject(
            awsSdkError(`Role with name ${name} already exists.`, 'EntityAlreadyExistsException')
          );
        }
        held.add(name);
        const path = typeof props['Path'] === 'string' ? props['Path'] : '/';
        return Promise.resolve({
          physicalId: name,
          attributes: { Arn: arnOf(path, name), RoleId: 'AROANEW' },
        });
      }),
      update: vi.fn((logicalId: string, physicalId: string) => {
        calls.push(`update ${logicalId}`);
        return Promise.resolve({ physicalId, wasReplaced: false });
      }),
      delete: vi.fn((logicalId: string, physicalId: string) => {
        calls.push(`delete ${logicalId}`);
        held.delete(physicalId);
        return Promise.resolve(undefined);
      }),
      getAttribute: vi.fn(),
    };
    stateBackend = {
      getState: vi.fn(),
      saveState: vi.fn().mockResolvedValue('etag-new'),
    };
  });

  function makeEngine(options: Record<string, unknown> = {}): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn().mockResolvedValue(undefined),
      } as never,
      new DagBuilder(),
      new DiffCalculator(),
      {
        getProvider: vi.fn().mockReturnValue(sdk),
        getProviderFor: vi.fn().mockReturnValue({ provider: sdk, provisionedBy: 'sdk' as const }),
        getRegisteredTypes: vi.fn().mockReturnValue([]),
        validateResourceTypes: vi.fn(),
        validateResourceProperties: vi.fn(),
        ccRouteUnavailableReason: vi.fn().mockReturnValue(undefined),
      } as never,
      { dryRun: false, ...options } as never,
      REGION,
      {
        updateForStack: vi.fn().mockResolvedValue(undefined),
        lookup: vi.fn().mockResolvedValue(null),
        patchEntry: vi.fn().mockResolvedValue(undefined),
      } as never
    );
  }

  /**
   * Deploy a role recorded with `recordedRole` and templated with
   * `templatedRole`, beside a function whose `Role` reads the role's ARN.
   */
  async function deploy(
    recordedRole: Record<string, unknown>,
    templatedRole: Record<string, unknown>,
    options: Record<string, unknown> = {}
  ): Promise<Error | undefined> {
    const name = sentName(recordedRole);
    const recordedPath = typeof recordedRole['Path'] === 'string' ? recordedRole['Path'] : '/';
    held.add(name);
    const oldArn = arnOf(recordedPath, name);
    const fnProps = { Handler: 'index.handler', Runtime: 'nodejs20.x' };
    const state: StackState = {
      version: STATE_SCHEMA_VERSION_CURRENT,
      region: REGION,
      stackName: STACK,
      resources: {
        Role: {
          physicalId: name,
          resourceType: ROLE,
          properties: recordedRole,
          observedProperties: recordedRole,
          attributes: { Arn: oldArn, RoleId: 'AROAOLD' },
          dependencies: [],
          provisionedBy: 'sdk',
        } as ResourceState,
        Fn: {
          physicalId: 'fn-1',
          resourceType: FN,
          properties: { ...fnProps, Role: oldArn },
          observedProperties: { ...fnProps, Role: oldArn },
          attributes: {},
          dependencies: ['Role'],
          provisionedBy: 'sdk',
        } as ResourceState,
      },
      outputs: {},
      lastModified: 0,
    };
    stateBackend.getState.mockResolvedValue({ state, etag: 'etag-old' });
    const template: CloudFormationTemplate = {
      Resources: {
        Role: { Type: ROLE, Properties: templatedRole },
        Fn: { Type: FN, Properties: { ...fnProps, Role: { 'Fn::GetAtt': ['Role', 'Arn'] } } },
      },
    };
    return makeEngine(options)
      .deploy(STACK, template)
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
  }

  const callsFor = (fn: ReturnType<typeof vi.fn>, id: string): unknown[][] =>
    fn.mock.calls.filter((c) => c[0] === id);

  /** Every message on the error's `cause` chain, joined. */
  function chainText(error: unknown): string {
    const parts: string[] = [];
    let cur: unknown = error;
    for (let depth = 0; cur instanceof Error && depth < 10; depth++) {
      parts.push(cur.message);
      cur = (cur as { cause?: unknown }).cause;
    }
    return parts.join('\n');
  }

  function savedRole(): ResourceState | undefined {
    const saves = stateBackend.saveState.mock.calls;
    return (saves[saves.length - 1]?.[2] as StackState | undefined)?.resources['Role'];
  }

  describe('a role the template does not name (cdkd-generated, deterministic name)', () => {
    it('is refused through the replacement guard, never handed to the provider update', async () => {
      const err = await deploy(
        { AssumeRolePolicyDocument: TRUST },
        { AssumeRolePolicyDocument: TRUST, Path: '/service/' }
      );

      expect(err).toBeDefined();
      // The bug: the change went to the provider's in-place update.
      expect(callsFor(sdk.update, 'Role')).toHaveLength(0);
      // Create-first asked for the generated name the live role holds...
      expect(callsFor(sdk.create, 'Role')).toHaveLength(1);
      expect((callsFor(sdk.create, 'Role')[0]![2] as Record<string, unknown>)['Path']).toBe(
        '/service/'
      );
      // ...and the refusal deletes nothing and names the name's origin and the way through.
      expect(callsFor(sdk.delete, 'Role')).toHaveLength(0);
      const text = chainText(err);
      expect(text).toMatch(/GENERATED by cdkd/);
      expect(text).toMatch(/cdkd deploy --replace/);
      expect(callsFor(sdk.update, 'Fn')).toHaveLength(0);
    });

    it('under --replace deletes the old role first, re-creates it on the new path, and re-points the function', async () => {
      const err = await deploy(
        { AssumeRolePolicyDocument: TRUST },
        { AssumeRolePolicyDocument: TRUST, Path: '/service/' },
        { replace: true }
      );

      expect(err).toBeUndefined();
      expect(callsFor(sdk.update, 'Role')).toHaveLength(0);
      expect(calls.filter((c) => c.endsWith(' Role'))).toEqual([
        'create Role',
        'delete Role',
        'create Role',
      ]);
      expect(callsFor(sdk.delete, 'Role')[0]![1]).toBe(GENERATED);
      const newArn = arnOf('/service/', GENERATED);
      expect(savedRole()?.attributes?.['Arn']).toBe(newArn);
      // The ARN carries the path, so the function reading it is updated after the role.
      const fnUpdates = callsFor(sdk.update, 'Fn');
      expect(fnUpdates).toHaveLength(1);
      expect((fnUpdates[0]![3] as Record<string, unknown>)['Role']).toBe(newArn);
      expect(calls.indexOf('update Fn')).toBeGreaterThan(calls.lastIndexOf('create Role'));
    });
  });

  describe('a role the template names (RoleName)', () => {
    it('is refused with the user-supplied-name guidance, deleting nothing', async () => {
      const err = await deploy(
        { RoleName: 'my-role', AssumeRolePolicyDocument: TRUST, Path: '/a/' },
        { RoleName: 'my-role', AssumeRolePolicyDocument: TRUST, Path: '/b/' }
      );

      expect(err).toBeDefined();
      expect(callsFor(sdk.update, 'Role')).toHaveLength(0);
      expect(callsFor(sdk.create, 'Role')).toHaveLength(1);
      expect(callsFor(sdk.delete, 'Role')).toHaveLength(0);
      const text = chainText(err);
      expect(text).toContain(`user-supplied physical name (${STACK}-my-role)`);
      expect(text).toMatch(/cdkd deploy --replace/);
    });

    it('under --replace is re-created under its name on the new path', async () => {
      const err = await deploy(
        { RoleName: 'my-role', AssumeRolePolicyDocument: TRUST, Path: '/a/' },
        { RoleName: 'my-role', AssumeRolePolicyDocument: TRUST, Path: '/b/' },
        { replace: true }
      );

      expect(err).toBeUndefined();
      expect(callsFor(sdk.update, 'Role')).toHaveLength(0);
      expect(calls.filter((c) => c.endsWith(' Role'))).toEqual([
        'create Role',
        'delete Role',
        'create Role',
      ]);
      const newArn = arnOf('/b/', `${STACK}-my-role`);
      expect(savedRole()?.attributes?.['Arn']).toBe(newArn);
      expect((callsFor(sdk.update, 'Fn')[0]![3] as Record<string, unknown>)['Role']).toBe(newArn);
    });
  });

  describe('what stays in place', () => {
    it('an unchanged non-default Path beside another change is an in-place update', async () => {
      const err = await deploy(
        { AssumeRolePolicyDocument: TRUST, Path: '/service/', Description: 'v1' },
        { AssumeRolePolicyDocument: TRUST, Path: '/service/', Description: 'v2' }
      );

      expect(err).toBeUndefined();
      expect(callsFor(sdk.update, 'Role')).toHaveLength(1);
      expect(callsFor(sdk.create, 'Role')).toHaveLength(0);
      expect(callsFor(sdk.delete, 'Role')).toHaveLength(0);
    });

    it('an explicit default Path removed from the template replaces nothing', async () => {
      const err = await deploy(
        { AssumeRolePolicyDocument: TRUST, Path: '/' },
        { AssumeRolePolicyDocument: TRUST }
      );

      expect(err).toBeUndefined();
      expect(callsFor(sdk.create, 'Role')).toHaveLength(0);
      expect(callsFor(sdk.delete, 'Role')).toHaveLength(0);
    });
  });
});
