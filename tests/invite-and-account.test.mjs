// 账号显示（/api/auth/userinfo）与邀请（/api/invitation/{query,commit}）的回归。
//
// 这两组接口都来自官方客户端 asar 里的 API 表：
//   userInfo: /api/auth/userinfo      invitationQuery: /api/invitation/query
//   invitationCommit: /api/invitation/commit
// 参数形状（`accessToken` 在 body、commit 用 `code`）来自客户端调用点与真机实测。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sandbox = mkdtempSync(join(tmpdir(), "accio-invite-"))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox

const { buildAuthUrl } = await import("../src/login.mjs")
const { accountLabelOf } = await import("../src/credential.mjs")
const { fetchUserInfo, commitInvitation, fetchInvitation } = await import("../src/api.mjs")
const { AccioAuthPlugin } = await import("../index.mjs")

const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } })
const cred = { access_token: "at_test", refresh_token: "rt_test", expires_at: Math.floor(Date.now() / 1000) + 3600 }

function stub(routes) {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, method: init?.method })
    for (const [match, respond] of routes) if (url.includes(match)) return respond()
    return json({ success: false, code: "404", message: "no route" })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

test("buildAuthUrl：邀请码按官方分享链接的参数名拼（ic / tenant / src / source=invite_center）", () => {
  const url = new URL(buildAuthUrl({
    region: "cn",
    redirectUri: "http://127.0.0.1:1234/auth/callback",
    state: "s",
    codeChallenge: "c",
    inviteCode: "IC624891464548",
  }))
  assert.equal(url.searchParams.get("ic"), "IC624891464548")
  assert.equal(url.searchParams.get("tenant"), "accio")
  assert.equal(url.searchParams.get("src"), "p_referral_IC624891464548")
  assert.equal(url.searchParams.get("source"), "invite_center")
  // 不填邀请码时一个都不加（不能给普通登录带垃圾参数）
  const plain = new URL(buildAuthUrl({ region: "cn", redirectUri: "http://x/cb", state: "s", codeChallenge: "c" }))
  assert.equal(plain.searchParams.get("ic"), null)
  assert.equal(plain.searchParams.get("source"), null)
})

test("accountLabelOf：手机号优先（去 +86）→ 邮箱 → userId → 空串", () => {
  assert.equal(accountLabelOf({ maskedMobile: "+86 189****8051", userId: "1798171953" }), "189****8051")
  assert.equal(accountLabelOf({ maskedMobile: "", email: "a@b.com", userId: "1" }), "a@b.com")
  assert.equal(accountLabelOf({ desensitizedEmail: "a***@b.com" }), "a***@b.com")
  assert.equal(accountLabelOf({ userId: "1798171953" }), "1798171953")
  assert.equal(accountLabelOf(null), "")
})

test("fetchUserInfo：token 必须在 body 的 accessToken（放 token 字段服务端回 400）", async () => {
  const s = stub([["/api/auth/userinfo", () => json({
    success: true, code: "200", message: "0",
    data: { userId: "1798171953", maskedMobile: "+86 189****8051", email: null },
  })]])
  try {
    const info = await fetchUserInfo(cred)
    assert.equal(info.userId, "1798171953")
    assert.equal(s.calls[0].body.accessToken, "at_test")
    assert.equal(s.calls[0].method, "POST")
  } finally { s.restore() }
})

test("commitInvitation：body 是 {accessToken, code}（客户端 asar：Oh(km.invitationCommit,{code})）", async () => {
  const s = stub([["/api/invitation/commit", () => json({ success: true, code: "200", data: { success: true } })]])
  try {
    await commitInvitation(cred, "IC624891464548")
    assert.equal(s.calls[0].body.accessToken, "at_test")
    assert.equal(s.calls[0].body.code, "IC624891464548")
    assert.equal(s.calls[0].url, "https://phoenix-gw.alibaba.com/api/invitation/commit")
  } finally { s.restore() }
})

test("fetchInvitation：data 是布尔", async () => {
  const s = stub([["/api/invitation/query", () => json({ success: true, code: "200", data: true })]])
  try {
    assert.equal(await fetchInvitation(cred), true)
  } finally { s.restore() }
})

test("邀请码方法：从 magpie 账号槽取当前 token → commit → query → success", async () => {
  // 预置 magpie 的账号槽（只读路径）
  const dir = join(sandbox, ".config", "magpie")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "plugin-auth.json"), JSON.stringify({
    accio: { type: "oauth", access: JSON.stringify(cred), refresh: "rt_test", expires: Date.now() + 3600_000, uid: "sha256:x" },
  }), "utf8")

  const s = stub([
    ["/api/invitation/commit", () => json({ success: true, code: "200", data: { success: true } })],
    ["/api/invitation/query", () => json({ success: true, code: "200", data: true })],
    ["/api/auth/userinfo", () => json({ success: true, code: "200", data: { userId: "1798171953", maskedMobile: "+86 189****8051" } })],
  ])
  try {
    const hooks = await AccioAuthPlugin({ client: {} })
    const method = hooks.auth.methods.find((m) => /邀请码/.test(m.label))
    assert.ok(method, "必须有「邀请码」登录方式")
    const started = await method.authorize({ code: "IC624891464548" })
    const outcome = await started.callback()
    assert.equal(outcome.type, "success")
    assert.equal(outcome.accountId, "189****8051", "邀请码绑定后卡片也要显示手机号")
    assert.match(outcome.uid, /^sha256:[0-9a-f]{12}$/)
    assert.deepEqual(s.calls.filter((c) => c.url.includes("/api/invitation/commit")).length, 1)
    assert.match(String(outcome.instructions ?? ""), /已提交/)
  } finally { s.restore() }
})

test("邀请码方法：没有登录态时明确报错（不静默失败）", async () => {
  // 上一条用例写过账号槽，这里先清掉
  const { rmSync } = await import("node:fs")
  rmSync(join(sandbox, ".config", "magpie", "plugin-auth.json"), { force: true })
  const hooks = await AccioAuthPlugin({ client: {} })
  const method = hooks.auth.methods.find((m) => /邀请码/.test(m.label))
  await assert.rejects(() => method.authorize({ code: "IC624891464548" }), /先用「登录 Accio」登录/)
})
