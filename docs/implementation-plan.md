# cdkq 実装計画書

## 1. プロジェクト概要

**cdkq** (CDK Quick Deploy) は、AWS CDK アプリケーションを CloudFormation スタックを介さずに、SDK/Cloud Control API 経由で直接デプロイする高速デプロイツールです。

### コアコンセプト

- **CDK アプリケーションとの互換性**: 既存の CDK コード(aws-cdk-lib)をそのまま利用可能
- **合成フェーズの委譲**: `@aws-cdk/toolkit-lib` を使用して CDK アプリの合成とコンテキスト解決を完全委譲
- **アセット管理**: `cdk-assets` を使用してアセットのビルドとアップロードを処理
- **ハイブリッドデプロイ**: Cloud Control API を優先し、非対応リソースは個別 SDK で対応
- **S3 ベース状態管理**: S3 の条件付き書き込み機能を使った排他制御とステート管理

### CDK CLI との関係

cdkq は CDK CLI (`aws-cdk`) を**置き換える**のではなく、**デプロイ方法の代替**を提供します。

#### `cdk init` について

**結論**: cdkq では提供しない

- `cdk init` は CDK プロジェクトのスキャフォールディング(テンプレート生成)を行う機能
- cdkq は既存の CDK アプリケーションをデプロイするツールであり、プロジェクト生成は責務外
- **推奨ワークフロー**:
  1. `npx aws-cdk init app --language typescript` で CDK プロジェクト作成
  2. CDK アプリを実装 (aws-cdk-lib を使用)
  3. `cdkq deploy` で高速デプロイ

#### `cdk bootstrap` について

**結論**: cdkq 独自の `bootstrap` コマンドを実装 (Phase 0 で対応)

| 項目 | CDK CLI | cdkq |
|------|---------|------|
| **コマンド** | `cdk bootstrap` | `cdkq bootstrap` |
| **作成リソース** | CloudFormation スタック<br>S3 バケット (アセット用)<br>IAM 実行ロール<br>ECR リポジトリ | S3 バケット (状態管理専用) |
| **権限モデル** | AssumeRole (CloudFormation 実行ロール使用) | 実行者の直接権限 |
| **CloudFormation 依存** | あり | なし |

**重要な違い**:

- **CDK CLI**: CloudFormation のデプロイに必要な基盤 (IAM ロール、アセットバケット) を作成
- **cdkq**: 状態管理用 S3 バケットのみを作成 (CloudFormation 不使用のため IAM ロール不要)

**アセットの扱い**:

- CDK CLI: bootstrap で作成した専用バケットにアセットをアップロード
- cdkq: `cdk-assets` を使用し、CDK が合成時に決定したバケット/キーにアップロード
  - 既存の CDK bootstrap バケットを利用可能
  - または、CDK アプリ側でカスタムバケットを指定可能

---

## 2. 技術スタック

### 依存ライブラリ

```json
{
  "@aws-cdk/toolkit-lib": "^3.x",           // CDK 合成・コンテキスト解決
  "@aws-cdk/cdk-assets-lib": "^3.x",        // アセット管理
  "@aws-sdk/client-s3": "^3.x",             // S3 状態管理・ロック
  "@aws-sdk/client-cloudcontrol": "^3.x",   // Cloud Control API
  "@aws-sdk/client-*": "^3.x",              // 個別サービス SDK
  "graphlib": "^2.x",                       // DAG 依存解析
  "commander": "^12.x",                     // CLI フレームワーク
  "p-limit": "^5.x"                         // 並列実行制御
}
```

### 開発環境

- **言語**: TypeScript 5.x
- **ランタイム**: Node.js 20.x 以上
- **ビルド**: esbuild (高速ビルド・バンドル)
- **テスト**: Vitest
- **リンター**: ESLint + Prettier

---

## 3. アーキテクチャ設計

### ディレクトリ構成

