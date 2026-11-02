/**
 * 词谱核对。数据在 data/cipu.json，来自 hulbji/couyun 整理的钦定词谱与龙榆生《唐宋词格律》。
 * 平仄用平水韵，入声作仄。谱里的「中」是可平可仄，不判错。
 */

import { readFileSync } from "node:fs";
import { hanzi, normKey } from "./text.js";
import { lookupChar, meterOptions } from "./pingshui.js";
import { dataFile as resolveData } from "./paths.js";

const dataFile = resolveData("cipu.json");

const BOOKS = {
  qin: "钦定词谱",
  long: "龙榆生《唐宋词格律》",
};

/** @type {{ tunes: object[], byName: Map<string, number[]> } | null} */
let table = null;

function load() {
  if (table) return;
  const raw = JSON.parse(readFileSync(dataFile, "utf8"));
  const byName = new Map();
  raw.tunes.forEach((tune, index) => {
    for (const name of tune.names || []) {
      const key = normKey(name);
      if (!key) continue;
      const list = byName.get(key) || [];
      if (!list.includes(index)) list.push(index);
      byName.set(key, list);
    }
  });
  table = { tunes: raw.tunes, byName };
}

/**
 * @param {unknown} value
 * @returns {"" | "qin" | "long"}
 */
function bookKey(value) {
  const text = String(value ?? "").replace(/\s/g, "");
  if (!text) return "";
  if (/龙榆生|唐宋词格律|龙谱/.test(text)) return "long";
  if (/钦定|钦谱/.test(text)) return "qin";
  return "unknown";
}

/**
 * @param {string} mark
 * @returns {string[]}
 */
function symbolsOf(mark) {
  return [...String(mark)].filter((ch) => ch === "平" || ch === "仄" || ch === "中");
}

/**
 * 句读落在第几个字上（从 0 起），用来在字数相同的各格里选更接近的一格。
 * @param {string} text
 * @returns {Set<number>}
 */
function breakPositions(text) {
  const marks = new Set("，。！？、；：,.;!?:　 \n\r");
  const positions = new Set();
  let count = 0;
  let pending = false;
  for (const ch of String(text ?? "")) {
    if (marks.has(ch)) {
      if (!pending && count > 0) positions.add(count - 1);
      pending = true;
      continue;
    }
    if (/\p{Script=Han}/u.test(ch)) {
      count += 1;
      pending = false;
    }
  }
  return positions;
}

/**
 * @param {string} ch
 */
function toneLabel(ch) {
  const readings = lookupChar(ch);
  if (!readings.length) return { label: "未", title: "平水韵未收" };
  const tones = [...new Set(readings.map((item) => item.tone))];
  return {
    label: tones.join("/"),
    title: readings.map((item) => `${item.tone} · ${item.rhyme}`).join("；"),
  };
}

/**
 * @param {string[]} chars
 * @param {number[][]} groups
 */
function rhymeReport(chars, groups) {
  return (groups || []).map((positions, index) => {
    const feet = positions.map((pos) => {
      const at = Math.abs(pos);
      const ch = chars[at] || "";
      const readings = lookupChar(ch);
      return {
        char: ch,
        xie: pos < 0,
        rhymes: [...new Set(readings.map((item) => item.rhyme))],
      };
    });
    const known = feet.filter((item) => item.rhymes.length);
    let same = null;
    if (known.length >= 2) {
      let shared = new Set(known[0].rhymes);
      for (const item of known.slice(1)) {
        shared = new Set([...shared].filter((rhyme) => item.rhymes.includes(rhyme)));
      }
      same = shared.size > 0;
    }
    return { label: `第${index + 1}组`, feet, same };
  });
}

/**
 * @param {object} form
 * @param {string[]} chars
 * @param {Set<number>} breaks
 */
function scoreForm(form, chars, breaks) {
  const pieces = (form.marks || []).map(symbolsOf).filter((row) => row.length);
  const symbols = pieces.flat();
  const lengthDiff = Math.abs(symbols.length - chars.length);
  let bad = 0;
  let unknown = 0;
  if (lengthDiff === 0) {
    symbols.forEach((expect, index) => {
      if (expect === "中") return;
      const meter = meterOptions(chars[index]);
      if (meter.unknown) unknown += 1;
      else if (!meter.options.includes(expect)) bad += 1;
    });
  }
  let overlap = 0;
  if (lengthDiff === 0 && breaks.size) {
    let cursor = 0;
    for (const row of pieces) {
      cursor += row.length;
      if (breaks.has(cursor - 1)) overlap += 1;
    }
  }
  return { lengthDiff, bad, unknown, overlap, symbols, pieces };
}

/**
 * @param {object} tune
 * @param {string} book
 * @param {object} form
 * @param {number} variantIndex
 * @param {string[]} chars
 * @param {ReturnType<typeof scoreForm>} score
 */
