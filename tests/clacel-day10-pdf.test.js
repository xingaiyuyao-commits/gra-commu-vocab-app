const test = require("node:test");
const assert = require("node:assert/strict");

const clacel = require("../wordtests-clacel");

const PDF_DAY10 = [
  ["travel", "I'm just gonna ___ around.", "travel", "ちょっと離れた場所に移動する", "ちょっとあちこち旅行するつもりです。"],
  ["lock", "Always ___ your car doors so people won't steal your things.", "lock", "に鍵をかける", "他人に物を盗まれないように、車のドアは常にロックしてください。"],
  ["confuse", "His riddle really ___ me.", "confused", "を混同する", "彼のなぞなぞには本当に困惑しました。"],
  ["contain", "This box ___ everything I won at the fair.", "contains", "を含む、を収容できる", "この箱には私がフェアで勝ち取ったすべてが入っています。"],
  ["stretch", "It is good to ___ your legs after sitting for a long time.", "stretch", "ストレッチをする、伸びる、を伸ばす", "長時間座った後は足を伸ばすのも良いですね。"],
  ["award", "Every year my company ___ one person Employee of the Year.", "awards", "（賞など）を与える", "私の会社では毎年、年間最優秀従業員 1 名を表彰しています。"],
  ["guard", "There are two large men ___ the doors.", "guarding", "を守る、を監視する", "大柄な男性2人がドアを見張っています。"],
  ["trap", "___ pest animals and releasing them somewhere else is more humane than killing them.", "trapping", "を閉じ込める、（動物）を罠で捕らえる", "害獣を捕まえて別の場所に放すことは、殺すより人道的です。"],
  ["plant", "I want to ___ flowers in my garden this year.", "plant", "を植える、（種）をまく", "今年は庭に花を植えたいと思っています。"],
  ["organize", "I need to ___ my room to make it easier to find things.", "organize", "を主催する、を組織する", "物を探しやすいように部屋を整理する必要があります。"],
  ["invent", "Scientists are trying to ___ a better kind of battery.", "invent", "を発明する", "科学者たちは、より優れた種類のバッテリーを発明しようとしています。"],
  ["wonder", "I ___ what I should have for breakfast tomorrow.", "wonder", "～かなと思う", "明日の朝食は何にしようかな。"],
  ["trade", "Games where you collect and ___ cards are very popular.", "trade", "を交換する、貿易する", "カードを集めて交換するゲームは非常に人気があります。"],
  ["grow", "He will probably ___ another 6 inches.", "grow", "成長する、増大する、を栽培する", "おそらくあと6インチは伸びるだろう。"],
  ["bite", "I ___ my fingernails too much.", "bite", "を噛む", "爪を噛みすぎてしまいます。"],
  ["mind", "I don’t ___ that my neighbors are a bit loud sometimes, they’re nice people.", "mind", "を気にする（嫌がる）、に気を付ける", "隣人は時々少しうるさいですが、彼らは良い人たちなので気にしません。"],
  ["promise", "I ___ that I will not tell a lie.", "promise", "を約束する", "嘘はつかないと約束します。"],
  ["fix", "That chair’s leg is broken, will you ___ it please?", "fix", "を修理する、を固定する", "その椅子の脚が壊れているので、直してくれませんか？"],
  ["happen", "Bad things ___ sometimes.", "happen", "起こる、偶然～する", "悪いことも時々起こります。"],
  ["feed", "One of my chores is to ___ the dog.", "feed", "に食べ物を与える", "私の家事の一つは犬に餌をあげることです。"],
];

test("Clacel Day 10の全20問が9月PDFの問題文・正解・日本語訳と一致する", () => {
  const day10 = clacel.series.find((series) => series.name === "Day 10");

  assert.ok(day10, "Clacel Day 10がありません");
  assert.equal(day10.items.length, 20);
  assert.deepEqual(
    day10.items.map(({ base, sentence, answer, ja, sentenceJa }) => [base, sentence, answer, ja, sentenceJa]),
    PDF_DAY10,
  );
});
