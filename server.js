const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { randomBytes, timingSafeEqual } = require("crypto");
const { Server } = require("socket.io");
const QUESTIONS = require("./questions");
const SENTENCES = require("./sentences");

const HIGHSCORE_FILE = path.join(__dirname, "highscore.json");

function loadHighscore() {
  try {
    const hs = JSON.parse(fs.readFileSync(HIGHSCORE_FILE, "utf8"));
    return { bestAvg: hs.bestAvg || 0, date: hs.date || null };
  } catch {
    return { bestAvg: 0, date: null };
  }
}

function saveHighscore(hs) {
  try {
    fs.writeFileSync(HIGHSCORE_FILE, JSON.stringify(hs));
  } catch (e) {
    console.error("highscore save failed:", e.message);
  }
}

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// ソケットイベント内の例外はNode側で捕捉されずプロセス全体を落とすため、
// ここで受け止めて他の進行中ルームを巻き込まないようにする（復旧不能な状態異常より全断のほうが実害が大きい）
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));
app.use(express.static(path.join(__dirname, "public")));

const TOTAL_QUESTIONS = 20;
const rooms = {}; // roomCode -> room state

function makeRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return rooms[code] ? makeRoomCode() : code;
}

function pickQuestions() {
  const shuffled = [...QUESTIONS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, TOTAL_QUESTIONS);
}

function publicPlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id,
    name: p.name,
    correct: p.correct,
    wrong: p.wrong,
    net: p.correct - p.wrong,
    answered: p.answeredCurrent,
  }));
}

function sendQuestion(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.phase !== "playing") return;
  const q = room.questions[room.currentIndex];
  for (const p of Object.values(room.players)) p.answeredCurrent = false;
  io.to(roomCode).emit("question", {
    index: room.currentIndex,
    total: TOTAL_QUESTIONS,
    sentence: q.sentence,
    hint: q.hint,
    ja: q.ja,
    coins: room.coins,
    deadline: room.deadline,
    players: publicPlayers(room),
  });
}

function endGame(roomCode, timedOut) {
  const room = rooms[roomCode];
  if (!room || room.phase !== "playing") return;
  room.phase = "finished";
  clearTimeout(room.timer);

  const players = publicPlayers(room);
  const topContributors = [...players]
    .sort((a, b) => b.net - a.net || b.correct - a.correct)
    .slice(0, 3);

  // 記録は「1人あたり平均コイン数」で人数差を吸収して比較する
  const playerCount = Object.keys(room.players).length;
  const avgCoins = playerCount > 0 ? room.coins / playerCount : 0;
  const hs = loadHighscore();
  const isNewRecord = avgCoins > hs.bestAvg;
  const prevBestAvg = hs.bestAvg;
  if (isNewRecord) saveHighscore({ bestAvg: avgCoins, date: new Date().toISOString() });

  io.to(roomCode).emit("gameOver", {
    coins: room.coins,
    maxCoins: TOTAL_QUESTIONS * playerCount,
    questionsCompleted: room.currentIndex,
    totalQuestions: TOTAL_QUESTIONS,
    timedOut,
    players,
    topContributors,
    avgCoins,
    prevBestAvg,
    isNewRecord,
  });
}

