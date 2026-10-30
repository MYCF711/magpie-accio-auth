// 非对话 API：模型目录 + 额度
//
// ═══════════════════════════════════════════════════════════════════
// 三条「业务失败恒 HTTP 200」的规矩
// ═══════════════════════════════════════════════════════════════════
//
// Accio 的失败不用状态码表达：
//
//   POST /api/llm/config/v2  无 token      → 200 {"success":false,"code":"403","message":"auth failed"}
//   GET  /api/entitlement/*  假 token      → 200 {"success":false,"code":"401","message":"NOT_LOGIN"}
//
// ⇒ **只看 HTTP 状态码会把每一次失败都当成成功**。成败一律读 body 的 `success` / `code`。
//   而 `code` 可能是数字也可能是字符串（官方客户端用 `String(e.code)==='401'`），
//   所以判据统一 `String(code)`。
//
// ═══════════════════════════════════════════════════════════════════
// token 的位置也跟前两个不一样
// ═══════════════════════════════════════════════════════════════════
//
//   目录   token 在 **body** 的 `token` 字段
//   额度   token 在 **query**（`?accessToken=`）
//   对话   token 在 **body** 的 `token` 字段（放 Authorization 头恒流内 402）
//
// ═══════════════════════════════════════════════════════════════════
// 「上游说不认识这个 token」≠「账号被吊销」（2026-10-30 实测）
// ═══════════════════════════════════════════════════════════════════
//
// 在被阿里 sentinel 风控的出口 IP 上：
//
//   POST /api/auth/userinfo          → 200 {"success":false,"code":"555","message":"blocked by sentinel rate limit"}
//   POST /api/llm/config/v2  (真 token) → 200 {"success":false,"code":"403","message":"auth failed"}
//   GET  /api/entitlement/* (真 token) → 200 {"success":false,"code":"401","message":"NOT_LOGIN"}
//   同上，把 token 换成一串垃圾      → **逐字相同**
//
// ⇒ 判登录失效的判据写在 `isSignInGone()` 里（白名单 + 先排风控/限流），
//   不在调用点各自发挥。对照实验与时间线见 docs/internals.md §13。
//
// ═══════════════════════════════════════════════════════════════════

import {
  CATALOG_PATH,
  GATEWAY,
  INVITE_COMMIT_PATH,
  INVITE_QUERY_PATH,
  QUOTA_PATH,
  REQUEST_TIMEOUT_MS,
  SUBSCRIPTION_PATH,
  USERINFO_PATH,
} from "./constants.mjs"
import { parseCatalog } from "./models.mjs"
import { usage as buildUsage, usageWindow } from "./quota.mjs"
import { fetchWithRetry } from "./transport.mjs"

/** 未登录 / 登录失效的错误形状（调用方据此抛 `signIn: "expired"`）。 */
export class SignInError extends Error {
  constructor(message) {
    super(message)
    this.name = "SignInError"
    this.signedOut = true
  }
}

/**
 * 上游**明说**「登录没了」的措辞 —— 只有命中它（或 HTTP / body 的 401）才允许判登录失效。
 *
 * ⚠ 为什么要一张白名单而不是「401/403 一律算」（2026-10-30 实测，见 docs/internals.md §13）：
 *   在**被阿里 sentinel 风控的出口 IP** 上，`userinfo` 回
 *   `{"code":"555","message":"blocked by sentinel rate limit"}`，
 *   而 catalog / entitlement 回的是 `403 auth failed` / `401 NOT_LOGIN` ——
 *   与拿垃圾 token 打过去**逐字一样**。也就是说这两个码表达的是
 *   「这个 token 我不认」，而**不**必然是「这个号被吊销了」。
 *   判错了的代价是账号被 magpie 标死、要人工重登，所以宁可不判。
 */
const AUTH_GONE_WORDS =
  /NOT_?LOGIN|not\s+logged\s+in|login\s+(?:required|expired)|please\s+(?:sign|log)\s?in|sign[-\s]?in\s+(?:required|expired)|token\s+(?:is\s+)?(?:invalid|expired|revoked|not\s+found)|invalid\s+(?:access\s+)?token|unauthenticated|auth(?:entication)?\s+failed|未登录|请重新登录|登录(?:已)?(?:过期|失效)/i

/** 明确「暂时性」的措辞 —— 命中它一律**不**判登录失效（风控 / 限流 / 超时 / 网关）。 */
const TRANSIENT_WORDS =
  /sentinel|blocked\s+by|rate\s*limit|too\s+many\s+requests|throttl|limit\s+exceeded|限流|风控|频率限制|访问频繁|请求过快|请稍后|稍后重试|系统繁忙|服务繁忙|timeout|timed?\s*out|超时|bad\s+gateway|service\s+unavailable|网关(?:异常|错误)/i

