import test from "node:test";
import assert from "node:assert/strict";
import { analyzeAoJiu, analyzeNianDui } from "../lib/meter.js";
import { presentTurn } from "../lib/present.js";

const ORIGINAL = ["夜雨打窗急", "孤灯照客愁", "家书久未至", "梦里到江楼"];
const CANDIDATE = ["夜雨打窗急", "孤灯照客愁", "家书久难至", "梦里到江楼"];

const YUN = {
  rhymeChars: ["愁", "楼"],
  sameRhyme: true,
  rhyme: ["下平十一尤"],
  options: [
    { char: "愁", rhymes: ["下平十一尤"] },
    { char: "楼", rhymes: ["下平十一尤"] },
  ],
  detail: "可以同入：下平十一尤。",
};

/**
 * 模拟陪改回合：先查原稿，再验证一个候选改法。
 */
function polishTrace() {
  return [
    { name: "checkNianDui", ok: true, result: analyzeNianDui(ORIGINAL) },
    { name: "findAoJiu", ok: true, result: analyzeAoJiu(ORIGINAL) },
    { name: "checkYun", ok: true, result: YUN },
    { name: "findAoJiu", ok: true, result: analyzeAoJiu(CANDIDATE) },
  ];
}

test("陪改时卡片停在最先检查的原稿，不跟到最后验证的候选", () => {
  const card = presentTurn(polishTrace(), { task: "polish" });
  assert.equal(card.type, "meter");
  const text = card.lines.map((line) => line.map((item) => item.ch).join("")).join("/");
  assert.equal(text, ORIGINAL.join("/"));
  assert.equal(card.issues.length, 1);
  assert.equal(card.issues[0].line, 3);
  assert.equal(card.issues[0].position, 3);
});

test("润色的建议排在卡片之后，创作的诗作排在卡片之前", () => {
  assert.equal(presentTurn(polishTrace(), { task: "polish" }).answerAfterCard, true);
  assert.equal(presentTurn(polishTrace(), { task: "polish" }).answerBeforeCard, undefined);
  assert.equal(presentTurn(polishTrace(), { task: "create" }).answerBeforeCard, true);
  assert.equal(presentTurn(polishTrace(), { task: "create" }).answerAfterCard, undefined);
});

test("纯格律核查既不前置也不后置建议，报告留在卡片内", () => {
  const card = presentTurn(polishTrace(), { task: "check" });
  assert.equal(card.answerBeforeCard, undefined);
  assert.equal(card.answerAfterCard, undefined);
});
