// Diagrams for the docs pages of this area, by the id a page's fence names
// (```text diagram=<id>). index.ts registers them.
import type { Diagram } from './render.js';

const valueResolution: Diagram = {
  id: 'local-value-resolution',
  title: 'Where a local container gets each environment value',
  description:
    'Each environment value in the synthesized template is one of three kinds. A literal is passed through unchanged. An intrinsic such as Ref or Fn::GetAtt is resolved from cdkd state under --from-state or from a CloudFormation stack under --from-cfn-stack, and is dropped with a warning when neither flag is given. A {{resolve:...}} dynamic reference is looked up with your own credentials, and a failed lookup stops the command. An entry in the --env-vars file replaces any of the three, and the result becomes the container environment.',
  rows: [['template'], ['literal', 'intrinsic', 'dynref'], ['override'], ['container']],
  nodes: [
    { id: 'template', title: 'Value in the synthesized template' },
    { id: 'literal', title: 'Literal', detail: ['Passed through unchanged'] },
    {
      id: 'intrinsic',
      title: 'Intrinsic (Ref, Fn::GetAtt, ...)',
      route: true,
      detail: [
        '--from-state: cdkd S3 state',
        '--from-cfn-stack: CloudFormation',
        'Neither: dropped with a warning',
      ],
    },
    {
      id: 'dynref',
      title: '{{resolve:...}}',
      detail: ['Looked up with your credentials', 'A failed lookup stops the command'],
    },
    {
      id: 'override',
      title: '--env-vars file',
      note: 'Replaces any of the three; an overridden key is never looked up',
    },
    { id: 'container', title: 'Container environment' },
  ],
};

const runTaskNetwork: Diagram = {
  id: 'local-run-task-network',
  title: 'The Docker network cdkd local run-task creates for one task',
  description:
    'Your machine reaches each task container on its published ports, bound to 127.0.0.1 by default. The task containers and the ECS metadata sidecar share one Docker network on subnet 169.254.170.0/24. Containers reach each other by container name, and reach the sidecar at 169.254.170.2 for task metadata and credentials.',
  rows: [['host'], ['app', 'sibling'], ['sidecar']],
  edges: [
    { from: 'host', to: 'app', label: 'published ports' },
    { from: 'host', to: 'sibling', label: 'published ports' },
    { from: 'app', to: 'sidecar', label: 'metadata, credentials' },
    { from: 'sibling', to: 'sidecar' },
  ],
  nodes: [
    { id: 'host', title: 'Your machine', detail: ['127.0.0.1:<hostPort>'] },
    {
      id: 'app',
      title: 'Task container',
      detail: ['Network alias: its container name'],
    },
    {
      id: 'sibling',
      title: 'Sibling container',
      detail: ['Network alias: its container name'],
    },
    {
      id: 'sidecar',
      title: 'ECS metadata sidecar',
      detail: ['169.254.170.2'],
      note: 'Network cdkd-local-task-<random>, subnet 169.254.170.0/24',
    },
  ],
};

export const localDiagrams: Diagram[] = [valueResolution, runTaskNetwork];
