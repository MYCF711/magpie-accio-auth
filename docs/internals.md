# internals —— 协议取证、实测结论、静默失败点

> 这份是给改代码的人看的。README 只回答「我能拿到什么、怎么装」。
> 所有结论要么有本仓库的探测命令，要么有来源标注；**没有凭印象写的数字**。

---

## 1 · 端点与实测（2026-10-29，本机直连，未登录）

| 请求 | 结果 | 说明 |
|---|---|---|
| `POST https://phoenix-gw.alibaba.com/api/llm/config/v2`（body `{"token":""}`） | `HTTP 200` `{"success":false,"code":"403","message":"auth failed","data":null}` | 端点活着；失败是**业务码** |
| `POST …/api/oauth/token`（假 code） | `HTTP 200` `{"success":false,"code":"90004","message":"invalid_request"}` | 换码端点存在，`clientId=accio-work` 被接受 |
| `GET …/api/entitlement/currentSubscription?accessToken=fake` | `HTTP 200` `{"success":false,"code":"401","message":"NOT_LOGIN"}` | 额度是「HTTP 200 + 业务码」 |
| `GET …/api/entitlement/quota?accessToken=fake` | `HTTP 200` `{"success":false,"code":"401","message":"NOT_LOGIN"}` | 同上 |
| `POST …/api/auth/refresh_token`（假 token） | `HTTP 200` `{"success":false,"code":"401","message":"NOT_LOGIN"}` | 同上 |
| `GET https://www.accio-ai.com/login?…` | `HTTP 200`，54,652 B，`<title>Login to Accio</title>` | 登录页活着 |
| `GET https://zh.accio.com/login?…` | `HTTP 200`，72,692 B，同一标题 | 国际站同一套页面 |

复跑：

```bash
curl -s -X POST https://phoenix-gw.alibaba.com/api/llm/config/v2 \
  -H 'Content-Type: application/json' -d '{"token":""}'
curl -s "https://phoenix-gw.alibaba.com/api/entitlement/currentSubscription?accessToken=fake"
```

**结论一：所有非对话端点都是「HTTP 200 + 信封里的 `success` / `code`」。**
只看状态码会把每一次失败当成功 —— `src/api.mjs` 与 `src/login.mjs` 的 `unwrap()` 是唯一判据。

**结论二：三个端点里 token 的位置各不相同。**

```
目录  POST /api/llm/config/v2                    token 在 body 的 token
额度  GET  /api/entitlement/*                    token 在 query ?accessToken=
对话  POST /api/adk/llm/generateContent?sg_k=…   token 在 body 的 token（放 Authorization 头恒流内 402）
```

---

## 2 · 登录

```
1. PKCE：verifier = 48 随机字节的 base64url；challenge = sha256(verifier).base64url
2. 起 127.0.0.1:<随机端口>/auth/callback 的临时服务
3. 打开 {中国站|国际站}/login?return_url=<loopback>&state=…&code_challenge=…&code_challenge_method=S256
   &client_id=accio-work&ttid=ttid_<32hex>&language=zh
4. 用户登录 → 页面跳回 loopback?code=…&state=…
5. POST {GATEWAY}/api/oauth/token  { code, codeVerifier, clientId, redirectUri }
   → data: { accessToken, refreshToken, expiresAt(秒), sgcookie? }
```

| 事实 | 错了会怎样 |
|---|---|
| 授权 URL 五个参数缺一不可 | 少 `code_challenge` 会被登录页判为 legacy 客户端，弹「请升级客户端」（社区移植最常踩） |
| `expiresAt` 是**秒** | 不 ×1000 → 判「1970 年已过期」→ 每请求都续期 → 并发消费 refresh_token → `invalid_grant` → 账号标死 |
| `return_url` 无白名单校验 | 好处：回调端口可以自起自管；代价：**必须严格校验 `state`**，否则任何本地进程都能投毒一个 `?code=` |
| 回调服务只绑 `127.0.0.1` | 绑 `0.0.0.0` 会让同局域网机器也能投伪造的 `?code=` |
| 先回提示页、后台换码 | 用户不必盯着转圈的标签页等换 token |

