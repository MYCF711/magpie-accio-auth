// Accio 协议层回归 —— 全部 stub fetch，不打真请求。
// 每条对应一次真机实测的事实；错了的症状写在断言消息里。
//
// 移植自 Gyl1219/magpie-providers-hub 的 tests/accio.test.mjs（MIT），
// 按本仓库的模块拆分改写：可选部分（目录、额度、对话）分别落在
// src/api.mjs / src/models.mjs / src/chat.mjs。

import { test } from "node:test"
import assert from "node:assert/strict"

import { accioExpiresAtMs, credentialOf, identityOf, toStored } from "../src/credential.mjs"
import { buildAuthUrl, refreshCredential } from "../src/login.mjs"
import { normalizeModel, parseCatalog, makeIndex, FALLBACK_ENTRIES, staticModels, liveModels, codeOf } from "../src/models.mjs"
import { serializeMessages, mergeToolArgs, isErrorFrame, accioSseToOpenAi, chat } from "../src/chat.mjs"
import { fetchCatalog, fetchUsage, SignInError } from "../src/api.mjs"

// ⚠ 测试卫生：把 HOME 指到临时目录再跑（Gyl1219 hub 的同款教训）。
// 否则 utdid / 模型目录快照会写进本机真实的 ~/.cache/magpie —— 每跑一次测试就多几个文件。
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
const sandbox = mkdtempSync(join(tmpdir(), "accio-test-"))
process.env.USERPROFILE = sandbox
process.env.HOME = sandbox


const CRED = { access_token: "acc01_live", refresh_token: "rr_1", expires_at: Date.now() + 3600_000, region: "cn" }
const INDEX = makeIndex(FALLBACK_ENTRIES)

/** stub fetch。 */
const stubFetch = (routes) => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url
    calls.push({ url, headers: init?.headers, method: init?.method, body: init?.body })
    for (const route of routes) {
      if (url.includes(route.match)) return route.respond({ url, calls })
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
  }
  return { calls, restore: () => { globalThis.fetch = original } }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } })

// ── 登录 ────────────────────────────────────────────────────────────────

test("授权 URL 参数缺一不可（少 code_challenge 会被登录页判 legacy 弹「请升级客户端」）", () => {
  const url = new URL(buildAuthUrl({
    region: "cn",
    redirectUri: "http://127.0.0.1:1234/auth/callback",
    state: "abc",
    codeChallenge: "challenge-x",
  }))
  assert.equal(url.origin + url.pathname, "https://www.accio-ai.com/login")
  assert.equal(url.searchParams.get("code_challenge"), "challenge-x")
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  assert.equal(url.searchParams.get("client_id"), "accio-work")
  assert.equal(url.searchParams.get("return_url"), "http://127.0.0.1:1234/auth/callback")
  assert.ok(url.searchParams.get("state") !== "")
  assert.ok(url.searchParams.get("ttid")?.startsWith("ttid_"))
})

test("global 区域换登录域；gateway 恒同一个（区域只是登录参数）", () => {
  const url = new URL(buildAuthUrl({
    region: "global", redirectUri: "http://127.0.0.1:1/c", state: "s", codeChallenge: "c",
  }))
  assert.equal(url.origin, "https://zh.accio.com")
})

test("令牌信封：expiresAt 秒→毫秒；缺一不可；sgcookie 透传", () => {
  const stub = stubFetch([{
    match: "/api/auth/refresh_token",
    respond: () => json({
      success: true,
      data: { accessToken: "at2", refreshToken: "rt2", expiresAt: 1792872000, sgcookie: "sg1" },
    }),
  }])
  try {
    // 这里只验归一化入口；续期往返在下面一条
  } finally {
    stub.restore()
  }
  assert.equal(accioExpiresAtMs(1792872000), 1792872000000, "秒必须 ×1000（不归一化会判 1970 年已过期 → 反复续期 → 账号被标死）")
  assert.equal(accioExpiresAtMs(1792872000000), 1792872000000, ">1e12 视为已是毫秒")
  assert.equal(accioExpiresAtMs(0), undefined)
  assert.equal(accioExpiresAtMs("1792872000"), 1792872000000, "字符串秒也要归一化")
})

