// Diagrams for the docs pages of this area, by the id a page's fence names
// (```text diagram=<id>). index.ts registers them.
import type { Diagram } from './render.js';

const diffCompares: Diagram = {
  id: 'diff-compares',
  title: 'What cdkd diff compares',
  description:
    'cdkd diff reads two inputs: the synthesized template, which is what the CDK app declares now, and cdkd state in S3, which is what the last deploy recorded. It reads both and writes neither. The result is the list of resources the next cdkd deploy would create, update or delete.',
  rows: [['template', 'state'], ['diff'], ['changes']],
  nodes: [
    {
      id: 'template',
      title: 'Synthesized template',
      detail: ['What the app declares now'],
    },
    {
      id: 'state',
      title: 'cdkd state (S3)',
      detail: ['What the last deploy recorded'],
    },
    { id: 'diff', title: 'cdkd diff', route: true, detail: ['Reads both, writes neither'] },
    {
      id: 'changes',
      title: '[+] create   [~] update   [-] delete',
      detail: ['What the next cdkd deploy would apply'],
    },
  ],
};

const driftCompares: Diagram = {
  id: 'drift-compares',
  title: 'What cdkd drift compares',
  description:
    'cdkd drift reads two inputs: cdkd state in S3, which holds the values AWS reported at the last deploy, and live AWS, through a fresh read of each resource. It compares the keys state records and puts each resource in one of five outcomes: clean, drifted, deleted, not compared, or drift unknown.',
  rows: [['state', 'aws'], ['drift'], ['outcomes']],
  nodes: [
    {
      id: 'state',
      title: 'cdkd state (S3)',
      detail: ['The values AWS reported at the last deploy'],
    },
    { id: 'aws', title: 'Live AWS', detail: ['A fresh read of each resource'] },
    {
      id: 'drift',
      title: 'cdkd drift',
      route: true,
      detail: ['Compares the keys state records'],
    },
    {
      id: 'outcomes',
      title: 'One outcome per resource',
      detail: ['clean / drifted / deleted / not compared / drift unknown'],
    },
  ],
};

const driftAcceptRevert: Diagram = {
  id: 'drift-accept-revert',
  title: 'The two ways to resolve drift',
  description:
    'When drift is reported on a property there are two directions. --accept copies the live value from AWS into cdkd state and does not modify AWS. --revert pushes the value recorded in cdkd state back into AWS through the resource provider.',
  rows: [['drift'], ['accept', 'revert']],
  nodes: [
    { id: 'drift', title: 'Drift reported on a property' },
    {
      id: 'accept',
      title: '--accept',
      detail: ['state <- AWS', 'Record the live value', 'AWS is not modified'],
    },
    {
      id: 'revert',
      title: '--revert',
      detail: ['AWS <- state', 'Push the recorded value back', "Through the resource's provider"],
    },
  ],
};

export const cliDiffDriftDiagrams: Diagram[] = [diffCompares, driftCompares, driftAcceptRevert];
