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

test("检索结果收成 search 卡片，建议排在卡片后", () => {
  const card = presentTurn([
    {
      name: "searchPoemLines",
      ok: true,
      result: {
        query: "明月几时有",
        mode: "exact",
        found: true,
        count: 1,
        items: [{
          author: "苏轼",
          title: "水调歌头",
          source: "宋词",
          line: "明月几时有，把酒问青天。",
          before: "",
          after: "",
          match: "line",
        }],
      },
    },
  ]);
  assert.equal(card.type, "search");
  assert.equal(card.variant, "exact");
  assert.equal(card.items[0].line, "明月几时有，把酒问青天。");
  assert.equal(card.answerAfterCard, true);
});

test("词韵校验单独调用也能成韵部卡", () => {
  const card = presentTurn([
    {
      name: "checkCiYun",
      ok: true,
      result: {
        book: "词林正韵",
        rhymeChars: ["东", "同"],
        sameRhyme: true,
        uniformTone: "平",
        rhyme: ["第一部"],
        options: [
          { char: "东", rhymes: ["第一部"], tones: ["平"] },
          { char: "同", rhymes: ["第一部"], tones: ["平"] },
        ],
        detail: "可以同入：第一部（平声）。",
      },
    },
  ]);
  assert.equal(card.type, "meter");
  assert.equal(card.variant, "rhyme");
  assert.equal(card.yun.book, "词林正韵");
  assert.equal(card.yun.sameRhyme, true);
});