function maybeAdvance(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const allAnswered = Object.values(room.players).every((p) => p.answeredCurrent);
  if (!allAnswered) return;

  const q = room.questions[room.currentIndex];
  setTimeout(() => {
    if (!rooms[roomCode] || room.phase !== "playing") return;
    room.currentIndex++;
    if (room.currentIndex >= TOTAL_QUESTIONS) {
      endGame(roomCode, false);
    } else {
      io.to(roomCode).emit("reveal", { answer: q.answer });
      setTimeout(() => sendQuestion(roomCode), 2000);
    }
  }, 800);
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name } = {}, cb = () => {}) => {
    const roomCode = makeRoomCode();
    rooms[roomCode] = {
      host: socket.id,
      phase: "lobby",
      coins: 0,
      currentIndex: 0,
      questions: pickQuestions(),
      players: {},
    };
    joinRoom(socket, roomCode, name, cb);
  });

  socket.on("joinRoom", ({ roomCode, name } = {}, cb = () => {}) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb({ error: "ルームが見つかりません" });
    if (room.phase !== "lobby") return cb({ error: "ゲームはすでに開始しています" });
    joinRoom(socket, code, name, cb);
  });

  socket.on("startGame", (opts = {}) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.host !== socket.id || room.phase !== "lobby") return;
    const sec = Math.min(600, Math.max(10, Number(opts && opts.timeLimitSec) || 180));
    room.phase = "playing";
    room.deadline = Date.now() + sec * 1000;
    room.timer = setTimeout(() => endGame(roomCode, true), sec * 1000);
    sendQuestion(roomCode);
  });

  socket.on("answer", ({ text } = {}) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.phase !== "playing") return;
    const player = room.players[socket.id];
    if (!player || player.answeredCurrent) return;

    const q = room.questions[room.currentIndex];
    const correct = String(text || "").trim().toLowerCase() === q.answer;
    player.answeredCurrent = true;
    if (correct) {
      player.correct++;
      room.coins++;
    } else {
      player.wrong++;
      room.coins = Math.max(0, room.coins - 1);
    }

    socket.emit("answerResult", { correct, answer: correct ? undefined : null });
    io.to(roomCode).emit("coinsUpdate", {
      coins: room.coins,
      players: publicPlayers(room),
      lastEvent: { name: player.name, correct },
    });
    maybeAdvance(roomCode);
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;
    delete room.players[socket.id];
    if (Object.keys(room.players).length === 0) {
      clearTimeout(room.timer);
      delete rooms[roomCode];
      return;
    }
    if (room.host === socket.id) room.host = Object.keys(room.players)[0];
    io.to(roomCode).emit("playersUpdate", {
      hostId: room.host,
      players: publicPlayers(room),
      hostName: room.players[room.host].name,
    });
    if (room.phase === "playing") maybeAdvance(roomCode);
  });

  function joinRoom(sock, roomCode, name, cb) {
    const room = rooms[roomCode];
    sock.join(roomCode);
    sock.data.roomCode = roomCode;
    room.players[sock.id] = {
      name: String(name || "名無し").slice(0, 12),
      correct: 0,
      wrong: 0,
      answeredCurrent: false,
    };
    cb({ roomCode, isHost: room.host === sock.id });
    io.to(roomCode).emit("playersUpdate", {
      hostId: room.host,
      players: publicPlayers(room),
      hostName: room.players[room.host].name,
    });
  }
});

/* ========== 並べ替えバトル（チーム対抗） ========== */

const ORDER_ROUNDS = 5;
const ROUND_TIME_MS = 60000;
const FREEZE_MS = 3000;
const orderRooms = {}; // roomCode -> room state

function makeOrderRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return orderRooms[code] ? makeOrderRoomCode() : code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function orderTeamMembers(room, team) {
  return Object.entries(room.players).filter(([, p]) => p.team === team);
}

function orderPublicState(room) {
  return {
    scores: room.scores,
    teams: {
      red: orderTeamMembers(room, "red").map(([, p]) => p.name),
      blue: orderTeamMembers(room, "blue").map(([, p]) => p.name),
    },
  };
}

function orderStartRound(roomCode) {
  const room = orderRooms[roomCode];
  if (!room || room.phase !== "playing") return;
  const sentence = room.sentences[room.round];
  room.progress = { red: 0, blue: 0 };
  room.roundActive = true;
  room.deadline = Date.now() + ROUND_TIME_MS;

  room.boards = { red: [], blue: [] };
  for (const team of ["red", "blue"]) {
    const members = orderTeamMembers(room, team);
    members.forEach(([, p]) => { p.hand = []; p.frozenUntil = 0; });
    shuffle(sentence.words).forEach((word, i) => {
      const [id, p] = members[i % members.length];
      p.hand.push(word);
      room.boards[team].push({ word, holderId: id, holderName: p.name });
    });
    members.forEach(([id, p]) => {
      io.to(id).emit("order:roundStart", {
        board: room.boards[team],
        round: room.round,
        totalRounds: ORDER_ROUNDS,
        ja: sentence.ja,
        wordCount: sentence.words.length,
        hand: p.hand,
        yourTeam: team,
        deadline: room.deadline,
        ...orderPublicState(room),
      });
    });
  }

  clearTimeout(room.timer);
  room.timer = setTimeout(() => orderEndRound(roomCode, "timeout"), ROUND_TIME_MS);
}

