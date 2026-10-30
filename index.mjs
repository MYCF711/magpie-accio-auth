// Accio（阿里 Accio Work）· magpie 供应商插件
//
// ═══════════════════════════════════════════════════════════════════════
// 九项清单（一项不缺）
// ═══════════════════════════════════════════════════════════════════════
//
//  钩子
//   ① config(cfg)                      声明 provider + 静态模型表
//   ② auth.methods[].authorize()       Accio OAuth（PKCE + 本机 loopback 回调）
//   ③ auth.refresh(auth, provider)     凭据续期（轮换 refresh_token，带去重闸）
//   ④ auth.loader(getAuth, provider)   请求接管（OpenAI → Accio Gemini 信封）
//   ⑤ auth.usage(getAuth, provider)    积分类别分桶（每日 / 每月 / 推荐）
//   ⑥ auth.checkin(getAuth, provider)  Accio 无每日签到 → inactive
//   ⑦ provider.models(provider,{auth}) 每账号目录（失败回退静态表）
//   ⑧ "chat.headers"(input, output)    每请求加头（utdid 双保险）
//
//  数据字段
//   ⑨ accountId / uid                  卡片显示名 / 区分同名账号
//      icon / maxConcurrency           图标与并发
//
// ═══════════════════════════════════════════════════════════════════════
// 这个插件只做一件事
// ═══════════════════════════════════════════════════════════════════════
//
// magpie 底下的 AI SDK 只会发 OpenAI 协议（`@ai-sdk/openai-compatible`），
// 而 Accio 的对话端点是**Gemini 风格信封 + 私有 SSE**：
// 插件在 `loader().fetch` 里把 OpenAI 请求翻成 Accio 信封、把 Accio 的 SSE 翻回
// OpenAI chunk 流。除对话外的所有东西（登录、续期、额度、目录、签到调度、
// 账号池、故障转移、代理、流式转发）都交给 magpie。
//
// ═══════════════════════════════════════════════════════════════════════
// 协议依据
// ═══════════════════════════════════════════════════════════════════════
//
// 全部字段级结论来自 DSH 2026-10 的真机实测（见 `docs/internals.md` 举证），
// 以及本仓库 2026-10-29 对四个真实端点的独立探测。
//
// ═══════════════════════════════════════════════════════════════════════

import {
  APP_VERSION,
  EXPIRY_LEAD_MS,
  LOGIN_BASE_CN,
  NPM,
  PLACEHOLDER_BASE,
  PROVIDER,
  PROVIDER_NAME,
} from "./src/constants.mjs"
import { accountLabelOf, credentialOf, expiryMs, identityOf, nearExpiry, toStored } from "./src/credential.mjs"
import { beginLogin, isTerminalRefreshError, refreshOnce } from "./src/login.mjs"
import { SignInError, commitInvitation, fetchCatalog, fetchInvitation, fetchUserInfo, fetchUsage } from "./src/api.mjs"
import { FALLBACK_ENTRIES, liveModels, makeIndex, staticModels } from "./src/models.mjs"
import { chat } from "./src/chat.mjs"
import {
  SIGNIN_CONFIRM_STRIKES,
  accountKeyOf,
  clearSignInGone,
  noteSignInGone,
  readInviteCode,
  readInviteSid,
  readModels,
  utdid,
  writeInviteCode,
  writeModels,
} from "./src/store.mjs"
import { importDesktopLogin } from "./src/desktop.mjs"
import { launchLoginBrowser } from "./src/browser.mjs"

/** 内嵌图标（自绘 SVG，13 行；不引用厂商素材）。`package.json` 的 `magpie.icon` 是同一份。 */
/** 登录站点选择 —— 主登录与「邀请码」方法共用同一份。 */
const REGION_PROMPT = {
  type: "select",
  key: "region",
  message: "登录站点",
  options: [
    { label: "中国站（accio-ai.com）", value: "cn" },
    { label: "国际站（zh.accio.com）", value: "global" },
  ],
}

/**
 * 「邀请码」那个数字框的灰色字 —— 与 magicrew 同一套文案节奏：
 * 打开时按当前策略现算，用户一眼知道现在用的是哪个码。
 */
function inviteHint() {
  const c = readInviteCode()
  return c
    ? `当前模式：自动（${c}）· 输入 1 保持不变，或直接填新码`
    : "还没有邀请码：直接填，形如 IC624891464548"
}

