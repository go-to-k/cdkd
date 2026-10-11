// Diagrams for the docs pages of this area, by the id a page's fence names
// (```text diagram=<id>). index.ts registers them.
import type { Diagram } from './render.js';

const prFlow: Diagram = {
  id: 'contrib-pr-flow',
  title: 'From a branch to a merged pull request',
  description:
    'You run the local checks on your branch (vp run check, vp test run and vp run build) and open a pull request with a conventional-commit title, tests and a changelog entry. CI then runs format, lint, type checks, the unit tests and the build. For the paths listed in the table that follows, the maintainer also runs an integration test. Once both are green, the maintainer squash-merges the pull request.',
  rows: [['branch'], ['local'], ['pr'], ['ci', 'integ'], ['merge']],
  nodes: [
    { id: 'branch', title: 'Your branch' },
    {
      id: 'local',
      title: 'Local checks',
      mono: true,
      detail: ['vp run check && vp test run && vp run build'],
    },
    {
      id: 'pr',
      title: 'Pull request',
      route: true,
      detail: ['Conventional-commit title, tests, changelog entry'],
    },
    { id: 'ci', title: 'CI', detail: ['Format, lint, types, unit tests, build'] },
    {
      id: 'integ',
      title: 'Integration run',
      detail: ['Only for the paths in the table below', 'The maintainer runs it'],
    },
    {
      id: 'merge',
      title: 'Squash merge',
      detail: ['By the maintainer, once both are green'],
    },
  ],
};

const workGraph: Diagram = {
  id: 'contrib-work-graph',
  title: 'The work graph that schedules assets and stacks',
  description:
    'A Docker asset is an asset-build node (the image build, four at a time) followed by an asset-publish node. A file asset starts at asset-publish, which uploads to S3 or pushes to ECR, eight at a time. A stack node, which runs DeployEngine for one stack, four at a time, waits for all of its asset-publish nodes. A stack that depends on another stack waits for that stack.',
  rows: [['build'], ['publish'], ['stack'], ['dependent']],
  nodes: [
    {
      id: 'build',
      title: 'asset-build',
      detail: ['Docker image build'],
      note: '4 at a time. Docker assets only.',
    },
    {
      id: 'publish',
      title: 'asset-publish',
      detail: ['S3 upload or ECR push'],
      note: '8 at a time. A file asset starts here.',
    },
    {
      id: 'stack',
      title: 'stack',
      route: true,
      detail: ['DeployEngine, for one stack'],
      note: '4 at a time',
    },
    { id: 'dependent', title: 'stack', detail: ['A stack that depends on it'] },
  ],
};

const providerRouting: Diagram = {
  id: 'contrib-provider-routing',
  title: 'How the provider registry routes a resource',
  description:
    'ProviderRegistry receives each resource in the template and picks one of three providers. Custom::* types go to the custom resource provider. A resource whose type is registered and whose every property is handled goes to the SDK provider. A resource with no SDK provider, or whose template sets a property the SDK provider does not handle, goes to the Cloud Control provider.',
  rows: [['resource'], ['registry'], ['custom', 'sdk', 'cc']],
  nodes: [
    { id: 'resource', title: 'Resource in the template' },
    { id: 'registry', title: 'ProviderRegistry' },
    { id: 'custom', title: 'Custom resource provider', detail: ['Custom::* types'] },
    {
      id: 'sdk',
      title: 'SDK provider',
      route: true,
      detail: ['The type is registered and every property is handled'],
    },
    {
      id: 'cc',
      title: 'Cloud Control provider',
      detail: ['No SDK provider, or the template sets a property the SDK provider does not handle'],
    },
  ],
};

const integRun: Diagram = {
  id: 'contrib-integ-run',
  title: 'What a verify.sh run does',
  description:
    'verify.sh builds cdkd and installs the dependencies of the fixture, then runs cdkd deploy, which creates real resources in the AWS account. It asserts against AWS by reading each resource back with the AWS CLI. Optionally it redeploys in a test mode: update, removal or failure injection. It then runs cdkd destroy and asserts that nothing is left: every resource is gone and there is no state for the stack.',
  rows: [['build'], ['deploy'], ['assert'], ['mode'], ['destroy'], ['clean']],
  nodes: [
    { id: 'build', title: "Build cdkd, install the fixture's dependencies" },
    {
      id: 'deploy',
      title: 'cdkd deploy',
      route: true,
      note: 'Real resources in the AWS account',
    },
    {
      id: 'assert',
      title: 'Assert against AWS',
      note: 'Read each resource back with the AWS CLI',
    },
    {
      id: 'mode',
      title: 'Redeploy in a test mode',
      note: 'Optional: update, removal, failure injection',
    },
    { id: 'destroy', title: 'cdkd destroy', route: true },
    {
      id: 'clean',
      title: 'Assert nothing is left',
      note: 'Every resource gone, no state for the stack',
    },
  ],
};

export const contributingDiagrams: Diagram[] = [prFlow, workGraph, providerRouting, integRun];
