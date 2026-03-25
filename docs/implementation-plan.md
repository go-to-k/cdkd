# cdkq 実装計画書

## 1. プロジェクト概要

**cdkq** (CDK Quick Deploy) は、AWS CDK アプリケーションを CloudFormation スタックを介さずに、SDK/Cloud Control API 経由で直接デプロイする高速デプロイツールです。

### コアコンセプト

- **CDK アプリケーションとの互換性**: 既存の CDK コード(aws-cdk-lib)をそのまま利用可能
- **合成フェーズの委譲**: `@aws-cdk/toolkit-lib` を使用して CDK アプリの合成とコンテキスト解決を完全委譲
- **アセット管理**: `@aws-cdk/cdk-assets-lib` を使用してアセットのビルドとアップロードを処理
- **ハイブリッドデプロイ**: Cloud Control API を優先し、非対応リソースは個別 SDK で対応
- **S3 ベース状態管理**: S3 の条件付き書き込み機能を使った排他制御とステート管理
- **DAG ベース並列実行**: 依存関係を解析し、並列実行可能なリソースを同時にプロビジョニング

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

**結論**: cdkq 独自の `bootstrap` コマンドを実装予定 (Phase 0 - 現在未実装)

| 項目 | CDK CLI | cdkq |
|------|---------|------|
| **コマンド** | `cdk bootstrap` | `cdkq bootstrap` (未実装) |
| **作成リソース** | CloudFormation スタック<br>S3 バケット (アセット用)<br>IAM 実行ロール<br>ECR リポジトリ | S3 バケット (状態管理専用) |
| **権限モデル** | AssumeRole (CloudFormation 実行ロール使用) | 実行者の直接権限 |
| **CloudFormation 依存** | あり | なし |

**重要な違い**:

- **CDK CLI**: CloudFormation のデプロイに必要な基盤 (IAM ロール、アセットバケット) を作成
- **cdkq**: 状態管理用 S3 バケットのみを作成 (CloudFormation 不使用のため IAM ロール不要)

**アセットの扱い**:

- CDK CLI: bootstrap で作成した専用バケットにアセットをアップロード
- cdkq: `@aws-cdk/cdk-assets-lib` を使用し、CDK が合成時に決定したバケット/キーにアップロード
  - 既存の CDK bootstrap バケットを利用可能
  - または、CDK アプリ側でカスタムバケットを指定可能

---

## 2. 技術スタック

### 依存ライブラリ

```json
{
  "@aws-cdk/toolkit-lib": "^1.19.1",        // CDK 合成・コンテキスト解決
  "@aws-cdk/cdk-assets-lib": "^2.2.0",      // アセット管理
  "@aws-cdk/cloud-assembly-api": "^2.2.0",  // CloudAssembly 解析
  "@aws-sdk/client-s3": "^3.0.0",           // S3 状態管理・ロック
  "@aws-sdk/client-cloudcontrol": "^3.0.0", // Cloud Control API
  "@aws-sdk/client-iam": "^3.0.0",          // IAM リソース管理
  "graphlib": "^2.1.8",                     // DAG 依存解析
  "commander": "^12.0.0",                   // CLI フレームワーク
  "p-limit": "^5.0.0"                       // 並列実行制御
}
```

### 開発環境

- **言語**: TypeScript 5.x
- **ランタイム**: Node.js 20.x 以上
- **ビルド**: esbuild (高速ビルド・バンドル)
- **テスト**: Vitest
- **リンター**: ESLint + Prettier

---

## 3. 実装ロードマップ

### Phase 0: Bootstrap 機能 ✅ **完了**

- [x] `bootstrap` コマンド実装
- [x] S3 バケット作成・設定
- [x] バケット存在確認とエラーハンドリング
- [x] リージョン別設定（LocationConstraint）
- [x] --force オプションで既存バケット上書き

### Phase 1: 基盤構築 ✅ **完了**

- [x] プロジェクト初期化(TypeScript/esbuild/Vitest セットアップ)
- [x] CLI フレームワーク構築(commander)
- [x] ロガー・エラーハンドリング実装
- [x] AWS SDK クライアント管理
- [x] 基本型定義(State, Resource, Config)
- [x] CLI コマンドスケルトン(synth, deploy, diff, destroy)

### Phase 2: 合成・アセット ✅ **完了**

- [x] `@aws-cdk/toolkit-lib` 統合
- [x] `@aws-cdk/cdk-assets-lib` 統合
- [x] CloudAssembly パーサー実装 (AssemblyLoader)
- [x] Synthesizer 実装
- [x] AssetPublisher 実装

### Phase 3: 状態管理 ✅ **完了**

