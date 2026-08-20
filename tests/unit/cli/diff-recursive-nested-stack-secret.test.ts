/**
 * `cdkd diff --recursive` over a nested stack whose input `Parameters` carry a
 * SECRET dynamic reference (issue
 * [#1903](https://github.com/go-to-k/cdkd/issues/1903)).
 *
 * `resolveChildStackParameters` used to build its resolver context with neither
 * `skipDynamicReferences` nor `recordedSecretValues`, so the diff DECRYPTED the
 * reference at plan time and printed the plaintext in the child's diff.
 *
 * The two halves of the issue are COUPLED, and this file is where that shows:
 * the flag is only correct because the deploy half now persists the
 * `{{resolve:...}}` EXPRESSION into the child's state. Both directions are
 * asserted — the freshly-deployed tree must report NO_CHANGE (the spurious
 * perpetual change the issue warns about), and a genuine change must still be
 * detected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

/**
 * Any live secret fetch is a FAILURE of this file's premise, so the fake throws
 * rather than returning a value: a test that starts decrypting must go red, not
 * quietly assert against a plaintext.
 */
const secretSend = vi.hoisted(() => vi.fn());
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return {
    ...actual,
    SecretsManagerClient: vi.fn().mockImplementation(() => ({
      send: secretSend,
      config: { region: () => Promise.resolve('us-east-1') },
      destroy: () => undefined,
    })),
  };
});

import {
  buildDiffTree,
  nodeHasChanges,
  treeHasChanges,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const NESTED = 'AWS::CloudFormation::Stack';
const PARAM = 'referencetoParentDbPassword';
const SECRET_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:password::}}';
const SECRET_PLAINTEXT = 'diff-recursive-plaintext-1903';

function res(resourceType: string, properties: Record<string, unknown>): ResourceState {
  return { physicalId: 'pid', resourceType, properties, attributes: {}, dependencies: [] };
}

function st(stackName: string, resources: Record<string, ResourceState>): StackState {
  return { stackName, region: 'us-east-1', resources, outputs: {}, version: 6, lastModified: 0 };
}

function fakeBackend(states: Record<string, StackState>): S3StateBackend {
  return {
    getState: async (stackName: string) => {
      const state = states[stackName];
      return state ? { state, etag: 'fake' } : null;
    },
  } as unknown as S3StateBackend;
}

describe('diff --recursive: a secret-bearing nested-stack Parameter (#1903)', () => {
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    secretSend.mockImplementation(() => {
      throw new Error('cdkd diff must not fetch a secret value at plan time');
    });
    dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-secret-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Child consumes the down-passed parameter; no `{{resolve:` in its own template. */
  function writeChildTemplate(): string {
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { [PARAM]: { Type: 'String' } },
        Resources: {
          ChildRes: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Type: 'String', Value: { Ref: PARAM } },
          },
        },
      })
    );
    return childPath;
  }

  /** Parent hands the secret DOWN through the nested row's `Parameters` block. */
  function parentTemplate(): CloudFormationTemplate {
    return {
      Resources: {
        Child: {
          Type: NESTED,
          Metadata: { 'aws:asset:path': 'child.json' },
          Properties: { Parameters: { [PARAM]: SECRET_EXPR } },
        },
      },
    };
  }

  /**
   * A freshly-deployed tree under the POST-fix persist shape: both the parent's
   * nested row and the child's resource hold the EXPRESSION, never the value.
   */
  function freshStates(): Record<string, StackState> {
    return {
      Parent: st('Parent', { Child: res(NESTED, { Parameters: { [PARAM]: SECRET_EXPR } }) }),
      'Parent~Child': st('Parent~Child', {
        ChildRes: res('AWS::SSM::Parameter', { Type: 'String', Value: SECRET_EXPR }),
      }),
    };
  }

  async function diff(states: Record<string, StackState>) {
    return await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: parentTemplate(),
      nestedTemplates: { Child: writeChildTemplate() },
      recursive: true,
      stateBackend: fakeBackend(states),
      diffCalculator: new DiffCalculator(),
    });
  }

  it('reports NO_CHANGE on a freshly-deployed tree and never fetches the secret', async () => {
    const root = await diff(freshStates());

    expect(root.changes.get('Child')!.changeType).toBe('NO_CHANGE');
    const child = root.children[0]!;
    expect(child.stackName).toBe('Parent~Child');
    // The crux: the child's down-passed SECRET parameter must not surface as a
    // spurious change. Before the fix the desired side decrypted to plaintext
    // while state held the expression, so this was a permanent UPDATE.
    expect(child.changes.get('ChildRes')!.changeType).toBe('NO_CHANGE');
    expect(nodeHasChanges(child)).toBe(false);
    expect(treeHasChanges(root)).toBe(false);
    // ...and no live GetSecretValue was issued at plan time.
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('never puts the plaintext into the rendered child diff', async () => {
    // The DISCLOSURE half of the issue, stated independently of the change
    // classification: even if a future refactor made the comparison agree some
    // other way, the plaintext must not be in the diff's data.
    const root = await diff(freshStates());
    expect(JSON.stringify(root)).not.toContain(SECRET_PLAINTEXT);
    expect(JSON.stringify(root)).not.toContain('GetSecretValue');
  });

  it('still detects a genuine change to the down-passed reference', async () => {
    // Regression guard: a CHANGED expression (a different secret / a different
    // JSON key) is a real change and must still diff. `skipDynamicReferences`
    // compares expressions, so this is exactly what it can still see.
    const states = freshStates();
    states['Parent~Child']!.resources['ChildRes']!.properties['Value'] =
      '{{resolve:secretsmanager:prod/db/cred:SecretString:OLD_KEY::}}';

    const root = await diff(states);

    const child = root.children[0]!;
    expect(child.changes.get('ChildRes')!.changeType).toBe('UPDATE');
    expect(treeHasChanges(root)).toBe(true);
    expect(secretSend).not.toHaveBeenCalled();
  });

  it('still resolves a NON-secret down-passed parameter (scope control)', async () => {
    // The flag must not stop ordinary literal / intrinsic parameters from
    // resolving, or every nested child would report spurious drift instead.
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { Plain: { Type: 'String' } },
        Resources: {
          ChildRes: {
            Type: 'AWS::SSM::Parameter',
            Properties: { Type: 'String', Value: { 'Fn::Join': ['', ['prefix:', { Ref: 'Plain' }]] } },
          },
        },
      })
    );
    const root = await buildDiffTree({
      stackName: 'Parent',
      displayName: 'Parent',
      region: 'us-east-1',
      template: {
        Resources: {
          Child: {
            Type: NESTED,
            Metadata: { 'aws:asset:path': 'child.json' },
            Properties: { Parameters: { Plain: 'public-value' } },
          },
        },
      },
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: fakeBackend({
        Parent: st('Parent', { Child: res(NESTED, { Parameters: { Plain: 'public-value' } }) }),
        'Parent~Child': st('Parent~Child', {
          ChildRes: res('AWS::SSM::Parameter', { Type: 'String', Value: 'prefix:public-value' }),
        }),
      }),
      diffCalculator: new DiffCalculator(),
    });

    expect(root.children[0]!.changes.get('ChildRes')!.changeType).toBe('NO_CHANGE');
    expect(treeHasChanges(root)).toBe(false);
  });
});
