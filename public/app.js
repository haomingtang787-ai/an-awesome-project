const STORAGE_KEY = "shici-window-v1";
/** 用户点过「稍后」的版本号；同一版本不再自动弹出。 */
const UPDATE_DISMISS_KEY = "shici-update-dismissed";

/**
 * 本地服务的访问令牌。
 * 桌面端把令牌拼在启动 URL 里（?t=...），页面从这里取出，之后每个 /api 请求都带上。
 * 本机其它程序没有令牌，读不到配置，也发不了对话请求。
 */
const accessToken = new URLSearchParams(location.search).get("t") || "";

(() => {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (!accessToken || !url.startsWith("/api/")) return nativeFetch(input, init);
    const headers = new Headers((init && init.headers) || undefined);
    headers.set("X-ShiChuang-Token", accessToken);
    return nativeFetch(input, { ...(init || {}), headers });
  };
})();

const EXAMPLES = [
  {
    label: "查律陪改",
    text: "先帮我查这首诗的平仄、粘对、拗救和韵脚，再陪我逐处改到合律，尽量保留原意。\n夜雨打窗急，孤灯照客愁。\n家书久未至，梦里到江楼。",
  },
  {
    label: "拟作七绝",
    text: "以「秋夜听雨」为题，作一首七言绝句。先立意谋篇，定稿前再用格律工具终检。",
  },
  {
    label: "品评一句",
    text: "品评「孤舟蓑笠翁，独钓寒江雪」，从意境和炼字说。",
  },
  {
    label: "核对词律",
    text: "请按钦定词谱核对这首忆秦娥：箫声咽，秦娥梦断秦楼月。秦楼月，年年柳色，霸陵伤别。乐游原上清秋节，咸阳古道音尘绝。音尘绝，西风残照，汉家陵阙。",
  },
];

const sidebar = document.querySelector("#sidebar");
const historyEl = document.querySelector("#history");
const threadEl = document.querySelector("#thread");
const transcriptEl = document.querySelector("#transcript");
const titleEl = document.querySelector("#current-title");
const bannerEl = document.querySelector("#banner");
const updateBannerEl = document.querySelector("#update-banner");
const updateOpenEl = document.querySelector("#update-open");
const updateDismissEl = document.querySelector("#update-dismiss");
const checkUpdateEl = document.querySelector("#check-update");
const appVersionEl = document.querySelector("#app-version");
const versionUpdateEl = document.querySelector("#version-update");
const sideNoteEl = document.querySelector(".side-note");
const draftEl = document.querySelector("#draft");
const formEl = document.querySelector("#composer");
const sendEl = document.querySelector("#send");
const stopEl = document.querySelector("#stop");
const modalEl = document.querySelector("#modal");

/** @type {{ current: string, latest: string, url: string, downloadUrl?: string, name?: string } | null} */
let pendingUpdate = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let statusTimer = null;

const TOOL_LABELS = {
  getPingZe: "查平仄",
  checkNianDui: "查粘对",
  findAoJiu: "查拗救",
  checkYun: "查韵脚",
  getRhythmBook: "查韵部",
  getPoemOriginal: "查原诗",
  getAllusion: "查典故",
  checkCiPu: "查词谱",
};
const settingsEl = document.querySelector("#settings");
const settingsForm = document.querySelector("#settings-form");
const cfgKey = document.querySelector("#cfg-key");
const cfgBase = document.querySelector("#cfg-base");
const cfgModel = document.querySelector("#cfg-model");
const cfgModelHint = document.querySelector("#cfg-model-hint");
const cfgRounds = document.querySelector("#cfg-rounds");
const cfgHint = document.querySelector("#cfg-key-hint");
const cfgError = document.querySelector("#cfg-error");
const fetchModelsEl = document.querySelector("#fetch-models");
const scrimEl = document.querySelector("#scrim");

const DEEPSEEK = {
  baseUrl: "https://api.deepseek.com",
};

/** @type {{ id: string, name: string }[]} */
let modelOptions = [];
/** 打开设置时是否已有保存的密钥。表单里密钥留空时仍可用来拉取模型。 */
let settingsHasKey = false;

/** @type {{ conversations: object[], activeId: string }} */
let state = loadState();
let inFlight = false;
/** @type {AbortController | null} */
let activeAbort = null;

