// 对话转发 —— OpenAI 形状 ⇄ Accio（Gemini 风格信封）
//
// ═══════════════════════════════════════════════════════════════════
// magpie 发进来的是 OpenAI chat completions（`@ai-sdk/openai-compatible`）
// ═══════════════════════════════════════════════════════════════════
//
//   POST {PLACEHOLDER}/chat/completions   body: { model, messages, tools, temperature, max_tokens, stream }
//
// Accio 要的是**另一种信封**（Gemini 风格：`contents` / `parts`，键 snake_case）：
//
//   POST {GATEWAY}/api/adk/llm/generateContent?sg_k={md5(requestId)}
//     headers: Content-Type / Accept: text/event-stream / utdid / version / appKey:'OneChat'
//     body   : { contents, system_instruction, tools, token, ... }
//     响应   : SSE，帧 `{content:{parts},usage_metadata,finish_reason,turn_complete}`，
//              流内错误 `{"error_code":"402","error_message":"unauthorized"}`（HTTP 仍 200）
//
// ⇒ 这个文件是双向翻译层：请求 OpenAI → Gemini，响应 SSE → OpenAI chunk 流。
//
// ═══════════════════════════════════════════════════════════════════
// 五个「写错就静默失败」的实测结论（全部来自 DSH 真机记录）
// ═══════════════════════════════════════════════════════════════════
//
// 1. **token 必须在 body 的 `token` 字段** —— 放 `Authorization` 头恒流内 402，
//    且错误以 `HTTP 200 + {"error_code":"402"}` 帧下发，不识别会误报「模型不回复」。
// 2. **缺 utdid 时阿里网关回 HTTP 200 + text/html 拦截页**（`bixi-intl.alicdn.com/punish`）
//    ⇒ 必须校验 content-type，否则 SSE 解析器会把它吞掉，症状同样是「模型不回复」。
// 3. **上行必须用 modelCode**（`1Drift-…`），发 slug 会请求打空。
// 4. **工具调用分片到达**（首帧只有 id/name，后续帧重复全量参数）⇒ 按 id 缓冲、
//    `mergeToolArgs` 合并成一次调用（重放会重复执行工具）。
// 5. **`system_instruction` 必须是字符串**（照 Gemini 包成对象恒 400）。
//
// ═══════════════════════════════════════════════════════════════════

import { createHash, randomBytes, randomUUID } from "node:crypto"

import { APP_KEY, APP_VERSION, GATEWAY, LLM_PATH } from "./constants.mjs"
import { codeOf } from "./models.mjs"
import { tokenFingerprint } from "./credential.mjs"
import { utdid } from "./store.mjs"
import { fetchWithRetry } from "./transport.mjs"

const requestIdOf = () => `req-${Date.now()}-${randomUUID().slice(0, 8)}`
const sgKOf = (requestId) => createHash("md5").update(requestId, "utf8").digest("hex")
/** message_id 必填（缺它上游 400）；掺随机量防上游按它去重。 */
const messageIdOf = (requestId) =>
  createHash("md5").update(`${requestId}:${randomBytes(16).toString("hex")}`, "utf8").digest("hex")

/** camelCase → snake_case（递归）；`undefined` 键整个丢掉（null 与缺键不同义）。 */
export function toSnake(value) {
  if (Array.isArray(value)) return value.map(toSnake)
  if (value !== null && typeof value === "object") {
    const out = {}
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue
      out[k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)] = toSnake(v)
    }
    return out
  }
  return value
}

/** 请求头。⚠ 不带 SecurityGuard 的 pctb-x-*（实测不必需）；token 不放 Authorization。 */
export function accioHeaders(credential, extra = {}) {
  const headers = {
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    utdid: utdid(),
    version: APP_VERSION,
    appKey: APP_KEY,
  }
  if (typeof credential?.sgcookie === "string" && credential.sgcookie !== "") {
    headers.sgcookie = credential.sgcookie
  }
  // 「chat.headers」钩子（以及 SDK）给的合法头：只认这两个（别把 Bearer 之类带上去）
  for (const name of ["utdid", "sgcookie"]) {
    const v = extra?.[name]
    if (typeof v === "string" && v !== "") headers[name] = v
  }
  return headers
}