```
cdkq/
├── src/
│   ├── cli/
│   │   ├── index.ts              # CLI エントリーポイント
│   │   ├── commands/
│   │   │   ├── deploy.ts         # deploy コマンド
│   │   │   ├── destroy.ts        # destroy コマンド
│   │   │   ├── diff.ts           # diff コマンド
│   │   │   └── synth.ts          # synth コマンド
│   │   └── options.ts            # 共通オプション定義
│   │
│   ├── synthesis/
│   │   ├── synthesizer.ts        # toolkit-lib ラッパー
│   │   ├── context-resolver.ts   # コンテキスト解決処理
│   │   └── assembly-loader.ts    # CloudAssembly 読み込み
│   │
│   ├── assets/
│   │   ├── asset-publisher.ts    # cdk-assets-lib ラッパー
│   │   └── asset-handler.ts      # アセット処理ロジック
│   │
│   ├── state/
│   │   ├── s3-state-backend.ts   # S3 状態管理
│   │   ├── lock-manager.ts       # S3 条件付き書き込みロック
│   │   └── state-schema.ts       # State/Lock スキーマ定義
│   │
│   ├── analyzer/
│   │   ├── template-parser.ts    # CFn テンプレート解析
│   │   ├── dag-builder.ts        # 依存関係グラフ構築
│   │   └── diff-calculator.ts    # 差分計算
│   │
│   ├── provisioner/
│   │   ├── orchestrator.ts       # デプロイオーケストレーション
│   │   ├── cloud-control/
│   │   │   ├── cc-provider.ts    # Cloud Control API プロバイダ
│   │   │   └── cc-poller.ts      # リソース作成ポーリング
│   │   ├── sdk-providers/
│   │   │   ├── base-provider.ts  # SDK プロバイダ基底クラス
│   │   │   ├── lambda.ts         # Lambda 個別実装
│   │   │   ├── s3.ts             # S3 個別実装
│   │   │   └── index.ts          # プロバイダレジストリ
│   │   └── resource-mapper.ts    # リソースタイプ→プロバイダマッピング
│   │
│   ├── utils/
│   │   ├── logger.ts             # 構造化ログ
│   │   ├── aws-clients.ts        # AWS SDK クライアント管理
│   │   └── error-handler.ts      # エラーハンドリング
│   │
│   └── types/
│       ├── state.ts              # State 型定義
│       ├── resource.ts           # Resource 型定義
│       └── config.ts             # Config 型定義
│
├── tests/
│   ├── unit/                     # ユニットテスト
│   ├── integration/              # 統合テスト
│   └── fixtures/                 # テストフィクスチャ
│
├── docs/
│   ├── implementation-plan.md    # 本ドキュメント
│   ├── architecture.md           # アーキテクチャドキュメント
│   ├── state-management.md       # 状態管理仕様
│   └── provider-development.md   # プロバイダ開発ガイド
│
├── package.json
├── tsconfig.json
├── vitest.config.ts
└── README.md
```

---

## 4. コアモジュール詳細設計

### Phase 1: 合成 (Synthesis)

#### synthesizer.ts - toolkit-lib ラッパー

```typescript
import { Toolkit } from '@aws-cdk/toolkit-lib';

export class Synthesizer {
  async synthesize(appPath: string, stackName?: string): Promise<CloudAssembly> {
    const toolkit = new Toolkit({
      app: appPath,
      contextLookups: true, // コンテキスト解決を自動化
    });

    const assembly = await toolkit.synth({
      stacks: stackName ? [stackName] : undefined,
    });

    return assembly;
  }
}
```

**重要ポイント**:

- `@aws-cdk/toolkit-lib` は 2025年2月に GA 達成
- コンテキストルックアップ(VPC ID 解決等)を自動処理
- `npx cdk` コマンドの代替として完全に機能

---

### Phase 2: アセット処理 (Asset Provisioning)

#### asset-publisher.ts - cdk-assets-lib ラッパー

```typescript
import { AssetPublishing } from '@aws-cdk/cdk-assets-lib';

export class AssetPublisher {
  async publishAssets(manifestPath: string): Promise<void> {
    const publisher = new AssetPublishing({
      manifest: manifestPath,
    });

    await publisher.publish();
  }
}
```

**重要ポイント**:

- アセットの S3 Bucket/Key は合成時に確定済み
- 動的な値注入は不要(CDK が自動でテンプレートに埋め込み済み)
- `@aws-cdk/cdk-assets-lib` v3 で AWS SDK v3 対応

---

### Phase 3: 状態管理 (State Management)

#### s3-state-backend.ts - S3 条件付き書き込み

