// 从本机 Accio 客户端导入登录态（Windows）
//
// ═══════════════════════════════════════════════════════════════════
// 为什么这条路存在
// ═══════════════════════════════════════════════════════════════════
//
// 官方 Windows 客户端登录一次之后，把登录态写在
//
//   %APPDATA%\Accio\credentials.enc       ← 当前账号（accessToken / refreshToken / expiresAt / sgcookie / user）
//   %APPDATA%\Accio\remembered-accounts.json  ← 账号展示缓存（明文：maskedMobile 等）
//
// 这两份数据与网站 OAuth 拿到的**是同一套 token**（都来自 /api/oauth/token、都调
// phoenix-gw.alibaba.com）。所以「已经登过客户端」的用户不必再过一遍网页登录 + 滑块：
// 插件直接把那份凭据读过来。
//
// ═══════════════════════════════════════════════════════════════════
// 加密格式（Chromium OSCrypt，实测 2026-10-29，Edge/Electron 41）
// ═══════════════════════════════════════════════════════════════════
//
//   Local State: os_crypt.encrypted_key = base64("DPAPI" + DPAPI(32 字节 AES key))
//   credentials.enc: "v10" + nonce(12) + ciphertext + tag(16)   ← AES-256-GCM
//
// ⇒ 先用 DPAPI（CurrentUser）解出 32 字节 key，再 AES-GCM 解文件。
//   DPAPI 只能在 Windows 上用，借 PowerShell 的 ProtectedData 调一次（约 0.3 秒）。
//
// ⚠ 解出来的 token 只交给 magpie 的账号槽，**不写插件的任何缓存**。

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { createDecipheriv } from "node:crypto"
import { homedir } from "node:os"

/** 客户端数据目录（Electron 的 app.getPath('userData')）。 */
export function desktopDataDir() {
  const appData = process.env.APPDATA || join(homedir(), "AppData", "Roaming")
  return join(appData, "Accio")
}

/** 本机是否装了（且登录过）Accio 客户端。 */
export function hasDesktopLogin() {
  const dir = desktopDataDir()
  return existsSync(join(dir, "credentials.enc")) && existsSync(join(dir, "Local State"))
}

/**
 * 本机是否装过 Accio 客户端（哪怕从没登录过）。
 *
 * 为什么要和 {@link hasDesktopLogin} 分开：装了没登录的用户，`credentials.enc` 还不存在，
 * 但**不该让他再去下载一次** —— 应该提示他打开客户端登录。判据取客户端会写的两个目录：
 *   · `%APPDATA%\Accio`（Electron 的 userData，首次启动就有）
 *   · `%LOCALAPPDATA%\Accio`（安装器 / launcher-telemetry）
 */
export function hasDesktopApp() {
  if (process.platform !== "win32") return false
  try {
    if (existsSync(desktopDataDir())) return true
    const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
    return existsSync(join(local, "Accio"))
  } catch {
    return false
  }
}

/**
 * 等本机客户端出现登录态 —— 给「没装客户端 → 跳下载页 → 装好登录 → **同一次点击**
 * 自动接上」那条路径用（主人 2026-10-30：「无账号才跳转下载软件」）。
 *
 * 为什么不是「弹个错误让用户再点一次」：装包 + 登录是分钟级动作，再点一次等于
 * 让用户自己记着回来；而客户端登录完成的唯一可靠信号就是 `credentials.enc` 出现，
 * 轮询它最便宜（两次 existsSync，不发网络请求）。
 *
 * ⚠ 上限由调用方给（我们传 `LOGIN_TIMEOUT_MS` = 10 分钟）；超时返回 `false`，
 *   由调用方给出「装好登录后再点一次」的明确文案，不静默成功。
 *
 * @param {{timeoutMs?:number, intervalMs?:number, probe?:()=>boolean, sleep?:(ms:number)=>Promise<void>, now?:()=>number}} [opts]
 *   测试注入 `probe` / `sleep` / `now`，不真的等 10 分钟。
 * @returns {Promise<boolean>} 是否等到了登录态
 */
