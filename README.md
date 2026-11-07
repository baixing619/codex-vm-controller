# Codex 虚拟机控制器

让 Codex 通过本机后台服务截图和操作一台明确绑定的 Hyper-V 虚拟机。包含技能、客户端、服务和原生控制组件。

## 使用

支持 Windows 10/11 x64 宿主；需要已配置的 Hyper-V 和一台正在运行的虚拟机。Windows 发布包自带 Node.js 24，无需另外安装开发环境。

1. 从 [Releases](../../releases/latest) 下载 Windows ZIP，完整解压。
2. 双击 `Configure.cmd`，填入目标虚拟机的 GUID，完成一次绑定。
3. 双击 `Start.cmd`，保持服务运行。连接时按系统提示确认 UAC。
4. 将 `skills/vm-computer-controller` 复制到自己的 Codex skills 目录（默认 `~/.codex/skills`），让 Codex 使用“Codex 虚拟机控制器”。

技能的命令和画面核对方法见 [SKILL.md](skills/vm-computer-controller/SKILL.md)。CLI 使用 Node.js 24；未安装系统 Node 时可用发布包内 `runtime/node.exe`。

设置默认保存在本用户 `%LOCALAPPDATA%/VmComputerController`。自定义目录需为空，配置器不会覆盖已有绑定；设置 `VM_CONTROLLER_HOME` 后，配置、启动和 CLI 使用同一目录。

## 操作范围

- 服务只监听本机动态端口，使用本用户受保护的连接信息和随机令牌。
- 启动服务不会连接虚拟机；明确连接后才启动控制组件。
- 只控制绑定的客机，不借用宿主鼠标或切换宿主窗口；不提供任意命令、文件访问或 VM 启停。
- 支持截图、左右键点击、有限按键和可打印 ASCII 文本；中文需使用客机已有输入法。
- 输入前查看当前客机截图，动作后核对新画面。取消或排空未知时停止，不自动重发。
- 配置、令牌、截图与调试内容不要提交到公开仓库。正常退出服务会等待执行排空，不关闭虚拟机。

## 源码与验证

仓库保留完整源码和测试；运行 ZIP 只包含技能、服务、原生组件、运行时、启动配置入口和必要说明/许可。

源码开发需要 Node.js 24；原生构建还需 .NET Framework 4.x x64、Visual Studio C++ 工具和 Windows SDK。执行 `npm test`、`native/build.ps1 -RunTests`、`npm run package`。

GitHub Actions 在 Windows/Linux 检查协议，并在 Windows 编译和验证解压后的包、独立配置及中文路径。云端使用合成设备，未验证其他电脑上的真实 Hyper-V 截图与输入。

自有源码采用 MIT；第三方运行组件见 [声明](THIRD_PARTY_NOTICES.md)。
