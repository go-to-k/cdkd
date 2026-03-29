# cdkd Benchmark

cdkd と CloudFormation のデプロイ速度を比較するベンチマークスクリプトです。

## 概要

`basic` サンプル（S3 バケット）を使用して、以下のフェーズを個別に計測します:

- **Synthesis** - CDK アプリから CloudFormation テンプレートへの変換時間
- **Deploy** - リソース作成を含むデプロイ全体の時間（Synthesis + アセット発行 + リソース作成）
- **Total** - 上記の合計

## 前提条件

- AWS 認証情報が設定済みであること
- Node.js >= 20.0.0
- cdkd がビルド済みであること（`npm run build`）
- CloudFormation ベンチマークには `cdk` CLI が必要（`npm install -g aws-cdk`）

## 使い方

### 基本

```bash
# cdkd と CloudFormation の両方を計測
./tests/benchmark/run-benchmark.sh

# State bucket を明示的に指定
STATE_BUCKET=my-bucket AWS_REGION=ap-northeast-1 ./tests/benchmark/run-benchmark.sh
```

### cdkd のみ計測

```bash
SKIP_CFN=true ./tests/benchmark/run-benchmark.sh
```

### CloudFormation のみ計測

```bash
SKIP_CDKD=true ./tests/benchmark/run-benchmark.sh
```

### リージョン指定

```bash
AWS_REGION=us-east-1 ./tests/benchmark/run-benchmark.sh
```

## 環境変数

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `STATE_BUCKET` | cdkd の状態管理用 S3 バケット | 自動解決（`cdkd-state-{accountId}-{region}`） |
| `AWS_REGION` | AWS リージョン | `ap-northeast-1` |
| `CDKD_BIN` | cdkd バイナリのパス | `./dist/cli.js` |
| `SKIP_CFN` | `true` で CloudFormation ベンチマークをスキップ | `false` |
| `SKIP_CDKD` | `true` で cdkd ベンチマークをスキップ | `false` |
| `RUNS` | 計測回数（最後の結果が使用される） | `1` |

## 出力例

```
## Benchmark Results: basic (S3 Bucket)

| Phase          | cdkd    | CloudFormation | Speedup |
|----------------|---------|----------------|---------|
| Synthesis      | 4.2s    | 4.2s           | 1.0x    |
| Deploy (total) | 8.5s    | 62.3s          | 7.3x    |
| Total          | 12.7s   | 66.5s          | 5.2x    |
```

結果は `tests/benchmark/results-YYYYMMDD-HHMMSS.md` にも保存されます。

## cdkd が速い理由

cdkd は CloudFormation をバイパスし、Cloud Control API を直接使用してリソースをプロビジョニングします。これにより以下のオーバーヘッドが排除されます:

1. **Change Set の作成・実行** - CloudFormation は変更セットを作成してから実行する 2 段階のプロセス
2. **スタックステータスのポーリング** - `CREATE_IN_PROGRESS` -> `CREATE_COMPLETE` の状態遷移待ち
3. **ドリフト検出** - CloudFormation の内部的な整合性チェック
4. **テンプレートの検証** - CloudFormation 側でのテンプレート解析

cdkd は DAG ベースの並列実行により、依存関係のないリソースを同時にデプロイすることも可能です。

## 注意事項

- ベンチマーク結果はネットワーク状況や AWS API のレイテンシにより変動します
- 初回実行時は CDK Toolkit のブートストラップが必要な場合があります（CloudFormation 側）
- 結果ファイル（`results-*.md`）は `.gitignore` に追加することを推奨します
