// 凭据的读写与身份
//
// ═══════════════════════════════════════════════════════════════════
// 存在 magpie 里的形状
// ═══════════════════════════════════════════════════════════════════
//
// magpie 的 plugin-auth.json 里，一个 accio 账号长这样：
//
//   {
//     "type": "oauth",
//     "access": "<JSON 字符串，见下>",
//     "refresh": "<Accio refresh_token>",
//     "expires": 1792872000000,
//     "accountId": "",
//     "uid": "jwt-sub:1735... 或 sha256:<12 位>"
//   }
//
// `access` 里那份 JSON 的结构（与 DSH 渠道的 accio 凭据同口径）：
//
//   {
//     "access_token":  "acc01_...",
//     "refresh_token": "rt01_...",
//     "expires_at":    1792872000000,   // ⚠ **毫秒**（上游 `expiresAt` 是秒，换码时已归一）
//     "region":        "cn" | "global", // 登录站点（只影响登录页域名）
//     "sgcookie":      "..."            // 可选：换码响应给了才带
//   }
//
// ═══════════════════════════════════════════════════════════════════
// 为什么 expires 必须归一化成毫秒
// ═══════════════════════════════════════════════════════════════════
//
// 上游 `expiresAt` 是**秒**。忘归一化 → 判「1970 年已过期」→ 每个请求都续期
// → 并发消费 refresh_token（一次性）→ `invalid_grant` → **账号被标死**。
// 这是迁移时实测到的第一号坑，`accioExpiresAtMs` 是它的唯一入口。
//
// ═══════════════════════════════════════════════════════════════════
// 为什么 accountId 是空的
// ═══════════════════════════════════════════════════════════════════
//
// Accio 的换码 / 续期响应**只给两个 token 和一个过期时间**，没有账号名、邮箱、用户 id。
// 不编造显示名（三级回退的下一级 metadata.email 也没有），所以卡片显示「Accio」。
// 多账号靠 `uid` 区分：先试着从 access_token 里解 JWT 的 sub；不是 JWT 就退回
// refresh_token 的哈希。⚠ 后者在重登时会变 —— 同一账号重登会多出一张卡（不会覆盖掉
// 旧凭据，也就不会把可用账号弄丢）。这是「不编造稳定 id」的代价，写进 README。

import { createHash } from "node:crypto"

/** 安全解析：对象直接用，字符串尝试 JSON.parse */
function parseMaybeJson(raw) {
  if (raw && typeof raw === "object") return raw
  if (typeof raw !== "string" || raw.length === 0) return null
  try {
    const j = JSON.parse(raw)
    return j && typeof j === "object" ? j : null
  } catch {
    return null
  }
}

/**
 * 秒→毫秒归一化。`> 1e12` 视为已是毫秒（防御性）。
 * 非正数 / 非数字 → undefined（**不猜**，由调用方决定怎么办）。
 */
export function accioExpiresAtMs(raw) {
  // 数字 / 数字字符串：秒（≤1e12）→ 毫秒
  if (typeof raw === "number" || (typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw.trim()))) {
    const n = typeof raw === "number" ? raw : Number(raw.trim())
    if (!Number.isFinite(n) || n <= 0) return undefined
    return n > 1e12 ? Math.round(n) : Math.round(n * 1000)
  }
  if (raw instanceof Date) {
    const ms = raw.getTime()
    return Number.isNaN(ms) ? undefined : ms
  }
  // ⚠ 日期字符串必须走 Date.parse，不能 Number()：
  //   `Number("2026-10-28 03:37:02")` = NaN → 旧实现会判「未过期」→ 拿死 token 打上游
  //   （Gyl1219 hub AGENTS §5 的真机教训）。这里明确返回毫秒或 undefined。
  if (typeof raw === "string") {
    const s = raw.trim()
    if (s === "") return undefined
    const direct = Date.parse(s)
    if (!Number.isNaN(direct)) return direct
    // 「2026-10-28 23:59:59」这种空格分隔、无时区的厂商原样格式
    const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/)
    if (m) {
      const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0))
      if (!Number.isNaN(d.getTime())) return d.getTime()
    }
    return undefined
  }
  return undefined
}

/**
 * 读一份 magpie auth 记录，取出完整凭据。
 *
 * 兼容两种来源：
 *   ① 本插件的形状（access 是 JSON 字符串）
 *   ② 字段直接铺在 auth 上（手写的 / 早先版本的记录）
 *
 * @returns {object|null} 完整凭据，或 null（未登录 / 形状不对）
 */