```typescript
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

export class S3StateBackend {
  constructor(
    private s3: S3Client,
    private bucket: string,
    private prefix: string
  ) {}

  // ロック取得 (If-None-Match: "*" で排他制御)
  async acquireLock(stackName: string, owner: string): Promise<boolean> {
    const key = `${this.prefix}/${stackName}/lock.json`;
    try {
      await this.s3.send(new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: JSON.stringify({ owner, timestamp: Date.now() }),
        IfNoneMatch: '*', // 既存オブジェクトがあれば失敗
      }));
      return true;
    } catch (error) {
      if (error.name === 'PreconditionFailed') return false;
      throw error;
    }
  }

  // ステート読み込み
  async getState(stackName: string): Promise<StackState | null> {
    const key = `${this.prefix}/${stackName}/state.json`;
    try {
      const result = await this.s3.send(new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }));
      return JSON.parse(await result.Body!.transformToString());
    } catch (error) {
      if (error.name === 'NoSuchKey') return null;
      throw error;
    }
  }

  // ステート保存 (ETag による楽観的ロック)
  async saveState(stackName: string, state: StackState, etag?: string): Promise<void> {
    const key = `${this.prefix}/${stackName}/state.json`;
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: JSON.stringify(state),
      ...(etag && { IfMatch: etag }), // ETag が一致する場合のみ更新
    }));
  }

  // ロック解放
  async releaseLock(stackName: string): Promise<void> {
    const key = `${this.prefix}/${stackName}/lock.json`;
    await this.s3.send(new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: key,
    }));
  }
}
```

#### State スキーマ

```typescript
interface StackState {
  version: number;
  stackName: string;
  resources: {
    [logicalId: string]: {
      physicalId: string;        // 実際の AWS リソース ID
      resourceType: string;       // AWS::Lambda::Function 等
      properties: Record<string, any>;
      attributes?: Record<string, any>;  // Fn::GetAtt で使用
      dependencies?: string[];    // DependsOn for proper deletion order
      metadata?: Record<string, any>;
    };
  };
  outputs: Record<string, unknown>;
  lastModified: number;
}
```

---

### Phase 4: 依存関係解析 (DAG Analysis)

#### dag-builder.ts - Ref/GetAtt 解析

```typescript
import { Graph } from 'graphlib';

export class DagBuilder {
  buildDependencyGraph(template: CloudFormationTemplate): Graph {
    const graph = new Graph({ directed: true });

    // 全リソースをノードとして追加
    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      graph.setNode(logicalId, resource);
    }

    // Ref/GetAtt/DependsOn から依存関係エッジを構築
    for (const [logicalId, resource] of Object.entries(template.Resources)) {
      const dependencies = this.extractDependencies(resource);
      dependencies.forEach(dep => {
        if (graph.hasNode(dep)) {
          graph.setEdge(dep, logicalId); // dep → logicalId
        }
      });
    }

    return graph;
  }

  private extractDependencies(resource: any): string[] {
    const deps = new Set<string>();

    // DependsOn 属性
    if (resource.DependsOn) {
      (Array.isArray(resource.DependsOn) ? resource.DependsOn : [resource.DependsOn])
        .forEach(dep => deps.add(dep));
    }

    // Properties 内の Ref/GetAtt を再帰的に探索
    const traverse = (obj: any) => {
      if (obj?.Ref) deps.add(obj.Ref);
      if (obj?.['Fn::GetAtt']) deps.add(obj['Fn::GetAtt'][0]);
      if (typeof obj === 'object' && obj !== null) {
        Object.values(obj).forEach(traverse);
      }
    };
    traverse(resource.Properties);

    return Array.from(deps);
  }

  // トポロジカルソート (並列実行レベル計算)
  getExecutionLevels(graph: Graph): string[][] {
    const levels: string[][] = [];
    const graphCopy = graph.copy();

    while (graphCopy.nodeCount() > 0) {
      // 依存関係のないノード(入次数0)を取得
      const readyNodes = graphCopy.nodes().filter(
        n => graphCopy.predecessors(n)!.length === 0
      );

      if (readyNodes.length === 0) {
        throw new Error('Circular dependency detected');
      }

      levels.push(readyNodes);
      readyNodes.forEach(n => graphCopy.removeNode(n));
    }

    return levels;
  }
}
```

---

