// 「续期绝不借用别的账号的凭据」不变量 + 去重键形状（2026-10-30，Jet Hub / 社区 review）。
//
//  ① refreshOnce 的键 = **OAuth client + refresh_token 链**（不是 provider id / accountId / region）
//  ② 一次续期只写**一个**账号槽，其它槽逐字节不变
//  ③ 写回体里必须带新 token 与稳定身份（accountId / uid），不写 undefined

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sandbox = mkdtempSync(join(tmpdir(), "accio-invariant-"))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox
process.env.APPDATA = join(sandbox, "Roaming")

const { AccioAuthPlugin } = await import("../index.mjs")
const { refreshKeyOf } = await import("../src/login.mjs")
const { CLIENT_ID } = await import("../src/constants.mjs")

const json = (obj) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" } })

function record(refresh, access, extra = {}) {
  return {
    type: "oauth",
    refresh,
    access: JSON.stringify({ access_token: access, refresh_token: refresh, expires_at: Date.now() + 3600_000 }),
    expires: Date.now() + 3600_000,
    accountId: "",
    uid: `sha256:${refresh}`,
    ...extra,
  }
}

test("refreshKeyOf：键里必须有 OAuth client id 与 refresh_token，且不含 region", () => {
  const a = { refresh_token: "R1", region: "cn" }
  const b = { refresh_token: "R1", region: "global" }
  assert.equal(refreshKeyOf(a), `${CLIENT_ID}\nR1`)
  assert.equal(refreshKeyOf(a), refreshKeyOf(b), "region 只决定登录页域名，不能进键（否则同一份凭据会双刷）")
  assert.notEqual(refreshKeyOf({ refresh_token: "R1" }), refreshKeyOf({ refresh_token: "R2" }))
})

test("一次续期只写目标账号：其它账号槽逐字节不变", async () => {
  const store = {
    accio: record("R1", "acc-old", { accountId: "181****0632", uid: "sha256:stable" }),
    "accio#other": record("R-other", "acc-other", { accountId: "189****1111", uid: "sha256:other" }),
  }
  const before = JSON.stringify(store["accio#other"])
  const calls = []

  const original = globalThis.fetch
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/auth/refresh_token")) {
      return json({ success: true, data: { accessToken: "acc-new", refreshToken: "R2", expiresAt: Math.floor(Date.now() / 1000) + 86400 } })
    }
    return json({})
  }
  try {
    const hooks = await AccioAuthPlugin({
      client: {
        auth: {
          // magpie 的 auth.set 是「整体替换」；path.id 由 host.js 的 scope 解析成当前账号
          set: async ({ path, body }) => {
            calls.push({ path: path.id, body })
            store[path.id] = body
          },
        },
      },
    })
    const out = await hooks.auth.refresh(store.accio)
    assert.ok(out)

    assert.equal(calls.length, 1, "一次续期只允许一次 auth.set")
    assert.equal(calls[0].path, "accio")
    assert.equal(JSON.parse(calls[0].body.access).refresh_token, "R2", "写回体必须是新链")
    assert.equal(calls[0].body.accountId, "181****0632", "不能把卡片手机号抹掉")
    assert.equal(calls[0].body.uid, "sha256:stable", "uid 必须稳定，不跟着 refresh 轮换")

    assert.equal(JSON.stringify(store["accio#other"]), before, "其它账号的记录必须逐字节不变")
    assert.equal(Object.keys(store).length, 2, "不许凭空多出账号槽")
  } finally {
    globalThis.fetch = original
  }
})
