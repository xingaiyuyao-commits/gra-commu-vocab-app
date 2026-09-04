// 単語テストのサーバーフロー検証。使い方: node scripts/test-quiz-flow.js
// ホストは開催者であり自分では回答しない前提（提出必須人数・採点・結果表示の対象から除く）。
const { spawn } = require("child_process");
const path = require("path");
const { io } = require("socket.io-client");
const WORDTESTS = require("../wordtests");

const PORT = 3199;
const URL = `http://localhost:${PORT}`;
const TEST_OPERATOR_PASSWORD = "flow-test-operator-password";
const connect = (cookie = "") => io(URL, {
  transports: ["websocket"],
  extraHeaders: cookie ? { Cookie: cookie } : undefined,
});
const results = [];
const check = (cond, msg) => { results.push(cond); console.log((cond ? "ok:" : "FAIL:"), msg); };

async function main() {
  const server = spawn("node", [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(PORT), OPERATOR_PASSWORD: TEST_OPERATOR_PASSWORD },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((res) => server.stdout.on("data", (d) => { if (d.toString().includes("Server running")) res(); }));

  try {
    const login = await fetch(`${URL}/api/operator/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: TEST_OPERATOR_PASSWORD }),
    });
    const operatorCookie = login.headers.get("set-cookie").split(";", 1)[0];
    // --- シナリオ1: ホスト1人＋参加者2人で通しプレイ（正解/不正解・順位・答え合わせ） ---
    const host = connect(operatorCookie);
    const g1a = connect();
    const g1b = connect();

    const created = await new Promise((res) => host.emit("quiz:createRoom", { category: "ielts", name: "ホスト" }, res));
    check(!!(created.roomCode && created.isHost && created.category === "ielts"), "ルーム作成でルームコードとホスト権が返る");
    check(
      Array.isArray(created.seriesNames) &&
        JSON.stringify(created.seriesNames) === JSON.stringify(WORDTESTS.ielts.series.map((s) => s.name)),
      "ルーム作成時に実際のDay名一覧(seriesNames)が届く（欠番があっても表示名がずれない）"
    );

    const joined = await new Promise((res) => g1a.emit("quiz:joinRoom", { roomCode: created.roomCode, name: "参加者A" }, res));
    check(joined.roomCode === created.roomCode && joined.isHost === false, "ルームコードで同じロビーに入れる");
    await new Promise((res) => g1b.emit("quiz:joinRoom", { roomCode: created.roomCode, name: "参加者B" }, res));

    const bad = await new Promise((res) => g1a.emit("quiz:createRoom", { category: "bogus", name: "誰か" }, res));
    check(!!bad.error, "不正なカテゴリはエラー");

    const notFound = await new Promise((res) => g1a.emit("quiz:joinRoom", { roomCode: "ZZZZ", name: "誰か" }, res));
    check(!!notFound.error, "存在しないルームコードはエラー");

    const startedAll = Promise.all([
      new Promise((res) => host.once("quiz:started", res)),
      new Promise((res) => g1a.once("quiz:started", res)),
      new Promise((res) => g1b.once("quiz:started", res)),
    ]);
    host.emit("quiz:startGame", { seriesIndex: 0 });
    const [qh, qa] = await startedAll;
    check(qh.questions.length === 20 && qh.total === 20, "20問配布される");
    check(typeof qh.endsAt === "number" && qh.endsAt > Date.now(), "制限時間の終了時刻が届く");
    check(JSON.stringify(qh.questions) === JSON.stringify(qa.questions), "全員に同じ問題が配られる");
    check(!("answer" in qh.questions[0]), "配布した問題に答えが含まれない");
    check(/^IELTS /.test(qh.setLabel), "セット名が届く");

    // ホストが回答を送っても無視される（ホストは開催者であり参加者ではない）
    host.emit("quiz:submit", { answers: Array(20).fill("x") });
    const hostSubmitIgnored = await Promise.race([
      new Promise((res) => host.once("quiz:submitProgress", () => res("fired"))),
      new Promise((res) => setTimeout(() => res("not-fired"), 300)),
    ]);
    check(hostSubmitIgnored === "not-fired", "ホストのquiz:submitは無視される（進捗も配信されない）");

    // 正答は問題文からデータを引いて求める（参加者Aは全問正解、参加者Bは全問空欄）
    const items = WORDTESTS.ielts.series[0].items;
    const correctAnswers = qh.questions.map((q) => items.find((it) => it.sentence === q.sentence).answer);

    const readyToRevealP1 = new Promise((res) => host.once("quiz:readyToReveal", res));
    const resultsAll = Promise.all([
      new Promise((res) => host.once("quiz:results", res)),
      new Promise((res) => g1a.once("quiz:results", res)),
      new Promise((res) => g1b.once("quiz:results", res)),
    ]);
    const progressP = new Promise((res) => g1b.once("quiz:submitProgress", res));
    g1a.emit("quiz:submit", { answers: correctAnswers.map((a) => "  " + a.toUpperCase() + " ") });
    const prog = await progressP;
    check(prog.submitted === 1 && prog.total === 2, "提出状況 1/2 が配信される（ホストは総数に含まれない）");
    g1b.emit("quiz:submit", { answers: Array(20).fill("") });
    await readyToRevealP1;
    host.emit("quiz:revealResults");
    const [rh] = await resultsAll;
    check(rh.perfect.length === 1 && rh.perfect[0].name === "参加者A", "大文字・空白混じりでも正解扱いで満点者に入る");
    check(rh.others.length === 1 && rh.others[0].name === "参加者B" && rh.others[0].score === 0, "空欄は0点でその他の参加者に入る");
    check(
      [...rh.perfect, ...rh.others].every((e) => e.name !== "ホスト"),
      "結果一覧にホストは含まれない"
    );
    check(rh.review.length === 20 && rh.review.every((r) => r.answer && r.sentence.includes("___")), "答え合わせ用の正答が届く");

    // 再戦: ロビーに戻れる
    const backP = new Promise((res) => host.once("quiz:backToLobby", res));
    host.emit("quiz:playAgain");
    await backP;
    check(true, "playAgainでロビーに戻る");
    host.disconnect(); g1a.disconnect(); g1b.disconnect();

    // --- シナリオ2: プレイ中の切断で残りメンバーだけで結果発表 ---
    const h2 = connect(operatorCookie);
    const gA = connect();
    const gB = connect();
    const c2 = await new Promise((res) => h2.emit("quiz:createRoom", { category: "toeic", name: "Host" }, res));
    await new Promise((res) => gA.emit("quiz:joinRoom", { roomCode: c2.roomCode, name: "A" }, res));
    await new Promise((res) => gB.emit("quiz:joinRoom", { roomCode: c2.roomCode, name: "B" }, res));
    const started2 = new Promise((res) => h2.once("quiz:started", res));
    h2.emit("quiz:startGame", { seriesIndex: 2 });
    await started2;
    const readyToRevealP2 = new Promise((res) => h2.once("quiz:readyToReveal", res));
    const results2 = new Promise((res) => h2.once("quiz:results", res));
    gA.emit("quiz:submit", { answers: Array(20).fill("x") });
    gB.emit("quiz:leave"); // 未提出のまま明示的に退出（単なる切断＝リロードとは区別される）
    await readyToRevealP2;
    h2.emit("quiz:revealResults");
    const r2 = await results2;
    const combined2 = [...r2.perfect, ...r2.others];
    check(combined2.length === 1 && combined2[0].name === "A", "未提出者の退出後、残りだけで結果発表");
    h2.disconnect(); gA.disconnect(); gB.disconnect();

    // --- シナリオ3: プレイ中にリロード（切断→同じplayerIdで再接続）しても続きから復帰できる ---
    const h3 = connect(operatorCookie);
    const g3 = connect();
    const c3 = await new Promise((res) => h3.emit("quiz:createRoom", { category: "clacel", name: "Host" }, res));
    const joined3 = await new Promise((res) => g3.emit("quiz:joinRoom", { roomCode: c3.roomCode, name: "B" }, res));
    const started3 = new Promise((res) => h3.once("quiz:started", res));
    h3.emit("quiz:startGame", { seriesIndex: 0 });
    await started3;

    g3.disconnect(); // ページリロードを模した瞬断
    const g3b = connect();
    const rejoin = await new Promise((res) =>
      g3b.emit("quiz:rejoin", {
        roomCode: c3.roomCode,
        playerId: joined3.playerId,
        sessionToken: joined3.sessionToken,
      }, res)
    );
    check(rejoin.ok === true, "同じplayerIdでの再接続はrejoin成功を返す");
    check(rejoin.phase === "playing" && rejoin.submitted === false, "再接続時にプレイ中であることが分かる");
    check(Array.isArray(rejoin.questions) && rejoin.questions.length === 20, "再接続時に問題一式を再送してくれる");
    check(typeof rejoin.endsAt === "number" && rejoin.endsAt > Date.now(), "再接続時に残り時間の終了時刻も届く");

    // 再接続後も通常どおり提出でき、ホストの操作で結果発表される
    const readyToRevealP3 = new Promise((res) => h3.once("quiz:readyToReveal", res));
    const resultsBoth3 = Promise.all([
      new Promise((res) => h3.once("quiz:results", res)),
      new Promise((res) => g3b.once("quiz:results", res)),
    ]);
    g3b.emit("quiz:submit", { answers: Array(20).fill("y") });
    await readyToRevealP3;
    h3.emit("quiz:revealResults");
    await resultsBoth3;
    check(true, "再接続後も提出でき結果発表まで進む");
    h3.disconnect(); g3b.disconnect();

    // --- シナリオ4: 結果発表は必ずホストのquiz:revealResults操作を経由し、
    //     かつ参加者全員の提出が揃うまではその操作自体が無視される ---
    const h4 = connect(operatorCookie);
    const g4 = connect();
    const c4 = await new Promise((res) => h4.emit("quiz:createRoom", { category: "clacel", name: "Host" }, res));
    await new Promise((res) => g4.emit("quiz:joinRoom", { roomCode: c4.roomCode, name: "B" }, res));
    const started4 = new Promise((res) => h4.once("quiz:started", res));
    h4.emit("quiz:startGame", { seriesIndex: 0 });
    const q4 = await started4;
    check(
      typeof q4.questions[0].sentenceJa === "string" && q4.questions[0].sentenceJa.length > 0,
      "配布される設問に例文の日本語訳(sentenceJa)が含まれる"
    );

    // 参加者がまだ誰も提出していない時点でquiz:revealResultsを送っても結果発表は行われない
    h4.emit("quiz:revealResults");
    const prematureAttempt = await Promise.race([
      new Promise((res) => h4.once("quiz:results", () => res("fired"))),
      new Promise((res) => setTimeout(() => res("not-fired"), 300)),
    ]);
    check(prematureAttempt === "not-fired", "参加者の提出が揃う前はquiz:revealResultsを送っても結果発表されない");

    // 参加者が提出して全員分（ホストを除く）が揃うと、quiz:readyToRevealが届く（結果はまだ発表されない）
    const readyToRevealP = new Promise((res) => h4.once("quiz:readyToReveal", res));
    g4.emit("quiz:submit", { answers: Array(20).fill("y") });
    await readyToRevealP;
    const stillWaiting = await Promise.race([
      new Promise((res) => h4.once("quiz:results", () => res("fired"))),
      new Promise((res) => setTimeout(() => res("not-fired"), 300)),
    ]);
    check(stillWaiting === "not-fired", "全員提出後もホストが操作するまで結果は自動発表されない");

    // ホスト以外のquiz:revealResultsは無視される
    g4.emit("quiz:revealResults");
    const guestAttempt = await Promise.race([
      new Promise((res) => h4.once("quiz:results", () => res("fired"))),
      new Promise((res) => setTimeout(() => res("not-fired"), 300)),
    ]);
    check(guestAttempt === "not-fired", "ホスト以外のquiz:revealResultsは無視される");

    // ホストがquiz:revealResultsを送ると結果発表される
    const results4 = Promise.all([
      new Promise((res) => h4.once("quiz:results", res)),
      new Promise((res) => g4.once("quiz:results", res)),
    ]);
    h4.emit("quiz:revealResults");
    const [r4h] = await results4;
    const combined4 = [...r4h.perfect, ...r4h.others];
    check(combined4.length === 1, "ホストのquiz:revealResultsで参加者分の結果が出る（ホストは含まれない）");
    h4.disconnect(); g4.disconnect();
  } finally {
    server.kill();
  }
  const failed = results.filter((c) => !c).length;
  console.log(failed === 0 ? "ALL PASS" : `${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
