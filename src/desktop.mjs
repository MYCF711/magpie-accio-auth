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
