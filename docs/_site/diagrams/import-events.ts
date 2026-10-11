// Diagrams for the docs pages of this area, by the id a page's fence names
// (```text diagram=<id>). index.ts registers them.
import type { Diagram } from './render.js';

const importOwnership: Diagram = {
  id: 'import-ownership',
  title: 'What cdkd import does to ownership',
  description:
    'Before an import, a CloudFormation stack (or nobody) manages the AWS resources. cdkd import reads each physical id and writes a state record for it, without changing the resource. With --migrate-from-cloudformation it then sets every resource in the CloudFormation stack to Retain and deletes that stack, which leaves the resources in place. Afterwards only cdkd state manages them, and the next cdkd deploy updates them in place.',
  rows: [['before'], ['import'], ['state'], ['retire'], ['after']],
  nodes: [
    {
      id: 'before',
      title: 'AWS resources, managed by CloudFormation or by nobody',
      note: 'Deployed with cdk deploy, or created by hand',
    },
    {
      id: 'import',
      title: 'cdkd import',
      detail: ['Reads each physical id', 'Does not change any resource'],
    },
    {
      id: 'state',
      title: 'cdkd state',
      route: true,
      detail: ['One record per adopted resource'],
      note: 'Written after you confirm',
    },
    {
      id: 'retire',
      title: 'CloudFormation stack retired',
      detail: ['Every resource set to Retain', 'Then DeleteStack'],
      note: 'Only with --migrate-from-cloudformation',
    },
    {
      id: 'after',
      title: 'Same AWS resources, managed by cdkd',
      note: 'The next cdkd deploy updates them in place',
    },
  ],
};

const importResolution: Diagram = {
  id: 'import-resolution',
  title: 'How cdkd import finds one resource',
  description:
    'For each resource in the template, cdkd import uses the physical id from --resource or a mapping file when one names the resource. Otherwise, in auto and hybrid mode, it looks the resource up by the name property the template sets. If that finds nothing, it reads the physical id from a CloudFormation stack of the same name. A resource none of the three resolves is reported as not found.',
  rows: [['override'], ['name'], ['cfn'], ['notfound']],
  nodes: [
    {
      id: 'override',
      title: '--resource or a mapping file names it',
      note: 'Used as given, in every mode',
    },
    {
      id: 'name',
      title: 'The template sets a name property',
      note: 'BucketName, RoleName, TopicName and the like',
    },
    {
      id: 'cfn',
      title: 'A CloudFormation stack of the same name exists',
      note: 'DescribeStackResources supplies the physical id',
    },
    {
      id: 'notfound',
      title: 'Reported as not found',
      note: 'Pass --resource for it and run again',
    },
  ],
  edges: [
    { from: 'override', to: 'name', label: 'not named' },
    { from: 'name', to: 'cfn', label: 'no match' },
    { from: 'cfn', to: 'notfound', label: 'no match' },
  ],
};

const eventsRun: Diagram = {
  id: 'events-run',
  title: 'The events one run records',
  description:
    'A run opens with RUN_STARTED. Each resource operation records RESOURCE_STARTED and then RESOURCE_SUCCEEDED or RESOURCE_FAILED, which carries the error. A failed deploy that rolls back records ROLLBACK_STARTED, one ROLLBACK_RESOURCE event per reverted operation, and ROLLBACK_FINISHED. The run closes with RUN_FINISHED, which carries the result and the counts.',
  rows: [['start'], ['resource'], ['ok', 'failed'], [null, 'rollback'], ['finish']],
  nodes: [
    { id: 'start', title: 'RUN_STARTED', note: 'Command, region, cdkd version' },
    { id: 'resource', title: 'RESOURCE_STARTED', note: 'One per resource operation' },
    { id: 'ok', title: 'RESOURCE_SUCCEEDED' },
    { id: 'failed', title: 'RESOURCE_FAILED', detail: ['Carries the error'] },
    {
      id: 'rollback',
      title: 'ROLLBACK_STARTED to ROLLBACK_FINISHED',
      detail: ['One ROLLBACK_RESOURCE event per reverted operation'],
    },
    { id: 'finish', title: 'RUN_FINISHED', route: true, note: 'Result and counts' },
  ],
  edges: [
    { from: 'start', to: 'resource' },
    { from: 'resource', to: 'ok' },
    { from: 'resource', to: 'failed' },
    { from: 'failed', to: 'rollback' },
    { from: 'ok', to: 'finish' },
    { from: 'rollback', to: 'finish' },
  ],
};

export const importEventsDiagrams: Diagram[] = [importOwnership, importResolution, eventsRun];
