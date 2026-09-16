# Clacel Scheduled Join Links Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 2026年9月14日から30日まで、毎日19:00のLINE予約配信へ事前登録でき、当日のClacel開催ルームへ自動接続する固定日付リンクを実装する。

**Architecture:** 日付と署名を含む参加URLを先に発行し、参加者画面は公開ステータスAPIを数秒ごとに確認する。当日の運営者がClacelルームを作成した時だけ、その日付と実ルームコードを永続ストレージへ1回だけ紐づける。終了後は完了状態を残し、同じ日付リンクが別ルームへ再利用されないようにする。

**Tech Stack:** Node.js, Express, Socket.IO, vanilla HTML/CSS/JavaScript, node:test, Railway persistent volume.

**Spec:** `docs/superpowers/specs/2026-09-14-clacel-scheduled-join-links-design.md`

**Global Constraints:** Clacelのみ対象。既存の`mode=join&room=...`、TOEIC、IELTS、通常の採点・復習ロジックは変えない。URLの改変・対象期間外・未来日・終了済みの参加を拒否する。開始後はサーバーが管理する共通の終了時刻まで途中参加を許可し、参加者ごとに時間を延長しない。秘密値はリポジトリへ保存しない。

---

### Task 1: 署名付き日付リンクの純粋ロジック

**Files:**
- Create: `scheduled-clacel-links.js`
- Create: `tests/scheduled-clacel-links.test.js`

1. 9月14日〜30日の17日分が列挙される失敗テストを書く。
2. HMAC署名が正しいURLだけを受理し、日付・コース・署名の改変を拒否する失敗テストを書く。
3. 東京日付で未来・当日・過去を判定する失敗テストを書く。
4. `node --test tests/scheduled-clacel-links.test.js`で期待どおりREDを確認する。
5. 最小実装を追加し、同テストをGREENにする。

### Task 2: 永続状態へ日付とルームの対応を追加

**Files:**
- Modify: `server.js`
- Modify: `tests/quiz-room-persistence.test.js`

1. `scheduledClacelEvents`が保存・再起動復元される失敗テストを書く。
2. 同じ東京日付のClacelルームを二重作成できない失敗テストを書く。
3. ホスト終了後にその日付が`finished`として残る失敗テストを書く。
4. 対象日以外、TOEIC、IELTSは従来どおり作成できる回帰テストを書く。
5. 各REDを確認後、状態バージョン更新・復元互換・ロールバックを最小実装する。
6. 対象テストをGREENにする。

### Task 3: 公開ステータスAPIと運営者用リンク一覧API

**Files:**
- Modify: `server.js`
- Create: `tests/scheduled-clacel-api.test.js`

1. 未認証ではリンク一覧を取得できない失敗テストを書く。
2. 認証済み運営者には17件のフル参加URLを返す失敗テストを書く。
3. 公開APIが`future`、`waiting`、`lobby`、`playing`、`finished`、`expired`を返す失敗テストを書く。
4. 改変URLと秘密値未設定を拒否する失敗テストを書く。
5. RED確認後、APIを実装してGREENにする。

### Task 4: 参加者の待機画面と自動接続

**Files:**
- Modify: `public/quiz.html`
- Modify: `tests/quiz-screen.test.js`
- Modify: `tests/join-course-label.test.js`

1. `mode=scheduled`でホーム・運営導線・ルームコード欄を隠す失敗テストを書く。
2. 開催前は待機表示、`lobby`受信後は名前入力と参加ボタンを表示する失敗テストを書く。
3. 開始後の途中参加、終了後・未来日・期限切れ・不正リンクの拒否を確認する失敗テストを書く。
4. 参加時にAPIから受け取った実ルームコードを使う失敗テストを書く。
5. RED確認後、3秒ポーリングと画面状態を最小実装しGREENにする。

### Task 5: ホスト画面のClacel共有URLを固定リンクへ変更

**Files:**
- Modify: `server.js`
- Modify: `public/quiz.html`
- Modify: `tests/operator-socket-auth.test.js`
- Modify: `tests/quiz-screen.test.js`

1. 当日のClacel作成応答に`scheduledJoinUrl`が含まれる失敗テストを書く。
2. ホスト画面だけがClacelでは固定URLを表示・コピーし、他コースは既存URLのままになる失敗テストを書く。
3. 再接続後も同じ固定URLを表示する失敗テストを書く。
4. RED確認後、作成・再接続応答と表示処理を実装しGREENにする。

### Task 6: リンク生成物と運用確認

**Files:**
- Create: `scripts/generate-clacel-line-schedule.js`
- Create: `tests/generate-clacel-line-schedule.test.js`
- Create locally, do not commit secret-bearing output: `tmp/clacel-line-schedule-2026-09-14-to-30.csv`

1. 17日分・各19:00・日付順のCSVを生成する失敗テストを書く。
2. RED確認後、環境変数の秘密値を使う生成スクリプトを実装しGREENにする。
3. 実URLとLINE用文面をローカルCSVへ生成する。秘密値そのものは表示・保存しない。

### Task 7: 全体検証・公開・画面確認

**Files:**
- Modify only if required by failing verification: scoped files above.

1. `npm test`を実行する。
2. `npm run test:deploy`を実行する。
3. `npm run test:load`で既存99人負荷を実行する。
4. 不正署名、未来日、終了済み、二重作成を反証テストする。
5. `fable-check`と`verification-before-completion`を実行する。
6. ブランチを本番リポジトリへ反映し、Railwayへ`SCHEDULE_LINK_SECRET`を設定してデプロイする。
7. 本番で9月14日・代表未来日・改変リンク、旧参加リンク、TOEIC/IELTSを確認する。
8. PC・スマホの待機前／開催後画面をスクリーンショットで保存する。
9. LINE予約画面へ17件を入力する直前に、配信先・文面・時刻をユーザーへ最終確認する。
