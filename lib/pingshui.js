/**
 * 平水韵查询。字表在 data/pingshui.json，第一次调用时读入。
 * 声调只作「平」「仄」「入」。近体诗的粘对、拗救另把「入」当作仄。
 */

import { readFileSync } from "node:fs";
import { normKey } from "./text.js";
import { dataFile as resolveData } from "./paths.js";

const dataFile = resolveData("pingshui.json");

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
        name: group.name,
        index,
      });
      byChar.set(ch, list);
    }
  });
}

/**
 * 一个字在平水韵中的全部读音。没有则空数组。
 * @param {string} ch
 * @returns {{ tone: string, rhyme: string, section: string, name: string }[]}
 */
export function lookupChar(ch) {
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
    name: reading.name,
  };
}

/**
 * 近体诗用的平仄。入声并入仄。多音则 options 里同时有「平」和「仄」。
 * @param {string} ch
 * @returns {{ readings: object[], options: string[], unknown: boolean }}
 */
export function meterOptions(ch) {
  const readings = lookupChar(ch);
  const options = new Set();
  for (const reading of readings) {
    options.add(reading.tone === "平" ? "平" : "仄");
  }
  return {
    readings,
    options: [...options],
    unknown: readings.length === 0,
  };
}

/**
 * 按韵部名称找韵部。同一简称可能对应多部。
 * @param {string} name
 * @returns {object[]}
 */
export function findGroups(name) {
  load();
  const key = normKey(name);
  const indexes = table.names[key] || [];
  return indexes.map((index) => table.groups[index]);
}
