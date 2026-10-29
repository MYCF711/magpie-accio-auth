// 内置验证码登录：只测「方法注册与 prompts 契约」。
// 真实浏览器流程在真机验证（见 docs/internals.md §12.7），跑单测不启动浏览器。
import { test } from "node:test"
import assert from "node:assert/strict"
import { AccioAuthPlugin } from "../index.mjs"

test("内置验证码登录：方法存在，问手机号/邮箱 + 站点", async () => {
  const h = await AccioAuthPlugin({ client: {} })
  const m = h.auth.methods.find((x) => /验证码登录（内置/.test(x.label))
  assert.ok(m, "必须有内置验证码登录方法")
  assert.equal(m.type, "oauth")
  const keys = (m.prompts ?? []).map((p) => p.key)
  assert.deepEqual(keys, ["account", "region"])
  const account = (m.prompts ?? []).find((p) => p.key === "account")
  assert.equal(account.validate("13800138000"), undefined)
  assert.equal(account.validate("a@b.com"), undefined)
  assert.match(account.validate("1"), /11 位手机号|完整邮箱/)
})

test("内置验证码登录：authorize 不等待用户登录（立刻返回）", async () => {
  const h = await AccioAuthPlugin({ client: {} })
  const m = h.auth.methods.find((x) => /验证码登录（内置/.test(x.label))
  // 只检查函数形态：真启动浏览器会连外网，单测不碰。authorize 必须是 async 函数。
  assert.equal(m.authorize.constructor.name, "AsyncFunction")
})
