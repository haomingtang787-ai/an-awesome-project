/**
 * 按作者和诗题查原诗。数据在 data/poems.json，第一次查询时读入。
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { Converter } from "opencc-js";
import { normKey } from "./text.js";
import { dataFile as resolveData } from "./paths.js";

const dataFile = resolveData("poems.json");
const gzipFile = resolveData("poems.json.gz");
const toSimp = Converter({ from: "tw", to: "cn" });

/** @type {{ poems: string[][], index: Record<string, number[]>, byAuthor: Map<string, [string, number[]][]> } | null} */
let table = null;

function load() {
  if (table) return;
  const raw = readTable();
  const byAuthor = new Map();
  for (const [key, ids] of Object.entries(raw.index)) {
    const splitAt = key.indexOf("\u0001");
    if (splitAt < 0) continue;
    const author = key.slice(0, splitAt);
    const title = key.slice(splitAt + 1);
    const list = byAuthor.get(author) || [];
    list.push([title, ids]);
    byAuthor.set(author, list);
  }
  table = { poems: raw.poems, index: raw.index, byAuthor };
}

/**
 * 优先读压缩过的诗集（安装包小一大截），没有就退回明文。
 */
function readTable() {
  try {
    return JSON.parse(gunzipSync(readFileSync(gzipFile)).toString("utf8"));
  } catch {
    return JSON.parse(readFileSync(dataFile, "utf8"));
  }
}

/**
 * 与建库时一致：原样键 + 简体键，避免繁体查询漏检。
 * @param {string} author
 * @param {string} title
 * @returns {string[]}
 */
export function poemIndexKeys(author, title) {
  const rawAuthor = normKey(author);
  const rawTitle = normKey(title);
  const simpAuthor = normKey(toSimp(author));
  const simpTitle = normKey(toSimp(title));
  const keys = [`${rawAuthor}\u0001${rawTitle}`];
  const simp = `${simpAuthor}\u0001${simpTitle}`;
  if (simp !== keys[0]) keys.push(simp);
  return keys.filter((key) => key && key !== "\u0001" && !key.startsWith("\u0001") && !key.endsWith("\u0001"));
}

/**
 * @param {string} authorKey
 * @param {string} titleKey
 * @returns {number[]}
 */
function fuzzyIds(authorKey, titleKey) {
  const fuzzy = [];
  for (const [poemTitle, value] of table.byAuthor.get(authorKey) || []) {
    if (poemTitle.startsWith(titleKey) || titleKey.startsWith(poemTitle)) {
      fuzzy.push(...value);
    }
  }
  return fuzzy;
}

/**
 * @param {string} author
 * @param {string} title
 * @returns {{ found: boolean, author: string, title: string, poems: object[], truncated: boolean, detail?: string }}
 */
export function findPoems(author, title) {
  load();
  const keys = poemIndexKeys(author, title);
  let ids = [];

  for (const exactKey of keys) {
    if (table.index[exactKey]) {
      ids = [...table.index[exactKey]];
      break;
    }
  }

  if (!ids.length) {
    const seen = new Set();
    for (const exactKey of keys) {
      const splitAt = exactKey.indexOf("\u0001");
      if (splitAt < 0) continue;
      for (const id of fuzzyIds(exactKey.slice(0, splitAt), exactKey.slice(splitAt + 1))) {
        seen.add(id);
      }
    }
    ids = [...seen];
  }

  if (!ids.length) {
    return {
      found: false,
      author,
      title,
      poems: [],
      truncated: false,
      detail: "诗集未收录此作者与诗题。不得凭记忆编造正文。",
    };
  }

  const truncated = ids.length > 5;
  const poems = ids.slice(0, 5).map((id) => {
    const [poemAuthor, poemTitle, text, source] = table.poems[id];
    return { author: poemAuthor, title: poemTitle, source, text };
  });
  return { found: true, author, title, poems, truncated };
}