- [x] S3 ステートバックエンド実装
- [x] S3 条件付き書き込みロック実装
- [x] ステートスキーマ設計
- [x] 楽観的ロック(ETag)実装
- [x] ロックマネージャー実装

### Phase 4: 依存関係解析 ✅ **完了**

- [x] CloudFormation テンプレートパーサー
- [x] DAG ビルダー実装(Ref/GetAtt/DependsOn)
- [x] トポロジカルソート (実行レベル計算)
- [x] 差分計算エンジン
- [x] 循環依存検出

### Phase 5: Cloud Control API ✅ **完了**

- [x] Cloud Control API プロバイダ実装
- [x] リソース作成ポーリング
- [x] エラーハンドリング(非対応リソース検出)
- [x] 対応リソースタイプマッピング (ブラックリスト方式)

### Phase 6: SDK プロバイダ ✅ **完了**

- [x] プロバイダレジストリ実装
- [x] リソースタイプ検証機能 (デプロイ前チェック)
- [x] Cloud Control API 未対応リソース実装
  - [x] IAM Role (AWS::IAM::Role)
  - [x] IAM Policy (AWS::IAM::Policy) - インラインポリシー対応

### Phase 7: オーケストレーション ✅ **完了**

- [x] デプロイオーケストレーター実装 (DeployEngine)
- [x] 並列実行エンジン(p-limit)
- [x] DELETE の逆順実行
- [x] 楽観的ロック統合
- [x] リソースタイプ事前検証

### Phase 8: CLI 統合 ✅ **完了**

- [x] `deploy` コマンド本体実装
- [x] `destroy` コマンド本体実装
- [x] `diff` コマンド本体実装
- [x] `synth` コマンド本体実装
- [x] `publish-assets` コマンド本体実装
- [x] リソース状態に依存関係情報を保存
- [x] S3StateBackend に listStacks() メソッド追加

**Phase 8 完了後のテスト結果**:

- ✅ S3 バケットの作成・削除成功 (Cloud Control API 経由)
- ✅ 状態管理・ロック機構動作確認
- ✅ パフォーマンス: CloudFormation の 3-5 倍高速 (小規模スタック)

詳細は [TESTING.md](../TESTING.md) を参照。

---

## 4. Phase 9: 次の実装項目 (優先度順)

### ✅ **完了済みの機能**

#### CloudFormation 組み込み関数の解決実装

- [x] Fn::Join の解決
- [x] Fn::Sub の解決
- [x] Ref (リソース参照) の解決
- [x] Fn::GetAtt の解決
- [x] リソース属性の補完（S3 Bucket ARN など）
- [x] 疑似パラメータのサポート（AWS::Region, AWS::AccountId など）

**実装**: `src/analyzer/intrinsic-function-resolver.ts`

**テスト結果**: intrinsic-functions exampleで検証済み

#### Bootstrap コマンド実装

- [x] `cdkq bootstrap` コマンドの実装
- [x] S3 状態バケットの自動作成と設定
- [x] リージョン別設定（LocationConstraint）
- [x] 既存バケットの検証と上書き確認 (`--force` オプション)

**実装**: `src/cli/commands/bootstrap.ts`

#### JSON Patch 実装 ✅ **完了**

- [x] JsonPatchGenerator の実装
- [x] プロパティレベルの差分計算実装
- [x] RFC 6902 準拠の JSON Patch 生成
- [x] 個別プロパティの add/replace/remove 操作
- [x] Cloud Control Provider への統合

**実装**: `src/provisioning/json-patch-generator.ts`, `src/provisioning/cloud-control-provider.ts`

**テスト結果**: basic exampleでS3バケットのタグ更新で検証済み

#### Fn::GetAtt ARN構築実装 ✅ **完了**

- [x] constructAttribute() メソッドの実装
- [x] Cloud Control API から取得できない属性の手動構築
- [x] リソースタイプ別ARN生成ロジック
- [x] 疑似パラメータによるregion/accountId/partition解決

**サポートリソース**:

- DynamoDB Table (Arn, StreamArn)
- S3 Bucket (Arn, DomainName, RegionalDomainName, WebsiteURL)
- IAM Role/Policy (Arn, RoleId/PolicyId)
- Lambda Function (Arn)
- SQS Queue (Arn, QueueUrl)
- SNS Topic (TopicArn)

**実装**: `src/deployment/intrinsic-function-resolver.ts:162-270`

**テスト結果**: lambda-exampleでDynamoDB ARNがIAM Policyに正しく解決されることを検証済み

#### アセット公開の修正 ✅ **完了**

- [x] アセットマニフェストパス解決の修正
- [x] スタック名ベースのマニフェスト検索実装
- [x] 複数スタックのアセット公開対応