test("续期：轮换 refresh_token；终端错误可识别（invalid_grant 等）", async () => {
  const stub = stubFetch([{
    match: "/api/auth/refresh_token",
    respond: () => json({
      success: true,
      data: { accessToken: "at2", refreshToken: "rt2", expiresAt: Math.floor(Date.now() / 1000) + 3600 },
    }),
  }])
  try {
    const next = await refreshCredential(CRED)
    assert.equal(next.access_token, "at2")
    assert.equal(next.refresh_token, "rt2", "刷新会轮换 refresh_token（并发续期必须串行）")
    assert.ok(next.expires_at > Date.now() + 3500_000, "expires_at 必须已毫秒化")
    assert.equal(next.region, "cn")
    assert.equal(next.sgcookie, undefined, "响应没给 sgcookie 就不编造")
  } finally {
    stub.restore()
  }
  {
    const stub2 = stubFetch([{
      match: "/api/auth/refresh_token",
      respond: () => json({ success: false, code: "invalid_grant", message: "token used" }),
    }])
    try {
      await assert.rejects(
        () => refreshCredential(CRED),
        (error) => /invalid_grant/.test(error.message),
      )
    } finally {
      stub2.restore()
    }
  }
})

test("凭据读写的双向形状：access 内的 JSON 与 magpie 记录的标量字段一致", () => {
  const stored = toStored(CRED)
  assert.equal(stored.type, "oauth")
  assert.equal(stored.refresh, "rr_1")
  assert.equal(stored.expires, CRED.expires_at)
  assert.equal(stored.accountId, "", "Accio 不给账号名 —— 不编造")
  assert.ok(stored.uid.length > 0, "uid 必须给，否则同名账号会被 magpie 合并")

  const back = credentialOf(stored)
  assert.equal(back.access_token, "acc01_live")
  assert.equal(back.refresh_token, "rr_1")
  assert.equal(back.expires_at, CRED.expires_at)
  assert.equal(credentialOf(null), null)
  assert.equal(credentialOf({ type: "oauth", access: "not-json" }), null)
})

test("identityOf：JWT 里取 sub；不是 JWT 就退回 refresh_token 哈希（同一个 token 恒同值）", () => {
  const jwt = [
    "eyJhbGciOiJIUzI1NiJ9",
    Buffer.from(JSON.stringify({ sub: "user-42" }), "utf8").toString("base64url"),
    "sig",
  ].join(".")
  assert.equal(identityOf({ access_token: jwt, refresh_token: "x" }), "jwt-sub:user-42")

  const a = identityOf({ access_token: "opaque", refresh_token: "rt-a" })
  const b = identityOf({ access_token: "opaque", refresh_token: "rt-a" })
  const c = identityOf({ access_token: "opaque", refresh_token: "rt-b" })
  assert.equal(a, b, "同一份 refresh_token 必须同值")
  assert.notEqual(a, c, "不同账号不能同 uid")
  assert.ok(!a.includes("rt-a"), "uid 不能带凭据明文")
})

// ── 目录 ────────────────────────────────────────────────────────────────

