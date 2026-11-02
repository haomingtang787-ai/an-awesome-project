/**
 * 原诗检索：建库用简体键，查询须兼容繁体。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";

import { poemIndexKeys, findPoems } from "../lib/poems.js";
import { dataFile } from "../lib/paths.js";

test("poemIndexKeys 繁体会多出简体键", () => {
  const keys = poemIndexKeys("蘇軾", "題西林壁");
  assert.ok(keys.length >= 2, `应同时含原样与简体：${JSON.stringify(keys)}`);
  assert.ok(keys.some((key) => key.includes("苏轼")), `应含简体作者：${JSON.stringify(keys)}`);
  assert.ok(keys.some((key) => key.includes("题西林壁")), `应含简体诗题：${JSON.stringify(keys)}`);
});

test("poemIndexKeys 简体不重复", () => {
  const keys = poemIndexKeys("苏轼", "题西林壁");
  assert.equal(keys.length, 1);
  assert.equal(keys[0], "苏轼\u0001题西林壁");
});

test("繁体作者可命中诗集（若本地有数据）", () => {
  if (!existsSync(dataFile("poems.json")) && !existsSync(dataFile("poems.json.gz"))) {
    return;
  }
  const result = findPoems("蘇軾", "題西林壁");
  assert.equal(result.found, true, result.detail || "应能查到苏轼《题西林壁》");
  assert.ok(result.poems.length > 0);
});
