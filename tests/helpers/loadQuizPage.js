const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

// quiz.html を jsdom 上で実際に実行し、socket.io をスタブに差し替えてテストできるようにするヘルパー。
// 本番の <script src="..."> はネットワーク越しに取得できないため、内容をインライン展開してから読み込む。
//
// quiz.html は「参加/回答」用の最初のio()呼び出しに加え、ホスト用の複数コース同時作成画面で
// コースごとに新しいio()接続を作る（本番ではforceNew:trueで独立接続）。テストでもio()の呼び出し
// ごとに独立したフェイクソケットを返し、fakeSockets配列で順番にアクセスできるようにしている。
// 既存のテスト（fakeSocket/emitted/socketHandlers/fireSocketEventを直接参照するもの）は
// 最初のio()呼び出し（fakeSockets[0]）を指すため、そのまま動作する。
function loadQuizPage({
  url = "http://localhost/quiz.html",
  nowIso = null,
  storedValues = {},
  operatorSessionStatus = 200,
} = {}) {
  const publicDir = path.join(__dirname, "..", "..", "public");
  let html = fs.readFileSync(path.join(publicDir, "quiz.html"), "utf8");

  // socket.io クライアントはテストでは不要（window.io をスタブで差し替えるため）なので取り除く
  html = html.replace(/<script src="\/socket\.io\/socket\.io\.js"><\/script>\s*/, "");

  // /ui-logic.js への外部参照は実ファイルの内容をインラインにして読み込む
  const uiLogicSrc = fs.readFileSync(path.join(publicDir, "ui-logic.js"), "utf8");
  html = html.replace(
    '<script src="/ui-logic.js"></script>',
    `<script>${uiLogicSrc}</script>`
  );
  const savedResultsSrc = fs.readFileSync(path.join(publicDir, "saved-results.js"), "utf8");
  html = html.replace(
    '<script src="/saved-results.js"></script>',
    `<script>${savedResultsSrc}</script>`
  );

  const fakeSockets = [];
  function createFakeSocket() {
    const socketHandlers = {};
    const emitted = [];
    const fakeSocket = {
      handlers: socketHandlers,
      emitted,
      on(event, handler) {
        (socketHandlers[event] ||= []).push(handler);
        return fakeSocket;
      },
      off(event, handler) {
        if (socketHandlers[event]) {
          socketHandlers[event] = socketHandlers[event].filter((h) => h !== handler);
        }
        return fakeSocket;
      },
      emit(event, payload, cb) {
        emitted.push({ event, payload, cb });
        return fakeSocket;
      },
      disconnect() {},
      fire(event, payload) {
        (socketHandlers[event] || []).forEach((handler) => handler(payload));
      },
    };
    fakeSockets.push(fakeSocket);
    return fakeSocket;
  }

  const virtualConsole = new VirtualConsole().forwardTo(console, { jsdomErrors: ["unhandled-exception"] });
  const dom = new JSDOM(html, {
    url,
    runScripts: "dangerously",
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      if (nowIso) {
        const RealDate = window.Date;
        const fixedNow = RealDate.parse(nowIso);
        window.Date = class extends RealDate {
          constructor(...args) {
            super(...(args.length ? args : [fixedNow]));
          }
          static now() { return fixedNow; }
        };
      }
      for (const [key, value] of Object.entries(storedValues)) {
        window.localStorage.setItem(key, String(value));
      }
      window.io = () => createFakeSocket();
      window.fetch = async (requestUrl) => ({
        status: operatorSessionStatus,
        ok: operatorSessionStatus === 200,
        json: async () => ({ authenticated: operatorSessionStatus === 200, requestUrl }),
      });
      // quiz.htmlはタイマー表示のため実際のsetIntervalを使うが、
      // テストではプロセスが終了しなくなるため無効化する（タイマー発火自体はテスト対象外）
      window.setInterval = () => 0;
      window.clearInterval = () => {};
    },
  });

  function fireSocketEvent(event, payload) {
    fakeSockets[0].fire(event, payload);
  }

  return {
    dom,
    window: dom.window,
    document: dom.window.document,
    emitted: fakeSockets[0].emitted,
    socketHandlers: fakeSockets[0].handlers,
    fakeSocket: fakeSockets[0],
    fakeSockets,
    fireSocketEvent,
    close() {
      for (const socket of fakeSockets) socket.disconnect();
      dom.window.close();
    },
  };
}

module.exports = { loadQuizPage };