/** 风控 / 网关的代号：不是登录语义。 */
const TRANSIENT_CODES = new Set(["429", "500", "501", "502", "503", "504", "555", "999"])

/**
 * 这份失败报文算不算「登录失效」—— **纯函数，测试直接钉它**。
 *
 * 顺序即判据，四条都不能动：
 *   ① 传输层/风控层：HTTP 429、HTTP ≥500、风控代号（555…）、限流措辞 → **不是**
 *   ② 402 = 没钱（Accio 对话流里 `{"error_code":"402","error_message":"unauthorized"}`
 *      就带 `unauthorized` 字样，先拦掉，别被措辞骗了）→ **不是**
 *   ③ 明说登录没了的措辞（`NOT_LOGIN` / `auth failed` / `未登录` …）→ **是**
 *   ④ 没有措辞时：只认 401（HTTP 或 body 的 code）—— HTTP 401 的语义就是未认证；
 *      **403 不认**：权限、WAF、风控都会回 403，它的措辞必须是 auth 类才算
 *
 * @param {number} status HTTP 状态码
 * @param {any} body 解析后的响应体
 * @returns {boolean}
 */
export function isSignInGone(status, body) {
  const code = String(body?.code ?? "")
  const message = String(body?.message ?? "")
  const http = Number(status)
  if (http === 429 || http >= 500) return false
  if (TRANSIENT_CODES.has(code)) return false
  if (TRANSIENT_WORDS.test(message)) return false
  if (code === "402") return false
  if (AUTH_GONE_WORDS.test(message)) return true
  return http === 401 || code === "401"
}

/** 解析 `{success, code, message, data}` 信封；`success !== true` 一律抛。 */
function unwrap(path, status, text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`Accio ${path} 返回非 JSON（HTTP ${status}）：${text.slice(0, 150)}`)
  }
  const code = String(body?.code ?? "")
  if (body?.success !== true) {
    // ⚠ 未登录的实测形态是 HTTP 200 + {success:false, code:'401', message:'NOT_LOGIN'}；
    //   但同样的形状也会来自风控/限流 ⇒ 判据走 isSignInGone 的白名单，不只看码。
    if (isSignInGone(status, body)) {
      throw new SignInError(`Accio 未登录或登录已过期（${code || status} ${String(body?.message ?? "")}）`.trim())
    }
    throw new Error(`Accio ${path} 失败（${code || status} ${String(body?.message ?? "")}）`.trim())
  }
  return body?.data
}

/**
 * 当前账号：`POST /api/auth/userinfo`，**token 在 body 的 `accessToken`**。
 *
 * 实测（2026-10-29，真实 token）：
 *   POST {"accessToken":"…"} → 200 {"success":true,"code":"200","data":{
 *     userId:"1798171953", accioId:"4500118477724", userName:"Accio User",
 *     email:null, maskedMobile:"+86 138****8000", mobileBound:true,
 *     needBindMobile:false, userLevel:"freeMember", routeRegion:"CN" }}
 *   ⚠ 参数名不是 `token`：放 `token` 会得到 200 + {"code":"400","message":"accessToken accessToken is null"}
 *   ⚠ 只接受 POST：GET / Authorization 头都是 405。
 */
export async function fetchUserInfo(credential) {
  const res = await fetchWithRetry(() => fetch(`${GATEWAY}${USERINFO_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ accessToken: credential.access_token }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }))
  const text = await res.text()
  const data = unwrap(USERINFO_PATH, res.status, text)
  return data ?? {}
}

/** 邀请关系是否已绑定（`data` 是布尔）。token 同样在 body 的 `accessToken`。 */
export async function fetchInvitation(credential) {
  const res = await fetchWithRetry(() => fetch(`${GATEWAY}${INVITE_QUERY_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ accessToken: credential.access_token }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }))
  const text = await res.text()
  const data = unwrap(INVITE_QUERY_PATH, res.status, text)
  return data === true
}

/**
 * 提交邀请码：`POST /api/invitation/commit`，body `{accessToken, code}`。
 *
 * 参数名 `code` 来自官方客户端（asar 里 `Oh(km.invitationCommit, { code: n })`），
 * 不是 `invitationCode` —— 后者只是客户端本地 HTTP 服务的入参名。
 */
export async function commitInvitation(credential, code) {
  const res = await fetchWithRetry(() => fetch(`${GATEWAY}${INVITE_COMMIT_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ accessToken: credential.access_token, code }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }))
  const text = await res.text()
  return unwrap(INVITE_COMMIT_PATH, res.status, text) ?? {}
}

/** 模型目录：`POST /api/llm/config/v2`，token 在 body。 */
export async function fetchCatalog(credential) {
  const res = await fetchWithRetry(() => fetch(`${GATEWAY}${CATALOG_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ token: credential.access_token }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }))
  const text = await res.text()
  const data = unwrap(CATALOG_PATH, res.status, text)
  return parseCatalog({ data })
}

