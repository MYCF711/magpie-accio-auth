// 钩子层的语义锁 —— 测的是「magpie 调我们时会不会静默出错」。
//
// 这些不在协议回归里：config 必须有模型、authorize 必须立刻返回、
// refresh 必须返回合并字段、models 的三态降级、额度未登录的形状、
// 签到 vocabulary、chat.headers 的 utdid、loader 的 404 语义。

import { test } from "node:test"
import assert from "node:assert/strict"

import { AccioAuthPlugin } from "../index.mjs"
import { toStored } from "../src/credential.mjs"
import { beginLogin } from "../src/login.mjs"
import { accountKeyOf, noteSignInGone } from "../src/store.mjs"

// ⚠ 测试卫生：把 HOME 指到临时目录再跑（Gyl1219 hub 的同款教训）。
// 否则 utdid / 模型目录快照会写进本机真实的 ~/.cache/magpie —— 每跑一次测试就多几个文件。
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const sandbox = mkdtempSync(join(tmpdir(), "accio-test-"))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox


const CRED = { access_token: "acc01_live", refresh_token: "rr_1", expires_at: Date.now() + 3600_000, region: "cn" }
const STORED = toStored(CRED)

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } })

const stubFetch = (handler) => {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    return handler(String(input), init, calls)
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const hooksOf = async (client = {}) => AccioAuthPlugin({ client })

// ── config ──────────────────────────────────────────────────────────────

test("config：未登录时也有模型（空 = 用户以为没装成）", async () => {
  const hooks = await hooksOf()
  const cfg = {}
  await hooks.config(cfg)
  const provider = cfg.provider?.accio
  assert.ok(provider, "必须声明 provider accio")
  assert.equal(provider.name, "Accio")
  assert.equal(provider.npm, "@ai-sdk/openai-compatible", "对外是 OpenAI 形状（转换在 loader 里）")
  assert.ok(Object.keys(provider.models ?? {}).length >= 15, "config.models 必须有内容")
})

test("config：不覆盖用户在 plugins.json 里配的 provider", async () => {
  const hooks = await hooksOf()
  const cfg = { provider: { accio: { name: "Mine", npm: "x", api: "y", models: { a: {} } } } }
  await hooks.config(cfg)
  assert.equal(cfg.provider.accio.name, "Mine", "必须用 ??= 而不是 =")
})

// ── 登录 ────────────────────────────────────────────────────────────────

test("authorize 立刻返回（不在里面等用户）；url / method / callback 齐全；close 释放端口", async () => {
  const started = await beginLogin({ region: "cn" })
  try {
    assert.match(started.url, /^https:\/\/www\.accio-ai\.com\/login\?/)
    assert.equal(typeof started.result?.then, "function")
  } finally {
    started.close()
  }
})

test("登录的 state 校验：state 不匹配的回调必须被拒（loopback 会被本地进程投毒）", async () => {
  const started = await beginLogin({ region: "cn" })
  const url = new URL(started.url)
  const returnUrl = url.searchParams.get("return_url")
  try {
    const res = await fetch(`${returnUrl}?code=abc&state=wrong`)
    assert.equal(res.status, 400, "state 不对必须 400，不能吞掉 code")
    await assert.rejects(() => started.result, /state 不匹配/)
  } finally {
    started.close()
  }
  // 失败的 result 已经 settles，close 不再改变它
})

// ── refresh ────────────────────────────────────────────────────────────

test("refresh：返回值是**合并**字段（access/refresh/expires/uid 都要给）", async () => {
  const stub = stubFetch(() => json({
    success: true,
    data: { accessToken: "at-new", refreshToken: "rt-new", expiresAt: Math.floor(Date.now() / 1000) + 3600 },
  }))
  try {
    const hooks = await hooksOf()
    const next = await hooks.auth.refresh(STORED)
    assert.equal(JSON.parse(next.access).access_token, "at-new")
    assert.equal(next.refresh, "rt-new", "轮换后的 refresh_token 必须回传")
    assert.ok(next.expires > Date.now() + 3500_000)
    assert.ok(typeof next.uid === "string" && next.uid.length > 0, "uid 必须回传，否则重登会丢账号身份")
  } finally {
    stub.restore()
  }
})

test("refresh：没有 refresh_token → 返回 undefined（不续期，不是失败）", async () => {
  const hooks = await hooksOf()
  const res = await hooks.auth.refresh({ type: "oauth", access: JSON.stringify({ ...CRED, refresh_token: "" }), refresh: "" })
  assert.equal(res, undefined)
})

test("refresh：终态错误 → signIn: expired（magpie 标记账号、不再重试）", async () => {
  const stub = stubFetch(() => json({ success: false, code: "invalid_grant", message: "refresh token has been used" }))
  try {
    const hooks = await hooksOf()
    await assert.rejects(
      () => hooks.auth.refresh(STORED),
      (e) => e.signIn === "expired",
    )
  } finally {
    stub.restore()
  }
})

// ── provider.models 三态 ───────────────────────────────────────────────

test("models：没登录 → 静态表（不是空表）", async () => {
  const hooks = await hooksOf()
  const models = await hooks.provider.models({ models: {} }, { auth: undefined })
  assert.ok(Object.keys(models).length >= 15)
})

test("models：上游失败 → 回退（不抛，不返回空表）", async () => {
  const stub = stubFetch(() => json({ success: false, code: "500", message: "boom" }))
  try {
    const hooks = await hooksOf()
    // ⚠ 用独立的 refresh_token：每个账号有自己的目录快照（per-account），
    //   复用同一个会让别的测试写下的快照影响这条断言 —— 本身就是坑 16 的形态。
    const fresh = { ...STORED, access: JSON.stringify({ ...CRED, refresh_token: `rr-fail-${Date.now()}` }) }
    const models = await hooks.provider.models({ models: {} }, { auth: fresh })
    assert.ok(Object.keys(models).length >= 15, "接口失败不能把卡片弄空")
  } finally {
    stub.restore()
  }
})

test("models：登录失效**连续两次**才抛 signIn: expired（第一次只报错、不标死账号）", async () => {
  const stub = stubFetch(() => json({ success: false, code: "401", message: "NOT_LOGIN" }))
  try {
    const hooks = await hooksOf()
    // ① 单次：只回退，不抛
    const single = { ...STORED, access: JSON.stringify({ ...CRED, refresh_token: `rr-lapse-models-1-${Date.now()}` }) }
    const models = await hooks.provider.models({ models: {} }, { auth: single })
    assert.ok(Object.keys(models).length >= 15, "第一次报失效不能打死账号，也不能把模型表弄空")

    // ② 同一账号已经有一条「一分钟前」的旧账 → 这次就是连续第二次，才允许标死
    const twice = { ...STORED, access: JSON.stringify({ ...CRED, refresh_token: `rr-lapse-models-2-${Date.now()}` }) }
    noteSignInGone(accountKeyOf(JSON.parse(twice.access).refresh_token), { now: Date.now() - 120_000 })
    await assert.rejects(
      () => hooks.provider.models({ models: {} }, { auth: twice }),
      (e) => e.signIn === "expired",
    )
  } finally {
    stub.restore()
  }
})

test("models：成功 → 目录里的模型可枚举，且都带 input.image 布尔", async () => {
  const stub = stubFetch(() => json({
    success: true,
    data: [{ modelList: [
      { modelCode: "1Drift-AAA", modelDisplayName: "Qwen 3.8 Flash", visible: true, contextWindow: 1_000_000, effectiveMultiple: 0.03, multimodal: true },
      { modelCode: "1Chronos-BBB", modelDisplayName: "GLM 5.3 Flash", visible: true, contextWindow: 1_000_000, effectiveMultiple: 0.03, multimodal: false },
    ] }],
  }))
  try {
    const hooks = await hooksOf()
    // 独立 refresh_token：目录快照按账号落盘，别让别的测试读到这条写下的快照
    const fresh = { ...STORED, access: JSON.stringify({ ...CRED, refresh_token: `rr-ok-${Date.now()}` }) }
    const models = await hooks.provider.models({ models: {} }, { auth: fresh })
    assert.deepEqual(Object.keys(models), ["qwen-3-8-flash", "glm-5-3-flash"])
    assert.equal(models["qwen-3-8-flash"].capabilities.input.image, true)
    assert.equal(models["glm-5-3-flash"].capabilities.input.image, false, "text-only 必须显式 false")
    assert.equal(models["qwen-3-8-flash"].rate, "x0.03")
  } finally {
    stub.restore()
  }
})

// ── usage ──────────────────────────────────────────────────────────────

test("usage：未登录 → error + 空 windows（不是抛异常）", async () => {
  const hooks = await hooksOf()
  const u = await hooks.auth.usage(async () => undefined)
  assert.equal(u.error, "未登录")
  assert.deepEqual(u.windows, [])
})

test("usage：登录失效**连续两次**才 signIn expired（第一次只报错、不标死账号）", async () => {
  const stub = stubFetch(() => json({ success: false, code: "401", message: "NOT_LOGIN" }))
  try {
    const hooks = await hooksOf()
    // ① 单次：不许标 expired —— 风控/限流会伪装成 401 NOT_LOGIN
    const single = { ...STORED, access: JSON.stringify({ ...CRED, refresh_token: `rr-lapse-usage-1-${Date.now()}` }) }
    const first = await hooks.auth.usage(async () => single)
    assert.equal(first.signIn, undefined, "单次 401 不许标 expired")
    assert.match(first.error, /1\/2/, "要让用户看见「第 1/2 次确认」")
    assert.deepEqual(first.windows, [])

    // ② 同一账号已有「一分钟前」的旧账 → 这次是连续第二次，才判 expired
    const twice = { ...STORED, access: JSON.stringify({ ...CRED, refresh_token: `rr-lapse-usage-2-${Date.now()}` }) }
    noteSignInGone(accountKeyOf(JSON.parse(twice.access).refresh_token), { now: Date.now() - 120_000 })
    const second = await hooks.auth.usage(async () => twice)
    assert.equal(second.signIn, "expired")
    assert.ok(typeof second.error === "string")
  } finally {
    stub.restore()
  }
})

// ── checkin ────────────────────────────────────────────────────────────

test("checkin：Accio 没有每日签到 → inactive（不是 failed）", async () => {
  const hooks = await hooksOf()
  const r = await hooks.auth.checkin(async () => STORED)
  assert.equal(r.outcome, "inactive")
  assert.match(r.message ?? "", /无每日签到/)
})

// ── chat.headers ───────────────────────────────────────────────────────

test("chat.headers：补 utdid（阿里网关的风控基线）；不是本 provider 就什么都不做", async () => {
  const hooks = await hooksOf()
  const output = { headers: {} }
  await hooks["chat.headers"]({ model: { providerID: "accio" } }, output)
  assert.ok(output.headers.utdid?.startsWith("accio-"))

  const untouched = { headers: {} }
  await hooks["chat.headers"]({ model: { providerID: "other" } }, untouched)
  assert.equal(untouched.headers.utdid, undefined)
})

// ── loader ─────────────────────────────────────────────────────────────

test("loader：没凭据 → 返回 {}（交给 magpie 按「没有可用凭据」处理）", async () => {
  const hooks = await hooksOf()
  assert.deepEqual(await hooks.auth.loader(async () => undefined), {})
})

test("loader：拿不到 model 的请求返回 404（只搁置这个模型，不打死整个账号）", async () => {
  const hooks = await hooksOf()
  const loader = await hooks.auth.loader(async () => STORED)
  const res = await loader.fetch("https://accio.invalid/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ messages: [] }),
  })
  assert.equal(res.status, 404)
  const body = await res.json()
  assert.match(body.error.message, /无法识别的请求/)
})

test("loader：完整往返（OpenAI 请求 → 上游 SSE → OpenAI chunk 流）", async () => {
  const stub = stubFetch(() => new Response(
    `data: ${JSON.stringify({ content: { role: "model", parts: [{ text: "hi" }] }, turn_complete: true, usage_metadata: { total_token_count: 3 } })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  ))
  try {
    const hooks = await hooksOf()
    const loader = await hooks.auth.loader(async () => STORED)
    const res = await loader.fetch("https://accio.invalid/v1/chat/completions", {
      method: "POST",
      headers: { utdid: "accio-from-chat-headers" },
      body: JSON.stringify({ model: "qwen-3-8-flash", messages: [{ role: "user", content: "hi" }], stream: true }),
    })
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/)
    const text = await res.text()
    assert.match(text, /"content":"hi"/)
    assert.match(text, /data: \[DONE\]/)
    // chat.headers 带下来的 utdid 必须真的进上游请求头
    const sent = stub.calls.at(-1).init.headers
    assert.equal(sent.utdid, "accio-from-chat-headers")
  } finally {
    stub.restore()
  }
})