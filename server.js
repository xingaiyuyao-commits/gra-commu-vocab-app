const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { isIP, SocketAddress } = require("net");
const { createHash, createHmac, randomBytes, timingSafeEqual } = require("crypto");
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
const quizPersistenceHealth = {
  required: false,
  configured: false,
  ready: true,
  lastError: null,
  restoreFailed: false,
};

// ソケットイベント内の例外はNode側で捕捉されずプロセス全体を落とすため、
// ここで受け止めて他の進行中ルームを巻き込まないようにする（復旧不能な状態異常より全断のほうが実害が大きい）
process.on("uncaughtException", (err) => console.error("uncaughtException:", err));
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err));

app.get("/healthz", (_req, res) => {
  const ok = !quizPersistenceHealth.required
    || (quizPersistenceHealth.configured && quizPersistenceHealth.ready && !quizPersistenceHealth.lastError);
  res.status(ok ? 200 : 503).json(ok
    ? { ok: true }
    : { ok: false, error: "quiz persistence unavailable" });
});
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
const { selectReviewQuestions, ReviewSelectionError } = require("./quiz-review-selection");
const QUIZ_QUESTION_COUNT = 20;
const QUIZ_TIME_LIMIT_SEC = 300; // 5分
const QUIZ_REVIEW_TIME_LIMIT_SEC = 750; // 12分30秒

const QUIZ_CATEGORIES = ["clacel", "ielts", "toeic"];
const IS_RAILWAY_RUNTIME = Boolean(
  process.env.RAILWAY_ENVIRONMENT_ID
  || process.env.RAILWAY_SERVICE_ID
  || process.env.RAILWAY_PROJECT_ID
);
const QUIZ_ROOM_PERSISTENCE_REQUIRED = Boolean(process.env.QUIZ_ROOM_STATE_FILE) || IS_RAILWAY_RUNTIME;
const QUIZ_ROOM_STATE_FILE = process.env.QUIZ_ROOM_STATE_FILE
  || (fs.existsSync("/data") ? "/data/quiz-rooms.json" : null);
const QUIZ_PERSISTENCE_ERROR = "ルーム状態を保存できませんでした。しばらくしてからもう一度お試しください。";

quizPersistenceHealth.required = QUIZ_ROOM_PERSISTENCE_REQUIRED;
quizPersistenceHealth.configured = Boolean(QUIZ_ROOM_STATE_FILE);
if (QUIZ_ROOM_PERSISTENCE_REQUIRED && !QUIZ_ROOM_STATE_FILE) {
  quizPersistenceHealth.ready = false;
  quizPersistenceHealth.lastError = "persistent volume is not mounted";
  console.error("quiz room persistence unavailable: persistent volume is not mounted");
}

const QUIZ_MISTAKE_REASONS = ["inflection", "spelling", "blank", "other"];

function sanitizeQuizWrongAnswerReasons(reasons) {
  if (!reasons || typeof reasons !== "object" || Array.isArray(reasons)) return {};
  return Object.fromEntries(Object.entries(reasons)
    .filter(([index, reason]) => /^\d+$/.test(index) && QUIZ_MISTAKE_REASONS.includes(reason)));
}

function sanitizeQuizReasonCounts(counts) {
  return Object.fromEntries(QUIZ_MISTAKE_REASONS.map((reason) => [
    reason,
    Math.max(0, Math.trunc(Number(counts?.[reason]) || 0)),
  ]).filter(([, count]) => count > 0));
}

function sanitizeHistoryQuestionStats(stats) {
  if (!Array.isArray(stats)) return [];
  return stats.flatMap((stat) => {
    if (!stat || typeof stat !== "object" || Array.isArray(stat)) return [];
    const questionId = String(stat.questionId || "");
    const attempts = Number(stat.attempts);
    const wrongCount = Number(stat.wrongCount);
    const reasons = stat.reasonCounts;
    if (!/^[a-z0-9/_-]+$/i.test(questionId)
      || !Number.isInteger(attempts) || attempts < 0
      || !Number.isInteger(wrongCount) || wrongCount < 0 || wrongCount > attempts
      || !reasons || typeof reasons !== "object" || Array.isArray(reasons)
      || Object.keys(reasons).some((reason) => !QUIZ_MISTAKE_REASONS.includes(reason))
      || Object.values(reasons).some((count) => !Number.isInteger(count) || count < 0)) return [];
    return [{ questionId, attempts, wrongCount, reasonCounts: sanitizeQuizReasonCounts(reasons) }];
  });
}

function sanitizeStoredHistoryRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) return null;
  const day = Number(record.day);
  return {
    ...record,
    ...(Number.isInteger(day) && day > 0 ? { day } : {}),
    ...(typeof record.datasetRevision === "string" && record.datasetRevision ? { datasetRevision: record.datasetRevision } : {}),
    questionStats: sanitizeHistoryQuestionStats(record.questionStats),
  };
}