### Phase 5: リソースプロビジョニング

#### orchestrator.ts - デプロイオーケストレーション

```typescript
import pLimit from 'p-limit';

export class DeployOrchestrator {
  constructor(
    private stateBackend: S3StateBackend,
    private providerRegistry: ProviderRegistry,
    private concurrency = 10
  ) {}

  async deploy(template: CloudFormationTemplate, stackName: string): Promise<void> {
    // 1. ロック取得
    const lockAcquired = await this.stateBackend.acquireLock(stackName, 'cdkq');
    if (!lockAcquired) throw new Error('Stack is locked by another process');

    try {
      // 2. 既存ステート取得
      const currentState = await this.stateBackend.getState(stackName) || { resources: {} };

      // 3. DAG 構築
      const dagBuilder = new DagBuilder();
      const graph = dagBuilder.buildDependencyGraph(template);
      const levels = dagBuilder.getExecutionLevels(graph);

      // 4. 差分計算
      const diffCalc = new DiffCalculator();
      const changes = diffCalc.calculateDiff(currentState, template);

      // 5. レベル単位で並列実行
      const limit = pLimit(this.concurrency);
      const newState = { ...currentState };

      for (const level of levels) {
        await Promise.all(
          level.map(logicalId =>
            limit(() => this.provisionResource(
              logicalId,
              template.Resources[logicalId],
              changes[logicalId],
              newState
            ))
          )
        );
      }

      // 6. ステート保存
      await this.stateBackend.saveState(stackName, {
        version: 1,
        stackName,
        resources: newState.resources,
        outputs: this.resolveOutputs(template, newState),
        lastModified: Date.now(),
      });

    } finally {
      // 7. ロック解放
      await this.stateBackend.releaseLock(stackName);
    }
  }

  private async provisionResource(
    logicalId: string,
    resource: any,
    change: ChangeType,
    state: StackState
  ): Promise<void> {
    const provider = this.providerRegistry.getProvider(resource.Type);

    switch (change) {
      case 'CREATE':
        const physicalId = await provider.create(logicalId, resource.Properties);
        state.resources[logicalId] = {
          physicalId,
          resourceType: resource.Type,
          properties: resource.Properties
        };
        break;
      case 'UPDATE':
        await provider.update(state.resources[logicalId].physicalId, resource.Properties);
        state.resources[logicalId].properties = resource.Properties;
        break;
      case 'DELETE':
        await provider.delete(state.resources[logicalId].physicalId);
        delete state.resources[logicalId];
        break;
      case 'NO_CHANGE':
        break;
    }
  }
}
```

#### cloud-control/cc-provider.ts - Cloud Control API プロバイダ

```typescript
import {
  CloudControlClient,
  CreateResourceCommand,
  UpdateResourceCommand,
  DeleteResourceCommand
} from '@aws-sdk/client-cloudcontrol';

export class CloudControlProvider implements ResourceProvider {
  constructor(private client: CloudControlClient) {}

  async create(logicalId: string, properties: any): Promise<string> {
    const response = await this.client.send(new CreateResourceCommand({
      TypeName: this.getTypeName(logicalId),
      DesiredState: JSON.stringify(properties),
    }));

    return this.waitForResource(response.ProgressEvent!.RequestToken!);
  }

  async update(physicalId: string, properties: any): Promise<void> {
    await this.client.send(new UpdateResourceCommand({
      TypeName: this.getTypeName(),
      Identifier: physicalId,
      PatchDocument: JSON.stringify(properties),
    }));
  }

  async delete(physicalId: string): Promise<void> {
    await this.client.send(new DeleteResourceCommand({
      TypeName: this.getTypeName(),
      Identifier: physicalId,
    }));
  }

  private async waitForResource(requestToken: string): Promise<string> {
    // GetResourceRequestStatus でポーリング
    // 実装省略
  }
}
```

#### sdk-providers/lambda.ts - Lambda 個別実装例