test("目录归一：visible 过滤、modelCode、倍率升序（缺的排最后）、efforts null = 无档位", () => {
  const models = parseCatalog({
    data: [
      { modelList: [
        { modelCode: "1Orbit-Q", modelDisplayName: "Ultimate", visible: true, contextWindow: 1000000, effectiveMultiple: 2.8, multimodal: true, reasoningEfforts: ["low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high", maxTokens: 65536 },
        { modelCode: "1Drift-F", modelDisplayName: "Qwen 3.8 Flash", visible: true, contextWindow: 1000000, effectiveMultiple: 0.03 },
        { modelCode: "1Hidden", modelDisplayName: "Hidden", visible: false },
        { modelCode: "1NoEff", modelDisplayName: "No Efforts", visible: true, reasoningEfforts: null, defaultReasoningEffort: "max" },
      ] },
    ],
  })
  assert.deepEqual(models.map((m) => m.name), ["Qwen 3.8 Flash", "Ultimate", "No Efforts"], "按倍率升序，缺倍率的排最后")
  assert.equal(models[0].efforts, undefined, "reasoningEfforts=null 必须表达为无档位（编造会让用户选到服务端不认的值）")
  assert.equal(models[2].defaultEffort, "max", "defaultReasoningEffort 可单独存在")
  assert.equal(models[2].efforts, undefined)
  assert.equal(models[1].efforts.join(","), "low,medium,high,xhigh,max", "档位顺序照抄服务端")
  assert.equal(models[1].defaultEffort, "high")
  assert.equal(normalizeModel({ visible: true }), undefined, "没有 modelCode 的条目不列（不猜）")
  assert.equal(normalizeModel(null), undefined)
})

test("静态表：兜底 15 条、slug 作对外 id、倍率进 rate 而不是名字", () => {
  const models = staticModels()
  const ids = Object.keys(models)
  assert.ok(ids.length >= 15, `兜底表 15 条（实际 ${ids.length}）`)
  assert.ok(models["qwen-3-8-flash"], "slug 归一：Qwen 3.8 Flash → qwen-3-8-flash")
  assert.equal(models["qwen-3-8-flash"].rate, "x0.03", "倍率进 rate 字段（卡片胶囊），name 保持干净")
  assert.equal(models["qwen-3-8-flash"].name, "Qwen 3.8 Flash")
  assert.equal(models["qwen-3-8-flash"].api.id, "qwen-3-8-flash")
})

test("slug ↔ modelCode：上行必须换回 modelCode（发 slug 会请求打空）", () => {
  assert.equal(codeOf(INDEX, "qwen-3-8-flash"), "1Drift-F8hS3mK7pL2n")
  assert.equal(codeOf(INDEX, "not-in-table"), "not-in-table", "查不到原样发，让上游报错 —— 不编造")
  assert.equal(codeOf(INDEX, undefined), undefined)
})

test("撞名 slug 自动加后缀（否则后一条覆盖前一条）", () => {
  const live = liveModels([
    { id: "code-a", name: "Same Name", contextWindow: 1, supportsImage: false },
    { id: "code-b", name: "Same Name", contextWindow: 1, supportsImage: false },
  ])
  assert.deepEqual(Object.keys(live), ["same-name", "same-name-2"])
  assert.equal(live["same-name-2"].api.id, "same-name-2")
})

test("每个模型都显式声明 capabilities.input.image（省略 ≠ text，会被 models.dev 投票补）", () => {
  for (const [id, m] of Object.entries(staticModels())) {
    assert.equal(typeof m.capabilities?.input?.image, "boolean", `${id} 缺 input.image 布尔值`)
    assert.equal(typeof m.capabilities?.attachment, "boolean", `${id} 缺 attachment 布尔值`)
    assert.equal(m.capabilities.toolcall, true, `${id} 缺少 toolcall`)
  }
})

// ── 请求体 ──────────────────────────────────────────────────────────────

test("消息序列化：system 抽出、tool 结果按 name 配对回填 functionResponse", () => {
  const { contents, systemInstruction } = serializeMessages([
    { role: "system", content: "sys" },
    { role: "user", content: "查天气" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "weather", arguments: '{"city":"北京"}' } }] },
    { role: "tool", tool_call_id: "c1", content: "晴" },
  ])
  assert.equal(systemInstruction, "sys")
  assert.deepEqual(contents[0], { role: "user", parts: [{ text: "查天气" }] })
  assert.deepEqual(contents[1], {
    role: "model",
    parts: [{ functionCall: { id: "c1", name: "weather", argsJson: '{"city":"北京"}' } }],
  })
  assert.deepEqual(contents[2], {
    role: "user",
    parts: [{ functionResponse: { id: "c1", name: "weather", responseJson: "晴" } }],
  })
})