export function buildBody({ model, accessToken, contents, systemInstruction, tools, temperature, maxOutputTokens, requestId }) {
  const camel = {
    model,
    empid: "",
    tenant: "",
    iaiTag: "",
    requestId,
    userRequestId: requestId,
    contents,
    // ⚠ 必须是**字符串**：对象形态实测恒回 HTTP 200 + 流内 400「Invalid request
    // format」（与 Gemini 在这一格上不同形，别照搬）。
    systemInstruction: systemInstruction === "" ? undefined : systemInstruction,
    // ⚠ parametersJson 必须是字符串：toSnake 会下钻对象 —— schema 参数名
    // 是数据，递归改写会把 filePath 静默变成 file_path（无任何报错）。
    tools: tools !== undefined && tools.length > 0 ? tools : undefined,
    temperature,
    maxOutputTokens,
    stopSequences: [],
    properties: { utdid: utdid(), version: APP_VERSION, appKey: APP_KEY, normalizedResponse: "true" },
    token: accessToken,
    messageId: messageIdOf(requestId),
    incremental: true,
  }
  const body = toSnake(camel)
  // ⚠ properties 子树不参与 snake 转换：实测成功形状里 appKey 是驼峰、
  // normalized_response 是 snake（两种键形混用），走通用转换是未实测形状。
  body.properties = {
    utdid: utdid(),
    version: APP_VERSION,
    appKey: APP_KEY,
    normalized_response: "true",
  }
  return body
}

// ── OpenAI → Gemini 信封 ────────────────────────────────────────────────

const textOf = (content) => {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.filter((b) => typeof b?.text === "string").map((b) => b.text).join("")
}

const dataUrlOf = (url) => {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(String(url ?? ""))
  return match === null ? undefined : { mimeType: match[1], data: match[2] }
}

/**
 * OpenAI 消息 → `{contents, systemInstruction}`。
 *
 * ⚠ 工具结果下发为 `{role:'user',parts:[{functionResponse}]}`（Gemini 风格），
 * **按 name 配对**（OpenAI 的 tool 消息不带 name ⇒ 需从 assistant 的 tool_calls
 * 建 id→name 映射回填，漏了映射工具结果就全字段丢失）。
 *
 * ⚠⚠ **跨消息配对纪律**：`functionResponse` **必须紧密相邻** —— 中间插任何东西
 * （含图片 user 消息）都会断开配对。故本函数把「工具结果内嵌的图片」先收集、
 * **全部 functionResponse 之后**才追加一条独立 user 消息。
 * 同时 `responseJson` 只装文本 —— 把含图的数组整体 stringify 会把巨大 base64
 * 塞进 JSON 串（图片既没真正给模型，还撑爆请求体）。
 */
