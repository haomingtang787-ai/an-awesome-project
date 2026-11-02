/**
 * 命令行入口。
 *
 * 启动后在终端等待输入，同一进程内保留多轮对话。
 * 输入 exit 退出。格律、品鉴、闲聊都交给模型自行判断要不要调用工具。
 */

import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { pathToFileURL } from "node:url";
import config, { assertConfig } from "./config.js";
import { ReactAgent, POETRY_SYSTEM_PROMPT } from "./agent.js";
import { executeTool, getToolDefinitions } from "./tools.js";

/** 粘贴的多行如果间隔不超过这段时间，就合成一条消息。手打的下一句不会被并进去。 */
const PASTE_CLUSTER_MS = 100;

/**
 * 等待若干毫秒。
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 从 readline 收集用户输入。
 * 普通回车立即成句；一次粘贴进来的多行诗会合为一条，避免被拆成好几轮对话。
 */
export class LineSession {
  /**
   * @param {readline.Interface} rl
   */
  constructor(rl) {
    this.lines = [];
    this.closed = false;
    this.waiting = null;

    rl.on("line", (line) => {
      this.lines.push({ line, at: Date.now() });
      this.wake();
    });
    rl.on("close", () => {
      this.closed = true;
      this.wake();
    });
  }

  /** 唤醒正在等待下一行的读循环。 */
  wake() {
    if (!this.waiting) return;
    const resolve = this.waiting;
    this.waiting = null;
    resolve();
  }

  /**
   * 直到有新行，或输入流关闭。
   * @returns {Promise<void>}
   */
  async waitForLine() {
    if (this.lines.length > 0 || this.closed) return;
    await new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  /**
   * 读取一条用户消息。流关闭且没有剩余内容时返回 null。
   * @returns {Promise<string | null>}
   */
  async readMessage() {
    await this.waitForLine();
    if (this.lines.length === 0) return null;

    const first = this.lines.shift();
    await delay(PASTE_CLUSTER_MS);

    const bundled = [first];
    while (this.lines.length > 0 && this.lines[0].at - first.at <= PASTE_CLUSTER_MS) {
      bundled.push(this.lines.shift());
    }

    return bundled
      .map((item) => item.line)
      .join("\n")
      .replace(/^\uFEFF/, "")
      .trim();
  }
}

/**
 * 判断用户是否要退出。只认整句 exit，避免诗句里偶然出现这个词。
 * @param {string} text
 * @returns {boolean}
 */
function isExit(text) {
  return text.trim().toLowerCase() === "exit";
}

/**
 * 把工具参数收成一行简短说明，方便在终端里看到这一步查了什么。
 * @param {string} name
 * @param {object} args
 * @returns {string}
 */
function describeCall(name, args) {
  if (typeof args.character === "string" && args.character) {
    return `${name} 「${args.character}」`;
  }
  if (Array.isArray(args.rhymeChars)) {
    return `${name} 「${args.rhymeChars.join("、")}」`;
  }
  if (Array.isArray(args.lines)) {
    return `${name}（${args.lines.length} 句）`;
  }
  return name;
}

/**
 * 思考文字过长时截断，避免把工具轮次的草稿刷满终端。
 * @param {string} text
 * @returns {string}
 */
function briefThought(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 180) return oneLine;
  return `${oneLine.slice(0, 180)}…`;
}

/**
 * 启动交互。配置不完整时直接退出，不进入对话。
 * @returns {Promise<void>}
 */
export async function main() {
  try {
    assertConfig(config);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  const agent = new ReactAgent({
    config,
    systemPrompt: POETRY_SYSTEM_PROMPT,
    tools: {
      definitions: getToolDefinitions(),
      execute: executeTool,
    },
  });

  /** 跨轮次保留。工具观测也留在里面，方便接着追问。退出进程后即消失。 */
  const history = [];
  let placeholderWarned = false;
  const interactive = Boolean(stdin.isTTY);

  const rl = readline.createInterface({
    input: stdin,
    output: stdout,
    terminal: interactive,
  });
  rl.setPrompt("你：");
  const session = new LineSession(rl);

  rl.on("SIGINT", () => {
    console.log("\n已退出。");
    process.exit(0);
  });

  if (interactive) {
    console.log("古典诗词助手");
    console.log("可做格律校验、诗词品鉴，也可闲谈诗人、典故与格律常识。");
    console.log("本会话会记住上文。诗若分行，请一次粘贴。输入 exit 退出。");
    console.log("格律、原诗和典故都查本地韵书与诗集。词律另有钦定词谱和龙榆生《唐宋词格律》。查无此条时会说明未收录。");
    console.log();
    rl.prompt();
  }

  while (true) {
    const text = await session.readMessage();
    if (text == null) {
      console.log("\n已退出。");
      break;
    }
    if (!text) {
      if (interactive) rl.prompt();
      continue;
    }
    if (isExit(text)) {
      console.log("已退出。");
      break;
    }
    if (text.length > 8000) {
      console.error("\n这段文字太长了，请分成几次发送。\n");
      if (interactive) rl.prompt();
      continue;
    }

    try {
      const answer = await agent.run(history, text, {
        onRound(round) {
          console.log(`\n第 ${round} 轮`);
        },
        onThought(thought) {
          console.log(`思：${briefThought(thought)}`);
        },
        onToolCall(name, args) {
          console.log(`  · ${describeCall(name, args)}`);
        },
        onToolResult(_name, content) {
          if (!placeholderWarned && content.includes('"status": "placeholder"')) {
            placeholderWarned = true;
            console.error("（当前格律工具是占位实现，不能当作真实平仄或韵部）");
          }
        },
        onToolError(name, message) {
          console.error(`  · ${name} 未能完成：${message}`);
        },
        onMaxIterations(max) {
          console.error(`\n已达最大循环轮次（${max}），改为直接作答。`);
        },
      });

      console.log("\n答：");
      console.log(answer);
      console.log();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n出错：${message}\n`);
    }

    if (interactive && !session.closed) rl.prompt();
  }

  rl.close();
}

/**
 * 只有直接执行 cli.js 时才进入对话，被别的文件引入时不自动启动。
 */
function isDirectExecution() {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