**为什么是一个供应商而不是两张卡**：两站的差异只有登录页域名（`www.accio-ai.com` / `zh.accio.com`）；
换码、目录、对话、额度全在 `phoenix-gw.alibaba.com`。按脚手架 MULTI-PROVIDER 的判据
（后端 host 不同、账号体系不同、目录不同）一条都不满足 ⇒ 单供应商 + `prompts` 选站点。

### 2.1 登录页真人验证（2026-10-29，ego-browser）

用本插件 `buildAuthUrl()` 生成的真实参数（`client_id=accio-work` + 完整 PKCE）打开两个登录页：

| 站点 | 渲染结果 | 判据 |
|---|---|---|
| `www.accio-ai.com/login?…` | 标题 `Login to Accio`，页面「免费组建你的 Agent 团队 · 登录即可立即开始，赠送免费欢迎额度」；手机号登录 / 邮箱登录 / 阿里巴巴 / 1688 / Google 五个入口 | **没有**「请升级客户端」—— `client_id` 与 `code_challenge` 被接受 |
| `zh.accio.com/login?…` | 同一标题；「使用Alibaba.com 继续」「使用 Google 继续」+ 邮箱输入 | 同上 |

截图：`../tmp/accio-research/login-cn.png`、`../tmp/accio-research/login-global.png`（工作区临时目录）。

### 2.2 宿主里的登录链路（magpie 0.1.1978，沙箱）

```
$ magpie plugin login accio
登录站点
  1. 中国站（accio-ai.com）
  2. 国际站（zh.accio.com）
> 1
Sign in in your browser. If it didn't open, go to:
https://www.accio-ai.com/login?return_url=http%3A%2F%2F127.0.0.1%3A51918%2Fauth%2Fcallback&state=35c1…&code_challenge=KQ8r…&code_challenge_method=S256&client_id=accio-work&ttid=ttid_…&language=zh
在打开的页面里完成 Accio 登录（中国站（accio-ai.com）），完成后本窗口自动继续。
```

⇒ `prompts` 被宿主正确渲染；`authorize()` 在宿主里能立刻返回一个完整的 loopback 回调 URL
（`return_url` 端口 51918 是本进程起的一次性回调服务）。

### 2.3 装进正式实例（magpie 0.1.1978，真实 config）

```
$ magpie plugin add 'D:\主工作区\projects\magpie-accio-auth'
✓ added D:\主工作区\projects\magpie-accio-auth
…
D:\主工作区\projects\magpie-accio-auth (Accio 0.1.0)  on
  accio (Accio, 15 models)  not signed in · magpie plugin login accio
```

- `magpie` 会检测 `plugins.json` 变化并**只重启 plugin host**（`internal/plugin/store.go` 的
  `checkList` / `hostStale`），不需要重启整个进程，网关不中断。
- 未登录时 `/v1/models` 里没有 accio 的模型（magpie 只列已登录 provider 的模型），
  所以此时请求 `accio/<model>` 会得到 `magpie knows no model` —— 这是宿主行为，不是插件缺陷。
- **尚未验证的一步**：真实登录后的模型目录与一次真实对话。它需要账号验证码，只能由使用者本人完成。

---

## 3 · 续期

- 刷新**轮换** `refresh_token`（响应里给新的），所以必须串行。
- 串行有两层：magpie 自己的 15 秒等待 + `src/login.mjs` 的 `refreshOnce`。
- 去重键必须是**凭据身份**（`refresh_token`），不是 provider id —— 账号池下同一 provider
  有多个账号，按 provider 键控会让账号 B 共享账号 A 的结果。
- 终态错误（`invalid_grant` / `token has been used` / `NOT_LOGIN` / `expired`）→
  `signIn: "expired"`，magpie 标记账号、不再重试直到重新登录。
- 其它错误（网络抖动）→ 原样抛，magpie 30 秒后重试。

---

## 4 · 对话（协议转换）

请求（OpenAI → Accio）：

