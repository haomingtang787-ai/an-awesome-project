/**
 * 格律与检索工具注册表。
 *
 * 平仄、粘对、拗救、韵脚，以及韵部收字、原诗、典故，都在这里查本地数据。
 * 查不到就写明未收录。ReAct 引擎不包含这些数据。
 */

import { findGroups, lookupChar } from "./lib/pingshui.js";
import { analyzeAoJiu, analyzeNianDui } from "./lib/meter.js";
import { findPoems } from "./lib/poems.js";
import { findAllusions } from "./lib/allusions.js";
import { checkCi } from "./lib/cipu.js";

/** @type {Map<string, { definition: object, handler: (args: object) => Promise<unknown> }>} */
const registry = new Map();

/**
 * 按 OpenAI function calling 的格式登记一个工具。
 * @param {object} definition tools 数组中的一项，type 固定为 function
 * @param {(args: object) => Promise<unknown>} handler
 */
export function registerTool(definition, handler) {
  const name = definition?.function?.name;
  if (!name) throw new Error("工具定义缺少 function.name。");
  if (registry.has(name)) throw new Error(`工具重复注册：${name}`);
  if (typeof handler !== "function") throw new Error(`工具 ${name} 缺少 handler。`);
  registry.set(name, { definition, handler });
}

/**
 * 取出全部工具定义，顺序与注册顺序一致，可直接放进聊天请求的 tools 字段。
 * @returns {object[]}
 */
export function getToolDefinitions() {
  return [...registry.values()].map((item) => item.definition);
}

/**
 * 按名称执行工具。返回值统一变成字符串，方便写入 role=tool 的消息。
 * @param {string} name
 * @param {object} args
 * @returns {Promise<string>}
 */
export async function executeTool(name, args) {
  const entry = registry.get(name);
  if (!entry) throw new Error(`未注册的工具：${name}`);

  const result = await entry.handler(args ?? {});
  if (typeof result === "string") return result;

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    throw new Error(`工具 ${name} 的结果无法序列化。`);
  }
}

/**
 * 按换行和句读把一段文字切开。只整理输入，不判断格律。
 * 逗号、句号在近体诗里通常就是一句的边界。
 * @param {unknown} text
 * @returns {string[]}
 */
function splitPoem(text) {
  return String(text)
    .split(/[\r\n]+|[，。！？；]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * 把参数收成诗句数组。模型有时会传整段字符串，这里只做切分，不判断格律。
 * @param {unknown} value
 * @returns {string[]}
 */
function asLines(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => splitPoem(item));
  }
  if (typeof value === "string") return splitPoem(value);
  return [];
}

/**
 * 把韵脚参数收成单字列表。
 * @param {unknown} value
 * @returns {string[]}
 */
function asChars(value) {
  const source = Array.isArray(value) ? value.map((item) => String(item)).join("") : String(value ?? "");
  return [...source.replace(/[\s，。、；：？！,.!?]/g, "")];
}

/**
 * 查询单个汉字的平水韵平仄，结果应为「平」「仄」或「入」。
 * @param {object} args
 * @param {string} args.character
 */
async function getPingZe(args) {
  const character = String(args.character ?? "")
    .replace(/[\s，。、；：？！,.!?「」『』“”‘’（）()]/g, "");
  if ([...character].length !== 1) {
    throw new Error("getPingZe 一次只能查询一个汉字。");
  }

  const readings = lookupChar(character);
  if (!readings.length) {
    return {
      character,
      found: false,
      tone: null,
      readings: [],
      detail: "平水韵未收此字，不得编造平仄。",
    };
  }
  const tones = [...new Set(readings.map((item) => item.tone))];
  return {
    character,
    found: true,
    tone: tones.length === 1 ? tones[0] : null,
    readings,
  };
}

/**
 * 校验律诗或绝句的粘对。
 * @param {object} args
 * @param {string[]} args.lines
 */
async function checkNianDui(args) {
  const lines = asLines(args.lines);
  if (lines.length < 2) {
    throw new Error("checkNianDui 至少需要按顺序给出两句诗。");
  }
  return analyzeNianDui(lines);
}

/**
 * 识别拗句与拗救。
 * @param {object} args
 * @param {string[]} args.lines
 */
