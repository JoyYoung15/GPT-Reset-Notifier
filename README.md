# GPT / Codex 重置微信与飞书提醒

Cloudflare 定时器每 5 分钟启动 GitHub Actions，检查 AIHOT 的公开 Tibo 重置消息，使用 Server酱 Turbo 向个人微信推送，并可同时通过自定义机器人推送到飞书群。原 GitHub cron 保留作为后备。无需电脑开机、OpenAI API Key 或模型付费调用；采集和运行可能延迟，不保证即时送达。

## 飞书接入

支持公司群和个人群同时接收。公司群保留 `FEISHU_WEBHOOK_URL`、`FEISHU_SIGNING_SECRET`；个人群新增 `FEISHU_PERSONAL_WEBHOOK_URL`、`FEISHU_PERSONAL_SIGNING_SECRET`。个人群使用独立 `.feishu-personal-state.json`，首次接入不补发历史；三个渠道共用本轮消息源快照，每个渠道分别去重、计算每日限额。某一渠道失败仍会继续检查其他渠道。

测试个人群时，只勾选 `send_feishu_personal_test`（“只向个人飞书群发送一条测试消息”），微信测试和公司群测试均保持关闭。Cloudflare 定时运行不启用任何测试开关。

在接收群创建自定义机器人并启用签名校验，在本仓库 Actions secrets 保存 `FEISHU_WEBHOOK_URL` 和 `FEISHU_SIGNING_SECRET`。无需修改 Cloudflare。两项均未配置时跳过飞书；只配置一项会报错。

飞书使用 `notifier-state` 分支中的 `.feishu-state.json`，与微信记录独立。首次运行建立历史基线，不补发历史；两渠道互不消耗发送额度，单个渠道失败不阻止另一个渠道尝试。同一频道发送不确定时抑制自动重试，避免重复提醒。每个渠道每日最多 4 次自动推送，另留 1 次手动测试。

Actions → WeChat Reset Monitor → Run workflow 中勾选“发送一条标明为测试的飞书消息”，保持微信测试不勾选。飞书 API 接受后仍应在群内确认收到。没有新消息时，两个渠道都不发送例行汇总。运行名称 `Cloudflare check ...` 及日志中的 `cloudflare_scheduled_at` 可用于核对自动触发。

## 配置

1. 在仓库 Settings → Secrets and variables → Actions 添加 `SERVERCHAN_SENDKEY`，值为 Server酱 Turbo 的 SCT SendKey。不要把它写入代码。
2. 将本目录内的 `monitor.mjs`、`feishu.mjs`、`source.mjs`、`source-request.mjs`、`state-request.mjs`、`serverchan.mjs`、`package.json`、`tests`、`.github` 和 `README.md` 放到仓库根目录。不能只上传 ZIP，也不能多套一层文件夹。
3. 打开 Actions → **WeChat Reset Monitor** → **Run workflow**，勾选测试消息后运行。
4. 首次运行建立历史基线。收到标明【测试】的微信后即完成接通；后续定时检查不发送例行汇总。

## 识别与覆盖范围

- 来源为 https://aihot.news/api/v1/codex-resets 。这是第三方整理，非 OpenAI 官方接口；程序不会直接核验 X，也不独立核验 AIHOT 的分类。
- 读取关联重置事件的 announce / confirm / amend / cancel 消息，保留原帖、北京时间和未知范围。
- 只有 Tibo 自己正文中的明确英文不确定重置表述，才额外作为“可能”提示。此规则不能理解所有暗示，可能漏报；普通相关回复、社区祈愿和模型预测不会触发。
- 仅覆盖该接口收录的 Tibo 信息，尚未覆盖其他 OpenAI 成员及所有官方渠道。原 Codex 对话定时监测已停止。
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

