const test = require("node:test");
const assert = require("node:assert/strict");

const wordtests = require("../wordtests");
const { getStudyDateLabel } = require("../public/ui-logic");

const FORM_QUESTION_IDS = {
  clacel: `day24/q17 day26/q17 day22/q19 day23/q10 day24/q06 day27/q02 day22/q18 day24/q01 day24/q15 day26/q18 day26/q09 day22/q03 day25/q07 day23/q15 day27/q04 day25/q04 day22/q12 day26/q11 day26/q12 day23/q09 day24/q10 day22/q10 day22/q14 day25/q09 day27/q17 day24/q03 day26/q15 day23/q01 day27/q19 day26/q03 day22/q15 day22/q04 day26/q06 day23/q11 day24/q18 day25/q06 day25/q05 day26/q10 day23/q13 day25/q10 day23/q12 day27/q03 day27/q05 day27/q18 day23/q07 day24/q07 day23/q17 day27/q10 day25/q03 day25/q02`,
  toeic: `day23/q05 day22/q19 day24/q14 day22/q11 day27/q13 day25/q08 day22/q06 day23/q12 day27/q17 day25/q02 day26/q16 day26/q20 day27/q15 day27/q07 day22/q05 day27/q19 day23/q18 day23/q08 day27/q12 day23/q01 day26/q05 day22/q10 day26/q13 day27/q18 day23/q14 day24/q04 day24/q12 day23/q03 day26/q03 day25/q13 day24/q03 day26/q18 day25/q09 day23/q02 day27/q08 day22/q13 day22/q08 day26/q04 day26/q19 day24/q08 day26/q12 day25/q17 day22/q04 day25/q05 day25/q12 day24/q20 day24/q09 day27/q14 day25/q14 day24/q17`,
  ielts: `day26/q04 day23/q18 day24/q18 day23/q15 day26/q12 day22/q13 day27/q03 day22/q16 day24/q12 day22/q02 day24/q03 day22/q14 day22/q06 day25/q20 day27/q16 day25/q16 day25/q05 day22/q01 day23/q03 day23/q10 day27/q13 day23/q01 day26/q08 day26/q10 day27/q18 day24/q14 day27/q01 day23/q20 day27/q15 day24/q20 day24/q06 day22/q03 day26/q14 day25/q18 day26/q15 day24/q01 day24/q19 day26/q13 day25/q06 day24/q02 day25/q01 day23/q02 day27/q19 day27/q12 day26/q09 day25/q12 day22/q07 day23/q17 day25/q11 day27/q17`,
};

function expectedIds(course) {
  return FORM_QUESTION_IDS[course]
    .split(" ")
    .map((suffix) => `2026-${suffix.startsWith("day2") && Number(suffix.slice(3, 5)) >= 26 ? "10" : "09"}/${course}/${suffix}`);
}

test("Day 28はGoogleフォームと同じDay 22〜27の復習50問を同じ順番で配信する", () => {
  assert.equal(getStudyDateLabel(28), "10月3日");
  for (const course of Object.keys(FORM_QUESTION_IDS)) {
    const review = wordtests[course].series.find(({ day }) => day === 28);
    const expected = expectedIds(course);

    assert.ok(review, `${course}: Day 28がない`);
    assert.equal(review.name, "Day 28（復習50問）");
    assert.equal(review.isReview, true);
    assert.deepEqual(review.sourceDays, [22, 23, 24, 25, 26, 27]);
    assert.deepEqual(review.fixedQuestionIds, expected, `${course}: Googleフォームとの順番不一致`);
    assert.equal(review.fixedQuestionIds.length, 50);
    assert.equal(new Set(review.fixedQuestionIds).size, 50);

    const counts = [22, 23, 24, 25, 26, 27].map((day) =>
      review.fixedQuestionIds.filter((id) => id.includes(`/day${day}/`)).length
    );
    assert.deepEqual(counts, course === "clacel" ? [8, 9, 8, 8, 9, 8] : course === "toeic" ? [8, 8, 8, 8, 9, 9] : [8, 8, 9, 8, 8, 9]);
  }
});
