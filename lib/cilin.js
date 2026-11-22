/**
 * 词林正韵查询。字表在 data/cilin.json，第一次调用时读入。
 *
 * 平水韵按平、上、去、入四声分一百零六部，作诗只押平声韵；
 * 填词另用《词林正韵》，把相邻的平水韵韵部并成十九部，
 * 每部再分平声、仄声（上声与去声）、入声。仄声韵就落在这里。
 */

import { readFileSync } from "node:fs";
import { normKey } from "./text.js";
import { dataFile as resolveData } from "./paths.js";

const dataFile = resolveData("cilin.json");

/** @type {{ groups: object[], names: Record<string, number[]>, alias: Record<string, string> } | null} */
let table = null;
/** @type {Map<string, object[]> | null} */
let byChar = null;

function load() {
  if (table) return;
  table = JSON.parse(readFileSync(dataFile, "utf8"));
  byChar = new Map();
  table.groups.forEach((group, index) => {
    for (const ch of group.chars) {
      const list = byChar.get(ch) || [];
      list.push({
        tone: group.tone,
        rhyme: group.id,
        section: group.section,
        index,
      });
      byChar.set(ch, list);
    }
  });
}

/**
 * 一个字在《词林正韵》中的全部读法。没有则空数组。
 * @param {string} ch
 * @returns {{ tone: string, rhyme: string, section: string }[]}
 */
export function lookupCiChar(ch) {
  load();
  const direct = byChar.get(ch);
  if (direct) return direct.map(stripIndex);
  const simplified = table.alias[ch];
  if (simplified && byChar.has(simplified)) {
    return byChar.get(simplified).map(stripIndex);
  }
  return [];
}

/**
 * @param {object} reading
 */
function stripIndex(reading) {
  return {
    tone: reading.tone,
    rhyme: reading.rhyme,
    section: reading.section,
  };
}

/**
 * 按韵部名或声调查词林正韵。声调可填「平声」「仄声」「入声」。
 * @param {string} name
 * @returns {object[]}
 */
export function findCiGroups(name) {
  load();
  const key = normKey(name);
  const indexes = table.names[key] || [];
  return indexes.map((index) => table.groups[index]);
}

/**
 * 列出某一类声调的全部韵部。词林正韵里仄声只分上声、去声一类。
 * @param {string} tone 平声 / 仄声 / 入声
 * @returns {object[]}
 */
export function ciGroupsOfTone(tone) {
  load();
  const key = normKey(tone);
  const wanted = key.includes("入")
    ? "入"
    : key.includes("仄") || key.includes("上") || key.includes("去")
      ? "仄"
      : key.includes("平")
        ? "平"
        : "";
  if (!wanted) return [];
  return table.groups.filter((group) => group.tone === wanted);
}

/**
 * 校验若干韵脚字是否同属一个词林正韵韵部。
 *
 * 同部后再看声调：平声、仄声、入声各自可以通押；平仄相杂时只报同部，
 * 是否允许转韵交给词牌判断，不硬判出韵。
 *
 * @param {string[]} rhymeChars
 * @returns {object}
 */
export function checkCiYun(rhymeChars) {
  load();
  const options = rhymeChars.map((ch) => {
    const readings = lookupCiChar(ch);
    return {
      char: ch,
      rhymes: [...new Set(readings.map((item) => item.rhyme))],
      tones: [...new Set(readings.map((item) => item.tone))],
      readings,
    };
  });

  const unknown = options.filter((item) => item.readings.length === 0).map((item) => item.char);
  if (unknown.length) {
    return {
      book: "词林正韵",
      rhymeChars,
      sameRhyme: null,
      rhyme: null,
      uniformTone: null,
      compatible: null,
      options: options.map(publicOption),
      detail: `「${unknown.join("、")}」《词林正韵》未收，不得编造韵部。`,
    };
  }

  let common = new Set(options[0].readings.map((item) => item.rhyme));
  for (const item of options.slice(1)) {
    common = new Set([...common].filter((rhyme) => item.rhymes.includes(rhyme)));
  }
  const rhyme = [...common];

  let uniformTone = null;
  if (rhyme.length) {
    for (const tone of ["平", "仄", "入"]) {
      if (options.every((item) => item.readings.some(
        (reading) => reading.tone === tone && rhyme.includes(reading.rhyme),
      ))) {
        uniformTone = tone;
        break;
      }
    }
  }

  const toneNames = { 平: "平声", 仄: "仄声", 入: "入声" };
  let detail;
  if (!rhyme.length) {
    detail = "这些字没有共同的《词林正韵》韵部。";
  } else if (uniformTone) {
    detail = `可以同入：${rhyme.join("、")}（${toneNames[uniformTone]}）。`;
  } else {
    detail = `同属${rhyme.join("、")}，但平仄相杂；词中平韵、仄韵一般分押，是否允许转韵要看词牌。`;
  }

  return {
    book: "词林正韵",
    rhymeChars,
    sameRhyme: rhyme.length > 0,
    rhyme: rhyme.length ? rhyme : null,
    uniformTone,
    compatible: rhyme.length ? Boolean(uniformTone) : false,
    options: options.map(publicOption),
    detail,
  };
}

/**
 * @param {{ char: string, rhymes: string[], tones: string[] }} item
 */
function publicOption(item) {
  return {
    char: item.char,
    rhymes: item.rhymes,
    tones: item.tones,
  };
}
