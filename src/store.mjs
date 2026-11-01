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
/**
 * 当前邀请码策略（`~/.cache/magpie/accio-invite.json`）。
 *
 * 与 magicrew 的 `magicrew-invite-policy-<site>.json` 同一语义：
 * 登录时**自动**把它带进登录页 URL，用户不用每次都填。
 * 区别：Accio 没有「查询自己邀请码」的接口（`/api/invitation/query` 只返回布尔），
 * 所以这里的码来自「上一次成功用过的码」—— 首次由用户在「邀请码」里填一次。
 */
export function readInviteCode() {
  const v = readJson(fileOf("invite"), null)
  return typeof v?.code === "string" ? v.code.trim() : ""
}

/** 与邀请码配对的分 `sId`（官方分享链接里的那个 base64）。没有就空串。 */
export function readInviteSid() {
  const v = readJson(fileOf("invite"), null)
  return typeof v?.sid === "string" ? v.sid.trim() : ""
}

export function writeInviteCode(code, source, sid) {
  const c = String(code ?? "").trim()
  if (!c) return
  const next = { code: c, source: String(source ?? ""), at: Date.now() }
  const s = String(sid ?? "").trim()
  if (s) next.sid = s
  else {
    // 换码时保留旧 sid 只在不换码的前提下有意义；换了码就必须一起换
    const prev = readJson(fileOf("invite"), null)
    if (prev?.sid && prev?.code === c) next.sid = prev.sid
  }
  writeJson(fileOf("invite"), next)
}

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

// ── ④ 「登录失效」的连续确认计数（每账号一条）──────────────────────────
//
// 为什么不能一次算数：magpie 每次轮询额度都会调 `usage()`，而 `signIn: "expired"`
// 会让它**把这个号标死、要从卡片上人工重登**。可上游在风控限流时回的
// `401 NOT_LOGIN` / `403 auth failed`，跟「token 真被吊销了」**逐字一样**
// （2026-10-30 对照实验，docs/internals.md §13）——
// 一次抖动就把用户三个号全标成「已退出登录」，代价与收益完全不成比例。
//
// 于是：**连续两次、且两次相隔 ≥ `SIGNIN_CONFIRM_GAP_MS`** 都报「登录失效」才算确认
// （间隔的要求是为了让 `usage` 与 `models` 在同一次轮询里各报一次不算两次）。
// 期间照常把上游原文回给 magpie 显示，只是**不**打死亡标记。
//
// ⚠ 读了干净的一次就清零：magpie 那边也是这么自愈的（源码 plugin_usage.go：
//   `u.Error == ""` → 清 lapse），两边口径一致。
export const SIGNIN_CONFIRM_STRIKES = 2
export const SIGNIN_CONFIRM_GAP_MS = 60_000

function signInFailFile() {
  return fileOf("signin-fails")
}

function readSignInFails() {
  const v = readJson(signInFailFile(), null)
  return v && typeof v === "object" ? v : {}
}

/** 这个账号目前累计了几次「连续登录失效」。 */
export function signInFailsOf(account, now = Date.now()) {
  const rec = readSignInFails()[account]
  if (!rec || !Number.isFinite(rec.n)) return 0
  // 太久没再报（> 1 小时）就当翻篇了，不让一次周一的抖动影响周三
  if (now - Number(rec.at) > 3600_000) return 0
  return rec.n
}

/**
 * 记一次「上游说登录失效」，返回累计次数。
 * @param {string} account 账号键（`accountKeyOf`）
 * @param {{now?:number, gapMs?:number}} [opts]
 */
export function noteSignInGone(account, { now = Date.now(), gapMs = SIGNIN_CONFIRM_GAP_MS } = {}) {
  if (!account) return 0
  const all = readSignInFails()
  const rec = all[account]
  const fresh = !rec || !Number.isFinite(rec.n) || now - Number(rec.at) > 3600_000
  const n = fresh ? 1 : now - Number(rec.at) >= gapMs ? Number(rec.n) + 1 : Number(rec.n)
  // 没跨过间隔就不更新 at —— 否则连发两次会把间隔推远、永远确认不了
  const at = fresh || n > Number(rec.n) ? now : Number(rec.at)
  all[account] = { n, at }
  writeJson(signInFailFile(), all)
  return n
}

