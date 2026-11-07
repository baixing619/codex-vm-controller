---
name: vm-computer-controller
description: View and operate an explicitly configured local Hyper-V VM through the separately installed controller service, using guest screenshots without host mouse or window input.
---

# Codex 虚拟机控制器

服务包需先完成 Configure.cmd 的单 VM 绑定，并运行 Start.cmd。技能目录可独立复制安装，scripts/controller.mjs 与 config.mjs 必须一起保留。CLI 需 Node.js 24；没有系统 Node 时使用服务包内 runtime/node.exe。

配置默认在本用户 LOCALAPPDATA/VmComputerController；自定义位置使用 VM_CONTROLLER_HOME 或命令选项 --home。客户端自行读取受保护的 connection.json，不输出或另存令牌。

## 工作流

先查状态，再按用户授权连接：

```text
node "<技能目录>/scripts/controller.mjs" status
node "<技能目录>/scripts/controller.mjs" connect
node "<技能目录>/scripts/controller.mjs" capture --directory "<任务目录>/虚拟机"
```

用图像查看工具查看返回的 framePath。坐标以客机原始帧左上角为 (0,0)，不包含宿主窗口或缩放。

```text
node "<技能目录>/scripts/controller.mjs" click --x 310 --y 450 --button left --directory "<任务目录>/虚拟机"
node "<技能目录>/scripts/controller.mjs" key --key Enter --directory "<任务目录>/虚拟机"
node "<技能目录>/scripts/controller.mjs" type --text-file "<文本文件>" --directory "<任务目录>/虚拟机"
```

每次只执行一个已授权动作，查看返回新帧后再决定下一步。图标可先单击选中，再按 Enter。回执只说明控制器接纳；未看到预期结果时重新截图，不盲目重复输入。

输入绑定当前服务实例、VM、frameId、控制代次、尺寸和动作版本。截图超过120秒、服务重启或被其他动作改变后，必须重新截图。

## 限制与停止

按键支持 Shift、Space、Enter、Escape、Tab、Backspace、ArrowUp/Down/Left/Right。文本只支持1至1000个可打印 ASCII；中文用客机已有输入法逐帧输入拼音、核对候选与上屏结果，不宣称 Unicode 直通。

不接受任意 VM、宿主窗口、shell、进程路径或控制来源。服务启动仅监听，连接不启停 VM。尊重输入授权、停止指令和系统授权，不更改 UAC 或权限检查。

```text
node "<技能目录>/scripts/controller.mjs" debug
node "<技能目录>/scripts/controller.mjs" cancel
```

调试最多256条，仅存内存，可能含本轮输入文字；不要上传或写入无关上下文。截图目录仅保留当前帧。取消、超时或排空未知后先查状态，不自动重发；用户停止后须明确恢复才继续。