function orderEndRound(roomCode, reason) {
  const room = orderRooms[roomCode];
  if (!room || !room.roundActive) return;
  room.roundActive = false;
  clearTimeout(room.timer);

  let winner;
  if (reason === "complete") {
    winner = room.progress.red >= room.sentences[room.round].words.length ? "red" : "blue";
  } else {
    winner =
      room.progress.red > room.progress.blue ? "red" :
      room.progress.blue > room.progress.red ? "blue" : "draw";
  }
  if (winner !== "draw") room.scores[winner]++;

  const sentence = room.sentences[room.round];
  io.to(roomCode).emit("order:roundResult", {
    winner,
    reason,
    sentence: sentence.words.join(" "),
    ja: sentence.ja,
    round: room.round,
    totalRounds: ORDER_ROUNDS,
    ...orderPublicState(room),
  });

  room.round++;
  setTimeout(() => {
    if (!orderRooms[roomCode]) return;
    if (room.round >= ORDER_ROUNDS) orderEndGame(roomCode, null);
    else orderStartRound(roomCode);
  }, 4000);
}

function orderEndGame(roomCode, forcedWinner) {
  const room = orderRooms[roomCode];
  if (!room || room.phase !== "playing") return;
  room.phase = "finished";
  clearTimeout(room.timer);
  const { red, blue } = room.scores;
  const winner = forcedWinner || (red > blue ? "red" : blue > red ? "blue" : "draw");
  io.to(roomCode).emit("order:gameOver", {
    winner,
    forced: !!forcedWinner,
    ...orderPublicState(room),
    contributions: Object.values(room.players)
      .map((p) => ({ name: p.name, team: p.team, placed: p.placed }))
      .sort((a, b) => b.placed - a.placed),
  });
}

io.on("connection", (socket) => {
  socket.on("order:createRoom", ({ name } = {}, cb = () => {}) => {
    const roomCode = makeOrderRoomCode();
    orderRooms[roomCode] = {
      host: socket.id,
      phase: "lobby",
      players: {},
      scores: { red: 0, blue: 0 },
      sentences: shuffle(SENTENCES).slice(0, ORDER_ROUNDS),
      round: 0,
      progress: { red: 0, blue: 0 },
      roundActive: false,
    };
    orderJoin(socket, roomCode, name, cb);
  });

  socket.on("order:joinRoom", ({ roomCode, name } = {}, cb = () => {}) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const room = orderRooms[code];
    if (!room) return cb({ error: "ルームが見つかりません" });
    if (room.phase !== "lobby") return cb({ error: "ゲームはすでに開始しています" });
    orderJoin(socket, code, name, cb);
  });

  socket.on("order:startGame", () => {
    const roomCode = socket.data.orderRoomCode;
    const room = orderRooms[roomCode];
    if (!room || room.host !== socket.id || room.phase !== "lobby") return;
    if (Object.keys(room.players).length < 2) {
      socket.emit("order:error", { message: "2人以上で開始できます" });
      return;
    }
    const ids = shuffle(Object.keys(room.players));
    ids.forEach((id, i) => { room.players[id].team = i % 2 === 0 ? "red" : "blue"; });
    room.phase = "playing";
    orderStartRound(roomCode);
  });

  socket.on("order:place", ({ word } = {}) => {
    const roomCode = socket.data.orderRoomCode;
    const room = orderRooms[roomCode];
    if (!room || room.phase !== "playing" || !room.roundActive) return;
    const player = room.players[socket.id];
    if (!player || Date.now() < player.frozenUntil) return;

    const idx = player.hand.indexOf(word);
    if (idx === -1) return;

    const team = player.team;
    const sentence = room.sentences[room.round];
    const expected = sentence.words[room.progress[team]];

    if (word === expected) {
      player.hand.splice(idx, 1);
      player.placed++;
      room.progress[team]++;
      const bi = room.boards[team].findIndex((b) => b.word === word);
      if (bi !== -1) room.boards[team].splice(bi, 1);
      socket.emit("order:placeOk", { word });
      const placedWords = sentence.words.slice(0, room.progress[team]);
      for (const [id, p] of Object.entries(room.players)) {
        io.to(id).emit("order:progress", {
          team,
          count: room.progress[team],
          wordCount: sentence.words.length,
          words: p.team === team ? placedWords : undefined,
          by: p.team === team ? player.name : undefined,
        });
      }
      if (room.progress[team] >= sentence.words.length) orderEndRound(roomCode, "complete");
    } else {
      player.frozenUntil = Date.now() + FREEZE_MS;
      socket.emit("order:frozen", { until: player.frozenUntil, word });
      for (const [id, p] of Object.entries(room.players)) {
        if (p.team === team && id !== socket.id) {
          io.to(id).emit("order:teammateMiss", { name: player.name });
        }
      }
    }
  });

  socket.on("disconnect", () => {
    const roomCode = socket.data.orderRoomCode;
    const room = orderRooms[roomCode];
    if (!room) return;
    const leaving = room.players[socket.id];
    delete room.players[socket.id];

    if (Object.keys(room.players).length === 0) {
      clearTimeout(room.timer);
      delete orderRooms[roomCode];
      return;
    }
    if (room.host === socket.id) room.host = Object.keys(room.players)[0];

    if (room.phase === "playing" && leaving && leaving.team) {
      const members = orderTeamMembers(room, leaving.team);
      if (members.length === 0) {
        // チームが全滅したら相手チームの勝ち
        orderEndGame(roomCode, leaving.team === "red" ? "blue" : "red");
        return;
      }
      // 抜けた人の持ち札を残ったチームメイトに配り直す
      if (room.roundActive && leaving.hand.length > 0) {
        leaving.hand.forEach((word, i) => {
          const [nid, np] = members[i % members.length];
          np.hand.push(word);
          const entry = room.boards[leaving.team].find((b) => b.word === word);
          if (entry) { entry.holderId = nid; entry.holderName = np.name; }
        });
        members.forEach(([id, p]) => io.to(id).emit("order:handUpdate", {
          hand: p.hand,
          board: room.boards[leaving.team],
        }));
      }
    }
    io.to(roomCode).emit("order:playersUpdate", {
      hostId: room.host,
      players: Object.values(room.players).map((p) => p.name),
      hostName: room.players[room.host].name,
      ...orderPublicState(room),
    });
  });

  function orderJoin(sock, roomCode, name, cb) {
    const room = orderRooms[roomCode];
    sock.join(roomCode);
    sock.data.orderRoomCode = roomCode;
    room.players[sock.id] = {
      name: String(name || "名無し").slice(0, 12),
      team: null,
      hand: [],
      placed: 0,
      frozenUntil: 0,
    };
    cb({ roomCode, isHost: room.host === sock.id });
    io.to(roomCode).emit("order:playersUpdate", {
      hostId: room.host,
      players: Object.values(room.players).map((p) => p.name),
      hostName: room.players[room.host].name,
      ...orderPublicState(room),
    });
  }
});