export function serializeMessages(messages) {
  const contents = []
  const system = []
  const toolNames = new Map()

  for (const message of messages) {
    if (message?.role === "assistant" && Array.isArray(message.tool_calls)) {
      for (const call of message.tool_calls) {
        if (typeof call?.id === "string" && typeof call?.function?.name === "string") {
          toolNames.set(call.id, call.function.name)
        }
      }
    }
  }

  /** 工具结果内嵌图片（data URL → inlineData），配对批完成后统一追加。 */
  const pendingImages = []
  const collectToolImages = (content) => {
    if (!Array.isArray(content)) return
    for (const part of content) {
      if (part?.type === "image_url") {
        const inline = dataUrlOf(part?.image_url?.url)
        if (inline !== undefined) pendingImages.push(inline)
      }
    }
  }
  const flushPendingImages = () => {
    if (pendingImages.length === 0) return
    contents.push({
      role: "user",
      parts: [
        { text: "Attached image(s) from tool result:" },
        ...pendingImages.map((inline) => ({ inlineData: inline })),
      ],
    })
    pendingImages.length = 0
  }

  for (const message of messages) {
    const role = message?.role
    if (role === "system" || role === "developer") {
      const text = textOf(message.content)
      if (text !== "") system.push(text)
      continue
    }
    if (role === "tool") {
      const id = typeof message.tool_call_id === "string" ? message.tool_call_id : ""
      collectToolImages(message.content)
      // ⚠ responseJson 只装文本：含图数组整体 stringify 会把巨大 base64 塞进 JSON
      const text = typeof message.content === "string"
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter((p) => typeof p?.text === "string").map((p) => p.text).join("")
          : JSON.stringify(message.content ?? {})
      contents.push({
        role: "user",
        parts: [{
          functionResponse: {
            id,
            name: toolNames.get(id) ?? "",
            responseJson: text,
          },
        }],
      })
      continue
    }
    if (role === "assistant") {
      // ⚠ 跨 assistant 边界前必须先把上一批工具图片落盘（配对纪律）：
      //   进入下一条 model 消息之前，functionResponse 批必须已闭合。
      flushPendingImages()
      const parts = []
      const text = textOf(message.content)
      if (text !== "") parts.push({ text })
      for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
        parts.push({
          functionCall: {
            id: typeof call?.id === "string" ? call.id : "",
            name: typeof call?.function?.name === "string" ? call.function.name : "",
            argsJson: typeof call?.function?.arguments === "string" ? call.function.arguments : "{}",
          },
        })
      }
      if (parts.length > 0) contents.push({ role: "model", parts })
      continue
    }
    // user（含图片：Gemini 风格 inlineData，实测四象限色块四色全对）
    const parts = []
    const blocks = Array.isArray(message.content) ? message.content : undefined
    if (blocks !== undefined) {
      for (const block of blocks) {
        if (typeof block?.text === "string") {
          if (block.text !== "") parts.push({ text: block.text })
          continue
        }
        if (block?.type === "image_url") {
          const inline = dataUrlOf(block?.image_url?.url)
          if (inline === undefined) {
            throw new Error("Accio: 暂不支持远程图片链接（只支持 base64 data URL）")
          }
          parts.push({ inlineData: inline })
          continue
        }
      }
    }
    if (parts.length > 0) {
      contents.push({ role: "user", parts })
      continue
    }
    const text = textOf(message.content)
    if (text !== "") contents.push({ role: "user", parts: [{ text }] })
  }
  // ⚠ 收尾：末尾一批工具结果的内嵌图片也要落盘（否则永远不发）
  flushPendingImages()
  return { contents, systemInstruction: system.join("\n\n") }
}

export function toAccioTools(tools) {
  const out = []
  for (const tool of tools) {
    const fn = tool?.function
    if (fn === undefined || typeof fn.name !== "string" || fn.name === "") continue
    out.push({
      name: fn.name,
      description: typeof fn.description === "string" ? fn.description : "",
      parametersJson: JSON.stringify(fn.parameters ?? { type: "object", properties: {} }),
    })
  }
  return out.length > 0 ? out : undefined
}

// ── SSE：Accio 帧 → OpenAI chunks ──────────────────────────────────────

/**
 * 工具参数分片合并。
 * 实测形态：首帧无参数、后续帧重复**完整**参数；但增量式也会出现，两种都处理。
 */
export function mergeToolArgs(fragments) {
  const nonEmpty = fragments.filter((f) => f !== "")
  if (nonEmpty.length === 0) return ""
  let cumulative = true
  for (let i = 1; i < nonEmpty.length; i++) {
    if (!nonEmpty[i].startsWith(nonEmpty[i - 1])) { cumulative = false; break }
  }
  if (cumulative) return nonEmpty[nonEmpty.length - 1]
  let merged = ""
  for (const fragment of nonEmpty) {
    merged = fragment.startsWith(merged) ? fragment : merged + fragment
  }
  return merged
}

/** 流内错误帧判据：带 error_code/error_message 且 **error_code !== '200'**（200 是成功哨兵）。 */
export function isErrorFrame(frame) {
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) return false
  const code = frame.error_code ?? frame.errorCode
  const message = frame.error_message ?? frame.errorMessage
  if ((code === undefined || code === "") && (message === undefined || message === "")) return false
  return String(code ?? "") !== "200"
}

/** OpenAI finish_reason 映射（未知一律 stop，不编造成 error）。 */
const finishOf = (reason) => {
  if (reason === "MAX_TOKENS" || reason === "max_tokens") return "length"
  return "stop"
}

/**
 * 消费 Accio SSE → OpenAI chunk 流。
 *
 * 帧形状：`{content:{parts},usage_metadata,finish_reason,turn_complete}` +
 * 流内错误帧 + 顶层 function_call（无 content，工具意图首帧）。
 * ⚠ 工具调用是**分片**到达（首帧只有 id/name，后续帧补 args_json）——
 * 按 id 缓冲、结束时用 mergeToolArgs 合并成一次调用。
 */