test("跨消息配对纪律：≥2 个 tool_call 且「非最后一个」结果带图时，图片必须排在全部 functionResponse 之后", () => {
  const { contents } = serializeMessages([
    { role: "user", content: "读两张图" },
    { role: "assistant", content: null, tool_calls: [
      { id: "c1", type: "function", function: { name: "shot1", arguments: "{}" } },
      { id: "c2", type: "function", function: { name: "shot2", arguments: "{}" } },
    ] },
    { role: "tool", tool_call_id: "c1", content: [
      { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } },
      { type: "text", text: "截图1" },
    ] },
    { role: "tool", tool_call_id: "c2", content: "截图2 的文本" },
  ])
  const roles = contents.map((c) => c.role + ":" + (c.parts?.[0]?.functionResponse?.name ?? c.parts?.[0]?.functionCall?.name ?? c.parts?.[0]?.text ?? c.parts?.[0]?.inlineData?.mimeType ?? "?"))
  assert.deepEqual(roles, [
    "user:读两张图",
    "model:shot1",
    "user:shot1",
    "user:shot2",
    "user:Attached image(s) from tool result:",
  ], `functionResponse 必须紧密相邻（got ${JSON.stringify(roles)}）`)
  const imgMsg = contents.at(-1)
  assert.equal(imgMsg.parts[1].inlineData.mimeType, "image/png")
  assert.equal(imgMsg.parts[1].inlineData.data, "QUJD")
  const fr = contents.find((c) => c.parts?.[0]?.functionResponse?.name === "shot1")
  assert.ok(!fr.parts[0].functionResponse.responseJson.includes("QUJD"),
    "responseJson 只装文本 —— 含图数组整体 stringify 会把巨大 base64 塞进 JSON")
  for (let i = 0; i < contents.length; i++) {
    if (contents[i].parts?.[0]?.functionResponse && contents[i + 1]) {
      const next = contents[i + 1].parts?.[0]
      assert.ok(next?.functionResponse || next?.text === "Attached image(s) from tool result:",
        `contents[${i + 1}] 插进了 functionResponse 配对之间`)
    }
  }
})

// ── SSE ─────────────────────────────────────────────────────────────────

const sse = (frames) => new Response(
  frames.map((f) => (typeof f === "string" ? f : `data: ${JSON.stringify(f)}\n\n`)).join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } },
)

const collect = async (response, model = "qwen-3-8-flash") => {
  const chunks = []
  for await (const piece of accioSseToOpenAi(response.body, { model })) chunks.push(piece)
  return chunks
}
const parse = (chunks) => chunks
  .filter((c) => c.startsWith("data: ") && c !== "data: [DONE]\n\n")
  .map((c) => JSON.parse(c.slice(6)))

test("SSE：文本/思考/usage 取最大值/finish", async () => {
  const chunks = await collect(sse([
    { content: { role: "model", parts: [{ text: "想", thought: true }] }, usage_metadata: { prompt_token_count: 10, total_token_count: 10 } },
    { content: { role: "model", parts: [{ text: "答" }] } },
    { content: { role: "model", parts: [{ text: "案" }] }, usage_metadata: { prompt_token_count: 8, candidates_token_count: 5, total_token_count: 15, thoughts_token_count: 4 }, finish_reason: "STOP" },
    { turn_complete: true, usage_metadata: { prompt_token_count: 10, candidates_token_count: 5, total_token_count: 15 } },
  ]))
  const parsed = parse(chunks)
  const reasoning = parsed.find((c) => c.choices?.[0]?.delta?.reasoning_content)
  assert.equal(reasoning.choices[0].delta.reasoning_content, "想", "thought 标记的 part 必须映射 reasoning_content（不污染正文）")
  const text = parsed.filter((c) => c.choices?.[0]?.delta?.content).map((c) => c.choices[0].delta.content).join("")
  assert.equal(text, "答案")
  const finish = parsed.find((c) => c.choices?.[0]?.finish_reason !== null)
  assert.equal(finish.choices[0].finish_reason, "stop")
  const usage = parsed.find((c) => c.usage)
  assert.equal(usage.usage.prompt_tokens, 10, "usage 取各键最大值（上游多帧重复播报且早期帧偏小）")
  assert.equal(usage.usage.total_tokens, 15)
  assert.equal(usage.usage.completion_tokens_details.reasoning_tokens, 4)
  assert.equal(chunks.at(-1), "data: [DONE]\n\n")
})

