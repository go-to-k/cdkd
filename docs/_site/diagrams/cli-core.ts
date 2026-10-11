// Diagrams for the docs pages of this area, by the id a page's fence names
// (```text diagram=<id>). index.ts registers them.
import type { Diagram } from './render.js';

const roleArnIdentities: Diagram = {
  id: 'cli-role-arn-identities',
  title: 'Which identity each AWS call runs as under --role-arn',
  description:
    'Your base credentials, from --profile, AWS_PROFILE or the default chain, answer one STS AssumeRole call at command start. cdkd passes the resulting temporary credentials explicitly to every AWS client it builds, so its own calls always run as the role. It also exports them as AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY and AWS_SESSION_TOKEN for the programs it starts, such as your CDK app during synthesis. Those programs run as the role only while no profile is selected; with a profile selected the AWS SDK ignores the exported variables and they run as the profile.',
  rows: [['base'], ['assume'], ['own', 'child']],
  edges: [
    { from: 'base', to: 'assume' },
    { from: 'assume', to: 'own', label: 'passed to each client' },
    { from: 'assume', to: 'child', label: 'exported as AWS_* variables' },
  ],
  nodes: [
    {
      id: 'base',
      title: 'Your base credentials',
      note: '--profile, AWS_PROFILE, or the default chain',
    },
    {
      id: 'assume',
      title: 'STS AssumeRole',
      route: true,
      note: 'Once, at command start; a 1-hour session',
    },
    {
      id: 'own',
      title: 'AWS calls cdkd makes',
      detail: ['Always the role'],
    },
    {
      id: 'child',
      title: 'Programs cdkd starts',
      detail: [
        'Your CDK app during synthesis',
        'No profile selected: the role',
        'Profile selected: the profile',
      ],
    },
  ],
};

const stackLock: Diagram = {
  id: 'cli-stack-lock',
  title: 'How a deploy takes and releases a stack lock',
  description:
    'cdkd deploy tries to take the lock for one stack in one region. If the lock is free, or held but expired, the deploy takes it, renews it while it works on the stack, and releases it when that work finishes, which can be before the resources it created finish provisioning. If another run holds the lock, the deploy waits two seconds and tries again, up to three times, and then fails naming the holder.',
  rows: [['start'], ['acquire'], ['work', 'wait'], ['release', 'fail']],
  edges: [
    { from: 'start', to: 'acquire' },
    { from: 'acquire', to: 'work', label: 'free, or expired' },
    { from: 'acquire', to: 'wait', label: 'held by another run' },
    { from: 'work', to: 'release' },
    { from: 'wait', to: 'fail', label: 'still held after 3 retries' },
  ],
  loops: [{ from: 'wait', to: 'acquire', label: 'try again' }],
  nodes: [
    { id: 'start', title: '$ cdkd deploy MyStack' },
    {
      id: 'acquire',
      title: 'Take the lock',
      route: true,
      note: 'One lock per stack per region',
    },
    {
      id: 'work',
      title: 'Work on the stack',
      detail: ['The lock is renewed while the run is alive'],
    },
    { id: 'wait', title: 'Wait 2 seconds' },
    {
      id: 'release',
      title: 'Release the lock',
      detail: ['When the work finishes, not when the resources finish provisioning'],
    },
    { id: 'fail', title: 'Fail', detail: ['Names the holder when the lock is readable'] },
  ],
};

const assetDestinations: Diagram = {
  id: 'cli-asset-destinations',
  title: 'Where a deploy publishes assets bound for CDK bootstrap storage',
  description:
    'cdkd deploy looks for the bootstrap marker of the region it deploys into. If the marker exists, assets go to the cdkd-owned asset bucket and ECR repository. If there is no marker, the deploy offers to create the asset storage: once created, assets go to the cdkd-owned storage; if the prompt is declined, the creation fails, or auto-creation is opted out of, assets go to the CDK bootstrap bucket and repository named by the asset manifest, which is legacy mode.',
  rows: [['marker'], ['auto', 'owned'], ['legacy', null]],
  edges: [
    { from: 'marker', to: 'auto', label: 'no marker' },
    { from: 'marker', to: 'owned', label: 'marker exists' },
    { from: 'auto', to: 'owned', label: 'created' },
    { from: 'auto', to: 'legacy', label: 'declined, failed, or opted out' },
  ],
  nodes: [
    {
      id: 'marker',
      title: 'Read the region’s bootstrap marker',
      mono: true,
      detail: ['cdkd-bootstrap/{region}.json'],
    },
    {
      id: 'auto',
      title: 'Offer to create the asset storage',
      detail: ['cdkd deploy only'],
    },
    {
      id: 'owned',
      title: 'cdkd-owned storage',
      route: true,
      detail: ['Asset bucket and ECR repository', 'Collected by cdkd gc'],
    },
    {
      id: 'legacy',
      title: 'Legacy mode',
      detail: ['CDK bootstrap bucket and repository', 'Within reach of cdk gc'],
    },
  ],
};

export const cliCoreDiagrams: Diagram[] = [roleArnIdentities, stackLock, assetDestinations];