**変更点**:

- `assets.json` → `${stackName}.assets.json`
- スタックごとにアセットマニフェストを検索するループを追加

**実装**: `src/cli/commands/deploy.ts:85-125`

**テスト結果**: lambda-exampleでLambdaコードのS3アップロードが成功

#### SDK Provider 拡張 ✅ **完了**

- [x] AWS::SQS::QueuePolicy Provider 実装
- [x] AWS::S3::BucketPolicy Provider 実装
- [x] Custom Resource Provider 実装 (Lambda-backed)
- [x] Custom Resource Delete 操作実装 (ServiceToken from state)
- [x] ResourceProvider interface 拡張 (delete に properties 追加)

**実装**:

- `src/provisioning/providers/sqs-queue-policy-provider.ts`
- `src/provisioning/providers/s3-bucket-policy-provider.ts`
- `src/provisioning/providers/custom-resource-provider.ts`
- `src/types/resource.ts` - delete() signature update

**テスト結果**: multi-resource-example で SQS Queue Policy の作成・削除成功

#### アカウントID解決の改善 ✅ **完了**

- [x] STS GetCallerIdentity 統合
- [x] IntrinsicFunctionResolver の async 化
- [x] 実際の AWS Account ID/Region/Partition の使用
- [x] アカウント情報のキャッシング
- [x] AWS::AccountId, AWS::Region, AWS::Partition の実装

**実装**:

- `src/utils/aws-clients.ts` - STSClient 追加
- `src/deployment/intrinsic-function-resolver.ts` - getAccountInfo() 実装
- `src/deployment/deploy-engine.ts` - await resolver.resolve()

**効果**: Lambda ARN などで正しいアカウント ID が使用される

#### コード品質改善 ✅ **完了**

- [x] DeployEngine の重複コード削除
- [x] resolveOutputs() / resolveValue() の IntrinsicFunctionResolver への統合
- [x] ESM/CommonJS 互換性の修正 (error.name ベース判定)

**実装**:

- `src/deployment/deploy-engine.ts` - 重複解決ロジック削除（~80行削減）
- `src/state/lock-manager.ts` - PreconditionFailed エラー判定修正

**効果**:

- Outputs で全組み込み関数がサポートされる (Fn::Sub, Fn::Join など)
- コードメンテナンス性の向上
- ESM/CommonJS 混在時の実行時エラー解消

### 優先度: 高 (High Priority)

#### 1. CloudFormation 組み込み関数の追加対応

**実装済みの関数** (2026-03-25):

- [x] Fn::Select - 配列のインデックス指定
- [x] Fn::Split - 文字列の分割
- [x] Fn::If - 条件分岐
- [x] Fn::Equals - 等価比較（Conditionsで使用）
- [x] Conditions の基本サポート (evaluateConditions メソッド)
- [x] Parameters のサポートと Ref (Parameters への参照) の解決
  - resolveParameters メソッド追加
  - テンプレートのDefault値とユーザー指定値のマージ
  - 型変換 (String/Number/CommaDelimitedList/ListOfNumber)
  - DeployEngineに統合
- [x] Fn::ImportValue (クロススタック参照)
  - S3 state backend 経由で他スタックの outputs を検索
  - ResolverContext に stateBackend と stackName を追加
  - 自己参照の回避（現在のスタックをスキップ）

**未実装の関数**:

- [x] ~~Fn::And, Fn::Or, Fn::Not~~ → 実装済み（`intrinsic-function-resolver.ts` 行738-761）
- [ ] Fn::FindInMap, Fn::GetAZs, Fn::Base64

**影響範囲**:

- `src/deployment/intrinsic-function-resolver.ts`
- `src/deployment/deploy-engine.ts`

#### 2. アセット公開のエラーハンドリング改善 ✅ **部分完了**

**実装済み**:

- [x] ファイル不存在エラー（ENOENT）のみ許可
- [x] その他のエラーは失敗として扱う

**実装**: `src/cli/commands/deploy.ts:98-111`

### 優先度: 中 (Medium Priority)

#### 4. カスタムリソース対応

**実装内容**:

- [ ] Custom::XXX リソースのサポート
- [ ] Lambda バックエンドハンドラー呼び出し実装
- [ ] CREATE/UPDATE/DELETE イベント処理
- [ ] 非同期実行とポーリングメカニズム

#### 5. リソース置換の検出

**課題**: 現在、`wasReplaced` を常に `false` として返している。

**実装内容**:

- [ ] Cloud Control API のレスポンスから置換を検出
- [ ] 置換時の物理 ID 変更を追跡

