/**
 * 诗句检索：字面精确检索，以及按主题意象的近似检索。
 * 本地没有诗集数据时整组跳过。
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { dataFile } from "../lib/paths.js";
import { searchPoemLines, searchPoemMeaning } from "../lib/poem-search.js";

const hasPoems = () => existsSync(dataFile("poems.json")) || existsSync(dataFile("poems.json.gz"));

test("按字面查原句，能认出作者与出处", () => {
  if (!hasPoems()) return;
  const result = searchPoemLines({ query: "山重水复疑无路", limit: 5 });
  assert.equal(result.found, true, result.detail);
  assert.ok(result.items.length >= 1);
  assert.ok(result.items.some((item) => /陸游|陆游/.test(item.author)));
  assert.ok(result.items.some((item) => item.line.includes("山重水複疑無路")));
});

test("多段查询要求同诗命中，同一句不重复", () => {
  if (!hasPoems()) return;
  const result = searchPoemLines({ query: "白日依山尽，黄河入海流。", limit: 4 });
  assert.equal(result.found, true, result.detail);
  assert.ok(result.items.some((item) => item.title.includes("登鸛雀樓")));
  const counts = new Map();
  for (const item of result.items) {
    const key = `${item.author}\u0001${item.title}\u0001${item.line}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  assert.ok([...counts.values()].every((count) => count === 1), "同一首诗同一句不应出现两次");
});

test("作者、出处、诗题筛选可用", () => {
  if (!hasPoems()) return;
  const byAuthor = searchPoemLines({ query: "明月几时有", author: "苏轼", limit: 3 });
  assert.equal(byAuthor.found, true);
  assert.ok(byAuthor.items.every((item) => /蘇軾|苏轼/.test(item.author)));

  const bySource = searchPoemLines({ query: "明月", source: "宋词", limit: 2 });
  assert.equal(bySource.found, true);
  assert.ok(bySource.items.every((item) => item.source === "宋词"));

  const byTitle = searchPoemLines({ query: "春望", field: "title", author: "杜甫", limit: 2 });
  assert.equal(byTitle.found, true);
  assert.ok(byTitle.items.some((item) => item.title === "春望"));
});

test("查不到就报未命中，不编造", () => {
  if (!hasPoems()) return;
  const result = searchPoemLines({ query: "这句肯定不在诗集里啊", limit: 2 });
  assert.equal(result.found, false);
  assert.equal(result.items.length, 0);
  assert.match(result.detail, /没有|可换|searchPoemMeaning/);
});

test("语义近似检索能识别主题并按分数排序", () => {
  if (!hasPoems()) return;
  const result = searchPoemMeaning({ query: "送别时的不舍", limit: 6 });
  assert.equal(result.found, true, result.detail);
  assert.ok(result.themes.includes("送别"));
  assert.ok(result.items.length >= 3);
  for (let index = 1; index < result.items.length; index += 1) {
    assert.ok(result.items[index - 1].score >= result.items[index].score, "结果应按相近度降序");
  }
  assert.ok(result.items.every((item) => item.line && item.author && item.title));
  assert.match(result.detail, /近似|不是严格/);
});

test("语义检索支持多个意象，如月与酒", () => {
  if (!hasPoems()) return;
  const result = searchPoemMeaning({ query: "月亮和酒", limit: 5 });
  assert.equal(result.found, true);
  assert.ok(result.themes.includes("月夜"));
  assert.ok(result.themes.includes("酒"));
  assert.ok(result.items.some((item) => item.line.includes("月") && item.line.includes("酒")));
});

test("语义检索可限作者与条数", () => {
  if (!hasPoems()) return;
  const result = searchPoemMeaning({ query: "秋天思乡", author: "杜甫", limit: 2 });
  assert.ok(result.items.length <= 2);
  assert.ok(result.items.every((item) => /杜甫/.test(item.author)));
});
