# 2026-11-12 GitHub Actions 启动失败

时间均为北京时间（Asia/Shanghai，UTC+8）。核验日期：2026-11-12。

## 结论

04:20–04:45 连续 6 次运行的结论为 `startup_failure`。用户指出的 04:35、04:40、04:45 三次运行均没有创建 job；页面注释报告 GitHub 内部临时错误，并提示检查 GitHub 服务状态。监测脚本尚未执行，因此本次不属于 AIHOT 字段兼容、GitHub 状态文件写入、微信或飞书发送失败。

GitHub 同期公布了 Actions 等服务事故，05:21 宣布恢复。仓库运行的启动错误与该事故相符，但平台尚未发布详细根因，不能从时间重合进一步断言具体基础设施组件出了什么问题。公告时间晚于本仓库开始出现失败的时间。

官方记录：https://www.githubstatus.com/incidents/dvy0t3mvh1lg

## 运行证据

| 触发时间 | 运行 | 结论 |
| --- | --- | --- |
| 04:15 | [43094837270](https://github.com/JoyYoung15/GPT-Reset-Notifier/actions/runs/43094837270) | success |
| 04:20 | [43095474669](https://github.com/JoyYoung15/GPT-Reset-Notifier/actions/runs/43095474669) | startup_failure |
| 04:25 | [43095995595](https://github.com/JoyYoung15/GPT-Reset-Notifier/actions/runs/43095995595) | startup_failure |
| 04:30 | [43096491187](https://github.com/JoyYoung15/GPT-Reset-Notifier/actions/runs/43096491187) | startup_failure |
| 04:35 | [43096974019](https://github.com/JoyYoung15/GPT-Reset-Notifier/actions/runs/43096974019) | startup_failure |
| 04:40 | [43097469092](https://github.com/JoyYoung15/GPT-Reset-Notifier/actions/runs/43097469092) | startup_failure |
| 04:45 | [43097959273](https://github.com/JoyYoung15/GPT-Reset-Notifier/actions/runs/43097959273) | startup_failure；04:49:26 更新为失败 |
| 04:50 | [43098407886](https://github.com/JoyYoung15/GPT-Reset-Notifier/actions/runs/43098407886) | success；job 实际于 04:57:50–04:57:59 执行 |
| 04:55 | [43098867334](https://github.com/JoyYoung15/GPT-Reset-Notifier/actions/runs/43098867334) | success；job 实际于 04:58:06–04:58:20 执行 |

失败和恢复运行使用同一提交 `6ec15f234804f2d5f5b21db2112bd29b24ed8d40`。Cloudflare 仍持续创建运行；GitHub 恢复后，后续轮询自动接续。

恢复后的 04:50 运行日志确认源快照为 healthy，完成校验，微信、公司飞书、个人飞书均完成检查且未发现新符合条件的信号。16:00 运行的详细日志和 17:00 运行状态也确认恢复持续有效。本地既有 54 项测试全部通过。

## 处理与边界

- 本次提交仅补充故障记录和排查说明。无需更改通知逻辑、密钥或消息状态；没有发送测试消息或重放历史通知。
- `startup_failure` 发生在执行任务前，脚本中的重试无法处理。已有每 5 分钟触发会在平台恢复后再次检查，但不能保证 GitHub 故障期间仍能及时通知。
- 恢复时通过原有持久化记录处理接口仍提供的新信号。本次日志未发现新信号，不能据此证明故障期间 X 没有任何新帖子，或证明第三方来源没有漏收。
- 若要在 GitHub 全面不可用时仍继续发送，需要另一个可独立执行采集、去重和发送的系统；单纯增加 GitHub 触发次数或调整通知重试不能消除这一依赖。

## 后续排查方法

1. 明确时区和触发时间、实际完成时间的区别。例如 04:45 触发的失败在 04:49 才更新。
2. 查询指定时间范围内的全部运行并跟随分页，再分类 `conclusion`。不要只查询 `status=failure`：它会漏掉 `startup_failure`、`timed_out`、`cancelled` 等状态；未完成运行也不能算成功。
3. 对没有 job 的运行查看 Summary → Annotations，结合官方状态页定位启动阶段故障。有 job 时再查看各步骤日志。
4. 核实后续连续运行使用的提交和具体步骤，确认源检查、三个渠道检查均完成；不要仅凭调度请求被接受就宣称监测成功。
5. API 请求失败或限流时停止使用旧响应变量，避免把上一次成功查询误配给当前运行。保留错误，使用已授权的认证读取后重新核验。
