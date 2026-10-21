# GPT / Codex 重置微信提醒

GitHub Actions 每 15 分钟检查 AIHOT 的公开 Tibo 重置消息，使用 Server酱 Turbo 向个人微信推送。无需服务器、OpenAI API Key 或模型付费调用。

## 配置

1. 在仓库 Settings → Secrets and variables → Actions 添加 `SERVERCHAN_SENDKEY`，值为 Server酱 Turbo 的 SCT SendKey。不要把它写入代码。
2. 将本目录内的 `monitor.mjs`、`package.json`、`tests`、`.github` 和 `README.md` 放到仓库根目录。不能只上传 ZIP，也不能多套一层文件夹。
3. 打开 Actions → **WeChat Reset Monitor** → **Run workflow**，勾选测试消息后运行。
4. 首次运行建立历史基线。收到标明【测试】的微信后即完成接通；后续定时检查不发送例行汇总。

## 识别与覆盖范围

- 来源为 https://aihot.news/api/v1/codex-resets 。这是第三方整理，非 OpenAI 官方接口；程序不会直接核验 X，也不独立核验 AIHOT 的分类。
- 读取关联重置事件的 announce / confirm / amend / cancel 消息，保留原帖、北京时间和未知范围。
- 只有 Tibo 自己正文中的明确英文不确定重置表述，才额外作为“可能”提示。此规则不能理解所有暗示，可能漏报；普通相关回复、社区祈愿和模型预测不会触发。
- 仅覆盖该接口收录的 Tibo 信息，尚未覆盖其他 OpenAI 成员及所有官方渠道。原 Codex 定时监测可以继续作为补充。
- “来源称已完成”不等于自己的账号已到账。具体计划、窗口和资格以原文及账号显示为准。
- 首次运行不推历史；启动之后新发布的消息才触发，留 5 分钟重叠处理采集延迟。接口历史回填不会突然群发。
- 按原帖 ID、动作、原文内容去重。中文翻译变动不重复提醒。

## 状态与费用

- 自动在 `notifier-state` 分支保存哈希去重记录和发送额度。该分支不保存 SendKey 或微信身份信息；不要删除，否则会重新建立基线。
- 同一个 workflow 使用串行并发组，避免两个轮询同时推送。Actions 需要 `contents: write` 才能保存状态。
- 每个北京时间自然日最多自动发 4 次，额外留 1 次手动测试，总计不超过 5 次；其他程序共用 SendKey 的消耗不在本程序统计内。
- 每次汇总最多两条来源更新。达到每日上限后留待次日，不会宣称所有消息都实时送达。
- Server酱免费额度和 GitHub 免费规则可能改变，请查官方说明。公开仓库的标准 Actions 运行器目前免费。
- GitHub 定时任务可能延迟或被跳过；公开仓库 60 天无活动可能暂停。该方案不是即时消息保证服务。

## 故障与测试

源数据超过两小时未采集、结构不兼容或请求失败时，工作流报错，不将失败当作“没有消息”。查看 Actions 红色失败运行可了解原因。

发送前先持久化尝试记录，防止进程中断重复推送。发生超时或推送失败时标记 `delivery_uncertain` 并停止自动重发：请查 Server酱日志确认，必要时手动查看原帖。这样优先避免刷屏，但可能漏收该条消息。手动测试也计入每日请求上限。

本地无需密钥可运行：`npm test`（Node.js 22）。真实发送只在 GitHub Actions 内运行。日志不会输出 SendKey 或包含密钥的请求 URL。

官方文档：
- https://sct.ftqq.com/docs/getting-started/faq/
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- https://docs.github.com/en/actions/concepts/billing-and-usage

本项目不隶属于 OpenAI、AIHOT 或 Server酱；源内容归原作者所有。