**影響範囲**: `src/provisioning/cloud-control-provider.ts:169-175`

#### 6. テスト実装

**ユニットテスト** (カバレッジ目標: 80%+):

- [x] DagBuilder のテスト (23 tests, all passing)
- [x] エラークラスのプロトタイプ修正 (Object.setPrototypeOf)
- [ ] JsonPatchGenerator のテスト
- [ ] DiffCalculator のテスト
- [ ] DeployEngine のテスト
- [ ] LockManager のテスト
- [ ] S3StateBackend のテスト
- [ ] ProviderRegistry のテスト
- [ ] CloudControlProvider のテスト

**統合テスト** (実際の AWS デプロイ):

- [x] S3, Lambda, DynamoDB などの実デプロイ (lambda-example で検証済み)
- [x] アセット公開テスト (S3 / ECR) (Lambda コードアセットで検証済み)
- [ ] マルチスタックのテスト
- [ ] エラーケースのテスト
- [ ] 更新デプロイのテスト

**E2E テスト**:

- [ ] deploy → diff → destroy のフルサイクル
- [ ] 更新デプロイのテスト
- [ ] dry-run モードのテスト
- [ ] 並列実行のテスト

#### 7. 統合テスト用の例の整備 ✅ **完了**

- [x] tests/integration/examples ディレクトリ構造の作成
- [x] basic example (シンプルな S3 バケット)
- [x] intrinsic-functions example (組み込み関数のテスト)
- [x] lambda example (Lambda + DynamoDB + IAM)
- [x] parameters example (CloudFormation Parameters - 未実装機能のデモ)
- [x] conditions example (CloudFormation Conditions - 未実装機能のデモ)
- [x] multi-resource example (S3 + Lambda + DynamoDB + SQS + IAM)
- [x] 各例のドキュメント作成 (英語)

**実装**: `tests/integration/examples/`

**追加された例**:

- `lambda/`: 実践的なLambda関数、DynamoDBテーブル、IAM権限の組み合わせ
- `parameters/`: CloudFormation Parametersの仕様デモ（将来の実装用）
- `conditions/`: CloudFormation Conditionsの仕様デモ（将来の実装用）
- `multi-resource/`: イベント駆動アーキテクチャの複合的な例（現在の実装で動作）

#### 8. ドキュメント作成 ✅ **完了**

- [x] **アーキテクチャドキュメント** (`docs/architecture.md`) - レイヤー構造、デプロイフロー、設計原則を網羅
- [x] **状態管理仕様** (`docs/state-management.md`) - S3状態構造、ロック機構、トラブルシューティング
- [x] **プロバイダー開発ガイド** (`docs/provider-development.md`) - 新規プロバイダー実装手順、ベストプラクティス
- [x] **トラブルシューティングガイド** (`docs/troubleshooting.md`) - よくある問題と解決方法、デバッグ手順

**特徴**:

- すべて英語で記述（実装計画書のみ日本語）
- Cloud Control API の広範なサポート（200+ リソースタイプ）を明記
- 別のAIエージェントへの引き継ぎを考慮した詳細な説明

### 優先度: 低 (Low Priority)

#### 9. ロック取得のリトライ機構

**課題**: 現在、ロック取得失敗時に即座に失敗する。

**実装内容**:

- [ ] エクスポネンシャルバックオフでリトライ
- [ ] リトライ回数の設定

**影響範囲**: `src/deployment/deploy-engine.ts`

#### 10. AWS SDK エラー型判定の改善

**課題**: 現在、`error.name` での文字列比較を使用している。

**実装内容**:

- [ ] `instanceof` を使用した型安全な判定

**影響範囲**: `src/state/lock-manager.ts:86-92`

#### 11. ロールバック機構

**実装内容**:

- [ ] トランザクションログの実装
- [ ] 失敗時の逆順ロールバック
- [ ] `--no-rollback` フラグ対応

**注**: Terraform でもロールバックはサポートされていないため、優先度は低い。

#### 12. CloudFormation 組み込み関数の完全サポート

**実装内容**:

- [x] Fn::ImportValue, Fn::Split 対応 ✅
- [x] Fn::Select, Fn::If などの複雑な関数 ✅
- [x] Conditions の完全サポート ✅
- [x] Fn::And, Fn::Or, Fn::Not (論理演算子) ✅

**注**: すべて実装済み。intrinsic-function-resolver.ts で対応。

#### 13. IAM ロール置換時の古いリソース削除改善

**課題**: 現在、削除失敗を警告のみ → リソースリークの可能性。

**実装内容**:

- [ ] 削除失敗時にエラーを投げる
- [ ] 孤立リソースの追跡

