// 本机客户端导入（src/desktop.mjs）的可测部分：
//   - 数据目录从 APPDATA 惰性解析（测试改 env 必须立即生效）
//   - 没有客户端时 hasDesktopLogin = false、importDesktopLogin = null
// 真实解密依赖本机 DPAPI，不在这里测（在真机验证，见 docs/internals.md §12.5）。

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sandbox = mkdtempSync(join(tmpdir(), "accio-desktop-"))

const { desktopDataDir, hasDesktopLogin, importDesktopLogin } = await import("../src/desktop.mjs")

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