export async function* accioSseToOpenAi(body, { model, signal } = {}) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const id = `chatcmpl-accio-${Date.now().toString(36)}`
  const created = Math.floor(Date.now() / 1000)
  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

  let buffer = ""
  let sawAny = false
  let finishReason
  /** 原始 usage：取各键**最大值**（上游多帧重复播报且早期帧偏小）。 */
  const usage = {}
  /** 工具调用缓冲：id → {name, fragments[]}（按首见顺序）。 */
  const calls = new Map()

  const noteUsage = (raw) => {
    const u = typeof raw === "object" && raw !== null ? raw : {}
    const pick = (...keys) => {
      for (const k of keys) {
        const v = u[k]
        if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.trunc(v)
      }
      return undefined
    }
    const pairs = [
      ["prompt_tokens", pick("prompt_token_count", "promptTokenCount")],
      ["completion_tokens", pick("candidates_token_count", "candidatesTokenCount")],
      ["total_tokens", pick("total_token_count", "totalTokenCount")],
      ["reasoning_tokens", pick("thoughts_token_count", "thoughtsTokenCount")],
    ]
    for (const [key, value] of pairs) {
      if (value !== undefined && (usage[key] === undefined || value > usage[key])) usage[key] = value
    }
  }

  const handlePart = function* (part) {
    if (part === null || typeof part !== "object") return
    if (typeof part.text === "string" && part.text !== "") {
      sawAny = true
      // ⚠ thought 标记的 part 是思考内容，映射 reasoning_content（不污染正文）
      yield chunk(part.thought === true ? { reasoning_content: part.text } : { content: part.text })
      return
    }
    const call = part.functionCall ?? part.function_call
    if (call !== null && typeof call === "object") {
      // ⚠ 无名调用也计入 sawAny：上游确实产出了内容（只是不可用），
      // 丢弃后若归零会触发「模型未返回任何内容块」、把 MAX_TOKENS 截断
      // 伪装成空响应。
      sawAny = true
      const callId = typeof call.id === "string" && call.id !== "" ? call.id : `call_${calls.size}`
      const name = typeof call.name === "string" ? call.name : ""
      if (name === "") return // 无名调用整块丢弃（产出无名工具调用会让上游 400）
      const state = calls.get(callId) ?? { name, fragments: [], order: calls.size }
      if (typeof call.args_json === "string" && call.args_json !== "") state.fragments.push(call.args_json)
      else if (typeof call.argsJson === "string" && call.argsJson !== "") state.fragments.push(call.argsJson)
      calls.set(callId, state)
    }
  }

  const handleFrame = function* (frame) {
    if (isErrorFrame(frame)) {
      const code = String(frame.error_code ?? frame.errorCode ?? "")
      const message = String(frame.error_message ?? frame.errorMessage ?? "")
      const detail = [code === "" ? "" : `error_code=${code}`, message].filter((s) => s !== "").join(" ")
      // 402 = 额度/认证失败（token 放错头的典型形态）；其余按通用上游错误
      throw new Error(`Accio: ${code === "402" ? "额度或认证失败" : "上游返回错误帧"}（${detail}）`)
    }
    noteUsage(frame.usage_metadata ?? frame.usageMetadata)
    if (typeof frame.finish_reason === "string" && frame.finish_reason !== "") finishReason = frame.finish_reason
    if (typeof frame.finishReason === "string" && frame.finishReason !== "") finishReason = frame.finishReason
    const content = frame.content
    if (content !== null && typeof content === "object" && Array.isArray(content.parts)) {
      for (const part of content.parts) yield* handlePart(part)
    }
    // ⚠ 顶层 function_call（无 content 信封）是**实测的真实形状** —— 丢弃它
    // = 模型的工具调用凭空消失（「思考一下就中断」的根因之一）。
    const topCall = frame.function_call ?? frame.functionCall
    if (topCall !== null && typeof topCall === "object") yield* handlePart({ function_call: topCall })
  }

  const emitCalls = function* () {
    let index = 0
    for (const [callId, state] of calls) {
      const args = mergeToolArgs(state.fragments)
      yield chunk({
        tool_calls: [{
          index: index++,
          id: callId,
          type: "function",
          function: { name: state.name, arguments: args },
        }],
      })
    }
  }

  const finalize = function* () {
    yield* emitCalls()
    const finish = finishOf(finishReason)
    yield chunk({}, finish)
    if (Object.keys(usage).length > 0) {
      const completion = usage.completion_tokens ?? 0
      const prompt = usage.prompt_tokens ?? 0
      const out = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: usage.total_tokens ?? prompt + completion,
      }
      if (usage.reasoning_tokens !== undefined) out.completion_tokens_details = { reasoning_tokens: usage.reasoning_tokens }
      yield `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage: out })}\n\n`
    }
    yield "data: [DONE]\n\n"
  }

  const processLine = function* (rawLine) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    if (!line.startsWith("data:")) return
    const payload = line.slice(5).trim()
    if (payload === "" || payload === "[DONE]") return
    let frame
    try { frame = JSON.parse(payload) } catch { return }
    yield* handleFrame(frame)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        // ⚠ 上游流以终帧收尾、**没有 [DONE]**；flush 解码器并把余量按整行走一遍
        buffer += decoder.decode()
        if (buffer !== "") {
          for (const line of buffer.split("\n")) yield* processLine(line)
        }
        break
      }
      const piece = decoder.decode(value, { stream: true })
      buffer += piece
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) yield* processLine(line)
      if (signal?.aborted === true) break
    }
  } finally {
    await reader.cancel?.().catch(() => {})
    reader.releaseLock?.()
  }

  if (!sawAny) {
    throw new Error("Accio: 模型未返回任何内容块")
  }
  yield* finalize()
}

