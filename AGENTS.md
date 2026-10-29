# AGENTS.md —— 给 AI 执行者的入口

> 人类请读 [README](./README.md)。这份只回答两件事：
> **你现在该读哪一份**，以及**忘了哪一条会静默出错**。
>
> 结构照搬 [magpie-plugin-scaffold](../magpie-plugin-scaffold/AGENTS.md)；
> 第二节是本仓库自己的坑，论证在 [docs/internals.md](./docs/internals.md)。

---

## 零、magpie 升级时：只看稳定版

**判断「要不要跟着 magpie 改这个插件」看稳定渠道，不看每版本渠道。**

```bash
curl -s "https://usemagpie.ai/api/latest?channel=stable" | grep -o '"version":"[^"]*"'
node ../magpie-plugin-scaffold/scripts/check-magpie-stable.mjs
```

稳定版变了才需要重提取契约（脚手架的 `extract-contract.py`）→ `contract-diff.mjs`。
2026-10-28 实测：每版本 0.1.1763 / 稳定版 0.1.1327，但插件相关字段**一条不差** ——
追每版本几乎全是白跑。

---

## 一、先定位你在哪一步

| 你在做什么 | 必读（按顺序） | 做完的判据 |
|---|---|---|
| **改登录 / 续期** | [docs/internals.md](./docs/internals.md) 的 §2 §3 | `node --test` 全过；state 校验与轮换串行两条测试仍绿 |
| **改对话协议（信封 / SSE）** | internals §4 + [脚手架 HOOKS.md](../magpie-plugin-scaffold/HOOKS.md) 第六、七节 | 风控页 / 402 / 工具分片 / 空流 四条测试仍绿 |
| **改模型目录 / id 映射** | internals §5 | slug ↔ modelCode 与撞名 slug 两条测试仍绿 |
| **改额度窗口** | internals §6 | 窗口由 `src/quota.mjs` 构造（写错会抛） |
| **改传输 / 续期重试** | internals §11 | `tests/borrowed.test.mjs` 全过 |
| **代码写完，准备交付** | [CHECKLIST.md](./CHECKLIST.md) 的 **A 表** | A 表全勾 + `node scripts/check.mjs` 退出 0 |
| **要发版本** | 脚手架的 `UPDATING.md`（七步） | CHECKLIST 的 **B 表**全勾 + 五条验证 |

**最容易漏的是最后一行。** `git push` 只是七步里的第 4 步。

---

## 二、本仓库的坑

| # | 症状（出问题时你看到什么） | 判据 | 出处 |
|---|---|---|---|
| 1 | 插件「登录成功」但每请求都 401 / 流内 402 | token 在 **body 的 `token`**，不在 `Authorization` 头 —— 放头恒流内 402，且 HTTP 仍 200 | internals §4 |
| 2 | 模型选得到、发出去「模型不回复」 | 上行必须发 `modelCode`；slug 只是对外 id。查不到原样发入参，不编造 | internals §5 |
| 3 | 登录页弹「请升级客户端」 | 授权 URL 五个参数缺一不可，少 `code_challenge` 就被判 legacy | internals §2 |
| 4 | 账号「莫名失效」，多账号同时刷新更常见 | Accio 刷新**轮换** refresh_token；必须串行，键用凭据身份 | internals §3 |
| 5 | 续期后账号立刻被判过期（1970 年） | `expiresAt` 是**秒**，必须 ×1000 再存 | internals §2 |
| 6 | 每请求都被判「已过期」而疯狂续期 | 同 #5 的下游症状；`accioExpiresAtMs` 是唯一入口 | src/credential.mjs |
| 7 | 模型「思考一下就中断」/ 工具不执行 | 工具调用是分片到达的，必须按 id 缓冲合并；顶层 `function_call` 帧不能丢 | internals §4 |
| 8 | 工具结果里带图后，整轮工具调用失效 | `functionResponse` 必须紧密相邻；图片统一排到批末 | internals §4 |
| 9 | 卡片「剩余额度未知」而 `usage()` 明明有 windows | 窗口写错：`aside` 给了 amount/limit、`resetsAt` 不是 ISO、`used` 缺省 | internals §6 |
| 10 | 这个号在路由页「剩余额度未知」且总排最后 | 窗口全标了 `aside` ⇒ 路由层整条跳过。用完的桶给 `used:100`，别 aside | internals §6 |
| 11 | 卡片上的模型收不了图，却被当能收图 | `capabilities.input.image` 必须写**布尔值**；省略 = 厂商未表态 | internals §5 |
| 12 | 症状像「模型不回复」，真因是风控 | 缺 `utdid` 时网关回 `HTTP 200 + text/html` 拦截页；必须按 content-type 判 | internals §4 |
| 13 | 重复登录同一账号，多出一张卡 | Accio 不给账号名/用户 id；`uid` 是 JWT sub 或 refresh_token 哈希，重登会变 | internals §7 |
| 14 | 改了代码重装，行为没变 | 同版本号重打包会命中 bun 缓存 —— 必须 bump `version` | 脚手架 UPDATING 第 1 步 |
| 15 | `magpie plugin add xxx.tgz` 报 `exports no OpenCode plugin function` | 这个命令把 tgz 当 JS 模块 `import()`；本地包走 `plugins.json` + `plugins/package.json` 登记 | 脚手架 README 常见坑 1 |
| 16 | 想让卡片标题/许可对，去改了 magpie 的缓存 | 插件对 magpie 目录**只有读的份**；载体是 `registry-entry.json` | internals §8 |
| 17 | GitHub 把 license 标成 `NOASSERTION` | `LICENSE` 必须是**逐字 MIT 正文**，归属说明在 `NOTICE.md` | 脚手架 README 顶部四件 |
| 18 | 长对话跑一半被掐断 / 长思考模型总是超时 | **不要在 `chat` 里挂硬超时** —— magpie 的 `signal` 管取消；30s / 120s 都会掐断长对话 | internals §11 |
| 19 | 凭据明明过期却一直拿死 token 打上游 | 过期时间是日期字符串时不能 `Number()`（NaN 会判「永不过期」）；统一走 `accioExpiresAtMs` | internals §11 |
| 20 | 本地目录装的插件，改了代码但 magpie 里行为还是旧的 | 本地路径 spec **不会远程更新**，也不看 git；要 `magpie plugin off <spec>` + `on <spec>` 重载，或重启 magpie | internals §11 |
| 21 | 账号卡片只有「Signed in」，看不出是哪个号 | 官方 `POST /api/auth/userinfo` body 必须是 `{"accessToken":…}`（放 `token` 回 400；GET/Authorization 回 405）；`maskedMobile` 就是卡片名 | internals §12.2 |
| 22 | 邀请码填了但上级没拿到奖励 | 新号的邀请关系只能在**登录 URL** 上带 `?ic=…&tenant=accio&src=p_referral_…&source=invite_center`；`/api/invitation/commit` 的字段名是 `code`，不是 `invitationCode` | internals §12.3 |

