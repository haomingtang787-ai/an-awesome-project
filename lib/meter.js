/**
 * 近体诗粘对与拗救。
 * 平仄来自平水韵；入声作仄。句式采用通行的五言、七言四种起结。
 * 一、三与七言第五字从宽，二、四、六和句脚从严。孤平、三拗四救、三平调另判。
 */

import { hanzi } from "./text.js";
import { meterOptions } from "./pingshui.js";

/** 八句格式。超过八句时，从第五句起循环。 */
const FORMS = {
  5: {
    "仄起·不入韵": ["仄仄平平仄", "平平仄仄平", "平平平仄仄", "仄仄仄平平", "仄仄平平仄", "平平仄仄平", "平平平仄仄", "仄仄仄平平"],
    "仄起·入韵": ["仄仄仄平平", "平平仄仄平", "平平平仄仄", "仄仄仄平平", "仄仄平平仄", "平平仄仄平", "平平平仄仄", "仄仄仄平平"],
    "平起·不入韵": ["平平平仄仄", "仄仄仄平平", "仄仄平平仄", "平平仄仄平", "平平平仄仄", "仄仄仄平平", "仄仄平平仄", "平平仄仄平"],
    "平起·入韵": ["平平仄仄平", "仄仄仄平平", "仄仄平平仄", "平平仄仄平", "平平仄仄平", "仄仄仄平平", "仄仄平平仄", "平平仄仄平"],
  },
  7: {
    "平起·不入韵": ["平平仄仄平平仄", "仄仄平平仄仄平", "仄仄平平平仄仄", "平平仄仄仄平平", "平平仄仄平平仄", "仄仄平平仄仄平", "仄仄平平平仄仄", "平平仄仄仄平平"],
    "平起·入韵": ["平平仄仄仄平平", "仄仄平平仄仄平", "仄仄平平平仄仄", "平平仄仄仄平平", "平平仄仄平平仄", "仄仄平平仄仄平", "仄仄平平平仄仄", "平平仄仄仄平平"],
    "仄起·不入韵": ["仄仄平平平仄仄", "平平仄仄仄平平", "平平仄仄平平仄", "仄仄平平仄仄平", "仄仄平平平仄仄", "平平仄仄仄平平", "平平仄仄平平仄", "仄仄平平仄仄平"],
    "仄起·入韵": ["仄仄平平仄仄平", "平平仄仄仄平平", "平平仄仄平平仄", "仄仄平平平仄仄", "仄仄平平仄仄平", "平平仄仄仄平平", "平平仄仄平平仄", "仄仄平平平仄仄"],
  },
};

/**
 * @param {string[]} lines 已经按句切开的诗句
 */
export function analyzeNianDui(lines) {
  const prepared = lines.map((line, index) => prepareLine(line, index));
  const dui = [];
  const nian = [];

  for (let i = 0; i + 1 < prepared.length; i += 2) {
    dui.push(comparePair(prepared[i], prepared[i + 1], "对"));
  }
  for (let i = 1; i + 1 < prepared.length; i += 2) {
    nian.push(comparePair(prepared[i], prepared[i + 1], "粘"));
  }

  return {
    lines: prepared.map((line) => line.text || line.raw),
    dui,
    nian,
  };
}

/**
 * @param {string[]} lines
 */
export function analyzeAoJiu(lines) {
  const prepared = lines.map((line, index) => prepareLine(line, index));
  const lengths = new Set(prepared.filter((line) => line.length === 5 || line.length === 7).map((line) => line.length));
  const uniform = lengths.size === 1 ? [...lengths][0] : 0;
  const chosen = uniform && prepared.length >= 2 ? chooseForm(prepared, uniform) : null;
  const violations = [];
  const rescues = [];
  const unknownChars = [];

  prepared.forEach((line, index) => {
    for (const ch of line.chars) {
      if (meterOptions(ch).unknown) unknownChars.push(ch);
    }
    if (line.length !== 5 && line.length !== 7) {
      violations.push({
        line: index + 1,
        kind: "非近体句",
        detail: `第${index + 1}句有 ${line.length} 字，五言、七言拗救规则用不上。`,
      });
      return;
    }
    const pattern = chosen
      ? patternAt(FORMS[uniform][chosen.form], index)
      : bestSinglePattern(line);
    inspectLine(line, pattern, index, violations, rescues);
  });

  return {
    form: chosen ? `${uniform}言${chosen.form.replace("·", "")}` : "各句单独比对，未定全篇起结",
    rhymeDecision: chosen?.rhymeDecision || "未定",
    lines: prepared.map((line) => line.text),
    violations,
    rescues,
    unknownChars: [...new Set(unknownChars)],
  };
}

/**
 * @param {string} line
 * @param {number} index
 */
function prepareLine(line, index) {
  const chars = hanzi(line);
  return {
    index,
    raw: String(line),
    text: chars.join(""),
    chars,
    length: chars.length,
    second: chars[1] || "",
  };
}

