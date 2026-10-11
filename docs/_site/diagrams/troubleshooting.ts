// Diagrams for the docs pages of this area, by the id a page's fence names
// (```text diagram=<id>). index.ts registers them.
import type { Diagram } from './render.js';

const lockHeld: Diagram = {
  id: 'troubleshooting-lock-held',
  title: 'What to do about a lock error',
  description:
    'A lock error names the process holding the lock. If that process is still running, wait for it and re-run. If it is gone, for example a cancelled CI job or a killed process, run cdkd force-unlock as the message prints it.',
  rows: [['error'], ['running', 'gone'], [null, 'unlock']],
  edges: [
    { from: 'error', to: 'running' },
    { from: 'error', to: 'gone' },
    { from: 'gone', to: 'unlock' },
  ],
  nodes: [
    { id: 'error', title: 'Lock error names the holder' },
    { id: 'running', title: 'Holder still running', detail: ['Wait, then re-run'] },
    { id: 'gone', title: 'Holder is gone', detail: ['Cancelled CI job, killed process'] },
    {
      id: 'unlock',
      title: 'cdkd force-unlock',
      route: true,
      detail: ['As the message prints it'],
    },
  ],
};

const afterFailedDeploy: Diagram = {
  id: 'troubleshooting-after-failed-deploy',
  title: 'Options after a failed or interrupted deploy',
  description:
    'When a deploy fails or is stopped, the default automatic rollback reverts what the deploy completed. With --no-rollback, after Ctrl+C, or when the rollback itself died, partial state and a rollback journal are kept, and there are three ways on: cdkd deploy to fix forward, cdkd rollback to revert to the pre-deploy state, or cdkd destroy to clean up.',
  rows: [['failed'], ['auto', 'partial'], ['forward', 'revert', 'destroy']],
  edges: [
    { from: 'failed', to: 'auto' },
    { from: 'failed', to: 'partial' },
    { from: 'partial', to: 'forward' },
    { from: 'partial', to: 'revert' },
    { from: 'partial', to: 'destroy' },
  ],
  nodes: [
    { id: 'failed', title: 'Deploy fails or is stopped' },
    {
      id: 'auto',
      title: 'Automatic rollback (default)',
      detail: ['Reverts what the deploy completed'],
    },
    {
      id: 'partial',
      title: '--no-rollback, Ctrl+C, or a rollback that died',
      detail: ['Partial state and a journal are kept'],
    },
    { id: 'forward', title: 'cdkd deploy', detail: ['Fix forward'] },
    { id: 'revert', title: 'cdkd rollback', route: true, detail: ['Revert'] },
    { id: 'destroy', title: 'cdkd destroy', detail: ['Clean up'] },
  ],
};

export const troubleshootingDiagrams: Diagram[] = [lockHeld, afterFailedDeploy];
