// 内置登录：headless 浏览器里完成 Accio 登录页，**不弹任何可见窗口**
//
// ═══════════════════════════════════════════════════════════════════
// 为什么必须用浏览器
// ═══════════════════════════════════════════════════════════════════
//
// Accio 的登录页（login.accio-ai.com）发验证码前会过阿里 baxia 风控：
//   · 请求 `/integrated/captcha/token` 时会被拦下，弹 **NC 滑块**（#nc_1_n1z）；
//   · 滑块的 x5secdata 是服务端一次性的，纯 HTTP 拼不出来。
// 所以「不弹浏览器」不等于「不用浏览器」——用 **headless** 跑完，用户看不到窗口。
//
// ═══════════════════════════════════════════════════════════════════
// 实测踩到的三个坑（别再踩）
// ═══════════════════════════════════════════════════════════════════
//
// ① **必须勾协议**：不勾「同意 Accio 的使用条款」时，点「登录」静默无响应
//    （没有错误提示、没有网络请求），看起来像按钮坏了。
// ② **必须用真实键盘输入**：React 受控输入不认 `value=` 赋值；`Input.dispatchKeyEvent`
//    的 `char` 事件才是它认的。视口也要够大（1440×900），默认 800×600 布局会变。
// ③ **滑块必须拟人**：贝塞尔/一步到位会被判 bot（报 HuxHv）；能过的是
//    起手停 0.3s → 按下停 0.35s → 40 步 × 18ms 匀速（y ±0.5px 抖动）→ 停 0.38s → 松手。
//    来源：linhuai777/accio2api `_human_drag`（2026-09-23 实测）。
//
// ═══════════════════════════════════════════════════════════════════
// 流程
// ═══════════════════════════════════════════════════════════════════
//
//   launchEdge() → open(url) → chooseTab(account) → type(account) → agree()
//   → submit() → sendCode() → solveSlider()（可能要 2 次发送）→ 验证码页
//   → submitCode(code) → 页面跳回 loopback（beginLogin 的 result 兑现）
//
// 浏览器进程在登录完成（或被放弃）后关闭，profile 目录删掉。

import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 候选 Edge / Chrome（Windows）。按优先级，别写死一个名字。 */
const CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
]

export function findBrowser() {
  for (const p of CANDIDATES) {
    try { if (p && existsSync(p)) return p } catch {}
  }
  return null
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36 Edg/156.0.0.0"

/** 一个 headless 浏览器 + 一个页面，CDP 直连。 */
export async function launchBrowser() {
  const exe = findBrowser()
  if (!exe) throw new Error("本机没有 Edge / Chrome，无法内置登录（可改用「从本机 Accio 客户端导入」）")
  const profile = mkdtempSync(join(tmpdir(), "accio-login-"))
  // ⚠ 用 `--remote-debugging-port=0` 让浏览器自己挑端口，从 stderr 的
  //   "DevTools listening on ws://127.0.0.1:<port>/" 里读回来 ——
  //   自己猜端口（9300+随机）在 Windows 上会撞保留端口段，起不来还不报原因。
  const child = spawn(exe, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    `--user-agent=${UA}`,
    "--window-size=1440,900",
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] })

  let port = null
  const onData = (d) => {
    const m = String(d).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//)
    if (m) port = Number(m[1])
  }
  child.stderr.on("data", onData)
  child.stdout.on("data", onData)
  for (let i = 0; i < 100 && port === null; i++) await sleep(200)
  if (port === null) {
    try { child.kill() } catch {}
    throw new Error("headless 浏览器启动失败（没有报出调试端口）")
  }
  let version = null
  for (let i = 0; i < 40; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break } catch { await sleep(250) }
  }
  if (!version) {
    try { child.kill() } catch {}
    throw new Error("headless 浏览器起来了但调试接口不通")
  }
  return {
    exe,
    port,
    profile,
    async close() {
      try { child.kill() } catch {}
      await sleep(400)
      try { rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }) } catch {}
    },
  }
}

/** 打开一个页面并返回 CDP 客户端。 */
export async function openPage(browser, url) {
  const tab = await (await fetch(`http://127.0.0.1:${browser.port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })).json()
  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id
    pending.set(i, res)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const evaluate = async (expression) =>
    (await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result?.result?.value

  await send("Page.enable")
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  return { ws, send, evaluate, close: () => { try { ws.close() } catch {} } }
}

// ── 页面操作小工具 ─────────────────────────────────────────

const boxOf = async (page, selector) => {
  const raw = await page.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return null; const r=el.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`)
  return raw ? JSON.parse(raw) : null
}

const clickAt = async (page, box) => {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y })
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 })
  await sleep(60)
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 })
}