/**
 * @param {object} left
 * @param {object} right
 * @param {"对" | "粘"} kind
 */
function comparePair(left, right, kind) {
  const expect = kind === "对" ? "相反" : "相同";
  const base = {
    kind,
    upper: left.text,
    lower: right.text,
    upperChar: left.second,
    lowerChar: right.second,
  };
  if (!left.second || !right.second) {
    return { ...base, result: "缺字", detail: "某句不足两字，看不了第二字。" };
  }
  const a = meterOptions(left.second);
  const b = meterOptions(right.second);
  if (a.unknown || b.unknown) {
    const missing = [a.unknown ? left.second : "", b.unknown ? right.second : ""].filter(Boolean).join("、");
    return { ...base, result: "缺字", detail: `「${missing}」平水韵未收，不能判断${kind}。` };
  }
  const outcomes = [];
  for (const leftTone of a.options) {
    for (const rightTone of b.options) {
      outcomes.push(kind === "对" ? leftTone !== rightTone : leftTone === rightTone);
    }
  }
  const toneNote = `「${left.second}」${a.options.join("/")}，「${right.second}」${b.options.join("/")}`;
  if (outcomes.every(Boolean)) {
    return { ...base, result: kind, detail: `第二字${toneNote}，平仄${expect}。` };
  }
  if (outcomes.some(Boolean)) {
    return { ...base, result: "未决", detail: `第二字有多音，${toneNote}，不能断定${kind}。` };
  }
  return { ...base, result: kind === "对" ? "失对" : "失粘", detail: `第二字${toneNote}，平仄并非${expect}。` };
}

/**
 * @param {object[]} lines
 * @param {5 | 7} length
 */
function chooseForm(lines, length) {
  const rhymeDecision = openingRhyme(lines);
  let best = null;
  for (const [form, patterns] of Object.entries(FORMS[length])) {
    let score = 0;
    lines.forEach((line, index) => {
      if (line.length !== length) return;
      const pattern = patternAt(patterns, index);
      score += strictMisses(line.chars, pattern);
    });
    const rhymed = form.endsWith("·入韵");
    if (rhymeDecision === "入韵" && !rhymed) score += 3;
    if (rhymeDecision === "不入韵" && rhymed) score += 3;
    if (rhymeDecision === "未定" && rhymed && length === 5) score += 1;
    if (!best || score < best.score) best = { form, score, rhymeDecision };
  }
  return best;
}

/**
 * 首句末字与次句末字是否同平声韵。
 * @param {object[]} lines
 * @returns {"入韵" | "不入韵" | "未定"}
 */
function openingRhyme(lines) {
  if (lines.length < 2) return "未定";
  const a = lines[0].chars.at(-1);
  const b = lines[1].chars.at(-1);
  if (!a || !b) return "未定";
  const left = meterOptions(a).readings.filter((item) => item.tone === "平").map((item) => item.rhyme);
  const right = meterOptions(b).readings.filter((item) => item.tone === "平").map((item) => item.rhyme);
  if (!left.length || !right.length) return "未定";
  return left.some((rhyme) => right.includes(rhyme)) ? "入韵" : "不入韵";
}

/**
 * @param {string[]} patterns
 * @param {number} index
 */
function patternAt(patterns, index) {
  if (index < patterns.length) return patterns[index];
  const cycle = patterns.slice(4);
  return cycle[(index - 4) % cycle.length];
}

/**
 * @param {string[]} chars
 * @param {string} pattern
 */
function strictMisses(chars, pattern) {
  let misses = 0;
  for (const index of strictIndexes(pattern.length)) {
    const verdict = allows(meterOptions(chars[index] || ""), pattern[index]);
    if (verdict === "no") misses += 1;
  }
  return misses;
}

/**
 * @param {number} length
 */
function strictIndexes(length) {
  if (length === 5) return [1, 3, 4];
  if (length === 7) return [1, 3, 5, 6];
  return [];
}

/**
 * @param {{ unknown: boolean, options: string[] }} info
 * @param {string} expected
 * @returns {"yes" | "maybe" | "no" | "unknown"}
 */
function allows(info, expected) {
  if (!info || info.unknown) return "unknown";
  if (!info.options.includes(expected)) return "no";
  return info.options.length === 1 ? "yes" : "maybe";
}

/**
 * @param {object} line
 */
function bestSinglePattern(line) {
  const patterns = [...new Set(Object.values(FORMS[line.length]).flat())];
  let best = patterns[0];
  let bestScore = Infinity;
  let bestAll = Infinity;
  for (const pattern of patterns) {
    const score = strictMisses(line.chars, pattern);
    const all = allMisses(line.chars, pattern);
    if (score < bestScore || (score === bestScore && all < bestAll)) {
      best = pattern;
      bestScore = score;
      bestAll = all;
    }
  }
  return best;
}