function invitePrompt() {
  return { type: "text", key: "invite", message: "邀请码", placeholder: inviteHint() }
}

/** 面板标题后缀 —— 让「当前用哪个码」在选登录方式那一屏就能看见（加载时算一次）。 */
function inviteTag() {
  const c = readInviteCode()
  return c ? `（邀请码 ${c}）` : ""
}

/**
 * 数字框的值 → 真正要带进登录 URL 的码。
 *   0 / 留空 / 1 → 沿用当前策略（1 是「保持当前」；Accio 没有多账号码表，二者等价）
 *   其它         → 当作新码（大写）
 */
function resolveInviteChoice(raw) {
  const s = String(raw ?? "").trim()
  if (s === "" || s === "0" || s === "1") return readInviteCode()
  return s.toUpperCase()
}

/**
 * 主登录与「邀请码」共用的 callback：
 *   拿凭据 → 取账号名 → 有邀请码就顺手提交一次（老账号已有关系时服务端会忽略）→ 记下这个码。
 *
 * ⚠ `log` 必须由调用方传进来：这个函数在模块级，而日志通道挂在插件实例的 `client` 上。
 *   之前这里直接写 `log(...)` —— 一旦走到「拿不到账号信息」那条 catch，就是
 *   `ReferenceError: log is not defined`，把一次**成功**的登录报成失败。
 *
 * ⚠ `session` 是我们自己拉的那个干净浏览器窗口：登录一结束（成功/失败/超时）就关掉它，
 *   顺手把一次性 profile 目录删掉 —— 那个目录里装着这次登录的 cookie。
 */
function loginCallback(started, inviteCode, { log = () => {}, session = null } = {}) {
  return async function callback() {
    try {
      const cred = await started.result
      const info = await fetchUserInfo(cred).catch((e) => {
        log(`拿不到账号信息，卡片将显示供应商名：${e?.message ?? e}`, "warn")
        return null
      })
      if (inviteCode) {
        await commitInvitation(cred, inviteCode).catch((e) => {
          log(`邀请码提交失败（登录本身已成功）：${e?.message ?? e}`, "warn")
        })
        writeInviteCode(inviteCode, "used")
      }
      return {
        type: "success",
        access: JSON.stringify(cred),
        refresh: cred.refresh_token,
        expires: expiryMs(cred),
        accountId: accountLabelOf(info),
        uid: identityOf(cred),
      }
    } catch (e) {
      return { type: "failed", error: String(e?.message ?? e).slice(0, 500) }
    } finally {
      // 无论成败都收窗口：失败时留着它只会让用户以为还在等
      try {
        session?.close?.()
      } catch {
        // 关不掉不影响这次登录的结果
      }
    }
  }
}

/** 自己开出来的那个干净窗口的说明文案（用户看得到，要说清「为什么又要登一次」）。 */
function cleanBrowserNote(browserName) {
  return (
    `已用 ${browserName} 打开一个**全新窗口**（独立 profile，读不到你日常浏览器的任何登录态）。\n` +
    "要添加哪个号，就在这个窗口里登哪个号 —— 它会直接进登录页，不会落到已经登录的账号上。\n" +
    "登录完这个窗口会自动关上；中途关掉也没关系，重新点一次即可。"
  )
}

/**
 * 「邀请码」方法拿不到 getAuth()（magpie 的 method 契约只有 inputs），
 * 从 magpie 自己的账号槽里找当前 accio 账号；多个账号时不猜，让用户去账号页确认。
 */
function currentAccioCredential() {
  const slots = readMagpieAuthSlots(PROVIDER)
  if (slots.length === 0) return null
  const cred = credentialOf(slots[0].value)
  return cred ?? null
}

const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMTAxYTI2Ii8+PHBhdGggZD0iTTY0IDI2IEw5NiAxMDIgSDgwIEw3MiA4MiBINTYgTDQ4IDEwMiBIMzIgWiBNNjAgNjggSDY4IEw2NCA1MiBaIiBmaWxsPSIjZmY3YTQ1Ii8+PC9zdmc+"

/** 账号目录快照的键（per-account，见 src/store.mjs） */
const keyOf = (cred) => accountKeyOf(cred?.refresh_token)

