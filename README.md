# 古典诗词 ReAct Agent

古典诗词助手，主入口是桌面窗口「诗窗」，也可以用命令行。主线是格律：先查准平仄、粘对、拗救、韵脚与词谱，再陪你逐处推敲、改到定稿；也可以润色旧稿、按题新作、查韵部收字、核对原诗、查典故出处，或品鉴闲聊。格律结果是带表格的卡片，拗字用朱色标出；陪改建议与赏析是普通文本。

引擎与诗词数据是分开的：`agent.js` 只负责「思考 → 调用工具 → 观测 → 再思考」，`tools.js` 登记格律与检索工具。以后要做别的 Agent，可以留着这套循环，换掉系统提示词和工具。

不依赖 LangChain、Vercel AI SDK，HTTP 只使用 axios。请求格式是 OpenAI 兼容的 function calling，可对接 GPT、Claude、Grok 等支持工具调用的模型。本程序不连接 QQ，也没有聊天平台适配。

## 你需要准备

- Node.js 18 或更高版本
- 一个 **支持 function calling（工具调用）** 的模型，以及它的 OpenAI 兼容接口地址和密钥

模型若不支持工具调用，格律核查无法进行，接口通常会直接返回错误。

## 安装

```bash
npm install
```

项目里的 `.npmrc` 已指向 npmmirror，Electron 与 electron-builder 二进制也会走国内镜像，避免打包时从 GitHub 慢下或失败。也可自行设置环境变量 `ELECTRON_MIRROR`、`ELECTRON_BUILDER_BINARIES_MIRROR`。

## 配置

在页面左侧打开「接口设置」。DeepSeek 的地址已经填好：`https://api.deepseek.com`。粘贴密钥后点「拉取模型」，从开放平台 `GET /models` 取当前可用名单，再选一个支持工具调用的模型保存。

开发模式下这些值写入项目里的 `config.local.json`（已 git 忽略）。打包成 exe 后，密钥写在系统用户目录，不会进安装包。也可以直接编辑本地配置文件，例如：

```json
{
  "apiKey": "你的密钥",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-flash",
  "maxIterations": 8
}
```

`model` 以你账号在开放平台返回的名单为准，不要沿用已经下线的旧名。

| 字段 | 作用 |
| --- | --- |
| `apiKey` | 接口密钥 |
| `baseUrl` | 接口根地址，例如 `https://api.openai.com/v1`。不要带 `/chat/completions`，程序会自己拼接 |
| `model` | 模型名，必须支持 function calling |
| `maxIterations` | 单轮里最多允许几轮工具调用，防止循环不停、耗尽额度。默认 `8` |

`baseUrl` 的常见写法：

- DeepSeek：`https://api.deepseek.com`
- OpenAI：`https://api.openai.com/v1`
- Grok：`https://api.x.ai/v1`
- 其他兼容服务：填到版本前缀这一级即可

留空保存密钥时，会沿用已经写在 `config.local.json` 里的密钥。

## 启动

先看命令说明：

```bash
npm run help
```

| Command | Meaning |
| --- | --- |
| `npm run desktop` | Open the desktop window (dev) |
| `npm run build:exe` | Build `dist/诗窗.exe` |
| `npm start` | Local web server only |
| `npm run cli` | Terminal chat |
| `npm run build:data` | Rebuild `data/` |

产物在 `dist/诗窗.exe`。双击即可，不必再开浏览器。桌面快捷方式会优先启动这个 exe。

网页调试请用终端打印的**完整地址**打开（带 `?t=` 令牌）。只开 `http://127.0.0.1:8787` 会因缺少令牌无法调用接口。端口被占用时，PowerShell 里写 `$env:PORT=8788; npm start`。若只在本机调试、想省去令牌，可写 `$env:SHICI_DEV_NO_TOKEN=1; npm start`，再用 `http://127.0.0.1:8787` 打开。

配置缺了 `apiKey`、`baseUrl` 或 `model` 时，窗口仍会打开，并提示先去填写；这时发送不会请求模型。

命令行在配置不齐时会直接退出。输入 `exit` 退出。同一进程里的上下文只留在内存中。

## 使用

侧栏是过往对话。主区域里，你的话靠右，助手的赏析和闲聊靠左成段。发送后可点「停止」中断本轮；等待时会显示正在调用的工具。近体诗格律会变成卡片：字下是平水韵声调，拗字为朱色，虚线是用来相救的字，下面有粘对、拗救和韵脚表。词律另有一式，按钦定词谱或龙榆生《唐宋词格律》标出不合谱的字。调用过的工具会在回答下方简短列出。

「新建对话」另开一则，原来的留在侧栏。「清空会话」只去掉正在看的这一则。对话记在本机，清掉应用数据后就没有了。启动时会静默查询 GitHub Releases；若有新版本，主区域上方出现提醒条，也可在侧栏点「检查更新」。点「稍后」会暂时忽略该版本。

