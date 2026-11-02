/**
 * 把公开韵书、诗集、典故库和词谱收成 data/ 下的检索文件。
 * 运行：node scripts/build-data.mjs
 * 平水韵、诗集、典故、词谱都保留来源许可，见 data/licenses。
 */

import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Converter } from "opencc-js";

const execFileAsync = promisify(execFile);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data");
const licenseDir = join(dataDir, "licenses");
const toSimp = Converter({ from: "tw", to: "cn" });
const toTrad = Converter({ from: "cn", to: "tw" });

const POETRY = "https://raw.githubusercontent.com/chinese-poetry/chinese-poetry/master/";
const POETRY_API = "https://api.github.com/repos/chinese-poetry/chinese-poetry/contents/";

/**
 * raw.githubusercontent.com 偶发 504。jsDelivr 上是同一份文件。
 * @param {string} url
 * @returns {string | null}
 */
function mirror(url) {
  const matched = url.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  if (!matched) return null;
  return `https://cdn.jsdelivr.net/gh/${matched[1]}/${matched[2]}@${matched[3]}/${matched[4]}`;
}

/**
 * @param {number} ms
 */
function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * @param {string} target
 * @returns {Promise<string>}
 */
async function fetchOnce(target) {
  const response = await fetch(target, {
    headers: { "User-Agent": "shici-react-agent" },
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) throw new Error(`${response.status} ${target}`);
  return await response.text();
}

/**
 * @param {string} url
 * @returns {Promise<string>}
 */
async function fetchText(url) {
  const targets = [url];
  const alt = mirror(url);
  if (alt) targets.push(alt);
  let lastError = new Error(url);

  for (const target of targets) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await fetchOnce(target);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (/^4\d\d /.test(lastError.message) && !lastError.message.startsWith("429")) throw lastError;
        await wait(600 * (attempt + 1));
      }
    }
  }

  const { stdout } = await execFileAsync(
    "curl.exe",
    ["--ssl-no-revoke", "-fsSL", "--max-time", "40", "--retry", "4", "--retry-delay", "1", "-A", "shici-react-agent", url],
    { maxBuffer: 32 * 1024 * 1024, encoding: "buffer", windowsHide: true },
  );
  return Buffer.from(stdout).toString("utf8");
}

/**
 * @param {string} url
 * @returns {Promise<{ json: () => Promise<any>, text: () => Promise<string> }>}
 */
async function fetchOk(url) {
  const text = await fetchText(url);
  return {
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

/**
 * @param {string[]} urls
 * @param {number} limit
 * @param {(url: string) => Promise<void>} worker
 */
async function pool(urls, limit, worker) {
  let cursor = 0;
  async function run() {
    while (cursor < urls.length) {
      const url = urls[cursor];
      cursor += 1;
      await worker(url);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, urls.length) }, () => run()));
}

/**
 * @param {string} path
 */
async function listJson(path) {
  const response = await fetchOk(POETRY_API + encodeURIComponent(path));
  const items = await response.json();
  return items.filter((item) => item.type === "file" && item.name.endsWith(".json"));
}

/**
 * @param {string} path
 */
function poetryUrl(path) {
  return POETRY + path.split("/").map((part) => encodeURIComponent(part)).join("/");
}

/**
 * @param {string} text
 */
