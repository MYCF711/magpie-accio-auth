// 登录（PKCE + 本地 loopback 回调）与续期
//
// ═══════════════════════════════════════════════════════════════════
// 登录流程
// ═══════════════════════════════════════════════════════════════════
//
//   1. 生成 PKCE（verifier = 48 随机字节的 base64url，官方客户端同款）+ state
//   2. 起一个 127.0.0.1 的临时回调服务（端口由系统分配）
//   3. 打开 {LOGIN_BASE}/login?return_url=<loopback>&code_challenge=…&client_id=accio-work…
//   4. 用户在页面里完成登录 → 页面跳回 loopback/auth/callback?code=…&state=…
//   5. POST {GATEWAY}/api/oauth/token 用 code + verifier 换凭据
//
// ⚠ `authorize()` 必须**立刻返回**，不能在里面等用户完成登录 ——
//   真正等登录的是 `callback()`。死等会让双方互等。
//   所以这里把「等」放进挂起的 result promise，url 立刻可用。
//
// ⚠ 授权 URL 的参数**缺一不可**：少了 `code_challenge` 会被登录页判为 legacy 客户端
//   而弹「请升级客户端」—— 这是社区移植最常踩的坑。
//
// ⚠ Accio 对 `return_url` **无白名单校验**，所以回调端口可以由插件自起自管；
//   但因此**必须严格校验 state**：否则任何能往 loopback 投查询串的本地进程
//   都能把攻击者的授权码写进用户账号。
//
// ═══════════════════════════════════════════════════════════════════
// 续期的两个坑
// ═══════════════════════════════════════════════════════════════════
//
// 1. **刷新会轮换 refresh_token**。两个并发请求同时看到临期 → 各发一次续期
//    → 第二次消费已被消费的 token → `invalid_grant` → 凭据永久失效。
//    故必须**去重**，且键要用凭据身份（refresh_token）而不是 provider id ——
//    账号池下同一 provider 有多个账号，按 provider 键控会让账号 B 共享账号 A 的结果。
// 2. 续期成功就**立即返回**给调用方落盘（`index.mjs` 的 refresh 钩子），
//    不要攒到下次再说 —— 旧 refresh_token 此刻已经作废。

import { createHash, randomBytes } from "node:crypto"
import { createServer } from "node:http"

import {
  CALLBACK_PATH,
  INVITE_PARAM,
  INVITE_SID_PARAM,
  INVITE_SOURCE,
  CLIENT_ID,
  EXPIRY_LEAD_MS,
  GATEWAY,
  LOGIN_BASE_CN,
  LOGIN_BASE_GLOBAL,
  LOGIN_TIMEOUT_MS,
  REFRESH_PATH,
  REQUEST_TIMEOUT_MS,
  TOKEN_EXCHANGE_PATH,
} from "./constants.mjs"
import { accioExpiresAtMs } from "./credential.mjs"

/** PKCE：verifier 是 **48 随机字节**的 base64url（官方客户端同款）。 */
export function createPkce() {
  const verifier = randomBytes(48).toString("base64url")
  const challenge = createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

/**
 * 拼授权 URL。
 * ⚠ 五个参数缺一不可，`ttid` 每次新生成（上游拿它做一次性的客户端标记）。
 */
export function buildAuthUrl({ region, redirectUri, state, codeChallenge, inviteCode, inviteSid }) {
  const params = new URLSearchParams({
    return_url: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    client_id: CLIENT_ID,
    ttid: `ttid_${randomBytes(16).toString("hex")}`,
    language: "zh",
  })
  // 邀请：与官方分享链接逐字一致（`?ic=…&tenant=accio&src=p_referral_…&source=invite_center`）。
  // 登录页把 `ic` 记在会话里，注册完成即建立邀请关系 —— 少一个参数上级就拿不到奖励。
  const invite = String(inviteCode ?? "").trim()
  if (invite) {
    params.set(INVITE_PARAM, invite)
    params.set("tenant", "accio")
    params.set("src", `p_referral_${invite}`)
    params.set("source", INVITE_SOURCE)
    // 官方分享链接里与 `ic` 配对的那个 `sId`（base64，`==` 会被编码成 %3D%3D）
    const sid = String(inviteSid ?? "").trim()
    if (sid) params.set(INVITE_SID_PARAM, sid)
  }
  const base = region === "global" ? LOGIN_BASE_GLOBAL : LOGIN_BASE_CN
  return `${base}/login?${params.toString()}`
}

/** 解析 `{success, code, message, data}` 信封；失败抛**带服务端原文**的错误。 */
export function unwrapEnvelope(path, status, text) {
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`Accio: ${path} 返回非 JSON（HTTP ${status}）：${text.slice(0, 200)}`)
  }
  // ⚠ 业务失败恒 HTTP 200 —— 只看状态码会把「失败」当成功
  if (body?.success !== true) {
    throw new Error(`Accio: ${path} 失败（${String(body?.code ?? status)} ${String(body?.message ?? "")}）`.trim())
  }
  if (body.data === null || typeof body.data !== "object") {
    throw new Error(`Accio: ${path} 响应缺 data 对象`)
  }
  return body.data
}

