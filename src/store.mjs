// 插件自己的缓存 —— 三条规矩，缺一条就会出事
//
// 规矩 ①：**只写 `~/.cache/magpie`，不碰 `~/.config/magpie`。**
//   后者是 magpie 的目录（plugins.json / plugin-auth.json / 市场缓存…）。
//   插件对那里只有读的份 —— 写它等于改别人的状态，历史上真的把 registry 条目盖掉过。
//
// 规矩 ②：**文件名里必须带「谁的数据」。** 宿主是同一个进程跑所有账号，
//   用模块级变量或单文件存 per-account 状态，第二个账号进来就会串号。
//
// 规矩 ③：**这里的东西全都可删。** 删掉整个目录，插件应该只是「重新拉一遍目录 +
//   生成一个新 utdid」，而不是崩。所以读失败一律当「没有」，不抛。
//
// ⚠ 不在这里存 token 的明文副本 —— 凭据由 magpie 的 plugin-auth.json 管，
//   抄一份就会有两个人同时刷新 token，最后分叉、用户莫名掉登录。

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createHash, randomBytes } from "node:crypto"

/** 文件名前缀 —— 与别的插件区分开 */
const PREFIX = "accio"

function cacheDir() {
  return join(homedir(), ".cache", "magpie")
}

export function fileOf(kind, { account } = {}) {
  const name = `${PREFIX}-${kind}` + (account ? `__${String(account)}` : "") + ".json"
  return join(cacheDir(), name)
}

/**
 * 只读 magpie 的账号槽 `~/.config/magpie/plugin-auth.json`。
 *
 * ⚠ 这里**只读**：写入是 magpie 的事，插件抄一份就会出现两个刷新者。
 *   用途只有一个 —— 「邀请码」这个登录方式拿不到 getAuth()，只能从槽里找当前账号。
 */
export function magpieConfigDir() {
  return join(homedir(), ".config", "magpie")
}

export function readMagpieAuthSlots(provider) {
  try {
    const obj = JSON.parse(readFileSync(join(magpieConfigDir(), "plugin-auth.json"), "utf8"))
    return Object.entries(obj || {})
      .filter(([key]) => key === provider || key.startsWith(`${provider}#`))
      .map(([key, value]) => ({ key, value }))
  } catch {
    return []
  }
}

function readJson(file, fallback = null) {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"))
    return v ?? fallback
  } catch {
    return fallback
  }
}

/** 原子写：先写 `.tmp` 再 rename（同一分区上 rename 是原子的）。 */
function writeJson(file, value) {
  try {
    mkdirSync(cacheDir(), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(value))
    renameSync(tmp, file)
    return true
  } catch {
    return false // 缓存写不进去不该影响主流程
  }
}

// ── ① 装机 id（utdid）────────────────────────────────────────────────
//
// ⚠ 阿里网关拿 utdid 做风控基线：**缺失时回 HTTP 200 + 一张 HTML 拦截页**
//   （`bixi-intl.alicdn.com/punish/...` 跳转脚本），症状是「模型不回复」——
//   真因是风控，排查方向会完全错。所以它必须稳定：同一台机器一个值，重启不变。
//
// 装机级（不是每账号）与官方客户端同口径：一次装机一个 id。
export function utdid() {
  const file = fileOf("state")
  const saved = readJson(file, null)
  if (typeof saved?.utdid === "string" && saved.utdid !== "") return saved.utdid

  const fresh = `accio-${randomBytes(6).toString("hex")}${Date.now().toString(36)}`
  writeJson(file, { at: new Date().toISOString(), utdid: fresh })
  return fresh
}

// ── ② 模型目录快照（每账号一条）────────────────────────────────────────
//
// 为什么要有：`provider.models` 抛异常会让整张卡片从列表里消失；
// 上游抖一下时应当退回**上次的目录**，而不是返回空表。
// 另外 chat 需要 slug → modelCode 的映射（上游只认 modelCode，发 slug 会请求打空）——
// 这份快照就是那张映射表。
export function readModels(account) {
  const v = readJson(fileOf("models", { account }), null)
  return Array.isArray(v?.entries) ? v : null
}

export function writeModels(account, entries) {
  if (!account) return false
  return writeJson(fileOf("models", { account }), { at: new Date().toISOString(), entries })
}

// ── ③ 账号键（per-account 缓存的目录名）────────────────────────────────
//
// Accio 的 OAuth 响应**不带**账号名／邮箱，所以拿不到人类可读的身份。
// 用 refresh_token 的哈希做稳定键：同一份凭据永远同一个键，且不可反推。
// ⚠ 换了 refresh_token（重登）会变成新键 —— 这是**缓存键**，不是账号身份；
//   账号身份由 magpie 的账号槽负责（见 index.mjs 的 uid 说明）。
export function accountKeyOf(refreshToken) {
  if (typeof refreshToken !== "string" || refreshToken === "") return "anon"
  return createHash("sha256").update(refreshToken, "utf8").digest("hex").slice(0, 10)
}