// Accio（阿里 Accio Work）· 端点与常量
//
// ═══════════════════════════════════════════════════════════════════
// 三个域，别混
// ═══════════════════════════════════════════════════════════════════
//
//   GATEWAY          一切 API：登录换码、续期、模型目录、对话、额度
//   LOGIN_BASE_CN    中国站登录页（www.accio-ai.com）
//   LOGIN_BASE_GLOBAL 国际站登录页（zh.accio.com）
//
// ⚠ 两个登录域只决定「在哪个站登录」；换码、目录、对话、额度**都在 GATEWAY**。
//   所以这是**一个供应商**，不是「国内 / 国际两张卡」——
//   MULTI-PROVIDER 的判据（后端 host 不同、账号体系不同、目录不同）一条都不满足。
//
// 实测（2026-10-29，本机直连）：
//   POST /api/llm/config/v2  无 token        → HTTP 200 {"success":false,"code":"403","message":"auth failed"}
//   POST /api/oauth/token    假 code         → HTTP 200 {"success":false,"code":"90004","message":"invalid_request"}
//   GET  /api/entitlement/*  ?accessToken=…  → HTTP 200 {"success":false,"code":"401","message":"NOT_LOGIN"}
//   GET  https://www.accio-ai.com/login       → HTTP 200，54,652 B（标题 "Login to Accio"）
//   GET  https://zh.accio.com/login           → HTTP 200，72,692 B（同一标题）
//   ⇒ 四个端点都在，且失败恒为 **HTTP 200 + body 内的 code**（只看状态码会全部漏判）。
//
// ═══════════════════════════════════════════════════════════════════

/** 一切 API 的网关。登录站点只是登录参数，不改变这里。 */
export const GATEWAY = "https://phoenix-gw.alibaba.com"

/** 中国站登录页 */
export const LOGIN_BASE_CN = "https://www.accio-ai.com"

/** 国际站登录页 */
export const LOGIN_BASE_GLOBAL = "https://zh.accio.com"

/** 授权码 → 凭据（PKCE public client，无 secret） */
export const TOKEN_EXCHANGE_PATH = "/api/oauth/token"

/** 凭据续期（**轮换 refresh_token**） */
export const REFRESH_PATH = "/api/auth/refresh_token"

/** 对话（Gemini 风格信封，SSE 响应） */
export const LLM_PATH = "/api/adk/llm/generateContent"

/** 模型目录（`data[].modelList[]`） */
export const CATALOG_PATH = "/api/llm/config/v2"

/** 额度：订阅与积分桶 */
export const SUBSCRIPTION_PATH = "/api/entitlement/currentSubscription"

/** 额度：每日刷新倒计时（`refreshCountdownSeconds`） */
export const QUOTA_PATH = "/api/entitlement/quota"

/** 本地 loopback 回调路径 */
export const CALLBACK_PATH = "/auth/callback"

/**
 * PKCE public client id。
 * ⚠ 登录页会按它认客户端；少了 `code_challenge` 会被判成旧客户端而弹「请升级客户端」。
 */
export const CLIENT_ID = "accio-work"

/** 上游认的 app key（随每个对话请求发） */
export const APP_KEY = "OneChat"

/**
 * 官方桌面客户端版本号，随每个对话请求发。
 * ⚠ 与真实客户端差太远时可能吃风控 —— 升级客户端后同步这一行（`accio.mjs` 移植口径）。
 */
export const APP_VERSION = "0.34.4"

/** 请求超时 */
export const REQUEST_TIMEOUT_MS = 30_000

/** 登录窗口总时长 */
export const LOGIN_TIMEOUT_MS = 10 * 60 * 1000

/** token 提前续期窗口（与其它插件一致的 10 分钟口径） */
export const EXPIRY_LEAD_MS = 10 * 60 * 1000

/** provider id —— magpie 里模型显示成 `accio/<model>` */
export const PROVIDER = "accio"

/** 供应商名（供应商列表里那一行；插件卡片标题来自 package.json 的 name） */
export const PROVIDER_NAME = "Accio"

/** API 形状：对外仍是 OpenAI chat completions（协议转换在 loader 的 fetch 里做） */
export const NPM = "@ai-sdk/openai-compatible"

/**
 * 占位 baseURL。
 *
 * ⚠ 不能是空串：magpie 会据它判「无处可发」；真正的上游地址在 `loader().fetch` 里改写，
 *   这个 `.invalid` 保留域永远不会被访问（RFC 2606）。
 *
 * 保留 `BASE` 这个别名是给脚手架的 `scripts/score.mjs` 用的：它的身份门按
 * `const BASE = "…"` 判「是不是还没改模板」。两个名字同一份值，别再引第三个。
 */
export const BASE = "https://accio.invalid/v1"
export const PLACEHOLDER_BASE = BASE