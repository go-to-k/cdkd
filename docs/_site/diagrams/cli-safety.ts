// Diagrams for the docs pages of this area, by the id a page's fence names
// (```text diagram=<id>). index.ts registers them.
import type { Diagram } from './render.js';

const replacementGuard: Diagram = {
  id: 'safety-replacement-guard',
  title: 'What cdkd decides when a deploy has to replace a resource',
  description:
    'A deploy has to replace a resource, which means deleting the old one and creating a new one. If the type is not stateful, the resource is replaced with no flag. If it is stateful and declares UpdateReplacePolicy: Retain, the new resource is created and the old one is kept in AWS, no longer tracked. If it is stateful without Retain and --force-stateful-recreation was not passed, the deploy is refused and nothing is deleted. With --force-stateful-recreation the old resource is deleted and re-created, and all data in it is lost.',
  rows: [
    ['replace', null],
    ['stateful', 'plain'],
    ['retain', 'kept'],
    ['flag', 'refused'],
    ['lost', null],
  ],
  edges: [
    { from: 'replace', to: 'stateful' },
    { from: 'stateful', to: 'plain', label: 'no' },
    { from: 'stateful', to: 'retain', label: 'yes' },
    { from: 'retain', to: 'kept', label: 'yes' },
    { from: 'retain', to: 'flag', label: 'no' },
    { from: 'flag', to: 'refused', label: 'no' },
    { from: 'flag', to: 'lost', label: 'yes' },
  ],
  nodes: [
    {
      id: 'replace',
      title: 'A deploy has to replace a resource',
      detail: ['Delete the old one, create a new one'],
    },
    {
      id: 'stateful',
      title: 'Is the type stateful?',
      detail: ['A database, a bucket, a log group, a key'],
    },
    { id: 'plain', title: 'Replaced', detail: ['No flag needed'] },
    { id: 'retain', title: 'UpdateReplacePolicy: Retain?' },
    {
      id: 'kept',
      title: 'New one created, old one kept',
      detail: ['The old resource stays in AWS, no longer tracked'],
    },
    { id: 'flag', title: '--force-stateful-recreation passed?' },
    { id: 'refused', title: 'Refused', detail: ['Nothing is deleted'] },
    {
      id: 'lost',
      title: 'Deleted and re-created',
      route: true,
      detail: ['All data in the old resource is lost'],
    },
  ],
};

const rollbackReplay: Diagram = {
  id: 'rollback-replay',
  title: 'What cdkd rollback reverts and what it leaves',
  description:
    'A deploy that fails without a completed rollback leaves a rollback journal beside the state file, listing every operation it completed. cdkd rollback replays that journal newest first. It reverts three kinds of operation: a created resource is deleted following its DeletionPolicy, an updated resource gets its previous properties back, and a replaced resource is re-created while the new one is deleted. It leaves three things as they are: a resource the deploy deleted, which cannot be restored; the operation that failed, unless --revert-failed is passed; and any resource named by --orphan.',
  rows: [['failed'], ['journal'], ['replay'], ['reverted', 'left']],
  edges: [
    { from: 'failed', to: 'journal' },
    { from: 'journal', to: 'replay' },
    { from: 'replay', to: 'reverted' },
    { from: 'replay', to: 'left' },
  ],
  nodes: [
    {
      id: 'failed',
      title: 'A deploy fails and is not rolled back',
      note: '--no-rollback, Ctrl-C, or an automatic rollback that died partway',
    },
    {
      id: 'journal',
      title: 'Rollback journal',
      note: 'rollback-journal.json beside state.json: every operation the deploy completed',
    },
    {
      id: 'replay',
      title: 'cdkd rollback',
      route: true,
      note: 'Replays the journal newest first; no CDK app needed',
    },
    {
      id: 'reverted',
      title: 'Reverted',
      detail: [
        'Created: deleted, following DeletionPolicy',
        'Updated: previous properties restored',
        'Replaced: old one re-created, new one deleted',
      ],
    },
    {
      id: 'left',
      title: 'Left as it is',
      detail: [
        'Deleted: cannot be restored',
        'The operation that failed, unless --revert-failed',
        'Anything named by --orphan',
      ],
    },
  ],
};

export const cliSafetyDiagrams: Diagram[] = [replacementGuard, rollbackReplay];
