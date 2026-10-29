// 额度窗口的构造器 —— 把「写错不报错，但 GUI 和路由会坏」的那些坑变成运行时错误。
//
// 为什么需要它：`usage` 钩子返回的窗口是 magpie 画额度条 **和** 智能路由排序的输入。
// 写错字段不会让插件崩，只会让用户看到「剩余额度未知」、让这个号在路由里被当成不存在 ——
// 而插件作者从日志里什么都看不到。这些坑在 AGENTS.md 第 1 / 22 / 23 / 24 条有完整论证，
// 这里是它们的可执行版本：**写错就 throw，错误信息直接说后果。**
//
// 用法：
//   import { usageWindow, usage } from "./quota.mjs"
//   return usage({
//     plan: "Pro",
//     windows: [
//       usageWindow({ name: "5 hours", used: 37, resetsAt: u.resets_at, span: 18000 }),
//       usageWindow({ name: "积分", balance: 6291, unit: "积分" }),
//     ],
//   })

/** 写法错误（不是上游失败）。调用方应当**重新抛出**，而不是吞成 usage.error -- 
 *  因为那是编码错误，静默掉就又会变成"GUI 坏了但日志里什么都没有"。 */
export class QuotaShapeError extends Error {
  constructor(message) {
    super(message)
    this.name = "QuotaShapeError"
  }
}

const TIME_KEYS = ["resetsAt", "runsOutAt", "until"]

/** 把厂商给的时间（ISO / 秒 / 毫秒时间戳 / Date）统一成 ISO 字符串。解析不了就抛。 */
export function toIso(value, field = "time") {
  if (value == null) return undefined
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new QuotaShapeError(`${field}: 无效的 Date`)
    return value.toISOString()
  }
  if (typeof value === "number") {
    // 厂商常给秒级时间戳：10 位按秒、13 位按毫秒
    const ms = value < 1e12 ? value * 1000 : value
    const d = new Date(ms)
    if (Number.isNaN(d.getTime())) throw new QuotaShapeError(`${field}: ${value} 不是有效时间戳`)
    return d.toISOString()
  }
  const s = String(value).trim()
  // 先原样试（ISO），再试「2026-10-28 23:59:59」这种厂商原样格式
  const direct = Date.parse(s)
  if (!Number.isNaN(direct)) return new Date(direct).toISOString()
  const m = s.match(/^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/)
  if (m) {
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0))
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  throw new QuotaShapeError(
    `${field}: 无法解析 "${s}"。magpie 只认 ISO / 时间戳 —— ` +
    `塞厂商原样格式会让整条窗口被丢掉（AGENTS 坑 22）`,
  )
}

/**
 * 构造一个额度窗口，并在构造时把五类「静默失败」拦下来。
 * 返回的对象可以直接放进 `usage().windows`。
 */
export function usageWindow(w = {}) {
  const out = {}
  for (const [k, v] of Object.entries(w)) if (v !== undefined) out[k] = v

  for (const k of TIME_KEYS) if (out[k] !== undefined) out[k] = toIso(out[k], k)

  const isWallet = out.balance !== undefined
  const isAside = out.aside === true

  // ① used 与 balance 是两种形态：钱包型（有 balance）不该给 used/limit
  if (isWallet) {
    if (!Number.isFinite(Number(out.balance))) {
      throw new QuotaShapeError(`窗口 "${out.name ?? "?"}": balance 必须是有限数字，收到 ${out.balance}`)
    }
    out.balance = Number(out.balance)
    if (out.used !== undefined) {
      // 官方：wallet 窗口不写 used / limit / aside。给了 used 会被当成「占比」而不是余额
      throw new QuotaShapeError(`窗口 "${out.name ?? "?"}": 钱包型（有 balance）不要再给 used —— magpie 会把它当占比读`)
    }
  } else {
    // ② used 必填且必须是有限数字：缺了按 0% = 满额算，空号反而排到队首（AGENTS 坑 1）
    if (!Number.isFinite(Number(out.used))) {
      throw new QuotaShapeError(
        `窗口 "${out.name ?? "?"}": used 必填且必须是有限数字（收到 ${out.used}）。` +
        `漏了会被当成 0% = 满额，空账号反而排到路由队首（AGENTS 坑 1）`,
      )
    }
    out.used = Number(out.used)
  }

  // ③ aside 窗口不许带 amount / limit：magpie 算不出占比，会整条丢掉（AGENTS 坑 22 / 24）
  if (isAside && (out.amount !== undefined || out.limit !== undefined)) {
    throw new QuotaShapeError(
      `窗口 "${out.name ?? "?"}": aside: true 的窗口不能给 amount/limit —— ` +
      `magpie 算不出占比会整条丢掉，卡片显示「剩余额度未知」且路由把它当不存在（AGENTS 坑 22 / 24）。` +
      `改用 display 描述，或去掉 aside`,
    )
  }

  // ④ 数量型窗口：amount 与 limit 必须成对，且 limit > 0
  if (!isWallet && !isAside && (out.amount !== undefined || out.limit !== undefined)) {
    if (!Number.isFinite(Number(out.amount)) || !Number.isFinite(Number(out.limit)) || Number(out.limit) <= 0) {
      throw new QuotaShapeError(`窗口 "${out.name ?? "?"}": amount/limit 必须成对且 limit > 0（收到 amount=${out.amount}, limit=${out.limit}）`)
    }
    out.amount = Number(out.amount)
    out.limit = Number(out.limit)
  }

  // ⑤ span 是秒，正整数
  if (out.span !== undefined) {
    if (!Number.isInteger(Number(out.span)) || Number(out.span) <= 0) {
      throw new QuotaShapeError(`窗口 "${out.name ?? "?"}": span 是窗口长度（秒），必须是正整数，收到 ${out.span}`)
    }
    out.span = Number(out.span)
  }

  if (out.name === undefined || String(out.name).trim() === "") {
    throw new QuotaShapeError("窗口必须有 name —— 它显示在进度条上方")
  }

  return out
}

/** 构造整个 usage 返回值。窗口逐个过一遍 usageWindow。 */
export function usage(u = {}) {
  const out = { ...u }
  if (u.windows !== undefined) {
    if (!Array.isArray(u.windows)) throw new QuotaShapeError("usage.windows 必须是数组")
    out.windows = u.windows.map((w) => usageWindow(w))
  }
  for (const k of TIME_KEYS) if (out[k] !== undefined) out[k] = toIso(out[k], k)
  if (out.error !== undefined && typeof out.error !== "string") {
    throw new QuotaShapeError("usage.error 必须是字符串（显示在额度窗口的位置）")
  }
  return out
}