/**
 * 单句在几种句式之间难分时，用全部位置的出入做次序。
 * @param {string[]} chars
 * @param {string} pattern
 */
function allMisses(chars, pattern) {
  let misses = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    if (allows(meterOptions(chars[index] || ""), pattern[index]) === "no") misses += 1;
  }
  return misses;
}

/**
 * @param {object} line
 * @param {string} pattern
 * @param {number} index
 * @param {object[]} violations
 * @param {object[]} rescues
 */
function inspectLine(line, pattern, index, violations, rescues) {
  const explained = new Set();
  const guping = gupingAt(pattern);
  if (guping) {
    const head = meterOptions(line.chars[guping[0]]);
    const save = meterOptions(line.chars[guping[1]]);
    const headZe = allows(head, "仄");
    const savePing = allows(save, "平");
    const saveZe = allows(save, "仄");
    if (headZe === "yes" && saveZe === "yes" && savePing === "no") {
      violations.push({
        line: index + 1,
        position: guping[0] + 1,
        kind: "犯孤平",
        detail: `第${index + 1}句「${line.text}」第一处当平的字用了仄，救字仍是仄。`,
      });
      explained.add(guping[0]);
      explained.add(guping[1]);
    } else if (headZe === "yes" && savePing === "yes" && saveZe === "no") {
      rescues.push({
        line: index + 1,
        kind: "孤平拗救",
        positions: [guping[0] + 1, guping[1] + 1],
        detail: `第${index + 1}句「${line.text}」孤平已由第 ${guping[1] + 1} 字改平救回。`,
      });
      explained.add(guping[0]);
      explained.add(guping[1]);
    } else if (headZe === "yes" && savePing === "maybe") {
      violations.push({
        line: index + 1,
        position: guping[1] + 1,
        kind: "孤平未决",
        detail: `第${index + 1}句救字有平、仄两读，不能断定孤平是否已救。`,
      });
    }
  }

  const sansao = sansaoAt(pattern);
  if (sansao) {
    const ao = meterOptions(line.chars[sansao[0]]);
    const jiu = meterOptions(line.chars[sansao[1]]);
    if (allows(ao, "仄") === "yes" && allows(ao, "平") === "no" && allows(jiu, "平") === "yes" && allows(jiu, "仄") === "no") {
      rescues.push({
        line: index + 1,
        kind: "三拗四救",
        positions: [sansao[0] + 1, sansao[1] + 1],
        detail: `第${index + 1}句「${line.text}」第 ${sansao[0] + 1} 字当平而仄，第 ${sansao[1] + 1} 字改平相救。`,
      });
      explained.add(sansao[0]);
      explained.add(sansao[1]);
    } else if (allows(ao, "仄") === "yes" && allows(ao, "平") === "no" && allows(jiu, "仄") === "yes" && allows(jiu, "平") === "no") {
      violations.push({
        line: index + 1,
        position: sansao[0] + 1,
        kind: "拗而未救",
        detail: `第${index + 1}句「${line.text}」该平的字用了仄，邻字没有改平来救。`,
      });
      explained.add(sansao[0]);
    }
  }

  if (pattern.endsWith("平平") && pattern.at(-3) === "仄") {
    const third = meterOptions(line.chars[pattern.length - 3]);
    if (allows(third, "平") === "yes" && allows(third, "仄") === "no") {
      violations.push({
        line: index + 1,
        position: pattern.length - 2,
        kind: "三平调",
        detail: `第${index + 1}句「${line.text}」句尾三字皆平。`,
      });
      explained.add(pattern.length - 3);
    }
  }

  for (const position of strictIndexes(pattern.length)) {
    if (explained.has(position)) continue;
    const info = meterOptions(line.chars[position] || "");
    const verdict = allows(info, pattern[position]);
    if (verdict === "no") {
      violations.push({
        line: index + 1,
        position: position + 1,
        kind: "失律",
        expected: pattern[position],
        actual: info.options.join("/"),
        detail: `第${index + 1}句第 ${position + 1} 字「${line.chars[position]}」应${pattern[position]}，实际为${info.options.join("/")}。`,
      });
    }
  }
}

/**
 * 孤平发生的位置：五言第 1 字与第 3 字，七言第 3 字与第 5 字。
 * @param {string} pattern
 * @returns {[number, number] | null}
 */
function gupingAt(pattern) {
  if (pattern === "平平仄仄平") return [0, 2];
  if (pattern === "仄仄平平仄仄平") return [2, 4];
  return null;
}

/**
 * 三拗四救：五言第 3 字拗、第 4 字救；七言第 5 字拗、第 6 字救。
 * @param {string} pattern
 * @returns {[number, number] | null}
 */
function sansaoAt(pattern) {
  if (pattern === "平平平仄仄") return [2, 3];
  if (pattern === "仄仄平平平仄仄") return [4, 5];
  return null;
}
