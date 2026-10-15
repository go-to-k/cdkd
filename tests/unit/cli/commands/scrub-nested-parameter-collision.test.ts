/**
 * `cdkd scrub` of a nested child withdraws a literal-spelled parameter's #4644
 * spelling exactly where the deploy does (issue
 * [#4731](https://github.com/go-to-k/cdkd/issues/4731)): when one child
 * resource reads it beside a same-plaintext sibling. Otherwise scrub would
 * rewrite the child's records with the literal's tokens while the next deploy
 * diffs against the survivor.
 *
 * Drives the REAL resolver through `scrubStack`'s nested-child entry and reads
 * the withdrawal off the very bag scrub was handed. The control (the two reads
 * in DIFFERENT resources) keeps the spelling, so the case reads the call.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';
import {
  recordNestedStackParameterExpressions,
  recordResolvedPair,
  redactInheritedParameterValue,
  redactSecretsForState,
  type RecordedSecretValues,
} from '../../../../src/deployment/secret-redaction.js';

vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

import { scrubStack } from '../../../../src/cli/commands/scrub.js';

const EXPR_A = '{{resolve:secretsmanager:prod/db/cred:SecretString:scrub4731::}}';
const EXPR_B = '{{resolve:secretsmanager:prod/db/cred:SecretString:scrub4731:AWSCURRENT:}}';
const SHARED = 'sh4red-scrub-4731';
const SPELLING = `postgres://plainuser:${EXPR_A}@host`;
const CONN = `postgres://plainuser:${SHARED}@host`;

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function parentRow(): RecordedSecretValues {
  const parent: RecordedSecretValues = new Map();
  for (const expression of [EXPR_A, EXPR_B]) {
    parent.set(SHARED, expression);
    recordResolvedPair(parent, expression, SHARED);
  }
  recordNestedStackParameterExpressions(
    parent,
    'AWS::CloudFormation::Stack',
    { Parameters: { ConnA: CONN, SecretB: SHARED } },
    { Parameters: { ConnA: SPELLING, SecretB: EXPR_B } }
  );
  return parent;
}

describe('cdkd scrub of a nested child withdraws a colliding literal spelling (#4731)', () => {
  for (const mixed of [true, false]) {
    it(`${mixed ? 'withdraws' : 'keeps'} it when ${mixed ? 'one resource reads both parameters' : 'the reads are in different resources'}`, async () => {
      const parent = parentRow();
      expect(redactInheritedParameterValue(parent, 'ConnA', CONN)).toBe(SPELLING);
      // ConnA resolves LAST, so without the withdrawal its token takes the slot.
      const selA = { 'Fn::Select': [0, [{ Ref: 'ConnA' }]] };
      // An `Fn::Base64` in the list is no re-read (the persist arm evaluates
      // `Ref` / `Fn::Select` / `Fn::Split` / `Fn::Join` / `Fn::Sub` / `Fn::If`
      // only, #4731 / #4919), so the slot answers it and the withdrawal still
      // applies.
      const selB = { 'Fn::Select': [0, [{ Ref: 'SecretB' }, { 'Fn::Base64': 'x' }]] };
      const template = {
        Parameters: { ConnA: { Type: 'String' }, SecretB: { Type: 'String' } },
        Resources: mixed
          ? { R: { Type: 'AWS::SSM::Parameter', Properties: { Description: selB, Value: selA } } }
          : {
              R: { Type: 'AWS::SSM::Parameter', Properties: { Value: selA } },
              S: { Type: 'AWS::SSM::Parameter', Properties: { Value: selB } },
            },
        Outputs: {},
      } as unknown as CloudFormationTemplate;
      const state: StackState = {
        version: 9,
        region: 'us-east-1',
        stackName: 'MyStack~Child',
        resources: {
          R: {
            physicalId: 'r',
            resourceType: 'AWS::SSM::Parameter',
            properties: mixed ? { Value: CONN, Description: SHARED } : { Value: CONN },
            attributes: {},
            dependencies: [],
          },
          ...(mixed
            ? {}
            : {
                S: {
                  physicalId: 's',
                  resourceType: 'AWS::SSM::Parameter',
                  properties: { Value: SHARED },
                  attributes: {},
                  dependencies: [],
                },
              }),
        },
        outputs: {},
        lastModified: 0,
      } as StackState;
      const saveState = vi.fn().mockResolvedValue('etag-2');
      await scrubStack(
        { stackName: 'MyStack~Child', template } as never,
        'us-east-1',
        {
          getState: vi.fn().mockResolvedValue({ state, etag: 'etag-1' }),
          saveState,
          purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
          listStacks: vi.fn().mockResolvedValue([]),
        } as never,
        {
          acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
          releaseLock: vi.fn().mockResolvedValue(undefined),
        } as never,
        {
          dryRun: false,
          logger,
          nestedChild: {
            logicalId: 'Child',
            stackName: 'MyStack~Child',
            input: { parameters: { ConnA: CONN, SecretB: SHARED }, inheritedSecrets: parent },
          },
        } as never
      );
      expect(redactInheritedParameterValue(parent, 'ConnA', CONN)).toBe(
        mixed ? redactSecretsForState(CONN, parent) : SPELLING
      );
      expect(redactSecretsForState(CONN, parent)).not.toBe(SPELLING);
      // What scrub REWROTE: the withdrawal precedes resource resolution.
      const saved = saveState.mock.calls.at(-1)![2] as StackState;
      expect(saved.resources['R']!.properties).toEqual(
        mixed
          ? { Value: `postgres://plainuser:${EXPR_B}@host`, Description: EXPR_B }
          : { Value: SPELLING }
      );
    });
  }
});

describe('cdkd scrub positions an Fn::If by the branch its resolution took (#4954)', () => {
  // The branches resolve to one plaintext spelled two ways: SecretB's token,
  // or the piece of ConnA's literal. Only the recorded branch tells them apart.
  const piece = {
    'Fn::Select': [0, { 'Fn::Split': ['@', { 'Fn::Select': [2, { 'Fn::Split': [':', { Ref: 'ConnA' }] }] }] }],
  };
  // `siblingLast` reads SecretB after the `Fn::If`, so the slot holds its
  // token and only the recorded branch answers the ConnA piece.
  for (const taken of [true, false]) {
    for (const siblingLast of [true, false]) {
    it(`keeps ConnA's spelling and writes the ${taken ? 'SecretB' : 'ConnA piece'} token (${siblingLast ? 'sibling' : 'literal'} read last)`, async () => {
      const parent = parentRow();
      const template = {
        Parameters: { ConnA: { Type: 'String' }, SecretB: { Type: 'String' } },
        Conditions: { C: { 'Fn::Equals': ['a', taken ? 'a' : 'b'] } },
        Resources: {
          R: {
            Type: 'AWS::SSM::Parameter',
            Properties: siblingLast
              ? { Value: { Ref: 'ConnA' }, Description: { 'Fn::If': ['C', { Ref: 'SecretB' }, piece] }, Name: { Ref: 'SecretB' } }
              : { Name: { Ref: 'SecretB' }, Description: { 'Fn::If': ['C', { Ref: 'SecretB' }, piece] }, Value: { Ref: 'ConnA' } },
          },
        },
        Outputs: {},
      } as unknown as CloudFormationTemplate;
      const state: StackState = {
        version: 9,
        region: 'us-east-1',
        stackName: 'MyStack~Child',
        resources: {
          R: {
            physicalId: 'r',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Value: CONN, Description: SHARED, Name: SHARED },
            attributes: {},
            dependencies: [],
          },
        },
        outputs: {},
        lastModified: 0,
      } as StackState;
      const saveState = vi.fn().mockResolvedValue('etag-2');
      await scrubStack(
        { stackName: 'MyStack~Child', template } as never,
        'us-east-1',
        {
          getState: vi.fn().mockResolvedValue({ state, etag: 'etag-1' }),
          saveState,
          purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
          listStacks: vi.fn().mockResolvedValue([]),
        } as never,
        {
          acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
          releaseLock: vi.fn().mockResolvedValue(undefined),
        } as never,
        {
          dryRun: false,
          logger,
          nestedChild: {
            logicalId: 'Child',
            stackName: 'MyStack~Child',
            input: { parameters: { ConnA: CONN, SecretB: SHARED }, inheritedSecrets: parent },
          },
        } as never
      );
      expect(redactInheritedParameterValue(parent, 'ConnA', CONN)).toBe(SPELLING);
      const saved = saveState.mock.calls.at(-1)![2] as StackState;
      expect(saved.resources['R']!.properties).toEqual({
        Value: SPELLING,
        Description: taken ? EXPR_B : EXPR_A,
        Name: EXPR_B,
      });
    });
    }
  }
});

describe('cdkd scrub re-reads a leaf naming a pseudo parameter the child resolver records (#4962)', () => {
  // `AWS::Region` is bound from the region scrub's resolver answers, as the
  // deploy binds it; `AWS::StackName` is never bound, so it still withdraws.
  for (const pseudo of ['AWS::Region', 'AWS::StackName']) {
    for (const siblingLast of [true, false]) {
      it(`${pseudo === 'AWS::Region' ? 'keeps' : 'withdraws'} ConnA's spelling for an Fn::Sub naming ${pseudo} (${siblingLast ? 'sibling' : 'literal'} read last)`, async () => {
        const parent = parentRow();
        const leaf = { 'Fn::Select': [0, [{ 'Fn::Sub': `\${ConnA}-\${${pseudo}}` }]] };
        const suffix = pseudo === 'AWS::Region' ? 'us-east-1' : 'MyStack~Child';
        const template = {
          Parameters: { ConnA: { Type: 'String' }, SecretB: { Type: 'String' } },
          Resources: {
            R: {
              Type: 'AWS::SSM::Parameter',
              Properties: siblingLast
                ? { Value: { Ref: 'ConnA' }, Description: leaf, Name: { Ref: 'SecretB' } }
                : { Name: { Ref: 'SecretB' }, Description: leaf, Value: { Ref: 'ConnA' } },
            },
          },
          Outputs: {},
        } as unknown as CloudFormationTemplate;
        const state: StackState = {
          version: 9,
          region: 'us-east-1',
          stackName: 'MyStack~Child',
          resources: {
            R: {
              physicalId: 'r',
              resourceType: 'AWS::SSM::Parameter',
              properties: { Value: CONN, Description: `${CONN}-${suffix}`, Name: SHARED },
              attributes: {},
              dependencies: [],
            },
          },
          outputs: {},
          lastModified: 0,
        } as StackState;
        const saveState = vi.fn().mockResolvedValue('etag-2');
        await scrubStack(
          { stackName: 'MyStack~Child', template } as never,
          'us-east-1',
          {
            getState: vi.fn().mockResolvedValue({ state, etag: 'etag-1' }),
            saveState,
            purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
            listStacks: vi.fn().mockResolvedValue([]),
          } as never,
          {
            acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
            releaseLock: vi.fn().mockResolvedValue(undefined),
          } as never,
          {
            dryRun: false,
            logger,
            nestedChild: {
              logicalId: 'Child',
              stackName: 'MyStack~Child',
              input: { parameters: { ConnA: CONN, SecretB: SHARED }, inheritedSecrets: parent },
            },
          } as never
        );
        const saved = saveState.mock.calls.at(-1)![2] as StackState;
        const props = saved.resources['R']!.properties as Record<string, unknown>;
        expect(JSON.stringify(props)).not.toContain(SHARED);
        if (pseudo === 'AWS::Region') {
          expect(redactInheritedParameterValue(parent, 'ConnA', CONN)).toBe(SPELLING);
          expect(props).toEqual({ Value: SPELLING, Description: `${SPELLING}-us-east-1`, Name: EXPR_B });
        } else {
          // The pre-#4644 answer: ConnA reads the parent map's survivor.
          const survivor = `postgres://plainuser:${EXPR_B}@host`;
          expect(redactInheritedParameterValue(parent, 'ConnA', CONN)).toBe(survivor);
          // Every leaf reading ConnA, the bare `Ref` too, persists the survivor.
          expect(props).toEqual({
            Value: survivor,
            Description: `${survivor}-MyStack~Child`,
            Name: EXPR_B,
          });
        }
      });
    }
  }
});