```typescript
import {
  LambdaClient,
  CreateFunctionCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  DeleteFunctionCommand
} from '@aws-sdk/client-lambda';

export class LambdaProvider implements ResourceProvider {
  constructor(private client: LambdaClient) {}

  async create(logicalId: string, properties: LambdaFunctionProperties): Promise<string> {
    const response = await this.client.send(new CreateFunctionCommand({
      FunctionName: properties.FunctionName,
      Runtime: properties.Runtime,
      Role: properties.Role,
      Handler: properties.Handler,
      Code: {
        S3Bucket: properties.Code.S3Bucket,
        S3Key: properties.Code.S3Key,
      },
      Environment: properties.Environment,
      Timeout: properties.Timeout,
      MemorySize: properties.MemorySize,
    }));

    return response.FunctionArn!;
  }

  async update(physicalId: string, properties: LambdaFunctionProperties): Promise<void> {
    // Code と Configuration は別々に更新
    if (properties.Code) {
      await this.client.send(new UpdateFunctionCodeCommand({
        FunctionName: physicalId,
        S3Bucket: properties.Code.S3Bucket,
        S3Key: properties.Code.S3Key,
      }));
    }

    await this.client.send(new UpdateFunctionConfigurationCommand({
      FunctionName: physicalId,
      Runtime: properties.Runtime,
      Role: properties.Role,
      Handler: properties.Handler,
      Environment: properties.Environment,
      Timeout: properties.Timeout,
      MemorySize: properties.MemorySize,
    }));
  }

  async delete(physicalId: string): Promise<void> {
    await this.client.send(new DeleteFunctionCommand({
      FunctionName: physicalId,
    }));
  }
}
```

---

## 5. CLI コマンド設計

### 基本コマンド

```bash
# Bootstrap (初回セットアップ)
cdkq bootstrap --state-bucket my-cdkq-state \
               --region us-east-1 \
               [--force]

# 合成のみ
cdkq synth --app "npx ts-node app.ts" [--output cdk.out]

# デプロイ
cdkq deploy --app "npx ts-node app.ts" \
            --state-bucket my-cdkq-state \
            [--stack MyStack] \
            [--concurrency 20] \
            [--dry-run]

# 差分表示
cdkq diff --app "npx ts-node app.ts" \
          --state-bucket my-cdkq-state \
          [--stack MyStack]

# 削除
cdkq destroy --app "npx ts-node app.ts" \
             --state-bucket my-cdkq-state \
             [--stack MyStack] \
             [--force]

# 状態確認
cdkq state show --state-bucket my-cdkq-state --stack MyStack
```

### Bootstrap コマンドの設計

#### 目的

cdkq 専用の状態管理バケットを作成する。CDK CLI の `cdk bootstrap` とは異なり、CloudFormation スタックや IAM ロールは作成せず、S3 バケットのみを準備する。

#### CDK CLI との比較

| 項目 | CDK CLI (`cdk bootstrap`) | cdkq (`cdkq bootstrap`) |
|------|---------------------------|-------------------------|
| **作成リソース** | CloudFormation スタック<br>S3 バケット<br>IAM 実行ロール<br>ECR リポジトリ | S3 バケット (状態管理専用) |
| **権限モデル** | AssumeRole (CloudFormation 実行ロール) | 実行者の直接権限 |
| **用途** | CDK アプリのデプロイ基盤 | cdkq の状態管理のみ |
| **依存関係** | CloudFormation に依存 | S3 のみ (CloudFormation 不要) |

#### Bootstrap の実装仕様

```typescript
// src/cli/commands/bootstrap.ts
async function bootstrapCommand(options: {
  stateBucket: string;
  region: string;
  force?: boolean;
}): Promise<void> {
  const s3 = new S3Client({ region: options.region });

  // 1. バケットの存在確認
  const exists = await checkBucketExists(s3, options.stateBucket);

  if (exists && !options.force) {
    throw new Error('Bucket already exists. Use --force to overwrite.');
  }

  // 2. バケット作成 (存在しない場合)
  if (!exists) {
    await s3.send(new CreateBucketCommand({
      Bucket: options.stateBucket,
      CreateBucketConfiguration: {
        LocationConstraint: options.region !== 'us-east-1' ? options.region : undefined,
      },
    }));
  }

  // 3. バージョニング有効化
  await s3.send(new PutBucketVersioningCommand({
    Bucket: options.stateBucket,
    VersioningConfiguration: {
      Status: 'Enabled',
    },
  }));

  // 4. サーバーサイド暗号化有効化
  await s3.send(new PutBucketEncryptionCommand({
    Bucket: options.stateBucket,
    ServerSideEncryptionConfiguration: {
      Rules: [{
        ApplyServerSideEncryptionByDefault: {
          SSEAlgorithm: 'AES256',
        },
      }],
    },
  }));

  // 5. パブリックアクセスブロック
  await s3.send(new PutPublicAccessBlockCommand({
    Bucket: options.stateBucket,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  }));

  logger.info(`✅ Bootstrap complete!`);
  logger.info(`State bucket: s3://${options.stateBucket}`);
}
```

#### バケット構造

```
s3://my-cdkq-state/
  └── cdkq/              # デフォルトプレフィックス (--state-prefix で変更可能)
      ├── MyStack/
      │   ├── lock.json       # スタックロック
      │   └── state.json      # スタック状態
      ├── AnotherStack/
      │   ├── lock.json
      │   └── state.json
      └── ...
