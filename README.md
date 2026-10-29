# Accio for magpie

**Accio 订阅里已有的 Qwen、GLM、DeepSeek、MiniMax、Kimi，变成 magpie 里的一排模型 —— 不用装桌面客户端，浏览器里用阿里账号登录即可。**

Accio（阿里 Accio Work）是一个把多家模型打包进订阅的客户端；这个插件把那部分订阅接进
magpie：任何支持 OpenAI 协议的 agent 都能选它的模型。
非官方插件，与阿里巴巴集团、Alibaba.com、Accio 官方没有任何隶属或背书关系。

```
模型       15 条兜底；登录后跟随平台目录
倍率       x0.013 ~ x2.8（同一订阅内跨度约 215 倍）
上下文     最高 1,000,000；最低 200,000
积分桶     每日 / 每月 / 推荐，三桶各一条进度条
登录       浏览器里扫码/账号登录，不装客户端
```

> **改代码 / 发版本之前**：先看 [AGENTS.md](./AGENTS.md) —— 按「你在哪一步」给阅读顺序，
> 外加本仓库会静默出错的坑（症状 → 判据 → 出处）。交付与发版逐条走
> [CHECKLIST.md](./CHECKLIST.md) 的两张表；协议取证在 [docs/internals.md](./docs/internals.md)。

---

## 功能

- **一个供应商，两个登录入口** —— 中国站与国际站只在登录页不同；换码、目录、对话、额度同一个网关，所以不会出现两张各登一次的卡。
- **倍率标在模型上** —— 每条模型带 `x0.03` 这样的倍率胶囊，与计费同源；最便宜的档和最贵的档差约 215 倍。
- **积分算得准** —— 三桶积分各一条进度条；用完的桶显示 100%，不会被当成「还有额度」排到路由队首。
- **续期不打死账号** —— Accio 刷新会轮换 refresh_token，插件按凭据身份串行，不会出现「并发续期 → invalid_grant → 账号失效」。
- **工具能真正用起来** —— 上游的工具调用是分片到达的，插件合并成一次调用再交给 agent；并发多条工具结果时保持配对相邻。
- **风控页能识别** —— 上游偶尔回 HTTP 200 + 一张拦截页；插件按 content-type 判出来并带上服务端原文，而不是让 agent 看到「模型不回复」。
- **图片输入跟随厂商声明** —— 每个模型显式声明能否收图：能收的直接发内联图，不能收的不会被 magpie 误判成能收。
- **思考内容不污染正文** —— 上游用 `thought` 标记的片段映射到 `reasoning_content`。

---

## 模型

**Qwen / GLM / DeepSeek / MiniMax / Kimi** —— 各家最新的一版都在；登录后跟随平台目录上下架，
所以这里只列托底的几条（未登录时你也看得见它们）。

| 发行商 | 代表模型 | 上下文 | 收图 | 倍率 |
|---|---|---|---|---|
| Qwen | `qwen-3-8-flash` | 1M | ✓ | x0.03 |
| Qwen | `qwen-3-8-max` | 1M | ✓ | x0.44 |
| GLM | `glm-5-3-flash` | 1M | ✓ | x0.03 |
| GLM | `glm-5-3` | 1M | ✗ | x0.16 |
| DeepSeek | `deepseek-v4-1-flash` | 1M | ✓ | x0.045 |
| DeepSeek | `deepseek-v4-pro` | 1M | ✗ | x0.17 |
| MiniMax | `minimax-m3` | 1M | ✓ | x0.08 |
| Kimi | `kimi-k2-6` | 256K | ✓ | x0.14 |

另有三档按能力的通用模型（`standard` / `professional` / `ultimate`，倍率 0.13 / 1 / 2.8）。

思考档位按厂商目录展示（上游不接受显式 effort，档位只是展示）。
全量模型以 `magpie plugin list` 或应用内的模型选择器为准 —— 平台目录随时上下架。

---

## 签到

**没有每日签到。** Accio 的积分按套餐周期自动刷新（每日桶的刷新时刻从上游读），
所以签到钩子返回 `inactive`，magpie 不会给你挂一个永远失败的签到。

---

## 安装

在 magpie 的 **插件 → 发现** 搜 `Accio`，点**安装**。

> 卡片标题来自包内的 `name`（`Accio`），npm 上的包名是 `accio-auth` —— 这两个不一样是故意的，
> 发布脚本在发布时换名，装的人什么都不用做。

### 命令行

```bash
# 从 npm（推荐）
magpie plugin add accio-auth

# 从仓库源码（拿最新代码，不走 npm）
magpie plugin add github:MYCF711/magpie-accio-auth

# 本地目录（改代码时）
magpie plugin add /path/to/magpie-accio-auth
```

装完确认：

```bash
magpie plugin list
# Accio  on
#   accio (Accio, 15 models)  signed in as …
```

### 登录

在 magpie 的供应商卡片上点 **登录 Accio**，先选站点（中国站 / 国际站），
然后在弹出的页面里完成阿里账号登录 —— 回调走本机 `127.0.0.1`，不需要装 Accio 桌面客户端。

---

## 常见问题

**要装 Accio 的桌面客户端吗？** 不用。登录是标准的 OAuth + 本机回环回调，只在你自己的浏览器里完成。

**中国站和国际站是两张卡吗？** 不是。两站的区别只在登录页域名；换码、模型目录、对话、额度都走同一个网关，所以是一个供应商、两组登录态可以并存（同站两个账号也支持）。

**为什么卡片上不显示账号名？** Accio 的登录响应只给两个 token 和一个过期时间，不给账号名、邮箱或用户 id。插件不编造显示名，所以卡片显示「Accio」；多账号靠内部的 `uid` 区分。

**重复登录同一个账号会怎样？** 会多一张卡，而不是覆盖。原因同上：拿不到稳定的账号 id。删掉旧的那张即可（不会把可用凭据弄丢）。

**积分显示 0 就是没额度了吗？** 是。插件读的是账号真实的积分桶；用完的桶显示 100%，不会伪装成「还有余量」而把这个号排到路由队首。

**会不会因为共用登录态被风控？** 插件按官方客户端的请求形状发（`utdid` 装机 id、`appKey`、版本头），并把「HTTP 200 + HTML 拦截页」这种风控形态识别成明确错误。但任何非官方调用都有风险 —— 用它就意味着接受这一点。

---

## 参考源

| 来源 | 用在哪 |
|---|---|
| [Gyl1219/magpie-providers-hub](https://github.com/Gyl1219/magpie-providers-hub)（MIT） | Accio 渠道的协议实现与回归断言；本仓库把它拆成一个独立供应商插件 |
| [JetLi/dsh-providers-hub](https://github.com/iJetLi/dsh-providers-hub)（MIT） | 渠道对象的接口形状（经上一条间接） |
| [MYCF711/magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold)（MIT） | 九项钩子骨架、额度窗口构造器、合规检查器 |
| [yetone/magpie](https://github.com/yetone/magpie)（MIT） | 钩子契约 |

完整版权声明见 [NOTICE.md](./NOTICE.md)。

---

> 更新记录：[`CHANGELOG.md`](./CHANGELOG.md)

## 许可

MIT。