document.querySelector("#new-chat").addEventListener("click", newConversation);
document.querySelector("#clear-chat").addEventListener("click", askClear);
document.querySelector("#modal-cancel").addEventListener("click", closeModal);
document.querySelector("#modal-confirm").addEventListener("click", confirmClear);
document.querySelector("#open-sidebar").addEventListener("click", () => setSidebar(true));
document.querySelector("#open-settings").addEventListener("click", () => openSettings());
document.querySelector("#settings-cancel").addEventListener("click", closeSettings);
document.querySelector("#use-deepseek").addEventListener("click", () => {
  fillDeepSeek();
  fetchModels();
});
fetchModelsEl.addEventListener("click", () => fetchModels());
cfgKey.addEventListener("change", () => {
  if (cfgKey.value.trim()) fetchModels();
});
bannerEl.addEventListener("click", () => openSettings());
checkUpdateEl.addEventListener("click", () => {
  setSidebar(false);
  checkUpdate({ quiet: false });
});
updateOpenEl.addEventListener("click", openUpdatePage);
updateDismissEl.addEventListener("click", dismissUpdateBanner);
versionUpdateEl.addEventListener("click", openUpdatePage);
settingsEl.addEventListener("click", (event) => {
  if (event.target === settingsEl) closeSettings();
});
settingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveSettings();
});
scrimEl.addEventListener("click", () => setSidebar(false));

formEl.addEventListener("submit", (event) => {
  event.preventDefault();
  sendDraft();
});

stopEl.addEventListener("click", () => {
  if (activeAbort) activeAbort.abort();
});

draftEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    formEl.requestSubmit();
  }
});

draftEl.addEventListener("input", fitDraft);

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (!settingsEl.hidden) {
    closeSettings();
    return;
  }
  if (!modalEl.hidden) {
    closeModal();
    return;
  }
  setSidebar(false);
});

boot();

function boot() {
  render();
  fitDraft();
  loadReady().then(() => checkUpdate({ quiet: true }));
}

async function loadReady() {
  try {
    const response = await fetch("/api/settings");
    const data = await response.json();
    bannerEl.hidden = Boolean(data.ready);
    if (!data.ready) {
      bannerEl.textContent = "接口还没配好。点这里填写 DeepSeek 密钥。";
    }
    if (appVersionEl) {
      appVersionEl.textContent = data.version ? `v${data.version}` : "v—";
      appVersionEl.title = data.version ? `当前版本 ${data.version}` : "当前版本未知";
    }
    return data;
  } catch {
    bannerEl.hidden = false;
    bannerEl.textContent = "页面还没连上本地服务。";
    return null;
  }
}

/**
 * 向 GitHub Releases 查询是否有比当前 package.json 更新的版本。
 * @param {{ quiet?: boolean }} [options]
 */
async function checkUpdate(options = {}) {
  const quiet = Boolean(options.quiet);
  checkUpdateEl.disabled = true;
  if (!quiet) setUpdateStatus("正在查询 GitHub…");
  try {
    const response = await fetch("/api/update");
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (!quiet) setUpdateStatus(data.error || "查询更新失败。");
      return;
    }
    pendingUpdate = {
      current: String(data.current || ""),
      latest: String(data.latest || ""),
      url: String(data.url || ""),
      downloadUrl: String(data.downloadUrl || data.url || ""),
      name: String(data.name || ""),
    };
    if (data.hasUpdate && pendingUpdate.latest) {
      showUpdateBadge(pendingUpdate);
      showUpdateBanner(pendingUpdate, { force: !quiet });
      if (!quiet) setUpdateStatus(`发现新版本 ${pendingUpdate.latest}`);
    } else {
      hideUpdateBadge();
      hideUpdateBanner();
      if (!quiet) setUpdateStatus(`已是最新版 ${pendingUpdate.current || ""}`.trim());
    }
  } catch {
    if (!quiet) setUpdateStatus("无法连接更新服务，请检查网络。");
  } finally {
    checkUpdateEl.disabled = false;
  }
}

/**
 * @param {{ current: string, latest: string, url: string, name?: string }} info
 * @param {{ force?: boolean }} [options]
 */
function showUpdateBanner(info, options = {}) {
  const dismissed = localStorage.getItem(UPDATE_DISMISS_KEY) || "";
  if (!options.force && dismissed === info.latest) {
    hideUpdateBanner();
    return;
  }
  pendingUpdate = info;
  updateOpenEl.textContent = `有新版本 ${info.latest}（当前 ${info.current}）。点此打开 GitHub 下载页`;
  updateBannerEl.hidden = false;
}

