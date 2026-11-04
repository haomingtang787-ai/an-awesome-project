/**
 * 把一轮工具结果收成前端能直接画的两种样子。
 * 格律工具有成功结果时做成卡片；赏析和闲聊保持普通文本。
 * 陪改与润色的回合，卡片先出、建议后随（answerAfterCard）；
 * 用户明确要新作时，诗作先出、终检卡片后随（answerBeforeCard）。
 */

import { hanzi } from "./text.js";
import { lookupChar } from "./pingshui.js";
import { analyzeAoJiu, analyzeNianDui } from "./meter.js";

const METER_TOOLS = new Set(["getPingZe", "checkNianDui", "findAoJiu", "checkYun", "checkCiPu"]);

/**
 * @param {Array<{ name: string, ok?: boolean, result?: object }>} trace
 * @param {{ task?: "create" | "polish" | "check" | "auto" }} [options]
 * @returns {object}
 */
export function presentTurn(trace, { task = "auto" } = {}) {
  const result = buildTurn(trace);
  if (result.type === "meter") {
    if (task === "create") result.answerBeforeCard = true;
    if (task === "polish") result.answerAfterCard = true;
  }
  return result;
}

/**
 * @param {Array<{ name: string, ok?: boolean, result?: object }>} trace
 * @returns {object}
 */
function buildTurn(trace) {
  const meter = (Array.isArray(trace) ? trace : []).filter(
    (item) => item && item.ok && item.result && METER_TOOLS.has(item.name),
  );
  if (!meter.length) return { type: "prose" };

  const ci = meter.find((item) => item.name === "checkCiPu");
  if (ci) return ciCard(ci.result);

  const lines = poemLines(meter);
  if (lines.length) return poemCard(lines, meter);

  const chars = meter.filter((item) => item.name === "getPingZe");
  if (chars.length) {
    return {
      type: "meter",
      variant: "chars",
      rows: chars.map((item) => charRow(item.result)),
    };
  }

  const yun = meter.find((item) => item.name === "checkYun");
  if (yun) return { type: "meter", variant: "rhyme", yun: yunView(yun.result) };
  return { type: "prose" };
}

/**
 * @param {object} result
 */
function ciCard(result) {
  const data = result && typeof result === "object" ? result : {};
  if (!data.found || !data.matched) {
    return {
      type: "meter",
      variant: "ci",
      matched: false,
      form: data.cipai || "",
      detail: data.detail || "词谱未收录。",
    };
  }
  return {
    type: "meter",
    variant: "ci",
    matched: true,
    form: data.cipai ? `${data.cipai} · ${data.book} · 第${data.variant}格` : data.book,
    lines: (data.lines || []).map((line) => line.map((item) => ({
      ch: item.ch,
      tone: item.tone,
      title: item.title,
      ao: item.status === "bad",
      jiu: false,
    }))),
    unknownChars: data.unknown || [],
    aoLabel: "朱色为不合谱",
    issues: data.issues || [],
    rhymeGroups: data.rhyme || [],
    detail: data.detail || "",
  };
}

/**
 * 取这一轮最先检查的那一版。陪改时模型会先查原稿、再验证候选改法，
 * 卡片应当停在原稿上，红字才对得上正文所说的问题。
 * @param {Array<{ name: string, result: object }>} meter
 * @returns {string[]}
 */
function poemLines(meter) {
  const ao = meter.find((item) => item.name === "findAoJiu");
  const pairs = meter.find((item) => item.name === "checkNianDui");
  for (const item of [ao, pairs]) {
    const lines = item?.result?.lines;
    if (Array.isArray(lines) && lines.some((line) => hanzi(line).length > 0)) {
      return lines.map((line) => String(line));
    }
  }
  return [];
}

/**
 * @param {string[]} lines
 * @param {Array<{ name: string, result: object }>} meter
 */
