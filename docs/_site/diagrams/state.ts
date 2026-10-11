// Diagrams for the docs pages of this area, by the id a page's fence names
// (```text diagram=<id>). index.ts registers them.
import type { Diagram } from './render.js';

const bucketLayout: Diagram = {
  id: 'state-bucket-layout',
  title: 'Objects in the cdkd state bucket',
  description:
    'The state bucket, cdkd-state-{accountId}, holds five groups of objects. Under the state prefix cdkd/, each stack and region has a directory with state.json (the state record), lock.json (present while a command holds the lock), rollback-journal.json (after a failed or interrupted deploy), create-tokens.json (the create-token ledger) and deployments/ (the deployment event history). Also under the state prefix, _index/{region}/exports.json is the exports index. Outside the prefix are cdkd-bootstrap/{region}.json (the asset-storage marker), custom-resource-responses/ (one object per custom resource call) and cdkd-migrate-tmp/ (transient CloudFormation templates).',
  rows: [['bucket'], ['stack', 'index'], ['marker', 'responses', 'tmp']],
  edges: [
    { from: 'bucket', to: 'stack' },
    { from: 'bucket', to: 'index' },
    { from: 'bucket', to: 'marker' },
    { from: 'bucket', to: 'responses' },
    { from: 'bucket', to: 'tmp' },
  ],
  nodes: [
    { id: 'bucket', title: 's3://cdkd-state-{accountId}/' },
    {
      id: 'stack',
      title: 'cdkd/{stackName}/{region}/',
      route: true,
      detail: [
        'state.json: the state record',
        'lock.json: while a command holds the lock',
        'rollback-journal.json: after a failed or interrupted deploy',
        'create-tokens.json: create-token ledger',
        'deployments/: deployment event history',
      ],
    },
    {
      id: 'index',
      title: 'cdkd/_index/{region}/',
      detail: ['exports.json: exports index'],
    },
    {
      id: 'marker',
      title: 'cdkd-bootstrap/',
      detail: ['{region}.json: asset-storage marker'],
    },
    {
      id: 'responses',
      title: 'custom-resource-responses/',
      detail: ['One object per custom resource call'],
    },
    {
      id: 'tmp',
      title: 'cdkd-migrate-tmp/',
      detail: ['Transient CloudFormation templates'],
    },
  ],
};

const lockLifecycle: Diagram = {
  id: 'state-lock-lifecycle',
  title: 'Lifecycle of a stack lock',
  description:
    'A command that starts work on a stack writes lock.json only if the key is absent. While the lock is held, the command renews it about every 2 minutes, and each renewal moves expiresAt 30 minutes ahead. From there the lock is either released, when the command finished, failed, or took a first Ctrl-C or SIGTERM, or left behind, after a SIGKILL, a crash, a second Ctrl-C or a cancelled CI job. A lock left behind is cleared when the next command takes it over once expiresAt passes, or when cdkd force-unlock deletes it.',
  rows: [['start'], ['held'], ['released', 'abandoned'], [null, 'cleared']],
  edges: [
    { from: 'start', to: 'held' },
    { from: 'held', to: 'released' },
    { from: 'held', to: 'abandoned' },
    { from: 'abandoned', to: 'cleared' },
  ],
  nodes: [
    {
      id: 'start',
      title: 'A command starts work on a stack',
      note: 'Writes lock.json only if the key is absent',
    },
    {
      id: 'held',
      title: 'Lock held',
      route: true,
      note: 'Renewed about every 2 minutes; each renewal moves expiresAt 30 minutes ahead',
    },
    {
      id: 'released',
      title: 'Released',
      detail: ['The command finished, failed, or took a first Ctrl-C or SIGTERM'],
    },
    {
      id: 'abandoned',
      title: 'Left behind',
      detail: ['SIGKILL, a crash, a second Ctrl-C, a cancelled CI job'],
    },
    {
      id: 'cleared',
      title: 'Cleared',
      detail: [
        'The next command takes it over once expiresAt passes, or cdkd force-unlock deletes it now',
      ],
    },
  ],
};

const deploySequence: Diagram = {
  id: 'state-deploy-sequence',
  title: 'When a deploy locks, reads and writes state',
  description:
    'cdkd deploy first synthesizes the app and publishes assets, before the stack is locked. It then acquires the stack lock by writing lock.json, and loads state.json, upgrading an older schema version. While it creates, updates and deletes resources, state.json is saved after each resource. It then resolves outputs and saves state.json in the current schema version. Last, it releases the lock, which also happens on failure and on the first Ctrl-C.',
  rows: [['synth'], ['lock'], ['load'], ['apply'], ['save'], ['release']],
  nodes: [
    {
      id: 'synth',
      title: 'Synthesize the app, publish assets',
      note: 'The stack is not locked yet',
    },
    { id: 'lock', title: 'Acquire the stack lock', note: 'lock.json' },
    {
      id: 'load',
      title: 'Load state.json',
      note: 'An older schema version is upgraded',
    },
    {
      id: 'apply',
      title: 'Create, update, delete resources',
      route: true,
      note: 'state.json is saved after each resource',
    },
    {
      id: 'save',
      title: 'Resolve outputs, save state.json',
      note: 'Written as the current schema version',
    },
    {
      id: 'release',
      title: 'Release the lock',
      note: 'On failure and on the first Ctrl-C too',
    },
  ],
};

export const stateDiagrams: Diagram[] = [bucketLayout, lockLifecycle, deploySequence];
