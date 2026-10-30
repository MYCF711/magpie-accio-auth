// 本机客户端导入（src/desktop.mjs）的可测部分：
//   - 数据目录从 APPDATA 惰性解析（测试改 env 必须立即生效）
//   - 没有客户端时 hasDesktopLogin = false、importDesktopLogin = null
// 真实解密依赖本机 DPAPI，不在这里测（在真机验证，见 docs/internals.md §12.5）。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sandbox = mkdtempSync(join(tmpdir(), "accio-desktop-"))

const { desktopDataDir, hasDesktopApp, hasDesktopLogin, importDesktopLogin, waitForDesktopLogin } = await import("../src/desktop.mjs")

test("desktopDataDir：跟着 APPDATA 走（惰性求值，不在模块加载时固化）", () => {
  const old = process.env.APPDATA
  try {
    process.env.APPDATA = join(sandbox, "RoamingA")
    assert.equal(desktopDataDir(), join(sandbox, "RoamingA", "Accio"))
    process.env.APPDATA = join(sandbox, "RoamingB")
    assert.equal(desktopDataDir(), join(sandbox, "RoamingB", "Accio"))
  } finally {
    process.env.APPDATA = old
  }
})

test("没有客户端：hasDesktopLogin false、importDesktopLogin null（不抛）", () => {
  const old = process.env.APPDATA
  try {
    process.env.APPDATA = join(sandbox, "empty")
    assert.equal(hasDesktopLogin(), false)
    assert.equal(importDesktopLogin(), null)
  } finally {
    process.env.APPDATA = old
  }
})

test("hasDesktopApp：装了但没登录也认得出（与 hasDesktopLogin 分开）", () => {
  const oldA = process.env.APPDATA
  const oldL = process.env.LOCALAPPDATA
  try {
    process.env.APPDATA = join(sandbox, "RoamingNoApp")
    process.env.LOCALAPPDATA = join(sandbox, "LocalNoApp")
    assert.equal(hasDesktopApp(), false)
    mkdirSync(join(sandbox, "LocalNoApp", "Accio"), { recursive: true })
    assert.equal(hasDesktopApp(), true, "安装目录在 = 装过客户端")
    assert.equal(hasDesktopLogin(), false, "没登录 ⇒ credentials.enc 不在")
  } finally {
    process.env.APPDATA = oldA
    process.env.LOCALAPPDATA = oldL
  }
})

// ── waitForDesktopLogin：「装了客户端但还没登录 → 装好登录」那条等待 ──────

test("waitForDesktopLogin：客户端已经登录好 → 立刻返回 true，不睡", async () => {
  let sleeps = 0
  const ok = await waitForDesktopLogin({
    timeoutMs: 10_000,
    probe: () => true,
    sleep: async () => { sleeps += 1 },
  })
  assert.equal(ok, true)
  assert.equal(sleeps, 0)
})

test("waitForDesktopLogin：超时返回 false（由调用方给「再点一次」的文案）", async () => {
  let now = 0
  let sleeps = 0
  const ok = await waitForDesktopLogin({
    timeoutMs: 10_000,
    intervalMs: 3000,
    probe: () => false,
    now: () => now,
    // 每次「睡」把注入的时钟推进 intervalMs
    sleep: async (ms) => { sleeps += 1; now += ms },
  })
  assert.equal(ok, false)
  assert.ok(sleeps >= 3, "应该按间隔轮询，而不是死等")
})

test("waitForDesktopLogin：探针抛错时继续等，不崩", async () => {
  let n = 0
  const ok = await waitForDesktopLogin({
    timeoutMs: 10_000,
    intervalMs: 10,
    probe: () => {
      n += 1
      if (n < 3) throw new Error("文件读到一半")
      return true
    },
    sleep: async () => {},
  })
  assert.equal(ok, true)
  assert.equal(n, 3)
})
