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

### 優先度: 高 (High Priority)

#### 1. CloudFormation 組み込み関数の追加対応

**未実装の関数**:

- [ ] Parameters のサポートと Ref (Parameters への参照) の解決
- [ ] Conditions の基本サポート
- [ ] Fn::ImportValue, Fn::Split
- [ ] Fn::Select, Fn::If などの複雑な関数

**影響範囲**: `src/analyzer/intrinsic-function-resolver.ts`

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

#### 8. ドキュメント作成

- [ ] **アーキテクチャドキュメント** (`docs/architecture.md`)
- [ ] **状態管理仕様** (`docs/state-management.md`)
- [ ] **プロバイダー開発ガイド** (`docs/provider-development.md`)
- [ ] **トラブルシューティングガイド** (`docs/troubleshooting.md`)

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

- [ ] Fn::ImportValue, Fn::Split 対応
- [ ] Fn::Select, Fn::If などの複雑な関数
- [ ] Conditions の完全サポート

**注**: 基本的な関数は優先度「高」で対応予定。

#### 13. IAM ロール置換時の古いリソース削除改善

**課題**: 現在、削除失敗を警告のみ → リソースリークの可能性。

**実装内容**:

- [ ] 削除失敗時にエラーを投げる
- [ ] 孤立リソースの追跡

**影響範囲**: `src/provisioning/providers/iam-role-provider.ts:190-202`

#### 14. requiresReplacement の正確な判定

**課題**: 現在、すべてのプロパティ変更を `requiresReplacement: false` として扱う。

**実装内容**:

- [ ] リソースタイプごとのスキーマに基づいて判定

**影響範囲**: `src/analyzer/diff-calculator.ts`

---

## 5. Phase 10-11: 開発環境改善・リリース準備

### Phase 10: 開発環境改善

- [ ] **npm から pnpm への移行**
- [ ] **プログレス表示(進捗バー)**

### Phase 11: リリース準備

- [ ] パフォーマンスベンチマーク
- [ ] セキュリティ監査
- [ ] npm パッケージ化
- [ ] README/例集整備

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
