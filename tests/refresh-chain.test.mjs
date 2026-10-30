// 「按 refresh chain 协调，不按 account」的回归锁（2026-10-30，Jet Hub 借鉴）。
//
// 场景：Accio 的刷新**轮换** refresh_token。两个进程（或 loader 内硬续期 + 宿主定时
// 续期）拿同一份旧 token 去刷时，一个成功、另一个必然 invalid_grant。失败那个如果
// 直接判「登录失效」，就会把**已经被别人续好的好账号标死**。
//
// 本文件钉：
//   ① 续期被拒时回读 plugin-auth.json —— 链已更新 ⇒ 用最新的，不抛 signIn expired
//   ② 链没变 / 读不到 ⇒ 仍判终态（真失效不能漏判）
//   ③ 别的账号的槽 ⇒ 绝不借用（不把 B 的凭据给 A）
//   ④ 认不准 ⇒ 不标死，抛普通错误（下轮再试）
//   ⑤ toStored 在续期路径保住 accountId / uid（否则卡片手机号被抹、uid 每轮漂）

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sandbox = mkdtempSync(join(tmpdir(), "accio-chain-"))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox
process.env.APPDATA = join(sandbox, "Roaming") // 别读到真机的 Accio 客户端

const { AccioAuthPlugin } = await import("../index.mjs")
const { toStored, identityOf } = await import("../src/credential.mjs")

const AUTH_DIR = join(sandbox, ".config", "magpie")
const AUTH_FILE = join(AUTH_DIR, "plugin-auth.json")

/** magpie 里一条账号记录（形状见 src/credential.mjs 头）。 */
function record(refresh, access, extra = {}) {
  return {
    type: "oauth",
    refresh,
    access: JSON.stringify({
      access_token: access,
      refresh_token: refresh,
      expires_at: Date.now() + 30 * 24 * 3600_000,
      region: "cn",
    }),
    expires: Date.now() + 30 * 24 * 3600_000,
    accountId: "",
    uid: `sha256:${refresh}`,
    ...extra,
  }
}

function writeAuth(records) {
  mkdirSync(AUTH_DIR, { recursive: true })
  writeFileSync(AUTH_FILE, JSON.stringify(records))
}

const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } })

/** 续期端点回「refresh token 用过了」（终态）。 */
function stubTerminal() {
  const original = globalThis.fetch
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/auth/refresh_token")) {
      return json({ success: false, code: "invalid_grant", message: "refresh token has been used" })
    }
    return json({})
  }
  return () => {
    globalThis.fetch = original
  }
}

const hooksOf = async () => AccioAuthPlugin({ client: {} })

test("链已更新：续期被拒但别的进程已续好 → 用最新凭据，不抛 signIn expired", async () => {
  // 存储里是同账号的新链 R2；本次拿的是旧链 R1
  const latest = record("R2-new", "acc-new", { accountId: "181****0632", uid: "sha256:R2-new" })
  writeAuth({ accio: latest })
  const stale = record("R1-old", "acc-old", { accountId: "181****0632", uid: "sha256:R1-old" })

  const restore = stubTerminal()
  try {
    const hooks = await hooksOf()
    const out = await hooks.auth.refresh(stale)
    assert.ok(out, "必须返回最新凭据，而不是抛错")
    assert.equal(out.refresh, "R2-new", "refresh 必须是最新那条链")
    assert.equal(JSON.parse(out.access).access_token, "acc-new")
    assert.equal(out.uid, "sha256:R1-old", "身份字段沿用旧记录（稳定），不跟着链漂")
  } finally {
    restore()
  }
})

test("链没变：仍判 signIn expired（真失效不能漏判）", async () => {
  const same = record("R1-old", "acc-old", { accountId: "181****0632", uid: "sha256:R1-old" })
  writeAuth({ accio: same })

  const restore = stubTerminal()
  try {
    const hooks = await hooksOf()
    await assert.rejects(() => hooks.auth.refresh(same), (e) => e.signIn === "expired")
  } finally {
    restore()
  }
})

test("读不到 plugin-auth.json：不得据此判「变了」，维持终态", async () => {
  const restore = stubTerminal()
  try {
    rmSync(AUTH_FILE, { force: true }) // 本用例要「读不到文件」
    const hooks = await hooksOf()
    const stale = record("R1-old", "acc-old", { accountId: "181****0632" })
    await assert.rejects(() => hooks.auth.refresh(stale), (e) => e.signIn === "expired")
  } finally {
    restore()
  }
})

test("别的账号的槽：绝不借用（B 的凭据不能写给 A）", async () => {
  const other = record("R-other", "acc-other", { accountId: "189****1111", uid: "sha256:R-other" })
  writeAuth({ "accio#other": other })
  const mine = record("R1-old", "acc-old", { accountId: "181****0632", uid: "sha256:R1-old" })

  const restore = stubTerminal()
  try {
    const hooks = await hooksOf()
    await assert.rejects(
      () => hooks.auth.refresh(mine),
      (e) => e.signIn === undefined && !/acc-other|R-other/.test(String(e.message)),
      "不许把别的账号的凭据/错误当成本账号的结果",
    )
  } finally {
    restore()
  }
})

test("多账号且认不准：不标死账号，抛普通错误（下轮再试）", async () => {
  writeAuth({
    "accio#a": record("R-a", "acc-a", { accountId: "189****1111", uid: "sha256:R-a" }),
    "accio#b": record("R-b", "acc-b", { accountId: "189****2222", uid: "sha256:R-b" }),
  })
  const mine = record("R1-old", "acc-old", { accountId: "", uid: "sha256:R1-old" })

  const restore = stubTerminal()
  try {
    const hooks = await hooksOf()
    await assert.rejects(
      () => hooks.auth.refresh(mine),
      (e) => e.signIn === undefined,
      "认不准时绝不能标 signIn expired（会把好账号标死）",
    )
  } finally {
    restore()
  }
})

// ── toStored：续期路径必须承接身份字段 ────────────────────────────────
test("toStored：续期（带 prev）保住 accountId / uid，不跟着 refresh 轮换漂", () => {
  const prev = { accountId: "181****0632", uid: "sha256:stable", type: "oauth" }
  const next = { access_token: "acc2", refresh_token: "R2", expires_at: Date.now() + 3600_000 }
  const stored = toStored(next, prev)
  assert.equal(stored.accountId, "181****0632", "续期不能把卡片手机号抹成空串")
  assert.equal(stored.uid, "sha256:stable", "uid 是账号身份，不能每轮换")
})

test("toStored：新登录（无 prev）仍按凭据生成身份，行为与以前一致", () => {
  const cred = { access_token: "acc1", refresh_token: "R1", expires_at: Date.now() + 3600_000 }
  const stored = toStored(cred)
  assert.equal(stored.accountId, "", "Accio 不给账号名 —— 空串让 magpie 回退到供应商名")
  assert.equal(stored.uid, identityOf(cred), "新号用 refresh 哈希做 uid")
})