/** 读到干净的一次就清零（账号自愈）。 */
export function clearSignInGone(account) {
  if (!account) return false
  const all = readSignInFails()
  if (!(account in all)) return false
  delete all[account]
  return writeJson(signInFailFile(), all)
}

// ── ⑤ 找回「这个 auth 对应账号」的最新记录（续期判终态前用）────────────
//
// 为什么需要（Jet Hub 的「按 refresh chain 协调，不按 account」，2026-10-30）：
// Accio 的刷新**轮换** refresh_token。A、B 两个 magpie 实例（或插件的
// loader 内硬续期 + 宿主定时续期）同时拿同一份旧 token 去刷时，一个成功、
// 另一个必然拿到 `invalid_grant`。失败那个如果直接判「登录失效」，就会把
// **已经被别人续好的好账号标死**。
//
// ⇒ 判终态前回读 `plugin-auth.json`：如果这个账号的 `refresh` 已经**不是**
//   本次用的那一份，说明「他处已续成功」，应当拿最新的那份继续，而不是标死。
//
// ⚠ 三条纪律（都是踩过的坑）：
//   1. 比对必须**按值**（字符串相等）。`credentialOf()` 每次 parse 都产生新对象，
//      引用比较恒为「不相等」⇒ 会把每一次都误判成「变了」。
//   2. **读不到 ≠ 变了**：文件正在被 magpie 原子重写、或目录不可读时返回 null，
//      调用方据此维持原来的终态判断，不许拿「空」当证据。
//   3. 认不准（多账号且 accountId/uid 都匹配不上）时返回 { changed: "unknown" }，
//      **不猜** —— 宁可让 magpie 下一轮再试，也不能把 A 的凭据写到 B 头上。
//
// @param {string} provider  供应商 id（`accio`）
// @param {object} auth      本次续期用的那条 magpie 记录（含 refresh/accountId/uid）
// @returns {{key:string, value:object, changed:true|false} | {changed:"unknown", reason:string} | null}
export function latestCredentialFor(provider, auth) {
  if (!auth || typeof auth !== "object") return null
  const slots = readMagpieAuthSlots(provider)
  if (slots.length === 0) return null

  const refreshOf = (record) => {
    if (typeof record?.refresh === "string" && record.refresh !== "") return record.refresh
    // 兼容手写/旧版记录：refresh 可能只躺在 access 的 JSON 里
    try {
      const inner = JSON.parse(record?.access ?? "{}")
      return typeof inner?.refresh_token === "string" ? inner.refresh_token : ""
    } catch {
      return ""
    }
  }

  const mine = refreshOf(auth)
  // ① 按值找到「还是本次用的那一份」⇒ 没变
  if (mine !== "") {
    const exact = slots.find((slot) => refreshOf(slot.value) === mine)
    if (exact) return { key: exact.key, value: exact.value, changed: false }
  }

  // ② 找「我自己」：accountId（稳定）→ uid → 全池只有一个 accio 槽
  const hasIdentity = (typeof auth.accountId === "string" && auth.accountId !== "")
    || (typeof auth.uid === "string" && auth.uid !== "")
  let pool = []
  if (typeof auth.accountId === "string" && auth.accountId !== "") {
    pool = slots.filter((slot) => slot.value?.accountId === auth.accountId)
  }
  if (pool.length === 0 && typeof auth.uid === "string" && auth.uid !== "") {
    pool = slots.filter((slot) => slot.value?.uid === auth.uid)
  }
  // 「全池只有一个槽」这条兜底**只在本次记录没有任何身份字段时**才用 ——
  // 否则「池里只剩另一个账号」会被误认成本次这一条 ⇒ 把 B 的凭据借给 A。
  if (pool.length === 0 && slots.length === 1 && !hasIdentity) pool = slots
  // 多账号且认不准：**不猜**，交给调用方当「无法确认」（不标死、下轮再试）
  if (pool.length !== 1) return { changed: "unknown", reason: `共 ${slots.length} 个 accio 账号槽，认不出本次这一条` }

  const value = pool[0].value
  const latest = refreshOf(value)
  if (latest === mine) return { key: pool[0].key, value, changed: false }
  return { key: pool[0].key, value, changed: true }
}
