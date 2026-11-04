/**
 * 通用 ReAct 核心引擎。
 *
 * 循环是：思考 -> 调用工具 -> 拿到观测 -> 再思考，直到模型直接作答，或到达最大轮次。
 * 本文件不包含平仄、韵部等业务数据，也不绑定某一种工具实现。
 * 诗词系统提示词只是一份预设，换别的 Agent 时传入自己的 systemPrompt 与 tools 即可。
 */

import { requestJson } from "./lib/http.js";

/** 单次模型请求的超时时间。这不是密钥类配置，因此不放进 config.js。 */
const REQUEST_TIMEOUT_MS = 120000;

/**
 * 古典诗词助手的系统提示词。
 * 复用本引擎做别的 Agent 时不必使用这份提示词。
 */
export const POETRY_SYSTEM_PROMPT = `你是一名古典诗词助手。用户多半是拿自己的稿子来：先查格律，再一起推敲，逐处改好，最后定稿。你要把格律查准，把建议讲实，陪用户改，而不是替他另写一首。

一、任务识别
1. 格律检查与陪改：用户的常态。先查，再议，再改，最后复核。
2. 润色：用户明确请你改稿。仍以原稿为本，能小改不大改。
3. 创作：用户明确要求新作时才写。
4. 检索：查韵部收字、原诗正文、典故出处。
5. 品鉴闲聊：赏析、评价、聊诗人、聊意境。
同一请求兼有几项时，按“先查格律，再谈改法，最后复核”的顺序做。

二、格律检查（首要）
1. 平仄、粘对、拗救、韵脚、词谱一律调用工具，不得编造；工具写明未收录或未知时，如实说明。
2. 近体诗用 checkNianDui、findAoJiu、checkYun，一次传全篇；词用 checkCiPu。不要逐字调用 getPingZe，除非用户只问某字，或确需确认一两个多音字。
3. 报告要具体：哪一句、哪一字、合不合、为什么。用平实的话解释，术语第一次出现时顺带一句白话。拗救的名目（三拗四救、特拗、孤平拗救等）拿不准就不要硬套，直接说“第几字该平用了仄，怎样改可合谱”。
4. 检查阶段只诊断，不擅自改诗。先让用户知道问题在哪，再谈怎么改。

三、陪用户改（核心）
1. 先问方向：是保原意小改到合律，还是愿意动句子换更好的写法。用户没说，就按“保原意、尽量小改”来做。
2. 建议分两层：格律硬伤先改；文学上的软建议另列，标明可改可不改。
3. 每处问题给一到两个具体改法，写清代价：换了哪个字、平仄怎么变、意思和声情受什么影响。不要只丢一句“建议改写”。
4. 优先在原句上换字、换语序；一句确实救不回来，才提出整句替代，并把原句保留在对照里。
5. 不替用户整首重写，不把用户的句子换成“更像古诗”的套话，不擅自删他的核心意象。改动要让用户看得见、选得了。
6. 一次改一处或一联，改完复述全篇，让用户看见前后变化；用户认可后再进入下一处。
7. 每轮改定后调用格律工具复核，直到全篇合律，或用户决定保留某一处拗句。
8. 某句文学上弱但格律无误时，可以指出（意浅、句直、凑韵、合掌、上下不接），并给至少一个具体的替换字或句，说明换后意象与声情的变化；同时标明这是建议，不是格律错误，取舍由用户定。

四、润色与创作
1. 润色是“陪改”的加强版：先通读，指出最值得动的两三处，给出改前/改后对照与理由，再复核格律。
2. 用户明确要新作时才创作：先定情、境、体，谋篇炼字，成篇后终检。
3. 不必摆出诗坛前辈的架子。不堆“意境深远”“耐人寻味”这类空评；建议要落到字句，宁少而实。

五、检索
查韵部收字用 getRhythmBook；核对或索取原诗用 getPoemOriginal；查典故用 getAllusion。工具写明未收录或未知时，如实说明，不得凭记忆补写。

六、品鉴与闲聊
赏析、评价、聊诗人、聊意境，不需要上述数据时直接作答，不强行调用工具。评价要落到具体字句。

七、工具与收束
1. 工具调用少而准：整篇格律检查通常三两次即可（粘对、拗救、韵脚，或一次词谱），不要反复逐字试改、反复全篇重查。
2. 一轮结束时说清：现在的问题、建议的下一步；已经改定的，给完整定稿和终检结果。
3. 文风平实、清楚、克制，不装腔，也不为简洁牺牲具体。`;

