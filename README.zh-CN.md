# Codex Credit Stats

[English](README.md) · 简体中文 · [日本語](README.ja.md)

![Codex Credit Stats 页面预览](docs/dashboard-preview.jpg)

Codex Credit Stats 是一个本地网页工具，用于根据你的实际使用情况估算 Codex 周限额。它会显示每个使用周期的预估周限额、每日 credits 使用量、当前窗口剩余 credits，以及常见套餐的参考额度。

## 安装

需要 Node.js 20 或更高版本。

```bash
git clone https://github.com/szguicheng/codex-credit-stats.git
cd codex-credit-stats
npm install
npm start
```

工具会在浏览器中打开本地页面。点击“连接 ChatGPT 并刷新”；如果尚未登录，请在打开的浏览器窗口中完成 ChatGPT 登录。

## 用途

这个工具用于帮助你了解当前使用习惯对应的 Codex 周限额。页面会显示：

- 每个七天使用周期的预估周限额；
- 用横向散点连线图对比不同周期；
- 已使用 credits 总计和每日使用明细；
- 当前窗口剩余比例和预估剩余 credits；
- Pro 20x、Pro 5x 和 Plus 套餐的参考额度。

## 工作逻辑

1. 启动本地网页工具，并通过浏览器连接 ChatGPT。
2. ChatGPT 完成认证后，工具从 analytics 页面取得每日使用总量。
3. 工具将每日总量与本地 Codex session 使用记录结合起来。
4. 以历史额度更新点为边界，向前按七天划分周期；从最近一次更新到当前日期的部分作为当前周期。
5. 估算每个周期对应的周限额，并在页面中展示结果。

## 它会读取哪些信息

工具会读取两类个人信息：

1. **ChatGPT analytics 使用数据** —— ChatGPT analytics 页面返回的每日 Codex credits 使用总量。如果 analytics 返回了套餐名称，也只会用于可选的参考对比。
2. **本地 Codex session 使用数据** —— 本地 Codex session 文件中记录的使用比例和重置时间，通常位于 `~/.codex/sessions`。

这两项信息用于计算预估周限额和当前窗口剩余 credits。