```
POST {GATEWAY}/api/adk/llm/generateContent?sg_k=md5(requestId)
Content-Type: application/json
Accept: text/event-stream
utdid: accio-…     ← 装机级稳定 id（~/.cache/magpie/accio-state.json）
version: 0.34.4    ← 官方客户端版本
appKey: OneChat
body: {
  model: <modelCode>, empid: "", tenant: "", iai_tag: "",
  request_id, user_request_id,
  contents: [{ role: "user"|"model", parts: [{text}|{inlineData}|{functionCall}|{functionResponse}] }],
  system_instruction: "<字符串>",
  tools: [{ name, description, parameters_json: "<JSON 字符串>" }],
  temperature, max_output_tokens, stop_sequences: [],
  properties: { utdid, version, appKey: "OneChat", normalized_response: "true" },
  token: <access_token>,
  message_id, incremental: true
}
```

响应（Accio SSE → OpenAI chunk 流）：

```
data: {"content":{"role":"model","parts":[{"text":"…"} | {"text":"…","thought":true} | {"functionCall":{…}}]},
       "usage_metadata":{…},"finish_reason":"STOP","turn_complete":true}
data: {"error_code":"402","error_message":"unauthorized"}    ← HTTP 仍 200
```

| 事实 | 错了会怎样 |
|---|---|
| token 在 body 的 `token` | 放 `Authorization` 头 → 恒流内 402，错误以 `HTTP 200 + {"error_code":"402"}` 帧下发 → 误报「模型不回复」 |
| 上行必须是 `modelCode` | 发 slug → 请求打空（模型不回复） |
| `system_instruction` 必须是字符串 | 包成对象 → 恒 400「Invalid request format」 |
| `parametersJson` 必须是字符串 | 让 `toSnake` 下钻对象 → schema 里的 `filePath` 被改成 `file_path`，静默变更工具参数名 |
| `properties` 子树不参与 snake 转换 | `appKey` 是驼峰、`normalized_response` 是 snake（两种键形混用），通用转换是未实测形状 |
| 必须校验 content-type | 缺 `utdid` 时网关回 `HTTP 200 + text/html` 拦截页（`bixi-intl.alicdn.com/punish`）→ SSE 解析器吞掉 → 症状与「模型不回复」同形 |
| 工具调用按 id 缓冲、结束合并 | 首帧只有 id/name、后续帧补参数；逐帧发会重复执行工具 |
| `functionResponse` 必须紧密相邻 | 中间插任何东西（含图片 user 消息）都会断开配对；工具结果里的图片要收集后统一追加 |
| `thought` 标记的 part 映射 `reasoning_content` | 混进正文会污染回答 |
| `error_code === "200"` 是成功哨兵 | 当错误抛会把正常流掐断 |
| 空流（一句话都没产出）要报错 | 否则 agent 看到「正常结束但没内容」，排查方向全错 |
| 非流式请求（`stream:false`）自己聚合 | 上游只有流式端点 |

---

## 5 · 模型目录与 id

- 目录：`POST /api/llm/config/v2` → `data[].modelList[]`，逐条 `visible === true` 才列。
- 对外 id = 展示名归一成的 slug（`Qwen 3.8 Flash` → `qwen-3-8-flash`）；
  上行 id = `modelCode`（`1Drift-…`）。
- 映射表由 `provider.models` 拉到的目录生成，随快照落 `~/.cache/magpie/accio-models__<accountKey>.json`；
  `chat` 时用它换回 `modelCode`。查不到**原样发入参**（让上游报错，不本地编造）。
- 明细条目的字段：
  - `rate: "x0.03"`（倍率胶囊；不再拼进模型名）
  - `limit.context` = 目录给的 `contextWindow`（0 时回落 128K）
  - `limit.output` = 目录给的 `maxTokens`（缺省 8192）
  - `capabilities.input.image` **布尔值**（`multimodal === true`）—— 省略会被 models.dev 按裸 id 投票补
  - `variants` = 思考档位（**仅展示**：上游没有任何受控字段，实测四类都不生效）
  - `free` 不写：积分制，没有免费声明；不能从倍率 0 反推
- 撞名 slug 自动加 `-2` / `-3`，否则后一条会覆盖前一条。