**影響範囲**: `src/provisioning/providers/iam-role-provider.ts:190-202`

#### 14. requiresReplacement の正確な判定 ✅ **完了**

**実装内容**:

- [x] リソースタイプごとのスキーマに基づいて判定
- [x] ReplacementRulesRegistry クラスの実装
- [x] 10以上のAWSリソースタイプのルール定義（S3, Lambda, DynamoDB, SQS, IAM, SNS, ECR, CloudWatch, API Gateway, ECS）

**実装場所**:

- `src/analyzer/replacement-rules.ts` - ルール定義
- `src/analyzer/diff-calculator.ts` - DiffCalculator に統合

#### 15. Bootstrap デフォルトバケット名サポート

**課題**: `--state-bucket` が必須オプション。CDK bootstrap と同様にデフォルト名で作成できるべき。

**実装内容**:

- [ ] デフォルトバケット名の自動生成: `cdkq-state-{accountId}-{region}`
- [ ] バケットポリシー設定: 当該アカウントからのアクセスのみ許可
- [ ] バージョニング・暗号化の有効化（既存 TODO 消化）
- [ ] `--state-bucket` 省略時にデフォルト名を使用

**参考**: CDK bootstrap バケット `cdk-hnb659fds-assets-{accountId}-{region}` と同じパターン

**影響範囲**: `src/cli/commands/bootstrap.ts`, 全 CLI コマンド

#### 16. リソース属性解決の強化（3段階ハイブリッド戦略）

**課題**: `Fn::GetAtt` で参照される属性（ARN等）の取得が、手動の `constructAttribute()` に依存しており6リソースタイプのみ対応。スケールしない。

**現状のアーキテクチャ**: 既に `resource.attributes` → `constructAttribute()` のフォールバック構造あり（`intrinsic-function-resolver.ts:386-399`）

**3段階の解決戦略**:

1. **Phase A: CC API ResourceModel のフル活用**（優先度: 高・即効）
   - [ ] CC API の `ResourceModel` が返す全プロパティを attributes に保存（**既に実装済み**。検証・テスト追加のみ）
   - [ ] CC API のプロパティキー名と GetAtt 属性名のエイリアスマッピング追加
     - 例: CC API `TableArn` → GetAtt `Arn` のズレ吸収
   - [ ] `enrichResourceAttributes()` を拡張し、より多くのリソースタイプでCC APIレスポンスを活用

2. **Phase B: CloudFormation Registry Schema の活用**（優先度: 中）
   - [ ] `aws cloudformation describe-type` で readOnly 属性一覧を自動取得
   - [ ] スキーマキャッシュ（ローカルファイル or メモリ）
   - [ ] CC API プロパティ名 → GetAtt 属性名の自動マッピング生成
   - [ ] 対象: CC API がプロパティとして返すが、GetAtt 名と異なる属性

3. **Phase C: ARN Builder（ルールベースフォールバック）**（優先度: 中）
   - [ ] `src/utils/arn-builder.ts` の新規作成
   - [ ] リソースタイプ → ARN 形式のマッピング表
   - [ ] `getAccountInfo()` の export・共通化
   - [ ] `partition` の動的解決（aws-cn, aws-us-gov 対応）
   - [ ] 既存の `constructAttribute()` コードをユーティリティに移行

**解決優先度**: ① CC API レスポンス → ② Schema マッピング → ③ ARN Builder（現在の `constructAttribute()`）

**対象リソース**: DynamoDB, S3, IAM Role/Policy, Lambda, SQS, SNS + CC API 対応の全リソース

**影響範囲**: `src/deployment/intrinsic-function-resolver.ts`, `src/provisioning/cloud-control-provider.ts`

#### 17. Custom Resource の非同期実行・SNS・Step Functions 対応計画

**課題**: 現在 Lambda 同期呼び出し（`RequestResponse`）のみ。ResponseURL がダミー値。

**段階的実装計画**:

1. **Phase A: ResponseURL の実装**（優先度: 高）
   - [ ] Pre-signed S3 URL の生成（レスポンス受信用）
   - [ ] Lambda からの非同期レスポンスのポーリング
   - [ ] CloudFormation Custom Resource Response Objects 仕様準拠

2. **Phase B: SNS バックエンド対応**（優先度: 低）
   - [ ] SNS Topic への Publish + S3 レスポンス待ち
   - [ ] **注**: CDK では一般的ではないため優先度低

3. **Phase C: Step Functions 統合**（優先度: 低）
   - [ ] CDK の `Provider` フレームワーク対応
   - [ ] `isCompleteHandler` / `onEventHandler` パターン
   - [ ] 非同期 CRUD + ポーリング

**現状の制限事項**:

