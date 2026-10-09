// The diagrams the docs draw, by the id a page's fence names
// (```text diagram=<id>). Each follows the text diagram it replaces on the
// site; the Markdown keeps that text, so the two are edited together.
import type { Diagram } from './render.js';

const howItWorks: Diagram = {
  id: 'how-it-works',
  title: 'How cdkd deploys a CDK app',
  description:
    'Your CDK app, using aws-cdk-lib, is synthesized by cdkd, which runs it as a subprocess and parses the Cloud Assembly into a CloudFormation template. Assets are built and published: an S3 zip upload, or an ECR image build and push. The cdkd engine builds the dependency graph, compares it with the existing resources, and starts each resource as soon as its dependencies finish, through SDK providers or, as the fallback for many additional types, the Cloud Control API.',
  rows: [['app'], ['synth'], ['template'], ['assets'], ['engine'], ['sdk', 'cc']],
  nodes: [
    { id: 'app', title: 'Your CDK app', note: 'aws-cdk-lib' },
    { id: 'synth', title: 'cdkd synthesis', note: 'Subprocess and Cloud Assembly parser' },
    { id: 'template', title: 'CloudFormation template' },
    {
      id: 'assets',
      title: 'Asset build and publish',
      note: 'S3 zip upload; ECR image build and push',
    },
    {
      id: 'engine',
      title: 'cdkd engine',
      route: true,
      detail: [
        'DAG analysis: the dependency graph',
        'Diff: compared with existing resources',
        'Parallel execution: each resource starts once its dependencies finish',
      ],
    },
    { id: 'sdk', title: 'SDK providers' },
    { id: 'cc', title: 'Cloud Control API', note: 'Fallback for many additional types' },
  ],
};

const layers: Diagram = {
  id: 'layers',
  title: 'cdkd layers and the modules in each',
  description:
    'The CLI layer (src/cli/) calls the synthesis layer (src/synthesis/), which feeds the assets layer (src/assets/) and the analysis layer (src/analyzer/). The analysis layer feeds the state layer (src/state/) and the deployment layer (src/deployment/), and the deployment layer calls the provisioning layer (src/provisioning/).',
  rows: [
    ['cli'],
    ['synthesis'],
    ['assets', 'analysis'],
    ['state', 'deployment'],
    [null, 'provisioning'],
  ],
  edges: [
    { from: 'cli', to: 'synthesis' },
    { from: 'synthesis', to: 'assets' },
    { from: 'synthesis', to: 'analysis' },
    { from: 'analysis', to: 'state' },
    { from: 'analysis', to: 'deployment' },
    { from: 'deployment', to: 'provisioning' },
  ],
  nodes: [
    {
      id: 'cli',
      title: 'CLI layer',
      mono: true,
      detail: [
        'src/cli/',
        'commands/: deploy, diff, destroy, synth, bootstrap',
        'options.ts: CLI option definitions',
      ],
    },
    {
      id: 'synthesis',
      title: 'Synthesis layer',
      mono: true,
      detail: [
        'src/synthesis/',
        'app-executor.ts: CDK app execution via child_process',
        'assembly-reader.ts: manifest.json / template parser',
        'synthesizer.ts: context provider loop orchestrator',
        'context-store.ts: cdk.context.json read / write',
        'context-providers/: missing context resolution',
      ],
    },
    {
      id: 'assets',
      title: 'Assets layer',
      mono: true,
      detail: [
        'src/assets/',
        'file-asset-publisher.ts',
        'docker-asset-publisher.ts',
        'asset-publisher.ts (orchestrator)',
      ],
    },
    {
      id: 'analysis',
      title: 'Analysis layer',
      mono: true,
      detail: [
        'src/analyzer/',
        'template-parser.ts',
        'dag-builder.ts',
        'diff-calculator.ts',
        'intrinsic-function-resolver.ts',
      ],
    },
    {
      id: 'state',
      title: 'State layer',
      mono: true,
      detail: ['src/state/', 's3-state-backend.ts', 'lock-manager.ts', 'types/state.ts (schema)'],
    },
    {
      id: 'deployment',
      title: 'Deployment layer',
      mono: true,
      detail: ['src/deployment/', 'deploy-engine.ts', 'intrinsic-function-resolver.ts'],
    },
    {
      id: 'provisioning',
      title: 'Provisioning layer',
      mono: true,
      detail: [
        'src/provisioning/',
        'provider-registry.ts',
        'cloud-control-provider.ts',
        'providers/',
        'json-patch-generator.ts',
      ],
    },
  ],
};

