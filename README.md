# codex-credit-stats

这是一个跨 macOS、Windows 和 Linux 的 localhost Web 工具。它不再需要 Electron、
DMG 或 Windows 安装包：Node 服务读取本地 Codex session，浏览器打开统计页面。

## 启动

```bash
npm install
npm start
```

`npm start` 会：

1. 启动只绑定到 `127.0.0.1` 的本地 HTTP 服务；
2. 自动打开系统默认浏览器中的统计页面；
3. 点击页面里的“连接 ChatGPT 并刷新”；
4. 在弹出的 Chrome/Edge 专用窗口中完成 ChatGPT 登录；
5. 登录完成后自动回到 analytics 请求，统计结果通过 localhost 的 SSE 事件回到页面。

也可以不自动打开浏览器：

```bash
node server.mjs --no-open --port=4317
```

然后访问终端打印的 localhost 地址。服务默认只监听 `127.0.0.1`，不会暴露到局域网。

## 登录边界

localhost 网页不能直接读取 `chatgpt.com` 的 HttpOnly cookie，也不能因为同属一台
机器就跨站复制 cookie。当前实现采用更安全的方式：Node 服务启动一个独立且持久化的
Chrome/Edge profile，并通过本机 DevTools 连接监听页面实际收到的 analytics response。

第一次登录后，登录状态会保存在这个浏览器 profile 中；后续刷新复用该 profile。程序
不会读取、打印或把密码、OTP、Authorization 或原始 cookie 传回 localhost，只把
analytics 日汇总和计算后的报告传给 localhost 页面。

未登录时，外部浏览器会停在 ChatGPT 首页等待登录，localhost 页面显示等待状态；
只有检测到登录后的页面状态才会导航到 Codex analytics，因此不会在未登录时反复
重定向。这个设计也与 OpenAI 官方对浏览器状态的说明一致：浏览器登录状态属于
具体浏览器 profile，需要使用现有 profile 时应通过浏览器扩展或对应浏览器状态，而
不是从普通网页跨站读取 cookie。

如果系统没有 Chrome 或 Edge，工具可以打开系统默认浏览器，但无法自动监听 response；
要完成自动统计，需要安装 Chrome/Edge。未来如果希望直接复用用户日常 Chrome 已登录
profile，可以再增加一个明确授权的浏览器扩展方案。

## 计算内容

页面自动显示：

- 以最近一次 weekly 额度更新为锚点，向前按 7 天切分的每个周期周限额估计；
- 横向散点连线图、取整范围和周期明细；
- 已使用 credits 总计，并附逐日使用明细；
- 当前窗口剩余比例、已使用比例、估算剩余 credits 和下一次更新时间；
- Pro 20x、Pro 5x、Plus 的静态参考额度；
- 如果 analytics 页面能识别具体套餐，则显示最近周期估计占参考额度的百分比。

用户不需要填写日期、时区、sessions 路径，也不需要导入 JSON。服务内部自动读取：

```text
~/.codex/sessions/**/*.jsonl
```

网页接口按日读取 `totals.credits`（兼容 `total.credits`），本地 session 读取 weekly
`rate_limits.primary.used_percent` 和 `resets_at`。估算公式为：

```text
weekly_limit ≈ cycle_credits / (used_percent / 100)
```

套餐参考值：

```text
Pro 20x ≈ 60,000 credits/week
Pro 5x  ≈ 15,000 credits/week
Plus    ≈  3,000 credits/week
```

## npm 入口

发布后可以直接使用：

```bash
npx codex-credit-stats
```

命令行版仍保留：

```bash
npx codex-credit-stats-cli --help
```

核心解析和计算位于 `src/index.mjs`，外部浏览器认证和 response 捕获位于
`src/browser-capture.mjs`，localhost 服务位于 `server.mjs`。