---

## 三、命令

```bash
# 合规检查 —— 退出码非 0 就是不合规，别靠眼睛看
node scripts/check.mjs
node scripts/check.mjs ../my-plugin

# 语义测试 —— check 查「形状」，它查「语义」（协议回归 + 钩子三态 + 传输重试）
node --test

# 打包面预演：README / CHANGELOG / docs 在不在包里
npm pack --dry-run

# 维护检查（发布前必跑）：改了代码有没有 bump、bump 了有没有 tag
node scripts/check-maintenance.mjs

# 发布（包内 name 是「Accio」，npm 包名是 accio-auth）
npm run publish:npm
```

真实端点探测（不需要凭据）：

```bash
curl -s -X POST https://phoenix-gw.alibaba.com/api/llm/config/v2 \
  -H 'Content-Type: application/json' -d '{"token":""}'      # → code 403 auth failed
curl -s "https://phoenix-gw.alibaba.com/api/entitlement/currentSubscription?accessToken=fake"  # → code 401 NOT_LOGIN
```

本机装/重载：

```bash
magpie plugin add 'D:\主工作区\projects\magpie-accio-auth'   # 首次
magpie plugin off 'D:\主工作区\projects\magpie-accio-auth'    # 改完代码后重载
magpie plugin on  'D:\主工作区\projects\magpie-accio-auth'
magpie plugin list | grep -A2 accio
```

---

## 四、两个交付门

**门 1 · 代码交付**

```
□ node scripts/check.mjs 退出码 = 0
□ node --test 全过（协议回归 + 钩子语义 + 传输/续期）
□ CHECKLIST.md 的 A 表全勾
```

**门 2 · 发布**

```
□ CHECKLIST.md 的 B 表全勾（七步）
□ 五条验证：npm 版本 / tarball 内容 / 本机 magpie 认得 / Release 在 / check-maintenance 过
```

⚠ **没过门 2 不许说「已发布」。**

---

## 五、代码结构

```
index.mjs           九项钩子的装配（config / auth 五钩 / provider.models / chat.headers）
src/constants.mjs   端点、常量、占位 baseURL
src/credential.mjs  凭据读写、秒→毫秒（含日期字符串）、uid 判定
src/login.mjs       PKCE + loopback 回调、续期、并发去重闸
src/api.mjs         模型目录、额度（信封判据只在这里定义一次）
src/models.mjs      slug ↔ modelCode、模型条目字段、兜底表
src/chat.mjs        OpenAI ⇄ Accio 双向转换（信封 + SSE）
src/transport.mjs   传输级重试（只重试连接类错误）
src/store.mjs       utdid、每账号目录快照（只写 ~/.cache/magpie）
src/quota.mjs       额度窗口构造器（写错直接抛）
```

---

## 六、文档地图

| 文件 | 管什么 | 什么时候读 |
|---|---|---|
| [README](./README.md) | 用户门面：能拿到什么、模型、安装、常见问题 | 改用户可见行为时 |
| [docs/internals.md](./docs/internals.md) | 端点实测、登录、续期、对话协议、额度、身份、**借鉴清单** | **改代码前按章查** |
| [CHANGELOG.md](./CHANGELOG.md) | 每版一节 | 写新版本时 |
| [CHECKLIST.md](./CHECKLIST.md) | 两张勾选表 | 两个交付门 |
| [NOTICE.md](./NOTICE.md) | 版权与来源 | 改参考源时 |
| 脚手架 [AGENTS.md](../magpie-plugin-scaffold/AGENTS.md) | 通用坑与 check 能查什么 | 第一次接触这个插件族时 |

---

## 七、这份文件的维护规矩

1. 任何一次「不报错、要几小时才找到」的坑，收工前在第二节加一行（症状 → 判据 → 出处）。
2. 第二节只放一句话判据，论证留在 `docs/internals.md`。
3. 判据要能当场验证（命令、字段、测试名）。