function hideUpdateBanner() {
  updateBannerEl.hidden = true;
}

/**
 * 左下角的常驻更新徽标。即使点了顶部提醒的「稍后」，这里仍保留入口。
 * @param {{ current: string, latest: string }} info
 */
function showUpdateBadge(info) {
  if (!versionUpdateEl) return;
  versionUpdateEl.hidden = false;
  versionUpdateEl.textContent = `可更新 v${info.latest}`;
  versionUpdateEl.title = `当前 v${info.current}，点击打开下载页`;
}

function hideUpdateBadge() {
  if (!versionUpdateEl) return;
  versionUpdateEl.hidden = true;
  versionUpdateEl.textContent = "";
  versionUpdateEl.removeAttribute("title");
}

function dismissUpdateBanner() {
  if (pendingUpdate?.latest) {
    localStorage.setItem(UPDATE_DISMISS_KEY, pendingUpdate.latest);
  }
  hideUpdateBanner();
  setUpdateStatus("已忽略此版本提醒");
}

function openUpdatePage() {
  // 优先打开 Release 页，方便看说明；直链 exe 作为后备。
  const target = pendingUpdate?.url || pendingUpdate?.downloadUrl;
  if (!target) return;
  window.open(target, "_blank", "noopener,noreferrer");
}

/**
 * @param {string} text
 */
function setUpdateStatus(text) {
  if (!sideNoteEl) return;
  if (statusTimer) clearTimeout(statusTimer);
  const original = sideNoteEl.dataset.original || sideNoteEl.textContent || "";
  if (!sideNoteEl.dataset.original) sideNoteEl.dataset.original = original;
  sideNoteEl.textContent = text;
  sideNoteEl.classList.add("update-status");
  statusTimer = setTimeout(() => {
    sideNoteEl.textContent = sideNoteEl.dataset.original || original;
    sideNoteEl.classList.remove("update-status");
    statusTimer = null;
  }, 4200);
}

async function openSettings() {
  setSidebar(false);
  cfgError.hidden = true;
  cfgError.textContent = "";
  settingsEl.hidden = false;
  const data = await loadReady();
  if (data) fillSettings(data);
  cfgKey.focus();
  if (settingsHasKey || cfgKey.value.trim()) {
    await fetchModels({ quiet: true });
  }
}

function closeSettings() {
  settingsEl.hidden = true;
}

function fillDeepSeek() {
  cfgBase.value = DEEPSEEK.baseUrl;
}

/**
 * 还没配过时，地址先放上 DeepSeek。模型等拉取开放平台名单后再选。
 * @param {object} data
 */
function fillSettings(data) {
  const fresh = !data.hasKey && !String(data.model || "").trim();
  const preset = data.deepseek || DEEPSEEK;
  settingsHasKey = Boolean(data.hasKey);
  cfgBase.value = fresh ? preset.baseUrl : (data.baseUrl || preset.baseUrl);
  cfgRounds.value = data.maxIterations || 8;
  cfgKey.value = "";
  cfgHint.textContent = data.hasKey
    ? `${data.keyHint}。留空则不修改。`
    : "到 DeepSeek 开放平台创建密钥，粘贴到上面。";
  renderModelOptions(modelOptions, data.model || "");
}

/**
 * @param {{ id: string, name?: string }[]} models
 * @param {string} [preferred]
 */
function renderModelOptions(models, preferred = "") {
  modelOptions = Array.isArray(models) ? models : [];
  const current = preferred || cfgModel.value || "";
  cfgModel.innerHTML = "";
  if (!modelOptions.length) {
    const empty = document.createElement("option");
    empty.value = current;
    empty.textContent = current || "请先拉取模型列表";
    cfgModel.append(empty);
    cfgModel.disabled = !current;
    cfgModelHint.textContent = current
      ? "名单尚未刷新。可点「拉取模型」从开放平台更新。"
      : "先填写密钥并拉取模型列表。";
    return;
  }
  cfgModel.disabled = false;
  for (const item of modelOptions) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.name ? `${item.name}（${item.id}）` : item.id;
    cfgModel.append(option);
  }
  if (current && ![...cfgModel.options].some((item) => item.value === current)) {
    const kept = document.createElement("option");
    kept.value = current;
    kept.textContent = `${current}（当前）`;
    cfgModel.prepend(kept);
  }
  cfgModel.value = current && [...cfgModel.options].some((item) => item.value === current)
    ? current
    : modelOptions[0].id;
  cfgModelHint.textContent = `已从开放平台拉取 ${modelOptions.length} 个模型。请选支持工具调用的一项。`;
}