如果运行显示 `startup_failure` 且没有 job，先查看 Summary → Annotations 和 [GitHub 服务状态](https://www.githubstatus.com/)。这是工作流启动阶段的问题，监测脚本中的重试尚未运行。Cloudflare 触发被接受不代表 Actions 已成功执行；需要核对后续运行和具体步骤。查询运行历史时要分页读取时间范围内的全部运行，不能只筛选 `failure`，否则会漏掉启动失败、超时等情况。参见 [2026-11-12 启动故障记录及恢复验证](docs/incidents/2026-11-12-actions-startup.md)。

源数据超过两小时未采集、结构不兼容或请求失败时，工作流报错，不将失败当作“没有消息”。查看 Actions 红色失败运行可了解原因。

兼容 AIHOT 的 `healthy`、`attention` 和 `delayed` 状态。后两者是整体采集进展提示，不能据此判定所有公开事件无效；最近两小时内采集且结构有效的公开记录继续按既有消息规则处理，日志记录警告，实际通知注明来源状态。`delayed` 会在 Actions 中产生 warning，说明采集可能不完整；此时“没有新信号”仅指本轮快照，不代表最新帖子已检查齐全，也不表示 OpenAI 重置发生或推迟。公开接口没有每条帖子的复核标记，程序不声称能识别具体待复核帖子；普通 `related` 回复不会仅因含有 reset 一词触发通知。状态变化不改变去重指纹，不补发已通知消息；恢复后新收录的符合条件消息按原有去重规则处理。超过两小时未采集、时间字段无效或明显在未来、结构异常，以及 `unknown`、缺失或未识别状态仍报错并停止处理，避免持续失效被隐藏成成功。

每轮先在 `Prepare shared source` 步骤读取和校验一次消息源，成功后微信和两个飞书渠道共用快照；失败则跳过所有通知渠道，避免再次请求触发源站限流。源站返回 429 时，本轮不立即重试，等待后续定时检查。健康状态、采集时间和结构异常分别记录错误，未接受的状态会记录实际状态值（非简单状态标识则显示 invalid）；成功读取时记录状态和采集时间。GitHub 状态读取、状态写入与 ServerChan 发送错误使用不同标识，日志保留 HTTP 状态或安全的网络错误码。中文翻译为 null 或缺失时回退到原文，普通相关回复仍不会触发提醒；消息 ID、原帖链接、原文类型和时效校验继续保留。

消息源 GET 遇到网络中断、超时或 HTTP 500/502/503/504/522 时，一轮最多尝试 3 次，默认间隔 2 秒、5 秒，每次请求限时 25 秒。服务端要求的 Retry-After 更长时遵守该等待时间；超过 60 秒则留给后续定时检查。429、重定向、结构错误和过期数据不会立即重试。日志只保留白名单网络错误码（如 UND_ERR_CONNECT_TIMEOUT），不输出异常原文、密钥或请求地址。GitHub 状态读取 GET 也最多尝试 3 次，每次限时 10 秒，默认等待 1 秒、2 秒；遵守不超过 10 秒的 Retry-After，更长等待留到下一轮。权限错误、429、无效 JSON 不重试；404 仍按原有缺失状态规则处理。微信／飞书发送不自动重试。状态 PUT 遇到暂时性错误时，先重新读取对应文件：内容已与目标完全一致则确认保存成功；仅在文件 SHA 仍与写入前一致（新文件则仍不存在）时，携带原 SHA 有限重试，最多 3 次写入。记录变化、被删除或无法核验时停止，不覆盖其他运行的状态；权限和限流错误不重试。首次创建状态分支的 POST 不自动重试。持续失败仍会显示红色。

发送前先持久化尝试记录，防止进程中断重复推送。发生超时或推送失败时标记 `delivery_uncertain` 并停止自动重发：请查 Server酱日志确认，必要时手动查看原帖。这样优先避免刷屏，但可能漏收该条消息。手动测试也计入每日请求上限。

本地无需密钥可运行：`npm test`（Node.js 22）。真实发送只在 GitHub Actions 内运行。日志不会输出 SendKey 或包含密钥的请求 URL。

官方文档：
- https://sct.ftqq.com/docs/getting-started/faq/
- https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule
- https://docs.github.com/en/actions/concepts/billing-and-usage

本项目不隶属于 OpenAI、AIHOT 或 Server酱；源内容归原作者所有。
