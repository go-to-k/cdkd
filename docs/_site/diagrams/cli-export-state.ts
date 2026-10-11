// Diagrams for the docs pages of this area, by the id a page's fence names
// (```text diagram=<id>). index.ts registers them.
import type { Diagram } from './render.js';

const exportOwnership: Diagram = {
  id: 'export-ownership',
  title: 'What cdkd export does to the ownership of a stack',
  description:
    'Before the export, cdkd owns the stack: a state record in S3 tracks its resources and cdkd deploy changes them. cdkd export builds a CloudFormation IMPORT changeset from that record and the synthesized template, without modifying the AWS resources. After the export, CloudFormation owns the stack: a CloudFormation stack holds the same resources, the cdkd state record is deleted, and cdk deploy changes them.',
  rows: [['before'], ['export'], ['after']],
  nodes: [
    {
      id: 'before',
      title: 'Before: cdkd owns the stack',
      detail: ['A state record in S3 tracks the resources', 'You change them with cdkd deploy'],
    },
    {
      id: 'export',
      title: 'cdkd export',
      route: true,
      detail: ['IMPORT changeset built from the state record and the synthesized template'],
      note: 'The AWS resources are not modified',
    },
    {
      id: 'after',
      title: 'After: CloudFormation owns the stack',
      detail: [
        'A CloudFormation stack holds the same resources',
        'The cdkd state record is deleted',
        'You change them with cdk deploy',
      ],
    },
  ],
};

const exportRun: Diagram = {
  id: 'export-run',
  title: 'The steps of a cdkd export run',
  description:
    'cdkd export first builds the import plan: it synthesizes the app or reads --template, classifies every resource and resolves each identifier, with no lock and no AWS writes, and reports blocked resources here. It then locks the stack and asks for confirmation; --dry-run stops before this step. Phase 1 creates the CloudFormation stack with an IMPORT changeset. Phase 2, which runs only when the stack has Custom Resources or AWS::IAM::Policy resources, deletes those inline policies and submits an UPDATE changeset with the full template; a failure there leaves both the CloudFormation stack and the cdkd state in place. Last, cdkd deletes its state record and releases the lock.',
  rows: [['plan'], ['lock'], ['phase1'], ['phase2'], ['done']],
  nodes: [
    {
      id: 'plan',
      title: 'Build the import plan',
      detail: ['Synthesize the app or read --template', 'Classify resources, resolve identifiers'],
      note: 'No lock and no AWS writes. Blocked resources are reported here.',
    },
    {
      id: 'lock',
      title: 'Lock the stack, ask for confirmation',
      note: '--dry-run stops before this step',
    },
    {
      id: 'phase1',
      title: 'Phase 1: IMPORT changeset',
      route: true,
      detail: ['Creates the CloudFormation stack from the importable resources'],
    },
    {
      id: 'phase2',
      title: 'Phase 2: UPDATE changeset',
      detail: [
        'Only with Custom Resources or AWS::IAM::Policy',
        'Deletes the inline policies, then CloudFormation creates both kinds',
      ],
      note: 'A failure here leaves the CloudFormation stack and the cdkd state in place',
    },
    { id: 'done', title: 'Delete the cdkd state record, release the lock' },
  ],
};

const stateCleanupChoice: Diagram = {
  id: 'state-cli-cleanup-choice',
  title: 'Which cdkd state subcommand removes what',
  description:
    'If the AWS resources should be deleted, cdkd state destroy deletes them and then the state record. If they should stay, the choice is how much of the record to remove: cdkd state orphan with --resource drops one resource entry and leaves the stack deployed, and cdkd state orphan without it deletes the whole record so cdkd tracks nothing in the stack.',
  rows: [['question'], ['scope', 'destroy'], ['one', 'all']],
  edges: [
    { from: 'question', to: 'scope', label: 'no' },
    { from: 'question', to: 'destroy', label: 'yes' },
    { from: 'scope', to: 'one', label: 'one resource' },
    { from: 'scope', to: 'all', label: 'whole stack' },
  ],
  nodes: [
    { id: 'question', title: 'Should the AWS resources be deleted?' },
    { id: 'scope', title: 'How much of the record goes?' },
    {
      id: 'destroy',
      title: 'Resources, then the record',
      mono: true,
      detail: ['cdkd state destroy MyStack'],
    },
    {
      id: 'one',
      title: 'One entry; the stack stays deployed',
      mono: true,
      detail: ['cdkd state orphan MyStack --resource MyQueue'],
    },
    {
      id: 'all',
      title: 'The whole record; nothing stays tracked',
      mono: true,
      detail: ['cdkd state orphan MyStack'],
    },
  ],
};

export const cliExportStateDiagrams: Diagram[] = [exportOwnership, exportRun, stateCleanupChoice];
