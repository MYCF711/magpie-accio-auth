import io

# ── internals §12.7 ──
p = 'docs/internals.md'
s = open(p, encoding='utf-8').read().replace('\r\n', '\n')
s += '''

### 12.7 内置验证码登录（headless，0.1.5）

`src/headless.mjs`：后台 `msedge --headless=new` + CDP 完成登录页，**没有可见窗口**。

流程（每一步都实测）：

1. `Emulation.setDeviceMetricsOverride` 设为 1440×900 —— 默认 800×600 布局不同，按钮位置会变。
2. 切「邮箱登录」tab（手机号是默认 tab，不用切）。
3. **逐字** `Input.dispatchKeyEvent`（keyDown → char → keyUp）：React 受控输入不认 `value=` 赋值。
4. **必须勾协议**（`input.ant-checkbox-input`）—— 不勾时点「登录」静默无响应，没有请求也没有提示。
5. 点 `button.submitButton--…`（登录）。
6. 点「发送验证码」→ 弹 **NC 滑块**（`#nc_1_n1z`，`baxia-dialog-content` iframe 内）。
7. 过滑块：起手停 0.3s → 按下停 0.35s → 40 步 × 18ms 匀速（y ±0.5px 抖动）→ 停 0.38s → 松手。
8. 滑块通过后页面到「输入验证码」页；`method: "code"` 让 magpie 弹输入框。
9. `callback(code)` 里把码填进页面 → 点「继续」→ 页面跳回 `beginLogin()` 的 loopback → 换 token。

真机证据（2026-10-29 13:00 的一次完整成功）：

```
7) after submit: 登录 | … | 发送验证码 | …
8) send-code: {"x":970,"y":421}
9) after send: … 发送验证码页 …
10) punish: yes
11) geo: {"handle":{"x":62,"y":202,"w":42,"h":30},"track":{"x":60,"y":200,"w":300,"h":34}}
14) final: … | 请输入发送至此邮箱的验证码。如未收到，请检查垃圾邮件/垃圾箱。 | 输入验证码 | 59秒后重新发送 | 继 续 | … | 发送成功
```

⚠ **限流**：同一出口 IP 连续多次「发送验证码」后，服务端会静默拒绝（页面停在发送页、不报错）。
连续测试时每轮换邮箱也没用 —— 限的是 IP。真实用户一次登录不受影响。

⚠ 无头浏览器启动用 `--remote-debugging-port=0`，从 stderr 的 `DevTools listening on ws://127.0.0.1:<port>/` 读端口；
自己猜端口（9300+随机）在 Windows 上会撞保留端口段，起不来且不报原因。
'''
open(p, 'w', encoding='utf-8', newline='\n').write(s)

# ── README 功能行 ──
p = 'README.md'
s = open(p, encoding='utf-8').read().replace('\r\n', '\n')
old = '- **装了 Windows 客户端的话，可以免登录导入**'
new = '- **内置验证码登录（不弹浏览器）** —— 填手机号/邮箱 → 收验证码 → 填进来就登好；登录页在后台 headless 完成，不会弹窗口。\n- **装了 Windows 客户端的话，可以免登录导入**'
if '内置验证码登录（不弹浏览器）** —— 填手机号' not in s:
    assert old in s
    s = s.replace(old, new, 1)
open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('internals + readme ok')