function sanitizeRestoredQuizResults(results, roomIsTrial) {
  if (!results || typeof results !== "object") return null;
  const resultAt = typeof results.resultAt === "string" && !Number.isNaN(Date.parse(results.resultAt))
    ? results.resultAt
    : null;
  const perfect = Array.isArray(results.perfect)
    ? results.perfect.filter((entry) => entry && typeof entry === "object").map((entry) => ({
      id: entry.id,
      name: entry.name,
    }))
    : [];
  const others = Array.isArray(results.others)
    ? results.others.filter((entry) => entry && typeof entry === "object").map((entry) => ({
      id: entry.id,
      name: entry.name,
      score: entry.score,
      total: entry.total,
    }))
    : [];
  return {
    ...(resultAt ? { resultAt } : {}),
    setLabel: String(results.setLabel || ""),
    perfect,
    others,
    review: Array.isArray(results.review) ? results.review : [],
    mistakes: Array.isArray(results.mistakes) ? results.mistakes.map((mistake) => ({
      ...mistake,
      ...(mistake?.reasonCounts && typeof mistake.reasonCounts === "object"
        ? { reasonCounts: sanitizeQuizReasonCounts(mistake.reasonCounts) }
        : {}),
    })) : [],
    isTrial: results.isTrial === true || roomIsTrial === true,
  };
}

function loadQuizState() {
  if (!QUIZ_ROOM_STATE_FILE) return { rooms: {}, resultHistory: {} };
  try {
    const saved = JSON.parse(fs.readFileSync(QUIZ_ROOM_STATE_FILE, "utf8"));
    const isVersionOne = saved.version === 1;
    const restored = {};
    for (const [code, room] of Object.entries(saved.rooms || {})) {
      if (!/^[A-Z2-9]{4}$/.test(code) || !room || !QUIZ_CATEGORIES.includes(room.category)) continue;
      if (!room.players || typeof room.players !== "object" || !room.players[room.host]) continue;
      const phase = ["lobby", "playing", "finished"].includes(room.phase) ? room.phase : "lobby";
      const isTrial = room.isTrial === true;
      restored[code] = {
        category: room.category,
        host: room.host,
        phase,
        players: Object.fromEntries(Object.entries(room.players).map(([id, player]) => {
          const resetLegacySubmission = isVersionOne && phase === "playing" && id !== String(room.host);
          return [id, {
            name: String(player.name || "名無し").slice(0, 12),
            sessionToken: String(player.sessionToken || ""),
            submittedAt: resetLegacySubmission ? null : (player.submittedAt ?? null),
            submissionKind: resetLegacySubmission
              ? null
              : (["manual", "timeout"].includes(player.submissionKind) ? player.submissionKind : null),
            score: resetLegacySubmission ? 0 : (Number(player.score) || 0),
            wrongQuestionIndexes: resetLegacySubmission
              ? []
              : (Array.isArray(player.wrongQuestionIndexes)
                ? player.wrongQuestionIndexes.filter((index) => Number.isInteger(index) && index >= 0)
                : []),
            wrongAnswerReasons: resetLegacySubmission
              ? {}
              : sanitizeQuizWrongAnswerReasons(player.wrongAnswerReasons),
            leaveTimer: null,
          }];
        })),
        questions: Array.isArray(room.questions) ? room.questions : [],
        startedAt: Number(room.startedAt) || 0,
        endsAt: Number(room.endsAt) || 0,
        setLabel: String(room.setLabel || ""),
        day: Number.isInteger(Number(room.day)) && Number(room.day) > 0 ? Number(room.day) : null,
        datasetRevision: String(room.datasetRevision || ""),
        isReview: room.isReview === true,
        sourceDays: Array.isArray(room.sourceDays)
          ? room.sourceDays.filter((day) => Number.isInteger(Number(day))).map(Number)
          : [],
        isTrial,
        results: sanitizeRestoredQuizResults(room.results, isTrial),
        timeoutHandle: null,
      };
    }
    const storedHistory = saved.resultHistory && typeof saved.resultHistory === "object" && !Array.isArray(saved.resultHistory)
      ? saved.resultHistory
      : {};
    const resultHistory = Object.fromEntries(Object.entries(storedHistory)
      .map(([key, record]) => [key, sanitizeStoredHistoryRecord(record)])
      .filter(([, record]) => record));
    return { rooms: restored, resultHistory };
  } catch (error) {
    if (error.code !== "ENOENT") {
      quizPersistenceHealth.ready = false;
      quizPersistenceHealth.lastError = error.message;
      quizPersistenceHealth.restoreFailed = true;
      console.error("quiz room restore failed:", error.message);
    }
    return { rooms: {}, resultHistory: {} };
  }
}

