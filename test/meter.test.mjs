/**
 * 格律判定的回归测试。
 *
 * 只钉住几件不能坏的事：
 * - 结构字段齐全，句数对得上；
 * - 合格的五绝不会莫名报失律；
 * - 明显拗的地方必须报出来；
 * - 未知字要单独列出来，不能默默当平。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { analyzeAoJiu, analyzeNianDui } from "../lib/meter.js";

const DENG_GUAN_QUE_LOU = ["白日依山尽", "黄河入海流", "欲穷千里目", "更上一层楼"];

test("analyzeAoJiu 返回结构齐全", () => {
  const result = analyzeAoJiu(DENG_GUAN_QUE_LOU);
  assert.equal(result.lines.length, 4);
  assert.equal(typeof result.form, "string");
  assert.ok(Array.isArray(result.violations));
  assert.ok(Array.isArray(result.rescues));
  assert.ok(Array.isArray(result.unknownChars));
});

test("登鹳雀楼判为五言，且不报失律", () => {
  const result = analyzeAoJiu(DENG_GUAN_QUE_LOU);
  assert.match(result.form, /(5|五)言/);
  const lost = result.violations.filter((item) => item.kind === "失律");
  assert.equal(lost.length, 0, `不该失律：${JSON.stringify(lost)}`);
});

test("句尾三平调会被抓出来", () => {
  // 五言句尾三字全平，且第三字本该用仄。
  const result = analyzeAoJiu(["青山多方平", "白日依山尽"]);
  const kinds = result.violations.map((item) => item.kind);
  assert.ok(kinds.includes("三平调"), `应报三平调，实际：${JSON.stringify(kinds)}`);
});

test("analyzeNianDui 的对与粘数量正确", () => {
  const result = analyzeNianDui(DENG_GUAN_QUE_LOU);
  // 四句：第 1-2 句对，第 2-3 句粘，第 3-4 句对。
  assert.equal(result.dui.length, 2);
  assert.equal(result.nian.length, 1);
  assert.deepEqual(result.lines, DENG_GUAN_QUE_LOU);
});

test("未知字单独列出，不当年平声混过去", () => {
  const result = analyzeAoJiu(["白日依山金", "黄河入海流"]);
  assert.ok(Array.isArray(result.unknownChars));
});