/** 额度端点：`GET …?accessToken=…`。 */
async function entitlementGet(path, credential) {
  const url = `${GATEWAY}${path}?accessToken=${encodeURIComponent(credential.access_token)}`
  const res = await fetchWithRetry(() => fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }))
  const text = await res.text()
  return unwrap(path, res.status, text)
}

/** 三类桶的**固定顺序**与展示名（键序由服务端决定，同一账号两次读数可能不同）。 */
const CREDIT_BUCKETS = [
  { key: "daily", label: "每日积分" },
  { key: "monthly", label: "每月积分" },
  { key: "referral", label: "推荐积分" },
]

/**
 * 额度 → magpie windows。
 *
 * 契约要点（`src/quota.mjs` 会在写法错时直接抛）：
 *   · `used` 必填且是有限数字 —— 它同时是**路由排序输入**，漏了按 0% = 满额，
 *     空号反而排到路由队首；
 *   · `resetsAt` 必须是 ISO —— 厂商原样时间会让整条窗口被丢掉；
 *   · **不要把窗口全标 `aside`** —— 全 aside 的账号在路由里等于不存在。
 *     所以这里剩 0 的桶也照样给 `used: 100`，不塞进折叠区。
 */
export async function fetchUsage(credential) {
  const data = await entitlementGet(SUBSCRIPTION_PATH, credential)
  const entitlement = data && typeof data.entitlement === "object" && data.entitlement !== null
    ? data.entitlement
    : undefined

  if (entitlement === undefined) {
    // 服务端给了响应但既无桶也无总余额：明说，不退化成 0
    if (typeof data?.remaining !== "number") {
      return buildUsage({
        plan: "Accio",
        windows: [usageWindow({ name: "Accio", used: 0, display: "响应未包含余额字段" })],
      })
    }
    return buildUsage({
      plan: "Accio",
      windows: [usageWindow({ name: "Accio 积分", used: 0, display: `剩余 ${data.remaining}`, amount: 0, limit: Math.max(1, data.remaining), unit: "积分" })],
    })
  }

  // quota 端点失败可容忍（只影响「每日桶何时刷新」这一条展示）
  let dailyResetIso
  try {
    const quota = await entitlementGet(QUOTA_PATH, credential)
    const seconds = Number(quota?.refreshCountdownSeconds)
    if (Number.isFinite(seconds) && seconds > 0) {
      dailyResetIso = new Date(Date.now() + seconds * 1000).toISOString()
    }
  } catch {
    // 倒计时缺席就留空（不编造）
  }

  const windows = []
  for (const bucket of CREDIT_BUCKETS) {
    const value = entitlement[bucket.key]
    if (typeof value !== "object" || value === null) continue
    const remaining = Number(value.remaining)
    if (!Number.isFinite(remaining)) continue // 桶在但读不到 remaining = 数据不足，跳过
    const used = Number(value.used)
    const total = Number(value.total)
    const percent = Number.isFinite(total) && total > 0
      ? Math.max(0, Math.min(100, Math.round(((Number.isFinite(used) ? used : total - remaining) / total) * 100)))
      : (remaining <= 0 ? 100 : 0)

    // ⚠ `display` 是 magpie **一定渲染**的兜底：结构化字段（resetsAt / amount）
    //   实测会被 quotas.json 丢掉一部分（Gyl1219 hub AGENTS §4）。重要信息写进 display。
    const resetLabel = bucket.key === "daily" && dailyResetIso !== undefined
      ? ` · ${new Date(dailyResetIso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })} 刷新`
      : ""
    // ⚠ 这里必须说「剩余」而不是「已用」：`amount` 传的是 used（magpie 按已用占占比），
    //   而用户在卡片上找的是「我还有多少」。0.1.5 及以前写「已用 0 / 500」，
    //   被当成「这个号没有邀请积分」（真实投诉，2026-10-29）。
    const display = Number.isFinite(total) && total > 0
      ? `剩余 ${remaining} / ${total}${resetLabel}`
      : `剩余 ${remaining}${resetLabel}`
    windows.push(usageWindow({
      name: `Accio · ${bucket.label}`,
      used: percent,
      // 有上限就给 amount/limit（能画成「已用 / 总量」），否则只给 display
      ...(Number.isFinite(total) && total > 0 && Number.isFinite(used)
        ? { amount: used, limit: total, unit: "积分" }
        : {}),
      display,
      ...(bucket.key === "daily" && dailyResetIso !== undefined ? { resetsAt: dailyResetIso } : {}),
    }))
  }

  return buildUsage({
    plan: "Accio",
    windows: windows.length > 0
      ? windows
      : [usageWindow({ name: "Accio", used: 0, display: "已登录（未读到积分桶）" })],
  })
}