// 自己拉起一个**干净 profile** 的浏览器来登录 Accio。
//
// ═══════════════════════════════════════════════════════════════════
// 为什么这事必须由插件自己做（2026-10-30 主人的原始投诉）
// ═══════════════════════════════════════════════════════════════════
//
// `authorize()` 只回 `{url, method:"auto"}` 时，**magpie 拿 url 去开系统默认浏览器**。
// 那个浏览器里躺着用户日常的 cookie / 会话 —— 点「登录 Accio（添加另一个号）」
// 时页面会直接落到**已经登录的那个账号**上，用户看到的就不是「添加新号」，
// 而是「怎么又登进旧号了」。
//
// 所以这条路自己 spawn 一个浏览器：`--user-data-dir=<一次性目录>` 让它没有
// 任何既有 cookie（纯净 profile），登录页只能让用户从头登一次。
// 同时 `authorize()` 回 `opened: true` 告诉 magpie「别再用系统浏览器开一遍」。
//
// ═══════════════════════════════════════════════════════════════════
// 为什么 Accio 不需要 CDP（与 magicrew 的差别）
// ═══════════════════════════════════════════════════════════════════
//
// magicrew 没有回调通道，只能靠 CDP 进页面读 localStorage —— 所以它必须自己管
// 调试端口、`DevToolsActivePort`、`SingletonLock`。
// Accio 有 **loopback OAuth 回调**（见 src/login.mjs）：登录完浏览器自己跳到
// `http://127.0.0.1:<port>/auth/callback?code=…`，我们的 http 服务就拿到了凭据。
// ⇒ 这里**只需要把窗口开起来**，不需要读它的任何东西，所以不写 CDP，少一半故障面。
//
// ⚠ 但正因如此，「用户把窗口关了」这件事插件必须自己发现：不然 `callback()` 会
//   干等到 10 分钟超时才报「登录超时」，用户以为卡死。`launchLoginBrowser()` 因此
//   返回一个 `exit` promise，由 `beginLogin()` 挂上去，关窗立刻给出明确原因。
//
// ⚠ 一次性目录 = 每次登录都要在这个窗口里重新登一次账号（独立 profile 本来也没有
//   用户日常浏览器的 cookie）。这是**刻意的**：复用目录会让第二次登录读到上一次
//   留在地上的会话，正好又变回「一开就落到旧账号」那个 bug。
//   （magicrew 踩过同一个坑，见其 src/browser-login.mjs 的 newProfileDir 注释。）

