/**
 * 韵书：平水韵补全到 106 部，词林正韵 19 部，仄声韵可查可校。
 */

import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";

import { dataFile } from "../lib/paths.js";
import { findGroups, groupsOfTone, lookupChar } from "../lib/pingshui.js";
import { checkCiYun, ciGroupsOfTone, findCiGroups, lookupCiChar } from "../lib/cilin.js";
import { executeTool } from "../tools.js";

test("平水韵回到 106 部，上声三讲已补", () => {
  const path = dataFile("pingshui.json");
  if (!existsSync(path)) return;
  const data = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(data.groups.length, 106);
  const sections = data.groups.reduce((map, group) => {
    map[group.section] = (map[group.section] || 0) + 1;
    return map;
  }, {});
  assert.deepEqual(sections, { 上平: 15, 下平: 15, 上声: 29, 去声: 30, 入声: 17 });
  const sanjiang = findGroups("上声三讲");
  assert.equal(sanjiang.length, 1);
  assert.equal(sanjiang[0].chars, "讲港棒蚌项耩");
});

test("仄声按声调列出韵部", () => {
  assert.equal(groupsOfTone("上声").length, 29);
  assert.equal(groupsOfTone("去声").length, 30);
  assert.equal(groupsOfTone("入声").length, 17);
  assert.equal(groupsOfTone("仄声").length, 76);
  assert.equal(groupsOfTone("平声").length, 30);
});

test("词林正韵十九部，平仄入各归其部", () => {
  const path = dataFile("cilin.json");
  if (!existsSync(path)) return;
  const data = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(new Set(data.groups.map((group) => group.id)).size, 19);
  assert.equal(data.groups.filter((group) => group.tone === "平").length, 14);
  assert.equal(data.groups.filter((group) => group.tone === "仄").length, 14);
  assert.equal(data.groups.filter((group) => group.tone === "入").length, 5);

  assert.deepEqual(lookupCiChar("东"), [{ tone: "平", rhyme: "第一部", section: "平声" }]);
  assert.ok(lookupCiChar("董").some((item) => item.rhyme === "第一部" && item.tone === "仄"));
  assert.ok(lookupCiChar("屋").some((item) => item.rhyme === "第十五部" && item.tone === "入"));
});

test("checkCiYun 分平仄，上声与去声同为仄声", () => {
  const flat = checkCiYun(["东", "同"]);
  assert.equal(flat.sameRhyme, true);
  assert.equal(flat.uniformTone, "平");
  assert.equal(flat.compatible, true);

  const mixed = checkCiYun(["东", "董"]);
  assert.equal(mixed.sameRhyme, true);
  assert.equal(mixed.uniformTone, null);
  assert.equal(mixed.compatible, false);
  assert.match(mixed.detail, /平仄相杂|转韵/);

  const different = checkCiYun(["东", "屋"]);
  assert.equal(different.sameRhyme, false);
  assert.equal(different.compatible, false);
});

test("词林正韵按声调列部，单部可取收字", () => {
  assert.equal(ciGroupsOfTone("平声").length, 14);
  assert.equal(ciGroupsOfTone("仄声").length, 14);
  assert.equal(ciGroupsOfTone("上声").length, 14);
  assert.equal(ciGroupsOfTone("去声").length, 14);
  assert.equal(ciGroupsOfTone("入声").length, 5);

  const first = findCiGroups("第一部");
  assert.equal(first.length, 2);
  assert.ok(first.some((group) => group.section === "平声"));
  assert.ok(first.some((group) => group.section === "仄声"));
});

test("getRhythmBook 可按声调列目，也可切词林正韵", async () => {
  const oblique = JSON.parse(await executeTool("getRhythmBook", { rhymeName: "仄声" }));
  assert.equal(oblique.found, true);
  assert.equal(oblique.summary, true);
  assert.equal(oblique.groups.length, 76);
  assert.equal(oblique.groups[0].id, "上声一董");
  assert.equal(oblique.groups.at(-1).id, "入声十七洽");

  const sanjiang = JSON.parse(await executeTool("getRhythmBook", { rhymeName: "上声三讲" }));
  assert.equal(sanjiang.groups[0].characters, "讲港棒蚌项耩");

  const ci = JSON.parse(await executeTool("getRhythmBook", { rhymeName: "第一部", book: "词林正韵" }));
  assert.equal(ci.book, "词林正韵");
  assert.equal(ci.groups.length, 2);

  const allCi = JSON.parse(await executeTool("getRhythmBook", { rhymeName: "词林正韵" }));
  assert.equal(allCi.book, "词林正韵");
  assert.equal(allCi.summary, true);
  assert.equal(allCi.groups.length, 33);
});

test("getPingZe 同时给平水韵与词林正韵", async () => {
  const result = JSON.parse(await executeTool("getPingZe", { character: "讲" }));
  assert.equal(result.found, true);
  assert.equal(result.tone, "仄");
  assert.equal(result.readings[0].rhyme, "上声三讲");
  assert.ok(result.ciYun.some((item) => item.rhyme === "第二部" && item.tone === "仄"));
});

test("lookupChar 仍按平水韵分四声", () => {
  assert.equal(lookupChar("东")[0].tone, "平");
  assert.equal(lookupChar("董")[0].tone, "仄");
  assert.equal(lookupChar("屋")[0].tone, "入");
});
