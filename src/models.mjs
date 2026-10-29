// 模型表与模型条目形状
//
// ═══════════════════════════════════════════════════════════════════
// 两个 id 的差别（本插件最容易错的一处）
// ═══════════════════════════════════════════════════════════════════
//
//   对外 id（magpie / agent 用）   `qwen-3-8-flash`  ← 展示名归一成 slug
//   上行 id（对话请求里用）        `1Drift-F8hS3mK7pL2n`  ← 上游的 modelCode
//
// 上游**只认 modelCode**，发 slug 会「请求打空」（症状：模型不回复）。
// 两者由 `makeIndex()` 建映射，`chat.mjs` 在发请求前换回 modelCode。
// 查不到时**原样发入参**，让上游报错 —— 不本地编造空模型名。
//
// ═══════════════════════════════════════════════════════════════════
// 两个表的分工
// ═══════════════════════════════════════════════════════════════════
//
//   FALLBACK_ENTRIES   config 钩子用 —— 未登录时也要有内容
//                      ⚠ 没有它 magpie 显示 "0 models"
//   liveEntries        登录后从 `POST /api/llm/config/v2` 拉，失败回退兜底表
//
// ═══════════════════════════════════════════════════════════════════
// 模型条目的字段（漏一个就静默少一块能力）
// ═══════════════════════════════════════════════════════════════════
//
// · `capabilities.input.image` **必须是布尔值**：省略 ≠ text，而是「厂商未表态」，
//   magpie 会按 models.dev 的裸 id 投票补 —— 同名模型在别家标过 image，
//   这个实际收不了图的模型就会被当成能收图，截图直发上游被拒。
// · `variants` 只是展示档位（Accio 上游没有受控 field，实测四类都不生效）。
// · `free` 不写：Accio 是积分制，没有「免费模型」声明；**不能从倍率 0 反推**。
//
// ═══════════════════════════════════════════════════════════════════

import { NPM, PLACEHOLDER_BASE } from "./constants.mjs"