async function findAoJiu(args) {
  const lines = asLines(args.lines);
  if (lines.length < 1) {
    throw new Error("findAoJiu 至少需要一句诗。");
  }
  return analyzeAoJiu(lines);
}

/**
 * 校验若干韵脚字是否同属一个平水韵韵部。
 * @param {object} args
 * @param {string[]} args.rhymeChars
 */
async function checkYun(args) {
  const rhymeChars = asChars(args.rhymeChars);
  if (rhymeChars.length < 2) {
    throw new Error("checkYun 至少需要两个韵脚字。");
  }

  const options = rhymeChars.map((ch) => ({
    char: ch,
    rhymes: lookupChar(ch).map((item) => item.rhyme),
  }));
  const unknown = options.filter((item) => item.rhymes.length === 0).map((item) => item.char);
  if (unknown.length) {
    return {
      rhymeChars,
      sameRhyme: null,
      rhyme: null,
      options,
      detail: `「${unknown.join("、")}」平水韵未收，不得编造韵部。`,
    };
  }

  let common = new Set(options[0].rhymes);
  for (const item of options.slice(1)) {
    common = new Set([...common].filter((rhyme) => item.rhymes.includes(rhyme)));
  }
  const rhyme = [...common];
  return {
    rhymeChars,
    sameRhyme: rhyme.length > 0,
    rhyme: rhyme.length ? rhyme : null,
    options,
    detail: rhyme.length
      ? `可以同入：${rhyme.join("、")}。`
      : "这些字没有共同的平水韵韵部。邻韵不算同部。",
  };
}

/**
 * 按韵部名称返回该韵部收录的全部字。
 * @param {object} args
 * @param {string} args.rhymeName
 */
async function getRhythmBook(args) {
  const rhymeName = String(args.rhymeName ?? "").trim();
  if (!rhymeName) {
    throw new Error("getRhythmBook 需要韵部名称。");
  }

  const groups = findGroups(rhymeName);
  if (!groups.length) {
    return {
      rhymeName,
      found: false,
      groups: [],
      detail: "韵书没有这个韵部，不得编造收字。这部字表不含上声三讲。",
    };
  }
  return {
    rhymeName,
    found: true,
    groups: groups.map((group) => ({
      id: group.id,
      tone: group.tone,
      count: [...group.chars].length,
      characters: group.chars,
    })),
  };
}

/**
 * 按作者与诗题返回原诗正文。
 * @param {object} args
 * @param {string} args.author
 * @param {string} args.title
 */
async function getPoemOriginal(args) {
  const author = String(args.author ?? "").trim();
  const title = String(args.title ?? "").trim();
  if (!author || !title) {
    throw new Error("getPoemOriginal 需要同时提供作者和诗题。");
  }
  return findPoems(author, title);
}

/**
 * 按典故名称或诗句关键词查询出处与释义。
 * @param {object} args
 * @param {string} args.keyword
 */
async function getAllusion(args) {
  const keyword = String(args.keyword ?? "").trim();
  if (!keyword) {
    throw new Error("getAllusion 需要典故名称或诗句关键词。");
  }
  return findAllusions(keyword);
}

registerTool(
  {
    type: "function",
    function: {
      name: "getPingZe",
      description: "查询单个汉字在平水韵中的平仄。多音多调会全部返回；只有一种声调时 tone 为「平」「仄」或「入」。仅在用户单独询问某字平仄，或终检时确需确认一两个多音字时调用。作诗填词与润色不要逐字调用；整篇核查请用 checkNianDui、findAoJiu 或 checkCiPu。未收录则不得编造。",
      parameters: {
        type: "object",
        properties: {
          character: {
            type: "string",
            description: "要查询的一个汉字",
          },
        },
        required: ["character"],
      },
    },
  },
  getPingZe,
);

registerTool(
  {
    type: "function",
    function: {
      name: "checkNianDui",
      description: "校验近体诗相邻诗句是否符合粘对。对：一联之内两句第二字平仄相反；粘：下一联出句与上一联对句第二字平仄相同。入声作仄。用于整篇检查与每轮改后复核：请按诵读顺序一次传入当前全篇，不要带诗题。陪用户改时先小改原句，一处确实救不回来再整句替换；不要为迁就格律逐字试改，也不要擅自重写全诗。未收录的字不得补判。",
      parameters: {
        type: "object",
        properties: {
          lines: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            description: "按顺序排列的诗句",
          },
        },
        required: ["lines"],
      },
    },
  },
  checkNianDui,
);

