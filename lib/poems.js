/**
 * 按作者和诗题查原诗。数据在 data/poems.json，第一次查询时读入。
 */

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { normKey } from "./text.js";
import { dataFile as resolveData } from "./paths.js";

const dataFile = resolveData("poems.json");
const gzipFile = resolveData("poems.json.gz");

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
 * @param {string} author
 * @param {string} title
 * @returns {{ found: boolean, author: string, title: string, poems: object[], truncated: boolean, detail?: string }}
 */
export function findPoems(author, title) {
  load();
  const authorKey = normKey(author);
  const titleKey = normKey(title);
  const exactKey = `${authorKey}\u0001${titleKey}`;
  let ids = table.index[exactKey] ? [...table.index[exactKey]] : [];

  if (!ids.length) {
    const fuzzy = [];
    for (const [poemTitle, value] of table.byAuthor.get(authorKey) || []) {
      if (poemTitle.startsWith(titleKey) || titleKey.startsWith(poemTitle)) {
        fuzzy.push(...value);
      }
    }
    ids = [...new Set(fuzzy)];
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