/** 展示名 → slug（对外 id）。归一后为空时回退 modelCode（空 id 会让整个目录不可用）。 */
export function slugOf(name) {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

/**
 * 远端目录条目归一（DSH `normalizeAccioModel` 同口径）：
 * `visible !== true` 剔除；`reasoningEfforts` 可能是 null —— 与空数组同样表达为
 * 「无档位」；`defaultReasoningEffort` 可单独存在（单档）。
 */
export function normalizeModel(raw) {
  if (raw === null || typeof raw !== "object") return undefined
  if (raw.visible !== true) return undefined
  const modelCode = typeof raw.modelCode === "string" ? raw.modelCode : ""
  if (modelCode === "") return undefined

  const displayName = typeof raw.modelDisplayName === "string" ? raw.modelDisplayName : ""
  const contextWindow = typeof raw.contextWindow === "number" && Number.isFinite(raw.contextWindow)
    ? raw.contextWindow : 0
  const multiple = typeof raw.effectiveMultiple === "number" && Number.isFinite(raw.effectiveMultiple)
    ? raw.effectiveMultiple : undefined
  const maxTokens = typeof raw.maxTokens === "number" && Number.isFinite(raw.maxTokens)
    ? raw.maxTokens : undefined
  const efforts = Array.isArray(raw.reasoningEfforts)
    ? raw.reasoningEfforts.filter((e) => typeof e === "string" && e.trim() !== "")
    : []
  const defaultEffort = typeof raw.defaultReasoningEffort === "string" && raw.defaultReasoningEffort.trim() !== ""
    ? raw.defaultReasoningEffort : undefined

  return {
    id: modelCode,
    name: displayName === "" ? modelCode : displayName,
    contextWindow,
    supportsImage: raw.multimodal === true,
    ...(multiple !== undefined ? { multiple } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(efforts.length > 0 ? { efforts } : {}),
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
  }
}

/** `POST /api/llm/config/v2` → `data[].modelList[]`，按倍率升序（缺倍率的排最后）。 */
export function parseCatalog(body) {
  const data = body?.data
  if (!Array.isArray(data)) return []
  const models = []
  for (const group of data) {
    const list = group?.modelList
    if (!Array.isArray(list)) continue
    for (const raw of list) {
      const entry = normalizeModel(raw)
      if (entry !== undefined) models.push(entry)
    }
  }
  // ⚠ 缺倍率排最后（`Infinity - Infinity = NaN` 会让 sort 退化为不稳定原序）
  return models.sort((a, b) => {
    const l = a.multiple
    const r = b.multiple
    if (l === undefined && r === undefined) return 0
    if (l === undefined) return 1
    if (r === undefined) return -1
    return l - r
  })
}

/**
 * 兜底模型表（DSH 2026-10-12 真机实测 15 条，倍率升序；slug 由展示名归一）。
 *
 * ⚠ `modelCode` 是上游的内部代号，非人类可读、**无法手写维护** ——
 *   这张表只在远端目录失败时兜住「未登录也能看到模型」这一件事。
 *   真实可用性一律以登录后拉到的目录为准。
 */
export const FALLBACK_ENTRIES = [
  { id: "1Drift-N8kP2Q7wR5mX", name: "Qwen 3.8 27B", contextWindow: 512_000, supportsImage: true, multiple: 0.013 },
  { id: "1Drift-F8hS3mK7pL2n", name: "Qwen 3.8 Flash", contextWindow: 1_000_000, supportsImage: true, multiple: 0.03 },
  { id: "1Chronos-F53X9nQ3rT8w", name: "GLM 5.3 Flash", contextWindow: 1_000_000, supportsImage: true, multiple: 0.03 },
  { id: "1Nova-Q3xM8vJ1rH6z", name: "DeepSeek V4.1 Flash", contextWindow: 1_000_000, supportsImage: true, multiple: 0.045 },
  { id: "1Zenith-M27hS2SR5xQ2p", name: "MiniMax M3", contextWindow: 1_000_000, supportsImage: true, multiple: 0.08 },
  { id: "1Chronos-dX3cV9sA2mK7", name: "GLM 5.1", contextWindow: 200_000, supportsImage: false, multiple: 0.12 },
  { id: "1Nexus-R3wF8qJ5vB6h", name: "Standard", contextWindow: 1_000_000, supportsImage: true, multiple: 0.13 },
  { id: "1Drift-A3bM5nK8pQ2w", name: "Qwen 3.5 A3B", contextWindow: 256_000, supportsImage: false, multiple: 0.13 },
  { id: "1Synapse-G5aJ8wL1dV4s", name: "Kimi K2.6", contextWindow: 256_000, supportsImage: true, multiple: 0.14 },
  { id: "1Chronos-L53W8nP2qR6m", name: "GLM-5.3", contextWindow: 1_000_000, supportsImage: false, multiple: 0.16 },
  { id: "1Chronos-G5p2V9sA2mK7", name: "GLM 5.2", contextWindow: 1_000_000, supportsImage: false, multiple: 0.16 },
  { id: "1Nova-bW7yT4kL9pN2", name: "DeepSeek V4 Pro", contextWindow: 1_000_000, supportsImage: false, multiple: 0.17 },
  { id: "1Drift-T3TB6WS9a23w", name: "Qwen 3.8 Max", contextWindow: 1_000_000, supportsImage: true, multiple: 0.44 },
  { id: "1Orbit-I9eY4tK8bW1f", name: "Professional", contextWindow: 1_000_000, supportsImage: true, multiple: 1 },
  { id: "1Orbit-Q7hN3xR6cP2m", name: "Ultimate", contextWindow: 1_000_000, supportsImage: true, multiple: 2.8 },
]

/**
 * 一条 magpie 模型条目（`provider.models` 形状）。
 *
 * ⚠ 这里同时写 `toolcall` 与 `tool_call` 两种拼写：契约里 `config` 的静态表读
 *   `tool_call`、`provider.models` 读 `toolcall`，写错位置的那一个会静默为假。
 *   多写一个键不报错，两处都成立。
 */
export function modelEntry(entry) {
  const context = entry.contextWindow > 0 ? entry.contextWindow : 128_000
  const output = entry.maxTokens ?? 8_192
  const image = entry.supportsImage === true
  const variants = variantsOf(entry)
  return {
    id: entry.slug ?? entry.id,
    name: entry.name,
    api: { id: entry.slug ?? entry.id, url: PLACEHOLDER_BASE, npm: NPM },
    status: "active",
    headers: {},
    options: {},
    // 倍率进 `rate`（卡片上那个胶囊）；name 保持干净，用户按名字选
    ...(entry.multiple !== undefined ? { rate: `x${entry.multiple}` } : {}),
    limit: { context, output },
    capabilities: {
      temperature: true,
      // ⚠ Accio 关不掉思考（实测四类字段全部无效），档位仅作展示
      reasoning: Object.keys(variants).length > 0,
      attachment: image,
      toolcall: true,
      tool_call: true,
      input: { text: true, image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
      maxTokens: output,
    },
    variants,
    release_date: "",
  }
}

/** 档位仅展示：上游没有受控字段（请求体不带 effort）。 */
function variantsOf(entry) {
  const out = {}
  if (Array.isArray(entry.efforts) && entry.efforts.length > 0) {
    for (const effort of entry.efforts) out[effort] = { reasoning_effort: effort }
  } else if (entry.defaultEffort !== undefined) {
    out[entry.defaultEffort] = { reasoning_effort: entry.defaultEffort }
  }
  return out
}

/** 分配对外 slug；同展示名撞车时加 `-2`、`-3`（否则后一条会覆盖前一条）。 */
export function assignSlugs(entries) {
  const used = new Set()
  const out = []
  for (const entry of entries) {
    const base = slugOf(entry.name) || entry.id
    let slug = base
    let n = 2
    while (used.has(slug)) {
      slug = `${base}-${n++}`
    }
    used.add(slug)
    out.push({ ...entry, slug })
  }
  return out
}

/** 未登录 / 拉取失败时的静态表（`config` 钩子用）。 */
export function staticModels() {
  const out = {}
  for (const entry of assignSlugs(FALLBACK_ENTRIES)) {
    out[entry.slug] = modelEntry(entry)
  }
  return out
}

/** 登录后拉到的目录 → magpie 形状（`provider.models` 用）。 */
export function liveModels(entries) {
  const out = {}
  for (const entry of assignSlugs(entries)) {
    out[entry.slug] = modelEntry(entry)
  }
  return out
}

/**
 * slug ↔ modelCode 映射。
 *
 * 每次目录刷新重建一份，调用方（index.mjs）把它随快照落盘，`chat.mjs` 用它换 id。
 * ⚠ 不要用模块级变量缓存 —— 宿主同一进程跑所有账号，第二个账号会串号。
 */
export function makeIndex(entries) {
  return assignSlugs(entries).map((entry) => ({ slug: entry.slug, code: entry.id }))
}

/** slug → modelCode；查不到原样返回（让上游报错，不本地编造）。 */
export function codeOf(index, slug) {
  if (!Array.isArray(index) || typeof slug !== "string") return slug
  const hit = index.find((m) => m.slug === slug)
  return hit?.code ?? slug
}