registerTool(
  {
    type: "function",
    function: {
      name: "findAoJiu",
      description: "识别近体诗中的拗句与拗救，包括三拗四救、孤平拗救和三平调。用户要求核查拗救，或整篇检查与改后复核时，把当前全篇按句传入。出律时先试小改原句，一句确实救不回来再整句替换；不要只换一个字交差，也不要擅自重写全诗。未收录的字不得补判。",
      parameters: {
        type: "object",
        properties: {
          lines: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description: "按顺序排列的诗句",
          },
        },
        required: ["lines"],
      },
    },
  },
  findAoJiu,
);

registerTool(
  {
    type: "function",
    function: {
      name: "checkYun",
      description: "校验若干韵脚字是否属于同一个平水韵韵部。按出现顺序传入韵脚。多音字会先求各字韵部的交集，不要先假定一个读音。用于整篇检查与改后复核，或用户单纯问韵脚；陪改时不要一边逐字凑韵一边调用。未收录则不得编造韵部。",
      parameters: {
        type: "object",
        properties: {
          rhymeChars: {
            type: "array",
            items: { type: "string" },
            minItems: 2,
            description: "韵脚字列表",
          },
        },
        required: ["rhymeChars"],
      },
    },
  },
  checkYun,
);

registerTool(
  {
    type: "function",
    function: {
      name: "getRhythmBook",
      description: "输入平水韵韵部名称，返回该韵部收录的全部字。用户明确询问某韵部有哪些字时必须调用；创作选韵不必整表拉取。未收录不得编造收字。",
      parameters: {
        type: "object",
        properties: {
          rhymeName: {
            type: "string",
            description: "韵部名称，如「上平一东」「七阳」",
          },
        },
        required: ["rhymeName"],
      },
    },
  },
  getRhythmBook,
);

registerTool(
  {
    type: "function",
    function: {
      name: "getPoemOriginal",
      description: "按作者和诗题返回原诗正文。收录全唐诗、全宋诗、宋词、诗经、楚辞。用户核对或索取原文时必须调用。未收录不得凭记忆编造正文。",
      parameters: {
        type: "object",
        properties: {
          author: {
            type: "string",
            description: "作者姓名，如「杜甫」",
          },
          title: {
            type: "string",
            description: "诗题，如「春望」",
          },
        },
        required: ["author", "title"],
      },
    },
  },
  getPoemOriginal,
);

registerTool(
  {
    type: "function",
    function: {
      name: "getAllusion",
      description: "按典故名称或诗句关键词查询典故出处与释义。用户追问典故出处或含义时必须调用。未收录不得编造典故。",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "典故名称，或含典故的诗句关键词",
          },
        },
        required: ["keyword"],
      },
    },
  },
  getAllusion,
);

registerTool(
  {
    type: "function",
    function: {
      name: "checkCiPu",
      description: "按钦定词谱或龙榆生《唐宋词格律》核对一首词的平仄。声调用平水韵，入声作仄；谱中「中」为可平可仄。用于整词检查与改后复核。用户核对词律时必须调用；作词或陪改时先把当前全词改定，再传全词复核。未收录的词牌或字不得编造。未指定词谱时不要传 book，由工具自选字数相符的一格。",
      parameters: {
        type: "object",
        properties: {
          cipai: {
            type: "string",
            description: "词牌名，如「忆秦娥」「水调歌头」。别名亦可，如「贺新郎」与「金缕曲」。",
          },
          text: {
            type: "string",
            description: "词的正文。可带标点或换行。不要把词牌名算进正文。",
          },
          book: {
            type: "string",
            description: "可选。钦定词谱，或龙榆生。不传则两部里选最相符的一格，字数相同时优先钦定词谱。",
          },
          variant: {
            type: "integer",
            description: "可选。第几格，从 1 起。不传则按字数与句读自选。",
          },
        },
        required: ["cipai", "text"],
      },
    },
  },
  async (args) => checkCi(args),
);
