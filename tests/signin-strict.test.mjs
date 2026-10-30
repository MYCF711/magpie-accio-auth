// 登录失效判定的**收窄**锁 —— 2026-10-30 的事故复盘（docs/internals.md §13）。
//
// 背景一句话：上游在风控限流时，会把 `401 NOT_LOGIN` / `403 auth failed` 回给
// 一个**完全有效**的 token，报文与拿垃圾 token 打过去逐字相同。
// 而 `signIn: "expired"` 的后果是 magpie 把这个号**标死、要人工重登** ——
// 所以判据必须是「上游明说登录没了」，网络错误 / 超时 / 5xx / 429 / 风控 /
// 未知错误**一律不许**走到那条路。
//
// 本文件钉三件事：
//   ① isSignInGone() 的判定表（纯函数）
//   ② 四个钩子路径（usage / models / refresh）在非登录失效错误下绝不返回/抛出 expired
//   ③ 单次「登录失效」不算数 —— 连续两次、隔 ≥1 分钟才标死

import { test } from "node:test"
import assert from "node:assert/strict"

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sandbox = mkdtempSync(join(tmpdir(), "accio-signin-"))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const { AccioAuthPlugin } = await import("../index.mjs")
const { isSignInGone, SignInError, fetchUsage, fetchCatalog } = await import("../src/api.mjs")
const { isTerminalRefreshError, isTransientRefreshError } = await import("../src/login.mjs")
const { toStored } = await import("../src/credential.mjs")
const store = await import("../src/store.mjs")

const CRED = { access_token: "acc01_live", refresh_token: "rr_strict", expires_at: Date.now() + 3600_000, region: "cn" }

let seq = 0
/** 每条约一个独立账号：确认计数是按账号键落盘的，共用会让测试互相污染 */
const freshStored = () => {
  seq += 1
  const cred = { ...CRED, refresh_token: `rr-strict-${seq}-${Date.now()}` }
  return { stored: toStored(cred), key: store.accountKeyOf(cred.refresh_token) }
}

const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } })

const stubFetch = (handler) => {
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => handler(String(input), init)
  return { restore: () => { globalThis.fetch = original } }
}

const hooksOf = async () => AccioAuthPlugin({ client: {} })

// ── ① 纯函数判定表 ─────────────────────────────────────────────────────

test("isSignInGone：只有上游明说登录没了才算（含 2026-10-30 实测的那几条原文）", () => {
  const cases = [
    // 实测的真·登录失效形状 —— 必须判「是」
    [200, { code: "401", message: "NOT_LOGIN" }, true, "entitlement 的实测形态"],
    [200, { code: "403", message: "auth failed" }, true, "catalog 的实测形态"],
    [200, { code: "401" }, true, "只有 401 没有措辞：HTTP 语义就是未认证"],
    [401, {}, true, "HTTP 401 本身"],
    [200, { code: "1001", message: "登录已过期，请重新登录" }, true, "中文措辞"],

    // 实测的风控/限流形状 —— 必须判「不是」
    [200, { code: "555", message: "blocked by sentinel rate limit" }, false, "实测：阿里 sentinel 风控"],
    [200, { code: "429", message: "too many requests" }, false, "限流"],
    [429, { code: "429", message: "rate limit" }, false, "HTTP 限流"],
    [200, { code: "403", message: "rate limit exceeded" }, false, "403 但明说是限流"],
    [200, { code: "403" }, false, "光一个 403：权限/WAF/风控都会回它，不许当登录失效"],
    [200, { code: "402", message: "unauthorized" }, false, "402 是没钱；Accio 对话流里 402 就带 unauthorized 字样"],
    [200, { code: "500", message: "内部错误" }, false, "5xx 代号"],
    [503, {}, false, "HTTP 5xx"],
    [200, { code: "90004", message: "invalid_request" }, false, "未知错误：不猜"],
    [200, {}, false, "空 body"],
    [200, { code: "401", message: "系统繁忙，请稍后重试" }, false, "有 401 但明说稍后重试"],
  ]
  for (const [status, body, want, why] of cases) {
    assert.equal(isSignInGone(status, body), want, `${why}：${JSON.stringify(body)} @ HTTP ${status}`)
  }
})

// ── ② 钩子路径：非登录失效的错误绝不 expired ──────────────────────────

const TRANSIENT_CASES = [
  {
    name: "5xx",
    respond: () => json({ success: false, code: "500", message: "内部错误" }),
  },
  {
    name: "429 限流",
    respond: () => json({ success: false, code: "429", message: "too many requests" }),
  },
  {
    name: "超时（AbortSignal.timeout 的 TimeoutError）",
    respond: () => {
      const e = new Error("The operation was aborted due to timeout")
      e.name = "TimeoutError"
      throw e
    },
  },
  {
    name: "坏 JSON（网关吐 HTML 拦截页）",
    respond: () => new Response("<html>punish</html>", { status: 200, headers: { "content-type": "text/html" } }),
  },
  {
    name: "sentinel 风控（本机实测原文）",
    respond: () => json({ success: false, code: "555", message: "blocked by sentinel rate limit" }),
  },
  {
    name: "未知错误码",
    respond: () => json({ success: false, code: "90004", message: "invalid_request" }),
  },
]