分行的诗可以一次贴进输入框。Shift+Enter 换行，Enter 发送。

模型自己决定走哪一种能力：

1. **格律检查与陪改**。近体诗的平仄、粘对、拗救、韵脚，以及词牌的钦定词谱、龙榆生《唐宋词格律》，都必须调用工具，先把问题查准、讲清；再按你的方向逐处提出具体改法，标明平仄与意思的取舍，改一轮复核一轮。不替你整首另写，改动要你看得见、选得了。
2. **润色**。先通读，指出文学上最值得动的两三处，给改前/改后对照与理由，再复核格律。文学建议会标明是建议，不是格律错误。
3. **创作**。用户明确要新作时才写：先定情、境、体，谋篇炼字，成篇后终检。
4. **检索**。查某韵部收字、核对或索取原诗、查询典故出处或释义时，必须调用对应工具，不得凭记忆编造。
5. **诗词品鉴与闲聊**。赏析、评价、聊诗人、聊意境，且不需要韵部收字、原诗正文或典故出处时，直接作答。

示例：

```text
先帮我查这首诗的平仄、粘对、拗救和韵脚，再陪我逐处改到合律，尽量保留原意。
夜雨打窗急，孤灯照客愁。
家书久未至，梦里到江楼。
```

```text
以「秋夜听雨」为题，作一首七言绝句。先立意谋篇，定稿前再用格律工具终检。
```

```text
请核查这首五言的平仄、粘对、拗救和韵脚：白日依山尽，黄河入海流。欲穷千里目，更上一层楼。
```

```text
品评「孤舟蓑笠翁，独钓寒江雪」，从意境和炼字说。
```

```text
近体诗里的入声，在平仄上怎么算？
```

格律卡片由工具结果直接落成，陪改建议由模型结合观测来组织，平实克制。网络错误和工具执行失败会写在页面上，命令行里则打印在终端，并且不会把密钥打出来。单轮失败不会丢掉已经聊过的内容。

到达 `maxIterations` 后，程序停止继续提供工具，再请模型根据已拿到的观测作答。

## 文件

| 文件 | 职责 |
| --- | --- |
| `agent.js` | 通用 ReAct 循环，以及诗词系统提示词预设 |
| `tools.js` | 格律与检索工具 |
| `server.js` | 本地服务与 `/api/chat`，可被桌面端嵌入 |
| `desktop/main.cjs` | Electron 主进程，打开诗窗桌面窗口 |
| `public/` | 诗窗界面（含本地霞鹜文楷字体） |
| `lib/present.js` | 把格律工具结果收成卡片数据 |
| `cli.js` | 终端入口，保留多轮上下文 |
| `config.js` | 读取配置。密钥写在 `config.local.json` 或用户目录 |

这些工具都读本地数据。查不到会写明未收录，这时模型不得补造。

| 工具 | 作用 | 结果 |
| --- | --- | --- |
| `getPingZe` | 查单字平水韵平仄 | 平 / 仄 / 入，多音并列 |
| `checkNianDui` | 校验律诗联句的粘对 | 各处粘、对是否成立 |
| `findAoJiu` | 识别拗句、拗救 | 三拗四救、孤平拗救、三平调 |
| `checkYun` | 校验韵脚是否同属一个平水韵韵部 | 是否同部，以及韵部 |
| `getRhythmBook` | 按韵部名称列出收字 | 该部全部收录字 |
| `getPoemOriginal` | 按作者和诗题查原诗 | 正文 |
| `getAllusion` | 按典故名或诗句关键词查典故 | 出处与释义 |
| `checkCiPu` | 按钦定词谱或龙榆生《唐宋词格律》核对一首词 | 不合谱的字，以及韵脚的平水韵 |

数据范围：

- 平水韵约八千字。字表没有上声「三讲」。
- 原诗收录全唐诗、全宋诗、宋词、诗经、楚辞。
- 词谱来自 couyun 整理的钦定词谱与龙榆生《唐宋词格律》。声调用平水韵，入声作仄；「中」为可平可仄。词韵常宽于平水，韵脚不同部时不判出韵。
- 典故来自古汉语典故资源库，出处和释义会截短。

来源与许可写在 `data/SOURCES.txt`。重新生成数据：`npm run build:data`。

## 复用这套引擎

`ReactAgent` 不依赖诗词工具。换一份系统提示词和工具表即可：

```javascript
import config from "./config.js";
import { ReactAgent } from "./agent.js";

const agent = new ReactAgent({
  config,
  systemPrompt: "你是另一名助手。需要外部事实时调用工具，否则直接回答。",
  tools: {
    definitions: [],
    execute: async () => "",
  },
});

const history = [];
const answer = await agent.run(history, "你好");
```

`history` 请由调用方保存，并在下一轮继续传入。
