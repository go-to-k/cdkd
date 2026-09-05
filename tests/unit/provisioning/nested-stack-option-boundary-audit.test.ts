/**
 * Makes the parent→child option audit MECHANICAL (issue
 * [#2567](https://github.com/go-to-k/cdkd/issues/2567)).
 *
 * `NestedStackProvider.runChildDeploy` spreads the parent's whole
 * `DeployEngineOptions` bag into the CHILD engine. Everything the parent
 * validated against ITS OWN template, state and live AWS arrives there
 * unvalidated for the child — which is how a bare `--recreate-via-*` id set
 * came to match a child resource that merely shared a logical id, skipping the
 * child's stateful guard.
 *
 * The remedy was a comment at the spread site enumerating which members name a
 * stack (or a resource in one) and why each is safe. That enumeration went
 * through three hand-written revisions in one review — "two members", then
 * four — and nothing watched it, so a FIFTH member would silently re-open the
 * question. `.claude/skills/work-issues/references/implement.md`: a list that
 * must stay in sync with the repo is a test, not a sentence.
 *
 * This is deliberately a MEMBERSHIP fence, not a semantic one. It cannot decide
 * whether a new option names a stack — that is the judgment the audit exists to
 * make. What it can do is refuse to let a new member arrive unnoticed: adding
 * one reds this case, and clearing it requires walking the audit and recording
 * the verdict here.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';

const REPO_ROOT = join(import.meta.dirname, '../../..');
const DEPLOY_ENGINE = readFileSync(join(REPO_ROOT, 'src/deployment/deploy-engine.ts'), 'utf8');
const NESTED_STACK_PROVIDER = readFileSync(
  join(REPO_ROOT, 'src/provisioning/providers/nested-stack-provider.ts'),
  'utf8'
);

/**
 * Every `DeployEngineOptions` member, as of the audit recorded at the spread
 * site. A member NOT in this list is unreviewed against the parent→child
 * boundary — that is the whole signal.
 */
const AUDITED_MEMBERS = [
  // --- names a stack, or a resource in one (the audit's subject) -------------
  'recreateTargets', // self-scoped: matched only while deploying its `stackName`
  'onCurrentStateLoaded', // self-scoped: the prefix gate returns early on a mismatch
  'parentStackInfo', // overwritten by the spread site, must describe THIS child
  'eventRecorder', // carries the top-level run's stack name, by design
  // --- names no resource ------------------------------------------------------
  'concurrency',
  'dryRun',
  'lockTimeout',
  'parameters',
  'noRollback',
  'roleArn',
  'resourceWarnAfterMs',
  'resourceTimeoutMs',
  'resourceWarnAfterByType',
  'resourceTimeoutByType',
  'captureObservedState',
  'assetRedirect',
  'inheritedSecrets',
  'replace',
  'forceStatefulRecreation',
  'strictGetAtt',
  'cfnFallback',
  'skipFinalSnapshot',
  'finalSnapshotClients',
];

/** Top-level member names of the `DeployEngineOptions` interface. */
function declaredMembers(): string[] {
  const start = DEPLOY_ENGINE.indexOf('export interface DeployEngineOptions {');
  if (start === -1) throw new Error('DeployEngineOptions interface not found');
  const end = DEPLOY_ENGINE.indexOf('\n}', start);
  if (end === -1) throw new Error('DeployEngineOptions interface close not found');
  const body = DEPLOY_ENGINE.slice(start, end);
  // Top-level members only: exactly two leading spaces. A nested object's
  // members are indented further, so `parentStackInfo`'s own fields do not
  // leak in and inflate the list.
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]!);
}

describe('the parent→child option boundary audit stays complete (#2567)', () => {
  it('finds the interface and a plausible number of members — the anti-vacuity floor', () => {
    // Without this, a parse that silently returned [] would make the set
    // comparison below trivially satisfiable in one direction.
    expect(declaredMembers().length).toBeGreaterThanOrEqual(20);
  });

  it('every DeployEngineOptions member has been walked against the boundary', () => {
    const unaudited = declaredMembers().filter((m) => !AUDITED_MEMBERS.includes(m));
    expect(
      unaudited,
      'a new DeployEngineOptions member is not in the audit. It is spread into every ' +
        'nested child engine by NestedStackProvider.runChildDeploy, so decide whether it ' +
        'names a stack (or a resource in one) and therefore needs scoping — then add it ' +
        'here and, if it does, to the comment at that spread site.'
    ).toEqual([]);
  });

  it('no audited member has been REMOVED without updating the audit', () => {
    // The other direction: a stale entry means the audit describes an option
    // that no longer exists, which is how an enumeration rots into fiction.
    const declared = declaredMembers();
    const vanished = AUDITED_MEMBERS.filter((m) => !declared.includes(m));
    expect(
      vanished,
      'the audit names DeployEngineOptions members that no longer exist — remove them here ' +
        'and from the comment at the nested-stack spread site'
    ).toEqual([]);
  });

  it('the spread site still names the four stack-naming members', () => {
    // The audit's verdict lives in prose; this pins that the prose still names
    // each member it claims to have walked, so deleting one from the comment
    // fails rather than quietly narrowing the claim.
    for (const member of ['recreateTargets', 'onCurrentStateLoaded', 'parentStackInfo', 'eventRecorder']) {
      expect(
        NESTED_STACK_PROVIDER,
        `the parent→child boundary comment no longer names \`${member}\``
      ).toContain(member);
    }
  });
});