for (const c of TRANSIENT_CASES) {
  test(`usage：${c.name} → 报错但**绝不** signIn expired`, async () => {
    const stub = stubFetch(c.respond)
    try {
      const hooks = await hooksOf()
      const { stored } = freshStored()
      const u = await hooks.auth.usage(async () => stored)
      assert.equal(u.signIn, undefined, `${c.name} 不许标登录失效`)
      assert.ok(typeof u.error === "string" && u.error.length > 0, "要给卡片一个原因")
      assert.deepEqual(u.windows, [])
    } finally {
      stub.restore()
    }
  })

  test(`models：${c.name} → 不抛 signIn expired（回退模型表）`, async () => {
    const stub = stubFetch(c.respond)
    try {
      const hooks = await hooksOf()
      const { stored } = freshStored()
      const models = await hooks.provider.models({ models: {} }, { auth: stored })
      assert.ok(Object.keys(models).length >= 15, `${c.name} 时必须有模型（回退）`)
    } finally {
      stub.restore()
    }
  })

  test(`refresh：${c.name} → 不判终态（交给 magpie 重试，不标死账号）`, async () => {
    const stub = stubFetch(c.respond)
    try {
      const hooks = await hooksOf()
      const { stored } = freshStored()
      await assert.rejects(
        () => hooks.auth.refresh(stored),
        (e) => e.signIn === undefined,
      )
    } finally {
      stub.restore()
    }
  })
}

test("refresh：明说 refresh_token 用过了 → 仍然立刻判终态（这条不能放松）", async () => {
  const stub = stubFetch(() => json({ success: false, code: "invalid_grant", message: "refresh token has been used" }))
  try {
    const hooks = await hooksOf()
    const { stored } = freshStored()
    await assert.rejects(() => hooks.auth.refresh(stored), (e) => e.signIn === "expired")
  } finally {
    stub.restore()
  }
})

test("isTerminalRefreshError：暂时性报错里混进终态字样也不许判终态", () => {
  // 风控/限流的报文里若恰好带了 not_login 字样，旧实现会把它当终态
  assert.equal(isTerminalRefreshError("Accio: 429 too many requests (not_login quota)"), false)
  assert.equal(isTerminalRefreshError("Accio: blocked by sentinel rate limit"), false)
  assert.equal(isTerminalRefreshError("fetch failed"), false)
  assert.equal(isTerminalRefreshError("The operation was aborted due to timeout"), false)
  assert.equal(isTransientRefreshError("blocked by sentinel rate limit"), true)
  // 真正的终态照旧
  assert.equal(isTerminalRefreshError("Accio: invalid_grant"), true)
  assert.equal(isTerminalRefreshError("refresh_token expired"), true)
})

// ── ③ 单次不算数：两次确认 ────────────────────────────────────────────

test("单次登录失效不标死；同一次轮询里的两次也不算数；跨过间隔的第二次才标死", async () => {
  const failures = stubFetch(() => json({ success: false, code: "401", message: "NOT_LOGIN" }))
  try {
    const hooks = await hooksOf()
    const { stored, key } = freshStored()

    const first = await hooks.auth.usage(async () => stored)
    assert.equal(first.signIn, undefined)
    assert.match(first.error, /1\/2/)
    assert.equal(store.signInFailsOf(key), 1)

    // 同一秒内的第二次（比如 models 与 usage 在同一次轮询里各报一次）→ 不许算两次
    const immediate = await hooks.auth.usage(async () => stored)
    assert.equal(immediate.signIn, undefined, "同一次轮询里的两次调用不算两次确认")
    assert.equal(store.signInFailsOf(key), 1)

    // 另一条账：先落一条「两分钟前」的旧账，再报一次 —— 这才是合法的第二次
    const twice = freshStored()
    store.noteSignInGone(twice.key, { now: Date.now() - 120_000 })
    const confirmed = await hooks.auth.usage(async () => twice.stored)
    assert.equal(confirmed.signIn, "expired")
  } finally {
    failures.restore()
  }
})

test("读到干净的一次就把确认计数清零（账号自愈，与 magpie 侧口径一致）", async () => {
  const good = stubFetch(() => json({
    success: true,
    data: { entitlement: { daily: { remaining: 5, used: 5, total: 10 } } },
  }))
  try {
    const hooks = await hooksOf()
    const { stored, key } = freshStored()
    store.noteSignInGone(key, { now: Date.now() - 120_000 })
    assert.equal(store.signInFailsOf(key), 1)
    await hooks.auth.usage(async () => stored)
    assert.equal(store.signInFailsOf(key), 0, "读到干净的一次必须清零")
  } finally {
    good.restore()
  }
})

// ── ④ 显式的登录失效仍然要能判出来（别收窄到判不出真事故） ─────────────

test("fetchUsage / fetchCatalog：实测的真·失效形状仍然抛 SignInError", async () => {
  const a = stubFetch(() => json({ success: false, code: "401", message: "NOT_LOGIN" }))
  try {
    await assert.rejects(() => fetchUsage(CRED), (e) => e instanceof SignInError)
  } finally {
    a.restore()
  }
  const b = stubFetch(() => json({ success: false, code: "403", message: "auth failed" }))
  try {
    await assert.rejects(() => fetchCatalog(CRED), (e) => e instanceof SignInError)
  } finally {
    b.restore()
  }
})
