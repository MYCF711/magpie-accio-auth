// 「无账号才跳转下载，有账号直接走软件登录」（主人 2026-10-30 的口径）。
//
// 「账号」= **本机 Accio 客户端里的登录态**（不是 magpie 账号列表）：
//   有 → authorize() 直接读客户端凭据（0 交互、不弹浏览器）
//   没有 → 打开客户端下载页，并继续等（≤10 分钟）；用户装好登录后同一次点击自动接上
//
// 本文件钉：
//   ① 有账号：opened:true、不调浏览器、callback 直接 success
//   ② 无账号：url=下载页、opened:false、callback 等客户端登录（超时给出可照做的错误）
//   ③ 客户端凭据坏了（读不出 / userinfo 失效）→ 明确告诉用户去客户端重登
//   ④ **绝不在插件加载时读客户端**（#522 review：用户删掉的号会自己回来）

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sandbox = mkdtempSync(join(tmpdir(), "accio-routing-"))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox
process.env.APPDATA = join(sandbox, "Roaming")

const { AccioAuthPlugin } = await import("../index.mjs")
const { DOWNLOAD_PAGE_CN } = await import("../src/constants.mjs")

const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } })

const GOT = {
  credential: {
    access_token: "acc-client",
    refresh_token: "R-client",
    expires_at: Date.now() + 30 * 24 * 3600_000,
    region: "cn",
    sgcookie: "",
  },
  user: { id: "1798677706", routeRegion: "CN" },
}

const deskOf = (over = {}) => ({
  hasDesktopLogin: () => true,
  hasDesktopApp: () => false,
  importDesktopLogin: () => GOT,
  waitForDesktopLogin: async () => true,
  ...over,
})

const hooksOf = async (desk, launcher) => AccioAuthPlugin({ client: {}, desktop: desk, launcher })

function stubUserInfo(ok = true) {
  const original = globalThis.fetch
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/auth/userinfo")) {
      return ok
        ? json({ success: true, data: { userId: "1798677706", maskedMobile: "+86 138****8000" } })
        : json({ success: false, code: "555", message: "blocked by sentinel rate limit" })
    }
    return json({})
  }
  return () => {
    globalThis.fetch = original
  }
}

test("有账号：authorize 直接导入（opened:true、不拉浏览器），callback 返回 success", async () => {
  let launcherCalls = 0
  const hooks = await hooksOf(deskOf(), async () => {
    launcherCalls += 1
    throw new Error("有账号时不该开浏览器")
  })
  const restore = stubUserInfo(true)
  try {
    const got = await hooks.auth.methods[0].authorize()
    assert.equal(got.opened, true, "opened:true 才能让 magpie 不再开系统浏览器")
    assert.match(got.instructions, /正在导入/)
    assert.equal(launcherCalls, 0)

    const res = await got.callback()
    assert.equal(res.type, "success")
    assert.equal(res.accountId, "138****8000", "账号名来自 userinfo 的 maskedMobile")
    assert.equal(JSON.parse(res.access).refresh_token, "R-client")
    assert.equal(res.refresh, "R-client")
  } finally {
    restore()
  }
})

test("有账号但读不出来（文件在、解密失败）→ 明确让用户去客户端重登", async () => {
  const hooks = await hooksOf(deskOf({ importDesktopLogin: () => null }))
  const got = await hooks.auth.methods[0].authorize()
  assert.equal(got.opened, true)
  const res = await got.callback()
  assert.equal(res.type, "failed")
  assert.match(res.error, /没找到本机 Accio 客户端的登录态/)
  assert.match(res.error, /打开 Accio 客户端登录一次/)
})

test("有账号但凭据已失效（userinfo 取不到）→ failed，不写死凭据", async () => {
  const hooks = await hooksOf(deskOf())
  const restore = stubUserInfo(false)
  try {
    const got = await hooks.auth.methods[0].authorize()
    const res = await got.callback()
    assert.equal(res.type, "failed")
    assert.match(res.error, /已经失效/)
    assert.match(res.error, /客户端重新登录/)
  } finally {
    restore()
  }
})

test("装了客户端但还没登录：不重复下载，提示打开客户端登录并等它接上", async () => {
  let waited = 0
  const hooks = await hooksOf(deskOf({
    hasDesktopLogin: () => false,
    hasDesktopApp: () => true,
    waitForDesktopLogin: async () => {
      waited += 1
      return true
    },
  }))
  const restore = stubUserInfo(true)
  try {
    const got = await hooks.auth.methods[0].authorize()
    assert.equal(got.opened, true, "已装客户端：只提示登录，不该再开下载页")
    assert.match(got.instructions, /打开 Accio 客户端登录一次/)
    const res = await got.callback()
    assert.equal(waited, 1)
    assert.equal(res.type, "success")
  } finally {
    restore()
  }
})

test("无账号：authorize 打开下载页（opened:false），不碰客户端、不拉自己的浏览器", async () => {
  let launcherCalls = 0
  const hooks = await hooksOf(deskOf({ hasDesktopLogin: () => false }), async () => {
    launcherCalls += 1
  })
  const got = await hooks.auth.methods[0].authorize()
  assert.equal(got.url, DOWNLOAD_PAGE_CN, "无账号要跳客户端下载页")
  assert.equal(got.opened, false, "下载页不需要登录态，交给 magpie 开系统浏览器")
  assert.match(got.instructions, /下载页/)
  assert.match(got.instructions, /最多等 10 分钟/)
  assert.match(got.instructions, /网页授权/, "要告诉用户想加另一个号走哪条")
  assert.equal(launcherCalls, 0)
})

test("无账号：等到客户端登录（同一次点击）→ 自动导入 success", async () => {
  let waited = 0
  const hooks = await hooksOf(deskOf({
    hasDesktopLogin: () => false,
    waitForDesktopLogin: async (opts) => {
      waited += 1
      assert.equal(opts.timeoutMs, 10 * 60_000, "上限必须是 10 分钟")
      return true
    },
  }))
  const restore = stubUserInfo(true)
  try {
    const got = await hooks.auth.methods[0].authorize()
    const res = await got.callback()
    assert.equal(waited, 1)
    assert.equal(res.type, "success")
    assert.equal(JSON.parse(res.access).refresh_token, "R-client")
  } finally {
    restore()
  }
})

test("无账号：等满 10 分钟没等到 → failed 文案让用户装好登录后再点一次", async () => {
  const hooks = await hooksOf(deskOf({ hasDesktopLogin: () => false, waitForDesktopLogin: async () => false }))
  const got = await hooks.auth.methods[0].authorize()
  const res = await got.callback()
  assert.equal(res.type, "failed")
  assert.match(res.error, /还没检测到 Accio 客户端的登录态/)
  assert.match(res.error, /再点一次/)
})

test("插件加载时绝不读客户端（#522：用户删掉的号不能自己回来）", async () => {
  let touched = 0
  await AccioAuthPlugin({
    client: {},
    desktop: {
      hasDesktopLogin: () => { touched += 1; return true },
      importDesktopLogin: () => { touched += 1; return GOT },
      waitForDesktopLogin: async () => { touched += 1; return true },
    },
  })
  assert.equal(touched, 0, "只有用户点 authorize / callback 时才可以读客户端")
})
