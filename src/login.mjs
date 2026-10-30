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

/**
 * **明确不是**「refresh_token 不能用了」的措辞。
 *
 * ⚠ 为什么必须先过这一关（2026-10-30 实测）：阿里网关的风控/限流会这样回 ——
 *   `POST /api/auth/userinfo` → `{"success":false,"code":"555","message":"blocked by sentinel rate limit"}`
 *   而在**同一个被限流的出口 IP** 上，catalog / entitlement 回的是
 *   `{"code":"403","message":"auth failed"}` / `{"code":"401","message":"NOT_LOGIN"}`
 *   —— 与拿一串垃圾 token 打过去**逐字相同**（对照实验见 docs/internals.md §13）。
 *   ⇒ 「上游说不认识这个 token」≠「这个号被吊销了」，也可能是本机出口被风控。
 *   终态标记是**不可逆**的（magpie 把账号标死、要人工重登），所以只要沾到
 *   限流 / 风控 / 超时 / 5xx / 网络 的字样，一律不判终态，留给下一次重试。
 */
const TRANSIENT_MARKERS = [
  "rate limit", "ratelimit", "too many requests", "429", "throttl",
  "sentinel", "blocked by", "风控", "限流", "访问频繁", "请稍后",
  "timeout", "timed out", "etimedout", "econnreset", "econnrefused", "enotfound", "eai_again",
  "fetch failed", "socket hang up", "other side closed", "terminated",
  "500", "502", "503", "504", "555", "bad gateway", "service unavailable",
]

/** 这条报错是不是「暂时性」的（限流 / 风控 / 超时 / 网络 / 5xx）。 */
export function isTransientRefreshError(error) {
  const lowered = String(error instanceof Error ? error.message : error).toLowerCase()
  return TRANSIENT_MARKERS.some((m) => lowered.includes(m.toLowerCase()))
}

/**
 * 续期失败是否**终态**：只有上游明说 refresh_token 不能用了才算。
 * ⚠ 顺序要紧：先排「暂时性」再看终态标记 —— 反过来会把风控/超时报文里
 *   偶然出现的 `not_login` 字样当成终态。
 */
export function isTerminalRefreshError(error) {
  if (isTransientRefreshError(error)) return false
  const lowered = String(error instanceof Error ? error.message : error).toLowerCase()
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
 * @returns {Promise<{url: string, result: Promise<object>, instructions: string, close: () => void, attachBrowserExit: (p: Promise<any>) => void}>}
 *   `url` 立刻可用；`result` 兑现完整凭据。
 *   `attachBrowserExit(p)` 把**我们自己拉的那个浏览器窗口**的退出信号挂上来
 *   （`src/browser.mjs` 的 `exit`）：窗口没了而授权回调还没来，就不必干等满 10 分钟
 *   超时，直接以「登录窗口已关闭」收尾。之所以是挂载而不是构造参数：
 *   窗口的 `exit` promise 要先有 url（窗口才开得起来）才能拿到，是个先有蛋后有鸡。
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
    // ⚠ 标记「回调已经到了」：此后用户随手关掉窗口**不算**「登录没完成」——
    //   换 token 还在飞，关窗只是关掉那个标签页而已。
    gotCallback = true
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
  let gotCallback = false
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

  // 用户把登录窗口关掉了：回调还没来就直接收尾，给出能照做的原因。
  // ⚠ 三种情形要分清，提示完全不同：
  //   · 窗口活了不到 3 秒就退出 → 多半是那个浏览器不认启动参数（换 Chrome/Chromium 试）
  //   · 用户自己关掉了窗口      → 只是改主意了，重新点一次即可
  //   · 一直等不到              → 10 分钟超时（另有兜底）
  const attachBrowserExit = (exit) => {
    if (!exit || typeof exit.then !== "function") return
    exit
      .then((info) => {
        if (settled || gotCallback) return
        const why = info?.signal ? `信号 ${info.signal}` : `退出码 ${info?.code ?? "未知"}`
        const tooQuickly = Number.isFinite(info?.ms) && info.ms < 3000
        fail(
          new Error(
            tooQuickly
              ? `Accio: 登录窗口一起来就退出了（${why}，${info.ms}ms）—— 多半是这个浏览器不认插件的启动参数。换一个 Chromium 内核的浏览器（Chrome / Chromium）再试一次。`
              : `Accio: 登录窗口已关闭（${why}），没收到授权回调 —— 请重新发起登录（关闭不影响已有账号）`,
          ),
        )
      })
      .catch(() => {})
  }

  return {
    url,
    result,
    instructions: `在打开的页面里完成 Accio 登录（${siteLabel}），完成后本窗口自动继续。`,
    close: () => settle(false, new Error("Accio: 登录已取消")),
    attachBrowserExit,
  }
}

export { EXPIRY_LEAD_MS }