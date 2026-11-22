/**
 * 诗句检索。
 *
 * 两种：
 * 1. 语句检索：按字面找原句，支持繁简、作者、出处，多段词要求同诗命中。
 * 2. 语义近似检索：没有词向量，靠一份人工主题意象表扩展查询，
 *    再按字、双字的重合度打分排序。它只给“大概像”的候选，不作严格语义判断。
 *
 * 诗集在 data/poems.json，就地扫描，不另建索引；单次查询通常一两秒内。
 */

import { Converter } from "opencc-js";
import { poemRows } from "./poems.js";
import { THEMES } from "./poem-themes.js";

const toSimp = Converter({ from: "tw", to: "cn" });
const toTrad = Converter({ from: "cn", to: "tw" });

const PUNCT = /[\s\u3000，。！？、；：,.!?;:"'“”‘’「」『』（）()《》〈〉【】\[\]{}·—…～~]/g;

/**
 * 去标点空白，保留原字。
 * @param {unknown} text
 * @returns {string}
 */
function plain(text) {
  return String(text ?? "").replace(PUNCT, "");
}

/**
 * 一个字串的繁简写法。诗集多为繁体，查询多为简体，两边都要试。
 * @param {string} text
 * @returns {string[]}
 */
function forms(text) {
  const base = plain(text);
  const values = new Set([base]);
  try {
    values.add(plain(toSimp(base)));
    values.add(plain(toTrad(base)));
    values.add(plain(toTrad(toSimp(base))));
  } catch {
    /* 生僻字转不了就只用原样。 */
  }
  return [...values].filter(Boolean);
}

/**
 * 把查询切成几段。空格和句读都算分隔；整句仍按原样作为一段。
 * @param {string} query
 * @returns {string[]}
 */
function queryParts(query) {
  return plain(query)
    .split(/[，。！？；、,.;!?]+|\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * 参数收成整数。
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 */
function intArg(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sourceKey(value) {
  const text = plain(value);
  if (!text) return "";
  if (/唐诗|全唐/.test(text)) return "全唐诗";
  if (/宋诗|全宋/.test(text)) return "全宋诗";
  if (/宋词/.test(text)) return "宋词";
  if (/诗经/.test(text)) return "诗经";
  if (/楚辞/.test(text)) return "楚辞";
  return text;
}

/**
 * @param {unknown} value
 */
function authorFilter(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const keys = new Set(forms(text));
  return (author) => {
    const name = plain(author);
    for (const key of keys) {
      if (name === key || name.includes(key)) return true;
    }
    return false;
  };
}

/**
 * @param {string[]} lines
 * @param {number} index
 */
function contextOf(lines, index) {
  return {
    before: index > 0 ? lines[index - 1] : "",
    after: index + 1 < lines.length ? lines[index + 1] : "",
  };
}

/**
 * 语句检索。按字面找，不做同义扩展。
 * @param {object} args
 * @param {string} args.query 要查的诗句、诗题或关键词
 * @param {string} [args.author] 限定作者
 * @param {string} [args.source] 限定出处：全唐诗 / 全宋诗 / 宋词 / 诗经 / 楚辞
 * @param {"line"|"title"|"any"} [args.field] 查诗句、诗题，或两者都查
 * @param {number} [args.limit] 最多几条，默认 12
 * @returns {object}
 */
export function searchPoemLines(args = {}) {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("searchPoemLines 需要要查的语句。");

  const parts = queryParts(query);
  if (!parts.length) throw new Error("searchPoemLines 的查询里没有可检索的字。");
  const partForms = parts.map((part) => ({ text: part, variants: forms(part) }));
  const limit = intArg(args.limit, 12, 1, 40);
  const field = String(args.field ?? "line").toLowerCase();
  const searchLine = field !== "title";
  const searchTitle = field !== "line";
  const authorOk = authorFilter(args.author);
  const sourceWanted = sourceKey(args.source);

  const rows = poemRows();
  const items = [];
  let count = 0;

  /**
   * @param {string} line
   * @param {string[]} variants
   */
  const match = (line, variants) => variants.some((variant) => line.includes(variant));

  /**
   * 正常按标点原样比对；整轮无果时，再拿去掉标点的行文比一次。
   * @param {boolean} normalize
   */
  function scan(normalize) {
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const [author, title, text, source] = rows[rowIndex];
      if (sourceWanted && source !== sourceWanted) continue;
      if (authorOk && !authorOk(author)) continue;

      const lines = String(text).split(/\r?\n/);
      const lineKeys = normalize ? lines.map(plain) : lines;
      const hits = new Map();

      if (searchLine) {
        for (let lineIndex = 0; lineIndex < lineKeys.length; lineIndex += 1) {
          for (let partIndex = 0; partIndex < partForms.length; partIndex += 1) {
            if (hits.has(partIndex)) continue;
            if (match(lineKeys[lineIndex], partForms[partIndex].variants)) {
              hits.set(partIndex, lineIndex);
            }
          }
        }
      }

      const titleHit = searchTitle && partForms.every((part) => (
        match(normalize ? plain(title) : title, part.variants)
      ));

      if (parts.length > 1 && hits.size !== parts.length && !titleHit) continue;
      if (!hits.size && !titleHit) continue;

      if (titleHit && !hits.size) {
        count += 1;
        if (items.length < limit) {
          items.push({
            author,
            title,
            source,
            line: "",
            lineIndex: -1,
            before: "",
            after: "",
            match: "title",
          });
        }
        continue;
      }

      const wanted = hits.size ? [...hits.entries()] : [];
      const seenLines = new Set();
      for (const [partIndex, lineIndex] of wanted) {
        if (seenLines.has(lineIndex)) continue;
        seenLines.add(lineIndex);
        count += 1;
        if (items.length >= limit) continue;
        const line = lines[lineIndex] || "";
        const { before, after } = contextOf(lines, lineIndex);
        items.push({
          author,
          title,
          source,
          line,
          lineIndex,
          before,
          after,
          match: "line",
          term: partForms[partIndex].text,
        });
      }
    }
  }

  scan(false);
  if (!count && searchLine) scan(true);

  return {
    query,
    mode: "exact",
    field: field === "title" ? "title" : field === "any" ? "any" : "line",
    found: count > 0,
    count,
    truncated: count > items.length,
    items,
    detail: count
      ? `字面命中 ${count} 处${count > items.length ? `，只列前 ${items.length} 处` : ""}。`
      : "诗集里没有这个字面。可换更短的关键词，或改用 searchPoemMeaning 作语义近似检索。",
  };
}

const INTENT_PREFIX = /^(请|麻烦|帮我|帮忙|我想|想要|想|要|找|查找|查|搜|搜索|来|给我|有没有|有哪些)+/;
const INTENT_SUFFIX = /(诗句|诗词|古诗|古诗词|句子|一句|几句|一下|相关|类似|相近|大概|意思)+$/;

/**
 * 去掉“帮我找一些写……的诗句”这类话头，留下可供打分的字。
 * @param {string} query
 */
function coreQuery(query) {
  let text = plain(query).replace(/的/g, "");
  text = text.replace(INTENT_PREFIX, "").replace(INTENT_SUFFIX, "");
  text = text.replace(INTENT_PREFIX, "").replace(INTENT_SUFFIX, "");
  return text;
}

const NOISE_CHARS = new Set([...(
  "请帮查找搜有无写描写表达关于大概意思相近类似相关诗句词语句子一下么呢吧啊的之了着过这那哪些什么如何怎么可以不"
)]);

/**
 * 查询里直接出现的词，按连接词拆开。
 * @param {string} core
 * @returns {string[]}
 */
function directParts(core) {
  return core
    .split(/[和与及、,，\s]+|还有|或者|以及/)
    .map((part) => part.trim())
    .filter((part) => part && [...part].some((ch) => /\p{Script=Han}/u.test(ch) && !NOISE_CHARS.has(ch)));
}

/**
 * @param {string} core
 */
function activeThemes(core) {
  return THEMES.filter((theme) => theme.keys.some((key) => core.includes(key)));
}

/**
 * 构造字与双字的权重表。
 * @param {string} core
 * @param {string[]} parts
 * @param {object[]} themes
 */
function buildWeights(core, parts, themes) {
  const charWeights = new Map();
  const bigramWeights = new Map();
  const charCues = new Map();
  const bigramCues = new Map();

  /**
   * @param {Map<string, number>} map
   * @param {Map<string, string>} cues
   * @param {string} key
   * @param {number} weight
   * @param {string} cue
   */
  const bump = (map, cues, key, weight, cue) => {
    if (!key) return;
    if (weight <= (map.get(key) || 0)) return;
    map.set(key, weight);
    cues.set(key, cue);
  };

  /**
   * @param {string} term
   * @param {number} weight
   * @param {string} cue
   */
  const addTerm = (term, weight, cue) => {
    for (const form of forms(term)) {
      const chars = [...form].filter((ch) => /\p{Script=Han}/u.test(ch));
      if (!chars.length) continue;
      if (chars.length === 1) {
        if (!NOISE_CHARS.has(chars[0])) bump(charWeights, charCues, chars[0], weight, cue);
        continue;
      }
      const step = weight / Math.max(1, chars.length - 1);
      for (let i = 0; i + 1 < chars.length; i += 1) {
        bump(bigramWeights, bigramCues, chars[i] + chars[i + 1], step, cue);
      }
      for (const ch of chars) {
        if (!NOISE_CHARS.has(ch)) bump(charWeights, charCues, ch, weight * 0.28, cue);
      }
    }
  };

  for (const part of parts) addTerm(part, 3.2, part);
  for (const ch of core) {
    if (!NOISE_CHARS.has(ch) && /\p{Script=Han}/u.test(ch)) {
      bump(charWeights, charCues, ch, 0.9, ch);
    }
  }
  for (const theme of themes) {
    for (const term of theme.terms) {
      const length = [...term].length;
      addTerm(term, length <= 1 ? 1.35 : 1.5 + Math.min(1.4, length * 0.25), theme.name);
    }
  }

  return { charWeights, bigramWeights, charCues, bigramCues };
}

/**
 * 语义检索用的行表：预先去掉标点，避免每次查询都重跑一遍正则。
 * 只存检索需要的三列，原诗仍在 poems 的原始行里。
 * @type {{ keys: string[], rowIds: number[], lineIds: number[] } | null}
 */
let lineCache = null;

function semanticLines() {
  if (lineCache) return lineCache;
  const rows = poemRows();
  const keys = [];
  const rowIds = [];
  const lineIds = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const lines = String(rows[rowIndex][2]).split(/\r?\n/);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const raw = lines[lineIndex];
      if (raw.length < 4 || raw.length > 40) continue;
      const key = plain(raw);
      if (key.length < 4 || key.length > 36) continue;
      keys.push(key);
      rowIds.push(rowIndex);
      lineIds.push(lineIndex);
    }
  }
  lineCache = { keys, rowIds, lineIds };
  return lineCache;
}

/** 行长度的归一化因子，逐行算 Math.pow 太费。 */
const LENGTH_FACTOR = Array.from({ length: 40 }, (_, index) => Math.pow(Math.max(1, index), 0.32));

/**
 * 语义近似检索。按主题意象扩展后，用字与双字重合度排序。
 * @param {object} args
 * @param {string} args.query 想找的意思、主题或场景
 * @param {string} [args.author] 限定作者
 * @param {string} [args.source] 限定出处
 * @param {number} [args.limit] 最多几条，默认 8
 * @returns {object}
 */
export function searchPoemMeaning(args = {}) {
  const query = String(args.query ?? "").trim();
  if (!query) throw new Error("searchPoemMeaning 需要描述想找的意思。");

  const core = coreQuery(query);
  if ([...core].length < 2) throw new Error("searchPoemMeaning 的查询太短，请多说几个字。");

  const parts = directParts(core);
  const themes = activeThemes(core);
  const { charWeights, bigramWeights, charCues, bigramCues } = buildWeights(core, parts, themes);

  const limit = intArg(args.limit, 8, 1, 20);
  const keep = Math.max(60, limit * 12);
  const authorOk = authorFilter(args.author);
  const sourceWanted = sourceKey(args.source);

  const rows = poemRows();
  const { keys, rowIds, lineIds } = semanticLines();
  let candidates = [];

  for (let index = 0; index < keys.length; index += 1) {
    const rowIndex = rowIds[index];
    const row = rows[rowIndex];
    if (sourceWanted && row[3] !== sourceWanted) continue;
    if (authorOk && !authorOk(row[0])) continue;

    const key = keys[index];
    let charScore = 0;
    let bigramScore = 0;
    const cues = [];
    /** 同一个字、同一个双字在一句里重复出现时，只按首次计全重，后面递减。 */
    let usedChars = null;
    let usedBigrams = null;
    for (const ch of key) {
      const weight = charWeights.get(ch);
      if (!weight) continue;
      if (usedChars && usedChars.includes(ch)) {
        charScore += weight * 0.25;
        continue;
      }
      if (!usedChars) usedChars = [];
      usedChars.push(ch);
      charScore += weight;
      if (charCues.has(ch)) cues.push(charCues.get(ch));
    }
    for (let i = 0; i + 1 < key.length; i += 1) {
      const bigram = key.slice(i, i + 2);
      const weight = bigramWeights.get(bigram);
      if (!weight) continue;
      if (usedBigrams && usedBigrams.includes(bigram)) {
        bigramScore += weight * 0.3;
        continue;
      }
      if (!usedBigrams) usedBigrams = [];
      usedBigrams.push(bigram);
      bigramScore += weight;
      if (bigramCues.has(bigram)) cues.push(bigramCues.get(bigram));
    }

    let coverage = 0;
    if (parts.length > 1) {
      let covered = 0;
      for (const part of parts) {
        if ([...part].some((ch) => key.includes(ch))) covered += 1;
      }
      if (covered === parts.length) coverage = 1.6;
    }

    const score = (charScore + bigramScore * 1.15) / LENGTH_FACTOR[key.length] + coverage;
    if (score < 2.1) continue;
    candidates.push({
      key,
      rowIndex,
      lineIndex: lineIds[index],
      score,
      cues,
    });
    if (candidates.length > keep * 4) {
      candidates.sort((a, b) => b.score - a.score);
      candidates = candidates.slice(0, keep);
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const items = [];
  const usedPoems = new Set();
  const usedLines = new Set();
  const authorCount = new Map();

  for (const candidate of candidates) {
    if (usedPoems.has(candidate.rowIndex) || usedLines.has(candidate.key)) continue;
    const row = rows[candidate.rowIndex];
    const usedByAuthor = authorCount.get(row[0]) || 0;
    if (usedByAuthor >= 3) continue;
    usedPoems.add(candidate.rowIndex);
    usedLines.add(candidate.key);
    authorCount.set(row[0], usedByAuthor + 1);

    const lines = String(row[2]).split(/\r?\n/);
    const { before, after } = contextOf(lines, candidate.lineIndex);
    items.push({
      author: row[0],
      title: row[1],
      source: row[3],
      line: lines[candidate.lineIndex] || "",
      lineIndex: candidate.lineIndex,
      before,
      after,
      score: Math.round(candidate.score * 10) / 10,
      cues: [...new Set(candidate.cues)].slice(0, 6),
    });
    if (items.length >= limit) break;
  }

  return {
    query,
    mode: "semantic",
    approximate: true,
    themes: themes.map((theme) => theme.name),
    found: items.length > 0,
    count: items.length,
    items,
    detail: items.length
      ? `按${themes.length ? `主题「${themes.map((theme) => theme.name).join("、")}」与` : ""}字面重合度排序，属近似检索，不是严格语义模型。引用前可用 searchPoemLines 核对原句。`
      : "没有找到足够相近的句子。可换一种说法，或改用 searchPoemLines 按字面查。",
  };
}
