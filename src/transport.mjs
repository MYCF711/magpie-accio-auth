// 传输级重试 —— 移植自 Gyl1219/magpie-providers-hub 的 `src/minimax-transport.mjs`（MIT）。
//
// 只重试**传输层**错误（连接没建立 / socket 断开 / DNS 失败）；4xx/5xx 是服务端的
// 明确答复（401 要续期、402 要充值、429 要冷却），重发只会原样失败且掩盖真因。
// ⚠ `signal` 被 abort 时绝不重试。
// ⚠ 本函数只管「请求发出前 / 响应头到达前」的失败；SSE 流开始后的错误在生成器里抛。

// ── 实现 ─────────────────────────────────────────────────────────
//
// 移植自 Gyl1219/magpie-providers-hub 的 `src/minimax-transport.mjs`（MIT）：
// 只重试**传输层**错误（连接没建立 / socket 断开 / DNS 失败）。4xx/5xx 是服务端的
// 明确答复（401 要续期、402 要充值、429 要冷却），重发只会原样失败且掩盖真因。
//
// ⚠ `signal` 被 abort 时绝不重试。
// ⚠ 本函数只管「请求发出前 / 响应头到达前」的失败；SSE 流开始后的错误在生成器里抛。

/** 该错误是否为传输级（沿 cause 链找真因：undici 把底层错误包成 `fetch failed`）。 */
export function isTransportError(error) {
  const seen = new Set()
  let current = error
  for (let depth = 0; current !== null && current !== undefined && depth < 6; depth += 1) {
    if (seen.has(current)) break
    seen.add(current)
    if (typeof current !== "object") break
    const name = typeof current.name === "string" ? current.name : ""
    const message = typeof current.message === "string" ? current.message.toLowerCase() : ""
    const code = typeof current.code === "string" ? current.code : ""
    if (name.startsWith("UND_ERR_") || code.startsWith("UND_ERR_")) return true
    if (code.startsWith("SELF_SIGNED_CERT") || code.startsWith("CERT_")
      || code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return true
    if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EPIPE"
      || code === "ETIMEDOUT" || code === "ENOTFOUND" || code === "EAI_AGAIN") return true
    if (message.includes("fetch failed")) return true
    if (message.includes("socket hang up") || message.includes("terminated")
      || message.includes("other side closed")) return true
    current = current.cause
  }
  return false
}

const sleep = (ms) => (ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)))

/** 传输级重试：2 次、400ms 指数退避；abort 绝不重试；耗尽抛最后的错误。 */
export async function fetchWithRetry(fetchOnce, signal, retries = 2) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetchOnce()
    } catch (error) {
      lastError = error
      if (signal?.aborted === true) throw error
      if (!isTransportError(error)) throw error
      if (attempt === retries) break
      await sleep(400 * 2 ** attempt)
    }
  }
  throw lastError
}