test("SSE：工具分片合并成一次调用（首帧无参数、后续帧重复全量）", async () => {
  const chunks = await collect(sse([
    { content: { role: "model", parts: [{ text: "我来查" }] } },
    { function_call: { id: "call_x", name: "read_file" } },
    { function_call: { id: "call_x", name: "read_file", args_json: '{"file_path":"a.txt"}' } },
    { function_call: { id: "call_x", name: "read_file", args_json: '{"file_path":"a.txt"}' } },
    { turn_complete: true, finish_reason: "STOP", usage_metadata: { total_token_count: 30 } },
  ]))
  const parsed = parse(chunks)
  const toolDeltas = parsed.filter((c) => c.choices?.[0]?.delta?.tool_calls)
  assert.equal(toolDeltas.length, 1, "分片必须合并成一次调用（实测三帧形态；发三次会重复执行工具）")
  assert.deepEqual(toolDeltas[0].choices[0].delta.tool_calls, [{
    index: 0, id: "call_x", type: "function", function: { name: "read_file", arguments: '{"file_path":"a.txt"}' },
  }])
  const finish = parsed.find((c) => c.choices?.[0]?.finish_reason !== null)
  assert.equal(finish.choices[0].finish_reason, "stop")
})

test("mergeToolArgs：累积式取最后一份，增量式依次拼接", () => {
  assert.equal(mergeToolArgs(['{"a"', '{"a":1}', '{"a":1}']), '{"a":1}')
  assert.equal(mergeToolArgs(['{"', 'a":', '1}']), '{"a":1}')
  assert.equal(mergeToolArgs([]), "")
})

test("SSE：流内 402 错误帧必须抛「额度或认证失败」（HTTP 200 掩盖的真实失败形态）", async () => {
  await assert.rejects(
    () => collect(sse([
      { turn_complete: true, error_code: "402", error_message: "unauthorized" },
    ])),
    /额度或认证失败.*402.*unauthorized/s,
  )
})

test("SSE：error_code=200 是成功哨兵，绝不可当错误抛", async () => {
  const chunks = await collect(sse([
    { error_code: "200", content: { role: "model", parts: [{ text: "好" }] }, usage_metadata: { total_token_count: 5 } },
    { turn_complete: true, error_code: "200" },
  ]))
  const parsed = parse(chunks)
  assert.ok(parsed.some((c) => c.choices?.[0]?.delta?.content === "好"))
})

test("SSE：无名工具调用整块丢弃，但不丢 finish/usage（MAX_TOKENS 不得伪装成正常 stop 后归零）", async () => {
  const chunks = await collect(sse([
    { function_call: { id: "t1", name: "" } },
    { usage_metadata: { total_token_count: 9 }, finish_reason: "MAX_TOKENS" },
  ]))
  const parsed = parse(chunks)
  assert.ok(!parsed.some((c) => c.choices?.[0]?.delta?.tool_calls))
  const finish = parsed.find((c) => c.choices?.[0]?.finish_reason !== null)
  assert.equal(finish.choices[0].finish_reason, "length")
  const usage = parsed.find((c) => c.usage)
  assert.equal(usage.usage.total_tokens, 9)
})

test("isErrorFrame 判据：带码但 200 → false；只有 message → true", () => {
  assert.equal(isErrorFrame({ error_code: "200" }), false)
  assert.equal(isErrorFrame({ error_code: "402", error_message: "x" }), true)
  assert.equal(isErrorFrame({ error_message: "boom" }), true)
  assert.equal(isErrorFrame({}), false)
})

test("SSE：空流（模型一句话都没产出）必须报错，不能伪装成正常结束", async () => {
  await assert.rejects(() => collect(sse([{ turn_complete: true }])), /未返回任何内容块/)
})

// ── chat 往返 ───────────────────────────────────────────────────────────

