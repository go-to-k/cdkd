import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6568: an `AWS::SSM::Document`'s `Content` (and five more
 * "may replace" properties) change replaces the document under the default
 * `UpdateMethod: Replace` and updates it in place under `NewVersion`. The
 * registry schema lists none of the six as create-only, so without a rule the
 * diff called the change an update and the Cloud Control handler refused it.
 */

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: {
      send: () =>
        Promise.reject(
          Object.assign(new Error('not authorized'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
          })
        ),
    },
  }),
}));

import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { ssmDocumentChangeReplaces } from '../../../src/analyzer/replacement-rules/predicates.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { findDestructiveChanges } from '../../../src/analyzer/destructive-changes.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const DOC = 'AWS::SSM::Document';
const MAYBE = ['Content', 'Attachments', 'DocumentFormat', 'Requires', 'TargetType', 'VersionName'];
const contentV = (v: string) => ({
  schemaVersion: '2.2',
  mainSteps: [{ action: 'aws:runShellScript', name: 'run', inputs: { runCommand: [`echo ${v}`] } }],
});

describe('ssmDocumentChangeReplaces (#6568)', () => {
  const bags = (oldMethod: unknown, newMethod: unknown) => ({
    oldProperties: oldMethod === undefined ? {} : { UpdateMethod: oldMethod },
    newProperties: newMethod === undefined ? {} : { UpdateMethod: newMethod },
  });

  it('replaces when the new template sets no UpdateMethod (the default Replace)', () => {
    expect(ssmDocumentChangeReplaces('a', 'b', bags(undefined, undefined))).toBe(true);
  });

  it('replaces under UpdateMethod: Replace', () => {
    expect(ssmDocumentChangeReplaces('a', 'b', bags('Replace', 'Replace'))).toBe(true);
  });

  it('updates in place under UpdateMethod: NewVersion', () => {
    expect(ssmDocumentChangeReplaces('a', 'b', bags('NewVersion', 'NewVersion'))).toBe(false);
  });

  it('reads the NEW template when the same deploy switches UpdateMethod', () => {
    expect(ssmDocumentChangeReplaces('a', 'b', bags('Replace', 'NewVersion'))).toBe(false);
    expect(ssmDocumentChangeReplaces('a', 'b', bags(undefined, 'NewVersion'))).toBe(false);
    expect(ssmDocumentChangeReplaces('a', 'b', bags('NewVersion', undefined))).toBe(true);
    expect(ssmDocumentChangeReplaces('a', 'b', bags('NewVersion', 'Replace'))).toBe(true);
  });

  it('answers the default without sibling bags, and does not read the values (a promotion passes none)', () => {
    expect(ssmDocumentChangeReplaces(undefined, undefined)).toBe(true);
    expect(ssmDocumentChangeReplaces(undefined, undefined, bags(undefined, 'NewVersion'))).toBe(false);
  });
});

describe('AWS::SSM::Document replacement rule (#6568)', () => {
  const registry = new ReplacementRulesRegistry();

  it('replaces on every "may replace" property under the default, in place under NewVersion', () => {
    for (const prop of MAYBE) {
      expect(registry.isClassified(DOC, prop)).toBe(true);
      expect(
        registry.requiresReplacement(DOC, prop, 'a', 'b', { oldProperties: {}, newProperties: {} })
      ).toBe(true);
      expect(
        registry.requiresReplacement(DOC, prop, 'a', 'b', {
          oldProperties: { UpdateMethod: 'NewVersion' },
          newProperties: { UpdateMethod: 'NewVersion' },
        })
      ).toBe(false);
    }
  });

  it('always replaces on Name and DocumentType, and leaves UpdateMethod / Tags unclassified', () => {
    for (const prop of ['Name', 'DocumentType']) {
      expect(registry.requiresReplacement(DOC, prop, 'a', 'b')).toBe(true);
    }
    for (const prop of ['UpdateMethod', 'Tags']) {
      expect(registry.isClassified(DOC, prop)).toBe(false);
    }
  });

  const stateWith = (properties: Record<string, unknown>) =>
    ({
      version: 16,
      stackName: 'S',
      region: 'us-east-1',
      resources: {
        Doc: {
          physicalId: 'S-Doc-ABC123',
          resourceType: DOC,
          properties,
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    }) as StackState;
  const diffOf = async (recorded: Record<string, unknown>, desired: Record<string, unknown>) => {
    const state = stateWith(recorded);
    const change = (
      await new DiffCalculator().calculateDiff(
        state,
        { Resources: { Doc: { Type: DOC, Properties: desired } } } as CloudFormationTemplate,
        async (v: unknown) => v
      )
    ).get('Doc')!;
    return { change, state };
  };

  it('the diff reports a default-method Content change as a replacement', async () => {
    const { change, state } = await diffOf(
      { DocumentType: 'Command', Content: contentV('v1') },
      { DocumentType: 'Command', Content: contentV('v2') }
    );
    expect(change.propertyChanges?.find((pc) => pc.path === 'Content')?.requiresReplacement).toBe(
      true
    );
    expect(findDestructiveChanges('S', [change], state.resources).map((c) => c.impact)).toEqual([
      'WILL_REPLACE',
    ]);
  });

  it('the diff keeps a NewVersion Content change, and a Tags-only change, in place', async () => {
    const base = { DocumentType: 'Command', Name: 'named-doc', UpdateMethod: 'NewVersion' };
    const { change } = await diffOf(
      { ...base, Content: contentV('v1') },
      { ...base, Content: contentV('v2') }
    );
    expect(change.changeType).toBe('UPDATE');
    expect(change.propertyChanges?.some((pc) => pc.requiresReplacement)).toBe(false);

    const tagged = await diffOf(
      { DocumentType: 'Command', Content: contentV('v1') },
      { DocumentType: 'Command', Content: contentV('v1'), Tags: [{ Key: 'k', Value: 'v' }] }
    );
    expect(tagged.change.changeType).toBe('UPDATE');
    expect(tagged.change.propertyChanges?.some((pc) => pc.requiresReplacement)).toBe(false);
  });

  it('the diff replaces when the same deploy drops NewVersion and changes Content', async () => {
    const { change } = await diffOf(
      { DocumentType: 'Command', UpdateMethod: 'NewVersion', Content: contentV('v1') },
      { DocumentType: 'Command', Content: contentV('v2') }
    );
    expect(change.propertyChanges?.find((pc) => pc.path === 'Content')?.requiresReplacement).toBe(
      true
    );
  });
});