const quizState = loadQuizState();
const quizRooms = quizState.rooms; // roomCode -> room state
const resultHistory = quizState.resultHistory; // yyyy-mm-dd:category -> daily result
const RESULTS_ADMIN_PASSWORD = process.env.RESULTS_ADMIN_PASSWORD || "";
const RESULTS_HISTORY_COOKIE = "results_history_session";
const RESULTS_HISTORY_SESSION_MS = 12 * 60 * 60 * 1000;
const RESULTS_LOGIN_FAILURE_LIMIT = 5;
const RESULTS_LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
const RESULTS_LOGIN_FAILURE_MAX_IPS = 2_048;
const resultsLoginFailures = new Map();

function persistQuizState() {
  if (!QUIZ_ROOM_STATE_FILE) {
    if (QUIZ_ROOM_PERSISTENCE_REQUIRED) {
      quizPersistenceHealth.ready = false;
      quizPersistenceHealth.lastError = "persistence is not configured";
      return false;
    }
    return true;
  }
  if (quizPersistenceHealth.restoreFailed) return false;
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
        submissionKind: player.submissionKind,
        score: player.score,
        wrongQuestionIndexes: player.wrongQuestionIndexes,
        wrongAnswerReasons: player.wrongAnswerReasons,
      }])),
      questions: room.questions,
      startedAt: room.startedAt,
      endsAt: room.endsAt,
      setLabel: room.setLabel,
      day: room.day,
      datasetRevision: room.datasetRevision,
      isReview: room.isReview,
      sourceDays: room.sourceDays,
      isTrial: room.isTrial,
      results: room.results,
    };
  }
  const directory = path.dirname(QUIZ_ROOM_STATE_FILE);
  const temporaryFile = `${QUIZ_ROOM_STATE_FILE}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporaryFile, JSON.stringify({ version: 2, rooms, resultHistory }), { mode: 0o600 });
    fs.renameSync(temporaryFile, QUIZ_ROOM_STATE_FILE);
    quizPersistenceHealth.ready = true;
    quizPersistenceHealth.lastError = null;
    return true;
  } catch (error) {
    quizPersistenceHealth.ready = false;
    quizPersistenceHealth.lastError = error.message;
    console.error("quiz room save failed:", error.message);
    try { fs.unlinkSync(temporaryFile); } catch {}
    return false;
  }
}

function cloneQuizRoom(room) {
  if (!room) return null;
  return {
    ...room,
    players: Object.fromEntries(Object.entries(room.players).map(([id, player]) => [id, { ...player }])),
    questions: room.questions.slice(),
    results: room.results ? JSON.parse(JSON.stringify(room.results)) : null,
  };
}

function cloneQuizState() {
  return {
    rooms: Object.fromEntries(Object.entries(quizRooms).map(([code, room]) => [code, cloneQuizRoom(room)])),
    resultHistory: JSON.parse(JSON.stringify(resultHistory)),
  };
}

function persistQuizMutation(roomCode, mutate) {
  const before = cloneQuizState();
  mutate();
  if (persistQuizState()) return true;
  const current = quizRooms[roomCode];
  const priorRoom = before.rooms[roomCode];
  if (current?.timeoutHandle && current.timeoutHandle !== priorRoom?.timeoutHandle) clearTimeout(current.timeoutHandle);
  for (const code of Object.keys(quizRooms)) delete quizRooms[code];
  Object.assign(quizRooms, before.rooms);
  for (const key of Object.keys(resultHistory)) delete resultHistory[key];
  Object.assign(resultHistory, before.resultHistory);
  return false;
}

function resultsPasswordMatches(provided) {
  if (typeof provided !== "string") return false;
  const expectedHash = createHash("sha256").update(RESULTS_ADMIN_PASSWORD).digest();
  const providedHash = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedHash, providedHash);
}

function resultsCookieSignature(payload) {
  const key = createHmac("sha256", RESULTS_ADMIN_PASSWORD)
    .update("results-history-session-v1")
    .digest();
  return createHmac("sha256", key).update(payload).digest("base64url");
}

function makeResultsSessionToken(expiresAt) {
  const payload = `${expiresAt}.${randomBytes(16).toString("base64url")}`;
  return `${payload}.${resultsCookieSignature(payload)}`;
}

function resultsSessionTokenIsValid(token) {
  if (typeof token !== "string") return false;
  const parts = token.split(".");
  if (parts.length !== 3 || !/^\d+$/.test(parts[0]) || !parts[1] || !parts[2]) return false;
  const expiresAt = Number(parts[0]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return false;
  const payload = `${parts[0]}.${parts[1]}`;
  const expected = Buffer.from(resultsCookieSignature(payload));
  const provided = Buffer.from(parts[2]);
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function requestCookie(req, name) {
  for (const part of String(req.headers.cookie || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1 || part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim();
  }
  return "";
}

function resultsCookieAttributes() {
  const attributes = ["HttpOnly", "SameSite=Strict", "Path=/"];
  if (IS_RAILWAY_RUNTIME || process.env.NODE_ENV === "production") attributes.push("Secure");
  return attributes;
}

function setResultsSessionCookie(res) {
  const expiresAt = Date.now() + RESULTS_HISTORY_SESSION_MS;
  res.setHeader("Set-Cookie", [
    `${RESULTS_HISTORY_COOKIE}=${makeResultsSessionToken(expiresAt)}`,
    `Max-Age=${RESULTS_HISTORY_SESSION_MS / 1000}`,
    `Expires=${new Date(expiresAt).toUTCString()}`,
    ...resultsCookieAttributes(),
  ].join("; "));
}

function clearResultsSessionCookie(res) {
  res.setHeader("Set-Cookie", [
    `${RESULTS_HISTORY_COOKIE}=`,
    "Max-Age=0",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT",
    ...resultsCookieAttributes(),
  ].join("; "));
}

function cleanupResultsLoginFailures(now) {
  for (const [ip, entry] of resultsLoginFailures) {
    if (entry.resetAt <= now) resultsLoginFailures.delete(ip);
  }
  while (resultsLoginFailures.size > RESULTS_LOGIN_FAILURE_MAX_IPS) {
    resultsLoginFailures.delete(resultsLoginFailures.keys().next().value);
  }
}

function resultsLoginFailureState(ip, now) {
  cleanupResultsLoginFailures(now);
  return resultsLoginFailures.get(ip);
}

function recordResultsLoginFailure(ip, now) {
  const current = resultsLoginFailures.get(ip);
  const next = current && current.resetAt > now
    ? { count: current.count + 1, resetAt: current.resetAt }
    : { count: 1, resetAt: now + RESULTS_LOGIN_FAILURE_WINDOW_MS };
  resultsLoginFailures.delete(ip);
  if (resultsLoginFailures.size >= RESULTS_LOGIN_FAILURE_MAX_IPS) {
    resultsLoginFailures.delete(resultsLoginFailures.keys().next().value);
  }
  resultsLoginFailures.set(ip, next);
}

function normalizeResultsHistoryIp(value) {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate || candidate.includes("%")) return "";
  const version = isIP(candidate);
  if (!version) return "";
  try {
    const normalized = new SocketAddress({
      address: candidate,
      family: version === 4 ? "ipv4" : "ipv6",
      port: 0,
    }).address.toLowerCase();
    return normalized;
  } catch {
    return "";
  }
}

function resultsHistoryClientIp(req) {
  const socketIp = normalizeResultsHistoryIp(req.socket?.remoteAddress);
  if (!IS_RAILWAY_RUNTIME) return socketIp || "unknown";
  return normalizeResultsHistoryIp(req.headers["x-real-ip"]) || socketIp || "unknown";
}

function requireResultsHistoryAuth(req, res, next) {
  const token = requestCookie(req, RESULTS_HISTORY_COOKIE);
  if (!resultsSessionTokenIsValid(token)) return res.status(401).json({ error: "認証が必要です" });
  next();
}

function validHistoryMonth(month) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""));
}

function validHistoryDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const value = new Date(Date.UTC(year, month - 1, day));
  return value.getUTCFullYear() === year
    && value.getUTCMonth() === month - 1
    && value.getUTCDate() === day;
}

function sanitizedHistoryRecord(record) {
  const participantCount = Number(record?.participantCount);
  return {
    date: String(record?.date || ""),
    category: String(record?.category || ""),
    setLabel: String(record?.setLabel || ""),
    participantCount: Number.isFinite(participantCount) ? Math.max(0, Math.trunc(participantCount)) : 0,
    perfectNames: Array.isArray(record?.perfectNames) ? record.perfectNames.map((name) => String(name)) : [],
    updatedAt: String(record?.updatedAt || ""),
  };
}

app.use("/api/results-history", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!RESULTS_ADMIN_PASSWORD) {
    return res.status(503).json({ error: "結果履歴の認証が設定されていません" });
  }
  if (quizPersistenceHealth.restoreFailed) {
    return res.status(503).json({ error: "結果履歴を復元できませんでした" });
  }
  next();
});

app.post("/api/results-history/login", express.json({ limit: "1kb" }), (req, res) => {
  const now = Date.now();
  const ip = resultsHistoryClientIp(req);
  const failure = resultsLoginFailureState(ip, now);
  if (failure && failure.count >= RESULTS_LOGIN_FAILURE_LIMIT) {
    return res.status(429).json({ error: "ログイン試行が多すぎます。しばらくしてから再度お試しください" });
  }
  if (!resultsPasswordMatches(req.body?.password)) {
    recordResultsLoginFailure(ip, now);
    return res.status(401).json({ error: "認証に失敗しました" });
  }
  resultsLoginFailures.delete(ip);
  setResultsSessionCookie(res);
  res.json({ ok: true });
});

app.post("/api/results-history/logout", (_req, res) => {
  clearResultsSessionCookie(res);
  res.json({ ok: true });
});

app.get("/api/results-history", requireResultsHistoryAuth, (req, res) => {
  const month = String(req.query.month || "");
  if (!validHistoryMonth(month)) return res.status(400).json({ error: "monthはYYYY-MM形式で指定してください" });
  const records = Object.values(resultHistory)
    .filter((record) => record && String(record.date || "").startsWith(`${month}-`))
    .map(sanitizedHistoryRecord)
    .sort((a, b) => a.date.localeCompare(b.date) || a.category.localeCompare(b.category));
  res.json(records);
});

app.delete("/api/results-history/:date/:category", requireResultsHistoryAuth, (req, res) => {
  const { date, category } = req.params;
  if (!validHistoryDate(date) || !QUIZ_CATEGORIES.includes(category)) {
    return res.status(400).json({ error: "日付またはコースが不正です" });
  }
  const key = `${date}:${category}`;
  if (!Object.hasOwn(resultHistory, key)) return res.status(404).json({ error: "記録が見つかりません" });
  if (!persistQuizMutation(null, () => { delete resultHistory[key]; })) {
    return res.status(500).json({ error: QUIZ_PERSISTENCE_ERROR });
  }
  res.json({ ok: true });
});

if (QUIZ_ROOM_STATE_FILE && !quizPersistenceHealth.restoreFailed) persistQuizState();

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

function quizSeriesMeta(category) {
  return WORDTESTS[category].series.map((series) => ({
    name: series.name,
    count: series.isReview ? 50 : Math.min(QUIZ_QUESTION_COUNT, series.items.length),
    timeLimitSec: series.isReview ? QUIZ_REVIEW_TIME_LIMIT_SEC : QUIZ_TIME_LIMIT_SEC,
    isReview: series.isReview === true,
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

function quizEditDistance(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[b.length];
}

function quizMistakeReason(q, submitted) {
  const mine = String(submitted || "").trim().toLowerCase();
  if (!mine) return "blank";
  const answer = String(q.answer || "").trim().toLowerCase();
  const base = String(q.base || "").trim().toLowerCase();
  if (base && answer !== base && mine === base) return "inflection";
  const accepted = [answer, ...(Array.isArray(q.altAnswers) ? q.altAnswers : [])]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  const spellingThreshold = answer.length >= 6 ? 2 : 1;
  if (accepted.some((value) => quizEditDistance(mine, value) <= spellingThreshold)) return "spelling";
  return "other";
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
  const saved = persistQuizMutation(roomCode, () => {
    room.timeoutHandle = null;
    for (const p of quizParticipants(room)) {
      if (p.submittedAt === null) {
        room.players[p.id].score = 0;
        room.players[p.id].wrongQuestionIndexes = room.questions.map((_question, index) => index);
        room.players[p.id].wrongAnswerReasons = Object.fromEntries(
          room.questions.map((_question, index) => [index, "blank"]),
        );
        room.players[p.id].submittedAt = Date.now();
        room.players[p.id].submissionKind = "timeout";
      }
    }
  });
  if (!saved) {
    const restored = quizRooms[roomCode];
    if (restored?.phase === "playing") restored.timeoutHandle = setTimeout(() => quizForceFinish(roomCode), 1_000);
    return;
  }
  const participants = quizParticipants(room);
  io.to(roomCode).emit("quiz:submitProgress", {
    submitted: participants.filter((p) => p.submittedAt !== null).length,
    total: participants.length,
  });
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

function tokyoDateKey(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function quizResultNow() {
  const fixedIso = process.env.QUIZ_TEST_NOW_ISO;
  if (fixedIso) {
    const fixed = new Date(fixedIso);
    if (!Number.isNaN(fixed.getTime())) return fixed;
  }
  return new Date();
}

function buildQuestionStats(room, participants) {
  return room.questions.map((question, index) => {
    const wrongParticipants = participants.filter((participant) =>
      (participant.wrongQuestionIndexes || []).includes(index));
    const reasonCounts = {};
    for (const participant of wrongParticipants) {
      const reason = QUIZ_MISTAKE_REASONS.includes(participant.wrongAnswerReasons?.[index])
        ? participant.wrongAnswerReasons[index]
        : "other";
      reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;
    }
    return {
      questionId: String(question.questionId || ""),
      attempts: participants.length,
      wrongCount: wrongParticipants.length,
      reasonCounts: sanitizeQuizReasonCounts(reasonCounts),
    };
  });
}

function topThreeMistakes(questionStats, questions) {
  return questionStats
    .map((stat, index) => ({ stat, index }))
    .filter(({ stat }) => stat.wrongCount > 0)
    .sort((left, right) => right.stat.wrongCount - left.stat.wrongCount || left.index - right.index)
    .slice(0, 3)
    .map(({ stat, index }) => ({
      index,
      answer: questions[index].answer,
      ja: questions[index].ja,
      count: stat.wrongCount,
      reasonCounts: stat.reasonCounts,
    }));
}

// ホストの操作で結果発表を確定させる。参加者全員が提出済みであることを再確認してから発表する。
function quizRevealResults(roomCode) {
  const room = quizRooms[roomCode];
  if (!room || room.phase !== "playing") return false;
  const participants = quizParticipants(room);
  if (participants.length === 0 || !participants.every((p) => p.submittedAt !== null)) return false;
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
    .map((e) => ({ id: e.id, name: e.name }));
  const others = entries
    .filter((e) => e.score !== e.total)
    .map((e) => ({ id: e.id, name: e.name, score: e.score, total: e.total }));
  const questionStats = buildQuestionStats(room, participants);
  const mistakes = topThreeMistakes(questionStats, room.questions);
  const now = quizResultNow();
  const resultAt = now.toISOString();
  const date = tokyoDateKey(now);
  const saved = persistQuizMutation(roomCode, () => {
    room.phase = "finished";
    room.results = {
      resultAt,
      setLabel: room.setLabel,
      perfect,
      others,
      review: room.questions.map((q) => ({ sentence: q.sentence, answer: q.answer, altAnswers: q.altAnswers, ja: q.ja, sentenceJa: q.sentenceJa })),
      mistakes,
      isTrial: room.isTrial === true,
    };
    resultHistory[`${date}:${room.category}`] = {
      date,
      category: room.category,
      setLabel: room.setLabel,
      day: room.day,
      datasetRevision: room.datasetRevision,
      participantCount: participants.length,
      perfectNames: perfect.map((entry) => entry.name),
      questionStats,
      updatedAt: resultAt,
    };
  });
  if (!saved) return false;
  io.to(roomCode).emit("quiz:results", room.results);
  return true;
}

// 通信切断では呼ばず、画面の「退出」操作だけで参加者またはルームを削除する。
function quizFinalizePlayerLeave(roomCode, playerId) {
  const room = quizRooms[roomCode];
  if (!room) return { ok: true, wasHost: false };
  const player = room.players[playerId];
  if (room.host === playerId) {
    const timeoutHandle = room.timeoutHandle;
    if (!persistQuizMutation(roomCode, () => { delete quizRooms[roomCode]; })) {
      return { ok: false, error: QUIZ_PERSISTENCE_ERROR };
    }
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (player?.leaveTimer) clearTimeout(player.leaveTimer);
    return { ok: true, wasHost: true };
  }
  if (!player) return { ok: true, wasHost: false };
  const saved = persistQuizMutation(roomCode, () => { delete room.players[playerId]; });
  if (!saved) return { ok: false, error: QUIZ_PERSISTENCE_ERROR };
  if (player.leaveTimer) clearTimeout(player.leaveTimer);
  if (quizRooms[roomCode]) {
    quizPlayersUpdate(roomCode);
    if (room.phase === "playing") quizCheckAllSubmitted(roomCode);
  }
  return { ok: true, wasHost: false };
}

io.on("connection", (socket) => {
  socket.on("quiz:createRoom", ({ category, name } = {}, cb = () => {}) => {
    if (!QUIZ_CATEGORIES.includes(category)) return cb({ error: "カテゴリが不正です" });
    const roomCode = makeQuizRoomCode();
    const newRoom = {
      category,
      host: null,
      phase: "lobby",
      players: {},
      questions: [],
      startedAt: 0,
      day: null,
      datasetRevision: "",
      isReview: false,
      sourceDays: [],
      results: null,
    };
    quizJoin(socket, roomCode, name, cb, newRoom);
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
    const canJoinPlaying = room.phase === "playing" && Date.now() < room.endsAt;
    if (room.phase !== "lobby" && !canJoinPlaying) return cb({ error: "この回はすでに終了しています" });
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
      autoSubmitted: player.submissionKind === "timeout",
      seriesNames: WORDTESTS[room.category].series.map((s) => s.name),
      seriesMeta: quizSeriesMeta(room.category),
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

  socket.on("quiz:startGame", ({ seriesIndex } = {}, cb = () => {}) => {
    const roomCode = socket.data.quizRoomCode;
    const room = quizRooms[roomCode];
    if (!room || room.host !== socket.data.quizPlayerId || room.phase !== "lobby") return cb({ ok: false, error: "開始できませんでした" });
    const cat = WORDTESTS[room.category];
    const series = cat && cat.series[Number(seriesIndex)];
    if (!series) return cb({ ok: false, error: "問題セットが見つかりません" });
    let prepared;
    try {
      prepared = series.isReview
        ? selectReviewQuestions({
          category: room.category,
          reviewDay: series.day,
          datasetRevision: cat.datasetRevision,
          sourceDays: series.sourceDays,
          series: cat.series,
          resultHistory,
        })
        : {
          questions: shuffle(series.items).slice(0, QUIZ_QUESTION_COUNT),
          sourceDays: [],
          durationSec: QUIZ_TIME_LIMIT_SEC,
        };
    } catch (error) {
      if (error instanceof ReviewSelectionError) return cb({ ok: false, error: error.message });
      throw error;
    }
    const previousTimeout = room.timeoutHandle;
    const saved = persistQuizMutation(roomCode, () => {
      room.questions = prepared.questions;
      room.phase = "playing";
      room.startedAt = Date.now();
      room.endsAt = room.startedAt + prepared.durationSec * 1000;
      room.setLabel = `${cat.label} ${series.name}`;
      room.day = Number.isInteger(series.day) ? series.day : null;
      room.datasetRevision = String(cat.datasetRevision || "");
      room.isReview = series.isReview === true;
      room.sourceDays = prepared.sourceDays;
      room.isTrial = series.isTrial === true;
      room.results = null;
      room.timeoutHandle = null;
      for (const p of Object.values(room.players)) {
        p.submittedAt = null;
        p.submissionKind = null;
        p.score = 0;
        p.wrongQuestionIndexes = [];
        p.wrongAnswerReasons = {};
      }
    });
    if (!saved) {
      socket.emit("quiz:startError", { error: QUIZ_PERSISTENCE_ERROR });
      return cb({ ok: false, error: QUIZ_PERSISTENCE_ERROR });
    }
    if (previousTimeout) clearTimeout(previousTimeout);
    room.timeoutHandle = setTimeout(() => quizForceFinish(roomCode), prepared.durationSec * 1000);
    cb({ ok: true });
    io.to(roomCode).emit("quiz:started", {
      setLabel: room.setLabel,
      total: room.questions.length,
      endsAt: room.endsAt,
      questions: quizSanitizedQuestions(room),
    });
  });

  socket.on("quiz:submit", ({ answers, automatic = false } = {}, cb = () => {}) => {
    const roomCode = socket.data.quizRoomCode;
    const room = quizRooms[roomCode];
    if (!room || room.phase !== "playing") return cb({ ok: false, error: "提出できませんでした" });
    if (socket.data.quizPlayerId === room.host) return cb({ ok: false, error: "運営者は提出できません" }); // ホストは開催者であり回答しない
    const player = room.players[socket.data.quizPlayerId];
    if (!player) return cb({ ok: false, error: "参加者が見つかりません" });
    if (player.submittedAt !== null) {
      const participants = quizParticipants(room);
      const submittedCount = participants.filter((p) => p.submittedAt !== null).length;
      return cb({ ok: true, submittedCount, totalCount: participants.length });
    }
    const arr = Array.isArray(answers) ? answers : [];
    const saved = persistQuizMutation(roomCode, () => {
      player.wrongQuestionIndexes = room.questions
        .map((q, index) => (quizAnswerMatches(q, arr[index]) ? null : index))
        .filter((index) => index !== null);
      player.wrongAnswerReasons = Object.fromEntries(player.wrongQuestionIndexes.map((index) => [
        index,
        quizMistakeReason(room.questions[index], arr[index]),
      ]));
      player.score = room.questions.length - player.wrongQuestionIndexes.length;
      player.submittedAt = Date.now();
      player.submissionKind = automatic ? "timeout" : "manual";
    });
    if (!saved) return cb({ ok: false, error: QUIZ_PERSISTENCE_ERROR });
    const participants = quizParticipants(room);
    const submittedCount = participants.filter((p) => p.submittedAt !== null).length;
    cb({ ok: true });
    io.to(roomCode).emit("quiz:submitProgress", {
      submitted: submittedCount,
      total: participants.length,
    });
    quizCheckAllSubmitted(roomCode);
  });

  // ホストの操作で結果発表を確定させる。全員提出済みであることをここでも確認する
  // （制限時間が来ても自動では発表せず、必ずホストのこの操作を経由する）
  socket.on("quiz:revealResults", (cb = () => {}) => {
    const roomCode = socket.data.quizRoomCode;
    const room = quizRooms[roomCode];
    if (!room || room.host !== socket.data.quizPlayerId || room.phase !== "playing") return cb({ ok: false, error: "結果を発表できませんでした" });
    if (!quizRevealResults(roomCode)) {
      socket.emit("quiz:actionError", { error: QUIZ_PERSISTENCE_ERROR });
      return cb({ ok: false, error: QUIZ_PERSISTENCE_ERROR });
    }
    cb({ ok: true });
  });

  socket.on("quiz:playAgain", (cb = () => {}) => {
    const roomCode = socket.data.quizRoomCode;
    const room = quizRooms[roomCode];
    if (!room || room.host !== socket.data.quizPlayerId || room.phase !== "finished") return cb({ ok: false, error: "ロビーに戻れませんでした" });
    const saved = persistQuizMutation(roomCode, () => {
      room.phase = "lobby";
      room.questions = [];
      room.results = null;
      for (const p of Object.values(room.players)) {
        p.submittedAt = null;
        p.submissionKind = null;
        p.score = 0;
        p.wrongQuestionIndexes = [];
        p.wrongAnswerReasons = {};
      }
    });
    if (!saved) {
      socket.emit("quiz:actionError", { error: QUIZ_PERSISTENCE_ERROR });
      return cb({ ok: false, error: QUIZ_PERSISTENCE_ERROR });
    }
    cb({ ok: true });
    io.to(roomCode).emit("quiz:backToLobby");
    quizPlayersUpdate(roomCode);
  });

  socket.on("quiz:leave", (payload, acknowledgement) => {
    const cb = typeof payload === "function"
      ? payload
      : (typeof acknowledgement === "function" ? acknowledgement : () => {});
    const roomCode = socket.data.quizRoomCode;
    const playerId = socket.data.quizPlayerId;
    if (!roomCode || !playerId) return cb({ ok: true });
    const result = quizFinalizePlayerLeave(roomCode, playerId);
    if (!result.ok) return cb(result);
    socket.data.quizRoomCode = null;
    socket.data.quizPlayerId = null;
    cb({ ok: true });
    if (result.wasHost) socket.to(roomCode).emit("quiz:roomClosed");
    socket.leave(roomCode);
  });

  function quizJoin(sock, roomCode, name, cb, newRoom = null) {
    const room = newRoom || quizRooms[roomCode];
    const id = makeQuizPlayerId(room);
    const saved = persistQuizMutation(roomCode, () => {
      if (newRoom) quizRooms[roomCode] = room;
      room.players[id] = {
        name: String(name || "名無し").slice(0, 12),
        sessionToken: makeQuizSessionToken(),
        submittedAt: null,
        submissionKind: null,
        score: 0,
        wrongQuestionIndexes: [],
        wrongAnswerReasons: {},
        leaveTimer: null,
      };
      if (!room.host) room.host = id;
    });
    if (!saved) return cb({ error: QUIZ_PERSISTENCE_ERROR });
    sock.join(roomCode);
    sock.data.quizRoomCode = roomCode;
    sock.data.quizPlayerId = id;
    const seriesNames = WORDTESTS[room.category].series.map((s) => s.name);
    const response = {
      roomCode,
      isHost: room.host === id,
      category: room.category,
      playerId: id,
      sessionToken: room.players[id].sessionToken,
      seriesNames,
      seriesMeta: quizSeriesMeta(room.category),
    };
    if (room.phase === "playing") {
      response.phase = room.phase;
      response.setLabel = room.setLabel;
      response.total = room.questions.length;
      response.endsAt = room.endsAt;
      response.questions = quizSanitizedQuestions(room);
    }
    cb(response);
    quizPlayersUpdate(roomCode);
    if (room.phase === "playing") {
      const participants = quizParticipants(room);
      io.to(roomCode).emit("quiz:submitProgress", {
        submitted: participants.filter((p) => p.submittedAt !== null).length,
        total: participants.length,
      });
      const remainingMs = room.endsAt - Date.now();
      if (!room.timeoutHandle && remainingMs > 0) {
        room.timeoutHandle = setTimeout(() => quizForceFinish(roomCode), remainingMs);
      }
    }
  }
});

for (const [roomCode, room] of Object.entries(quizRooms)) {
  if (room.phase !== "playing") continue;
  const remainingMs = room.endsAt - Date.now();
  room.timeoutHandle = setTimeout(() => quizForceFinish(roomCode), Math.max(0, remainingMs));
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