/**
 * 把模型返回的 content 收成普通字符串。
 * 兼容只返回字符串的接口，以及把正文拆成 text 片段的接口。
 * @param {unknown} content
 * @returns {string}
 */
function normalizeContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return String(content);
}

/**
 * 整理成 OpenAI 兼容的 tool_calls 结构。arguments 统一为字符串。
 * @param {unknown} toolCalls
 * @returns {Array<{ id: string, type: "function", function: { name: string, arguments: string } }>}
 */
function normalizeToolCalls(toolCalls) {
  if (!Array.isArray(toolCalls)) return [];

  return toolCalls.map((call, index) => {
    const fn = call && typeof call === "object" ? call.function || {} : {};
    let args = fn.arguments;
    if (args == null) {
      args = "{}";
    } else if (typeof args !== "string") {
      args = JSON.stringify(args);
    }

    const id = call && typeof call.id === "string" && call.id
      ? call.id
      : `call_${index}_${Date.now()}`;

    return {
      id,
      type: "function",
      function: {
        name: typeof fn.name === "string" ? fn.name : "",
        arguments: args,
      },
    };
  });
}

/**
 * 把网络错误与 HTTP 错误转成可直接打印的中文说明。
 * 不读取 error.config，避免把 Authorization 里的密钥打进终端。
 * @param {unknown} error
 * @returns {string}
 */