/**
 * @param {{ quiet?: boolean }} [options]
 */
async function fetchModels(options = {}) {
  const quiet = Boolean(options.quiet);
  if (!quiet) {
    cfgError.hidden = true;
    cfgError.textContent = "";
  }
  const apiKey = cfgKey.value.trim();
  if (!apiKey && !settingsHasKey) {
    if (!quiet) {
      cfgError.hidden = false;
      cfgError.textContent = "请先填写 API 密钥，再拉取模型。";
    }
    return;
  }
  fetchModelsEl.disabled = true;
  cfgModelHint.textContent = "正在从开放平台拉取模型…";
  try {
    const response = await fetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey,
        baseUrl: cfgBase.value.trim(),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (!quiet) {
        cfgError.hidden = false;
        cfgError.textContent = data.error || "没有拉到模型列表。";
      }
      cfgModelHint.textContent = "拉取失败。请检查密钥和接口地址。";
      return;
    }
    renderModelOptions(data.models || [], cfgModel.value);
  } catch {
    if (!quiet) {
      cfgError.hidden = false;
      cfgError.textContent = "页面与本地服务失去联系。";
    }
    cfgModelHint.textContent = "拉取失败。页面与本地服务失去联系。";
  } finally {
    fetchModelsEl.disabled = false;
  }
}

async function saveSettings() {
  cfgError.hidden = true;
  const model = cfgModel.value.trim();
  if (!model) {
    cfgError.hidden = false;
    cfgError.textContent = "请先拉取并选择模型。";
    return;
  }
  try {
    const response = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: cfgKey.value,
        baseUrl: cfgBase.value.trim(),
        model,
        maxIterations: Number(cfgRounds.value),
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      cfgError.hidden = false;
      cfgError.textContent = data.error || "没有保存成功。";
      return;
    }
    settingsHasKey = Boolean(data.hasKey);
    bannerEl.hidden = true;
    closeSettings();
  } catch {
    cfgError.hidden = false;
    cfgError.textContent = "页面与本地服务失去联系。";
  }
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "");
    if (saved && Array.isArray(saved.conversations) && saved.conversations.length) {
      const activeId = saved.conversations.some((item) => item.id === saved.activeId)
        ? saved.activeId
        : saved.conversations[0].id;
      return { conversations: saved.conversations, activeId };
    }
  } catch {
    /* 空记录或旧格式，从新的一则开始。 */
  }
  const fresh = blankConversation();
  return { conversations: [fresh], activeId: fresh.id };
}

function persist() {
  const conversations = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  if (conversations.length > 40) conversations.length = 40;
  state.conversations = conversations;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    conversations: state.conversations,
    activeId: state.activeId,
  }));
}

function blankConversation() {
  return {
    id: crypto.randomUUID(),
    title: "新的对话",
    updatedAt: Date.now(),
    messages: [],
    agentHistory: [],
  };
}

function active() {
  return state.conversations.find((item) => item.id === state.activeId) || state.conversations[0];
}

function newConversation() {
  const current = active();
  if (current && current.messages.length === 0 && !inFlight) {
    draftEl.focus();
    setSidebar(false);
    return;
  }
  const fresh = blankConversation();
  state.conversations.unshift(fresh);
  state.activeId = fresh.id;
  persist();
  render();
  setSidebar(false);
  draftEl.focus();
}

function askClear() {
  const current = active();
  if (!current || current.messages.length === 0 || inFlight) return;
  modalEl.hidden = false;
  document.querySelector("#modal-cancel").focus();
}

function closeModal() {
  modalEl.hidden = true;
}

function confirmClear() {
  const id = state.activeId;
  state.conversations = state.conversations.filter((item) => item.id !== id);
  const fresh = blankConversation();
  state.conversations.unshift(fresh);
  state.activeId = fresh.id;
  persist();
  closeModal();
  render();
}

function removeConversation(id) {
  const index = state.conversations.findIndex((item) => item.id === id);
  if (index < 0) return;
  state.conversations.splice(index, 1);
  if (!state.conversations.length) {
    const fresh = blankConversation();
    state.conversations.push(fresh);
    state.activeId = fresh.id;
  } else if (state.activeId === id) {
    const next = state.conversations[Math.max(0, index - 1)] || state.conversations[0];
    state.activeId = next.id;
  }
  persist();
  render();
}

