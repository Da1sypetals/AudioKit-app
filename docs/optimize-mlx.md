# Metal / MLX 推理性能优化

## 仓库自身材料

开始工作前必须完整读取目标仓库及其父目录中的 `AGENTS.md`。

## 本机工具链与设备

开始任何 profile 前，必须读取并保存以下命令的输出。工具链、SDK、操作系统和芯片发生变化后必须重新读取。

```sh
sw_vers
system_profiler SPHardwareDataType
xcode-select -p
xcodebuild -version
xcrun --show-sdk-path
xcrun --find gpudebug
xcrun gpudebug --version
xcrun --find gpucapture
```

必须通过 `xcrun` 解析当前选中 Xcode 内的工具。禁止根据 PATH 中同名程序推断当前工具链。

必须读取当前 SDK 的 Metal headers。通过 `xcrun --show-sdk-path` 取得 SDK 根目录，再读取 `System/Library/Frameworks/Metal.framework/Headers/` 下与 capture、command buffer、compute pipeline、resource、counter 相关的声明和注释。API 可用性以当前 SDK headers 为准。

## GPU capture 与 gpudebug

必须完整阅读本机提供的以下 man page：

```sh
man gpudebug
man gpucapture
```

你的主要优化依据是`gpudebug`工具，你必须遵循Profile-guided Opimization对程序进行性能分析和性能优化。

必须使用 `gpudebug <command> ?` 阅读准备调用的每个子命令的上下文帮助。包括但不限于 `list`、`go`、`info`、`fetch`、`find`、`profile`、`wait`、`status`。参数、对象层级、会话生命周期和 JSON 输出格式以本机help文档为准。

必须完整阅读 Apple 官方文档：

- [Investigating GPU issues with AI agents](https://developer.apple.com/documentation/xcode/investigating-gpu-issues-with-ai-agents)
- [Debugging with interactive command-line tools](https://developer.apple.com/documentation/xcode/debugging-with-interactive-command-line-tools)

真实推理生成的 `.gputrace` 是 GPU 工作负载的事实来源。必须读取 trace 内的以下对象树：

- `commands`
- `performance`
- `api_calls`
- `resources`

必须从当前 trace 动态读取可用的 counter、shader、encoder、command buffer、pipeline 和 resource。禁止沿用另一台机器、另一个系统版本或另一份 trace 的对象编号与 counter 名称。

必须读取生成 trace 的 capture 代码或 capture 命令，确认预热、同步、求值、capture 起止位置、输入读取和输出读取所在的边界。MLX 使用 lazy evaluation；测量区间由实际求值边界决定。

必须将原始 `.gputrace` 与生成它的可执行文件、source commit、模型、输入、构建配置、工具链和 capture 边界关联保存。缺少关联信息的 trace 无法支持可复核的性能判断。

你需要探索gpudebug提供的更多输出，不限于上面所描述的输出，以对程序性能进行更精确的分析。

## Benchmark 与正确性

在优化的过程中，你需要确保程序的运行结果和优化前保持一致，数值误差应当在浮点数运算顺序误差的可接受范围之内。你需要用（最大绝对误差、平均绝对误差）来衡量程序的正确性。