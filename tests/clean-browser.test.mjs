// 「添加账号」必须落到一个**干净 profile** 的浏览器窗口 —— 2026-10-30 主人投诉的第二条：
// 「添加账号时的浏览器不应该调用能读到 user 登录态的浏览器」。
//
// 这条路径原来回的是 `{url, method:"auto"}` ⇒ **magpie 拿 url 开系统默认浏览器**，
// 那个浏览器里带着用户日常的 Accio 会话，于是「添加账号」直接落到已经登录的号上。
//
// 现在：插件自己 `spawn` 一个 `--user-data-dir=<一次性目录>` 的窗口，并回 `opened: true`
// 让 magpie 别再开一遍。本文件钉住四件事：
//   ① 参数里必须有 `--user-data-dir`（这是「纯净」的全部要害）
//   ② 找不到浏览器 → **明确报错**，绝不静默退回系统浏览器
//   ③ 用户中途关窗 → 立刻给出「窗口已关闭」，不干等 10 分钟超时
//   ④ 窗口只属于本次登录：用完/失败都关掉、一次性 profile 目录随之删掉

import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sandbox = mkdtempSync(join(tmpdir(), "accio-browser-"))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const { AccioAuthPlugin } = await import("../index.mjs")
const browser = await import("../src/browser.mjs")

/** 假浏览器进程：能 emit('exit')，能被 kill() */
function fakeChild() {
  const child = new EventEmitter()
  child.pid = 4242
  child.killed = false
  child.kill = () => {
    child.killed = true
  }
  return child
}

const fakeSpawn = (child) => {
  const calls = []
  const spawnFn = (exe, args, opts) => {
    calls.push({ exe, args, opts })
    return child
  }
  spawnFn.calls = calls
  return spawnFn
}

// ── ① 候选表与「找不到浏览器」 ─────────────────────────────────────────

test("候选表：Chrome/Chromium 在前、Edge 在最后；Edge 的两个落盘名都留着", () => {
  const list = browser.browserCandidates("win32", {
    PROGRAMFILES: "C:\\Program Files",
    "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
    LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local",
    APPDATA: "C:\\Users\\x\\AppData\\Roaming",
    USERPROFILE: "C:\\Users\\x",
  })
  const names = list.map((c) => c.name)
  assert.equal(names[0], "Chrome", "首选 Chrome：没有企业策略、没有强制登录")
  assert.equal(names.at(-1), "Edge", "Edge 放最后：策略最多、最容易被拦住")
  const edgePaths = list.filter((c) => c.name === "Edge").map((c) => c.path)
  assert.ok(edgePaths.some((p) => p.endsWith("Microsoft Edge.exe")), "微软落盘名可能带空格")
  assert.ok(edgePaths.some((p) => p.endsWith("msedge.exe")), "老装法是 msedge.exe，两个都要留")
})

test("findBrowser：按顺序挑第一个真实存在的；一个都没有返回 null", () => {
  const candidates = [
    { name: "Chrome", path: "C:\\nope\\chrome.exe" },
    { name: "Chromium", path: "C:\\yes\\chrome.exe" },
    { name: "Edge", path: "C:\\yes\\msedge.exe" },
  ]
  const found = browser.findBrowser({ candidates, exists: (p) => p === "C:\\yes\\chrome.exe" })
  assert.equal(found.name, "Chromium")
  assert.equal(browser.findBrowser({ candidates, exists: () => false }), null)
})

test("没找到浏览器：报错文案里要有「装什么」和「找过哪些路径」", () => {
  const msg = browser.noBrowserMessage([{ name: "Chrome", path: "C:\\x\\chrome.exe" }])
  assert.match(msg, /没找到可用的 Chromium 内核浏览器/)
  assert.match(msg, /Chrome/)
  assert.ok(msg.includes("C:\\x\\chrome.exe"), `报错里要列找过的路径，实际：${msg}`)
})

test("launchLoginBrowser：没有浏览器 → 抛错（**不静默退回系统浏览器**）", async () => {
  await assert.rejects(
    () => browser.launchLoginBrowser("https://www.accio-ai.com/login", { exists: () => false, baseDir: sandbox }),
    (e) => /没找到可用的 Chromium 内核浏览器/.test(e.message),
  )
})

// ── ② 参数里的纯净 profile ─────────────────────────────────────────────