function openConversation(id) {
  if (id === state.activeId) {
    setSidebar(false);
    return;
  }
  state.activeId = id;
  persist();
  render();
  setSidebar(false);
}

function setSidebar(open) {
  sidebar.classList.toggle("open", open);
  scrimEl.hidden = !open;
}

function render() {
  const current = active();
  titleEl.textContent = current?.title || "新的对话";
  document.title = current?.title && current.title !== "新的对话"
    ? `诗窗 · ${current.title}`
    : "诗窗";
  renderHistory();
  renderThread();
}

function renderHistory() {
  historyEl.replaceChildren();
  const ordered = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const conversation of ordered) {
    const item = document.createElement("li");
    if (conversation.id === state.activeId) item.className = "active";

    const open = document.createElement("button");
    open.type = "button";
    open.className = "item";
    const title = document.createElement("span");
    title.className = "item-title";
    title.textContent = conversation.title || "新的对话";
    const meta = document.createElement("span");
    meta.className = "item-meta";
    meta.textContent = `${formatTime(conversation.updatedAt)}  ${previewOf(conversation)}`;
    open.append(title, meta);
    open.addEventListener("click", () => openConversation(conversation.id));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.setAttribute("aria-label", "删除这则对话");
    remove.textContent = "×";
    remove.addEventListener("click", () => removeConversation(conversation.id));

    item.append(open, remove);
    historyEl.append(item);
  }
}

function renderThread() {
  const current = active();
  threadEl.replaceChildren();
  if (!current || current.messages.length === 0) {
    threadEl.append(emptyState());
  } else {
    for (const message of current.messages) {
      if (message.role === "user") {
        threadEl.append(block("bubble-user", message.content));
      } else if (message.presentation?.type === "meter") {
        const card = message.presentation;
        if (card.answerBeforeCard && message.content) {
          const wrap = document.createElement("div");
          wrap.className = "assistant-turn";
          wrap.append(block("bubble-text", message.content));
          threadEl.append(wrap);
        }
        const meter = meterCard(
          card,
          card.answerBeforeCard || card.answerAfterCard ? "" : message.content,
        );
        if (message.tools?.length) meter.append(toolTrail(message.tools));
        threadEl.append(meter);
        if (card.answerAfterCard && message.content) {
          const wrap = document.createElement("div");
          wrap.className = "assistant-turn";
          wrap.append(block("bubble-text", message.content));
          threadEl.append(wrap);
        }
      } else {
        const wrap = document.createElement("div");
        wrap.className = "assistant-turn";
        wrap.append(block("bubble-text", message.content));
        if (message.tools?.length) wrap.append(toolTrail(message.tools));
        threadEl.append(wrap);
      }
    }
  }
  if (current?.pending) {
    threadEl.append(block("pending", current.progress || "正在斟酌"));
  }
  if (current?.error) {
    const flash = block("flash", current.error);
    flash.setAttribute("role", "alert");
    threadEl.append(flash);
  }
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function emptyState() {
  const wrap = document.createElement("div");
  wrap.className = "empty";
  const quote = document.createElement("p");
  quote.className = "verse-quote";
  quote.textContent = "欲穷千里目\n更上一层楼";
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "先查格律，再逐处推敲，改到定稿。";
  const examples = document.createElement("div");
  examples.className = "examples";
  for (const example of EXAMPLES) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = example.label;
    button.addEventListener("click", () => {
      draftEl.value = example.text;
      fitDraft();
      draftEl.focus();
    });
    examples.append(button);
  }
  wrap.append(quote, hint, examples);
  return wrap;
}