**兜底表（15 条）的来源**：DSH 2026-10-12 真机实测的 `modelCode` 清单，经
Gyl1219/magpie-providers-hub 的 `src/accio.mjs` 转述。`modelCode` 非人类可读、无法手工维护，
所以它只用来兜住「未登录也能看到模型」这一件事 —— 真实可用性一律以登录后拉到的目录为准。

---

## 6 · 额度

`GET /api/entitlement/currentSubscription?accessToken=…` →
`data.entitlement.{daily,monthly,referral}`，每桶 `{ remaining, used, total }`。

`GET /api/entitlement/quota?accessToken=…` → `data.refreshCountdownSeconds`（每日桶的刷新倒计时）。

转成 magpie 窗口：

| 桶 | 显示 | 字段 |
|---|---|---|
| 每日积分 | `Accio · 每日积分` | `used = (used/total)*100`、`amount/limit/unit`、`resetsAt`（now + 倒计时，ISO） |
| 每月积分 | `Accio · 每月积分` | 同上，无 `resetsAt`（上游不给） |
| 推荐积分 | `Accio · 推荐积分` | 同上 |

**三条静默失败点（`src/quota.mjs` 会直接抛）：**

1. `used` 缺省 → magpie 按 0% = 满额算，空号反而排到路由队首。
2. `resetsAt` 塞厂商原样时间 → 解析失败，整条窗口被丢掉（卡片「剩余额度未知」）。
3. **窗口全标 `aside`** → `allowanceOf()` 整条跳过 → 这个号在智能路由里等于不存在。
   所以用完的桶给 `used: 100`，**不标 aside**。

---

## 7 · 账号身份（为什么 accountId 是空的）

Accio 的换码 / 续期响应只有两个 token + 过期时间，没有账号名、邮箱、用户 id。

- `accountId` 留空 → magpie 三级回退落到供应商名，卡片显示「Accio」（不编造名字）。
- `uid`：先试着解 `access_token` 的 JWT payload 取 `sub` / `userId` / `uid` / `accountId`；
  不是 JWT 就退回 `sha256(refresh_token)` 前 12 位。
- ⚠ 哈希兜底的副作用：**同一账号重登会得到新 uid ⇒ 多一张卡**（不覆盖旧凭据，也就不会丢账号）。
  这是「不编造稳定 id」的代价，写进 README 的常见问题。

---

## 8 · 文件落点

```
~/.cache/magpie/accio-state.json              装机 id（utdid），全局一份
~/.cache/magpie/accio-models__<accountKey>.json  每账号的模型目录快照（按 refresh_token 哈希命名）
```

- 只写 `~/.cache/magpie`，**不碰 `~/.config/magpie`**（那是 magpie 的目录）。
- 全可删：删掉只是重新拉一次目录 + 生成一个新 utdid。
- 不存 token 明文副本 —— 凭据由 magpie 的 `plugin-auth.json` 管。

---

## 9 · 与其它实现的差别（为什么自己拆一个包）

