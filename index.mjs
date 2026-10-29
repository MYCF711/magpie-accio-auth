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
import { accountKeyOf, readMagpieAuthSlots, readModels, utdid, writeModels } from "./src/store.mjs"
import { importDesktopLogin } from "./src/desktop.mjs"

/** 内嵌图标（自绘 SVG，13 行；不引用厂商素材）。`package.json` 的 `magpie.icon` 是同一份。 */
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

export const AccioAuthPlugin = async ({ client } = {}) => {
  const log = (msg, level = "info") => {
    try {
      client?.app?.log?.({ service: "accio", level, message: msg })
    } catch {
      // 没有日志通道就算了
    }
  }

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
           */
          prompts: [
            {
              type: "select",
              key: "region",
              message: "登录站点",
              options: [
                { label: "中国站（accio-ai.com）", value: "cn" },
                { label: "国际站（zh.accio.com）", value: "global" },
              ],
            },
            {
              // 新账号注册时填上级的邀请码：登录页按 `?ic=…` 建立邀请关系，
              // 要等新号注册完才生效，所以这里只能带进 URL，不能事后补。
              type: "text",
              key: "invite",
              message: "邀请码（可选，新账号归属上级）",
              placeholder: "留空跳过；形如 IC624891464548",
              validate: (v) => {
                const c = String(v ?? "").trim()
                return c === "" || /^IC[0-9A-Z]{6,}$/i.test(c) ? undefined : "邀请码形如 IC624891464548"
              },
            },
          ],

          /**
           * ⚠ **立刻返回**，不能在这里等用户完成登录 —— 真正等的是 callback()。
           *   死等会让双方互等（magpie 要等 url 才开浏览器）。
           */
          async authorize(inputs) {
            const region = inputs?.region === "global" ? "global" : "cn"
            const inviteCode = String(inputs?.invite ?? "").trim()
            const started = await beginLogin({ region, inviteCode })
            return {
              url: started.url,
              instructions: started.instructions,
              method: "auto",

              async callback() {
                try {
                  const cred = await started.result
                  // 账号显示名：官方 `/api/auth/userinfo` 给的手机号（邮箱登录时是邮箱）。
                  // 拿不到就退回空串让卡片用供应商名 —— **不编造**。
                  const info = await fetchUserInfo(cred).catch((e) => {
                    log(`拿不到账号信息，卡片将显示供应商名：${e?.message ?? e}`, "warn")
                    return null
                  })
                  return {
                    type: "success",
                    // magpie 的 refreshLead 机制读这两个
                    access: JSON.stringify(cred),
                    refresh: cred.refresh_token,
                    expires: expiryMs(cred),
                    accountId: accountLabelOf(info),
                    // 区分同名账号（同一站两个账号）
                    uid: identityOf(cred),
                  }
                } catch (e) {
                  return { type: "failed", error: String(e?.message ?? e).slice(0, 500) }
                }
              },
            }
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
           * 邀请码 —— 走官方 `/api/invitation/commit`（参数名 `code`，取自客户端 asar）。
           *
           * 只对**已登录**的账号有意义：新号注册时的邀请关系由登录 URL 的 `?ic=` 建立
           * （主登录方法的「邀请码」输入框），这里是「登录之后补绑」的入口。
           */
          type: "oauth",
          label: `Accio 邀请码（绑定到已登录账号）`,
          prompts: [
            {
              type: "text",
              key: "code",
              message: "邀请码",
              placeholder: "IC624891464548",
              validate: (v) =>
                /^IC[0-9A-Z]{6,}$/i.test(String(v ?? "").trim()) ? undefined : "邀请码形如 IC624891464548",
            },
          ],

          async authorize(inputs) {
            const code = String(inputs?.code ?? "").trim().toUpperCase()
            const cred = currentAccioCredential()
            // ⚠ authorize 里失败只能抛（返回 failed 是 callback 的契约）
            if (!cred) throw new Error("先用「登录 Accio」登录一个账号，再来绑定邀请码")
            return {
              // 不需要浏览器：magpie 的契约要求带 url，这里标记 opened 让它别再开一次
              url: LOGIN_BASE_CN,
              opened: true,
              method: "auto",
              instructions: `正在把邀请码 ${code} 提交到当前账号…`,

              async callback() {
                try {
                  await commitInvitation(cred, code)
                  const bound = await fetchInvitation(cred).catch(() => false)
                  const info = await fetchUserInfo(cred).catch(() => null)
                  return {
                    type: "success",
                    access: JSON.stringify(cred),
                    refresh: cred.refresh_token,
                    expires: expiryMs(cred),
                    accountId: accountLabelOf(info),
                    uid: identityOf(cred),
                    instructions: `邀请码 ${code} 已提交${bound ? "（本账号已绑定邀请关系）" : ""}`,
                  }
                } catch (e) {
                  return { type: "failed", error: String(e?.message ?? e).slice(0, 300) }
                }
              },
            }
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

        try {
          const u = await fetchUsage(cred)
          return u
        } catch (e) {
          if (e instanceof SignInError) {
            return { error: "Accio 登录已失效，请重新登录", windows: [], signIn: "expired" }
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
     *   ③ 登录失效       → 抛 `signIn: "expired"`
     */
    provider: {
      id: PROVIDER,
      name: PROVIDER_NAME,

      async models(provider, { auth } = {}) {
        const fallback = staticModels()
        const cred = credentialOf(auth)
        if (!cred) return fallback

        try {
          const entries = await fetchCatalog(cred)
          if (!entries.length) return fallback
          writeModels(keyOf(cred), entries)
          const live = liveModels(entries)
          return Object.keys(live).length > 0 ? live : fallback
        } catch (e) {
          if (e instanceof SignInError) {
            throw Object.assign(new Error("Accio 登录已失效，请重新登录"), { signIn: "expired" })
          }
          const snap = readModels(keyOf(cred))
          if (Array.isArray(snap?.entries) && snap.entries.length > 0) {
            log(`目录拉取失败，回退上次快照：${e?.message ?? e}`, "warn")
            const cached = liveModels(snap.entries)
            if (Object.keys(cached).length > 0) return cached
          }
          log(`目录拉取失败，回退静态表：${e?.message ?? e}`, "warn")
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
}