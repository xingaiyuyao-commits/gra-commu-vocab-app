# OSH Vocabulary Challenge ホーム復元・デプロイ一本化 設計

## 1. 目的

承認済みホームをGitHub上の正本として復元し、本番反映経路を「GitHub `main` → CI → Railway自動デプロイ」の1本に統一する。ローカル作業ツリーの未追跡ファイルや環境依存設定が本番へ混入する状態を解消する。

## 2. 現状と原因

現在は次の2経路が混在している。

1. GitHubの`main`へのpushを起点とするRailway自動デプロイ
2. ローカル作業フォルダを直接送信する`railway up`

GitHubデプロイにはコミットSHAが記録されるが、CLIデプロイにはローカルの未追跡ファイルも含まれる。さらに、`/healthz`を指定する`railway.toml`が未追跡であるため、CLIデプロイだけがヘルスチェック設定を持ち、GitHubデプロイは`healthcheckPath: null`になっている。

GitHub側にはActions、ブランチ保護、必須チェックがなく、RailwayはCI完了を待たずにデプロイを開始する。Git管理済みテストにも起動待ちの不安定さと終了しないテストがあり、そのままではCIゲートに利用できない。

## 3. 正本と責任範囲

- アプリケーションコードの正本はGitHubリポジトリ `xingaiyuyao-commits/gra-commu-vocab-test` の`main`とする。
- 本番サービスはRailwayの既存サービス `gra-commu-vocab-test` を継続利用する。
- 通常の本番反映で`railway up`を使用しない。
- Railway CLIの本番リンクは、誤送信防止のため実装完了時に解除する。
- Railwayの環境変数・ボリューム内容はGitへ保存しない。

## 4. ホーム画面

2026-09-02 11:59の添付スクリーンショットをPC版の正本とする。

### 4.1 PC

- `ÖSH Vocabulary Challenge`を中央の1行見出しとして表示する。
- 参加CTAを見出し下の中央に配置する。
- 今日の日付と学習Dayを中央の横長枠に表示する。
- 下段は2カラムとし、左に既存画像`/assets/osh-vocab-home-illustration.png`、右にコース一覧を配置する。
- コース一覧はClacel、TOEIC、IELTSの順とし、次の文言を表示する。
  - Clacel: `日常から仕事まで、使える英語を。` / `基礎を積み上げながら、英語を自分の言葉にしていくコースです。`
  - TOEIC: `スコアと実務につながる英語を。` / `頻出語を確実に身につけ、試験にも仕事にも活かします。`
  - IELTS: `海外で学び、暮らすための英語を。` / `アカデミックな語彙を鍛え、世界へ踏み出す力を育てます。`
- 3コースの行と下部の`運営用`は、既存のルーム作成画面`/quiz.html?mode=create`への導線とする。

### 4.2 モバイル

- 見出し、CTA、Day欄、画像、コース一覧の順に1カラムで表示する。
- 横スクロールを発生させない。
- CTAと各コース導線は44px以上の操作領域を確保する。

### 4.3 維持する挙動

- `QuizUi.getStudyDay(new Date())`による日付・Day計算
- 参加CTAの`/quiz.html?mode=join`
- ルーム作成画面の`/quiz.html?mode=create`
- 参加画面のコース名表示

## 5. デプロイ方式

### 5.1 単一路線

1. 変更をGitへコミットする。
2. `main`へpushする。
3. GitHub Actionsがデプロイ対象テストを実行する。
4. Railwayの`Wait for CI`が成功を待つ。
5. CI成功時だけRailwayがGitHubのコミットSHAをビルドする。
6. `/healthz`がHTTP 200を返した後に本番へ切り替える。
7. 本番URLのHTMLと実表示を確認する。

### 5.2 Railway設定

- Railwayサービス設定へ`healthcheckPath=/healthz`を永続設定する。
- 未追跡の`railway.toml`は使用しない。削除は対象がこの未追跡ファイルであることを再確認してから行う。
- 自動デプロイ対象ブランチは`main`のままとする。
- GitHub Actions追加後に`Wait for CI`を有効化する。
- サービスの既存ドメイン、環境変数、リージョン、ボリュームは変更しない。

## 6. CIとテスト

### 6.1 テスト安定化

- `tests/healthz.test.js`は固定10秒待ちへの依存を減らし、子プロセスの標準エラー・終了理由を検出して確実に後始末する。
- `tests/quiz-screen.test.js`は未解決PromiseまたはJSDOMのハンドルを特定し、テスト終了時に解放する。
- 変更前に失敗・停止を再現し、変更後に同じコマンドが終了コード0で完了することを確認する。

### 6.2 GitHub Actions

- Node.js 24系を使用する。
- `npm ci`で`package-lock.json`どおりに依存関係を導入する。
- Git管理済みのデプロイ対象テストを直列実行する。
- `push`の`main`と`pull_request`を対象にする。
- タイムアウトを設定し、停止したテストを成功扱いにしない。

### 6.3 Nodeバージョン

- `package.json`の`engines.node`でNode 24系を指定し、ローカル、GitHub Actions、Railwayのメジャーバージョンを一致させる。

## 7. Git運用

- 今回変更するファイルだけを明示的に`git add`する。`git add .`は使用しない。
- 既存の141件の未追跡ファイルを削除・移動・一括ignoreしない。
- サイトと教材制作物のリポジトリ分割は第2段階の別作業とする。
- `main`のブランチ保護とPR必須化は今回は導入しない。CI待機までを必須化し、日常修正の操作量を増やさない。

## 8. ボリュームと永続化

- `/data`の既存Railwayボリュームは削除しない。
- 現行`server.js`がボリュームを利用していない問題は記録するが、今回のデプロイ一本化へ永続化実装を混ぜない。
- ルーム永続化は、データ形式・復旧条件・ボリューム内データを別途監査してから独立した設計で実装する。

## 9. 検証

### 9.1 ローカル

- ホーム構造テスト
- Day計算テスト
- 参加コース表示テスト
- ヘルスチェックテスト
- クイズ画面テスト
- PC幅と390px幅で実ブラウザ確認
- `scrollWidth === clientWidth`の確認

### 9.2 GitHub・Railway

- GitHub Actions成功
- Railwayデプロイの`commitHash`がGitHubのHEADと一致
- Railwayデプロイ設定で`healthcheckPath=/healthz`
- Railwayデプロイ成功
- 本番`/healthz`がHTTP 200
- 本番ホームの画像が898×518で読込完了
- CTAと作成導線が期待URLへ遷移

## 10. ロールバック

- アプリケーション変更に問題があれば、直前の正常コミットを`git revert`してpushする。
- Railway設定変更に問題があれば、変更した設定項目だけを直前値へ戻す。
- 既存の本番ドメイン、環境変数、ボリュームは触らないため、それらの復旧操作は不要とする。

## 11. 完了条件

- 添付スクリーンショットのPC構成とモバイル1カラムが本番で確認できる。
- デプロイ経路がGitHub自動デプロイだけになる。
- CI失敗時はRailwayデプロイが開始または本番切替されない。
- GitHub由来の本番デプロイに`/healthz`設定が適用される。
- 対象テストが停止せず、終了コード0で完了する。
- ホームHTML、画像、CI、運用手順がすべてGit管理される。
