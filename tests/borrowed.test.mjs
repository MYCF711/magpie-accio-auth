// 从 Gyl1219/magpie-providers-hub 借鉴的三处改进的回归：
//   ① 传输级重试（只重试连接类错误；4xx/5xx 不重试；abort 不重试）
//   ② 日期字符串的过期解析（`Number("2026-10-28 03:37:02")` = NaN 的真机坑）
//   ③ loader 临期软续期（失败沿用原凭据，硬失效由 chat 的 401 兜底）
// 另加：同 provider 两个账号并发续期不串号（hub pool.test 的同款语义）。

import { test } from "node:test"
import assert from "node:assert/strict"

import { accioExpiresAtMs, toStored } from "../src/credential.mjs"
import { fetchWithRetry, isTransportError } from "../src/transport.mjs"
import { refreshOnce } from "../src/login.mjs"
import { fetchUsage } from "../src/api.mjs"
import { AccioAuthPlugin } from "../index.mjs"

// ⚠ 测试卫生：把 HOME 指到临时目录再跑（Gyl1219 hub 的同款教训）。
// 否则 utdid / 模型目录快照会写进本机真实的 ~/.cache/magpie —— 每跑一次测试就多几个文件。
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const sandbox = mkdtempSync(join(tmpdir(), "accio-test-"))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox


const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } })

const sse = (frames) => new Response(
  frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } },
)

const err = (code, message = "boom") => Object.assign(new Error(message), { code })

// ── ① 传输级重试 ────────────────────────────────────────────────────────

test("isTransportError：连接类错误 true，HTTP 类错误 false（沿 cause 链）", () => {
  assert.equal(isTransportError(err("ECONNRESET")), true)
  assert.equal(isTransportError(err("ENOTFOUND")), true)
  assert.equal(isTransportError(Object.assign(new Error("fetch failed"), { cause: err("ECONNREFUSED") })), true)
  assert.equal(isTransportError(new Error("HTTP 401 unauthorized")), false)
  assert.equal(isTransportError(new Error("额度或认证失败")), false)
  assert.equal(isTransportError(null), false)
})

test("fetchWithRetry：ECONNRESET 重试 2 次后成功；第三次用尽抛最后一个错", async () => {
  let calls = 0
  const flaky = async () => {
    calls += 1
    if (calls < 3) throw err("ECONNRESET")
    return "ok"
  }
  assert.equal(await fetchWithRetry(flaky, undefined, 2), "ok")
  assert.equal(calls, 3, "2 次重试 = 最多 3 次调用")

  calls = 0
  const dead = async () => { calls += 1; throw err("ECONNREFUSED") }
  await assert.rejects(() => fetchWithRetry(dead, undefined, 2), /boom/)
  assert.equal(calls, 3)
})

test("fetchWithRetry：4xx/5xx 不重试（重发只会原样失败且掩盖真因）", async () => {
  let calls = 0
  const reject = async () => { calls += 1; throw new Error("HTTP 500 upstream") }
  await assert.rejects(() => fetchWithRetry(reject, undefined, 2), /HTTP 500/)
  assert.equal(calls, 1, "非传输错误必须一次就抛")

  calls = 0
  const auth = async () => { calls += 1; throw new Error("HTTP 401 unauthorized") }
  await assert.rejects(() => fetchWithRetry(auth, undefined, 2), /401/)
  assert.equal(calls, 1)
})

test("fetchWithRetry：已 abort 的 signal 绝不重试", async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const f = async () => { calls += 1; throw err("ECONNRESET") }
  await assert.rejects(() => fetchWithRetry(f, controller.signal, 2))
  assert.equal(calls, 1)
})

// ── ② 日期字符串解析 ────────────────────────────────────────────────────

test("accioExpiresAtMs：ISO / 厂商空格格式 / 秒级数字 / 毫秒数字 全部归一", () => {
  assert.equal(accioExpiresAtMs(1792872000), 1792872000000, "秒 → 毫秒")
  assert.equal(accioExpiresAtMs(1792872000000), 1792872000000, "毫秒原样")
  assert.equal(accioExpiresAtMs("1792872000"), 1792872000000, "数字字符串按秒")
  assert.equal(accioExpiresAtMs("2026-10-28T03:37:02.000Z"), Date.parse("2026-10-28T03:37:02.000Z"))
  assert.equal(accioExpiresAtMs("2026-10-28 03:37:02"), new Date(2026, 9, 28, 3, 37, 2).getTime(), "厂商原样格式不能走到 NaN")
  assert.equal(accioExpiresAtMs(""), undefined)
  assert.equal(accioExpiresAtMs("not-a-date"), undefined)
  assert.equal(accioExpiresAtMs(0), undefined)
})

test("过期判据：日期字符串到期 → nearExpiry 为真（旧实现会判「1970 年」或 NaN）", async () => {
  const { nearExpiry } = await import("../src/credential.mjs")
  const past = { access_token: "a", refresh_token: "r", expires_at: accioExpiresAtMs("2020-01-01 00:00:00") }
  assert.equal(nearExpiry(past, 60_000), true)
  const future = { access_token: "a", refresh_token: "r", expires_at: accioExpiresAtMs("2099-01-01 00:00:00") }
  assert.equal(nearExpiry(future, 60_000), false)
})