function reportForm(tune, book, form, variantIndex, chars, score) {
  const lines = [];
  const issues = [];
  const unknown = [];
  let cursor = 0;
  score.pieces.forEach((row, lineIndex) => {
    const line = row.map((expect, offset) => {
      const ch = chars[cursor];
      cursor += 1;
      const tone = toneLabel(ch);
      const meter = meterOptions(ch);
      let status = "ok";
      if (expect === "中") status = "free";
      else if (meter.unknown) status = "unknown";
      else if (!meter.options.includes(expect)) status = "bad";
      if (status === "unknown") unknown.push(ch);
      if (status === "bad") {
        issues.push({
          line: lineIndex + 1,
          position: offset + 1,
          ch,
          expect,
          actual: tone.label,
        });
      }
      const expectText = expect === "中" ? "可平可仄" : `宜${expect}`;
      return {
        ch,
        tone: tone.label,
        expect,
        status,
        title: `${tone.title}。谱：${expectText}`,
      };
    });
    lines.push(line);
  });

  const name = tune.names[0];
  const bookName = BOOKS[book];
  const variant = variantIndex + 1;
  const head = `${bookName} · ${name} · 第${variant}格，共 ${chars.length} 字。`;
  const body = issues.length
    ? `有 ${issues.length} 处不合谱。`
    : unknown.length
      ? "已收字的平仄相合。未收字不作判。"
      : "平仄相合。";

  return {
    found: true,
    matched: true,
    cipai: name,
    book: bookName,
    variant,
    variantCount: (tune[book] || []).length,
    badCount: issues.length,
    unknownCount: unknown.length,
    marks: form.marks || [],
    example: form.example || "",
    lines,
    issues,
    unknown: [...new Set(unknown)],
    rhyme: rhymeReport(chars, form.groups),
    detail: `${head}${body}`,
    note: "声调依平水韵，入声作仄。谱中「中」为可平可仄。韵脚只列平水韵；词韵常更宽，不同部不判出韵。",
  };
}

/**
 * @param {object} args
 * @param {string} args.cipai
 * @param {string} args.text
 * @param {string} [args.book]
 * @param {number} [args.variant]
 */
export function checkCi(args) {
  load();
  const cipai = String(args.cipai ?? "").trim();
  let text = String(args.text ?? "").trim();
  if (!cipai || !text) {
    throw new Error("checkCiPu 需要词牌名和词正文。");
  }

  const book = bookKey(args.book);
  if (book === "unknown") {
    return {
      found: false,
      matched: false,
      detail: "只收录两部词谱：钦定词谱，以及龙榆生《唐宋词格律》。请指定其中一部，或留空由程序自选。",
    };
  }

  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (rows.length > 1 && normKey(rows[0]) === normKey(cipai)) {
    text = rows.slice(1).join("\n");
  }
  const chars = hanzi(text);
  if (!chars.length) {
    throw new Error("checkCiPu 的正文里没有汉字。");
  }

  const ids = table.byName.get(normKey(cipai)) || [];
  if (!ids.length) {
    return {
      found: false,
      matched: false,
      cipai,
      detail: "词谱未收录此词牌。不得凭记忆编造格律。",
    };
  }

  const variant = Number(args.variant);
  const wantVariant = Number.isInteger(variant) && variant > 0;
  const breaks = breakPositions(text);
  /** @type {object[]} */
  const pool = [];

  for (const id of ids) {
    const tune = table.tunes[id];
    const books = book ? [book] : ["qin", "long"];
    for (const key of books) {
      const forms = tune[key] || [];
      if (!forms.length) continue;
      forms.forEach((form, index) => {
        if (wantVariant && index !== variant - 1) return;
        pool.push({ tune, book: key, form, index });
      });
    }
  }

  if (!pool.length) {
    const tune = table.tunes[ids[0]];
    if (book === "long" && !(tune.long || []).length) {
      return {
        found: true,
        matched: false,
        cipai: tune.names[0],
        detail: `龙榆生《唐宋词格律》未收「${tune.names[0]}」。钦定词谱收有此调。`,
      };
    }
    return {
      found: true,
      matched: false,
      cipai: tune.names[0],
      detail: wantVariant ? `没有第 ${variant} 格。` : "没有可核对的词谱格式。",
    };
  }

  const ranked = pool.map((item) => ({
    ...item,
    score: scoreForm(item.form, chars, breaks),
  }));
  const fitting = ranked.filter((item) => item.score.lengthDiff === 0);
  if (!fitting.length) {
    const sizes = ranked.map((item) => `${BOOKS[item.book]}第${item.index + 1}格 ${item.score.symbols.length} 字`);
    return {
      found: true,
      matched: false,
      cipai: ranked[0].tune.names[0],
      detail: `来稿 ${chars.length} 字，与各格字数都不合，未判平仄。各格为：${sizes.join("、")}。`,
    };
  }

  fitting.sort((a, b) => {
    if (a.score.bad !== b.score.bad) return a.score.bad - b.score.bad;
    if (a.score.unknown !== b.score.unknown) return a.score.unknown - b.score.unknown;
    if (a.score.overlap !== b.score.overlap) return b.score.overlap - a.score.overlap;
    if (!book && a.book !== b.book) return a.book === "qin" ? -1 : 1;
    return a.index - b.index;
  });

  const best = fitting[0];
  return reportForm(best.tune, best.book, best.form, best.index, chars, best.score);
}
