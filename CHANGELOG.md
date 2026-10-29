# 更新记录

一条一行，说用户能感知的变化。发版流程见 magpie-plugin-scaffold 的 `UPDATING.md`（七步，`git push` 只是第 4 步）。

## 0.1.3 — 2026-10-29

- **从本机 Accio 客户端导入（免登录）** —— 装了官方 Windows 客户端并登录过的话，点这一项就够了：
  插件从 `%APPDATA%\Accio\credentials.enc` 解出 `accessToken / refreshToken / expiresAt / sgcookie`，
  连账号卡片上的手机号一起带过来。不跳浏览器、不过滑块。
  （Chromium OSCrypt v10 + DPAPI，详见 `src/desktop.mjs` 与 internals §12.5。）

## 0.1.2 — 2026-10-29

- **卡片上显示手机号 / 邮箱** —— 登录后用官方 `/api/auth/userinfo` 取 `maskedMobile`（邮箱账号是邮箱），
  不再是一张只有「Signed in」的卡。
- **邀请码** —— 登录流程多一个可选输入框：新账号注册时按官方分享链接的 `?ic=…&tenant=accio&src=p_referral_…&source=invite_center`
  建立邀请关系；另有「Accio 邀请码」登录方式，给已登录账号补绑（`/api/invitation/commit`，参数名 `code`）。
- **邀请状态查询** —— `/api/invitation/query` 返回本账号是否已绑定邀请关系。

> 接口形状来自官方 Windows 客户端 `app.asar` 里的 API 表（`userInfo` / `invitationQuery` / `invitationCommit`），
> 并用真实 token 在 `phoenix-gw.alibaba.com` 上验过。

## 0.1.1 — 2026-10-29

从 Gyl1219/magpie-providers-hub 的实测记录里吸收的五处改进（来源见 NOTICE）：

- **长对话不再被 30 秒硬超时掐断** —— `chat` 只透传 magpie 的 signal，插件自己不再挂超时。
- **连接抖动自动重试 2 次** —— 只重试传输层错误（ECONNRESET / ENOTFOUND / fetch failed），4xx/5xx 不重试（401 该续期、402 该充值、429 该冷却）。
- **临期自动软续期** —— 发请求前发现凭据临期就先续一次；续期失败沿用原凭据，真失效仍由 401 硬续期兜底。
- **额度卡片文字更全** —— 每条窗口带「已用 50 / 300 · 12:00 刷新」，不再只靠可能被丢的结构化字段。
- **过期时间支持日期字符串** —— ISO / `2026-10-28 03:37:02` 都能解析；旧实现 `Number()` 会得到 NaN。


## 0.1.0 — 2026-10-29

首个版本。

- **Accio（阿里 Accio Work）接进 magpie** —— 浏览器里用阿里账号登录，订阅里已有的 Qwen / GLM / DeepSeek / MiniMax / Kimi 等模型变成 magpie 里的一排 `accio/<model>`，任何支持 OpenAI 协议的 agent 都能用。
- **两个登录入口，一个供应商** —— 中国站（accio-ai.com）与国际站（zh.accio.com）只在登录页域名上不同，换码 / 目录 / 对话 / 额度都走同一个网关。
- **模型带计费倍率** —— 每条模型显示 `x0.03` 这样的倍率胶囊（兜底表里跨度 0.013 ~ 2.8，约 215 倍），选型不用去翻客户端。
- **积分桶读真实账号** —— 每日 / 每月 / 推荐三类积分各一条进度条，用完的桶显示「已用 100%」而不是标成附加额度（标成 aside 会让这个号在智能路由里消失）。
- **续期串行** —— Accio 刷新会轮换 `refresh_token`，并发的第二次续期会把账号标死；插件按凭据身份键控去重。
- **工具调用分片合并** —— 上游按帧补参数，合并成一次调用再交给 agent（重放会重复执行工具）。
- **风控页识别** —— 上游缺 `utdid` 时回 HTTP 200 + HTML 拦截页；插件按 content-type 判出来并把服务端原文带给用户，而不是报「模型不回复」。
- 无每日签到（Accio 的积分按套餐周期自动刷新），签到钩子返回 `inactive`。