export function sseResponse(generator) {
  const encoder = new TextEncoder()
  const iterator = generator[Symbol.asyncIterator]()
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next()
        if (done) controller.close()
        else controller.enqueue(encoder.encode(value))
      } catch (error) {
        controller.error(error)
      }
    },
    async cancel() {
      await iterator.return?.().catch(() => {})
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store" },
  })
}

/** HTTP 错误体的可读 detail（逐字保留服务端原文）。 */
function errorDetail(body) {
  try {
    const data = JSON.parse(body)
    const parts = [
      data.error_code !== undefined ? `error_code=${String(data.error_code)}` : undefined,
      typeof data.error_message === "string" ? data.error_message : undefined,
      data.code !== undefined ? `code=${String(data.code)}` : undefined,
      typeof data.message === "string" ? data.message : undefined,
    ].filter((v) => v !== undefined)
    if (parts.length > 0) return parts.join(" ")
  } catch { /* 非 JSON：原样 */ }
  return body
}

/**
 * 一次对话。
 *
 * @param {object} opts
 * @param {object} opts.credential 当前凭据
 * @param {object} opts.body       OpenAI 形状的请求体
 * @param {string} [opts.model]    对外模型 id（slug）
 * @param {Array}  [opts.index]    slug → modelCode 映射
 * @param {AbortSignal} [opts.signal]
 * @param {(current: object) => Promise<object|undefined>} [opts.renew] 硬续期（失败抛）
 * @returns {Promise<Response>}
 */