test("launchLoginBrowser：参数里必须有 --user-data-dir 指向一次性目录，且 URL 在最后", async () => {
  const child = fakeChild()
  const spawnFn = fakeSpawn(child)
  const url = "https://www.accio-ai.com/login?state=abc"
  const session = await browser.launchLoginBrowser(url, {
    candidates: [{ name: "Chrome", path: "C:\\chrome.exe" }],
    exists: () => true,
    spawnFn,
    baseDir: sandbox,
    platform: "linux",
  })
  const [call] = spawnFn.calls
  assert.equal(call.exe, "C:\\chrome.exe")
  const udd = call.args.find((a) => a.startsWith("--user-data-dir="))
  assert.ok(udd, "没有 --user-data-dir 就会用用户日常 profile —— 这正是要修的 bug")
  assert.equal(udd, `--user-data-dir=${session.profileDir}`)
  assert.ok(call.args.includes("--no-first-run"), "干净窗口不该弹首启引导")
  assert.equal(call.args.at(-1), url, "URL 必须最后给")
  assert.ok(existsSync(session.profileDir), "一次性 profile 目录要先建出来")
  assert.ok(session.profileDir.startsWith(join(sandbox, browser.PROFILE_PREFIX)))
  session.close()
})

test("每次登录一个独立 profile 目录（复用目录 = 第二次登录读到上一次的会话）", async () => {
  const mk = async () => {
    const child = fakeChild()
    const s = await browser.launchLoginBrowser("https://x/login", {
      candidates: [{ name: "Chrome", path: "C:\\chrome.exe" }],
      exists: () => true,
      spawnFn: fakeSpawn(child),
      baseDir: sandbox,
      platform: "linux",
    })
    return s
  }
  const a = await mk()
  const b = await mk()
  assert.notEqual(a.profileDir, b.profileDir)
  a.close()
  b.close()
})

test("sweepProfiles：只删过期的、自己造的那些目录；别的文件一概不碰", () => {
  const base = mkdtempSync(join(tmpdir(), "accio-sweep-"))
  const old = join(base, `${browser.PROFILE_PREFIX}old`)
  const fresh = join(base, `${browser.PROFILE_PREFIX}fresh`)
  const other = join(base, "magicrew-login-someone-else")
  for (const d of [old, fresh, other]) mkdirSync(d, { recursive: true })
  const past = new Date(Date.now() - 3 * 3600_000)
  utimesSync(old, past, past)
  utimesSync(other, past, past)

  const removed = browser.sweepProfiles({ baseDir: base, maxAgeMs: 2 * 3600_000 })
  assert.equal(removed, 1, "只该删掉那一个过期的本插件 profile")
  assert.equal(existsSync(old), false)
  assert.equal(existsSync(fresh), true, "没过期的不动（可能正有账号在登）")
  assert.equal(existsSync(other), true, "别的插件的目录不许碰")
  rmSync(base, { recursive: true, force: true })
})

test("spawn 直接抛错 → 明确报错，并且把刚建的 profile 目录收拾掉", async () => {
  const before = new Set(readdirSync(sandbox))
  await assert.rejects(
    () => browser.launchLoginBrowser("https://x/login", {
      candidates: [{ name: "Chromium", path: "C:\\chrome.exe" }],
      exists: () => true,
      spawnFn: () => {
        throw new Error("EPERM")
      },
      baseDir: sandbox,
      platform: "linux",
    }),
    (e) => /浏览器进程起不来/.test(e.message) && /Chromium/.test(e.message),
  )
  const added = readdirSync(sandbox).filter(
    (n) => n.startsWith(browser.PROFILE_PREFIX) && !before.has(n) && statSync(join(sandbox, n)).isDirectory(),
  )
  assert.deepEqual(added, [], "起不来就不许留下垃圾 profile")
})

test("exit：进程退出时兑现；close() 杀进程并删掉一次性目录", async () => {
  const child = fakeChild()
  const session = await browser.launchLoginBrowser("https://x/login", {
    candidates: [{ name: "Chrome", path: "C:\\chrome.exe" }],
    exists: () => true,
    spawnFn: fakeSpawn(child),
    baseDir: sandbox,
    platform: "linux",
  })
  const seen = session.exit
  child.emit("exit", 0, null)
  const info = await seen
  assert.equal(info.code, 0)
  assert.equal(info.signal, null)
  assert.ok(Number.isFinite(info.ms), "exit 里要带「活了多久」，登录层据此区分秒退与用户关窗")
  assert.equal(existsSync(session.profileDir), false, "窗口关了，一次性 profile 也要没")

  const child2 = fakeChild()
  const s2 = await browser.launchLoginBrowser("https://x/login", {
    candidates: [{ name: "Chrome", path: "C:\\chrome.exe" }],
    exists: () => true,
    spawnFn: fakeSpawn(child2),
    baseDir: sandbox,
    platform: "linux",
  })
  s2.close()
  assert.equal(child2.killed, true)
  assert.equal(existsSync(s2.profileDir), false)
})

