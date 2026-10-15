/**
 * `cdkd diff --recursive` over a nested child that splits a parent-built
 * `{{resolve:...}}` parameter on a delimiter inside the token text (issue
 * [#4929](https://github.com/go-to-k/cdkd/issues/4929)).
 *
 * The deploy's child holds the PLAINTEXT and splits it, then redacts each
 * piece back to its token, so its state holds `//<user token>`. This command
 * binds the parent's token spelling instead, and its `Fn::Split` cut the token
 * itself (`//{{resolve`): a change on every run, so `--fail` exited 1 on an
 * unchanged tree. It now keeps whole exactly the tokens the parent's REAL pass
 * resolves (the ones its comparison pass left unresolved), and still splits
 * token TEXT the real pass passes through as text (a `Ref` / `Fn::FindInMap`).
 *
 * End to end through `buildDiffTree` with the real resolver. No secret is
 * fetched: the Secrets Manager fake throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('../deployment/_inert-cloudformation-client.js')).withInertCloudFormationClient(
    importOriginal
  )
);

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

const secretSend = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error('cdkd diff must not fetch a secret');
  })
);
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

import { buildDiffTree, treeHasChanges, type DiffTreeNode } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const USER_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:user4929::}}';
const PW_EXPR = '{{resolve:secretsmanager:prod/db/cred:SecretString:pw4929::}}';
const SPELLING = `postgres://${USER_EXPR}:${PW_EXPR}@host`;

/** The issue's two read shapes: a piece (a string leaf) and the list itself. */
const PIECE = (param: string): unknown => ({
  'Fn::Select': [1, { 'Fn::Split': [':', { Ref: param }] }],
});
const LIST = (param: string): unknown => ({ 'Fn::Split': [':', { Ref: param }] });
/** What the deploy's child persists: each piece with its plaintext as the token. */
const PIECE_STORED = `//${USER_EXPR}`;
const LIST_STORED = ['postgres', `//${USER_EXPR}`, `${PW_EXPR}@host`];
/** The same text split AS TEXT, as the real pass splits token text it never resolves. */
const PIECE_AS_TEXT = '//{{resolve';
const LIST_AS_TEXT = SPELLING.split(':');

function res(properties: Record<string, unknown>, resourceType = 'AWS::SSM::Parameter'): ResourceState {
  return { physicalId: 'pid', resourceType, properties, attributes: {}, dependencies: [] };
}

function st(resources: Record<string, ResourceState>, stackName: string): StackState {
  return { stackName, region: 'us-east-1', resources, outputs: {}, version: 6, lastModified: 0 };
}

function backendOf(states: Record<string, StackState>): S3StateBackend {
  return {
    getState: async (stackName: string) => {
      const state = states[stackName];
      return state ? { state, etag: 'e' } : null;
    },
    saveState: vi.fn(),
    putState: vi.fn(),
    deleteState: vi.fn(),
  } as unknown as S3StateBackend;
}

function stackRow(
  path: string,
  parameters: Record<string, unknown>
): CloudFormationTemplate['Resources'][string] {
  return {
    Type: 'AWS::CloudFormation::Stack',
    Metadata: { 'aws:asset:path': path },
    Properties: { Parameters: parameters },
  };
}