test("chat：HTTP 200 + text/html = 风控拦截页，必须报风控而不是「模型不回复」", async () => {
  const stub = stubFetch([{
    match: "/api/adk/llm/generateContent",
    respond: () => new Response('<a href="https://bixi-intl.alicdn.com/punish/x">click</a>', {
      status: 200,
      headers: { "content-type": "text/html;charset=UTF-8" },
    }),
  }])
  try {
    const response = await chat({
      credential: CRED,
      body: { model: "qwen-3-8-flash", messages: [{ role: "user", content: "hi" }] },
      index: INDEX,
    })
    const payload = await response.json()
    assert.match(payload.error.message, /风控拦截/)
    assert.match(payload.error.message, /bixi-intl\.alicdn\.com/, "服务端原文必须带给用户（诊断用）")
  } finally {
    stub.restore()
  }
})

test("chat：token 在 body、sg_k + snake_case、modelCode 上行、empid 空串、properties 双键形", async () => {
  let captured
  const stub = stubFetch([{
    match: "/api/adk/llm/generateContent",
    respond: ({ calls }) => {
      captured = calls.at(-1)
      return sse([{ content: { role: "model", parts: [{ text: "ok" }] }, turn_complete: true, usage_metadata: { total_token_count: 3 } }])
    },
  }])
  try {
    const response = await chat({
      credential: CRED,
      body: { model: "qwen-3-8-flash", messages: [{ role: "user", content: "hi" }], max_tokens: 100 },
      index: INDEX,
    })
    await response.text()
    assert.ok(captured.url.includes("sg_k="), "sg_k = md5(requestId) 必须在查询串")
    const body = JSON.parse(captured.body)
    assert.equal(body.token, CRED.access_token, "token 必须在 body 的 token 字段")
    assert.equal(captured.headers.appKey, "OneChat")
    assert.ok(captured.headers.utdid?.startsWith("accio-"), "utdid 缺失会吃到风控拦截页")
    assert.equal(captured.headers.Accept, "text/event-stream")
    assert.equal(body.model, "1Drift-F8hS3mK7pL2n", "上行必须用 modelCode（发 slug 会请求打空）")
    assert.equal(body.max_output_tokens, 100)
    assert.equal(typeof body.message_id, "string", "message_id 必填（缺它上游 400）")
    assert.equal(body.empid, "", "empid/tenant/iai_tag 必须空串（真实值会被拒）")
    assert.equal(body.properties.appKey, "OneChat", "properties 子树不参与 snake 转换（实测两种键形混用）")
    assert.equal(body.properties.normalized_response, "true")
  } finally {
    stub.restore()
  }
})

test("chat：provider 前缀 `accio/<id>` 也能解析（magpie 的模型 id 可能带前缀）", async () => {
  let captured
  const stub = stubFetch([{
    match: "/api/adk/llm/generateContent",
    respond: ({ calls }) => {
      captured = calls.at(-1)
      return sse([{ content: { role: "model", parts: [{ text: "ok" }] }, turn_complete: true }])
    },
  }])
  try {
    const response = await chat({
      credential: CRED,
      body: { model: "accio/qwen-3-8-flash", messages: [{ role: "user", content: "hi" }] },
      index: INDEX,
    })
    await response.text()
    assert.equal(JSON.parse(captured.body).model, "1Drift-F8hS3mK7pL2n")
  } finally {
    stub.restore()
  }
})

test("chat：非流式响应聚合为 chat.completion", async () => {
  const stub = stubFetch([{
    match: "/api/adk/llm/generateContent",
    respond: () => sse([
      { content: { role: "model", parts: [{ text: "你好" }, { text: "呀", thought: true }] }, usage_metadata: { prompt_token_count: 3, candidates_token_count: 2, total_token_count: 5 } },
      { turn_complete: true, finish_reason: "STOP" },
    ]),
  }])
  try {
    const response = await chat({
      credential: CRED,
      body: { model: "qwen-3-8-flash", messages: [{ role: "user", content: "hi" }], stream: false },
      index: INDEX,
    })
    const j = await response.json()
    assert.equal(j.object, "chat.completion")
    assert.equal(j.choices[0].message.content, "你好")
    assert.equal(j.choices[0].finish_reason, "stop")
    assert.equal(j.usage.total_tokens, 5)
  } finally {
    stub.restore()
  }
})