const synthesizerLoop: Diagram = {
  id: 'synthesizer-loop',
  title: 'The synthesizer’s context provider loop',
  description:
    'The synthesizer executes the CDK app with AppExecutor and reads the cloud assembly with AssemblyReader, then checks the manifest for missing context. If context is missing, it resolves it through the ContextProviderRegistry, saves it to cdk.context.json with ContextStore, and executes the app again from the first step. Once nothing is missing, it returns the final assembly with its stacks and asset manifests.',
  rows: [
    ['execute', null],
    ['read', null],
    ['check', 'resolve'],
    ['done', 'save'],
    [null, 'again'],
  ],
  edges: [
    { from: 'execute', to: 'read' },
    { from: 'read', to: 'check' },
    { from: 'check', to: 'resolve', label: 'missing' },
    { from: 'resolve', to: 'save' },
    { from: 'save', to: 'again' },
    { from: 'check', to: 'done', label: 'none missing' },
  ],
  loops: [{ from: 'again', to: 'execute', label: 'back to the first step' }],
  nodes: [
    { id: 'execute', title: 'Execute the CDK app', mono: true, detail: ['AppExecutor'] },
    { id: 'read', title: 'Read the cloud assembly', mono: true, detail: ['AssemblyReader'] },
    { id: 'check', title: 'Check the manifest for missing context' },
    {
      id: 'resolve',
      title: 'Resolve the missing context',
      mono: true,
      detail: ['ContextProviderRegistry'],
    },
    {
      id: 'save',
      title: 'Save it to cdk.context.json',
      mono: true,
      detail: ['ContextStore'],
    },
    { id: 'again', title: 'Execute the app again with the updated context' },
    {
      id: 'done',
      title: 'Return the final assembly',
      note: 'With its stacks and asset manifests',
    },
  ],
};

const synthesisFlow: Diagram = {
  id: 'synthesis-flow',
  title: 'The synthesis flow',
  description:
    'The CDK app named by --app, CDKD_APP or the "app" field of cdk.json is run by AppExecutor.execute() through child_process.spawn(), with CDK_OUTDIR, CDK_CONTEXT_JSON and CDK_DEFAULT_REGION and ACCOUNT set. It writes manifest.json and each stack’s template and asset manifest to cdk.out/. AssemblyReader parses manifest.json; missing context is resolved through the providers and the app synthesized again if needed; the final assembly is returned with its stacks and asset manifests.',
  rows: [['app'], ['execute'], ['output'], ['read'], ['context'], ['done']],
  nodes: [
    { id: 'app', title: 'Your CDK app', note: '--app, CDKD_APP, or the "app" field of cdk.json' },
    {
      id: 'execute',
      title: 'AppExecutor.execute()',
      mono: true,
      detail: ['child_process.spawn()'],
      note: 'With CDK_OUTDIR, CDK_CONTEXT_JSON and CDK_DEFAULT_REGION / ACCOUNT',
    },
    {
      id: 'output',
      title: 'Output to cdk.out/',
      mono: true,
      detail: ['manifest.json', '{StackName}.template.json', '{StackName}.assets.json'],
    },
    { id: 'read', title: 'AssemblyReader parses manifest.json' },
    {
      id: 'context',
      title: 'Check for missing context',
      note: 'Resolved through the providers, and synthesized again if needed',
    },
    {
      id: 'done',
      title: 'Return the final assembly',
      note: 'With its stacks and asset manifests',
    },
  ],
};