// ── ③ loader 临期软续期 ─────────────────────────────────────────────────

test("loader：凭据临期 → 先续期再用新 token 发对话（续期失败才沿用旧凭据）", async () => {
  const oldCred = {
    access_token: "old-token",
    refresh_token: "rt-old",
    // 已经过期（临期窗口内）
    expires_at: Date.now() - 1000,
    region: "cn",
  }
  const stored = toStored(oldCred)
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, body: init?.body })
    if (url.includes("/api/auth/refresh_token")) {
      return json({
        success: true,
        data: { accessToken: "new-token", refreshToken: "rt-new", expiresAt: Math.floor(Date.now() / 1000) + 3600 },
      })
    }
    if (url.includes("/api/adk/llm/generateContent")) {
      return sse([{ content: { role: "model", parts: [{ text: "ok" }] }, turn_complete: true }])
    }
    return json({})
  }
  try {
    const hooks = await AccioAuthPlugin({ client: {} })
    const loader = await hooks.auth.loader(async () => stored)
    const res = await loader.fetch("https://accio.invalid/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "qwen-3-8-flash", messages: [{ role: "user", content: "hi" }], stream: true }),
    })
    await res.text()
    assert.ok(calls.some((c) => c.url.includes("/api/auth/refresh_token")), "临期必须先续期一次")
    const gen = calls.find((c) => c.url.includes("/api/adk/llm/generateContent"))
    assert.equal(JSON.parse(gen.body).token, "new-token", "对话必须用续期后的新 token")
  } finally {
    globalThis.fetch = original
  }
})

// ── ④ 同 provider 多账号并发续期不串号 ─────────────────────────────────

test("refreshOnce：同一 refresh_token 的并发续期只发一次（一次性 token 不被消费两次）", async () => {
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes("/api/auth/refresh_token")) {
      calls += 1
      const body = JSON.parse(init.body)
      await new Promise((r) => setTimeout(r, 20)) // 拉长窗口，确保并发
      return json({
        success: true,
        data: { accessToken: `at-${body.refreshToken}`, refreshToken: `${body.refreshToken}-next`, expiresAt: Math.floor(Date.now() / 1000) + 3600 },
      })
    }
    return json({})
  }
  try {
    const base = { access_token: "at", expires_at: Date.now() + 3600_000 }
    const [a, b] = await Promise.all([
      refreshOnce({ ...base, refresh_token: "same-rt" }),
      refreshOnce({ ...base, refresh_token: "same-rt" }),
    ])
    assert.equal(calls, 1, "同一 refresh_token 并发 → 只消费一次")
    assert.equal(a.access_token, "at-same-rt")
    assert.equal(b.access_token, "at-same-rt")
  } finally {
    globalThis.fetch = original
  }
})

test("refreshOnce：不同 refresh_token（同 provider 两个账号）各自消费一次、结果不串号", async () => {
  const consumed = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.includes("/api/auth/refresh_token")) {
      const body = JSON.parse(init.body)
      consumed.push(body.refreshToken)
      return json({
        success: true,
        data: { accessToken: `at-${body.refreshToken}`, refreshToken: `${body.refreshToken}-next`, expiresAt: Math.floor(Date.now() / 1000) + 3600 },
      })
    }
    return json({})
  }
  try {
    const base = { access_token: "at", expires_at: Date.now() + 3600_000 }
    const [a, b] = await Promise.all([
      refreshOnce({ ...base, refresh_token: "RT-A" }),
      refreshOnce({ ...base, refresh_token: "RT-B" }),
    ])
    assert.deepEqual(consumed.sort(), ["RT-A", "RT-B"], "两个账号各消费一次，谁都不能共享对方的结果")
    assert.equal(a.access_token, "at-RT-A")
    assert.equal(b.access_token, "at-RT-B")
  } finally {
    globalThis.fetch = original
  }
})

// ── ⑤ 额度 display（magpie 一定渲染的兜底）─────────────────────────────

test("fetchUsage：display 说「剩余 / 总量」与每日刷新时刻（结构化字段可能被 quotas.json 丢掉）", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/api/entitlement/currentSubscription")) {
      return json({
        success: true,
        data: { entitlement: { daily: { remaining: 250, used: 50, total: 300 } } },
      })
    }
    if (url.includes("/api/entitlement/quota")) return json({ success: true, data: { refreshCountdownSeconds: 86400 } })
    return json({})
  }
  try {
    const usage = await fetchUsage({ access_token: "at", refresh_token: "rt", expires_at: Date.now() + 3600_000 })
    assert.equal(usage.windows[0].display.startsWith("剩余 250 / 300"), true)
    assert.match(usage.windows[0].display, /\d{2}:\d{2} 刷新$/, "刷新时刻要写进 display（不依赖可能被丢的 resetsAt）")
    assert.ok(usage.windows[0].resetsAt, "结构化 resetsAt 仍要给")
  } finally {
    globalThis.fetch = original
  }
})