// ── ③ 「添加账号」这条路真的用到它 ─────────────────────────────────────

const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } })

test("authorize：自己开浏览器（opened: true），不再把 url 交给 magpie 用系统浏览器打开", async () => {
  const child = fakeChild()
  let openedUrl = null
  const launcher = async (url) => {
    openedUrl = url
    return { name: "Chrome", profileDir: join(sandbox, "fake"), exit: new Promise(() => {}), close: () => {}, child }
  }
  const hooks = await AccioAuthPlugin({ client: {}, launcher })
  const method = hooks.auth.methods.find((m) => m.label.includes("登录 Accio"))
  const got = await method.authorize({ region: "cn" })
  try {
    assert.equal(got.opened, true, "opened: true 才会让 magpie 不再开一遍系统浏览器")
    assert.equal(got.method, "auto")
    assert.ok(got.url.includes("return_url="), "回环回调还在")
    assert.equal(openedUrl, got.url, "交给浏览器的必须是我们自己那条授权 URL")
    assert.match(openedUrl, /^https:\/\/www\.accio-ai\.com\/login\?/)
    assert.match(got.instructions, /Chrome/)
    assert.match(got.instructions, /全新窗口/)
    assert.equal(typeof got.callback, "function")

    // 收尾：投一个 state 不匹配的回调，让回环端口释放（否则这个 http 服务会一直挂着）
    const loopback = new URL(got.url).searchParams.get("return_url")
    await fetch(`${loopback}?code=x&state=wrong`)
    await got.callback().catch(() => {})
  } finally {
    // 保持 lint 安静：断言完就没什么可做的了
  }
})

test("authorize：拉不起浏览器 → 抛错，不静默退回系统浏览器", async () => {
  const launcher = async () => {
    throw new Error("没能自己拉起浏览器登录：本机没找到可用的 Chromium 内核浏览器。")
  }
  const hooks = await AccioAuthPlugin({ client: {}, launcher })
  const method = hooks.auth.methods.find((m) => m.label.includes("登录 Accio"))
  await assert.rejects(() => method.authorize({ region: "cn" }), /没找到可用的 Chromium 内核浏览器/)
})

test("用户中途关窗 → callback 立刻回失败原因（不干等 10 分钟超时）", async () => {
  let fireExit
  const exit = new Promise((r) => {
    fireExit = r
  })
  const closed = { v: false }
  const launcher = async () => ({
    name: "Edge",
    profileDir: join(sandbox, "fake2"),
    exit,
    close: () => {
      closed.v = true
    },
  })
  const hooks = await AccioAuthPlugin({ client: {}, launcher })
  const method = hooks.auth.methods.find((m) => m.label.includes("登录 Accio"))
  const got = await method.authorize({ region: "cn" })
  fireExit({ code: 0, signal: null, ms: 45_000 })
  const res = await got.callback()
  assert.equal(res.type, "failed")
  assert.match(res.error, /登录窗口已关闭/)
  assert.match(res.error, /重新发起登录/)
  assert.equal(closed.v, true, "失败也要把窗口收掉")
})

test("窗口一起来就秒退 → 提示「换个浏览器」，而不是怪用户关窗", async () => {
  let fireExit
  const exit = new Promise((r) => {
    fireExit = r
  })
  const launcher = async () => ({ name: "360浏览器", profileDir: join(sandbox, "fake-quick"), exit, close: () => {} })
  const hooks = await AccioAuthPlugin({ client: {}, launcher })
  const method = hooks.auth.methods.find((m) => m.label.includes("登录 Accio"))
  const got = await method.authorize({ region: "cn" })
  fireExit({ code: 1, signal: null, ms: 240 })
  const res = await got.callback()
  assert.equal(res.type, "failed")
  assert.match(res.error, /起来就退出/)
  assert.match(res.error, /换一个 Chromium 内核的浏览器/)
})