const deployCreate: Diagram = {
  id: 'deploy-create',
  title: 'A first deployment, where every resource is created',
  description:
    'cdkd deploy goes through the CLI layer, which resolves --app and --state-bucket, and the synthesis layer, which runs the CDK app and parses the cloud assembly. Per stack, pipelined, the assets layer publishes to S3 and ECR, skipping what exists (8 file and 4 Docker assets at a time). The state layer acquires the lock and finds no state; the analysis layer parses the template, builds the DAG and diffs everything as a CREATE. The deployment layer runs the deploy engine through SDK providers, preferred, or the Cloud Control provider as the fallback, and the state layer then resolves outputs, saves state and releases the lock.',
  rows: [
    ['user'],
    ['cli'],
    ['synth'],
    ['assets'],
    ['lock'],
    ['analysis'],
    ['deploy'],
    ['sdk', 'cc'],
    ['save'],
  ],
  edges: [
    { from: 'user', to: 'cli' },
    { from: 'cli', to: 'synth' },
    { from: 'synth', to: 'assets', label: 'per stack, pipelined' },
    { from: 'assets', to: 'lock' },
    { from: 'lock', to: 'analysis' },
    { from: 'analysis', to: 'deploy' },
    { from: 'deploy', to: 'sdk' },
    { from: 'deploy', to: 'cc' },
    { from: 'sdk', to: 'save' },
    { from: 'cc', to: 'save' },
  ],
  nodes: [
    { id: 'user', title: '$ cdkd deploy' },
    {
      id: 'cli',
      title: 'CLI layer',
      mono: true,
      detail: ['config-loader'],
      note: '--app (or CDKD_APP / cdk.json), --state-bucket (or env / cdk.json)',
    },
    {
      id: 'synth',
      title: 'Synthesis layer',
      detail: [
        'AppExecutor runs the CDK app via child_process.spawn()',
        'AssemblyReader parses manifest.json from cdk.out/',
        'Synthesizer resolves missing context',
      ],
    },
    {
      id: 'assets',
      title: 'Assets layer',
      detail: ['Publish to S3 / ECR', 'Skip what already exists'],
      note: 'File: 8 at a time; Docker: 4 at a time',
    },
    { id: 'lock', title: 'State layer', detail: ['Acquire the lock', 'Get state (none yet)'] },
    {
      id: 'analysis',
      title: 'Analysis layer',
      detail: ['Parse the template', 'Build the DAG', 'Diff: every resource is a CREATE'],
    },
    {
      id: 'deploy',
      title: 'Deployment layer',
      route: true,
      detail: ['Deploy engine', 'Execute by levels'],
    },
    {
      id: 'sdk',
      title: 'SDK providers',
      detail: ['Preferred', 'S3, Lambda, IAM, DynamoDB, SQS, SNS, and more'],
    },
    {
      id: 'cc',
      title: 'Cloud Control provider',
      detail: ['Fallback', 'Many types', 'Async polling'],
    },
    {
      id: 'save',
      title: 'State layer',
      detail: ['Resolve outputs', 'Save state', 'Release the lock'],
    },
  ],
};

const deployUpdate: Diagram = {
  id: 'deploy-update',
  title: 'An update deployment',
  description:
    'Up to synthesis an update runs as a first deployment does. The analysis layer diffs the current state against the template, which gives UPDATE operations; the provisioning layer generates a JSON Patch from the old properties to the new ones and applies it with the Cloud Control API UpdateResource().',
  rows: [['same'], ['analysis'], ['provisioning']],
  nodes: [
    { id: 'same', title: 'As a first deployment, up to synthesis' },
    {
      id: 'analysis',
      title: 'Analysis layer',
      detail: ['Diff the current state against the template', 'Gives an UPDATE'],
    },
    {
      id: 'provisioning',
      title: 'Provisioning layer',
      route: true,
      detail: ['JSON Patch generator: old properties to new', 'Cloud Control API UpdateResource()'],
    },
  ],
};

