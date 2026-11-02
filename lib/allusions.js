/**
 * 典故出处与释义。数据在 data/allusions.json，第一次查询时读入。
 */

import { readFileSync } from "node:fs";
import { normKey } from "./text.js";
import { dataFile as resolveData } from "./paths.js";

const dataFile = resolveData("allusions.json");

/** 去掉数据集里的标注标签，只留可读正文。 */
function plain(text) {
  return String(text).replace(/<[^>]+>/g, "");
}

/** @type {{ entries: object[], exact: Map<string, number[]> } | null} */
let table = null;

function load() {
  if (table) return;
  const entries = JSON.parse(readFileSync(dataFile, "utf8"));
  const exact = new Map();
  entries.forEach((entry, id) => {
    for (const alias of entry.aliases) {
      const key = normKey(alias);
      if (key.length < 2) continue;
      const list = exact.get(key) || [];
      list.push(id);
      exact.set(key, list);
    }
  });
  table = { entries, exact };
}

/**
 * @param {string} keyword
 * @returns {{ keyword: string, found: boolean, items: object[], detail?: string }}
 */
export function findAllusions(keyword) {
  load();
  const key = normKey(keyword);
  if (key.length < 2) {
    return {
      keyword,
      found: false,
      items: [],
      detail: "典故检索至少需要两个字。不得编造出处。",
    };
  }

  const ids = new Set(table.exact.get(key) || []);

  if (!ids.size) {
    const contained = [];
    for (const [alias, aliasIds] of table.exact) {
      if (alias.length >= 2 && key.includes(alias)) {
        contained.push([alias.length, aliasIds]);
      }
    }
    contained.sort((a, b) => b[0] - a[0]);
    for (const [, aliasIds] of contained) {
      for (const id of aliasIds) ids.add(id);
      if (ids.size >= 8) break;
    }
  }

  if (!ids.size) {
    for (const [alias, aliasIds] of table.exact) {
      if (alias.includes(key)) {
        for (const id of aliasIds) ids.add(id);
        if (ids.size >= 8) break;
      }
    }
  }

  const items = [...ids].slice(0, 8).map((id) => {
    const entry = table.entries[id];
    return {
      name: plain(entry.name),
      source: plain(entry.source),
      meanings: entry.meanings.map(plain),
    };
  });

  if (!items.length) {
    return {
      keyword,
      found: false,
      items: [],
      detail: "典故库未收录此条。不得编造出处或释义。",
    };
  }
  return { keyword, found: true, items };
}
