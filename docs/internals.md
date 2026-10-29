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