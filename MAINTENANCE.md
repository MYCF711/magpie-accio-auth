# MAINTENANCE.md —— 维护台账（给接手的 agent 看）

> 用途：任何人（Lead 或专员）接手这个仓库前先读这一页，30 秒内知道「现在在哪一步、下一步是什么、哪里会踩坑」。
> 读完再去读 `AGENTS.md`（入口与坑表）和 `CHANGELOG.md`（历史）。
> **每次干完活必须回来更新本文件的「当前状态」与「下一步」。**

---

## 一、身份

| 项 | 值 |
|---|---|
| 仓库 | `magpie-accio-auth`（目录名；`workspace.json` 的 id = `magpie-accio-auth`） |
| 包内 name | `Accio`（`package.json` 的 `name`） |
| npm 包名 | `accio-auth`（与包内 name 不同，发布用这个） |
| 当前版本 | `0.1.9`（工作区里已 bump，未提交、未打 tag） |
| 承载的供应商 | `accio`（阿里 Accio Work） |
| 上游 | magpie（`yetone/magpie`）插件协议；本机源码 checkout `<WORKSPACE>\projects\magpie` |
| 关联仓库 | `magpie-plugin-scaffold`（脚手架 / HOOKS.md / UPDATING.md / check.mjs） |
| 参考实现 | `magpie-magicrew-auth`（浏览器登录 / 登录方式形态）、`magpie-trustoken-auth`（状态码语义翻译）、`iJetLi/dsh-providers-hub`（续期按 refresh 链协调，0.1.9 起） |

## 二、当前状态（2026-10-30 19:xx 盘点）

```
分支        feat/software-first-login（从 main 1c4389f 起；0.1.8 已发布、tag v0.1.8）
相对 main   未提交（Lead 统一提交；不许推 main、不许 push、不许提 PR）
改动        见 `git status` / `git diff --stat`
本次做了    ① 软件优先登录：主入口按「本机客户端登录态」分流（有→导入 / 无→下载页+轮询≤10min）
            ② 方法表下标保持 0/1/2；旧「客户端导入」槽改为「网页授权」
            ③ 续期判终态前回读 refresh 链（latestCredentialFor）+ 认不准不标死
            ④ refreshOnce 键 = client_id + refresh_token（不带 region）
            ⑤ in-path「续期成功但写回失败」= 终态（persistRequired，仅 chat/loader 路径）
            ⑥ toStored 承接 prev.accountId / uid（修 uid 每轮漂、卡片手机号被抹）
            ⑦ 0.1.9 版号 + CHANGELOG + AGENTS 坑表 27-30 + internals §14 + 本文件
```

最近 5 个提交（main）：

```
1c4389f chore: 同步脚手架 0.1.34 的六份文档，清掉临时脚本
9c2594f feat(0.1.8): 退登判定收窄 + 干净 profile 的浏览器登录
c45d9ee fix: carry sId with the invitation code, matching the official share link
824074f fix: show remaining credits (invite credits were reading as zero); drop the built-in login
36be902 docs: spell out the built-in login and the three headless pitfalls
```

## 三、下一步

1. 复核本分支的改动（`git diff`）→ 跑两道门（见第五节）→ Lead 决定合入与发版（0.1.9）。
2. **发版前必须确认**：本机 magpie 里装的是本地目录 spec（`<WORKSPACE>\projects\magpie-accio-auth`），
   改完要 `magpie plugin off <spec>` + `on <spec>` 或重启 magpie 才生效（坑 20）。
3. 未决（等上游/等证据，别猜）：
   - 0.1.8 之前的三个 accio 账号当前仍被上游拒绝（`401 NOT_LOGIN` / `403 auth failed`，与垃圾 token 同形）。
     本机出口同时在被 sentinel 限流（`555 blocked by sentinel rate limit`）⇒ **成因未能证实**。
     要证实需要第二个出口 IP 做对照。**若用户重新登录后立刻又被标失效，优先查这条。**
   - 0.1.9 的「软件优先」在本机可验（`hasDesktopLogin() === true`），但「装客户端→轮询」全流程
     只能靠假时钟单测，未在真机走一遍安装流程。

## 四、硬约束（违反会静默出错）