export async function waitForDesktopLogin({
  timeoutMs = 10 * 60_000,
  intervalMs = 3000,
  probe = hasDesktopLogin,
  // ⚠ 定时器 unref：用户在 magpie 里取消登录时，这个 callback 可能还在等；
  //   不 unref 会让宿主进程为了它多活最多 10 分钟（宿主本来就常驻，但别添乱）。
  sleep = (ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    t.unref?.()
  }),
  now = () => Date.now(),
} = {}) {
  const deadline = now() + Math.max(0, timeoutMs)
  // 先看一眼：点进这条分支时可能客户端刚好登录完（或用户本来就是「装了但没登录」）
  for (;;) {
    try {
      if (probe()) return true
    } catch {
      // 探不动就当作「还没有」，继续等
    }
    const left = deadline - now()
    if (left <= 0) return false
    await sleep(Math.min(intervalMs, left))
  }
}

/** DPAPI(CurrentUser) 解一段密文 —— 只能 Windows，借 PowerShell。 */
function dpapiDecrypt(cipher) {
  if (process.platform !== "win32") throw new Error("DPAPI 只在 Windows 上可用")
  const b64 = cipher.toString("base64")
  const script =
    "Add-Type -AssemblyName System.Security; " +
    "[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect(" +
    `[Convert]::FromBase64String('${b64}'), $null, 'CurrentUser'))`
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 20_000,
  })
  return Buffer.from(out.trim(), "base64")
}

/** 解开 Chromium OSCrypt 的 `v10` 文件（AES-256-GCM，key 由 DPAPI 保护）。 */
function decryptV10(file, localState) {
  const data = readFileSync(file)
  if (data.subarray(0, 3).toString() !== "v10") {
    throw new Error(`不认识的加密版本：${data.subarray(0, 3).toString()}`)
  }
  const ls = JSON.parse(readFileSync(localState, "utf8"))
  const wrapped = Buffer.from(ls?.os_crypt?.encrypted_key ?? "", "base64")
  if (wrapped.subarray(0, 5).toString() !== "DPAPI") throw new Error("Local State 里没有 DPAPI 包装的 key")
  const key = dpapiDecrypt(wrapped.subarray(5))
  if (key.length !== 32) throw new Error(`AES key 长度异常：${key.length}`)

  const nonce = data.subarray(3, 15)
  const body = data.subarray(15)
  const tag = body.subarray(body.length - 16)
  const cipher = body.subarray(0, body.length - 16)
  const d = createDecipheriv("aes-256-gcm", key, nonce)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(cipher), d.final()]).toString("utf8")
}

/**
 * 读客户端当前账号的登录态。
 * @returns {{credential:{access_token,refresh_token,expires_at,sgcookie,region}, user:object}|null}
 */
export function importDesktopLogin() {
  if (process.platform !== "win32") return null
  const dir = desktopDataDir()
  const file = join(dir, "credentials.enc")
  if (!existsSync(file)) return null
  const obj = JSON.parse(decryptV10(file, join(dir, "Local State")))
  if (!obj?.accessToken || !obj?.refreshToken) return null
  const expires = Number(obj.expiresAt)
  return {
    credential: {
      access_token: String(obj.accessToken),
      refresh_token: String(obj.refreshToken),
      // 客户端存的是**毫秒**（实测 1795839590000）；插件的 accioExpiresAtMs 也认毫秒
      expires_at: Number.isFinite(expires) && expires > 0 ? expires : undefined,
      sgcookie: typeof obj.sgcookie === "string" ? obj.sgcookie : "",
      region: obj?.user?.routeRegion === "CN" || obj?.user?.routeRegion === undefined ? "cn" : "global",
    },
    user: obj.user ?? {},
  }
}