test("回调已经收到之后再关窗，不算失败（换 token 还在飞）", async () => {
  const realFetch = globalThis.fetch
  let fireExit
  const exit = new Promise((r) => {
    fireExit = r
  })
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/oauth/token")) {
      return json({
        success: true,
        data: { accessToken: "acc01_z", refreshToken: "rt_z", expiresAt: Math.floor(Date.now() / 1000) + 86400 },
      })
    }
    return json({ success: false, code: "555", message: "blocked by sentinel rate limit" })
  }
  try {
    const launcher = async () => ({ name: "Chrome", profileDir: join(sandbox, "fake-race"), exit, close: () => {} })
    const hooks = await AccioAuthPlugin({ client: {}, launcher })
    const method = hooks.auth.methods.find((m) => m.label.includes("登录 Accio"))
    const got = await method.authorize({ region: "cn" })
    const u = new URL(got.url)
    await realFetch(`${u.searchParams.get("return_url")}?code=c9&state=${u.searchParams.get("state")}`)
    fireExit({ code: 0, signal: null, ms: 800 }) // 用户随手把窗口关了
    const res = await got.callback()
    assert.equal(res.type, "success", "回调已到，关窗不该把这次登录判死")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("完整往返：回调带对 state → 换码成功 → callback 返回 success 并关窗", async () => {
  const realFetch = globalThis.fetch
  const closed = { v: false }
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/api/oauth/token")) {
      return json({
        success: true,
        data: { accessToken: "acc01_new", refreshToken: "rt_new", expiresAt: Math.floor(Date.now() / 1000) + 86400 },
      })
    }
    if (url.includes("/api/auth/userinfo")) return json({ success: true, data: { userId: "u1", maskedMobile: "+86 181****0632" } })
    return json({})
  }
  try {
    const launcher = async () => ({ name: "Chrome", profileDir: join(sandbox, "fake3"), exit: new Promise(() => {}), close: () => { closed.v = true } })
    const hooks = await AccioAuthPlugin({ client: {}, launcher })
    const method = hooks.auth.methods.find((m) => m.label.includes("登录 Accio"))
    const got = await method.authorize({ region: "cn" })

    const authorizeUrl = new URL(got.url)
    const returnUrl = authorizeUrl.searchParams.get("return_url")
    const state = authorizeUrl.searchParams.get("state")
    // 浏览器那一侧：登录页跳回我们的回环地址。
    // ⚠ 必须用**真的** fetch —— 上面那个 stub 会把这记回环请求也吞掉，回调就永远不来。
    const page = await realFetch(`${returnUrl}?code=authcode123&state=${state}`)
    assert.equal(page.status, 200)

    const res = await got.callback()
    assert.equal(res.type, "success")
    assert.equal(res.accountId, "181****0632", "账号名来自 userinfo 的 maskedMobile")
    assert.equal(JSON.parse(res.access).access_token, "acc01_new")
    assert.equal(res.refresh, "rt_new")
    assert.equal(closed.v, true, "登录结束就关掉那个干净窗口")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("登录成功但 userinfo 取不到（风控限流）→ 仍算成功，不许抛 ReferenceError", async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/api/oauth/token")) {
      return json({
        success: true,
        data: { accessToken: "acc01_x", refreshToken: "rt_x", expiresAt: Math.floor(Date.now() / 1000) + 86400 },
      })
    }
    // userinfo 被 sentinel 拦下 —— 真机实测就是这个形状
    return json({ success: false, code: "555", message: "blocked by sentinel rate limit" })
  }
  try {
    const launcher = async () => ({ name: "Chrome", profileDir: join(sandbox, "fake4"), exit: new Promise(() => {}), close: () => {} })
    const hooks = await AccioAuthPlugin({ client: {}, launcher })
    const method = hooks.auth.methods.find((m) => m.label.includes("登录 Accio"))
    const got = await method.authorize({ region: "cn" })
    const u = new URL(got.url)
    await realFetch(`${u.searchParams.get("return_url")}?code=c1&state=${u.searchParams.get("state")}`)

    const res = await got.callback()
    assert.equal(res.type, "success", "拿不到账号名只是卡片显示回退，不是登录失败")
    assert.equal(res.accountId, "", "空串让 magpie 回退到供应商名，不编造")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("导入本机客户端那条路保持原样：不拉浏览器（opened: true，显式导入不算错）", async () => {
  let called = 0
  const hooks = await AccioAuthPlugin({ client: {}, launcher: async () => { called += 1; throw new Error("不该被调用") } })
  const method = hooks.auth.methods.find((m) => m.label.includes("从本机 Accio 客户端导入"))
  const got = await method.authorize()
  assert.equal(got.opened, true)
  assert.equal(called, 0, "导入路径本来就不该开浏览器")
})
