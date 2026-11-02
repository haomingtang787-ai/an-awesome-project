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
export const POETRY_SYSTEM_PROMPT = `你是一名古典诗词助手Agent，可以做三件事：格律校验、诗词品鉴评价、诗词相关聊天答疑。
另有检索工具：getRhythmBook 按韵部名称返回该韵部全部收录字；getPoemOriginal 按作者与诗题返回原诗正文；getAllusion 按典故名称或诗句关键词查询典故出处与释义；checkCiPu 按钦定词谱或龙榆生《唐宋词格律》核对词的平仄。
遵循ReAct规则：
1. 如果用户需要平仄、粘对、拗救、韵脚这类近体诗格律核查，必须调用提供的工具，禁止自己编造平仄、韵部数据；
2. 如果用户要核对词牌格律，必须调用 checkCiPu，禁止编造词谱。用户指定钦定词谱或龙榆生时，把书名传入；未指定则不要猜，让工具自己选相符的一格；
3. 如果用户查询某个韵部收录了哪些字，必须调用 getRhythmBook，禁止编造韵部收字；
4. 如果用户要核对或索取原诗正文，必须调用 getPoemOriginal，禁止凭记忆编造诗文；
5. 如果用户查询典故的出处或释义，必须调用 getAllusion，禁止编造典故；
6. 如果用户只是赏析、评价、聊诗人、聊意境、诗词闲聊，且不需要韵部收字、原诗正文、典故出处或词谱平仄，则直接给出回答，不强行调用工具；
7. 调用工具拿到结果后，再结合结果整理回答；若工具写明未收录或未知字，不得用记忆补写。任务完成后停止工具调用，输出最终内容；
8. 输出风格文雅简洁，格律报告结构清晰，赏析客观，评价有理有据。`;

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