function poemCard(lines, meter) {
  const ao = analyzeAoJiu(lines);
  const pairs = analyzeNianDui(lines);
  const marks = aoMarks(ao);
  const yunCall = meter.find((item) => item.name === "checkYun");

  return {
    type: "meter",
    variant: "poem",
    form: prettyForm(ao.form),
    rhymeDecision: ao.rhymeDecision,
    unknownChars: ao.unknownChars,
    lines: ao.lines.map((line, lineIndex) => {
      const chars = hanzi(line);
      return chars.map((ch, index) => {
        const tone = toneOf(ch);
        const key = `${lineIndex + 1}:${index + 1}`;
        return {
          ch,
          tone: tone.label,
          title: tone.title,
          ao: marks.ao.has(key),
          jiu: marks.jiu.has(key),
        };
      });
    }),
    pairs: [...pairs.dui, ...pairs.nian].map((item) => ({
      kind: item.kind,
      upper: item.upper,
      lower: item.lower,
      upperChar: item.upperChar,
      lowerChar: item.lowerChar,
      result: item.result,
      detail: item.detail,
    })),
    issues: issueRows(ao),
    yun: yunCall ? yunView(yunCall.result) : null,
  };
}

/**
 * 拗字进朱色，救字只记位置，不标成拗。
 * 三平调的句尾三字都算拗。
 * @param {object} ao
 */
function aoMarks(ao) {
  const aoSet = new Set();
  const jiuSet = new Set();

  for (const item of ao.violations) {
    if (!item.position) continue;
    aoSet.add(`${item.line}:${item.position}`);
    if (item.kind === "三平调") {
      aoSet.add(`${item.line}:${item.position + 1}`);
      aoSet.add(`${item.line}:${item.position + 2}`);
    }
    if (item.kind === "犯孤平") {
      const length = hanzi(ao.lines[item.line - 1] || "").length;
      aoSet.add(`${item.line}:${length >= 7 ? 5 : 3}`);
    }
  }
  for (const item of ao.rescues) {
    const [aoPos, jiuPos] = item.positions || [];
    if (aoPos) aoSet.add(`${item.line}:${aoPos}`);
    if (jiuPos) jiuSet.add(`${item.line}:${jiuPos}`);
  }
  return { ao: aoSet, jiu: jiuSet };
}

/**
 * @param {object} ao
 */
function issueRows(ao) {
  const rows = [];
  for (const item of ao.violations) {
    rows.push({
      line: item.line,
      position: item.position || "",
      kind: item.kind,
      detail: item.detail,
      fault: item.kind !== "非近体句",
    });
  }
  for (const item of ao.rescues) {
    rows.push({
      line: item.line,
      position: (item.positions || []).join("、"),
      kind: item.kind,
      detail: item.detail,
      fault: false,
    });
  }
  rows.sort((a, b) => a.line - b.line || String(a.position).localeCompare(String(b.position), "zh"));
  return rows;
}

/**
 * @param {object} result
 */
function charRow(result) {
  const readings = Array.isArray(result.readings) ? result.readings : [];
  const tones = [...new Set(readings.map((item) => item.tone).filter(Boolean))];
  return {
    character: result.character || "",
    found: Boolean(result.found),
    label: result.found ? result.tone || tones.join("/") || "未" : "未收",
    detail: result.detail || readings.map((item) => `${item.tone} · ${item.rhyme}`).join("；"),
  };
}

/**
 * @param {object} result
 */
function yunView(result) {
  const rhyme = Array.isArray(result.rhyme) ? result.rhyme : [];
  return {
    sameRhyme: result.sameRhyme ?? null,
    rhyme,
    detail: result.detail || "",
    feet: (result.options || []).map((item) => ({
      char: item.char,
      rhymes: item.rhymes || [],
    })),
  };
}

/**
 * @param {string} ch
 */
function toneOf(ch) {
  const readings = lookupChar(ch);
  if (!readings.length) return { label: "未", title: "平水韵未收" };
  const tones = [...new Set(readings.map((item) => item.tone))];
  return {
    label: tones.join("/"),
    title: readings.map((item) => `${item.tone} · ${item.rhyme}`).join("；"),
  };
}

/**
 * @param {string} form
 */
function prettyForm(form) {
  let text = String(form).replace(/^5言/, "五言").replace(/^7言/, "七言");
  text = text.replace("不入韵", "·不入韵");
  text = text.replace(/·不入韵|入韵/g, (part) => (part === "入韵" ? "·入韵" : part));
  return text;
}