export async function chat({ credential, body: openaiBody, model, index, signal, renew, extraHeaders }) {
  const slug = String(openaiBody?.model ?? model ?? "").split("/").filter((s) => s !== "").pop() ?? ""
  const wireModel = codeOf(index, slug)

  const { contents, systemInstruction } = serializeMessages(Array.isArray(openaiBody?.messages) ? openaiBody.messages : [])
  const tools = toAccioTools(Array.isArray(openaiBody?.tools) ? openaiBody.tools : [])
  const requestedMax = Number(openaiBody?.max_tokens ?? openaiBody?.max_completion_tokens)
  const maxOutputTokens = Number.isSafeInteger(requestedMax) && requestedMax > 0 ? requestedMax : 8192
  const stop = Array.isArray(openaiBody?.stop)
    ? openaiBody.stop.filter((s) => typeof s === "string" && s !== "")
    : (typeof openaiBody?.stop === "string" && openaiBody.stop !== "" ? [openaiBody.stop] : [])

  const requestId = requestIdOf()
  const payload = buildBody({
    model: wireModel,
    accessToken: credential.access_token,
    contents,
    systemInstruction,
    tools,
    temperature: typeof openaiBody?.temperature === "number" ? openaiBody.temperature : undefined,
    maxOutputTokens,
    requestId,
  })
  if (systemInstruction !== "") payload.system_instruction = systemInstruction
  else delete payload.system_instruction
  if (stop.length > 0) payload.stop_sequences = stop

  // ⚠ 不要挂硬超时：magpie 的 signal 管取消；30s 会把长对话 / 长思考掐断
  //   （Gyl1219 hub 的 AGENTS §5 真机结论：120s 也会掐断长对话）。
  const send = (cred) => fetchWithRetry(
    () => fetch(`${GATEWAY}${LLM_PATH}?sg_k=${sgKOf(requestId)}`, {
      method: "POST",
      headers: accioHeaders(cred, extraHeaders),
      body: JSON.stringify(payload),
      signal,
    }),
    signal,
  )

  let response = await send(credential)

  // HTTP 401/403：凭据可能被服务端提前撤销而本地 expires_at 未到 —— 续期一次重发。
  // ⚠ token 在 body 里，重发前必须把新 token 写回。
  if ((response.status === 401 || response.status === 403) && typeof renew === "function") {
    const before = tokenFingerprint(credential)
    let renewed
    try {
      renewed = await renew(credential)
    } catch {
      renewed = undefined
    }
    if (renewed !== undefined && tokenFingerprint(renewed) !== before) {
      payload.token = renewed.access_token
      response = await send(renewed)
    }
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    return Response.json(
      { error: { type: "provider_error", message: `Accio 返回 HTTP ${response.status}：${errorDetail(text).slice(0, 300)}` } },
      { status: response.status >= 400 ? response.status : 502 },
    )
  }

  // ⚠⚠ 必须校验 content-type：**HTTP 200 也可能是一张风控拦截页**
  // （缺 utdid 时阿里网关回 200 + text/html，body 是 bixi-intl.alicdn.com/punish
  // 跳转脚本）。不校验会被 SSE 解析器吞掉，症状是「模型不回复」——
  // 真因是风控，排查方向完全错。判 content-type 比判 body 文本稳。
  const contentType = (response.headers.get("content-type") ?? "").toLowerCase()
  if (!contentType.includes("text/event-stream")) {
    const peek = await response.text().catch(() => "")
    return Response.json(
      {
        error: {
          type: "provider_error",
          message: `Accio: 上游未返回事件流（content-type: ${contentType || "(空)"}）——`
            + `通常是被风控拦截（网关返回 200 + HTML 拦截页）。${peek === "" ? "" : ` 服务端原文：${peek.slice(0, 200)}`}`,
        },
      },
      { status: 502 },
    )
  }

  if (payload.stream !== false && openaiBody?.stream !== false) {
    return sseResponse(accioSseToOpenAi(response.body, { model: slug, signal }))
  }

  // 非流式：聚合成一个 chat.completion（上游只有流式端点，这里做汇聚）
  const parts = []
  const toolCalls = []
  let finish = "stop"
  let usage
  for await (const piece of accioSseToOpenAi(response.body, { model: slug, signal })) {
    if (!piece.startsWith("data: ") || piece === "data: [DONE]\n\n") continue
    const chunk = JSON.parse(piece.slice(6))
    const delta = chunk.choices?.[0]?.delta
    if (typeof delta?.content === "string") parts.push(delta.content)
    if (Array.isArray(delta?.tool_calls)) toolCalls.push(...delta.tool_calls)
    if (chunk.choices?.[0]?.finish_reason) finish = chunk.choices[0].finish_reason
    if (chunk.usage) usage = chunk.usage
  }
  const text = parts.join("")
  return Response.json({
    id: `chatcmpl-accio-${Date.now().toString(36)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: slug,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: text,
        ...(toolCalls.length > 0
          ? {
            tool_calls: toolCalls.map((call, index) => ({
              id: call.id ?? `call_${index}`,
              type: "function",
              function: { name: call.function?.name ?? "", arguments: call.function?.arguments ?? "" },
            })),
          }
          : {}),
      },
      finish_reason: finish,
    }],
    ...(usage !== undefined ? { usage } : {}),
  })
}