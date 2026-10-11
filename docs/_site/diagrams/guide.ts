// Diagrams for the docs pages of this area, by the id a page's fence names
// (```text diagram=<id>). index.ts registers them.
import type { Diagram } from './render.js';

const waitModes: Diagram = {
  id: 'guide-wait-modes',
  title: 'Where each wait mode returns',
  description:
    'A deploy passes three points in order. First, AWS accepts the create or update call: --no-wait returns here. Second, the resources a later step of the same deploy needs are ready, such as an RDS instance, a NAT gateway, an EC2 instance or a load balancer being available and an ACM certificate being issued: the default returns here. Third, everything CloudFormation waits for has settled, which adds ECS service steady state and CloudFront Deployed: --full-wait returns here.',
  rows: [['accepted'], ['ready'], ['settled']],
  nodes: [
    {
      id: 'accepted',
      title: 'AWS accepts the create or update call',
      note: '--no-wait returns here. AWS finishes in the background.',
    },
    {
      id: 'ready',
      title: 'Resources the deploy itself depends on are ready',
      route: true,
      detail: [
        'RDS, DocumentDB, Neptune, ElastiCache: available',
        'NAT gateway, EC2 instance, load balancer: up',
        'ACM certificate: issued',
      ],
      note: 'The default returns here.',
    },
    {
      id: 'settled',
      title: 'Everything CloudFormation waits for has settled',
      detail: ['ECS service: steady state', 'CloudFront distribution: Deployed'],
      note: '--full-wait returns here.',
    },
  ],
};

const rollbackUndo: Diagram = {
  id: 'guide-rollback-undo',
  title: 'What a rollback does to each resource the failed deploy touched',
  description:
    'When a deploy fails, the rollback handles each resource by what the deploy had done to it. A resource the deploy created is deleted, unless its DeletionPolicy is Retain, which leaves it in AWS, or Snapshot, which snapshots it first. A resource the deploy updated is set back to the properties cdkd had recorded for it. A resource the deploy replaced has its old resource re-created and the new one deleted. A resource the deploy deleted cannot be restored, so the rollback warns and moves on. Resources the deploy did not touch are left alone.',
  rows: [['fail'], ['created', 'updated'], ['replaced', 'deleted']],
  edges: [
    { from: 'fail', to: 'created' },
    { from: 'fail', to: 'updated' },
    { from: 'fail', to: 'replaced' },
    { from: 'fail', to: 'deleted' },
  ],
  nodes: [
    {
      id: 'fail',
      title: 'A resource fails mid-deploy',
      detail: ['Resources the deploy did not touch are left alone'],
    },
    {
      id: 'created',
      title: 'Created by this deploy',
      route: true,
      detail: ['Deleted', 'Retain: left in AWS', 'Snapshot: snapshotted, then deleted'],
    },
    {
      id: 'updated',
      title: 'Updated by this deploy',
      route: true,
      detail: ['Set back to the properties cdkd had recorded'],
    },
    {
      id: 'replaced',
      title: 'Replaced by this deploy',
      route: true,
      detail: ['Old resource re-created, new one deleted', 'Data in the old one is not recovered'],
    },
    {
      id: 'deleted',
      title: 'Deleted by this deploy',
      detail: ['Cannot be restored', 'The rollback warns and moves on'],
    },
  ],
};

const driftVsDiff: Diagram = {
  id: 'guide-drift-vs-diff',
  title: 'What cdkd diff and cdkd drift each compare',
  description:
    'Three things describe a stack. The template is what your CDK app asks for now. cdkd state is what cdkd last deployed, with the properties it read back from AWS at that time. AWS holds what exists now. cdkd diff compares the template with state and needs the CDK app. cdkd drift compares state with AWS and needs no CDK app.',
  rows: [['template'], ['state'], ['aws']],
  edges: [
    { from: 'template', to: 'state', label: 'cdkd diff compares these two' },
    { from: 'state', to: 'aws', label: 'cdkd drift compares these two' },
  ],
  nodes: [
    { id: 'template', title: 'Template', note: 'What your CDK app asks for now.' },
    {
      id: 'state',
      title: 'cdkd state',
      route: true,
      note: 'What cdkd last deployed, with the properties it read back from AWS then.',
    },
    { id: 'aws', title: 'AWS', note: 'What exists now, console edits included.' },
  ],
};

const orphanVsDestroy: Diagram = {
  id: 'guide-orphan-vs-destroy',
  title: 'What destroy and orphan each remove',
  description:
    'A deployed stack is two things: the AWS resources and the cdkd state that tracks them. A destroy deletes the AWS resources and then the state. An orphan removes only the state, or one resource entry in it, and leaves the AWS resources running and untracked.',
  rows: [['stack'], ['destroy', 'orphan']],
  edges: [
    { from: 'stack', to: 'destroy', label: 'destroy' },
    { from: 'stack', to: 'orphan', label: 'orphan' },
  ],
  nodes: [
    {
      id: 'stack',
      title: 'A deployed stack',
      detail: ['AWS resources', 'The cdkd state that tracks them'],
    },
    {
      id: 'destroy',
      title: 'Nothing is left',
      detail: ['AWS resources: deleted', 'State: deleted'],
    },
    {
      id: 'orphan',
      title: 'Resources keep running',
      route: true,
      detail: [
        'AWS resources: untouched',
        'State, or one entry in it: removed',
        'cdkd no longer tracks them',
      ],
    },
  ],
};