| 实现 | 形态 | 与本插件的关系 |
|---|---|---|
| [linhuai777/accio2api](https://github.com/linhuai777/accio2api)（MIT，Python） | 独立反代服务：账号池 + 邮箱别名 + 代理池 + Web 控制台 | 不是 magpie 插件；协议结论可交叉参考 |
| [Maicon501a/accio-proxy](https://github.com/Maicon501a/accio-proxy)（Go + Wails） | 双模式：读 Accio.exe 的 DPAPI 加密登录态 / 独立模拟 | 要装客户端；本插件走标准 OAuth，不需要 |
| [alan113523/accio-local-api](https://github.com/alan113523/accio-local-api)（JS） | Anthropic + OpenAI 双协议桥 | 独立进程；本插件是 magpie 插件形态 |
| [Gyl1219/magpie-providers-hub](https://github.com/Gyl1219/magpie-providers-hub)（MIT） | 一个包十个供应商的聚合 hub | 本仓库从它的 `src/accio.mjs` 拆出 accio 单包 —— 聚合形态下 magpie 的 failover 与单渠道开关都是 provider 粒度，做不到 |
| 本仓库 | **一个包一个供应商**（`accio`），九项钩子全实现 | — |

---

## 10 · 检索记录（2026-10-29，「magpie 里有没有 accio 插件」）

| 源 | 检索方式 | 结果 |
|---|---|---|
| magpie 社区插件仓库 | `GET api.github.com/repos/magpie-community/plugins/contents/packages` | **49 个包，没有 accio**：aider, antigravity-cloak, autoclaw, block-patterns, bub, calc, chat, cline, cloudflare-workers-ai, codearts, codex-history, commandcode, copilot, cowork, cursor, devin, factory, gcp-ai, grok, history-trim, joycode, kilo, kimi-desktop, kimi-work, kiro, layerfs, mimo, minimax, model-map, nous, opencodereview, opendesign, param-override, pig, qoder, raccoon, reserve, river, search1api, system-prompt, think-tags, trae, type4me, usage, word-guard, workbuddy, zcode, zed, zen-free |
| 社区 registry.json | 同上仓库 | 未包含 accio 条目 |
| npm | `registry.npmjs.org/-/v1/search?text=accio opencode` / `magpie accio` / `accio auth magpie` | 没有任何 magpie / opencode 的 accio 插件；`@accio-ai/*` 是厂商自己的包（ecommerce-cli / dps-cli），不是插件 |
| npm 包名占用 | `registry.npmjs.org/accio-auth` / `magpie-accio-auth` / `opencode-accio-auth` | 三个都 404（可用） |
| GitHub | `search/repositories?q=accio+2api` / `accio+proxy` / `accio+openai` / `magpie+accio` | 见下表 |

### GitHub 上的 Accio 反代 / 插件形态

| 仓库 | 形态 | 本插件是否采用 |
|---|---|---|
| [Gyl1219/magpie-providers-hub](https://github.com/Gyl1219/magpie-providers-hub) ★1，MIT | 一个包十个供应商的聚合 hub，其中 `src/accio.mjs`（1,144 行）是 Accio 渠道的**真机实测**实现（DSH 2026-10 结论） | **采用**：协议层移植成单供应商插件；去掉聚合层（sidecar / 自注册 / 通知 / sweep） |
| [linhuai777/accio2api](https://github.com/linhuai777/accio2api) ★8，MIT，Python | 独立 OpenAI 兼容反代：账号池 + 邮箱别名 + 代理池 + Web 控制台 | 未采用（不是插件形态）；协议结论可交叉参考 |
| [Maicon501a/accio-proxy](https://github.com/Maicon501a/accio-proxy) ★0，Go+Wails | 双模式：读 Accio.exe 的 DPAPI 登录态，或独立模拟 | 未采用（要装客户端；本插件用标准 OAuth） |
| [alan113523/accio-local-api](https://github.com/alan113523/accio-local-api) ★0，JS | 本地 Anthropic + OpenAI 双协议桥 | 未采用（独立进程） |
| [380758137/accio2api](https://github.com/380758137/accio2api) ★2 | Accio 2API PoC（README 404） | 未采用（PoC） |
| [xyh9949/Accio-Switch](https://github.com/xyh9949/Accio-Switch) ★3 | 反向：让 Accio 客户端用第三方 OpenAI/NewAPI 模型 | 方向相反，未采用 |


---

## 11 · 从 Gyl1219/magpie-providers-hub 学到的（逐条判定：借鉴 / 不借鉴）

`magpie-providers-hub` 是同一批 DSH 真机结论的另一个 magpie 形态（聚合 10 渠道）。本仓库
把它的 `src/accio.mjs` 拆成单供应商插件；下面是**逐文件复核后**的借鉴判定。

### 借鉴（已进代码）

| 来源 | 结论 | 落在哪 |
|---|---|---|
| `src/minimax-transport.mjs` | 传输级重试：只重试 ECONNRESET / ENOTFOUND / `fetch failed` 这类连接错误，2 次 400ms 退避；4xx/5xx 不重试；abort 不重试 | `src/transport.mjs`（`isTransportError` / `fetchWithRetry`），`chat` 与 `api` 都走它 |
| `src/aggregate.mjs` 的 `ensureAuth` / `renewSoft` | loader 发请求前先看临期、先软续期；续期失败不抛、沿用原凭据 | `index.mjs` 的 `loader().fetch` |
| `AGENTS.md` §5 | **chat 不要挂硬超时**（120s 也会掐断长对话）—— magpie 的 signal 管取消 | `src/chat.mjs` 的 `send()` 只透传 `signal` |
| `AGENTS.md` §5 | 过期时间是日期字符串时不能 `Number()`（= NaN → 判「永不过期」→ 拿死 token 打上游） | `src/credential.mjs` 的 `accioExpiresAtMs` 支持 ISO / 空格格式 |
| `AGENTS.md` §4 | `display` 是 magpie 一定渲染的兜底；`resetsAt` / `runsOutAt` 实测会被 `quotas.json` 丢掉 | `src/api.mjs` 的 windows 都带 `display`（含每日刷新时刻） |
| `AGENTS.md` §5 | 渠道 `chat` 必须返回**原始 Response**，不要 `{ response }` 包装（magpie 取 `res.headers.forEach` 会 502） | `src/chat.mjs` 的 `chat()` 直接 return Response |
| `tests/usage.test.mjs` | Accio 的额度口径：三桶固定顺序、0 桶保留、缺席桶不产出、只有 daily 有 resetsAt | `src/api.mjs` 与 `tests/accio.test.mjs` |

### 刻意不借鉴（附理由）

| 来源 | 为什么不 |
|---|---|
| `src/aggregate.mjs` 的 `writeSidecar` / `loadCredential` 旁路双写 | magpie 的 `plugin-auth.json` 已经是账号的唯一来源；插件再存一份会出现两个刷新者，最后凭据分叉、用户莫名掉登录 |
| `page/` 页面快照 + `sweepAllChannels` 5 分钟定时器 + Windows toast | 脚手架「最小交付面」明确禁止：签到调度/额度趋势/界面 magpie 都已做，插件重复实现是错。本插件只用 magpie 的原生卡片 |
| `src/self-register.mjs`（写 magpie 市场缓存） | 上游 `plugins#399` review 明确要求删掉：插件对 magpie 的目录只有读的份 |
| `migrateLegacySlots` / 旧账号槽迁移 | 单供应商、首版，没有旧槽可迁 |
| 重复登录仍有效账号「不覆盖原槽」 | 需要稳定的账号 id；Accio 不返回账号名/邮箱/uid，`uid` 只能从 JWT sub 取，取不到时是 refresh_token 哈希（重登会变）。没有可靠判据时宁可不猜 |
| `shared.mjs` 的 `assignExpiryBands` 滚动指针分档 | hub 的 AGENTS §1 明确写着：**accio 属于「余额/重置型」，不下发作废时间，滚动指针不适用**。本插件按三桶（每日/每月/推荐）+ 每日刷新时刻显示 |
| `chat` 的第二参 `{body, signal, renew}` 约定 | 那是 hub 聚合层的内部接口；magpie 的插件契约是 `loader().fetch(input, init)`，我们已经按 magpie 的接口实现 |


---

## 12 · 账号信息与邀请（2026-10-29 真机）

### 12.1 网站登录态 vs 客户端登录态：同一套 token

Accio 国内版客户端（Electron 41，`E:\Accio`，数据目录 `%APPDATA%\Accio`）的登录态与网站 OAuth **完全同源**：

| | 网站（本插件） | Windows 客户端 |
|---|---|---|
| 换 token | `POST /api/oauth/token`（PKCE） | 同一个 `/api/oauth/token`（客户端打开同一个登录页） |
| 调 API | `phoenix-gw.alibaba.com` + `access_token` | 同一个网关、同一个 `access_token` |
| 用户信息 | `POST /api/auth/userinfo` `{accessToken}` | 同一个接口（asar 里 `userInfo:"/api/auth/userinfo"`） |

⇒ **网站上 OAuth 拿到的 token 就是客户端能用的全部凭据**，不需要读客户端的 cookie / DPAPI。
客户端的 `remembered-accounts.json`（明文）只是它自己的展示缓存，插件不依赖它。

### 12.2 `/api/auth/userinfo`（官方客户端 API 表里的 `userInfo`）

```
POST https://phoenix-gw.alibaba.com/api/auth/userinfo
Content-Type: application/json

{"accessToken":"acc01_live_…"}
```

实测返回（本机真实账号）：

```json
{"success":true,"code":"200","message":"0","data":{
  "userId":"1798171953","accioId":"4500118477724","userName":"Accio User",
  "email":null,"portraitPath":null,"mobileBound":true,"needBindMobile":false,
  "userLevel":"freeMember","desensitizedEmail":null,"originalAliId":null,
  "originalAccountId":null,"routeRegion":"CN",
  "maskedMobile":"+86 189****8051","bindSiteCodeList":null,"activeTeam":null}}
```

- ⚠ **参数名是 `accessToken`**（不是 `token`）：放 `token` → HTTP 200 + `{"code":"400","message":"accessToken accessToken is null"}`。
- ⚠ **只接受 POST**：GET / `Authorization` 头都是 405。
- 卡片显示取 `maskedMobile`（去掉 `+86 `）→ `email` / `desensitizedEmail` → `userId` → 空串。

### 12.3 邀请（官方客户端「邀请中心」）

官方分享链接的形状（实测，来自账号自己的分享）：

```
https://www.accio-ai.com/login?sId=hKVFtOhL8IqKglYysM8tGA%3D%3D&ic=IC624891464548
  &tenant=accio&src=p_referral_IC624891464548&source=invite_center
```

- `ic` = 邀请码；`src=p_referral_<邀请码>`、`source=invite_center` 是来源标记。
- 登录页把它记在会话里，**新账号注册完成即建立邀请关系** —— 所以必须在登录 URL 上带，事后补不了（补的是另一个接口，见下）。

客户端 asar 的 API 表（`km` 对象，逐字）：

```js
{ refreshToken:"/api/auth/refresh_token", accountSwitchSafeRefreshToken:"/api/auth/safe/refresh_token",
  logout:"/api/auth/logout", userInfo:"/api/auth/userinfo", entitlementQuota:"/api/entitlement/quota",
  invitationQuery:"/api/invitation/query", invitationCommit:"/api/invitation/commit",
  diamondConfig:"/api/entitlement/config", authFeeLink:"/api/entitlement/authFeeLink",
  showTips:"/api/entitlement/showTips", mobileBindGetStatus:"/api/mobileBind/getStatus",
  mobileBindSendCode:"/api/mobileBind/sendCode", mobileBindBind:"/api/mobileBind/bindForLogin",
  tokenExchange:"/api/oauth/token" }
```

| 接口 | 方法 | body | 响应 |
|---|---|---|---|
| `/api/invitation/query` | POST | `{accessToken}` | `{"success":true,"code":"200","data":true}`（布尔：本账号是否已有邀请关系） |
| `/api/invitation/commit` | POST | `{accessToken, code:"IC…"}` | `{"success":true,"code":"200","data":{...}}` |

⚠ `commit` 的字段名是 **`code`** —— asar 调用点：`Oh(km.invitationCommit, { code: n })`。
客户端本地 HTTP 服务的入参叫 `invitationCode`，那是另一层，别混。

### 12.4 内置登录（进行中）

已打通：

- `msedge.exe --headless=new --remote-debugging-port` + CDP 能打开 `www.accio-ai.com/login`，标题 `Login to Accio`。
- 登录页的两个真实接口（浏览器里抓到）：
  - `POST https://login.accio-ai.com/saml/route/check` `{email, returnUrl, deviceId, agreementIds, sourceType}`
  - `POST https://login.accio-ai.com/integrated/captcha/token` `{email, deviceId, identifierType}`
- 触发风控时弹的是**阿里 NC 滑块**（`#nc_1_n1z` 42×30，轨道 `#nc_1_n1t`），在 `baxia-dialog-content` iframe 里，
  frame 内坐标要加 iframe 偏移（实测 iframe 420×320 位于 (36,249)，handle 中心 (119,466)）。
- 轨迹必须拟人：`linhuai777/accio2api` 的 `_human_drag` = 起手停 0.3s → 按下停 0.35s → 40 步 × 18ms 匀速（y ±0.5px 抖动）→ 停 0.38s → 松手；贝塞尔版实测被拒。

尚未打通：登录页的「先填邮箱 → 点登录 → 出现发送验证码」这一段在 CDP 里还没跑通（原生 click 与 `Input.insertText` 都没让 React 表单进入下一步）。
下一步方向：用 `Input.dispatchKeyEvent` 逐字键入 + 真实鼠标点击，或改用 `Page.addScriptToEvaluateOnNewDocument` 注入 React 兼容的输入。


### 12.5 从本机客户端导入（免登录，0.1.3）

官方 Windows 客户端（Electron 41，`E:\Accio`）把当前账号写在
`%APPDATA%\Accio\credentials.enc`，格式与 Chromium 的 OSCrypt 一致：

```
Local State: os_crypt.encrypted_key = base64("DPAPI" + DPAPI(32-byte AES key))
credentials.enc: "v10" + nonce(12) + ciphertext + tag(16)    ← AES-256-GCM
```

解密后的结构（实测本机）：

```json
{
  "accessToken": "…32 字符…",
  "refreshToken": "…128 字符…",
  "expiresAt": 1795839590000,
  "sgcookie": "…112 字符…",
  "user": {
    "id": "1798171953", "name": "Accio User", "accioId": "4500118477724",
    "mobileBound": true, "needBindMobile": false, "userLevel": "freeMember",
    "routeRegion": "CN", "maskedMobile": "+86 189****8051", "activeTeam": null
  },
  "revision": 1
}
```

- 字段名与插件的凭据完全对应（`accessToken→access_token`、`expiresAt` 已是毫秒）。
- 用这份 token 调 `/api/auth/userinfo` 能取到同一个账号（`userId 1798171953`）——
  证明**客户端与网站 OAuth 是同一套 token**。
- DPAPI 借 PowerShell 的 `ProtectedData.Unprotect` 解 32 字节 key（约 0.3 秒，仅 Windows）。
- 限制：只在 Windows 生效；客户端未安装 / 未登录 → 方法明确失败并提示走网页登录。
- ⚠ 解出的 token 只交给 magpie 的账号槽，**不写插件缓存**。

实测：`importDesktopLogin()` → `{tokenLen:32, refreshLen:128, expires:1795839590000, user:"+86 189****8051"}`；
方法 callback → `{type:"success", accountId:"189****8051", expires:1795839590000}`。


### 12.6 邀请码的插件形态（对齐 magicrew，0.1.4）

与 `magpie-magicrew-auth/src/hooks/methods.mjs` 的「邀请码」逐条对齐：

| 维度 | 超级麦吉 | 本插件（Accio） |
|---|---|---|
| 入口 | 独立登录方式 `${SHORT} 邀请码` | `Accio 邀请码` |
| 输入 | 一个 text 框，placeholder 每次点开现算 | 同款（`inviteHint()`） |
| 语义 | 0/空=自动、1=首选、其它=码 | 0/空=沿用策略、1=保持当前、其它=新码 |
| 多步 | `ask()`：邀请码 → 主验证码 | `ask()`：邀请码 → 登录站点 |
| 保存后 | 直接接 `primaryMethod.authorize()` | 直接接 `beginLogin({inviteCode})` |
| 策略文件 | `magicrew-invite-policy-<site>.json` | `~/.cache/magpie/accio-invite.json`（`{code, source, at}`） |
| 标题后缀 | `（上级 <accountId>）` | `（邀请码 IC…）` |
| 码的来源 | `rollInvite()` 登录后从服务端拿**自己的**码 | **没有查自己码的接口**（`/api/invitation/query` 只返回布尔）⇒ 用「上一次成功使用的码」 |

⚠ **唯一的业务差异**：magicrew 能 `rollInvite` 拿到每个账号自己的邀请码，Accio 没有对应接口
（客户端「邀请中心」只给分享链接，链接里的 `ic` 是上级的码）。所以这里的「自动」是
「沿用上次成功用过的码」，首次需要用户填一次 —— 这是接口能力差异，不是实现偷懒。