describe('cdkd diff --recursive keeps a parent-resolved {{resolve:...}} token whole in a child Fn::Split (#4929)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-diff-4929-'));
    vi.clearAllMocks();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A root whose one nested row hands the child `Conn: <rowValue>`; the child
   * reads it through `reads` into `Leaf.Value`, and its state holds `stored`.
   * The root's stored row equals what the row resolves to, so only the child
   * can diff.
   */
  async function treeOf(args: {
    rowValue: unknown;
    storedRowValue: unknown;
    reads: unknown;
    stored: unknown;
    rootExtra?: Partial<CloudFormationTemplate>;
    childExtra?: Record<string, unknown>;
  }): Promise<DiffTreeNode> {
    const childPath = join(dir, 'child.json');
    writeFileSync(
      childPath,
      JSON.stringify({
        Parameters: { Conn: { Type: 'String' } },
        ...args.childExtra,
        Resources: { Leaf: { Type: 'AWS::SSM::Parameter', Properties: { Value: args.reads } } },
      })
    );
    return buildDiffTree({
      stackName: 'Root',
      displayName: 'Root',
      region: 'us-east-1',
      template: {
        ...args.rootExtra,
        Resources: { Child: stackRow('child.json', { Conn: args.rowValue }) },
      } as CloudFormationTemplate,
      nestedTemplates: { Child: childPath },
      recursive: true,
      stateBackend: backendOf({
        Root: st(
          { Child: res({ Parameters: { Conn: args.storedRowValue } }, 'AWS::CloudFormation::Stack') },
          'Root'
        ),
        'Root~Child': st({ Leaf: res({ Value: args.stored }) }, 'Root~Child'),
      }),
      diffCalculator: new DiffCalculator(),
      isNestedChild: false,
    });
  }

  function leafChange(root: DiffTreeNode): string | undefined {
    return root.children[0]?.changes.get('Leaf')?.changeType;
  }

  describe('a parameter the parent BUILT from tokens (the real pass resolves them)', () => {
    it.each([
      ['a piece', PIECE('Conn'), PIECE_STORED],
      ['the list', LIST('Conn'), LIST_STORED],
    ])('a template literal row value: %s diffs NO_CHANGE', async (_shape, reads, stored) => {
      const root = await treeOf({ rowValue: SPELLING, storedRowValue: SPELLING, reads, stored });
      expect(leafChange(root)).toBe('NO_CHANGE');
      expect(treeHasChanges(root)).toBe(false);
      expect(secretSend).not.toHaveBeenCalled();
    });

    it.each([
      ['a piece', PIECE('Conn'), PIECE_STORED],
      ['the list', LIST('Conn'), LIST_STORED],
    ])('an Fn::Join row value: %s diffs NO_CHANGE', async (_shape, reads, stored) => {
      const root = await treeOf({
        rowValue: { 'Fn::Join': ['', ['postgres://', USER_EXPR, ':', PW_EXPR, '@host']] },
        storedRowValue: SPELLING,
        reads,
        stored,
      });
      expect(leafChange(root)).toBe('NO_CHANGE');
      expect(treeHasChanges(root)).toBe(false);
    });

    it('still detects a genuine change: a child state holding another piece diffs UPDATE', async () => {
      const root = await treeOf({
        rowValue: SPELLING,
        storedRowValue: SPELLING,
        reads: PIECE('Conn'),
        stored: '//someone-else',
      });
      expect(leafChange(root)).toBe('UPDATE');
    });

    it('a cut-token child state (what this command used to compute) is a change, not agreement', async () => {
      const root = await treeOf({
        rowValue: SPELLING,
        storedRowValue: SPELLING,
        reads: PIECE('Conn'),
        stored: PIECE_AS_TEXT,
      });
      expect(leafChange(root)).toBe('UPDATE');
    });
  });

  describe('token TEXT the real pass passes through as text is still split as text', () => {
    const MAPPINGS = { Mappings: { Db: { Conn: { Value: SPELLING } } } };

    it.each([
      ['a piece', PIECE('Conn'), PIECE_AS_TEXT],
      ['the list', LIST('Conn'), LIST_AS_TEXT],
    ])('a parent Fn::FindInMap row value: %s splits the token text', async (_shape, reads, stored) => {
      const root = await treeOf({
        rowValue: { 'Fn::FindInMap': ['Db', 'Conn', 'Value'] },
        storedRowValue: SPELLING,
        reads,
        stored,
        rootExtra: MAPPINGS as Partial<CloudFormationTemplate>,
      });
      expect(leafChange(root)).toBe('NO_CHANGE');
    });

    it('a parent Fn::FindInMap row value: the whole-token state is a change (the token is text there)', async () => {
      const root = await treeOf({
        rowValue: { 'Fn::FindInMap': ['Db', 'Conn', 'Value'] },
        storedRowValue: SPELLING,
        reads: PIECE('Conn'),
        stored: PIECE_STORED,
        rootExtra: MAPPINGS as Partial<CloudFormationTemplate>,
      });
      expect(leafChange(root)).toBe('UPDATE');
    });

    it('a parent Ref to its own parameter spelling a token: the child splits the token text', async () => {
      const root = await treeOf({
        rowValue: { Ref: 'Spelled' },
        storedRowValue: SPELLING,
        reads: PIECE('Conn'),
        stored: PIECE_AS_TEXT,
        rootExtra: {
          Parameters: { Spelled: { Type: 'String', Default: SPELLING } },
        } as Partial<CloudFormationTemplate>,
      });
      expect(leafChange(root)).toBe('NO_CHANGE');
    });

    it("a child Fn::FindInMap spelling another token is split as text even beside a parent-resolved one", async () => {
      const OTHER = '{{resolve:secretsmanager:other/cred:SecretString:k4929::}}';
      const root = await treeOf({
        rowValue: SPELLING,
        storedRowValue: SPELLING,
        reads: {
          'Fn::Select': [
            1,
            { 'Fn::Split': [':', { 'Fn::FindInMap': ['Local', 'Conn', 'Value'] }] },
          ],
        },
        stored: '//{{resolve',
        childExtra: { Mappings: { Local: { Conn: { Value: `postgres://${OTHER}@h` } } } },
      });
      expect(leafChange(root)).toBe('NO_CHANGE');
    });
  });

  describe('a grandchild inherits the provenance through a Ref', () => {
    /** `storedInner` is what the middle's state holds for the row's `Inner`. */
    async function threeLevels(
      middleRow: unknown,
      storedInner: unknown,
      grandchildReads: unknown,
      stored: unknown,
      root: { row: unknown; extra?: Partial<CloudFormationTemplate> } = { row: SPELLING }
    ) {
      const middlePath = join(dir, 'middle.json');
      const leafPath = join(dir, 'leaf.json');
      writeFileSync(
        leafPath,
        JSON.stringify({
          Parameters: { Inner: { Type: 'String' } },
          Resources: { Leaf: { Type: 'AWS::SSM::Parameter', Properties: { Value: grandchildReads } } },
        })
      );
      writeFileSync(
        middlePath,
        JSON.stringify({
          Parameters: { Conn: { Type: 'String' } },
          Resources: { Grand: stackRow('leaf.json', { Inner: middleRow }) },
        })
      );
      return buildDiffTree({
        stackName: 'Root',
        displayName: 'Root',
        region: 'us-east-1',
        template: {
          ...root.extra,
          Resources: { Middle: stackRow('middle.json', { Conn: root.row }) },
        } as CloudFormationTemplate,
        nestedTemplates: { Middle: middlePath, Grand: leafPath },
        recursive: true,
        stateBackend: backendOf({
          Root: st(
            { Middle: res({ Parameters: { Conn: SPELLING } }, 'AWS::CloudFormation::Stack') },
            'Root'
          ),
          'Root~Middle': st(
            {
              Grand: res(
                { Parameters: { Inner: storedInner } },
                'AWS::CloudFormation::Stack'
              ),
            },
            'Root~Middle'
          ),
          'Root~Middle~Grand': st({ Leaf: res({ Value: stored }) }, 'Root~Middle~Grand'),
        }),
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
    }

    it("a middle row passing the parameter on by Ref: the grandchild's split keeps the token whole", async () => {
      const root = await threeLevels({ Ref: 'Conn' }, SPELLING, PIECE('Inner'), PIECE_STORED);
      const grand = root.children[0]?.children[0];
      expect(grand?.changes.get('Leaf')?.changeType).toBe('NO_CHANGE');
      expect(treeHasChanges(root)).toBe(false);
    });

    it("a middle row splitting the parameter itself: the middle's split keeps the token whole", async () => {
      const root = await threeLevels(PIECE('Conn'), PIECE_STORED, { Ref: 'Inner' }, PIECE_STORED);
      const grand = root.children[0]?.children[0];
      expect(root.children[0]?.changes.get('Grand')?.changeType).toBe('NO_CHANGE');
      expect(grand?.changes.get('Leaf')?.changeType).toBe('NO_CHANGE');
      expect(treeHasChanges(root)).toBe(false);
    });

    it('an inherited spelling passed on by a Ref to a DIFFERENT parameter, one holding it as text, is split as text', async () => {
      // The root resolves `Conn`'s tokens (literal) and hands `Mapped` the same
      // spelling as text (`Fn::FindInMap`); the middle forwards only `Mapped`.
      // The deploy's middle reads no secret-fed parameter for that row, so no
      // pair reaches the grandchild, and its split cuts the text.
      const middlePath = join(dir, 'middle.json');
      const leafPath = join(dir, 'leaf.json');
      writeFileSync(
        leafPath,
        JSON.stringify({
          Parameters: { Inner: { Type: 'String' } },
          Resources: {
            Leaf: { Type: 'AWS::SSM::Parameter', Properties: { Value: PIECE('Inner') } },
          },
        })
      );
      writeFileSync(
        middlePath,
        JSON.stringify({
          Parameters: { Conn: { Type: 'String' }, Mapped: { Type: 'String' } },
          Resources: { Grand: stackRow('leaf.json', { Inner: { Ref: 'Mapped' } }) },
        })
      );
      const treeWith = (stored: unknown): Promise<DiffTreeNode> =>
        buildDiffTree({
          stackName: 'Root',
          displayName: 'Root',
          region: 'us-east-1',
          template: {
            Mappings: { Db: { Conn: { Value: SPELLING } } },
            Resources: {
              Middle: stackRow('middle.json', {
                Conn: SPELLING,
                Mapped: { 'Fn::FindInMap': ['Db', 'Conn', 'Value'] },
              }),
            },
          } as unknown as CloudFormationTemplate,
          nestedTemplates: { Middle: middlePath, Grand: leafPath },
          recursive: true,
          stateBackend: backendOf({
            Root: st(
              {
                Middle: res(
                  { Parameters: { Conn: SPELLING, Mapped: SPELLING } },
                  'AWS::CloudFormation::Stack'
                ),
              },
              'Root'
            ),
            'Root~Middle': st(
              { Grand: res({ Parameters: { Inner: SPELLING } }, 'AWS::CloudFormation::Stack') },
              'Root~Middle'
            ),
            'Root~Middle~Grand': st({ Leaf: res({ Value: stored }) }, 'Root~Middle~Grand'),
          }),
          diffCalculator: new DiffCalculator(),
          isNestedChild: false,
        });
      const asText = await treeWith(PIECE_AS_TEXT);
      expect(asText.children[0]?.children[0]?.changes.get('Leaf')?.changeType).toBe('NO_CHANGE');
      const whole = await treeWith(PIECE_STORED);
      expect(whole.children[0]?.children[0]?.changes.get('Leaf')?.changeType).toBe('UPDATE');
    });

    it('token TEXT the root hands down (Fn::FindInMap) stays text through a middle Ref: the grandchild splits it', async () => {
      const fromMap = {
        row: { 'Fn::FindInMap': ['Db', 'Conn', 'Value'] },
        extra: { Mappings: { Db: { Conn: { Value: SPELLING } } } } as Partial<CloudFormationTemplate>,
      };
      const asText = await threeLevels({ Ref: 'Conn' }, SPELLING, PIECE('Inner'), PIECE_AS_TEXT, fromMap);
      expect(asText.children[0]?.children[0]?.changes.get('Leaf')?.changeType).toBe('NO_CHANGE');
      const whole = await threeLevels({ Ref: 'Conn' }, SPELLING, PIECE('Inner'), PIECE_STORED, fromMap);
      expect(whole.children[0]?.children[0]?.changes.get('Leaf')?.changeType).toBe('UPDATE');
    });
  });
});
