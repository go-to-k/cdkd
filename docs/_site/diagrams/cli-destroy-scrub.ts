// Diagrams for the docs pages of this area, by the id a page's fence names
// (```text diagram=<id>). index.ts registers them.
import type { Diagram } from './render.js';

const destroyFlow: Diagram = {
  id: 'destroy-flow',
  title: 'What cdkd destroy does, in order',
  description:
    'cdkd destroy selects the stacks, a consumer before the producers it reads from. It then runs the checks that refuse before anything changes: terminationProtection, an output another stack still imports, a damaged state record, and a missing --yes on a non-interactive stdin. It lists the resources and asks to confirm, takes the stack lock, and deletes the resources, dependents first. A resource with DeletionPolicy Retain is left in AWS and its record dropped; one with Snapshot gets a final snapshot and is then deleted. When every delete is confirmed, state.json and lock.json are removed and the run exits 0, with the event history kept unless --purge-events is passed. When a delete failed or was skipped, or the run was interrupted, state.json is kept with what is left and the run exits 2.',
  rows: [['select'], ['checks'], ['confirm'], ['delete'], ['clean', 'partial']],
  edges: [
    { from: 'select', to: 'checks' },
    { from: 'checks', to: 'confirm' },
    { from: 'confirm', to: 'delete' },
    { from: 'delete', to: 'clean', label: 'every delete confirmed' },
    { from: 'delete', to: 'partial', label: 'failed, skipped or Ctrl-C' },
  ],
  nodes: [
    {
      id: 'select',
      title: 'Select stacks',
      note: 'A consumer before the producers it reads from',
    },
    {
      id: 'checks',
      title: 'Checks that refuse before anything changes',
      detail: [
        'terminationProtection',
        'An output another stack still imports',
        'A damaged state record',
        'No --yes on a non-interactive stdin',
      ],
    },
    { id: 'confirm', title: 'List the resources and ask to confirm' },
    {
      id: 'delete',
      title: 'Take the stack lock, delete resources',
      route: true,
      detail: [
        'Dependents first',
        'Retain: left in AWS, record dropped',
        'Snapshot: final snapshot taken, then deleted',
      ],
    },
    {
      id: 'clean',
      title: 'Exit 0',
      detail: ['state.json and lock.json removed', 'Event history kept unless --purge-events'],
    },
    {
      id: 'partial',
      title: 'Exit 2',
      detail: ['state.json kept with what is left', 'Re-run to finish'],
    },
  ],
};

const scrubTouches: Diagram = {
  id: 'scrub-touches',
  title: 'What cdkd scrub reads and what it rewrites',
  description:
    'cdkd scrub synthesizes the CDK app, because only the template names the {{resolve:...}} references. It resolves each reference to learn the current secret value, held in memory only. It then rewrites, under each stack lock, the state.json of each target stack and of every nested stack under it: resource properties, attributes and observed properties, rollback-orphan records, outputs and cross-stack read names. After the lock is released it rewrites the entries those stacks publish in the exports index of each region. On a versioned state bucket it finally purges the earlier S3 versions of each key it rewrote. It never touches AWS resources, a rollback journal, a physical id, or a value the template does not reference.',
  rows: [['template'], ['resolve'], ['state'], ['index'], ['purge'], ['untouched']],
  edges: [
    { from: 'template', to: 'resolve' },
    { from: 'resolve', to: 'state' },
    { from: 'state', to: 'index', label: 'after the lock is released' },
    { from: 'index', to: 'purge', label: 'versioned bucket' },
  ],
  nodes: [
    {
      id: 'template',
      title: 'Synthesize the CDK app',
      note: 'Only the template names the {{resolve:...}} references',
    },
    {
      id: 'resolve',
      title: 'Resolve each reference',
      note: 'The current secret value, held in memory only',
    },
    {
      id: 'state',
      title: 'Rewrite state.json, under the stack lock',
      route: true,
      detail: [
        'Each target stack and every nested stack under it',
        'properties, attributes, observedProperties',
        'Rollback-orphan records',
        'Outputs and cross-stack read names',
      ],
    },
    {
      id: 'index',
      title: 'Rewrite the exports index entries',
      note: 'One exports.json per region',
    },
    {
      id: 'purge',
      title: 'Purge earlier S3 versions',
      note: 'Only of the keys this run rewrote',
    },
    {
      id: 'untouched',
      title: 'Never touched',
      detail: [
        'AWS resources',
        'rollback-journal.json',
        'Physical ids',
        'Values the template does not reference',
      ],
    },
  ],
};

export const cliDestroyScrubDiagrams: Diagram[] = [destroyFlow, scrubTouches];