import { spawn, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

/** 一次性 profile 的目录名前缀（`sweepProfiles` 只认这个名字，别的一概不碰） */
export const PROFILE_PREFIX = "accio-login-"

function cacheDir() {
  return join(homedir(), ".cache", "magpie")
}

/**
 * 候选浏览器表 —— **顺序有意义**，靠前的先试。
 *
 * 选序的道理不是「谁更有名」，而是**谁更干净、更不会被系统策略拦住**：
 *   ① Chrome / Chromium  自己装的，没有企业策略、没有强制登录
 *   ② 国产 Chromium 系   用户日常在用的，内核一样能开
 *   ③ Edge               Windows 自带，**放最后**：企业策略常禁用/接管，
 *                        且会被系统账号强制带上侧边栏与首启引导
 *
 * 表照搬 magicrew（同一台机器实测过的那份），只去掉它按 CDP 需求才需要的项。
 * ⚠ Edge 的真名可能是 `Microsoft Edge.exe`（带空格），也可能是 `msedge.exe` ——
 *   写死任何一个都会在另一类安装方式上落空，两个都留。
 *
 * @param {string} [platform] 默认 process.platform（测试注入用）
 * @param {Record<string,string>} [env] 默认 process.env（测试注入用）
 */
export function browserCandidates(platform = process.platform, env = process.env) {
  const e = env || {}
  if (platform === "win32") {
    const local = e.LOCALAPPDATA || ""
    const roaming = e.APPDATA || ""
    const home = e.USERPROFILE || e.HOME || ""
    const pf = e.PROGRAMFILES || "C:\\Program Files"
    const pf86 = e["PROGRAMFILES(X86)"] || e["ProgramFiles(x86)"] || "C:\\Program Files (x86)"
    const under = (root, rest) => `${root}\\${rest}`
    return [
      { name: "Chrome", path: under(pf, "Google\\Chrome\\Application\\chrome.exe") },
      { name: "Chrome", path: under(pf86, "Google\\Chrome\\Application\\chrome.exe") },
      { name: "Chrome", path: under(local, "Google\\Chrome\\Application\\chrome.exe") },
      { name: "Chromium", path: under(home, "scoop\\apps\\chromium\\current\\chrome.exe") },
      { name: "Chromium", path: under(local, "Chromium\\Application\\chrome.exe") },
      { name: "Chromium", path: under(pf, "Chromium\\Application\\chrome.exe") },
      { name: "Chromium", path: under(pf86, "Chromium\\Application\\chrome.exe") },
      { name: "Chromium", path: under(home, "Chromium\\chrome.exe") },
      { name: "Brave", path: under(pf, "BraveSoftware\\Brave-Browser\\Application\\brave.exe") },
      { name: "Brave", path: under(pf86, "BraveSoftware\\Brave-Browser\\Application\\brave.exe") },
      { name: "Brave", path: under(local, "BraveSoftware\\Brave-Browser\\Application\\brave.exe") },
      { name: "Vivaldi", path: under(local, "Vivaldi\\Application\\vivaldi.exe") },
      { name: "Vivaldi", path: under(pf, "Vivaldi\\Application\\vivaldi.exe") },
      { name: "360极速浏览器X", path: under(local, "360ChromeX\\Chrome\\Application\\360ChromeX.exe") },
      { name: "360浏览器", path: under(local, "360Chrome\\Chrome\\Application\\360chrome.exe") },
      { name: "360浏览器", path: under(local, "360Chrome\\Chrome\\Application\\360Chrome.exe") },
      { name: "QQ浏览器", path: under(local, "Tencent\\QQBrowser\\Application\\QQBrowser.exe") },
      { name: "搜狗浏览器", path: under(local, "SogouExplorer\\SogouExplorer.exe") },
      { name: "夸克浏览器", path: under(local, "Quark\\Quark.exe") },
      { name: "Edge", path: under(pf86, "Microsoft\\Edge\\Application\\Microsoft Edge.exe") },
      { name: "Edge", path: under(pf, "Microsoft\\Edge\\Application\\Microsoft Edge.exe") },
      { name: "Edge", path: under(pf86, "Microsoft\\Edge\\Application\\msedge.exe") },
      { name: "Edge", path: under(pf, "Microsoft\\Edge\\Application\\msedge.exe") },
    ]
  }

  if (platform === "darwin") {
    const h = e.HOME || ""
    return [
      { name: "Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { name: "Chromium", path: "/Applications/Chromium.app/Contents/MacOS/Chromium" },
      { name: "Brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
      { name: "Vivaldi", path: "/Applications/Vivaldi.app/Contents/MacOS/Vivaldi" },
      { name: "Chrome", path: `${h}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` },
      { name: "Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
      { name: "Edge", path: `${h}/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge` },
    ]
  }

  return [
    { name: "Chrome", path: "/usr/bin/google-chrome" },
    { name: "Chrome", path: "/usr/bin/google-chrome-stable" },
    { name: "Chromium", path: "/usr/bin/chromium" },
    { name: "Chromium", path: "/usr/bin/chromium-browser" },
    { name: "Chromium", path: "/snap/bin/chromium" },
    { name: "Brave", path: "/usr/bin/brave-browser" },
    { name: "Vivaldi", path: "/usr/bin/vivaldi" },
    { name: "Edge", path: "/usr/bin/microsoft-edge" },
    { name: "Edge", path: "/usr/bin/microsoft-edge-stable" },
  ]
}

/**
 * 挑一个**真实存在**的浏览器；一个都没有返回 null。
 * @param {{candidates?: Array<{name:string,path:string}>, exists?: (p:string)=>boolean}} [opts]
 */
export function findBrowser({ candidates, exists } = {}) {
  const has = typeof exists === "function" ? exists : existsSync
  for (const c of candidates ?? browserCandidates()) {
    try {
      if (c?.path && has(c.path)) return c
    } catch {
      // 单个候选探不动就跳过，不影响其它候选
    }
  }
  return null
}

/** 没找到浏览器时的可操作提示（明确报错，**不静默退回系统浏览器**）。 */
export function noBrowserMessage(candidates) {
  const tried = (candidates ?? browserCandidates()).map((c) => c.path)
  return (
    "没能自己拉起浏览器登录：本机没找到可用的 Chromium 内核浏览器。" +
    "装一个 Chrome / Chromium / Edge（或 360极速、QQ浏览器等 Chromium 内核的）再点一次。" +
    `已尝试过这些路径：${tried.join(" · ")}`
  )
}

/** 一次性 profile 目录（每次登录一个，带随机后缀）。 */
export function newProfileDir(baseDir) {
  const root = baseDir ?? cacheDir()
  const dir = join(root, `${PROFILE_PREFIX}${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 清残留的一次性 profile（超过 `maxAgeMs` 的）。
 * ⚠ 只删本插件自己造的名字（`accio-login-` 前缀的**目录**），别的一概不碰。
 * @returns {number} 删掉几个
 */
export function sweepProfiles({ maxAgeMs = 2 * 3600_000, baseDir, now = Date.now() } = {}) {
  const root = baseDir ?? cacheDir()
  let names = []
  try {
    names = readdirSync(root)
  } catch {
    return 0
  }
  let removed = 0
  for (const name of names) {
    if (!name.startsWith(PROFILE_PREFIX)) continue
    const p = join(root, name)
    try {
      const st = statSync(p)
      if (!st.isDirectory()) continue // 同前缀的文件不是 profile
      if (now - st.mtimeMs < maxAgeMs) continue // 可能正有账号在登
      rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      removed += 1
    } catch {
      // 删不掉就算了：下次 sweep 还会再试
    }
  }
  return removed
}

/**
 * 纯净 profile 的启动参数。
 *
 * `--user-data-dir` 是**这一个功能的全部要害**：没有它，浏览器会用默认 profile，
 * 也就是用户已经登录着 Accio 的那个 —— 添加账号立刻退化成「又登回旧号」。
 * 其余参数都是「别弹首启引导 / 别同步 / 别装扩展」，减少一个干净窗口里的杂音。
 */
export function cleanProfileFlags(dir) {
  return [
    `--user-data-dir=${dir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--no-service-autorun",
    "--disable-sync",
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-background-networking",
    "--disable-component-update",
    "--metrics-recording-only",
    "--mute-audio",
  ]
}

/** Windows：按 `--user-data-dir` 精确杀这一批进程（父进程可能早就 exit 了）。 */
function killByProfileDir(dir, exePath, platform = process.platform) {
  if (platform !== "win32" || !dir) return 0
  const name = basename(String(exePath || "chrome.exe")).replace(/'/g, "''")
  const pattern = String(dir).replace(/'/g, "''")
  try {
    execFileSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$p = Get-CimInstance Win32_Process -Filter "Name='${name}'" | Where-Object { $_.CommandLine -like '*${pattern}*' }; ` +
          `$p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $p.Count`,
      ],
      { stdio: "ignore", timeout: 30_000 },
    )
    return 1
  } catch {
    return 0
  }
}

function removeDir(dir) {
  if (!dir) return
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch {
    // 删不掉留在磁盘上，sweepProfiles 下次会再试
  }
}

/**
 * 起一个干净 profile 的浏览器窗口，指到 `url`。
 *
 * @param {string} url 授权页
 * @param {{candidates?:object[], exists?:Function, spawnFn?:Function, baseDir?:string, platform?:string}} [opts]
 *   测试注入用（`exists` / `spawnFn`）；生产走默认。
 * @returns {Promise<{name:string, exe:string, profileDir:string, child:object, exit:Promise<{code:number|null, signal:string|null}>, close:()=>void}>}
 * @throws {Error} 没找到浏览器 / 进程起不来 —— 消息里带可操作提示
 */
export async function launchLoginBrowser(url, opts = {}) {
  const platform = opts.platform ?? process.platform
  const candidates = opts.candidates ?? browserCandidates(platform)
  const found = findBrowser({ candidates, exists: opts.exists })
  if (!found) throw new Error(noBrowserMessage(candidates))

  sweepProfiles({ baseDir: opts.baseDir })
  const dir = newProfileDir(opts.baseDir)
  const args = [...cleanProfileFlags(dir), String(url)]
  const spawnFn = opts.spawnFn ?? spawn
  // ⚠ 关窗/收尾时在 Windows 上要按 `--user-data-dir` 精确杀进程，那一步走 PowerShell。
  //   测试注入 `platform: "linux"` 就只走 `child.kill()`，不去真开进程管理器。
  const kill = opts.killFn ?? (() => killByProfileDir(dir, found.path, platform))

  let child
  try {
    // stdio 必须 ignore：某些国产浏览器不认参数会往 stdout 吐一堆东西，
    // 那些东西会混进 magpie 的日志里，看着像插件在报错。
    child = spawnFn(found.path, args, { stdio: "ignore", detached: false, windowsHide: false })
  } catch (e) {
    removeDir(dir)
    throw new Error(`浏览器进程起不来（${found.name}：${String(e?.message ?? e).slice(0, 200)}）—— 换一个浏览器或手动装 Chrome 再试`)
  }

  const close = () => {
    kill()
    try {
      if (child?.pid && platform === "win32") {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" })
      } else {
        child?.kill?.()
      }
    } catch {
      try {
        child?.kill?.()
      } catch {}
    }
    removeDir(dir)
  }

  // 进程退出（用户关窗 / 启动就失败 / 被系统拦下）——登录层拿这个信号提前收尾，
  // 不然用户要对着「登录中…」干等满 10 分钟。
  //
  // ⚠ 带上 `ms`（活了多久）：**起来就秒退**与「用户登了一会儿把窗口关了」是两回事 ——
  //   前者多半是那个浏览器不认这批启动参数（国产 Chromium 系里实测有这种），
  //   后者只是用户改主意了。两者的提示文案必须不同，否则用户以为是自己的错。
  const startedAt = Date.now()
  const exit = new Promise((resolve) => {
    let done = false
    const finish = (code, signal) => {
      if (done) return
      done = true
      removeDir(dir) // 窗口没了，一次性 profile 也就没用了
      resolve({ code, signal, ms: Date.now() - startedAt })
    }
    child?.once?.("exit", (code, signal) => finish(code, signal))
    child?.once?.("error", () => finish(null, null))
  })

  return { name: found.name, exe: found.path, profileDir: dir, child, exit, close }
}
