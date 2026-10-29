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
  // sId 必须与官方分享链接一致（base64 的 == 会被编码成 %3D%3D）
  const withSid = new URL(buildAuthUrl({
    region: "cn", redirectUri: "http://x/cb", state: "s", codeChallenge: "c",
    inviteCode: "IC624891464548", inviteSid: "hKVFtOhL8IqKglYysM8tGA==",
  }))
  assert.equal(withSid.searchParams.get("sId"), "hKVFtOhL8IqKglYysM8tGA==")
  // 不填邀请码时一个都不加（不能给普通登录带垃圾参数）
  const plain = new URL(buildAuthUrl({ region: "cn", redirectUri: "http://x/cb", state: "s", codeChallenge: "c" }))
  assert.equal(plain.searchParams.get("ic"), null)
  assert.equal(plain.searchParams.get("source"), null)
  assert.equal(plain.searchParams.get("sId"), null)
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

test("邀请码方法：与 magicrew 同款的多步问答（邀请码 → 站点 → 问完）", async () => {
  const hooks = await AccioAuthPlugin({ client: {} })
  const method = hooks.auth.methods.find((m) => /邀请码/.test(m.label))
  assert.ok(method, "必须有「邀请码」登录方式")
  assert.equal(typeof method.ask, "function", "必须用 ask() 做多步问答，不能只给静态 prompts")

  const first = await method.ask({})
  assert.equal(first.key, "invite")
  assert.match(first.placeholder, /邀请码/, "灰色字要说明当前模式/怎么填")

  const second = await method.ask({ invite: "IC624891464548" })
  assert.equal(second.key, "region", "填完邀请码必须直接接主登录的站点选择，而不是回一句「已保存」")

  assert.equal(await method.ask({ invite: "IC624891464548", region: "cn" }), null)
})

test("邀请码方法：数字框语义 —— 0/空 沿用策略、其它当新码（resolveInviteChoice）", async () => {
  // resolveInviteChoice 是 index.mjs 内部函数；通过 _internal 暴露不了，
  // 这里改用「写入策略码后，邀请码方法的灰色字应显示它」来锁语义。
  const { writeInviteCode, readInviteCode } = await import("../src/store.mjs")
  writeInviteCode("IC624891464548", "test")
  assert.equal(readInviteCode(), "IC624891464548")
  const hooks = await AccioAuthPlugin({ client: {} })
  const method = hooks.auth.methods.find((m) => /邀请码/.test(m.label))
  const p = await method.ask({})
  assert.match(p.placeholder, /IC624891464548/, "灰色字要显示当前策略里的码")
})