const deployDestroy: Diagram = {
  id: 'deploy-destroy',
  title: 'Destroying a stack',
  description:
    'cdkd destroy goes through the CLI layer (a stack name, --app, --force or --all). The state layer gets the state, rebuilds the DAG from its recorded dependencies and applies the implicit type-based delete dependencies. The deployment layer sorts it in reverse topological order, and the provisioning layer calls each provider’s delete() in reverse dependency order.',
  rows: [['user'], ['cli'], ['state'], ['deployment'], ['provisioning']],
  nodes: [
    { id: 'user', title: '$ cdkd destroy' },
    {
      id: 'cli',
      title: 'CLI layer',
      mono: true,
      detail: ['destroy.ts'],
      note: '<stackName>, --app, --force, --all (synth-based)',
    },
    {
      id: 'state',
      title: 'State layer',
      detail: [
        'Get state',
        'Rebuild the DAG from state.dependencies',
        'Apply the implicit type-based delete dependencies (analyzer/implicit-delete-deps.ts)',
      ],
    },
    {
      id: 'deployment',
      title: 'Deployment layer',
      detail: ['Reverse topological sort: delete in reverse'],
    },
    {
      id: 'provisioning',
      title: 'Provisioning layer',
      route: true,
      detail: ['Provider.delete() in reverse dependency order'],
    },
  ],
};

const contextLoop: Diagram = {
  id: 'context-loop',
  title: 'The context provider resolution loop',
  description:
    'Synthesizer.synthesize() has AppExecutor spawn the CDK app with CDK_OUTDIR, CDK_CONTEXT_JSON and CDK_DEFAULT_REGION set, and AssemblyReader reads manifest.json. If the manifest has missing context entries, the ContextProviderRegistry resolves each one, ContextStore saves them to cdk.context.json, and the app is synthesized again. If nothing is missing, the final assembly is returned.',
  rows: [
    ['synthesizer', null],
    ['executor', null],
    ['reader', null],
    ['missing', 'registry'],
    ['done', 'store'],
  ],
  edges: [
    { from: 'synthesizer', to: 'executor' },
    { from: 'executor', to: 'reader' },
    { from: 'reader', to: 'missing' },
    { from: 'missing', to: 'registry', label: 'yes' },
    { from: 'missing', to: 'done', label: 'no' },
    { from: 'registry', to: 'store' },
  ],
  loops: [{ from: 'store', to: 'executor', label: 're-synthesize' }],
  nodes: [
    { id: 'synthesizer', title: 'Synthesizer', mono: true, detail: ['synthesize()'] },
    {
      id: 'executor',
      title: 'AppExecutor',
      mono: true,
      detail: ['spawn(cdkApp)', 'env: CDK_OUTDIR, CDK_CONTEXT_JSON, CDK_DEFAULT_REGION'],
    },
    { id: 'reader', title: 'AssemblyReader', mono: true, detail: ['read manifest.json'] },
    { id: 'missing', title: 'Missing context?', detail: ['The manifest’s missing entries'] },
    {
      id: 'registry',
      title: 'ContextProviderRegistry',
      mono: true,
      detail: ['resolve(key, props)'],
      note: 'Every CDK context provider type; see context-providers/',
    },
    { id: 'done', title: 'Return the final assembly' },
    { id: 'store', title: 'ContextStore', mono: true, detail: ['save to cdk.context.json'] },
  ],
};

export const DIAGRAMS: Record<string, Diagram> = Object.fromEntries(
  [
    howItWorks,
    layers,
    synthesizerLoop,
    synthesisFlow,
    deployCreate,
    deployUpdate,
    deployDestroy,
    contextLoop,
  ].map((diagram) => [diagram.id, diagram]),
);
