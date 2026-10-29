# CHECKLIST —— 两张表，两个交付门

> `scripts/check.mjs` 只查**能自动查的那部分**（约 30 条）。下面这些查不到，
> 但漏了照样出事，而且通常**不报错**。
>
> 用法：逐条勾，勾不上就是还没好。表格里的「判据」都能当场验，不用凭印象。

---

## A 表 · 代码交付前

给用户能装之前过一遍。

```
□ 1. config.models 有内容
      判据：插件装上后模型列表不是空的；静态占位也算
      出处：README 铁律 1

□ 2. authorize() 立刻返回
      判据：登录时不出现长时间转圈；所有网络请求都在 loader 里
      出处：README 铁律 2

□ 3. refresh 返回的是「合并」
      判据：刷新后原有字段一个不少（把旧对象展开再覆盖新字段）
      出处：README 铁律 3

□ 4. usage.used 是有限数字
      判据：额度条不是永远 100%；Number.isFinite(used) 为真
      出处：HOOKS 九

□ 5. free 来自厂商声明，不是从 rate 反推
      判据：rate===0 但套餐内收费的模型，没有被标 free
      出处：HOOKS 十一之二

□ 6. 模型级错误用 404
      判据：grep 一下 401/403 都用在了「登录失效」上，模型错误没有误用
      出处：README 常见坑 2

□ 7. 一次性 refresh_token 是串行的
      判据：同账号并发刷新有锁 / 复用同一个 in-flight promise
      出处：README 常见坑 4

□ 8. 上下文窗口是实测值，不是猜的
      判据：填错了会让 agent 认为「放不下」而拒绝长输入，见 README「上下文窗口要实测」
      出处：README 该节（含两种填错的后果）

□ 9. LICENSE 是逐字 MIT 正文，归属说明在 NOTICE.md
      判据：GitHub 仓库首页显示「MIT license」，不是 NOASSERTION
      出处：README 顶部四件

□ 10. 五个 TODO 的语义按 HOOKS.md 对过，不是「能跑就算」
      判据：每个钩子的返回值形状与 HOOKS 第 21 章一致
      出处：HOOKS 全章

□ 11. README 按 README-TEMPLATE.md 的九段结构写
      判据：开头有数字、功能一条一条、安装放最后、技术细节进了 docs/internals.md
      出处：README-TEMPLATE.md

□ 12. 有破坏性变更的话，CHANGELOG 里标了 ⚠ **破坏性**，README 里也提了
      判据：用户能从 CHANGELOG 一眼看出需要手动迁移什么
      出处：UPDATING 四

□ 13. node scripts/check.mjs 退出码 = 0
      判据：末尾「失败 0」；警告逐条判断是否可接受

□ 14. 每个模型都显式声明了 capabilities.input.image
      判据：grep 源码里每个模型定义都有 image: true/false，没有省略；
            text-only 用 { input: { text: true, image: false, audio: false, video: false, pdf: false } }
      出处：HOOKS 十一之三（不写 = 厂商未表态，magpie 会按 models.dev 裸 id 投票误判）
```

---

## B 表 · 发版前（七步，一步不能少）

> ⚠ **`git push` 只是第 4 步。** 只做 push 就说「已发布」，是本仓库历史上真实踩过的坑：
> GitHub 仓库右侧会一直写着「暂无发布版本」，npm 上还停在旧版本。

```
□ 第 0 步 · 写更新内容（先写，不是发完再补）
      判据：CHANGELOG 顶部是这个版本的一节，一条一行、说用户能感知的变化
      出处：UPDATING 四

□ 第 1 步 · bump version
      命令：npm version patch --no-git-tag-version
      判据：package.json 的 version 变了；没变的话 bun 会命中缓存装回旧产物
      出处：UPDATING 二 · 第 1 步

□ 第 2 步 · 打包面预演
      命令：npm pack --dry-run
      判据：清单里有 README.md / CHANGELOG.md / docs/（files 白名单别漏）
      出处：UPDATING 二 · 第 2 步

□ 第 3 步 · 提交
      判据：message 用 `<范围>: <小写句子>`，一条 commit 一件事
      出处：UPDATING 二 · 第 3 步

□ 第 4 步 · 推到默认分支
      命令：git push origin main
      判据：git 源装的人靠这里检测 —— **推别的分支不算**
      出处：UPDATING 一

□ 第 5 步 · npm publish
      命令：npm publish
           （包内 name 与 npm 包名不同、含大写标题时用 npm run publish:npm）
      判据：返回 `+ <包名>@<版本>`；package.json 的 name 已还原
      出处：UPDATING 二 · 第 5 步

□ 第 6 步 · tag + GitHub Release
      命令：git tag v<version> && git push origin v<version>
           然后建 Release（有 release.yml 的推 tag 就够；没有的按 UPDATING 手工发）
      判据：tag 与 package.json 的 version 一致；Release 不是 draft
      出处：UPDATING 二 · 第 6 步
      ⚠ Release / tag **不参与** magpie 的更新检测 —— 但少了用户就没有地方看这一版改了什么

□ 第 7 步 · 五条验证（每条都要真跑）
      ⓪ node scripts/check-maintenance.mjs → 退出码 0（改了代码必须 bump / bump 必须打 tag）
      ① npm view <包名> version            → 已是新版本
      ② 下载 dist.tarball 解包看内容       → 别只看版本号，要看到新代码
      ③ magpie plugin list                → 本机认得新版本（git 源看 commit）
      ④ GET /releases/tags/v<version>     → 200 且 draft=false
      判据：五条全过；没过不许说「已发布」
      出处：UPDATING 二 · 第 7 步
```

⚠ **npm 登记有延迟。** `npm publish` 返回成功时 registry 可能还查不到新版本，
实测约 1-2 分钟才出现。**别在这个窗口里当成失败重发** —— 重发会撞「同版本号已存在」。

---

## 发完之后

```
□ 用户侧说「有新版本但没动静」
      git 源：只提示、不自动更新，用户要自己点界面里那一行的「更新」按钮
      npm 源：magpie 会自动更新
      判据：先看 `~/.config/magpie/plugin-updates.json` 的 `waiting[]` 里有没有它

□ 用户侧说「更新了但没变化」
      判据：`magpie plugin list` 里的版本/commit 真的换了；插件自己写的缓存文件 mtime
            在更新之后被重建过（没变 = 新代码没加载）
      出处：AGENTS.md 坑 10

□ 破坏性变更
      判据：README 顶部有迁移说明，CHANGELOG 标了 ⚠ 破坏性
```
