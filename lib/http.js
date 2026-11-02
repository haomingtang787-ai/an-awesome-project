/**
 * 本机 HTTP 小封装。用 Node 自带 fetch，不再依赖 axios。
 */

/**
 * @param {AbortSignal | undefined} outer
 * @param {number} timeoutMs
 * @returns {{ signal: AbortSignal, cancel: () => void, timedOut: () => boolean }}
 */
function withTimeout(outer, timeoutMs) {
  const ac = new AbortController();
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort(Object.assign(new Error("等待响应超时。"), { name: "TimeoutError", code: "ETIMEDOUT" }));
  }, timeoutMs);

  const onAbort = () => {
    ac.abort(outer?.reason || Object.assign(new Error("请求已取消。"), { name: "AbortError" }));
  };

  if (outer) {
    if (outer.aborted) onAbort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: ac.signal,
    timedOut: () => timedOut,
    cancel() {
      clearTimeout(timer);
      if (outer) outer.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string, string>, body?: unknown, signal?: AbortSignal, timeoutMs?: number }} [options]
 * @returns {Promise<{ status: number, data: unknown }>}
 */
export async function requestJson(url, options = {}) {
  const method = options.method || "GET";
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 30000;
  const scoped = withTimeout(options.signal, timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: scoped.signal,
    });

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    return { status: response.status, data };
  } catch (error) {
    if (options.signal?.aborted) {
      throw Object.assign(new Error("请求已取消。"), { name: "AbortError" });
    }
    if (scoped.timedOut() || (error && (error.name === "TimeoutError" || error.code === "ETIMEDOUT"))) {
      throw Object.assign(new Error("等待响应超时。"), { name: "TimeoutError", code: "ETIMEDOUT" });
    }
    if (error && error.name === "AbortError") {
      throw Object.assign(new Error("请求已取消。"), { name: "AbortError" });
    }
    const code = error && typeof error.cause?.code === "string" ? error.cause.code : error?.code;
    if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "EAI_AGAIN") {
      throw Object.assign(new Error(`无法连接服务（${code}）。`), { name: "NetworkError", code });
    }
    throw error instanceof Error ? error : new Error(String(error));
  } finally {
    scoped.cancel();
  }
}
