import { AccioAuthPlugin } from "./index.mjs"
const email = process.argv[2]
const hooks = await AccioAuthPlugin({ client: {} })
const m = hooks.auth.methods.find((x) => /验证码登录（内置/.test(x.label))
const t0 = Date.now()
try {
  const h = await m.authorize({ account: email, region: "cn" })
  console.log("AUTHORIZED in", Math.round((Date.now() - t0) / 1000), "s | method:", h.method, "|", h.instructions)
} catch (e) {
  console.log("ERR:", String(e.message).slice(0, 300))
}