function block(className, text) {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * @param {object} card
 * @param {string} answer
 */
function meterCard(card, answer) {
  const wrap = document.createElement("article");
  wrap.className = "meter-card";

  const head = document.createElement("div");
  head.className = "meter-head";
  const kicker = document.createElement("span");
  kicker.className = "meter-kicker";
  kicker.textContent = card.variant === "chars" ? "平仄" : card.variant === "rhyme" ? "韵部" : card.variant === "ci" ? "词律" : "格律";
  head.append(kicker);
  if (card.form) {
    const form = document.createElement("span");
    form.className = "meter-form";
    form.textContent = card.form;
    head.append(form);
  }
  wrap.append(head);

  if (card.variant === "poem") appendPoem(wrap, card);
  if (card.variant === "ci") appendCi(wrap, card);
  if (card.variant === "chars") appendCharTable(wrap, card.rows || []);
  if (card.variant === "poem" && card.pairs?.length) appendPairTable(wrap, card.pairs);
  if (card.variant === "poem") appendIssueTable(wrap, card.issues || []);
  if (card.variant !== "ci" && card.yun) appendYun(wrap, card.yun);

  if (answer) {
    const note = document.createElement("div");
    note.className = "meter-note";
    note.textContent = answer;
    wrap.append(note);
  }

  const fine = document.createElement("p");
  fine.className = "fine";
  fine.textContent = card.variant === "ci"
    ? "平仄据平水韵，入声作仄。谱中「中」为可平可仄。韵脚不同部时不判出韵，词韵常更宽。"
    : "平仄据平水韵。入声在字下仍标「入」，粘对与拗救中作仄。";
  wrap.append(fine);
  return wrap;
}

/**
 * @param {HTMLElement} wrap
 * @param {object} card
 */
function appendPoem(wrap, card) {
  const verse = document.createElement("div");
  verse.className = "verse";
  let anyAo = false;
  let anyJiu = false;
  for (const line of card.lines || []) {
    const row = document.createElement("div");
    row.className = "verse-line";
    for (const syllable of line) {
      if (syllable.ao) anyAo = true;
      if (syllable.jiu) anyJiu = true;
      const cell = document.createElement("span");
      cell.className = `syllable${syllable.ao ? " ao" : ""}${syllable.jiu ? " jiu" : ""}`;
      if (syllable.title) cell.title = syllable.title;
      const char = document.createElement("span");
      char.className = "char";
      char.textContent = syllable.ch;
      const tone = document.createElement("span");
      tone.className = "tone";
      tone.textContent = syllable.tone;
      cell.append(char, tone);
      row.append(cell);
    }
    verse.append(row);
  }
  wrap.append(verse);

  if (anyAo || anyJiu) {
    const legend = document.createElement("p");
    legend.className = "legend";
    if (anyAo) {
      const mark = document.createElement("span");
      mark.className = "swatch";
      mark.textContent = card.aoLabel || "朱色为拗字";
      legend.append(mark);
    }
    if (anyJiu) {
      const mark = document.createElement("span");
      const sample = document.createElement("span");
      sample.className = "jiu-sample";
      sample.textContent = "救";
      mark.append(sample, document.createTextNode(" 为相救之字"));
      legend.append(mark);
    }
    wrap.append(legend);
  }

  if (card.unknownChars?.length) {
    const unknown = document.createElement("p");
    unknown.className = "fine";
    unknown.textContent = `平水韵未收：${card.unknownChars.join("、")}。这些字不作判。`;
    wrap.append(unknown);
  }
}

/**
 * @param {HTMLElement} wrap
 * @param {object} card
 */
function appendCi(wrap, card) {
  if (!card.matched) {
    const note = document.createElement("p");
    note.className = "fine";
    note.textContent = card.detail || "词谱未收录。";
    wrap.append(note);
    return;
  }

  appendPoem(wrap, card);
  wrap.append(heading("平仄"));
  const table = tableWith(["句", "位置", "字", "谱", "实际"]);
  const issues = card.issues || [];
  if (!issues.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 5;
    td.textContent = "平仄相合。";
    tr.append(td);
    table.append(tr);
  }
  for (const issue of issues) {
    const tr = document.createElement("tr");
    tr.append(
      cell(String(issue.line || "")),
      cell(String(issue.position || "")),
      cell(issue.ch || ""),
      cell(issue.expect === "中" ? "可" : `宜${issue.expect || ""}`),
      cell(issue.actual || "", "fault"),
    );
    table.append(tr);
  }
  wrap.append(table);

  for (const group of card.rhymeGroups || []) {
    wrap.append(heading(group.label || "韵脚"));
    const rhymes = tableWith(["字", "平水韵"]);
    for (const foot of group.feet || []) {
      const tr = document.createElement("tr");
      const name = foot.xie ? `${foot.char}（协）` : foot.char;
      tr.append(cell(name || ""), cell((foot.rhymes || []).join("、") || "未收"));
      rhymes.append(tr);
    }
    const summary = document.createElement("tr");
    const verdict = group.same === true ? "平水同部" : group.same === false ? "平水不同部" : "未定";
    const cls = group.same === true ? "ok" : "muted";
    const note = group.same === false ? "词韵常宽于平水，此处不判出韵。" : "";
    summary.append(cell(verdict, cls), cell(note));
    rhymes.append(summary);
    wrap.append(rhymes);
  }
}

/**
 * @param {HTMLElement} wrap
 * @param {object[]} rows
 */
function appendCharTable(wrap, rows) {
  const table = tableWith(["字", "声调", "说明"]);
  for (const row of rows) {
    const tr = document.createElement("tr");
    tr.append(
      cell(row.character),
      cell(row.label, row.found ? "" : "fault"),
      cell(row.detail || ""),
    );
    table.append(tr);
  }
  wrap.append(table);
}

/**
 * @param {HTMLElement} wrap
 * @param {object[]} pairs
 */
function appendPairTable(wrap, pairs) {
  wrap.append(heading("粘对"));
  const table = tableWith(["关系", "上句", "下句", "结果"]);
  for (const pair of pairs) {
    const tr = document.createElement("tr");
    tr.append(
      cell(pair.kind),
      cell(`${pair.upperChar || "—"}`),
      cell(`${pair.lowerChar || "—"}`),
      cell(pair.result, toneClass(pair.result)),
    );
    tr.title = pair.detail || "";
    table.append(tr);
  }
  wrap.append(table);
}

/**
 * @param {HTMLElement} wrap
 * @param {object[]} issues
 */
function appendIssueTable(wrap, issues) {
  wrap.append(heading("拗救"));
  const table = tableWith(["句", "位置", "判定", "说明"]);
  if (!issues.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.textContent = "未见需标出的拗字。";
    tr.append(td);
    table.append(tr);
  }
  for (const issue of issues) {
    const tr = document.createElement("tr");
    tr.append(
      cell(String(issue.line || "")),
      cell(String(issue.position || "—")),
      cell(issue.kind, issue.fault ? "fault" : "ok"),
      cell(issue.detail || ""),
    );
    table.append(tr);
  }
  wrap.append(table);
}

/**
 * @param {HTMLElement} wrap
 * @param {object} yun
 */
function appendYun(wrap, yun) {
  wrap.append(heading("韵脚"));
  const table = tableWith(["字", "可入"]);
  for (const foot of yun.feet || []) {
    const tr = document.createElement("tr");
    tr.append(cell(foot.char), cell((foot.rhymes || []).join("、") || "未收"));
    table.append(tr);
  }
  const summary = document.createElement("tr");
  const verdict = yun.sameRhyme === true ? "同部" : yun.sameRhyme === false ? "不同部" : "未定";
  const cls = yun.sameRhyme === true ? "ok" : yun.sameRhyme === false ? "fault" : "muted";
  summary.append(cell(verdict, cls), cell(yun.detail || (yun.rhyme || []).join("、")));
  table.append(summary);
  wrap.append(table);
}

/**
 * @param {string} text
 */
function heading(text) {
  const node = document.createElement("h3");
  node.textContent = text;
  return node;
}

/**
 * @param {string[]} titles
 */
function tableWith(titles) {
  const table = document.createElement("table");
  table.className = "meter-table";
  const head = document.createElement("tr");
  for (const title of titles) head.append(cell(title, "", "th"));
  table.append(head);
  return table;
}

/**
 * @param {string} text
 * @param {string} [className]
 * @param {string} [tag]
 */
function cell(text, className = "", tag = "td") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

/**
 * @param {string} result
 */
function toneClass(result) {
  if (result === "对" || result === "粘") return "ok";
  if (result === "未决" || result === "缺字") return "muted";
  return "fault";
}

async function sendDraft() {
  const text = draftEl.value.trim();
  const current = active();
  if (!text || !current || inFlight) return;

  current.messages.push({ role: "user", content: text });
  current.pending = true;
  current.progress = "正在斟酌";
  current.error = "";
  if (current.title === "新的对话") current.title = clip(text.replace(/\s+/g, ""), 16);
  current.updatedAt = Date.now();
  draftEl.value = "";
  fitDraft();
  inFlight = true;
  sendEl.disabled = true;
  stopEl.hidden = false;
  const controller = new AbortController();
  activeAbort = controller;
  persist();
  render();

  const id = current.id;
  try {
    const data = await chatStream({
      history: current.agentHistory || [],
      text,
      signal: controller.signal,
      onProgress(event) {
        const conversation = state.conversations.find((item) => item.id === id);
        if (!conversation) return;
        conversation.progress = progressLabel(event);
        if (state.activeId === id) render();
      },
    });
    const conversation = state.conversations.find((item) => item.id === id);
    if (!conversation) return;
    conversation.pending = false;
    conversation.progress = "";
    conversation.error = "";
    conversation.agentHistory = Array.isArray(data.history) ? data.history : conversation.agentHistory;
    conversation.messages.push({
      role: "assistant",
      content: data.answer || "",
      presentation: data.presentation || { type: "prose" },
      tools: Array.isArray(data.tools) ? data.tools : [],
    });
    conversation.updatedAt = Date.now();
    persist();
    if (state.activeId === id) render();
  } catch (error) {
    const conversation = state.conversations.find((item) => item.id === id);
    if (!conversation) return;
    conversation.pending = false;
    conversation.progress = "";
    conversation.messages.pop();
    if (!conversation.messages.length) conversation.title = "新的对话";
    if (controller.signal.aborted || error?.name === "AbortError") {
      conversation.error = "已停止。";
    } else {
      conversation.error = error?.message || "页面与本地服务失去联系。";
    }
    draftEl.value = text;
    fitDraft();
    persist();
    if (state.activeId === id) render();
  } finally {
    inFlight = false;
    activeAbort = null;
    sendEl.disabled = false;
    stopEl.hidden = true;
  }
}

/**
 * @param {{ history: object[], text: string, signal: AbortSignal, onProgress: (event: object) => void }} options
 */
async function chatStream({ history, text, signal, onProgress }) {
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ history, text, stream: true }),
    signal,
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "这次没有得到回答。");
  }

  if (!response.body) {
    throw new Error("本地服务没有返回可读的响应流。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let donePayload = null;
  let streamError = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() || "";
    for (const chunk of parts) {
      const parsed = parseSseChunk(chunk);
      if (!parsed) continue;
      if (parsed.event === "progress") {
        onProgress(parsed.data || {});
      } else if (parsed.event === "done") {
        donePayload = parsed.data;
      } else if (parsed.event === "error") {
        streamError = parsed.data?.error || "这次没有得到回答。";
      }
    }
  }

  if (streamError) throw new Error(streamError);
  if (!donePayload) throw new Error("这次没有得到回答。");
  return donePayload;
}