```

#### 必要な IAM 権限

cdkq を使用するユーザーには以下の権限が必要:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:PutBucketVersioning",
        "s3:PutEncryptionConfiguration",
        "s3:PutPublicAccessBlock",
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::my-cdkq-state",
        "arn:aws:s3:::my-cdkq-state/*"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "cloudcontrol:CreateResource",
        "cloudcontrol:UpdateResource",
        "cloudcontrol:DeleteResource",
        "cloudcontrol:GetResource",
        "cloudcontrol:GetResourceRequestStatus"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "lambda:*",
        "iam:*",
        "dynamodb:*",
        "s3:*"
      ],
      "Resource": "*"
      "// 注: 実際のリソースに応じて権限を絞る"
    }
  ]
}
```

---

## 6. 実装ロードマップ

### Phase 0: Bootstrap 機能 (オプション - 優先度低)

- [ ] `bootstrap` コマンド実装
- [ ] S3 バケット作成・設定
- [ ] バケット存在確認とエラーハンドリング

**注**: 初期バージョンでは、ユーザーが手動で S3 バケットを作成することを前提とし、bootstrap コマンドは後で実装可能。

### Phase 1: 基盤構築 (Week 1-2) ✅ **完了**

- [x] プロジェクト初期化(TypeScript/esbuild/Vitest セットアップ)
- [x] CLI フレームワーク構築(commander)
- [x] ロガー・エラーハンドリング実装
- [x] AWS SDK クライアント管理
- [x] 基本型定義(State, Resource, Config)
- [x] CLI コマンドスケルトン(synth, deploy, diff, destroy)

### Phase 2: 合成・アセット (Week 3-4) ✅ **完了**

- [x] `@aws-cdk/toolkit-lib` 統合
- [x] `cdk-assets` (旧 `@aws-cdk/cdk-assets-lib`) 統合
- [x] CloudAssembly パーサー実装 (AssemblyLoader)
- [x] Synthesizer 実装
- [x] AssetPublisher 実装

**実装の詳細**:

- Toolkit.fromCdkApp() で cdk.json の自動読み込み、コンテキスト解決
- AssetManifest.fromPath() でアセットマニフェスト処理
- AssemblyLoader で CloudAssembly からテンプレート抽出
- cdk-assets による S3/ECR へのアセット公開

### Phase 3: 状態管理 (Week 5-6) ✅ **完了**

- [x] S3 ステートバックエンド実装
- [x] S3 条件付き書き込みロック実装
- [x] ステートスキーマ設計
- [x] 楽観的ロック(ETag)実装
- [x] ロックマネージャー実装

### Phase 4: 依存関係解析 (Week 7-8) ✅ **完了**

- [x] CloudFormation テンプレートパーサー
- [x] DAG ビルダー実装(Ref/GetAtt/DependsOn)
- [x] トポロジカルソート (実行レベル計算)
- [x] 差分計算エンジン
- [x] 循環依存検出

### Phase 5: Cloud Control API (Week 9-10) ✅ **完了**

- [x] Cloud Control API プロバイダ実装
- [x] リソース作成ポーリング
- [x] エラーハンドリング(非対応リソース検出)
- [x] 対応リソースタイプマッピング (ブラックリスト方式)

### Phase 6: SDK プロバイダ (Week 11-14) ✅ **完了**