export function formatRequestError(error) {
  if (error && typeof error === "object" && Number.isInteger(error.status)) {
    const status = error.status;
    const data = error.data;
    let detail = "";
    if (typeof data === "string") {
      detail = data;
    } else if (data && typeof data === "object" && data.error && typeof data.error.message === "string") {
      detail = data.error.message;
    } else if (data != null) {
      try {
        detail = JSON.stringify(data);
      } catch {
        detail = "";
      }
    }
    if (detail.length > 500) detail = `${detail.slice(0, 500)}…`;

    if (status === 401 || status === 403) {
      return `模型服务拒绝了密钥（HTTP ${status}）。请检查接口设置里的密钥。${detail ? ` ${detail}` : ""}`;
    }
    if (status === 404) {
      return `模型服务地址或模型名可能不正确（HTTP 404）。接口地址应类似 https://api.deepseek.com，不要带上 /chat/completions。${detail ? ` ${detail}` : ""}`;
    }
    if (status === 429) {
      return `请求被限流或额度不足（HTTP 429）。${detail ? ` ${detail}` : ""}`;
    }
    return `模型服务返回错误（HTTP ${status}）。${detail}`.trim();
  }

  if (error && (error.name === "TimeoutError" || error.code === "ETIMEDOUT" || error.code === "ECONNABORTED")) {
    return "等待模型响应超时。请检查网络，或稍后再试。";
  }
  if (error && (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED" || error.code === "EAI_AGAIN")) {
    return `无法连接模型服务（${error.code}）。请检查接口地址与当前网络。`;
  }
  if (error instanceof Error) return error.message;
  return "请求模型时发生未知错误";
}

/**
 * @param {object} payload
 * @param {{ apiKey: string, baseUrl: string }} runtimeConfig
 * @param {AbortSignal} [signal]
 * @returns {Promise<object>}
 */
async function defaultTransport(payload, runtimeConfig, signal) {
  const base = String(runtimeConfig.baseUrl || "").replace(/\/+$/, "");
  const url = `${base}/chat/completions`;

  try {
    const { status, data } = await requestJson(url, {
      method: "POST",
      body: payload,
      signal,
      timeoutMs: REQUEST_TIMEOUT_MS,
      headers: {
        Authorization: `Bearer ${runtimeConfig.apiKey}`,
      },
    });
    if (status < 200 || status >= 300) {
      throw Object.assign(new Error(`HTTP ${status}`), { status, data });
    }
    return data;
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) {
      throw Object.assign(new Error("请求已取消。"), { name: "AbortError" });
    }
    throw new Error(formatRequestError(error));
  }
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isAbortError(error) {
  return Boolean(
    error
    && (error.name === "AbortError"
      || error.code === "ERR_CANCELED"
      || (typeof error.message === "string" && /aborted|取消|canceled/i.test(error.message))),
  );
}

/**
 * 通用 ReAct Agent。
 * 对话历史由调用方持有并传入，引擎会把本轮的用户消息、工具观测和最终回答追加进去。
 */
export class ReactAgent {
  /**
   * @param {object} options
   * @param {{ apiKey: string, baseUrl: string, model: string, maxIterations: number }} options.config
   * @param {string} options.systemPrompt
   * @param {{ definitions?: object[], execute?: (name: string, args: object) => Promise<string> }} [options.tools]
   * @param {(payload: object, runtimeConfig: object) => Promise<object>} [options.transport]
   *        替换默认的 HTTP 请求。测试或私有网关可以使用。
   */
  constructor({ config, systemPrompt, tools, transport } = {}) {
    if (!config) throw new Error("缺少 config。");
    if (!systemPrompt || !String(systemPrompt).trim()) {
      throw new Error("systemPrompt 不能为空。");
    }
    if (!Number.isInteger(config.maxIterations) || config.maxIterations < 1) {
      throw new Error("maxIterations 须为大于 0 的整数。");
    }

    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl;
    this.model = config.model;
    this.maxIterations = config.maxIterations;
    this.systemPrompt = String(systemPrompt);
    this.definitions = Array.isArray(tools?.definitions) ? tools.definitions : [];
    this.execute = typeof tools?.execute === "function"
      ? tools.execute
      : async (name) => {
        throw new Error(`未配置工具执行器，无法调用 ${name}`);
      };
    this.transport = transport || defaultTransport;
  }

  /**
   * 保证历史以系统提示词开头。若调用方已经放入系统消息，则保持原样。
   * @param {Array<object>} history
   */
  ensureSystem(history) {
    if (history.length === 0 || history[0].role !== "system") {
      history.unshift({ role: "system", content: this.systemPrompt });
    }
  }

  /**
   * 跑完一轮用户输入。成功时返回最终回答，并把本轮消息写入 history。
   * 请求失败时会撤回本轮追加的内容，避免留下没有回应的 tool_calls。
   *
   * @param {Array<object>} history
   * @param {string} userText
   * @param {object} [hooks]
   * @param {(round: number) => void} [hooks.onRound]
   * @param {(text: string) => void} [hooks.onThought]
   * @param {(name: string, args: object) => void} [hooks.onToolCall]
   * @param {(name: string, content: string) => void} [hooks.onToolResult]
   * @param {(name: string, message: string) => void} [hooks.onToolError]
   * @param {(max: number) => void} [hooks.onMaxIterations]
   * @param {AbortSignal} [hooks.signal]
   * @returns {Promise<string>}
   */
  async run(history, userText, hooks = {}) {
    if (!Array.isArray(history)) throw new Error("history 必须是数组。");

    const text = String(userText ?? "").trim();
    if (!text) throw new Error("用户输入为空。");
    if (hooks.signal?.aborted) throw new DOMException("请求已取消。", "AbortError");

    this.ensureSystem(history);
    const start = history.length;
    history.push({ role: "user", content: text });

    try {
      return await this.reactLoop(history, hooks);
    } catch (error) {
      history.splice(start);
      throw error;
    }
  }

  /**
   * ReAct 主循环。maxIterations 只限制“还可以调用工具”的请求次数。
   * 触及上限后，再发一次不附带工具的请求，让模型根据已有观测作答。
   * @param {Array<object>} history
   * @param {object} hooks
   * @returns {Promise<string>}
   */
  async reactLoop(history, hooks) {
    for (let round = 1; round <= this.maxIterations; round += 1) {
      throwIfAborted(hooks.signal);
      const message = await this.complete(history, true, hooks.signal);
      const toolCalls = normalizeToolCalls(message.tool_calls);
      const thought = normalizeContent(message.content).trim();

      if (toolCalls.length === 0) {
        if (!thought) throw new Error("模型没有返回可显示的内容。");
        history.push({ role: "assistant", content: thought });
        return thought;
      }

      if (thought) hooks.onThought?.(thought);
      hooks.onRound?.(round);

      const assistantMessage = {
        role: "assistant",
        // 有的兼容网关不接受 null，空字符串更稳妥。
        content: thought || "",
        tool_calls: toolCalls,
      };
      history.push(assistantMessage);

      for (const call of toolCalls) {
        throwIfAborted(hooks.signal);
        const observation = await this.observeToolCall(call, hooks);
        history.push({
          role: "tool",
          tool_call_id: call.id,
          content: observation,
        });
      }
    }

    hooks.onMaxIterations?.(this.maxIterations);
    return this.closingAnswer(history, hooks.signal);
  }

  /**
   * 执行一次工具调用，并把成功或失败都变成观测文本。
   * 工具失败不中断循环，方便模型改参数后再试。
   * @param {{ id: string, function: { name: string, arguments: string } }} call
   * @param {object} hooks
   * @returns {Promise<string>}
   */
  async observeToolCall(call, hooks) {
    const name = call.function.name;
    const rawArgs = call.function.arguments;

    if (!name) {
      const message = "工具调用缺少名称。";
      hooks.onToolError?.("（未命名）", message);
      return `工具执行失败：${message}`;
    }

    if (rawArgs.length > 100000) {
      const message = "参数过长，已拒绝执行。";
      hooks.onToolError?.(name, message);
      return `工具执行失败：${message}`;
    }

    let args;
    try {
      args = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch (error) {
      const message = `参数不是合法 JSON：${error instanceof Error ? error.message : String(error)}`;
      hooks.onToolError?.(name, message);
      return `工具执行失败：${message}`;
    }

    if (args == null || typeof args !== "object" || Array.isArray(args)) {
      const message = "参数必须是 JSON 对象。";
      hooks.onToolError?.(name, message);
      return `工具执行失败：${message}`;
    }

    hooks.onToolCall?.(name, args);

    try {
      const result = await this.execute(name, args);
      const content = typeof result === "string" ? result : JSON.stringify(result);
      hooks.onToolResult?.(name, content);
      return content;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      hooks.onToolError?.(name, message);
      return `工具执行失败：${message}`;
    }
  }

  /**
   * 不再提供工具，请模型交出最终回答。
   * 这一步失败时仍写入一条助手消息，避免历史停在 tool 角色上。
   * @param {Array<object>} history
   * @returns {Promise<string>}
   */
  async closingAnswer(history, signal) {
    const fallback = `已达最大循环轮次（${this.maxIterations}），且未能完成收束作答。请把问题缩小后再问。`;

    try {
      throwIfAborted(signal);
      const message = await this.complete(history, false, signal);
      const answer = normalizeContent(message.content).trim();
      if (!answer) throw new Error("模型没有返回可显示的内容。");
      history.push({ role: "assistant", content: answer });
      return answer;
    } catch (error) {
      if (isAbortError(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      const answer = `${fallback}（${reason}）`;
      history.push({ role: "assistant", content: answer });
      return answer;
    }
  }

  /**
   * 调用一次聊天补全接口。
   * @param {Array<object>} history
   * @param {boolean} allowTools
   * @param {AbortSignal} [signal]
   * @returns {Promise<object>}
   */
  async complete(history, allowTools, signal) {
    if (!String(this.apiKey || "").trim()) {
      throw new Error("未配置 apiKey。请在页面的「接口设置」里填写。");
    }
    if (!String(this.model || "").trim()) {
      throw new Error("未配置 model。请在页面的「接口设置」里填写支持 function calling 的模型名。");
    }
    if (!String(this.baseUrl || "").trim()) {
      throw new Error("未配置 baseUrl。请在页面的「接口设置」里填写。");
    }
    throwIfAborted(signal);

    const payload = {
      model: this.model,
      messages: JSON.parse(JSON.stringify(history)),
      stream: false,
    };

    if (allowTools && this.definitions.length > 0) {
      payload.tools = this.definitions;
      payload.tool_choice = "auto";
    }

    const data = await this.transport(payload, {
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      model: this.model,
    }, signal);

    const message = data?.choices?.[0]?.message;
    if (!message || typeof message !== "object") {
      throw new Error("模型响应缺少 choices[0].message，无法继续。");
    }
    return message;
  }
}

/**
 * @param {AbortSignal} [signal]
 */
function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("请求已取消。", "AbortError");
}