function norm(text) {
  return String(text ?? "")
    .replace(/[《》〈〉「」『』“”‘’"'·・\s，。！？、；：,.;!?()（）【】\-—]/g, "")
    .trim();
}

/**
 * @param {string} text
 * @param {number} max
 */
function clip(text, max) {
  const value = String(text ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

/**
 * @param {string[][]} poems
 * @param {Record<string, number[]>} index
 * @param {string} author
 * @param {string} title
 * @param {string[]} paragraphs
 * @param {string} source
 */
function addKey(index, author, title, id) {
  const keys = new Set([
    `${norm(author)}\u0001${norm(title)}`,
    `${norm(toSimp(author))}\u0001${norm(toSimp(title))}`,
  ]);
  for (const key of keys) {
    if (!key || key === "\u0001" || key.startsWith("\u0001") || key.endsWith("\u0001")) continue;
    if (!index[key]) index[key] = [];
    if (!index[key].includes(id)) index[key].push(id);
  }
}

function pushPoem(poems, index, author, title, paragraphs, source) {
  const text = (paragraphs || []).map((line) => String(line).trim()).filter(Boolean).join("\n");
  const cleanAuthor = String(author || "").trim();
  const cleanTitle = String(title || "").trim();
  if (!cleanAuthor || !cleanTitle || !text) return -1;
  const id = poems.length;
  poems.push([cleanAuthor, cleanTitle, text, source]);
  addKey(index, cleanAuthor, cleanTitle, id);
  return id;
}

async function buildPingshui() {
  const response = await fetchOk("https://raw.githubusercontent.com/charlesix59/chinese_word_rhyme/main/data/Pingshui_Rhyme.json");
  const raw = await response.json();
  const sectionName = {
    上平声部: "上平",
    下平声部: "下平",
    上声部: "上声",
    去声部: "去声",
    入声部: "入声",
  };
  const groups = [];
  for (const [sectionKey, rhymes] of Object.entries(raw)) {
    const section = sectionName[sectionKey] || sectionKey;
    for (const [name, chars] of Object.entries(rhymes)) {
      const tone = section === "入声" ? "入" : section.includes("平") ? "平" : "仄";
      const shortName = name.replace(/^入声/, "");
      const id = section === "入声" ? `入声${shortName}` : `${section}${shortName}`;
      groups.push({
        id,
        section,
        name: shortName,
        tone,
        chars: chars.join(""),
      });
    }
  }

  const names = {};
  const addName = (key, index) => {
    const normalized = norm(key);
    if (!normalized) return;
    if (!names[normalized]) names[normalized] = [];
    if (!names[normalized].includes(index)) names[normalized].push(index);
    const traditional = norm(toTrad(normalized));
    if (traditional && traditional !== normalized) {
      if (!names[traditional]) names[traditional] = [];
      if (!names[traditional].includes(index)) names[traditional].push(index);
    }
  };
  groups.forEach((group, index) => {
    addName(group.id, index);
    addName(group.name, index);
    addName(group.section + group.name, index);
    addName(`${group.section}声${group.name}`, index);
    if (group.section === "上平" || group.section === "下平") {
      addName(`平声${group.name}`, index);
    }
  });

  const seen = new Set(groups.flatMap((group) => [...group.chars]));
  const alias = {};
  for (const ch of seen) {
    const traditional = toTrad(ch);
    if ([...traditional].length === 1 && traditional !== ch && !seen.has(traditional)) {
      alias[traditional] = ch;
    }
  }

  await writeFile(join(dataDir, "pingshui.json"), JSON.stringify({ groups, names, alias }));
  console.log(`平水韵 ${groups.length} 部，${seen.size} 字，繁体别名 ${Object.keys(alias).length}`);
}

async function loadPoems() {
  try {
    const parsed = JSON.parse(await readFile(join(dataDir, "poems.json"), "utf8"));
    if (Array.isArray(parsed.poems) && parsed.index && typeof parsed.index === "object") return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return { poems: [], index: {} };
}

async function buildPoems() {
  const loaded = await loadPoems();
  const poems = loaded.poems;
  const index = loaded.index;
  const have = new Set(poems.map((row) => row[3]));

  const tangDir = await listJson("全唐诗");
  const tangFiles = tangDir.map((item) => item.name).filter((name) => /^poet\.tang\.\d+\.json$/.test(name));
  const songFiles = tangDir.map((item) => item.name).filter((name) => /^poet\.song\.\d+\.json$/.test(name));

  if (!have.has("全唐诗")) {
    console.log(`下载全唐诗 ${tangFiles.length} 个文件`);
    await pool(tangFiles, 6, async (name) => {
      const rows = await (await fetchOk(poetryUrl(`全唐诗/${name}`))).json();
      for (const row of rows) {
        pushPoem(poems, index, row.author, row.title, row.paragraphs, "全唐诗");
      }
    });
  }

  if (!have.has("全宋诗")) {
    console.log(`下载全宋诗 ${songFiles.length} 个文件`);
    let done = 0;
    await pool(songFiles, 4, async (name) => {
      const rows = await (await fetchOk(poetryUrl(`全唐诗/${name}`))).json();
      for (const row of rows) {
        pushPoem(poems, index, row.author, row.title, row.paragraphs, "全宋诗");
      }
      done += 1;
      if (done % 25 === 0 || done === songFiles.length) console.log(`全宋诗 ${done}/${songFiles.length}`);
    });
  }

  if (!have.has("宋词")) {
    const ciFiles = (await listJson("宋词"))
      .map((item) => item.name)
      .filter((name) => /^ci\.song\.\d+\.json$/.test(name));
    console.log(`下载宋词 ${ciFiles.length} 个文件`);
    await pool(ciFiles, 6, async (name) => {
      const rows = await (await fetchOk(poetryUrl(`宋词/${name}`))).json();
      for (const row of rows) {
        const title = [row.rhythmic, row.title].filter(Boolean).join(" ");
        const id = pushPoem(poems, index, row.author, title, row.paragraphs, "宋词");
        if (id >= 0 && row.rhythmic && row.title) addKey(index, row.author, row.rhythmic, id);
      }
    });
  }

  if (!have.has("诗经")) {
    const shijing = await (await fetchOk(poetryUrl("诗经/shijing.json"))).json();
    for (const row of shijing) {
      pushPoem(poems, index, "诗经", row.title, row.content, "诗经");
    }
  }
  if (!have.has("楚辞")) {
    const chuci = await (await fetchOk(poetryUrl("楚辞/chuci.json"))).json();
    for (const row of chuci) {
      pushPoem(poems, index, row.author || "楚辞", row.title, row.content, "楚辞");
    }
  }

  const target = join(dataDir, "poems.json");
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify({ poems, index }));
  await rm(target, { force: true });
  await rename(tmp, target);

  // 同时出一份 gzip：安装包只带这一份，体积能小一半以上。
  const gz = `${target}.gz`;
  const gzTmp = `${gz}.tmp`;
  await writeFile(gzTmp, gzipSync(await readFile(target)));
  await rm(gz, { force: true });
  await rename(gzTmp, gz);

  console.log(`诗集 ${poems.length} 首，索引 ${Object.keys(index).length}`);
}

async function buildAllusions() {
  const response = await fetchOk("https://raw.githubusercontent.com/KaijieMo-kj/Ancient-Chinese-Allusion-Resource-Database/main/Allusion_Knowledge_Base/core_structure_09.jsonl");
  const text = await response.text();
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    const name = String(row["典源词"] || "").trim();
    if (!name) continue;
    const meanings = [];
    const aliases = new Set([name, toSimp(name)]);
    for (const derived of row["衍生列表"] || []) {
      if (derived["释义"]) meanings.push(clip(derived["释义"], 160));
      const forms = [derived["典形词"]];
      for (const related of derived["同源列表"] || []) forms.push(related["典形词"]);
      for (const form of forms) {
        const cleaned = String(form || "").trim().replace(/\d+$/g, "");
        if (cleaned) {
          aliases.add(cleaned);
          aliases.add(toSimp(cleaned));
        }
      }
    }
    entries.push({
      name,
      source: clip(row["典源内容"] || "", 360),
      meanings: [...new Set(meanings)].slice(0, 4),
      aliases: [...aliases].filter((alias) => norm(alias).length >= 2),
    });
  }
  await writeFile(join(dataDir, "allusions.json"), JSON.stringify(entries));
  console.log(`典故 ${entries.length} 条`);
}

async function saveLicenses() {
  const files = [
    ["chinese-word-rhyme.txt", "https://raw.githubusercontent.com/charlesix59/chinese_word_rhyme/main/LICENSE"],
    ["chinese-poetry.txt", "https://raw.githubusercontent.com/chinese-poetry/chinese-poetry/master/LICENSE"],
  ];
  await mkdir(licenseDir, { recursive: true });
  for (const [name, url] of files) {
    const response = await fetchOk(url);
    await writeFile(join(licenseDir, name), await response.text());
  }
  await writeFile(join(licenseDir, "allusion-database.txt"), `上游仓库没有单独的 LICENSE 文件。
README 写明数据集使用 MIT License：
https://github.com/KaijieMo-kj/Ancient-Chinese-Allusion-Resource-Database
`);
}

/**
 * @param {object} form
 */
function compactForm(form) {
  const groups = Object.values(form.yun_classify || {}).map((positions) => (
    Array.isArray(positions) ? positions.map((pos) => Number(pos)) : []
  ));
  return {
    marks: form.ge_lyu_sep || [],
    groups,
    example: String(form.origin || "").trim(),
  };
}

async function couyunDir() {
  const candidates = [
    join(tmpdir(), "couyun-src"),
    join(tmpdir(), "shici-couyun"),
  ];
  for (const root of candidates) {
    const index = join(root, "couyun", "ci_pu", "ci_index.json");
    try {
      await access(index);
      return root;
    } catch {
      /* 下一个 */
    }
  }

  const dest = candidates[1];
  await rm(dest, { recursive: true, force: true });
  console.log("下载词谱仓库 couyun");
  const args = ["clone", "--depth", "1", "https://github.com/hulbji/couyun.git", dest];
  try {
    await execFileAsync("git", args, { windowsHide: true });
  } catch {
    await execFileAsync("git", ["-c", "http.sslVerify=false", ...args], { windowsHide: true });
  }
  return dest;
}

async function buildCipu() {
  const root = await couyunDir();
  const dir = join(root, "couyun", "ci_pu");
  const index = JSON.parse(await readFile(join(dir, "ci_index.json"), "utf8"));
  const tunes = [];
  for (const item of index) {
    const qin = JSON.parse(await readFile(join(dir, "ci_list", `cipai_${item.idx}.json`), "utf8"));
    let long = [];
    if (item.long_exist) {
      long = JSON.parse(await readFile(join(dir, "ci_long", `cipai_${item.idx}_long.json`), "utf8"));
    }
    const names = [...new Set(
      [...(item.names || []), ...(item.names_trad || [])]
        .map((name) => String(name).trim())
        .filter(Boolean),
    )];
    tunes.push({
      names,
      qin: qin.map(compactForm),
      long: long.map(compactForm),
    });
  }
  await mkdir(licenseDir, { recursive: true });
  await writeFile(join(dataDir, "cipu.json"), JSON.stringify({ tunes }));
  await writeFile(join(licenseDir, "couyun.txt"), await readFile(join(root, "LICENSE"), "utf8"));
  const longCount = tunes.filter((tune) => tune.long.length).length;
  console.log(`词谱 ${tunes.length} 调，其中龙榆生 ${longCount} 调`);
}

await mkdir(dataDir, { recursive: true });
await buildPoems();
await buildCipu();
await saveLicenses();
await buildPingshui();
await buildAllusions();