- [x] プロバイダレジストリ実装
- [x] リソースタイプ検証機能 (デプロイ前チェック)
- [x] Cloud Control API 未対応リソース実装
  - [x] IAM Role (AWS::IAM::Role)
  - [x] 管理ポリシーアタッチメント対応
  - [x] インラインポリシー対応
  - [x] タグ対応

**設計方針の変更**:

- Cloud Control API でカバーされるリソース (Lambda, S3, DynamoDB 等) は SDK プロバイダ不要
- SDK プロバイダは Cloud Control API 非対応リソースのみに限定
- 未対応リソースはデプロイ開始前に検出・エラー報告

### Phase 7: オーケストレーション (Week 15-16) ✅ **完了**

- [x] デプロイオーケストレーター実装 (DeployEngine)
- [x] 並列実行エンジン(p-limit)
- [x] DELETE の逆順実行
- [x] 楽観的ロック統合
- [x] リソースタイプ事前検証

**実装の詳細**:

- DAG ベースの並列実行 (レベル単位で順次、レベル内は並列)
- CREATE/UPDATE は依存順、DELETE は逆順で実行
- デプロイ開始前にすべてのリソースタイプを検証
- S3 ETag による楽観的ロックで状態の競合を防止
- Dry run モード対応

### Phase 8: 追加機能・CLI 統合 (Week 17-18) ✅ **完了**

- [x] `deploy` コマンド本体実装
- [x] `destroy` コマンド本体実装 (依存関係ベースの逆順削除、確認プロンプト付き)
- [x] `diff` コマンド本体実装 (プロパティレベルの変更表示)
- [x] ドライラン機能 (DeployEngine の dryRun オプション実装済み)
- [x] リソース状態に依存関係情報を保存
- [ ] プログレス表示(進捗バー) → Phase 10 に移動

**実装の詳細**:

- deploy: CDK 合成、アセット公開、DeployEngine 統合
- diff: 現在の状態と desired state の比較、CREATE/UPDATE/DELETE の表示
- destroy: 依存関係の逆順での削除、--force オプション対応
- ResourceState に dependencies フィールドを追加し、destroy 時の正しい削除順序を保証

### Phase 9: テスト・ドキュメント (Week 19-20)

- [ ] ユニットテスト(カバレッジ 80%+)
- [ ] 統合テスト(実際の AWS デプロイ)
- [ ] アーキテクチャドキュメント
- [ ] プロバイダ開発ガイド

### Phase 10: 開発環境改善 (Week 21)

- [ ] **npm から pnpm への移行**
  - より高速なパッケージインストール
  - ディスクスペース効率化
  - monorepo サポートの向上

- [ ] **ESLint + Prettier から vite+ への移行**
  - Vite エコシステムの統合リンティング・フォーマッティングツール
  - Vite との統合による開発体験の向上
  - 高速なビルドとホットリロード
  - TypeScript ネイティブサポート
  - 設定ファイルの簡略化

### Phase 11: リリース準備 (Week 22-23)

- [ ] パフォーマンスベンチマーク
- [ ] セキュリティ監査
- [ ] npm パッケージ化
- [ ] README/例集整備

### 将来の改善 (Future Enhancements)

**Bootstrap コマンド** (Phase 0 - 現在未実装):

- `cdkq bootstrap` コマンドの実装
- S3 状態バケットの自動作成と設定
- バケットポリシー、暗号化、バージョニングの設定
- 既存バケットの検証と上書き確認 (`--force` オプション)
- 現状: ユーザーが手動で S3 バケットを作成する必要がある (TESTING.md 参照)
- 参照: 実装仕様は本ドキュメントの「Bootstrap コマンドの設計」セクション参照

**ロールバック機構**:

- トランザクションログの実装
- 失敗時の逆順ロールバック
- `--no-rollback` フラグ対応
- Terraform 同様の手動状態復旧アプローチ

**CloudFormation 組み込み関数の完全サポート**:

- Fn::Sub, Fn::Join, Fn::Select 対応
- Fn::ImportValue, Fn::Split 対応
- Conditions サポート

**カスタムリソース対応**:

- Custom::XXX リソースのサポート
- Lambda バックエンドハンドラー呼び出し実装
- CREATE/UPDATE/DELETE イベント処理
- 非同期実行とポーリングメカニズム
- カスタムリソースプロバイダーの登録機能