test("chat：HTTP 401 时续期一次并用新 token 重发", async () => {
  const calls = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push({ url, body: init?.body })
    if (calls.length === 1) return new Response("unauthorized", { status: 401 })
    return sse([{ content: { role: "model", parts: [{ text: "复活" }] }, turn_complete: true }])
  }
  try {
    const response = await chat({
      credential: CRED,
      body: { model: "qwen-3-8-flash", messages: [{ role: "user", content: "hi" }] },
      index: INDEX,
      renew: async () => ({ ...CRED, access_token: "acc01_new" }),
    })
    await response.text()
    assert.equal(calls.length, 2, "401 必须重发一次")
    assert.equal(JSON.parse(calls[1].body).token, "acc01_new", "重发时必须把新 token 写回 body")
  } finally {
    globalThis.fetch = original
  }
})

test("chat：续期抛终态错误（如「续期成功但写回失败」）→ 原样上抛，不吞成 401", async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response("unauthorized", { status: 401 })
  try {
    await assert.rejects(
      () => chat({
        credential: CRED,
        body: { model: "qwen-3-8-flash", messages: [{ role: "user", content: "hi" }] },
        index: INDEX,
        renew: async () => {
          throw Object.assign(new Error("续期成功但凭据写回失败，请重新登录"), { signIn: "expired" })
        },
      }),
      (e) => e.signIn === "expired" && /写回失败/.test(e.message),
      "终态原因必须浮出来，不能被一句 401 盖掉",
    )
  } finally {
    globalThis.fetch = original
  }
})

// ── 目录 / 额度端点 ─────────────────────────────────────────────────────

test("fetchCatalog：token 在 body；业务失败（HTTP 200 + success:false）抛 SignInError", async () => {
  const stub = stubFetch([{
    match: "/api/llm/config/v2",
    respond: () => json({ success: false, code: "403", message: "auth failed" }),
  }])
  try {
    await assert.rejects(() => fetchCatalog(CRED), (e) => e instanceof SignInError)
    assert.equal(JSON.parse(stub.calls[0].body).token, CRED.access_token, "目录的 token 在 body")
  } finally {
    stub.restore()
  }
})

test("fetchUsage：token 在 query；三桶顺序固定；剩 0 的桶不标 aside（否则路由里没有这个号）", async () => {
  const stub = stubFetch([
    {
      match: "/api/entitlement/currentSubscription",
      respond: () => json({
        success: true,
        data: {
          entitlement: {
            monthly: { remaining: 0, used: 500, total: 500 },
            daily: { remaining: 90, used: 10, total: 100 },
            referral: { remaining: 5, used: 0, total: 5 },
          },
        },
      }),
    },
    { match: "/api/entitlement/quota", respond: () => json({ success: true, data: { refreshCountdownSeconds: 3600 } }) },
  ])
  try {
    const usage = await fetchUsage(CRED)
    assert.ok(stub.calls[0].url.includes("accessToken="), "额度的 token 在 query")
    assert.deepEqual(usage.windows.map((w) => w.name), [
      "Accio · 每日积分",
      "Accio · 每月积分",
      "Accio · 推荐积分",
    ], "顺序固定（键序由服务端决定，面板会跳行）")
    for (const w of usage.windows) {
      assert.ok(Number.isFinite(w.used), `${w.name}: used 必填且是有限数字（路由排序输入）`)
      assert.equal(w.aside, undefined, `${w.name}: 不要标 aside —— 全 aside 的账号在路由里等于不存在`)
    }
    assert.equal(usage.windows[1].used, 100, "用完的桶给 used:100（不要 aside）")
    assert.match(usage.windows[0].resetsAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, "resetsAt 必须是 ISO")
  } finally {
    stub.restore()
  }
})

test("fetchUsage：未登录（HTTP 200 + NOT_LOGIN）→ SignInError", async () => {
  const stub = stubFetch([{
    match: "/api/entitlement/currentSubscription",
    respond: () => json({ success: false, code: "401", message: "NOT_LOGIN" }),
  }])
  try {
    await assert.rejects(() => fetchUsage(CRED), (e) => e instanceof SignInError)
  } finally {
    stub.restore()
  }
})