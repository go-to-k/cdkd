import { describe, it, expect } from 'vite-plus/test';
import {
  collectCcApiRoutes,
  SDK_MIGRATION_TOKEN,
} from '../../../src/cli/commands/diff-recursive.js';
import { STICKY_CC_MIGRATION_EXEMPT } from '../../../src/provisioning/provider-registry.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

/**
 * `cdkd diff`'s routing annotation for a resource recorded
 * `provisionedBy: 'cc-api'` (issue
 * [#2719](https://github.com/go-to-k/cdkd/issues/2719)).
 *
 * `collectCcApiRoutes` is a pure function of (template, state), so there is no
 * reason for this to have been integ-only — and it shipped that way in the
 * first revision, including the pre-existing MISLABEL fix below, which is a
 * behaviour change with no unit test at all.
 *
 * The class of bug here is an annotation that states the OPPOSITE of what the
 * deploy will do. That is worse than a missing annotation: a user reads
 * `sticky` and plans around a resource staying on Cloud Control.
 */
const EXEMPT_TYPE = (() => {
  for (const [type, e] of STICKY_CC_MIGRATION_EXEMPT) if (e.mode === 'sdk-coverage') return type;
  throw new Error('no sdk-coverage member; these cases would be vacuous');
})();
const CC_BROKEN_TYPE = (() => {
  for (const [type, e] of STICKY_CC_MIGRATION_EXEMPT) if (e.mode === 'cc-broken') return type;
  throw new Error('no cc-broken member');
})();

function stateWith(
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>
): StackState {
  return {
    version: 9,
    stackName: 'S',
    region: 'us-east-1',
    resources: {
      [logicalId]: {
        physicalId: 'pid',
        resourceType,
        properties,
        provisionedBy: 'cc-api',
      },
    },
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;
}

function templateWith(
  logicalId: string,
  type: string,
  properties?: Record<string, unknown>
): CloudFormationTemplate {
  return {
    Resources: { [logicalId]: { Type: type, ...(properties ? { Properties: properties } : {}) } },
  } as unknown as CloudFormationTemplate;
}

describe('cdkd diff routing annotation for a cc-api record (#2719)', () => {
  it('says the resource is RETURNING when the flip conditions hold', () => {
    const hits = collectCcApiRoutes(
      templateWith('R', EXEMPT_TYPE, { DisplayName: 'new' }),
      stateWith('R', EXEMPT_TYPE, { DisplayName: 'old' })
    );
    expect(hits.get('R')).toEqual([SDK_MIGRATION_TOKEN]);
  });

  it('says STICKY for a type carrying no exemption', () => {
    const hits = collectCcApiRoutes(
      templateWith('R', 'AWS::CloudFormation::WaitConditionHandle', {}),
      stateWith('R', 'AWS::CloudFormation::WaitConditionHandle', {})
    );
    expect(hits.get('R')).toEqual(['sticky']);
  });

  it('says RETURNING for a cc-broken type — the pre-existing MISLABEL this fixes', () => {
    // Before #2719 this arm read the state record alone, so a type exempt
    // since issue #961 rendered `[via CC API: sticky]` while `getProviderFor`
    // routed it to the SDK provider: the annotation stated the opposite of
    // what the deploy would do. A cc-broken type flips unconditionally, so it
    // must say so even with no properties on either side.
    const hits = collectCcApiRoutes(
      templateWith('R', CC_BROKEN_TYPE),
      stateWith('R', CC_BROKEN_TYPE, {})
    );
    expect(hits.get('R')).toEqual([SDK_MIGRATION_TOKEN]);
  });

  it('says RETURNING for a template resource with NO Properties block', () => {
    // The engine normalizes an absent bag to `{}` (`change.desiredProperties
    // || {}`); this renderer must match, or removing the last property from a
    // cc-api-recorded resource prints `sticky` for a deploy that will flip it
    // — the same inverse-of-truth, reintroduced one level above the shared
    // predicate. Found in review, after the `?? {}` was initially missing.
    const hits = collectCcApiRoutes(
      templateWith('R', EXEMPT_TYPE),
      stateWith('R', EXEMPT_TYPE, { DisplayName: 'old' })
    );
    expect(hits.get('R')).toEqual([SDK_MIGRATION_TOKEN]);
  });

  it('annotates nothing for a resource with no state record', () => {
    const hits = collectCcApiRoutes(templateWith('R', EXEMPT_TYPE, {}), {
      version: 9,
      stackName: 'S',
      region: 'us-east-1',
      resources: {},
      outputs: {},
      lastModified: 0,
    } as unknown as StackState);
    expect(hits.has('R')).toBe(false);
  });
});

/**
 * Issue [#3713](https://github.com/go-to-k/cdkd/issues/3713): an unrecognized
 * key routes through Cloud Control only when it differs from the record, as
 * `getProviderFor` decides on the update path. The annotation must read the
 * same baseline, or it names a route the deploy will not take.
 */
describe('cdkd diff routing annotation for an unrecognized key (#3713)', () => {
  const TYPE = 'AWS::SQS::Queue';
  const UNKNOWN = 'CdkdTotallyNewPropertyFromTheFuture';

  it('PREMISE: the type is routable and carries no sticky-escape exemption', () => {
    expect(STICKY_CC_MIGRATION_EXEMPT.has(TYPE)).toBe(false);
  });

  it('does NOT name a key the record already holds unchanged', () => {
    const bag = { QueueName: 'q', [UNKNOWN]: 'same' };
    const hits = collectCcApiRoutes(templateWith('R', TYPE, { ...bag }), stateWith('R', TYPE, { ...bag }));
    // The record is on 'cc-api', so the sticky arm is what remains.
    expect(hits.get('R')).toEqual(['sticky']);
  });

  it('names the key once its value differs from the record', () => {
    const hits = collectCcApiRoutes(
      templateWith('R', TYPE, { QueueName: 'q', [UNKNOWN]: 'changed' }),
      stateWith('R', TYPE, { QueueName: 'q', [UNKNOWN]: 'same' })
    );
    expect(hits.get('R')).toEqual([UNKNOWN]);
  });
});