- **禁止直接推 `main`**：功能分支 → PR → 必需检查全绿 → 合并 → 从与 `origin/main` 完全一致的提交打 tag / 发 npm。
- **不许动 `~/.config/magpie`**：插件对那里**只有读的份**（`src/store.mjs` 规矩①）。本仓库只写 `~/.cache/magpie`，且那里的东西全可删。
- **`signIn: "expired"` 是「标死账号」的开关**：只有上游**明说**登录没了才允许（走 `src/api.mjs` 的 `isSignInGone()`），
  且 `usage` / `models` 要**连续两次、间隔 ≥60 s** 才落笔。风控/限流/超时/5xx/坏 JSON/未知码一律不许。
  （magpie 侧判据：`internal/provider/plugin_usage.go` 的 `case u.SignIn == "expired"`。）
- **登录必须自己开干净窗口**：`authorize()` 回 `{url, method:"auto"}` 而不 `opened: true` ⇒ magpie 用系统浏览器打开 ⇒ 添加账号落到旧号上（坑 24）。找不到浏览器时**明确报错**，不许静默退回系统浏览器。
- **方法表下标不许删**：magpie 用 `auth.methods[method]` 下标选方法；改登录方式只能改 label/行为，不能删槽或改长度（坑 30）。
- **软件优先只在 `authorize()` 里读客户端**：不许在插件加载/面板挂载时读 `credentials.enc`（#522：用户删掉的号会自己回来）。导入前必须 `userinfo` 验证。
- **一次性 profile 目录不许复用**：复用会让第二次登录读到上一次留下的会话（magicrew 踩过）。
- **refresh_token 只有一个出口**：`refreshOnce()`（键 = `client_id + refresh_token` 链，**不带 region**）。并发续期会「1 成功、其余 invalid_grant」⇒ 把好账号标死。
- **判终态前先回读自己的链**：`latestCredentialFor()`；`refresh` 已变 ⇒ 用最新的、不标死；读不到 ⇒ 维持终态；认不准 ⇒ 不标死、下轮再试；**别把别的账号的槽当自己的**（坑 29）。
- **in-path 续期写回失败 = 终态**（`persistRequired` 只在 loader/chat 路径开；`auth.refresh` 钩子由宿主落盘，不要开）。
- **`expires_at` 一律走 `accioExpiresAtMs()`**（秒→毫秒，含日期字符串）：漏了会判「1970 已过期」而疯狂续期。
- **不要在 `chat` 里挂硬超时**：magpie 的 `signal` 管取消，30s/120s 会掐断长对话。
- 其余坑见 `AGENTS.md` 第二节的 30 条表（每条带「判据」与出处）。

## 五、交付前自检

```bash
cd "<WORKSPACE>/projects/magpie-accio-auth"
node --test tests/*.test.mjs                       # 全过（当前 129 条）
node "<WORKSPACE>/projects/magpie-plugin-scaffold/scripts/check.mjs" .   # 退出码 0
npm pack --dry-run                                 # 打包面里文档齐全
node scripts/check-maintenance.mjs                 # 发布前：改了代码有没有 bump / tag
```

再对 `CHECKLIST.md` 的 **A 表**逐条勾。要发版走 `CHECKLIST.md` **B 表** + 脚手架 `UPDATING.md` 七步。

查「上游到底认不认这个 token」（只读，不改任何状态）：用**本仓库的**模块打真端点，
不要手搓 curl —— 判据（`isSignInGone`）就在 `src/api.mjs` 里，手搓容易跟代码走偏：

```bash
node -e "const {fetchUsage}=await import('file:///<WORKSPACE>/projects/magpie-accio-auth/src/api.mjs'); \
const fs=require('fs');const j=JSON.parse(fs.readFileSync(process.env.USERPROFILE+'/.config/magpie/plugin-auth.json','utf8')); \
const {credentialOf}=await import('file:///<WORKSPACE>/projects/magpie-accio-auth/src/credential.mjs'); \
console.log(await fetchUsage(credentialOf(j['accio'])).then(()=>'还有效').catch(e=>e.name+': '+e.message))" --input-type=module
```

⚠ **不要**拿 `refresh_token` 去试 `/api/auth/refresh_token`：它会**轮换** refresh_token，
一次试探就把用户手里的凭据作废（坑 4）。

## 六、给接手者的最短路径

1. 读本文件（你在读）
2. `git status` + `git log --oneline -5` + `git branch --show-current` 核实现状（别信台账里的旧快照）
3. 读 `AGENTS.md` 的「一、先定位你在哪一步」表，按你要做的事找必读（改登录 → internals §2 §3 §13）
4. 干活 → `node --test` + `scripts/check.mjs` → 更新本文件「当前状态」与「下一步」→ 回报 Lead