- Lambda 同期呼び出しのみ対応（タイムアウト上限あり）
- `Custom::S3AutoDeleteObjects` 等の CDK 内部カスタムリソースは ResponseURL 問題で動作不可
- SNS バックエンド、Step Functions バックエンドは未対応

**影響範囲**: `src/provisioning/providers/custom-resource-provider.ts`

#### 18. 統合テストの大幅拡充

**課題**: 7 例のみ。多様なリソースタイプのカバレッジ不足。

**実装内容**:

- [ ] **ECR 統合テスト**: Docker イメージアセットのビルド + ECR プッシュ
- [ ] **API Gateway テスト**: REST API + Lambda 統合
- [ ] **CloudWatch テスト**: Alarms, Log Groups
- [ ] **SNS/SQS イベント連携テスト**: Topic → Queue → Lambda
- [ ] **複合スタックテスト**: 既存の single-stack 例に多数リソース追加
- [ ] **E2E フルサイクルテスト**: deploy → diff → update → destroy の自動化
- [ ] **マルチスタック依存テスト**: 複数スタック間の依存関係

**影響範囲**: `tests/integration/examples/`

#### 19. 対応機能/リソース表の README 追加

**課題**: どのリソースが対応しているか一覧がない。

**実装内容**:

- [ ] 対応組み込み関数の一覧表
- [ ] Cloud Control API 対応リソース (200+) の代表例
- [ ] SDK Provider 対応リソース (4種)
- [ ] カスタムリソース対応状況
- [ ] 未対応機能一覧

**影響範囲**: `README.md`

#### 20. 公開判断基準（v0.1.0 リリース条件）

**目的**: OSSとして公開した際のインパクト最大化。

**最低限の公開条件**:

- [ ] Custom Resource の ResponseURL 問題解決（multi-resource テスト通過）
- [ ] ECR 統合テスト通過
- [ ] E2E テスト自動化（deploy → destroy フルサイクル）
- [ ] 対応機能/リソース一覧表の README 掲載
- [ ] CI/CD パイプライン（GitHub Actions）
- [ ] `npm install -g cdkq` でインストール可能

- [ ] CLI スタック指定の CDK 互換化（タスク21）
- [ ] `--app` の `cdk.json` 自動読み込み（タスク21）

**インパクト最大化のための追加項目**:

- [ ] ベンチマーク結果（CloudFormation vs cdkq の速度比較データ）
- [ ] 10+ リソースの実践的デモ（API Gateway + Lambda + DynamoDB + S3 + IAM）
- [ ] GIF/動画デモ（README 掲載用）
- [ ] bootstrap デフォルトバケット名対応（UX 改善）
- [ ] `CDKQ_STATE_BUCKET` 環境変数対応

#### 21. CLI スタック指定の CDK 互換化 + cdk.json 自動読み込み

**課題**: 現在 `--stack-name` オプション必須＋ `--app` 必須。CDK CLI と UX が大幅に異なる。

**CDK CLI の挙動**:

```bash
cdk deploy                    # シングルスタックなら指定不要
cdk deploy MyStack            # 位置引数でスタック名指定
cdk deploy Stack1 Stack2      # 複数スタック指定
cdk deploy --all              # 全スタック
cdk deploy 'My*'              # ワイルドカード
```

**cdkq の現状**:

```bash
cdkq deploy --app "..." --stack-name MyStack  # 両方必須
```

**実装内容**:

- [ ] `--stack-name` → 位置引数（`cdkq deploy [stacks...]`）に変更
- [ ] シングルスタックの自動検出（スタックが1つなら指定不要）
- [ ] `--all` フラグで全スタックデプロイ
- [ ] ワイルドカード対応（glob パターン）
- [ ] `--app` を省略可能に: `cdk.json` の `app` フィールドから自動読み込み
- [ ] `--state-bucket` を省略可能に: `cdk.json` の `context.cdkq.stateBucket` から読み込み
- [ ] 環境変数対応: `CDKQ_STATE_BUCKET`, `CDKQ_APP`
- [ ] diff/destroy コマンドにも同様の変更を適用

**優先度**: 高（公開前の UX 改善として必須）

**影響範囲**: `src/cli/commands/deploy.ts`, `src/cli/commands/destroy.ts`, `src/cli/commands/diff.ts`

---

## 5. Phase 10-11: 開発環境改善・リリース準備

### Phase 10: 開発環境改善

- [ ] **npm から pnpm への移行**
- [ ] **プログレス表示(進捗バー)**

### Phase 11: リリース準備

#### CI/CD パイプライン構築

