# NOTICE

本仓库是 **Accio（阿里 Accio Work）的第三方 magpie 插件**，与阿里巴巴集团、Alibaba.com、
Accio 官方**没有任何隶属、合作或背书关系**。它不提供账号、订阅或模型额度 ——
用的是使用者自己的 Accio 订阅。

---

## 代码与协议结论的来源

| 来源 | 许可 | 用在了哪 |
|---|---|---|
| [Gyl1219/magpie-providers-hub](https://github.com/Gyl1219/magpie-providers-hub) 的 `src/accio.mjs` 与 `tests/accio.test.mjs` | MIT | Accio 渠道的协议实现与回归断言：Gemini 风格信封、SSE 帧解析、工具分片合并、额度三桶、`slug ↔ modelCode` 映射、`utdid` 风控判据。本仓库把它拆成一个独立供应商插件（去掉聚合层的 sidecar / 自注册 / 通知 / sweep 定时器），并按其注释记录的 DSH 真机实测结论实现 |
| [JetLi/dsh-providers-hub](https://github.com/iJetLi/dsh-providers-hub)（经上一条间接） | MIT | 渠道对象的接口形状（`beginLogin` / `refresh` / `catalog` / `chat` / `usage`） |
| [magpie-plugin-scaffold](https://github.com/MYCF711/magpie-plugin-scaffold) | MIT | 九项钩子的骨架、`src/quota.mjs` 窗口构造器、`scripts/check.mjs` 合规检查器、`AGENTS.md` / `CHECKLIST.md` 的结构 |
| [yetone/magpie](https://github.com/yetone/magpie) | MIT | 钩子契约（由脚手架的 `extract-contract.py` 从二进制提取） |

本仓库自己的新增部分：

- 单供应商（`accio`）的九项钩子装配，两个登录站点作为登录参数而不是两张卡；
- `src/credential.mjs` 的身份判定（JWT `sub` → `refresh_token` 哈希）与凭据读写；
- `src/models.mjs` 的撞名 slug 处理、`rate` 字段（倍率不再拼进模型名）、
  `capabilities.input.image` 的显式布尔；
- `src/api.mjs` 的额度窗口（剩 0 的桶给 `used:100` 而不是 `aside`，避免该号在路由里消失）；
- 本仓库 2026-10-29 对四个真实端点的独立探测（见 `docs/internals.md`）。

---

## 图标

`index.mjs` / `package.json` 里的图标是本仓库自绘的 SVG（深底 + 橙色 A 形），
不引用厂商的任何素材。

## 许可

MIT，见 [LICENSE](./LICENSE)。