const findButton = async (page, label) =>
  page.evaluate(`(() => { const norm=(s)=>Array.from(s||'').filter((c)=>c.trim()!=='').join(''); const b=[...document.querySelectorAll('button')].find((x)=>norm(x.innerText)===norm(${JSON.stringify(label)})); if(!b) return null; const r=b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`)

const clickButton = async (page, label) => {
  const raw = await findButton(page, label)
  if (!raw) return false
  await clickAt(page, JSON.parse(raw))
  return true
}

/** React 受控输入：必须逐字发真实键盘事件。 */
const typeText = async (page, selector, text) => {
  const ok = await page.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el) return false; el.focus(); return true; })()`)
  if (!ok) return false
  for (const ch of String(text)) {
    const code = ch === "@" ? 50 : ch === "." ? 190 : ch.toUpperCase().charCodeAt(0)
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, windowsVirtualKeyCode: code })
    await page.send("Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch })
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, windowsVirtualKeyCode: code })
    await sleep(18)
  }
  return true
}

const bodyText = async (page) => String(await page.evaluate("document.body.innerText") || "")

/** 勾「同意协议」——不勾提交会静默无响应（坑①）。 */
const agree = async (page) =>
  page.evaluate(`(() => { const c=document.querySelector('input.ant-checkbox-input'); if(!c) return 'none'; if(!c.checked) c.click(); return c.checked; })()`)

/** 过 NC 滑块（坑③：拟人轨迹）。 */
async function solveSlider(page, frameUrlPart = "punish") {
  // 滑块 iframe 是异步加载的：先轮询等它出现、等 handle 出现（最多 10 秒）
  let frame = null
  for (let i = 0; i < 20; i++) {
    const tree = await page.send("Page.getFrameTree")
    const frames = []
    const walk = (n) => { frames.push(n.frame); (n.childFrames || []).forEach(walk) }
    walk(tree.result.frameTree)
    frame = frames.find((f) => (f.url || "").includes(frameUrlPart))
    if (frame) break
    await sleep(500)
  }
  if (!frame) return "no-slider"
  // 等 iframe 里的滑块 DOM 就绪
  let world = null
  let geoVal = null
  for (let i = 0; i < 20; i++) {
    world = await page.send("Page.createIsolatedWorld", { frameId: frame.id, worldName: `accio${i}`, grantUniveralAccess: true })
    const ctx = world.result.executionContextId
    const geoRaw = await page.send("Runtime.evaluate", {
      contextId: ctx, returnByValue: true,
      expression: `(() => { const h=document.querySelector('#nc_1_n1z'); const t=document.querySelector('#nc_1_n1t'); if(!h||!t) return null; const hb=h.getBoundingClientRect(), tb=t.getBoundingClientRect(); return JSON.stringify({handle:{x:hb.x,y:hb.y,w:hb.width,h:hb.height},track:{x:tb.x,y:tb.y,w:tb.width,h:tb.height}}); })()`,
    })
    geoVal = geoRaw.result?.result?.value
    if (geoVal) break
    await sleep(500)
  }
  if (!geoVal) {
    const inner = await page.send("Runtime.evaluate", { contextId: world.result.executionContextId, returnByValue: true, expression: "document.body ? document.body.innerText.slice(0,160) : '(no body)'" })
    return "no-handle:" + String(frame.url).slice(0, 80) + ":" + String(inner.result?.result?.value ?? "")
  }

  const ctx = world.result.executionContextId
  const geo = JSON.parse(geoVal)
  const off = JSON.parse(await page.evaluate(`(() => { const f=[...document.querySelectorAll('iframe')].find((i)=>(i.name||'')==='baxia-dialog-content'||(i.src||'').includes(${JSON.stringify(frameUrlPart)})); if(!f) return '{"x":0,"y":0}'; const r=f.getBoundingClientRect(); return JSON.stringify({x:r.x,y:r.y}); })()`))

  const sx = off.x + geo.handle.x + geo.handle.w / 2
  const sy = off.y + geo.handle.y + geo.handle.h / 2
  const ex = off.x + geo.track.x + geo.track.w - geo.handle.w * 0.15 + 6
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sx - 9, y: sy - 4 })
  await sleep(320)
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: sx, y: sy })
  await sleep(450)
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: sx, y: sy, button: "left", buttons: 1, clickCount: 1 })
  await sleep(350)
  for (let i = 1; i <= 40; i++) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: sx + (ex - sx) * i / 40,
      y: sy + ((i % 3) - 1) * 0.5,
      button: "left", buttons: 1,
    })
    await sleep(18)
  }
  await sleep(380)
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: ex, y: sy + 1, button: "left", buttons: 0, clickCount: 1 })
  await sleep(2200)

  const verdict = await page.send("Runtime.evaluate", {
    contextId: ctx, returnByValue: true,
    expression: `(() => { const t=document.querySelector('#nc_1__scale_text'); return JSON.stringify({text:t?t.innerText:'', hasSlider:!!document.querySelector('#nc_1_n1z')}); })()`,
  })
  return verdict.result?.result?.value ?? "unknown"
}

// ── 主流程 ─────────────────────────────────────────────────

/**
 * 打开登录页、填账号、发验证码（含滑块），停在验证码页。
 * @returns {Promise<{submitCode:(code:string)=>Promise<void>, close:()=>Promise<void>, page:any, browser:any}>}
 */
export async function startCodeLogin({ url, account }) {
  const browser = await launchBrowser()
  let page
  try {
    page = await openPage(browser, url)
    await sleep(4200)
    if (!(await page.evaluate("document.title")).includes("Login")) {
      throw new Error("登录页没有打开（标题不是 Login to Accio）")
    }

    const isEmail = String(account).includes("@")
    if (isEmail) {
      // 切「邮箱登录」tab
      const tabBox = await page.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((x)=>/邮箱登录/.test(x.innerText||'')); if(!b) return null; const r=b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`)
      if (!tabBox) throw new Error("找不到「邮箱登录」入口")
      await clickAt(page, JSON.parse(tabBox))
      await sleep(900)
    }

    const filled = await typeText(page, 'input[name="account"]', account)
    if (!filled) throw new Error("找不到账号输入框")
    const agreed = await agree(page)
    if (agreed !== true) throw new Error("同意协议的勾选框没勾上")
    await sleep(300)

    const submit = await page.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find((x)=>(x.className||'').includes('submitButton')); if(!b) return null; const r=b.getBoundingClientRect(); return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2}); })()`)
    if (!submit) throw new Error("找不到「登录」按钮")
    await clickAt(page, JSON.parse(submit))
    await sleep(3500)

    // 到了「发送验证码」页
    if (!(await bodyText(page)).includes("发送验证码")) {
      const t = await bodyText(page)
      throw new Error(`点登录后没有进入验证码页：${t.slice(0, 120)}`)
    }

    let sent = await clickButton(page, "发送验证码")
    if (!sent) throw new Error("找不到「发送验证码」按钮")
    await sleep(3200)
    console.error("[accio-login] sent, body:", (await bodyText(page)).slice(0, 120))

    // 可能弹滑块：最多试 3 次
    for (let attempt = 1; attempt <= 3; attempt++) {
      const verdict = await solveSlider(page)
      console.error("[accio-login] slider attempt", attempt, "->", String(verdict).slice(0, 80))
      if (verdict === "no-slider") break
      if (typeof verdict === "string" && verdict.includes("验证通过")) break
      // 滑块通过后首击被风控拦下：要再点一次发送
      await sleep(800)
      const again = await clickButton(page, "发送验证码")
      if (again) await sleep(3000)
      if ((await bodyText(page)).includes("输入验证码")) break
    }

    // 等验证码页（最多 25 秒）
    for (let i = 0; i < 25; i++) {
      if ((await bodyText(page)).includes("输入验证码")) break
      await sleep(1000)
    }
    if (!(await bodyText(page)).includes("输入验证码")) {
      throw new Error(`没有等到验证码输入页：${(await bodyText(page)).slice(0, 160)}`)
    }

    return {
      page,
      browser,
      async submitCode(code) {
        const input = await page.evaluate(`(() => { const sels=['input[name="code"]','input[placeholder*="验证码"]','input[maxlength="6"]']; const el=sels.map((s)=>document.querySelector(s)).find(Boolean); if(!el) return null; el.focus(); return el.name || el.placeholder || 'ok'; })()`)
        if (!input) throw new Error("找不到验证码输入框")
        await typeText(page, 'input[name="code"]', code).catch(async () => {
          // 选择器不叫 name=code 时，退回 placeholder
          await typeText(page, 'input[placeholder*="验证码"]', code)
        })
        await sleep(400)
        const ok = await clickButton(page, "继续") || await clickButton(page, "登 录")
        if (!ok) throw new Error("找不到「继续」按钮")
        await sleep(1500)
      },
      async close() {
        try { page.close() } catch {}
        await browser.close()
      },
    }
  } catch (e) {
    try { page?.close() } catch {}
    await browser.close()
    throw e
  }
}