/** data → 凭据。⚠ 三者缺一不可（官方客户端同款校验）；expiresAt 秒→毫秒在此一次性完成。 */
export function toCredential(path, data, extra = {}) {
  const access = data?.accessToken
  const refresh = data?.refreshToken
  const expiresAt = accioExpiresAtMs(data?.expiresAt)
  if (typeof access !== "string" || access === "") throw new Error(`Accio: ${path} 响应缺 accessToken`)
  if (typeof refresh !== "string" || refresh === "") throw new Error(`Accio: ${path} 响应缺 refreshToken`)
  if (expiresAt === undefined) throw new Error(`Accio: ${path} 响应缺 expiresAt（或非正数）`)
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at: expiresAt,
    ...(typeof data?.sgcookie === "string" && data.sgcookie !== "" ? { sgcookie: data.sgcookie } : {}),
    ...extra,
  }
}

/** 授权码 → 凭据 */
export async function exchangeCode({ code, codeVerifier, redirectUri, region }) {
  const res = await fetch(`${GATEWAY}${TOKEN_EXCHANGE_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ code, codeVerifier, clientId: CLIENT_ID, redirectUri }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  return toCredential(TOKEN_EXCHANGE_PATH, unwrapEnvelope(TOKEN_EXCHANGE_PATH, res.status, text), {
    region: region === "global" ? "global" : "cn",
  })
}

/** 续期失败的**终态**标记（refresh_token 真的不能用了）。 */
const TERMINAL_MARKERS = [
  "invalid_grant", "invalid refresh token", "invalid refresh_token",
  "refresh token has been used", "refresh_token has been used", "refresh token expired",
  "refresh_token expired", "expired refresh token", "NOT_LOGIN", "not_login",
]

export function isTerminalRefreshError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const lowered = message.toLowerCase()
  return TERMINAL_MARKERS.some((m) => lowered.includes(m.toLowerCase()))
}

/**
 * 续期（纯协议）。
 *
 * ⚠⚠ **刷新会轮换 refresh_token** —— 调用方必须走 `refreshOnce` 的串行闸，
 *   不要在并发路径里直接调它。
 */
export async function refreshCredential(current) {
  if (typeof current?.refresh_token !== "string" || current.refresh_token === "") {
    throw new Error("凭据缺少 refresh_token，请重新登录")
  }
  const res = await fetch(`${GATEWAY}${REFRESH_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ accessToken: current.access_token, refreshToken: current.refresh_token }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  const text = await res.text()
  const next = toCredential(REFRESH_PATH, unwrapEnvelope(REFRESH_PATH, res.status, text), {
    region: current.region === "global" ? "global" : "cn",
  })
  // 续期响应不给 sgcookie 就沿用旧的（不要编造，也不要丢）
  if (typeof current.sgcookie === "string" && next.sgcookie === undefined) next.sgcookie = current.sgcookie
  return next
}

// ── 并发去重闸 ────────────────────────────────────────────────────────
const refreshInFlight = new Map()

/**
 * 带并发去重的续期。
 *
 * ⚠ 键必须是**凭据身份**（refresh_token），不是 provider id ——
 *   账号池下同一 provider 有多个账号并发续期，按 provider 键控会让账号 B
 *   共享账号 A 的续期结果（拿到别人的凭据，且 B 的 token 根本没被消费）。
 */
export function refreshOnce(current) {
  const key = `accio\n${current?.refresh_token ?? ""}`
  const pending = refreshInFlight.get(key)
  if (pending !== undefined) return pending

  const task = refreshCredential(current).finally(() => refreshInFlight.delete(key))
  refreshInFlight.set(key, task)
  return task
}

// ── 启动登录 ──────────────────────────────────────────────────────────

const page = (title, message) =>
  "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
  `<title>${title}</title></head>` +
  `<body style="font-family:system-ui;padding:2rem"><p>${message}</p></body></html>`

/**
 * 起本地回调服务 + 授权 URL，**立刻**返回（`authorize()` 契约）。
 *
 * @param {object} [opts]
 * @param {"cn"|"global"} [opts.region] 登录站点
 * @returns {Promise<{url: string, result: Promise<object>, instructions: string, close: () => void}>}
 *   `url` 立刻可用（magpie 会打开它）；`result` 兑现完整凭据。
 */
export async function beginLogin({ region = "cn", inviteCode = "", inviteSid = "" } = {}) {
  const site = region === "global" ? "global" : "cn"
  const pkce = createPkce()
  const state = randomBytes(32).toString("hex")

  let settleOk, settleFail
  const result = new Promise((resolve, reject) => { settleOk = resolve; settleFail = reject })
  result.catch(() => {}) // 防 unhandledRejection
  let settled = false
  let timer
  let serverClosed = false

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404, { "Content-Type": "text/html; charset=utf-8" }).end(page("Accio 授权", "未知的回调路径"))
      return
    }
    const params = url.searchParams

    // ⚠ state 必须原样匹配：否则任何能往 loopback 投查询串的本地进程都能
    //   把攻击者的授权码写进用户账号。
    if ((params.get("state") ?? "") !== state) {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        .end(page("Accio 授权失败", "state 校验失败，请回到 magpie 重新发起登录"))
      fail(new Error("Accio: 登录回调 state 不匹配（可能是伪造的回调）"))
      return
    }

    const errorCode = params.get("error")
    if (errorCode !== null && errorCode !== "") {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        .end(page("Accio 授权失败", `授权被拒绝：${errorCode}`))
      fail(new Error(`Accio: 授权被拒绝（${errorCode}）`))
      return
    }

    const code = params.get("code") ?? ""
    if (code === "") {
      response.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
        .end(page("Accio 授权失败", "回调里没有授权码"))
      fail(new Error("Accio: 登录回调缺少授权码"))
      return
    }

    // 先回提示页再后台兑换：用户不必盯着转圈的标签页等换 token。
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
      .end(page("Accio 授权", "授权已收到，可以关闭此页面并返回 magpie。"))
    exchangeCode({ code, codeVerifier: pkce.verifier, redirectUri, region: site })
      .then((cred) => settle(true, cred))
      .catch((error) => settle(false, error instanceof Error ? error : new Error(String(error))))
  })

  const closeServer = () => {
    if (serverClosed) return
    serverClosed = true
    server.close()
  }
  let redirectUri = ""
  const settle = (ok, value) => {
    if (settled) return
    settled = true
    if (timer !== undefined) clearTimeout(timer)
    closeServer()
    ok ? settleOk(value) : settleFail(value)
  }
  const fail = (error) => settle(false, error)

  timer = setTimeout(() => fail(new Error("Accio: 登录超时（未收到授权回调）")), LOGIN_TIMEOUT_MS)
  timer.unref?.()

  // ⚠ 先挂 'error' 再 listen（EADDRINUSE 是异步 error 事件，不挂会崩进程）。
  const port = await new Promise((resolve, reject) => {
    let settledListen = false
    server.once("error", (error) => {
      if (settledListen) return
      settledListen = true
      reject(error)
    })
    // 只绑回环：绑全网卡会让同局域网机器也能投伪造的 ?code=
    server.listen(0, "127.0.0.1", () => {
      settledListen = true
      server.on("error", () => {})
      const addr = server.address()
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0)
    })
  }).catch((error) => {
    fail(new Error(`Accio: 回调端口无法监听（${error.message}）`))
    throw error
  })

  redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`
  const url = buildAuthUrl({ region: site, redirectUri, state, codeChallenge: pkce.challenge, inviteCode, inviteSid })
  const siteLabel = site === "global" ? "国际站（zh.accio.com）" : "中国站（accio-ai.com）"

  return {
    url,
    result,
    instructions: `在打开的页面里完成 Accio 登录（${siteLabel}），完成后本窗口自动继续。`,
    close: () => settle(false, new Error("Accio: 登录已取消")),
  }
}

export { EXPIRY_LEAD_MS }