const provisioningRoute: Diagram = {
  id: 'guide-provisioning-route',
  title: 'How cdkd picks the layer for a resource',
  description:
    'cdkd asks three questions about a resource on every deploy. Is it already recorded as cc-api in state? If yes, it stays on the Cloud Control API, apart from a few types that move back. If no: does an SDK provider exist for its type? If none exists, the Cloud Control API handles it. If one exists: does the provider handle every top-level property in the template? If it would leave a property out, the resource goes through the Cloud Control API. Otherwise the SDK provider handles it.',
  rows: [['recorded'], ['exists'], ['covers'], ['sdk']],
  edges: [
    { from: 'recorded', to: 'exists', label: 'no' },
    { from: 'exists', to: 'covers', label: 'yes' },
    { from: 'covers', to: 'sdk', label: 'yes' },
  ],
  nodes: [
    {
      id: 'recorded',
      title: 'Already recorded as cc-api in state?',
      note: 'Yes: it stays on the Cloud Control API, apart from a few types that move back.',
    },
    {
      id: 'exists',
      title: 'Does an SDK provider exist for the type?',
      note: 'No: the Cloud Control API handles it.',
    },
    {
      id: 'covers',
      title: 'Does it handle every top-level property in the template?',
      note: 'No: it goes through the Cloud Control API, so the property reaches AWS.',
    },
    { id: 'sdk', title: 'SDK provider', route: true, note: 'The fast path.' },
  ],
};

const mixedEstates: Diagram = {
  id: 'guide-mixed-estates',
  title: 'Where a cross-stack reference is resolved',
  description:
    'A cdkd deploy that meets Fn::ImportValue or Fn::GetStackOutput looks in cdkd state first. A value found there is used. On a miss, it asks CloudFormation: ListExports for Fn::ImportValue, DescribeStacks outputs for Fn::GetStackOutput. A value found there is used as a weak reference that nothing records. If CloudFormation has no such value either, the deploy fails with the not-found error.',
  rows: [['ref'], ['cdkd'], ['cfn'], ['fail']],
  edges: [
    { from: 'ref', to: 'cdkd' },
    { from: 'cdkd', to: 'cfn', label: 'not found' },
    { from: 'cfn', to: 'fail', label: 'not found' },
  ],
  nodes: [
    {
      id: 'ref',
      title: 'Reference in a stack cdkd deploys',
      mono: true,
      detail: ['Fn::ImportValue', 'Fn::GetStackOutput'],
    },
    {
      id: 'cdkd',
      title: 'cdkd state',
      route: true,
      note: 'Found: the value is used. A name both engines export resolves here.',
    },
    {
      id: 'cfn',
      title: 'CloudFormation',
      mono: true,
      detail: ['ListExports', 'DescribeStacks'],
      note: 'Found: the value is used, as a weak reference that nothing records.',
    },
    { id: 'fail', title: 'The deploy fails: not found' },
  ],
};

const crossStack: Diagram = {
  id: 'guide-cross-stack',
  title: 'Strong and weak cross-stack references',
  description:
    'A producer stack publishes outputs. A consumer that reads one with Fn::ImportValue holds a strong reference: cdkd records the import, and cdkd destroy refuses to destroy the producer while that consumer exists. A consumer that reads one with Fn::GetStackOutput holds a weak reference: the producer can be destroyed at any time, and the consumer then fails the next time it resolves the value.',
  rows: [['producer'], ['strong', 'weak']],
  edges: [
    { from: 'producer', to: 'strong', label: 'Fn::ImportValue' },
    { from: 'producer', to: 'weak', label: 'Fn::GetStackOutput' },
  ],
  nodes: [
    { id: 'producer', title: 'Producer stack', detail: ['Publishes outputs'] },
    {
      id: 'strong',
      title: 'Strong reference',
      route: true,
      detail: [
        'cdkd records the import',
        'Destroying the producer is refused while this consumer exists',
      ],
    },
    {
      id: 'weak',
      title: 'Weak reference',
      detail: [
        'The producer can be destroyed at any time',
        'The consumer then fails the next time it resolves the value',
      ],
    },
  ],
};

export const guideDiagrams: Diagram[] = [
  waitModes,
  rollbackUndo,
  driftVsDiff,
  orphanVsDestroy,
  provisioningRoute,
  mixedEstates,
  crossStack,
];