- [ ] GitHub Actions ワークフローの作成
  - [ ] Pull Request時の自動テスト実行（Unit + Integration）
  - [ ] Lint/型チェック/フォーマットチェックの自動実行
  - [ ] テストカバレッジレポート生成とアップロード
  - [ ] mainブランチへのマージ時の自動ビルド検証

- [ ] リリース自動化
  - [ ] セマンティックバージョニング対応
  - [ ] CHANGELOG.md自動生成
  - [ ] npmへの自動パブリッシュ（タグpush時）
  - [ ] GitHub Releasesへのリリースノート自動作成

#### 品質保証

- [ ] パフォーマンスベンチマーク
  - [ ] 大規模スタック（100+リソース）のデプロイ時間計測
  - [ ] CloudFormation との速度比較
  - [ ] メモリ使用量のプロファイリング

- [ ] セキュリティ監査
  - [ ] 依存パッケージの脆弱性スキャン（npm audit, Snyk）
  - [ ] IAM権限の最小権限原則チェック
  - [ ] 認証情報の安全な取り扱い検証
  - [ ] OWASP Top 10対応確認

#### パッケージング

- [ ] npm パッケージ化
  - [ ] package.jsonの最終調整（description, keywords, repository等）
  - [ ] .npmignoreの設定（テストファイル、開発用ファイルの除外）
  - [ ] distディレクトリの配布設定
  - [ ] CLIバイナリのエントリポイント設定

- [ ] README/例集整備
  - [ ] インストール手順の明確化
  - [ ] クイックスタートガイドの作成
  - [ ] よくある使用例の追加（Lambda、API Gateway、DynamoDB等）
  - [ ] トラブルシューティングセクションの充実
  - [ ] コントリビューションガイドラインの作成

---

## 6. 技術的課題と対策

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

## 7. 成功指標

1. **速度**: CloudFormation と比較して 3-5 倍高速(小規模スタック) ✅ **達成**
2. **互換性**: 既存 CDK アプリの 90% が無修正で動作
3. **信頼性**: ステート不整合率 0.1% 未満
4. **カバレッジ**: 上位 20 リソースタイプを個別 SDK で実装

---

## 8. まとめ

**cdkq** は、CDK エコシステムとの完全な互換性を保ちながら、CloudFormation のボトルネックを解消する革新的なツールです。

- `@aws-cdk/toolkit-lib` で合成・コンテキスト解決を委譲
- `@aws-cdk/cdk-assets-lib` でアセット管理を委譲
- S3 ベースの状態管理で DynamoDB 不要
- Cloud Control API/SDK のハイブリッドアプローチで柔軟性を確保
- DAG ベース並列実行で高速デプロイを実現

Phase 1-8 が完了し、基本的なデプロイ機能が動作することを確認しました。Phase 9 以降で、CloudFormation 組み込み関数の解決やテスト実装などを進め、プロダクションレディなツールを目指します。

---

## 9. 現在の実装状況サマリー（2026-03-26時点）

### ✅ 2026-03-26 セッションで完了

- **Custom Resource ResponseURL** — S3 Pre-signed URL でcfn-responseハンドラ対応
- **CLI 利便性向上** — `--app`/`--state-bucket` オプショナル化（cdk.json / 環境変数フォールバック）
- **CLI スタック指定 CDK 互換化** — 位置引数 `cdkq deploy MyStack`、`--all`、ワイルドカード
- **Bootstrap デフォルトバケット名** — `cdkq-state-{accountId}-{region}` + ポリシー + 暗号化 + バージョニング
- **リソース置換** — immutableプロパティ変更時の DELETE→CREATE フロー
- **対応機能/リソース表の README** — 組み込み関数、疑似パラメータ、リソース、機能の4テーブル
- **ユニットテスト 48件** — config-loader、resource-replacement、dag-builder
- **Fn::FindInMap / Fn::Base64 実装** — Mappings参照、Base64エンコード
- **destroy UX** — Y/n デフォルトyes、`--app` 受け付け

### 🚧 未実装・次の優先タスク

1. **multi-resource 統合テスト再検証** (最優先)
   - ResponseURL 修正で `Custom::S3AutoDeleteObjects` が動作するか検証

2. **DeletionPolicy / UpdateReplacePolicy 対応** (優先度: 高)
   - 型定義はあるが未実装。`Retain` 指定リソースが destroy 時に消えてしまう
   - DELETE 時に `DeletionPolicy: Retain` をチェックしてスキップ
   - リソース置換時に `UpdateReplacePolicy: Retain` で旧リソースを保持

3. **統合テスト拡充** (優先度: 高) → 詳細: §4 タスク18
   - ECR 統合テスト（Docker Lambda）
   - API Gateway 統合テスト
   - E2E フルサイクルテスト（deploy→diff→update→destroy）

