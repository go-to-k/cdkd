// Diagrams for the docs pages of this area, by the id a page's fence names
// (```text diagram=<id>). index.ts registers them.
import type { Diagram } from './render.js';

const destroyFlow: Diagram = {
  id: 'destroy-flow',
  title: 'What cdkd destroy does, in order',
  description:
    "cdkd destroy selects the stacks; a stack that reads another stack's outputs goes before the stack it reads from. It then runs the checks that refuse before anything changes: terminationProtection, an output another stack still imports, a damaged state record, and a missing --yes on a non-interactive stdin. It lists the resources and asks to confirm, takes the stack lock, and deletes the resources, dependents first. A resource with DeletionPolicy Retain is left in AWS and its record dropped; one with Snapshot gets a final snapshot and is then deleted. When every delete is confirmed, state.json and lock.json are removed and the run exits 0, with the event history kept unless --purge-events is passed. When a delete failed or was skipped, or the run was interrupted, state.json is kept with what is left and the run exits 2.",
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
      note: "A stack that reads another stack's outputs goes first",
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
    "cdkd scrub synthesizes the CDK app, because only the template says which values are {{resolve:...}} references. It looks up each reference to learn the secret's current value, which it keeps in memory. It then rewrites the state.json of each stack you named and of its nested stacks: resource properties and attributes, stack outputs, and the names of values read from other stacks. Next it updates the exports index, the per-region list of exported values. On a versioned state bucket it finally deletes the earlier S3 versions of the files this run rewrote. It never changes AWS resources, resource names and IDs, or values the template does not reference.",
  rows: [['template'], ['resolve'], ['state'], ['index'], ['purge'], ['untouched']],
  edges: [
    { from: 'template', to: 'resolve' },
    { from: 'resolve', to: 'state' },
    { from: 'state', to: 'index' },
    { from: 'index', to: 'purge', label: 'versioned bucket' },
  ],
  nodes: [
    {
      id: 'template',
      title: 'Synthesize the CDK app',
      note: 'Only the template says which values are {{resolve:...}} references',
    },
    {
      id: 'resolve',
      title: 'Look up each reference',
      note: "The secret's current value, kept in memory",
    },
    {
      id: 'state',
      title: 'Rewrite state.json',
      route: true,
      detail: [
        'Each stack you named and its nested stacks',
        'Resource properties and attributes',
        'Stack outputs',
        'Names read from other stacks',
      ],
    },
    {
      id: 'index',
      title: 'Update the exports index',
      note: 'The per-region list of exported values',
    },
    {
      id: 'purge',
      title: 'Delete earlier S3 versions',
      note: 'Only of the files this run rewrote',
    },
    {
      id: 'untouched',
      title: 'Never changed',
      detail: ['AWS resources', 'Resource names and IDs', 'Values the template does not reference'],
    },
  ],
};

export const cliDestroyScrubDiagrams: Diagram[] = [destroyFlow, scrubTouches];