export const AccioAuthPlugin = async ({ client, launcher } = {}) => {
  const log = (msg, level = "info") => {
    try {
      client?.app?.log?.({ service: "accio", level, message: msg })
    } catch {
      // 没有日志通道就算了
    }
  }

  // 拉起干净浏览器窗口的那一步。生产走 src/browser.mjs；测试注入一个假的，
  // 否则「添加账号」这条路径没法在 CI/无 GUI 环境下验证。
  const openBrowser = typeof launcher === "function" ? launcher : launchLoginBrowser

  /** 把续期后的凭据写回 magpie（`client.auth.set` 是整体替换，不是合并）。 */
  const saveAuth = async (cred, prev) => {
    const set = client?.auth?.set
    if (typeof set !== "function") return false
    try {
      await set({ path: { id: PROVIDER }, body: toStored(cred, prev) })
      return true
    } catch (e) {
      // 写回失败不阻断请求 —— magpie 自己的 refreshLead 还会再试一次
      log(`凭据写回失败：${e?.message ?? e}`, "warn")
      return false
    }
  }

  /** 硬续期（异常透传），走按凭据身份键控的去重闸。 */
  const renew = async (current, prev) => {
    const next = await refreshOnce(current)
    await saveAuth(next, prev)
    return next
  }

  /** 取该账号的 slug → modelCode 映射；没有快照就用兜底表。 */
  const indexOf = (cred) => {
    const snap = readModels(keyOf(cred))
    return makeIndex(Array.isArray(snap?.entries) ? snap.entries : FALLBACK_ENTRIES)
  }

  /**
   * 「登录 Accio」与「邀请码」两条网页登录路径的唯一入口。
   *
   * ═══ 为什么不把 `url` 交给 magpie 去开 ═══
   *
   * `authorize()` 只回 `{url, method:"auto"}` 时，magpie 拿它开**系统默认浏览器** ——
   * 那个浏览器里带着用户日常的 Accio 会话，点「添加账号」会直接落到**已经登录的号**上
   * （主人 2026-10-30 的原话：「添加账号就会导入之前的登录态」）。
   * 所以这里自己拉一个 `--user-data-dir=<一次性目录>` 的窗口，并回 `opened: true`
   * 告诉 magpie「页面已经由我打开了，你别再开一遍」（HOOKS.md 陷阱 3）。
   *
   * ═══ 起不来浏览器时怎么办 ═══
   *
   * **明确报错，不静默退回系统浏览器** —— 退回就等于把「落到旧账号」这个 bug 又放回来，
   * 而用户完全看不出发生了什么。抛出的错误里带上「装了哪些路径」与「装个 Chrome 再试」。
   */
  const startCleanLogin = async ({ region, inviteCode, inviteSid }) => {
    const started = await beginLogin({ region, inviteCode, inviteSid })
    let session
    try {
      session = await openBrowser(started.url)
    } catch (e) {
      started.close() // 浏览器起不来：把回环端口也一起放掉
      log(`拉起浏览器失败：${e?.message ?? e}`, "warn")
      throw e
    }
    // 用户把窗口关掉 → 立刻以「窗口已关闭」收尾，不让 callback 干等满 10 分钟
    started.attachBrowserExit(session.exit)
    log(`已用 ${session.name} 打开干净 profile 的登录窗口：${session.profileDir}`, "info")
    return {
      url: started.url,
      opened: true,
      instructions: cleanBrowserNote(session.name),
      method: "auto",
      callback: loginCallback(started, inviteCode, { log, session }),
    }
  }

  return {
    // ═══ ① 声明 provider ═════════════════════════════════════════════
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: NPM,
        api: PLACEHOLDER_BASE,
        // ⚠ 未登录时也必须有内容，否则 magpie 显示 "0 models"
        models: staticModels(),
      }
    },

    auth: {
      provider: PROVIDER,
      // 两处图标各管一块：auth.icon → 供应商行 / 用量卡；package.json magpie.icon → 插件卡片
      icon: ICON,
      maxConcurrency: 3,
      refreshLead: EXPIRY_LEAD_MS,

      // ═══ ② 登录 ═══════════════════════════════════════════════════
      methods: [
        {
          type: "oauth",
          label: `登录 ${PROVIDER_NAME}（阿里 Accio Work）`,
          /**
           * 两个登录入口，但**同一个供应商**：换码、目录、对话、额度都在
           * phoenix-gw.alibaba.com —— 站点只决定登录页域名。
           * 判据见 README「一个站点还是两个」。
           *
           * 邀请码不在这里问：与 magicrew 同款，邀请码有独立的登录方式，
           * 保存后由 `readInviteCode()` 自动带上；这样「登录 Accio」永远只问站点。
           */
          prompts: [REGION_PROMPT],

          /**
           * ⚠ **立刻返回**，不能在这里等用户完成登录 —— 真正等的是 callback()。
           *   死等会让双方互等（magpie 要等 url 才开浏览器）。
           *   但「立刻返回」指的是不等**登录结果**：拉起浏览器本身是同步做完的
           *   （起不来就当场抛错，而不是把 url 丢给 magpie 用系统浏览器开）。
           */
          async authorize(inputs) {
            const region = inputs?.region === "global" ? "global" : "cn"
            const inviteCode = readInviteCode()
            return startCleanLogin({ region, inviteCode, inviteSid: readInviteSid() })
          },
        },
        {
          /**
           * 从本机 Windows 客户端导入 —— 免登录、免滑块。
           *
           * 官方客户端登录后把 accessToken / refreshToken / expiresAt / sgcookie 写在
           * `%APPDATA%\Accio\credentials.enc`（Chromium OSCrypt v10，DPAPI 保护）。
           * 它与网站 OAuth 是**同一套 token**，所以直接拿来就能用（详见 src/desktop.mjs 头）。
           *
           * 没有客户端 / 客户端没登录 / 凭据过期 → 明确报错，让用户走网页登录。
           */
          type: "oauth",
          label: "从本机 Accio 客户端导入（免登录）",
          async authorize() {
            return {
              // 不需要浏览器：契约要求 url，标记 opened 让 magpie 别再开
              url: LOGIN_BASE_CN,
              opened: true,
              method: "auto",
              instructions: "正在读取本机 Accio 客户端的登录态…",

              async callback() {
                try {
                  const got = importDesktopLogin()
                  if (!got) {
                    return {
                      type: "failed",
                      error: "没找到本机 Accio 客户端的登录态。先在「Accio」客户端里登录一次，再回来点这个；没有客户端就用「登录 Accio」。",
                    }
                  }
                  // 用导入的 token 真打一次 userinfo：既验证凭据可用，也顺手拿账号名
                  const info = await fetchUserInfo(got.credential).catch(() => null)
                  if (!info?.userId) {
                    return {
                      type: "failed",
                      error: "读到了客户端凭据，但它已经失效（userinfo 取不到账号）——请在客户端重新登录一次再试。",
                    }
                  }
                  return {
                    type: "success",
                    access: JSON.stringify(got.credential),
                    refresh: got.credential.refresh_token,
                    expires: expiryMs(got.credential),
                    accountId: accountLabelOf(info),
                    uid: identityOf(got.credential),
                  }
                } catch (e) {
                  return { type: "failed", error: `读取客户端登录态失败：${String(e?.message ?? e).slice(0, 300)}` }
                }
              },
            }
          },
        },
        {
          /**
           * 邀请码 —— 与 magicrew 同款形态：
           *
           *   ① 一个**数字文本框**：0/留空 = 自动（沿用当前策略码）、1 = 保持当前、
           *      其它 = 直接当新邀请码；
           *   ② `ask()` 多步问答：问完邀请码**直接接主登录**（不再回「已保存」就结束）；
           *   ③ 保存策略 → 之后所有登录入口（含「登录 Accio」）自动带 `?ic=<码>`。
           *
           * 与 magicrew 的唯一差别：Accio 没有「查询自己邀请码」的接口
           * （`/api/invitation/query` 只返回布尔），所以「自己码」的来源是
           * **上一次成功使用的码**（`accio-invite.json`），首次由用户填一次。
           */
          type: "oauth",
          label: `Accio 邀请码${inviteTag()}`,
          get prompts() {
            return [invitePrompt()]
          },
          async ask(inputs) {
            if (!inputs || !Object.prototype.hasOwnProperty.call(inputs, "invite")) return invitePrompt()
            if (!Object.prototype.hasOwnProperty.call(inputs, "region")) return REGION_PROMPT
            return null
          },
          async authorize(inputs) {
            const code = resolveInviteChoice(inputs?.invite)
            if (code) writeInviteCode(code, "chosen")
            const region = inputs?.region === "global" ? "global" : "cn"
            // sId 只跟「策略里的那个码」成对；用户临时换码时不能拿旧 sId 去配新码
            const inviteSid = code && code === readInviteCode() ? readInviteSid() : ""
            // 与主登录同一条：自己拉干净 profile 的窗口，不借系统浏览器的登录态
            return startCleanLogin({ region, inviteCode: code, inviteSid })
          },
        },
      ],

      // ═══ ③ 续期 ═══════════════════════════════════════════════════
      /**
       * ⚠ 返回的字段**合并**到旧账号上（与 client.auth.set 的整体替换不同）。
       *
       * ⚠⚠ Accio 的刷新**轮换 refresh_token** —— 并发续期会「1 成功、其余 invalid_grant」，
       *   失败方会把好账号标死。串行由 magpie 的 15 秒等待 + 这里的 refreshOnce 双重保证。
       */
      async refresh(auth, provider) {
        const cred = credentialOf(auth)
        if (!cred?.refresh_token) return undefined

        try {
          const next = await renew(cred, auth)
          const stored = toStored(next, auth)
          return {
            access: stored.access,
            refresh: stored.refresh,
            expires: stored.expires,
            uid: stored.uid,
          }
        } catch (e) {
          if (isTerminalRefreshError(e)) {
            // refresh_token 真的不能用了 → 标记账号，不再重试直到重新登录
            throw Object.assign(new Error("Accio 续期失败，请重新登录"), { signIn: "expired" })
          }
          throw e
        }
      },

      // ═══ ④ 请求接管 ═══════════════════════════════════════════════
      async loader(getAuth, provider) {
        const auth = await getAuth()
        const cred = credentialOf(auth)
        if (!cred) return {}

        return {
          // ⚠ 不能是空串：magpie 会据它判「无处可发」；真正的上游在 fetch 里改写
          baseURL: PLACEHOLDER_BASE,
          // 空 apiKey：我们自己在请求体里放 token（放 Authorization 头恒流内 402）
          apiKey: "",

          async fetch(input, init) {
            // ⚠ 每次重新读 auth —— 可能已被 refresh 更新
            const fresh = await getAuth()
            let current = credentialOf(fresh) ?? cred

            // 临期软续期：失败不抛、沿用原凭据（与 Gyl1219 hub 的 ensureAuth 同口径）。
            // 真正确凿的失效由下方 chat 的 401 硬续期兜底。
            if (nearExpiry(current, EXPIRY_LEAD_MS)) {
              try {
                current = await renew(current, fresh)
              } catch (e) {
                log(`临期软续期失败，沿用原凭据：${e?.message ?? e}`, "warn")
              }
            }

            let body
            if (typeof init?.body === "string") {
              try {
                body = JSON.parse(init.body)
              } catch {
                return Response.json(
                  { error: { type: "invalid_request_error", message: "请求体不是 JSON" } },
                  { status: 400 },
                )
              }
            }
            if (body === undefined || typeof body?.model !== "string") {
              return Response.json(
                {
                  error: {
                    type: "invalid_request_error",
                    message: `无法识别的请求：model=${String(body?.model ?? "(空)")}`,
                  },
                },
                { status: 404 },
              )
            }

            // chat.headers 钩子（以及 SDK）带来的头：只取我们认识的那几个
            const incoming = new Headers(init?.headers ?? {})
            const extraHeaders = {}
            for (const name of ["utdid", "sgcookie"]) {
              const v = incoming.get(name)
              if (typeof v === "string" && v !== "") extraHeaders[name] = v
            }

            return chat({
              credential: current,
              body,
              index: indexOf(current),
              signal: init?.signal,
              extraHeaders,
              // 硬续期：失败抛，才能与「续期成功但没变化」区分开
              renew: () => renew(current, fresh),
            })
          },
        }
      },

      // ═══ ⑤ 额度 ═══════════════════════════════════════════════════
      /**
       * 卡片上的进度条 = `usage.windows`。三类积分桶各自一条：
       *   `Accio · 每日积分` / `每月积分` / `推荐积分`
       *
       * ⚠ 窗口里 `used` 必填、`resetsAt` 必须是 ISO、不要把窗口全标 `aside`
       *   —— 三条都是「写错不报错，但 GUI 和智能路由会坏」。
       *   本仓库用 `src/quota.mjs` 的构造器，写错会直接抛。
       */
      async usage(getAuth, provider) {
        const auth = await getAuth()
        const cred = credentialOf(auth)
        if (!cred) return { error: "未登录", windows: [] }
        const account = keyOf(cred)

        try {
          const u = await fetchUsage(cred)
          // 读到干净的一次 → 这个账号自愈（magpie 那边也是这么清的）
          clearSignInGone(account)
          return u
        } catch (e) {
          if (e instanceof SignInError) {
            // ⚠ 一次不算数：`401 NOT_LOGIN` 也可能是风控/限流伪装出来的
            //   （2026-10-30 实测，见 src/api.mjs 头与 docs/internals.md §13）。
            //   标死账号要用户人工重登，代价太大 ⇒ 连续两次、隔 ≥1 分钟才确认。
            const strikes = noteSignInGone(account)
            if (strikes >= SIGNIN_CONFIRM_STRIKES) {
              return { error: "Accio 登录已失效，请重新登录", windows: [], signIn: "expired" }
            }
            return {
              error: `${String(e?.message ?? e)}（第 ${strikes}/${SIGNIN_CONFIRM_STRIKES} 次，暂不标记失效）`.slice(0, 300),
              windows: [],
            }
          }
          // 上游失败 → 让卡片显示原因（吞成 0 会被当成空号排到路由队首）
          return { error: String(e?.message ?? e).slice(0, 300), windows: [] }
        }
      },

      // ═══ ⑥ 签到 ═══════════════════════════════════════════════════
      /**
       * Accio 没有「每日签到领积分」这类活动 —— 积分按套餐周期自动刷新
       * （`/api/entitlement/quota` 的 `refreshCountdownSeconds`）。
       * 契约词汇表里这一档是 `inactive`：不是失败，只是没有这个活动。
       */
      async checkin(getAuth, provider) {
        return { outcome: "inactive", message: `${PROVIDER_NAME} 无每日签到（积分按套餐周期自动刷新）` }
      },
    },

    // ═══ ⑦ 每账号的模型目录 ═════════════════════════════════════════
    /**
     * 三态降级（方向各自选对）：
     *   ① 整个接口失败   → 退回上次快照；没有快照才退回静态表（**不返回空表**）
     *   ② 单条缺字段     → 不列（`normalizeModel` 里剔除，不猜）
     *   ③ 登录失效       → 抛 `signIn: "expired"`（**连续两次确认后**才抛，见下）
     */
    provider: {
      id: PROVIDER,
      name: PROVIDER_NAME,

      async models(provider, { auth } = {}) {
        const fallback = staticModels()
        const cred = credentialOf(auth)
        if (!cred) return fallback
        const account = keyOf(cred)

        try {
          const entries = await fetchCatalog(cred)
          if (!entries.length) return fallback
          clearSignInGone(account)
          writeModels(account, entries)
          const live = liveModels(entries)
          return Object.keys(live).length > 0 ? live : fallback
        } catch (e) {
          if (e instanceof SignInError) {
            // 与 usage 同一套确认：上游说「不认这个 token」不等于「号被吊销」，
            // 风控限流会回一模一样的报文（docs/internals.md §13）。
            const strikes = noteSignInGone(account)
            if (strikes >= SIGNIN_CONFIRM_STRIKES) {
              throw Object.assign(new Error("Accio 登录已失效，请重新登录"), { signIn: "expired" })
            }
            log(`目录拉取报登录失效（第 ${strikes}/${SIGNIN_CONFIRM_STRIKES} 次，暂不标记账号）：${e?.message ?? e}`, "warn")
          } else {
            log(`目录拉取失败：${e?.message ?? e}`, "warn")
          }
          const snap = readModels(account)
          if (Array.isArray(snap?.entries) && snap.entries.length > 0) {
            log("回退上次目录快照", "warn")
            const cached = liveModels(snap.entries)
            if (Object.keys(cached).length > 0) return cached
          }
          log("回退静态表", "warn")
          return fallback
        }
      },
    },

    // ═══ ⑧ 每请求加头 ═══════════════════════════════════════════════
    /**
     * `utdid` 是阿里网关的风控基线：缺失时回 HTTP 200 + 一张 HTML 拦截页。
     * 这里补一次，`loader().fetch` 会把它并进上游请求头（双保险）。
     */
    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== PROVIDER) return
      output.headers.utdid = utdid()
    },
  }
}

// 供测试引用（⚠ 入口文件不要导出 helper 函数，否则会被当插件调用）
export const _internal = {
  PROVIDER,
  APP_VERSION,
  staticModels,
  liveModels,
  makeIndex,
  FALLBACK_ENTRIES,
  // 登录回调的收尾逻辑（拿账号名那一步失败时必须仍然算登录成功）
  loginCallback,
}