**その他の改善項目 (コードに TODO として記載済み)**:

1. **Cloud Control API の Update 処理改善**
   - 現在: ルート (`/`) を全置換 → 一部のリソースで失敗する可能性
   - 改善: プロパティレベルの JSON Patch (RFC 6902) を生成
   - 場所: `src/provisioning/cloud-control-provider.ts:122-128`

2. **リソース置換の検出**
   - 現在: `wasReplaced` を常に `false` として返す
   - 改善: Cloud Control API のレスポンスから置換を検出
   - 場所: `src/provisioning/cloud-control-provider.ts:169-175`

3. **ロック取得のリトライ機構**
   - 現在: ロック取得失敗時に即座に失敗
   - 改善: `acquireLockWithRetry` を使用してエクスポネンシャルバックオフ
   - 場所: `src/deployment/deploy-engine.ts:83-91`

4. **AWS SDK エラー型判定の改善**
   - 現在: `error.name` での文字列比較
   - 改善: `instanceof PreconditionFailedException` を使用
   - 場所: `src/state/lock-manager.ts:86-92`

5. **アセット公開エラーハンドリング**
   - 現在: すべてのエラーを無視してデプロイ続行
   - 改善: ファイル不存在のみ許可、その他は失敗させる
   - 場所: `src/cli/commands/deploy.ts:97-106`

6. **IAM ロール置換時の古いリソース削除**
   - 現在: 削除失敗を警告のみ → リソースリークの可能性
   - 改善: 削除失敗時にエラーを投げるか、孤立リソースを追跡
   - 場所: `src/provisioning/providers/iam-role-provider.ts:190-202`

7. **Parameters の Ref 解決**
   - 現在: Ref はリソースのみサポート
   - 改善: Parameters への Ref も解決できるようにする
   - 場所: `src/deployment/deploy-engine.ts:426-431`

8. **requiresReplacement の正確な判定**
   - 現在: すべてのプロパティ変更を `requiresReplacement: false` として扱う
   - 改善: リソースタイプごとのスキーマに基づいて判定
   - 場所: `src/analyzer/diff-calculator.ts` (TODO コメント参照)

---

## 7. 技術的課題と対策

### 1. Cloud Control API カバレッジ不足

**課題**: 全リソースタイプが対応しているわけではない
**対策**:

- 実行時にプロバイダレジストリで判定
- 非対応リソースは個別 SDK プロバイダにフォールバック
- 優先度の高いリソース(Lambda, S3, IAM 等)から順次実装

### 2. 複雑な依存関係解決

**課題**: カスタムリソースや動的な Ref 解決
**対策**:

- DAG ビルダーでの静的解析
- 実行時に `Fn::GetAtt` の値を解決してステートに保存
- カスタムリソースは初期バージョンで非対応(将来実装)

### 3. ロールバック

**課題**: 部分的な失敗時のロールバック
**対策**:

- トランザクションログ(変更履歴)を保存
- 失敗時は逆順で削除/復元
- `--no-rollback` オプションでデバッグ可能に

### 4. 大規模スタックのパフォーマンス

**課題**: 数百リソースの並列実行
**対策**:

- `p-limit` で同時実行数制御(デフォルト 10)
- DAG レベル単位での段階的実行
- リソースタイプ別の最適化(Lambda は Waiter 使用等)

---

## 8. 成功指標

1. **速度**: CloudFormation と比較して 3-5 倍高速(小規模スタック)
2. **互換性**: 既存 CDK アプリの 90% が無修正で動作
3. **信頼性**: ステート不整合率 0.1% 未満
4. **カバレッジ**: 上位 20 リソースタイプを個別 SDK で実装

---

## 9. まとめ

**cdkq** は、CDK エコシステムとの完全な互換性を保ちながら、CloudFormation のボトルネックを解消する革新的なツールです。

- `@aws-cdk/toolkit-lib` で合成・コンテキスト解決を委譲
- `@aws-cdk/cdk-assets-lib` でアセット管理を委譲
- S3 ベースの状態管理で DynamoDB 不要
- Cloud Control API/SDK のハイブリッドアプローチで柔軟性を確保
- DAG ベース並列実行で高速デプロイを実現

段階的な実装ロードマップに従うことで、22 週間でプロダクションレディなツールを完成させることが可能です。