export function credentialOf(auth) {
  if (!auth) return null

  const parsed = parseMaybeJson(auth.access)
  const fromParsed = parsed && typeof parsed.access_token === "string" && parsed.access_token !== ""
  const fromFlat = typeof auth.access_token === "string" && auth.access_token !== ""
  if (!fromParsed && !fromFlat) return null

  const base = fromParsed ? parsed : auth
  const expiresAt = accioExpiresAtMs(base.expires_at)
  if (expiresAt === undefined) return null

  return {
    access_token: base.access_token,
    refresh_token: typeof base.refresh_token === "string" ? base.refresh_token : (typeof auth.refresh === "string" ? auth.refresh : ""),
    expires_at: expiresAt,
    ...(typeof base.region === "string" && base.region !== "" ? { region: base.region } : {}),
    ...(typeof base.sgcookie === "string" && base.sgcookie !== "" ? { sgcookie: base.sgcookie } : {}),
  }
}

/** 凭据到期时间（毫秒）；缺就保守给 1 小时后（只用于 magpie 的续期调度，不是判定依据）。 */
export function expiryMs(cred) {
  const at = accioExpiresAtMs(cred?.expires_at)
  return at ?? Date.now() + 60 * 60 * 1000
}

/** 是否临期 */
export function nearExpiry(cred, leadMs) {
  const at = accioExpiresAtMs(cred?.expires_at)
  if (at === undefined) return false
  return at - Date.now() <= leadMs
}

/** JWT payload（不校验签名 —— 只用它取身份，不做任何信任判断） */
function jwtPayload(token) {
  if (typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 3 || parts[1] === "") return null
  try {
    const json = Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    const payload = JSON.parse(json)
    return payload && typeof payload === "object" ? payload : null
  } catch {
    return null
  }
}

/**
 * 账号身份（magpie 的 `uid`）。
 *
 * 顺序：JWT 里的 sub / userId / uid / accountId → refresh_token 哈希。
 * ⚠ 返回值**不含凭据明文**，也不可反推凭据。
 */
export function identityOf(cred) {
  const payload = jwtPayload(cred?.access_token)
  if (payload) {
    for (const key of ["sub", "userId", "uid", "accountId", "loginId"]) {
      const v = payload[key]
      if (typeof v === "string" && v !== "") return `jwt-${key}:${v}`
      if (typeof v === "number" && Number.isFinite(v)) return `jwt-${key}:${v}`
    }
  }
  const rt = typeof cred?.refresh_token === "string" ? cred.refresh_token : ""
  if (rt === "") return ""
  return `sha256:${createHash("sha256").update(rt, "utf8").digest("hex").slice(0, 12)}`
}

/**
 * 把凭据写回 magpie 记录的形状。
 *
 * ⚠ 这个函数的输出会被 magpie 存进 plugin-auth.json。
 *   改形状就等于让老用户的登录态失效 —— 不要改。
 *
 * @param {object} cred   完整凭据
 * @param {object} [prev] 上一份记录（保留 type 等字段）
 */
export function toStored(cred, prev) {
  return {
    ...(prev ?? {}),
    type: "oauth",
    expires: expiryMs(cred),
    access: JSON.stringify(cred),
    refresh: cred.refresh_token ?? "",
    // Accio 不给账号名 —— 空字符串让 magpie 三级回退落到供应商名，不编一个假的
    accountId: typeof cred.accountId === "string" ? cred.accountId : "",
    uid: identityOf(cred),
  }
}

/** 续期后「凭据真的换了吗」的指纹（access + refresh）。没换 ⇒ 重发注定同一个拒绝。 */
export function tokenFingerprint(cred) {
  return `${cred?.access_token ?? ""}::${cred?.refresh_token ?? ""}`
}

/**
 * 卡片上显示的账号名 —— 官方 `/api/auth/userinfo` 的优先级：
 *   手机号（`+86 189****8051` → 去掉 `+86 `，与其它供应商一致）
 *   → 邮箱 → `userId` → 空串（空串让卡片回退到供应商名，**不编造**）。
 */
export function accountLabelOf(info) {
  if (!info) return ""
  const mobile = String(info.maskedMobile ?? "").trim()
  if (mobile) return mobile.replace(/^\+?86\s*/, "")
  const mail = String(info.email ?? info.desensitizedEmail ?? "").trim()
  if (mail) return mail
  return String(info.userId ?? "").trim()
}
