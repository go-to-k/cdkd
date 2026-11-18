import { describe, it, expect, vi } from 'vite-plus/test';

/**
 * go-to-k/cdkd#6513: an `AWS::CertificateManager::Certificate`'s
 * `ValidationMethod` change is a replacement (ACM cannot change it, and
 * CloudFormation documents it as one), but the registry schema leaves it out
 * of `createOnlyProperties`. The diff must report it, so the engine replaces
 * the certificate and re-points its readers before the old one is deleted.
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
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { findDestructiveChanges } from '../../../src/analyzer/destructive-changes.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const CERT = 'AWS::CertificateManager::Certificate';

describe('ACM Certificate ValidationMethod (#6513)', () => {
  const registry = new ReplacementRulesRegistry();

  it('requires replacement when ValidationMethod changes', () => {
    expect(registry.requiresReplacement(CERT, 'ValidationMethod', 'DNS', 'EMAIL')).toBe(true);
  });

  it('leaves the other properties to the schema fallback (the rule names only the gap)', () => {
    for (const prop of ['DomainName', 'SubjectAlternativeNames', 'KeyAlgorithm', 'Tags']) {
      expect(registry.isClassified(CERT, prop)).toBe(false);
    }
  });

  const stateWith = (properties: Record<string, unknown>) =>
    ({
      version: 16,
      stackName: 'S',
      region: 'us-east-1',
      resources: {
        Cert: {
          physicalId: 'arn:aws:acm:us-east-1:111111111111:certificate/a',
          resourceType: CERT,
          properties,
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    }) as StackState;
  const diffOf = async (recorded: Record<string, unknown>, desired: Record<string, unknown>) =>
    (
      await new DiffCalculator().calculateDiff(
        stateWith(recorded),
        { Resources: { Cert: { Type: CERT, Properties: desired } } } as CloudFormationTemplate,
        async (v: unknown) => v
      )
    ).get('Cert')!;

  it('keeps the schema fallback: a DomainName change still replaces, a Tags change stays in place', async () => {
    const renamed = await diffOf({ DomainName: 'a.example.test' }, { DomainName: 'b.example.test' });
    expect(renamed.propertyChanges?.find((pc) => pc.path === 'DomainName')?.requiresReplacement).toBe(true);
    const tagged = await diffOf(
      { DomainName: 'a.example.test' },
      { DomainName: 'a.example.test', Tags: [{ Key: 'k', Value: 'v' }] }
    );
    expect(tagged.changeType).toBe('UPDATE');
    expect(tagged.propertyChanges?.some((pc) => pc.requiresReplacement)).toBe(false);
  });

  it('is reported by the diff and counted as destructive', async () => {
    const state = {
      version: 16,
      stackName: 'S',
      region: 'us-east-1',
      resources: {
        Cert: {
          physicalId: 'arn:aws:acm:us-east-1:111111111111:certificate/a',
          resourceType: CERT,
          properties: { DomainName: 'x.example.test', ValidationMethod: 'DNS' },
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
    } as StackState;
    const template = {
      Resources: {
        Cert: { Type: CERT, Properties: { DomainName: 'x.example.test', ValidationMethod: 'EMAIL' } },
      },
    } as CloudFormationTemplate;
    const changes = await new DiffCalculator().calculateDiff(state, template, async (v: unknown) => v);
    const change = changes.get('Cert')!;
    expect(change.propertyChanges?.find((pc) => pc.path === 'ValidationMethod')?.requiresReplacement).toBe(
      true
    );
    expect(findDestructiveChanges('S', [change], state.resources).map((c) => c.impact)).toEqual([
      'WILL_REPLACE',
    ]);
  });
});
