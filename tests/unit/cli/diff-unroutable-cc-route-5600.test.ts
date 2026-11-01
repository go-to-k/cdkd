/**
 * `cdkd diff` on a type with no Cloud Control route (issue
 * [#5600](https://github.com/go-to-k/cdkd/issues/5600)): `AWS::CodeBuild::Project`
 * with `Triggers` printed `[via CC API: Triggers]`, and `--json` carried the
 * same claim in `ccApi`, while the deploy refuses the resource pre-flight.
 *
 * Runs through the REAL registration and predicate, because what is pinned is
 * that the preview agrees with `ProviderRegistry.validateResourceProperties`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) =>
  (await import('../deployment/_inert-cloudformation-client.js')).withInertCloudFormationClient(importOriginal)
);

const warn = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

import {
  buildDiffTree,
  collectCcApiRoutes,
  computeStackDiff,
  countBlocking,
  findUnroutableDropRefusals,
  findUnwrittenCreateOnlyRefusals,
} from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import {
  loadProviderClasses,
  registerAllProviders,
} from '../../../src/provisioning/register-providers.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const TYPE = 'AWS::CodeBuild::Project';
const STACK = 'S';
const CHILD = `${STACK}~Child`;

const registry = new ProviderRegistry();
registerAllProviders(registry, await loadProviderClasses());
const reasonOf = (resourceType: string): string | undefined =>
  registry.ccRouteUnavailableReason(resourceType);

const template = (type = TYPE, properties: Record<string, unknown> = { Triggers: {} }) =>
  ({ Resources: { R: { Type: type, Properties: properties } } }) as unknown as CloudFormationTemplate;

function stateOf(resources: StackState['resources'] = {}, stackName = STACK): StackState {
  return {
    stackName,
    region: 'us-east-1',
    version: 10,
    resources,
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;
}

const backend = (states: Record<string, StackState>): S3StateBackend =>
  ({
    getState: async (stackName: string) =>
      states[stackName] ? { state: states[stackName], etag: 'fake' } : null,
  }) as unknown as S3StateBackend;

const warnings = (): string[] => warn.mock.calls.map(([message]) => String(message));

const DOCDB = 'AWS::DocDB::DBCluster';
const docDbState = {
  R: {
    physicalId: 'p',
    resourceType: DOCDB,
    properties: { SnapshotIdentifier: 'same' },
    acceptedCreateOnlyDrops: ['SnapshotIdentifier'],
  },
} as unknown as StackState['resources'];
const docDbRow = new Map([
  [
    'R',
    {
      logicalId: 'R',
      changeType: 'UPDATE',
      resourceType: DOCDB,
      desiredProperties: { SnapshotIdentifier: 'same' },
      propertyChanges: [
        {
          path: 'SnapshotIdentifier',
          oldValue: undefined,
          newValue: 'same',
          requiresReplacement: true,
        },
      ],
    },
  ],
]) as unknown as Map<string, ResourceChange>;

describe('cdkd diff on a type with no Cloud Control route (#5600)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('has the premise: the deploy refuses this template pre-flight', () => {
    expect(reasonOf(TYPE)).toBeDefined();
    expect(() =>
      registry.validateResourceProperties([
        { logicalId: 'R', resourceType: TYPE, properties: { Triggers: {} } },
      ])
    ).toThrow(/cannot fall back to Cloud Control API/);
  });

  it('prints no route for it', () => {
    expect(collectCcApiRoutes(template(), stateOf(), new Map(), reasonOf).has('R')).toBe(false);
  });

  it('prints no sticky route either: the same refusal reads no recorded layer', () => {
    const state = stateOf({
      R: { physicalId: 'p', resourceType: TYPE, properties: {}, provisionedBy: 'cc-api' },
    } as unknown as StackState['resources']);
    expect(collectCcApiRoutes(template(), state, new Map(), reasonOf).has('R')).toBe(false);
  });

  it('keeps the route of a type Cloud Control serves, through the same predicate', () => {
    const hits = collectCcApiRoutes(
      template('AWS::ApiGatewayV2::Api', { Body: {} }),
      stateOf(),
      new Map(),
      reasonOf
    );
    expect(hits.get('R')).toEqual(['Body']);
    expect(
      findUnroutableDropRefusals(
        template('AWS::ApiGatewayV2::Api', { Body: {} }),
        {},
        reasonOf
      )
    ).toEqual([]);
  });

  it('keeps the sticky tag of a recorded resource with no drop', () => {
    const state = stateOf({
      R: { physicalId: 'p', resourceType: TYPE, properties: {}, provisionedBy: 'cc-api' },
    } as unknown as StackState['resources']);
    const hits = collectCcApiRoutes(template(TYPE, {}), state, new Map(), reasonOf);
    expect(hits.get('R')).toEqual(['sticky']);
  });

  it('names the property, the reason and the --prefer-sdk-route entry in the warning', () => {
    const [reason, ...rest] = findUnroutableDropRefusals(template(), {}, reasonOf);
    expect(rest).toEqual([]);
    expect(reason).toContain(`R (${TYPE})`);
    expect(reason).toContain('refuses Triggers');
    expect(reason).toContain(reasonOf(TYPE));
    expect(reason).toContain(`--prefer-sdk-route ${TYPE}:Triggers`);
  });

  it('words the refusal conditionally over a condition it could not settle', () => {
    const conditional = {
      Resources: { R: { Type: TYPE, Condition: 'C', Properties: { Triggers: {} } } },
    } as unknown as CloudFormationTemplate;
    const [unsettled] = findUnroutableDropRefusals(conditional, {}, reasonOf, () => false);
    expect(unsettled).toContain('if condition C holds, a deploy of this stack');
    const [settled] = findUnroutableDropRefusals(conditional, {}, reasonOf, () => true);
    expect(settled).not.toContain('if condition');
  });

  it('offers no Cloud Control opt-in on a create-only row of such a type', () => {
    expect(findUnwrittenCreateOnlyRefusals(docDbRow, docDbState)[0]).toContain(
      '--recreate-via-cc-api'
    );
    const [text, ...rest] = findUnwrittenCreateOnlyRefusals(docDbRow, docDbState, reasonOf);
    expect(rest).toEqual([]);
    expect(text).not.toContain('--recreate-via-cc-api');
    expect(text).toContain('--prefer-sdk-route');
  });

  describe('a create-only key this SDK provider now writes', () => {
    const CODEBUILD = 'AWS::CodeBuild::Project';
    const nowWrittenRow = (desiredProperties: Record<string, unknown>) =>
      new Map([
        [
          'R',
          {
            logicalId: 'R',
            changeType: 'UPDATE',
            resourceType: CODEBUILD,
            desiredProperties,
            propertyChanges: [
              { path: 'Name', oldValue: undefined, newValue: 'same', requiresReplacement: true },
            ],
          },
        ],
      ]) as unknown as Map<string, ResourceChange>;
    const nowWrittenState = {
      R: {
        physicalId: 'p',
        resourceType: CODEBUILD,
        properties: { Name: 'same' },
        acceptedCreateOnlyDrops: ['Name'],
      },
    } as unknown as StackState['resources'];

    it('keeps the routable wording with no predicate', () => {
      const [text] = findUnwrittenCreateOnlyRefusals(
        nowWrittenRow({ Name: 'same' }),
        nowWrittenState
      );
      expect(text).toContain(
        'unless --recreate-via-cc-api or --replace opts in, whatever --prefer-sdk-route names; '
      );
    });

    it('names only --replace when no other key drives the route', () => {
      const [text, ...rest] = findUnwrittenCreateOnlyRefusals(
        nowWrittenRow({ Name: 'same' }),
        nowWrittenState,
        reasonOf
      );
      expect(rest).toEqual([]);
      expect(text).toContain('unless --replace opts in; a deploy with Name removed');
      expect(text).not.toContain('--recreate-via-cc-api');
      expect(text).not.toContain('whatever --prefer-sdk-route names');
    });

    it('names the flag the pre-flight check needs beside a sibling drop', () => {
      const [text, ...rest] = findUnwrittenCreateOnlyRefusals(
        nowWrittenRow({ Name: 'same', Triggers: {} }),
        nowWrittenState,
        reasonOf
      );
      expect(rest).toEqual([]);
      expect(text).toContain(
        `unless --prefer-sdk-route ${CODEBUILD}:Triggers with the --replace flag opts in; `
      );
      expect(text).not.toContain('--recreate-via-cc-api');
      expect(text).not.toContain('whatever --prefer-sdk-route names');
    });
  });

  it('skips AWS::CDK::Metadata, which the deploy check filters out', () => {
    expect(
      findUnroutableDropRefusals(template('AWS::CDK::Metadata'), {}, () => 'no route')
    ).toEqual([]);
  });

  describe('through buildDiffTree', () => {
    const diff = (tpl: CloudFormationTemplate, extra: object = {}) =>
      buildDiffTree({
        stackName: STACK,
        displayName: STACK,
        region: 'us-east-1',
        template: tpl,
        nestedTemplates: {},
        recursive: false,
        stateBackend: backend({ [STACK]: stateOf() }),
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
        ccRouteUnavailableReason: reasonOf,
        ...extra,
      });

    it('warns instead of a route, and does not exit 3: the flag lets the deploy through', async () => {
      const node = await diff(template());
      expect(node.changes.get('R')?.changeType).toBe('CREATE');
      expect(node.ccApiRoutes.has('R')).toBe(false);
      expect(countBlocking(node)).toBe(0);
      expect(warnings().filter((m) => m.includes('refuses Triggers'))).toHaveLength(1);
    });

    it('reads the passed predicate, not the type alone', async () => {
      // A served type a provider could still opt out of (`disableCcApiFallback`),
      // which only the registry knows.
      const served = template('AWS::ApiGatewayV2::Api', { Body: {} });
      expect((await diff(served)).ccApiRoutes.get('R')).toEqual(['Body']);
      const node = await diff(served, { ccRouteUnavailableReason: () => 'opted out' });
      expect(node.ccApiRoutes.has('R')).toBe(false);
    });

    it('passes the predicate to the create-only warning', async () => {
      await diff(template(DOCDB, { SnapshotIdentifier: 'same' }), {
        stateBackend: backend({ [STACK]: stateOf(docDbState) }),
        diffCalculator: { calculateDiff: async () => docDbRow },
      });
      const text = warnings().filter((m) => m.includes('previews a replacement'));
      expect(text).toHaveLength(1);
      expect(text[0]).not.toContain('--recreate-via-cc-api');
    });

    it('hedges over a condition the diff cannot settle, which the deploy may prune', async () => {
      await diff({
        Parameters: { P: { Type: 'String' } },
        Conditions: { C: { 'Fn::Equals': [{ Ref: 'P' }, 'x'] } },
        Resources: { R: { Type: TYPE, Condition: 'C', Properties: { Triggers: {} } } },
      } as unknown as CloudFormationTemplate);
      expect(warnings().filter((m) => m.includes('if condition C holds'))).toHaveLength(1);
    });

    describe('in a nested child', () => {
      let dir: string;

      beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'cdkd-5600-'));
      });

      afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
      });

      it('reads the same predicate, so the threading reaches the child', async () => {
        const childPath = join(dir, 'child.json');
        // A served type, so only the threaded predicate can refuse the row.
        writeFileSync(
          childPath,
          JSON.stringify(template('AWS::ApiGatewayV2::Api', { Body: {} }))
        );
        const node = await diff(
          {
            Resources: { Child: { Type: 'AWS::CloudFormation::Stack', Properties: {} } },
          } as unknown as CloudFormationTemplate,
          {
            recursive: true,
            ccRouteUnavailableReason: () => 'opted out',
            nestedTemplates: { Child: childPath },
            stateBackend: backend({
              [STACK]: stateOf({
                Child: {
                  physicalId: CHILD,
                  resourceType: 'AWS::CloudFormation::Stack',
                  properties: {},
                },
              } as unknown as StackState['resources']),
              [CHILD]: stateOf({}, CHILD),
            }),
          }
        );
        const kid = node.children.find((c) => c.stackName === CHILD);
        expect(kid, 'the nested child node is missing').toBeDefined();
        expect(kid!.changes.get('R')?.changeType).toBe('CREATE');
        expect(kid!.ccApiRoutes.has('R')).toBe(false);
        expect(warnings().filter((m) => m.includes('refuses Body'))).toHaveLength(1);
      });
    });
  });

  it('does not warn for a caller that previews no deploy (`cdkd refactor`)', async () => {
    await computeStackDiff(
      stateOf(),
      template(),
      'us-east-1',
      STACK,
      backend({ [STACK]: stateOf() }),
      new DiffCalculator()
    );
    expect(warnings().filter((m) => m.includes('refuses Triggers'))).toEqual([]);
  });
});