/* ========== 単語テスト（シリーズ別20問・満点者掲示板） ========== */

const WORDTESTS = require("./wordtests");
const QUIZ_QUESTION_COUNT = 20;
const QUIZ_TIME_LIMIT_SEC = 300; // 5分

/* ---------- 単語リスト編集画面（管理用API） ---------- */

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const WORDTESTS_FILES = {
  clacel: path.join(__dirname, "wordtests-clacel.js"),
  ielts: path.join(__dirname, "wordtests-ielts.js"),
  toeic: path.join(__dirname, "wordtests-toeic.js"),
};

function checkAdminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).json({ error: "サーバーに ADMIN_PASSWORD が設定されていません" });
  }
  if (req.headers["x-admin-password"] !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "パスワードが違います" });
  }
  next();
}

function makeHint(answer) {
  return answer[0] + "_".repeat(answer.length - 1);
}

function validateWordtestsData(data) {
  const errors = [];
  if (!data.label) errors.push("label がありません");
  if (!Array.isArray(data.series) || data.series.length === 0) errors.push("series がありません");
  (data.series || []).forEach((s, si) => {
    if (!s.name) errors.push(`series[${si}]: name がありません`);
    const seen = new Set();
    (s.items || []).forEach((it, i) => {
      const tag = `${s.name || "series" + si} #${i + 1}`;
      if (!it.sentence || !it.sentence.includes("___")) errors.push(`${tag}: 例文に ___ がありません`);
      if (!it.answer || !/^[a-z][a-z'-]*$/.test(it.answer.toLowerCase()))
        errors.push(`${tag}: answer の形式が不正です`);
      if (it.altAnswers !== undefined) {
        if (!Array.isArray(it.altAnswers) || it.altAnswers.some((a) => !/^[a-z][a-z'-]*$/.test(String(a).toLowerCase())))
          errors.push(`${tag}: altAnswers の形式が不正です`);
      }
      if (!it.base || !/^[a-z][a-z'-]*$/.test(it.base.toLowerCase())) errors.push(`${tag}: base の形式が不正です`);
      if (!it.ja) errors.push(`${tag}: ja（日本語訳）がありません`);
      if (!it.sentenceJa) errors.push(`${tag}: sentenceJa（例文和訳）がありません`);
      const base = (it.base || "").toLowerCase();
      if (seen.has(base)) errors.push(`${s.name}: base が重複しています（${base}）`);
      seen.add(base);
    });
  });
  return errors;
}

function serializeWordtestsFile(data, filePath) {
  let headerComment = "";
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, "utf8");
    const commentLines = [];
    for (const line of existing.split("\n")) {
      if (line.startsWith("//")) commentLines.push(line);
      else break;
    }
    if (commentLines.length) headerComment = commentLines.join("\n") + "\n";
  }
  let out = headerComment;
  out += "module.exports = {\n";
  out += `  label: ${JSON.stringify(data.label)},\n`;
  out += "  series: [\n";
  data.series.forEach((s) => {
    out += "    {\n";
    out += `      name: ${JSON.stringify(s.name)},\n`;
    out += "      items: [\n";
    s.items.forEach((it) => {
      const answer = it.answer.toLowerCase();
      const base = it.base.toLowerCase();
      const altPart = Array.isArray(it.altAnswers) && it.altAnswers.length
        ? `, altAnswers: ${JSON.stringify(it.altAnswers.map((a) => String(a).toLowerCase()))}`
        : "";
      out += `        { sentence: ${JSON.stringify(it.sentence)}, answer: ${JSON.stringify(answer)}${altPart}, base: ${JSON.stringify(base)}, hint: ${JSON.stringify(makeHint(answer))}, ja: ${JSON.stringify(it.ja)}, sentenceJa: ${JSON.stringify(it.sentenceJa)} },\n`;
    });
    out += "      ],\n";
    out += "    },\n";
  });
  out += "  ],\n";
  out += "};\n";
  return out;
}

app.get("/api/admin/wordtests/:category", express.json(), checkAdminAuth, (req, res) => {
  const filePath = WORDTESTS_FILES[req.params.category];
  if (!filePath) return res.status(404).json({ error: "不明なカテゴリです" });
  delete require.cache[require.resolve(filePath)];
  res.json(require(filePath));
});

app.post("/api/admin/wordtests/:category", express.json({ limit: "2mb" }), checkAdminAuth, (req, res) => {
  const category = req.params.category;
  const filePath = WORDTESTS_FILES[category];
  if (!filePath) return res.status(404).json({ error: "不明なカテゴリです" });

  const errors = validateWordtestsData(req.body);
  if (errors.length) return res.status(400).json({ error: "検証エラー", details: errors });

  try {
    fs.writeFileSync(filePath, serializeWordtestsFile(req.body, filePath), "utf8");
    delete require.cache[require.resolve(filePath)];
    WORDTESTS[category] = require(filePath);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "保存に失敗しました: " + e.message });
  }
});

const QUIZ_CATEGORIES = ["clacel", "ielts", "toeic"];
const QUIZ_ROOM_STATE_FILE = process.env.QUIZ_ROOM_STATE_FILE
  || (fs.existsSync("/data") ? "/data/quiz-rooms.json" : null);

function loadQuizRooms() {
  if (!QUIZ_ROOM_STATE_FILE) return {};
  try {
    const saved = JSON.parse(fs.readFileSync(QUIZ_ROOM_STATE_FILE, "utf8"));
    const restored = {};
    for (const [code, room] of Object.entries(saved.rooms || {})) {
      if (!/^[A-Z2-9]{4}$/.test(code) || !room || !QUIZ_CATEGORIES.includes(room.category)) continue;
      if (!room.players || typeof room.players !== "object" || !room.players[room.host]) continue;
      restored[code] = {
        category: room.category,
        host: room.host,
        phase: ["lobby", "playing", "finished"].includes(room.phase) ? room.phase : "lobby",
        players: Object.fromEntries(Object.entries(room.players).map(([id, player]) => [id, {
          name: String(player.name || "名無し").slice(0, 12),
          sessionToken: String(player.sessionToken || ""),
          submittedAt: player.submittedAt ?? null,
          score: Number(player.score) || 0,
          leaveTimer: null,
        }])),
        questions: Array.isArray(room.questions) ? room.questions : [],
        startedAt: Number(room.startedAt) || 0,
        endsAt: Number(room.endsAt) || 0,
        setLabel: String(room.setLabel || ""),
        results: room.results || null,
        timeoutHandle: null,
      };
    }
    return restored;
  } catch (error) {
    if (error.code !== "ENOENT") console.error("quiz room restore failed:", error.message);
    return {};
  }
}

const quizRooms = loadQuizRooms(); // roomCode -> room state

function persistQuizRooms() {
  if (!QUIZ_ROOM_STATE_FILE) return;
  const rooms = {};
  for (const [code, room] of Object.entries(quizRooms)) {
    rooms[code] = {
      category: room.category,
      host: room.host,
      phase: room.phase,
      players: Object.fromEntries(Object.entries(room.players).map(([id, player]) => [id, {
        name: player.name,
        sessionToken: player.sessionToken,
        submittedAt: player.submittedAt,
        score: player.score,
      }])),
      questions: room.questions,
      startedAt: room.startedAt,
      endsAt: room.endsAt,
      setLabel: room.setLabel,
      results: room.results,
    };
  }
  const directory = path.dirname(QUIZ_ROOM_STATE_FILE);
  const temporaryFile = `${QUIZ_ROOM_STATE_FILE}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporaryFile, JSON.stringify({ version: 1, rooms }), { mode: 0o600 });
    fs.renameSync(temporaryFile, QUIZ_ROOM_STATE_FILE);
  } catch (error) {
    console.error("quiz room save failed:", error.message);
    try { fs.unlinkSync(temporaryFile); } catch {}
  }
}

function makeQuizRoomCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return quizRooms[code] ? makeQuizRoomCode() : code;
}

function makeQuizSessionToken() {
  return randomBytes(32).toString("base64url");
}

function makeQuizPlayerId(room) {
  let id;
  do id = `p_${randomBytes(16).toString("hex")}`;
  while (room.players[id]);
  return id;
}

function quizSessionTokenMatches(expected, provided) {
  if (typeof expected !== "string" || typeof provided !== "string") return false;
  const expectedBytes = Buffer.from(expected);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

function quizPublicPlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id,
    name: p.name,
    submitted: p.submittedAt !== null,
  }));
}

function quizPlayersUpdate(roomCode) {
  const room = quizRooms[roomCode];
  if (!room || !room.players[room.host]) return;
  io.to(roomCode).emit("quiz:playersUpdate", {
    hostId: room.host,
    hostName: room.players[room.host].name,
    players: quizPublicPlayers(room),
  });
}

// 例文に時制を示す語がなく現在形・過去形どちらも文法的に成立してしまう設問は、
// altAnswers に許容する別解（三単現形など）を列挙しておくと両方を正解扱いにできる。
function quizAnswerMatches(q, submitted) {
  const mine = String(submitted || "").trim().toLowerCase();
  if (!mine) return false;
  if (mine === q.answer) return true;
  return Array.isArray(q.altAnswers) && q.altAnswers.includes(mine);
}

function quizHint(base) {
  return base[0] + "_".repeat(base.length - 1);
}

function quizSanitizedQuestions(room) {
  return room.questions.map((q) => ({ sentence: q.sentence, hint: quizHint(q.base), ja: q.ja, sentenceJa: q.sentenceJa }));
}

// ホストは開催者であり自分では回答しないため、提出必須人数・採点・結果表示の対象から常に除く
function quizParticipants(room) {
  return Object.entries(room.players)
    .filter(([id]) => id !== room.host)
    .map(([id, p]) => ({ id, ...p }));
}

// 制限時間が来たら、まだ提出していない参加者を0点扱いで確定させる。
// ただしこれだけでは結果発表は行わない（発表はホストのquiz:revealResults操作を待つ）。
function quizForceFinish(roomCode) {
  const room = quizRooms[roomCode];
  if (!room || room.phase !== "playing") return;
  for (const p of quizParticipants(room)) {
    if (p.submittedAt === null) {
      room.players[p.id].score = 0;
      room.players[p.id].submittedAt = Date.now();
    }
  }
  persistQuizRooms();
  quizCheckAllSubmitted(roomCode);
}

// 全員（ホストを除く参加者）の提出が揃ったことを検知し、結果発表が可能になったことを
// クライアントへ知らせる。結果の計算・発表そのものはquizRevealResults()（ホストの操作）が行う。
function quizCheckAllSubmitted(roomCode) {
  const room = quizRooms[roomCode];
  if (!room || room.phase !== "playing") return;
  const participants = quizParticipants(room);
  if (participants.length === 0 || !participants.every((p) => p.submittedAt !== null)) return;
  if (room.timeoutHandle) {
    clearTimeout(room.timeoutHandle);
    room.timeoutHandle = null;
  }
  io.to(roomCode).emit("quiz:readyToReveal");
}

// ホストの操作で結果発表を確定させる。参加者全員が提出済みであることを再確認してから発表する。
function quizRevealResults(roomCode) {
  const room = quizRooms[roomCode];
  if (!room || room.phase !== "playing") return;
  const participants = quizParticipants(room);
  if (participants.length === 0 || !participants.every((p) => p.submittedAt !== null)) return;
  room.phase = "finished";
  const total = room.questions.length;
  const entries = participants.map((p) => ({
    id: p.id,
    name: p.name,
    score: p.score,
    total,
    timeMs: p.submittedAt - room.startedAt,
  }));
  const perfect = entries
    .filter((e) => e.score === e.total)
    .sort((a, b) => a.timeMs - b.timeMs)
    .map((e) => ({ id: e.id, name: e.name, timeMs: e.timeMs }));
  const others = entries.filter((e) => e.score !== e.total);
  room.results = {
    setLabel: room.setLabel,
    perfect,
    others,
    review: room.questions.map((q) => ({ sentence: q.sentence, answer: q.answer, altAnswers: q.altAnswers, ja: q.ja, sentenceJa: q.sentenceJa })),
  };
  persistQuizRooms();
  io.to(roomCode).emit("quiz:results", room.results);
}

// 通信切断では呼ばず、画面の「退出」操作だけで参加者またはルームを削除する。
function quizFinalizePlayerLeave(roomCode, playerId) {
  const room = quizRooms[roomCode];
  if (!room) return;
  const player = room.players[playerId];
  if (player && player.leaveTimer) clearTimeout(player.leaveTimer);
  if (room.host === playerId) {
    if (room.timeoutHandle) clearTimeout(room.timeoutHandle);
    io.to(roomCode).emit("quiz:roomClosed");
    delete quizRooms[roomCode];
    persistQuizRooms();
    return;
  }
  delete room.players[playerId];
  if (Object.keys(room.players).length === 0) {
    if (room.timeoutHandle) clearTimeout(room.timeoutHandle);
    delete quizRooms[roomCode];
    persistQuizRooms();
    return;
  }
  persistQuizRooms();
  quizPlayersUpdate(roomCode);
  if (room.phase === "playing") quizCheckAllSubmitted(roomCode);
}

io.on("connection", (socket) => {
  socket.on("quiz:createRoom", ({ category, name } = {}, cb = () => {}) => {
    if (!QUIZ_CATEGORIES.includes(category)) return cb({ error: "カテゴリが不正です" });
    const roomCode = makeQuizRoomCode();
    quizRooms[roomCode] = {
      category,
      host: null,
      phase: "lobby",
      players: {},
      questions: [],
      startedAt: 0,
      results: null,
    };
    quizJoin(socket, roomCode, name, cb);
  });

  socket.on("quiz:roomInfo", ({ roomCode } = {}, cb = () => {}) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const room = quizRooms[code];
    if (!room) return cb({ error: "ルームが見つかりません" });
    cb({ category: room.category });
  });

  socket.on("quiz:joinRoom", ({ roomCode, name } = {}, cb = () => {}) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const room = quizRooms[code];
    if (!room) return cb({ error: "ルームが見つかりません" });
    if (room.phase !== "lobby") return cb({ error: "テストはすでに開始しています" });
    quizJoin(socket, code, name, cb);
  });

  // リロード・再接続で同じplayerIdが戻ってきたら、進行中の状態のまま復帰させる
  socket.on("quiz:rejoin", ({ roomCode, playerId, sessionToken } = {}, cb = () => {}) => {
    const code = String(roomCode || "").toUpperCase().trim();
    const room = quizRooms[code];
    const player = room && playerId && room.players[playerId];
    if (!room || !player || !quizSessionTokenMatches(player.sessionToken, sessionToken)) return cb({ ok: false });

    if (player.leaveTimer) {
      clearTimeout(player.leaveTimer);
      player.leaveTimer = null;
    }
    socket.join(code);
    socket.data.quizRoomCode = code;
    socket.data.quizPlayerId = playerId;

    const res = {
      ok: true,
      isHost: room.host === playerId,
      category: room.category,
      phase: room.phase,
      submitted: player.submittedAt !== null,
      seriesNames: WORDTESTS[room.category].series.map((s) => s.name),
    };
    if (room.phase === "playing") {
      res.setLabel = room.setLabel;
      res.total = room.questions.length;
      res.endsAt = room.endsAt;
      res.questions = quizSanitizedQuestions(room);
      const participants = quizParticipants(room);
      res.submittedCount = participants.filter((p) => p.submittedAt !== null).length;
      res.totalCount = participants.length;
      res.allSubmitted = participants.length > 0 && res.submittedCount === res.totalCount;
    } else if (room.phase === "finished" && room.results) {
      res.results = room.results;
    }
    cb(res);
    quizPlayersUpdate(code);
  });

  socket.on("quiz:startGame", ({ seriesIndex } = {}) => {
    const roomCode = socket.data.quizRoomCode;
    const room = quizRooms[roomCode];
    if (!room || room.host !== socket.data.quizPlayerId || room.phase !== "lobby") return;
    const cat = WORDTESTS[room.category];
    const series = cat && cat.series[Number(seriesIndex)];
    if (!series) return;
    room.questions = shuffle(series.items).slice(0, QUIZ_QUESTION_COUNT);
    room.phase = "playing";
    room.startedAt = Date.now();
    room.endsAt = room.startedAt + QUIZ_TIME_LIMIT_SEC * 1000;
    room.setLabel = `${cat.label} ${series.name}`;
    room.results = null;
    if (room.timeoutHandle) clearTimeout(room.timeoutHandle);
    room.timeoutHandle = setTimeout(() => quizForceFinish(roomCode), QUIZ_TIME_LIMIT_SEC * 1000);
    for (const p of Object.values(room.players)) {
      p.submittedAt = null;
      p.score = 0;
    }
    persistQuizRooms();
    io.to(roomCode).emit("quiz:started", {
      setLabel: room.setLabel,
      total: room.questions.length,
      endsAt: room.endsAt,
      questions: quizSanitizedQuestions(room),
    });
  });

  socket.on("quiz:submit", ({ answers } = {}) => {
    const roomCode = socket.data.quizRoomCode;
    const room = quizRooms[roomCode];
    if (!room || room.phase !== "playing") return;
    if (socket.data.quizPlayerId === room.host) return; // ホストは開催者であり回答しない
    const player = room.players[socket.data.quizPlayerId];
    if (!player || player.submittedAt !== null) return;
    const arr = Array.isArray(answers) ? answers : [];
    player.score = room.questions.reduce(
      (n, q, i) => n + (quizAnswerMatches(q, arr[i]) ? 1 : 0),
      0
    );
    player.submittedAt = Date.now();
    persistQuizRooms();
    const participants = quizParticipants(room);
    io.to(roomCode).emit("quiz:submitProgress", {
      submitted: participants.filter((p) => p.submittedAt !== null).length,
      total: participants.length,
    });
    quizCheckAllSubmitted(roomCode);
  });

  // ホストの操作で結果発表を確定させる。全員提出済みであることをここでも確認する
  // （制限時間が来ても自動では発表せず、必ずホストのこの操作を経由する）
  socket.on("quiz:revealResults", () => {
    const roomCode = socket.data.quizRoomCode;
    const room = quizRooms[roomCode];
    if (!room || room.host !== socket.data.quizPlayerId || room.phase !== "playing") return;
    quizRevealResults(roomCode);
  });

  socket.on("quiz:playAgain", () => {
    const roomCode = socket.data.quizRoomCode;
    const room = quizRooms[roomCode];
    if (!room || room.host !== socket.data.quizPlayerId || room.phase !== "finished") return;
    room.phase = "lobby";
    room.questions = [];
    room.results = null;
    for (const p of Object.values(room.players)) {
      p.submittedAt = null;
      p.score = 0;
    }
    persistQuizRooms();
    io.to(roomCode).emit("quiz:backToLobby");
    quizPlayersUpdate(roomCode);
  });

  socket.on("quiz:leave", () => {
    const roomCode = socket.data.quizRoomCode;
    const playerId = socket.data.quizPlayerId;
    socket.data.quizRoomCode = null;
    socket.data.quizPlayerId = null;
    if (!roomCode || !playerId) return;
    quizFinalizePlayerLeave(roomCode, playerId);
  });

  function quizJoin(sock, roomCode, name, cb) {
    const room = quizRooms[roomCode];
    const id = makeQuizPlayerId(room);
    sock.join(roomCode);
    sock.data.quizRoomCode = roomCode;
    sock.data.quizPlayerId = id;
    room.players[id] = {
      name: String(name || "名無し").slice(0, 12),
      sessionToken: makeQuizSessionToken(),
      submittedAt: null,
      score: 0,
      leaveTimer: null,
    };
    if (!room.host) room.host = id;
    persistQuizRooms();
    const seriesNames = WORDTESTS[room.category].series.map((s) => s.name);
    cb({
      roomCode,
      isHost: room.host === id,
      category: room.category,
      playerId: id,
      sessionToken: room.players[id].sessionToken,
      seriesNames,
    });
    quizPlayersUpdate(roomCode);
  }
});

for (const [roomCode, room] of Object.entries(quizRooms)) {
  if (room.phase !== "playing") continue;
  const remainingMs = room.endsAt - Date.now();
  room.timeoutHandle = setTimeout(() => quizForceFinish(roomCode), Math.max(0, remainingMs));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