/**
 * @param {string} chunk
 */
function parseSseChunk(chunk) {
  let event = "message";
  const dataLines = [];
  for (const raw of chunk.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (!dataLines.length) return null;
  try {
    return { event, data: JSON.parse(dataLines.join("\n")) };
  } catch {
    return null;
  }
}

/**
 * @param {object} event
 */
function progressLabel(event) {
  if (!event || typeof event !== "object") return "正在斟酌";
  if (event.kind === "tool" && event.name) {
    return `正在${toolLabel(event.name)}`;
  }
  if (event.kind === "tool_done" && event.name) {
    return event.ok === false
      ? `${toolLabel(event.name)}未果，继续…`
      : `已完成${toolLabel(event.name)}`;
  }
  if (event.kind === "round" && event.round) {
    return `第 ${event.round} 轮 · 正在斟酌`;
  }
  if (event.kind === "thought" && event.text) {
    return clip(String(event.text).replace(/\s+/g, " "), 28);
  }
  if (event.kind === "max") {
    return "工具轮次已满，正在收束作答";
  }
  return "正在斟酌";
}

/**
 * @param {string} name
 */
function toolLabel(name) {
  return TOOL_LABELS[name] || name;
}

/**
 * @param {Array<{ name: string, ok?: boolean }>} tools
 */
function toolTrail(tools) {
  const node = document.createElement("p");
  node.className = "tool-trail";
  const labels = tools.map((item) => {
    const label = toolLabel(item.name);
    return item.ok === false ? `${label}（未果）` : label;
  });
  node.textContent = `已调用：${labels.join(" · ")}`;
  return node;
}

function previewOf(conversation) {
  const last = [...(conversation.messages || [])].reverse().find((item) => item.content);
  if (!last) return "尚无消息";
  return clip(last.content.replace(/\s+/g, " ").trim(), 18);
}

function formatTime(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}月${day}日 ${hour}:${minute}`;
}

function clip(text, count) {
  return [...text].slice(0, count).join("");
}

function fitDraft() {
  draftEl.style.height = "auto";
  draftEl.style.height = `${Math.min(draftEl.scrollHeight, 180)}px`;
}