4. **リソース属性解決の強化** (優先度: 中) → 詳細: §4 タスク16
   - CC API レスポンスのフル活用 + Schema マッピング + ARN Builder

5. **Custom Resource 非同期/SNS/SFN** (優先度: 中) → 詳細: §4 タスク17

6. **ロールバック機構** (優先度: 中)

7. **IAMロール置換時の削除改善** (優先度: 中)

8. **Fn::GetAZs** (優先度: 低)

9. **Progress bar / UI** (優先度: 低)

10. **公開判断基準** (優先度: 高) → 詳細: §4 タスク20

### 📋 次のエージェントへの引き継ぎ事項

#### すぐに着手すべきタスク（優先度順）

1. **Custom Resource の CloudFormation 統合修正** (最優先)

   **問題の詳細**:
   - エラー: `getaddrinfo ENOTFOUND pre-signed-s3-url-for-response`
   - 発生場所: Custom Resource の Lambda 関数実行時
   - 原因: Lambda 関数が CloudFormation にレスポンスを返す際、pre-signed URL が正しく解決されない
   - 影響: CDK の `autoDeleteObjects: true` 機能が動作しない

   **再現方法**:

   ```bash
   cd tests/integration/examples/multi-resource
   export STATE_BUCKET="your-bucket-name"
   export AWS_REGION="us-east-1"
   node ../../../../dist/cli.js deploy \
     --app "npx ts-node --prefer-ts-exts bin/app.ts" \
     --stack CdkqMultiResourceExample \
     --state-bucket $STATE_BUCKET \
     --region $AWS_REGION
   ```

   **必要な修正**:
   - ファイル: `src/provisioning/providers/custom-resource-provider.ts`
   - 現在の実装: Lambda を invoke するが、CloudFormation へのレスポンス送信が未実装
   - 必要な実装:
     1. Lambda レスポンスから `ResponseURL` を取得
     2. HTTPS PUT リクエストで CloudFormation にレスポンス送信
     3. SUCCESS/FAILED ステータスと PhysicalResourceId を含める
   - 参考: [CloudFormation Custom Resource Response Objects](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/crpg-ref-responses.html)

   **検証方法**:
   - multi-resource テストが成功すること
   - S3 バケットが作成され、Custom Resource が正常に動作すること

2. **CLI の利便性向上** (優先度: 高)
   - `--state-bucket` の環境変数サポート: `CDKQ_STATE_BUCKET` から読み込み
   - 設定ファイル対応: `cdk.json` の `context.cdkq` セクションから読み込み
   - 実装場所: `src/cli/commands/*.ts`

3. **ロールバック機構の実装** (優先度: 中)
   - 実装場所: `src/deployment/deploy-engine.ts`
   - 参考: Terraform はロールバックをサポートしていないため、優先度は中程度

4. **残り組み込み関数の実装** (優先度: 低)
   - 実装場所: `src/deployment/intrinsic-function-resolver.ts`
   - `Fn::FindInMap`: マッピング参照
   - `Fn::GetAZs`: AZ取得
   - `Fn::Base64`: Base64エンコード

#### 重要な実装ファイル

- **CLI**: `src/cli/commands/*.ts`
- **合成**: `src/synthesis/synth.ts`
- **状態管理**: `src/state/s3-state-backend.ts`
- **DAG解析**: `src/analyzer/dag-builder.ts`
- **組み込み関数**: `src/deployment/intrinsic-function-resolver.ts`
- **リソース置き換え**: `src/analyzer/replacement-rules.ts`
- **デプロイオーケストレーション**: `src/deployment/deploy-engine.ts`
- **プロビジョニング**: `src/provisioning/cloud-control-provider.ts`

#### テスト実行方法

```bash
# ビルド
npm run build

# 型チェック
npm run typecheck

# ユニットテスト
npm test

# 統合テスト（例: basic）
export STATE_BUCKET="your-bucket-name"
export AWS_REGION="us-east-1"
cd tests/integration/examples/basic
node ../../../../dist/cli.js deploy \
  --app "npx ts-node --prefer-ts-exts bin/app.ts" \
  --stack CdkqBasicExample \
  --state-bucket $STATE_BUCKET \
  --region $AWS_REGION \
  --verbose
```

#### 既知の問題・制限事項

- Cloud Control API が一部リソースタイプ未対応 → SDK Provider で回避
- 一部組み込み関数未実装 (`Fn::FindInMap`, `Fn::GetAZs`, `Fn::Base64`)
- ロールバック機構未実装
- プロダクション使用は非推奨（開発/テスト環境のみ）
