/**
 * 格律与检索工具注册表。
 *
 * 平仄、粘对、拗救、韵脚，以及韵部收字、原诗、典故，都在这里查本地数据。
 * 查不到就写明未收录。ReAct 引擎不包含这些数据。
 */

import { findGroups, groupsOfTone, lookupChar } from "./lib/pingshui.js";
import { checkCiYun as verifyCiYun, ciGroupsOfTone, findCiGroups, lookupCiChar } from "./lib/cilin.js";
import { analyzeAoJiu, analyzeNianDui } from "./lib/meter.js";
import { findPoems } from "./lib/poems.js";
import { findAllusions } from "./lib/allusions.js";
import { checkCi } from "./lib/cipu.js";
import { searchPoemLines, searchPoemMeaning } from "./lib/poem-search.js";

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
 * 查询单个汉字的平水韵平仄，并附《词林正韵》韵部。
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
  const ciReadings = lookupCiChar(character);
  const ciYun = ciReadings.map((item) => ({
    rhyme: item.rhyme,
    tone: item.tone,
    section: item.section,
  }));

  if (!readings.length) {
    const ciNote = ciYun.length
      ? `《词林正韵》列${ciYun.map((item) => `${item.rhyme}（${item.section}）`).join("、")}。`
      : "《词林正韵》亦未收。";
    return {
      character,
      found: false,
      tone: null,
      readings: [],
      ciYun,
      detail: `平水韵未收此字，不得编造平仄。${ciNote}`,
    };
  }
  const tones = [...new Set(readings.map((item) => item.tone))];
  return {
    character,
    found: true,
    tone: tones.length === 1 ? tones[0] : null,
    readings,
    ciYun,
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
 * 按韵部名或声调返回韵书收字。
 *
 * book 为「平水韵」时按 106 部查，上声、去声、入声都是仄声韵；
 * book 为「词林正韵」时按十九部查，每部分平声、仄声、入声。
 * 声调名（平声、仄声、上声、去声、入声）只列韵目与字数，不整表铺开。
 *
 * @param {object} args
 * @param {string} args.rhymeName
 * @param {string} [args.book]
 */
async function getRhythmBook(args) {
  const rhymeName = String(args.rhymeName ?? "").trim();
  if (!rhymeName) {
    throw new Error("getRhythmBook 需要韵部名称或声调。");
  }

  const bookText = String(args.book ?? "").trim();
  const hint = bookText || rhymeName;
  const wantsCi = /词林|词韵/.test(hint);
  const wantsPing = /平水/.test(hint);
  if (bookText && !wantsCi && !wantsPing) {
    return {
      rhymeName,
      book: bookText,
      found: false,
      groups: [],
      detail: "只收《平水韵》与《词林正韵》两部韵书。book 填「平水韵」「词林正韵」或留空。",
    };
  }

  if (wantsCi) {
    const byName = findCiGroups(rhymeName);
    const byTone = byName.length ? [] : ciGroupsOfTone(rhymeName);
    if (!byName.length && !byTone.length) {
      return {
        rhymeName,
        book: "词林正韵",
        found: false,
        groups: [],
        detail: "《词林正韵》没有这个韵部。可填「第一部」到「第十九部」，或填「平声」「仄声」「入声」。",
      };
    }
    const groups = byName.length ? byName : byTone;
    const summary = groups.length > 6;
    const mergedTone = !byName.length && /上声|去声/.test(rhymeName);
    return {
      rhymeName,
      book: "词林正韵",
      found: true,
      summary,
      groups: groups.map((group) => ({
        id: group.id,
        section: group.section,
        tone: group.tone,
        count: [...group.chars].length,
        ...(summary ? {} : { characters: group.chars }),
      })),
      detail: mergedTone
        ? `《词林正韵》上声、去声合为仄声，共 ${groups.length} 组${summary ? "，只列韵目与字数" : ""}。`
        : summary
          ? `共 ${groups.length} 组，只列韵目与字数；要收字请填具体韵部，如「第一部」。`
          : "同部平声、仄声、入声各自可通押；平仄混押须看词牌。",
    };
  }

  const byName = findGroups(rhymeName);
  const byTone = byName.length ? [] : groupsOfTone(rhymeName);
  if (!byName.length && !byTone.length) {
    return {
      rhymeName,
      book: "平水韵",
      found: false,
      groups: [],
      detail: "平水韵没有这个韵部。可填「上平一东」「下平七阳」「上声一董」「去声一送」「入声一屋」，或填声调「平声」「仄声」「上声」「去声」「入声」。",
    };
  }
  const groups = byName.length ? byName : byTone;
  const summary = groups.length > 6;
  return {
    rhymeName,
    book: "平水韵",
    found: true,
    summary,
    groups: groups.map((group) => ({
      id: group.id,
      section: group.section,
      tone: group.tone,
      count: [...group.chars].length,
      ...(summary ? {} : { characters: group.chars }),
    })),
    detail: summary
      ? `共 ${groups.length} 部，只列韵目与字数；要收字请填具体韵部，如「上声一董」。`
      : "平水韵上声、去声、入声都属仄声；作近体诗韵脚只用平声。",
  };
}

/**
 * 校验若干韵脚字是否同属一个《词林正韵》韵部。
 * @param {object} args
 * @param {string[]} args.rhymeChars
 */
async function checkCiYunTool(args) {
  const rhymeChars = asChars(args.rhymeChars);
  if (rhymeChars.length < 2) {
    throw new Error("checkCiYun 至少需要两个韵脚字。");
  }
  return verifyCiYun(rhymeChars);
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

/**
 * 按字面检索诗句。
 * @param {object} args
 */
async function searchLines(args) {
  return searchPoemLines(args);
}

/**
 * 按主题意思近似检索诗句。
 * @param {object} args
 */
async function searchMeaning(args) {
  return searchPoemMeaning(args);
}

registerTool(
  {
    type: "function",
    function: {
      name: "getPingZe",
      description: "查询单个汉字在平水韵中的平仄，并附《词林正韵》所属韵部。多音多调会全部返回；只有一种声调时 tone 为「平」「仄」或「入」。仅在用户单独询问某字平仄，或终检时确需确认一两个多音字时调用。作诗填词与润色不要逐字调用；整篇核查请用 checkNianDui、findAoJiu、checkCiPu 或 checkCiYun。未收录则不得编造。",
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
      description: "校验若干韵脚字是否属于同一个平水韵韵部，用于近体诗。按出现顺序传入韵脚。多音字会先求各字韵部的交集，不要先假定一个读音。填词的韵脚请用 checkCiYun（词林正韵十九部）。用于整篇检查与改后复核，或用户单纯问韵脚；陪改时不要一边逐字凑韵一边调用。未收录则不得编造韵部。",
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
      name: "checkCiYun",
      description: "校验若干韵脚字是否属于同一个《词林正韵》韵部。填词、核对词律时用；作近体诗仍用 checkYun 的平水韵。平声、仄声、入声各自同部可以通押；平仄相杂时只报同部，是否允许转韵要看词牌。多音字会先求交集，不要先假定一个读音。未收录则不得编造韵部。",
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
  checkCiYunTool,
);

registerTool(
  {
    type: "function",
    function: {
      name: "getRhythmBook",
      description: "查韵书韵部与收字。book 留空按《平水韵》，填「词林正韵」查词韵。rhymeName 可填具体韵部（平水韵如「上声三讲」「去声四寘」，词林正韵如「第一部」），也可填声调（「平声」「仄声」「上声」「去声」「入声」）只列韵目与字数。用户明确询问某韵部有哪些字或仄声韵有哪些部时必须调用；创作选韵不必整表拉取。未收录不得编造。",
      parameters: {
        type: "object",
        properties: {
          rhymeName: {
            type: "string",
            description: "韵部名称或声调，如「七阳」「上声三讲」「第一部」「仄声」",
          },
          book: {
            type: "string",
            description: "可选。韵书：《平水韵》或《词林正韵》。不传按平水韵。",
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
      name: "searchPoemLines",
      description: "按字面在诗集中检索原句，支持繁简、作者与出处筛选。用户问某句出自谁、某句在哪首、要核对引文，或按关键词找含某字的诗句时调用。query 可传一句，也可传几个关键词（空格或标点分段，多段要求同诗命中）。结果含作者、诗题、出处、上下句。引用必须照抄返回的 line，不得改写；未命中就说明没有，不得凭记忆编造。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "要查的诗句、诗题或关键词",
          },
          author: {
            type: "string",
            description: "可选。限定作者，如「杜甫」",
          },
          source: {
            type: "string",
            description: "可选。限定出处：全唐诗、全宋诗、宋词、诗经、楚辞",
          },
          field: {
            type: "string",
            enum: ["line", "title", "any"],
            description: "可选。查诗句、查诗题，或两者都查。默认 line。",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 40,
            description: "可选。最多返回几条，默认 12",
          },
        },
        required: ["query"],
      },
    },
  },
  searchLines,
);

registerTool(
  {
    type: "function",
    function: {
      name: "searchPoemMeaning",
      description: "按大意、主题或场景近似检索诗句。不是词向量语义模型，而是用主题意象表扩展后按字面重合度排序，只给候选。用户说「找些写离别相思的句子」「意思大概相近的」「写秋天孤独的」时调用。结果带分数与命中意象；引用前宜用 searchPoemLines 核对原句，不得把候选说成确定出处。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "想找的意思、主题或场景，如「送别时的不舍」「秋夜思乡」",
          },
          author: {
            type: "string",
            description: "可选。限定作者",
          },
          source: {
            type: "string",
            description: "可选。限定出处：全唐诗、全宋诗、宋词、诗经、楚辞",
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 20,
            description: "可选。最多返回几条，默认 8",
          },
        },
        required: ["query"],
      },
    },
  },
  searchMeaning,
);

registerTool(
  {
    type: "function",
    function: {
      name: "checkCiPu",
      description: "按钦定词谱或龙榆生《唐宋词格律》核对一首词的平仄。声调用平水韵，入声作仄；谱中「中」为可平可仄。韵脚会并列平水韵与《词林正韵》，词韵同部可通押，平仄混押须看词牌。用于整词检查与改后复核。用户核对词律时必须调用；作词或陪改时先把当前全词改定，再传全词复核。未收录的词牌或字不得编造。未指定词谱时不要传 book，由工具自选字数相符的一格。",
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
