# Browser-First 开源 Coding Agent 项目需求说明

## 一、项目定位

本项目旨在打造一个真正以浏览器为第一运行环境的开源 Coding Agent。

它不是传统 Coding Agent 的网页外壳，也不是把代码编辑器简单搬到浏览器中，而是希望在浏览器内部构建一套面向 AI Agent 的完整运行环境，使 AI 能够像在本地操作系统中一样，自由地完成代码读取、修改、执行、测试、调试、构建和预览等任务。

用户只需要打开网页，即可获得一个可直接使用的开发环境和 Coding Agent，无需提前安装 Node.js、Python、Docker、Git、IDE、编译器或其他本地依赖。

项目的长期目标是：

> 在浏览器中构建一个适合 AI Agent 使用的虚拟操作系统和开发执行环境，让 AI 可以像操作真实 OS 一样操作项目、进程、文件、网络、终端和运行时。

Coding Agent 是该浏览器运行环境的第一个核心应用，后续还可以扩展到更多类型的 Agent 和自动化任务。

---

## 二、核心理念

### 1. Browser-First

浏览器不是远程服务器的控制界面，而是项目的主要运行环境。

尽可能多的能力应直接运行在用户浏览器中，包括：

* 项目文件存储；
* 代码读取与修改；
* 命令执行；
* 测试运行；
* 应用构建；
* 开发服务器；
* 页面预览；
* 依赖管理；
* 进程调度；
* Agent 状态管理；
* 项目快照和恢复。

服务端只承担必要的轻量能力，例如模型 API、中继服务、身份认证、数据同步或浏览器无法直接实现的网络代理。

---

### 2. 零安装、开箱即用

项目主要面向不熟悉开发环境配置、容易被本地安装流程阻挡的用户。

用户无需理解：

* 如何安装编程语言；
* 如何配置环境变量；
* 如何安装包管理器；
* 如何使用 Docker；
* 如何配置 Git；
* 如何处理操作系统差异；
* 如何解决本地依赖冲突。

理想体验为：

1. 打开网页；
2. 创建或导入一个项目；
3. 描述想完成的任务；
4. AI 自动修改、执行和测试代码；
5. 用户直接查看运行结果；
6. 下载、保存或部署项目。

---

### 3. Open Source

项目将以开源形式开发。

开源的目标不仅是公开代码，还包括建立一个可由社区共同扩展的浏览器 Agent 运行时生态。

社区开发者应能够贡献：

* 新的编程语言运行时；
* 新的系统命令；
* 新的虚拟设备；
* 新的包管理器；
* 新的网络协议适配器；
* 新的测试框架；
* 新的 Agent 工具；
* 新的虚拟机后端；
* 新的浏览器兼容层；
* 新的模型 Provider；
* 新的任务模板。

项目希望通过清晰的接口、模块化架构和兼容性测试，吸引开发者持续完善浏览器内运行环境。

---

## 三、核心产品目标

### 1. 让 AI 在浏览器中像在 OS 中一样工作

AI Agent 应能够在浏览器中执行与本地操作系统类似的开发任务，包括：

* 创建、读取、修改和删除文件；
* 遍历目录；
* 搜索代码；
* 创建项目；
* 安装依赖；
* 执行命令；
* 启动和停止进程；
* 运行测试；
* 获取标准输出和错误输出；
* 查看退出状态；
* 启动开发服务器；
* 访问应用预览；
* 读取运行时错误；
* 调试失败任务；
* 构建项目；
* 保存和恢复工作状态。

对于 Agent 来说，浏览器环境应尽量表现为一个统一、稳定、可编程的操作系统环境，而不是一组相互割裂的浏览器 API。

---

### 2. 在浏览器内创建和调度运行环境

Agent 内核应能够创建、管理和调度多个运行环境。

运行环境可以根据实现阶段映射为：

* 独立浏览器标签页；
* Web Worker；
* Shared Worker；
* Service Worker；
* iframe；
* WebAssembly 实例；
* 浏览器内虚拟机；
* 浏览器内 Linux 环境；
* 远程兼容运行环境。

项目允许将独立进程、任务、工作区或虚拟机映射到多个浏览器标签页。

不同标签页之间可以代表：

* 不同进程；
* 不同开发环境；
* 不同 Agent；
* 同一项目的不同分支；
* 不同方案的并行实验；
* 不同测试环境；
* 不同虚拟机实例。

标签页之间需要能够进行状态同步、消息通信、资源协调和任务调度。

---

### 3. 支持多进程和并行任务

浏览器运行时应具备进程抽象。

每个虚拟进程至少应具有：

* 唯一进程 ID；
* 父进程 ID；
* 当前工作目录；
* 环境变量；
* 标准输入；
* 标准输出；
* 标准错误；
* 启动时间；
* 当前状态；
* 退出码；
* 资源使用情况；
* 终止能力；
* 等待能力；
* 消息通信能力。

Agent 可以：

* 创建新进程；
* 创建子进程；
* 在新标签页中创建独立进程或运行环境；
* 同时运行多个测试；
* 同时启动开发服务器和测试进程；
* 同时尝试多个解决方案；
* 暂停、恢复和终止任务；
* 监控进程状态；
* 收集不同进程的输出。

项目应支持类似以下概念：

```text
spawn
fork
exec
wait
kill
pipe
signal
background task
process group
workspace fork
```

具体实现可以根据浏览器能力进行抽象，但上层 Agent 应获得统一的进程管理接口。

---

## 四、浏览器操作系统能力

项目需要在浏览器中构建一层统一的 Browser OS Kernel。

该内核至少包含以下子系统。

### 1. 文件系统

支持：

* 文件读取和写入；
* 文件创建和删除；
* 目录创建和遍历；
* 文件移动和重命名；
* 文件搜索；
* 文件监听；
* 临时文件；
* 持久文件；
* 文件权限抽象；
* 符号链接抽象；
* 挂载点；
* 项目快照；
* 文件版本历史；
* 并发访问控制；
* 跨标签页文件同步。

可支持的存储来源包括：

* 浏览器内存；
* OPFS；
* IndexedDB；
* 用户本地目录；
* ZIP 文件；
* Git 仓库；
* HTTP 远程文件；
* 对象存储；
* 虚拟磁盘镜像。

文件系统应向 Agent 提供统一接口，使 Agent 不需要关心实际数据存储在哪一种浏览器能力中。

---

### 2. 进程系统

支持：

* 进程创建；
* 子进程创建；
* 进程退出；
* 进程等待；
* 进程终止；
* 进程状态查询；
* 标准输入输出；
* 管道；
* 环境变量；
* 工作目录；
* 后台进程；
* 进程间通信；
* 跨标签页进程通信；
* 进程资源限制；
* 进程崩溃恢复；
* 进程日志。

进程可以由不同执行单元承载，包括：

* Web Worker；
* Shared Worker；
* WebAssembly Instance；
* iframe；
* 浏览器标签页；
* 虚拟机；
* 远程执行器。

---

### 3. Shell 和命令行环境

系统需要为 Agent 提供终端和 Shell 能力。

至少支持：

* 命令执行；
* 参数解析；
* 当前目录；
* 环境变量；
* 管道；
* 输入输出重定向；
* 条件执行；
* 后台执行；
* 命令历史；
* 命令超时；
* 命令取消。

应逐步支持常见命令：

```text
cd
pwd
ls
cat
echo
mkdir
rm
cp
mv
find
grep
head
tail
sed
awk
which
env
export
ps
kill
git
npm
pnpm
node
python
cargo
make
```

Agent 除了执行 Shell 字符串，也应能够使用结构化进程 API，以提高稳定性和安全性。

---

### 4. WebAssembly 和运行时系统

WebAssembly 是项目的重要基础技术。

系统应支持：

* 加载和执行 WebAssembly；
* WASI；
* WASIX；
* 共享内存；
* 多线程；
* 文件系统访问；
* 标准输入输出；
* 环境变量；
* 进程抽象；
* 网络抽象；
* 动态加载；
* 运行时缓存；
* 实例快照；
* 实例恢复。

不同语言和工具可以通过 WebAssembly 进入浏览器运行环境，例如：

* Rust；
* C；
* C++；
* Python；
* Ruby；
* Lua；
* PHP；
* Go；
* SQLite；
* Git；
* Ripgrep；
* 编译器；
* 格式化器；
* Linter；
* 测试工具。

---

### 5. 虚拟机系统

当 WebAssembly 或浏览器原生运行时无法满足兼容性要求时，系统应支持浏览器内虚拟机。

虚拟机能力包括：

* 创建虚拟机；
* 启动和关闭虚拟机；
* 虚拟磁盘；
* 内存管理；
* CPU 时间管理；
* 虚拟网络；
* 文件共享；
* 端口映射；
* 快照；
* 恢复；
* 克隆；
* 多虚拟机调度；
* 虚拟机日志；
* 虚拟机状态监控。

长期目标是支持在浏览器中运行 Linux 或其他兼容操作系统，使未经特殊适配的软件也能够运行。

---

### 6. 网络系统

浏览器运行时应提供统一网络抽象。

支持：

* HTTP；
* HTTPS；
* Fetch；
* WebSocket；
* WebTransport；
* WebRTC；
* DNS 抽象；
* 虚拟 TCP；
* 虚拟 UDP；
* 端口监听；
* 端口转发；
* CORS 处理；
* 网络代理；
* 请求日志；
* 网络权限；
* 网络隔离。

系统应允许浏览器内进程访问：

* npm Registry；
* Git 仓库；
* 模型 API；
* 第三方 HTTP API；
* 数据库代理；
* 用户提供的远程服务；
* 自托管网络网关。

---

### 7. 虚拟端口和预览系统

浏览器中的开发服务器需要获得类似本地端口的能力。

系统应支持：

* 进程监听虚拟端口；
* Agent 查询端口状态；
* 将端口映射到预览页面；
* 同时运行多个开发服务器；
* 根据项目生成独立预览地址；
* 捕获控制台错误；
* 捕获网络错误；
* 捕获页面运行错误；
* Agent 自动访问和测试预览结果。

预览环境与主应用环境需要隔离，避免生成代码访问模型密钥、用户数据或 Agent 内核。

---

### 8. 包管理系统

系统应支持在浏览器中安装和管理项目依赖。

第一阶段重点支持 JavaScript 和 TypeScript 生态：

* npm；
* pnpm；
* package.json；
* lock 文件；
* Registry 下载；
* 依赖缓存；
* 生命周期脚本；
* ESM；
* CommonJS；
* Monorepo 的基础能力。

长期支持：

* Python 包；
* Rust Crate；
* WASI 包；
* 系统工具包；
* 浏览器虚拟软件仓库。

需要建立兼容性数据库，记录：

* 哪些包可以直接运行；
* 哪些包依赖原生模块；
* 哪些包需要替代实现；
* 哪些包需要虚拟机；
* 哪些包需要远程运行；
* 可使用哪些浏览器兼容方案。

---

## 五、Coding Agent 能力

### 1. 基础代码能力

Agent 至少能够：

* 理解项目结构；
* 搜索相关代码；
* 阅读文件；
* 修改文件；
* 新建文件；
* 删除文件；
* 生成补丁；
* 查看 Diff；
* 运行构建；
* 运行测试；
* 读取错误；
* 修复错误；
* 启动预览；
* 验证修改结果；
* 回滚失败修改。

---

### 2. 任务执行循环

Agent 应具备完整闭环：

```text
理解任务
→ 分析项目
→ 制定计划
→ 修改代码
→ 执行命令
→ 运行测试
→ 检查结果
→ 修复错误
→ 验证完成
```

Agent 不只是生成代码，还必须实际运行和验证。

---

### 3. 多 Agent 和多环境协作

后续支持：

* 一个 Agent 创建多个子 Agent；
* 每个 Agent 使用独立进程或标签页；
* 多个 Agent 并行尝试不同方案；
* 多个 Agent 分别负责开发、测试、审查和调试；
* 为同一项目创建多个工作区；
* 自动比较不同方案；
* 选择最佳结果；
* 合并不同 Agent 的修改。

示例：

```text
主 Agent
├── 实现 Agent
├── 测试 Agent
├── 调试 Agent
└── 审查 Agent
```

---

### 4. 自主测试能力

Agent 应能够在浏览器中运行：

* 单元测试；
* 组件测试；
* DOM 测试；
* 集成测试；
* 页面交互测试；
* 构建检查；
* 类型检查；
* Lint；
* 性能测试；
* 快照测试。

Agent 可以直接操作预览页面，例如：

* 打开页面；
* 点击按钮；
* 输入内容；
* 查询 DOM；
* 检查文本；
* 监听错误；
* 截图；
* 比较前后状态。

---

### 5. 调试能力

Agent 应能够：

* 读取堆栈；
* 捕获异常；
* 查看控制台；
* 查看测试失败；
* 查看网络请求；
* 查看运行进程；
* 查看文件变化；
* 检查端口；
* 重启服务；
* 修改代码后重新执行；
* 检测重复失败；
* 判断任务是否卡住。

---

## 六、模型接入要求

项目应支持灵活的模型接入。

用户可以配置：

```text
Base URL
API Key
Model ID
Provider 类型
```

支持：

* OpenAI-compatible API；
* OpenAI Responses API；
* Anthropic API；
* 本地模型；
* 自托管模型；
* 第三方中转；
* 用户自建 Gateway；
* 项目官方 API。

用户无需修改复杂配置文件。

系统应自动检测：

* Endpoint 是否可用；
* 是否支持流式输出；
* 是否支持工具调用；
* 是否支持多轮工具调用；
* 是否支持 JSON Schema；
* 是否支持并行工具；
* 是否支持长上下文；
* 是否适合 Coding Agent。

---

## 七、用户体验要求

### 1. 面向零基础用户

默认界面不应要求用户理解：

* 文件系统；
* Shell；
* Git；
* 依赖管理；
* 测试框架；
* 运行时；
* WebAssembly；
* 虚拟机；
* 模型协议。

默认界面应围绕任务和结果设计：

```text
输入需求
查看执行进度
查看应用预览
查看修改摘要
撤销修改
继续调整
下载项目
部署项目
```

高级用户可以展开：

* 文件树；
* 编辑器；
* 终端；
* 进程列表；
* 网络日志；
* Agent Trace；
* 虚拟机管理；
* Runtime 状态。

---

### 2. 开箱即食

首次使用流程应尽量简化：

1. 打开网站；
2. 选择新建项目或导入项目；
3. 输入需求；
4. Agent 自动开始工作；
5. 用户看到最终可运行结果。

可提供有限游客额度，使用户无需配置模型即可体验。

---

### 3. 本地优先和隐私透明

项目代码和执行环境默认保存在用户浏览器中。

用户应清楚看到：

* 哪些数据只在本地；
* 哪些数据发送给模型；
* 哪些请求经过服务器；
* 模型 API Key 存放位置；
* 当前网络访问目标；
* 当前 Agent 读取了哪些文件；
* 当前进程执行了哪些命令。

---

### 4. 可回滚

Agent 的每次重要修改都应创建 Checkpoint。

用户可以：

* 撤销单次修改；
* 恢复任务开始前状态；
* 查看历史版本；
* 比较不同版本；
* 创建项目分支；
* 在新标签页中打开某个历史快照；
* 并行尝试多个方案。

---

### 5. 可恢复

浏览器刷新、标签页崩溃或系统中断后，用户能够继续任务。

需要保存：

* 项目文件；
* Agent 对话；
* Agent 执行状态；
* 进程状态；
* 任务计划；
* 工具调用记录；
* 测试结果；
* Checkpoint；
* Runtime 配置。

---

## 八、标签页与进程设计

项目允许将进程或运行环境映射到独立标签页。

可能的设计包括：

```text
标签页 A：主 Agent
标签页 B：开发服务器
标签页 C：测试进程
标签页 D：子 Agent
标签页 E：虚拟机
标签页 F：方案分支
```

标签页之间通过统一的通信和调度系统协作。

需要支持：

* 标签页注册；
* 标签页身份；
* 父子关系；
* 状态同步；
* 消息传递；
* 文件共享；
* 进程控制；
* 资源统计；
* 异常检测；
* 标签页关闭处理；
* 标签页恢复；
* 跨标签页任务迁移。

可使用：

* BroadcastChannel；
* SharedWorker；
* Service Worker；
* MessageChannel；
* OPFS；
* SharedArrayBuffer；
* Atomics。

长期目标是让浏览器窗口本身成为可视化的进程和虚拟机管理界面。

---

## 九、系统安全要求

浏览器内执行的项目代码和第三方依赖均视为不可信代码。

系统必须隔离：

* 模型 API Key；
* 用户身份信息；
* Agent 系统提示词；
* 其他项目文件；
* 浏览器主站 Cookie；
* 用户本地目录权限；
* 内核管理接口；
* 其他标签页的状态。

安全措施包括：

* 独立 Origin；
* sandbox iframe；
* CSP；
* 权限系统；
* 网络访问控制；
* 文件访问控制；
* 进程资源限制；
* 依赖安装提示；
* 生命周期脚本审核；
* 命令风险分级；
* 敏感操作确认；
* 完整操作日志。

---

## 十、项目架构要求

项目应采用模块化设计，建议拆分为：

```text
browser-agent/
├── kernel/
├── filesystem/
├── process/
├── shell/
├── terminal/
├── wasi/
├── wasm/
├── virtual-machine/
├── networking/
├── package-manager/
├── runtime/
├── scheduler/
├── snapshots/
├── permissions/
├── agent-core/
├── model-gateway/
├── testing/
├── preview/
├── compatibility/
├── conformance/
├── ui/
└── docs/
```

核心模块之间通过稳定接口通信，避免与某一种运行时强绑定。

---

## 十一、运行时抽象

所有运行环境应实现统一接口，例如：

```ts
interface Runtime {
  boot(): Promise<void>;
  shutdown(): Promise<void>;

  spawn(options: SpawnOptions): Promise<ProcessHandle>;
  fork(options: ForkOptions): Promise<ProcessHandle>;

  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  listDirectory(path: string): Promise<FileEntry[]>;

  createSnapshot(): Promise<Snapshot>;
  restoreSnapshot(snapshot: Snapshot): Promise<void>;

  listen(port: number): Promise<VirtualPort>;
  exposePort(port: number): Promise<string>;

  getProcesses(): Promise<ProcessInfo[]>;
  getCapabilities(): Promise<RuntimeCapabilities>;
}
```

不同实现可以包括：

```text
Browser JavaScript Runtime
WebAssembly Runtime
WASI Runtime
WASIX Runtime
Pyodide Runtime
WebContainer Runtime
x86 Virtual Machine Runtime
Linux Runtime
Remote Runtime
```

Agent 只依赖统一 Runtime API。

---

## 十二、开源生态设计

项目需要提供清晰的扩展标准。

社区开发者可以创建：

```text
Runtime Adapter
Command Adapter
Language Runtime
Package Adapter
Network Adapter
Filesystem Adapter
Agent Tool
Testing Adapter
Model Provider
Virtual Device
Compatibility Rule
```

所有扩展应能够通过自动化兼容性测试。

项目需要维护 Conformance Suite，用于验证：

* 文件系统行为；
* 进程行为；
* Shell 行为；
* 网络行为；
* WASI 行为；
* 包管理行为；
* 快照行为；
* 多标签页行为；
* Agent 工具行为。

---

## 十三、第一阶段 MVP

第一阶段目标不是完成所有操作系统功能，而是证明 Browser-First Coding Agent 的完整闭环。

MVP 应实现：

### 浏览器运行环境

* 浏览器内文件系统；
* 项目持久化；
* 基础 Shell；
* 进程管理；
* Web Worker 执行；
* WebAssembly 执行；
* 标准输入输出；
* 进程退出码；
* 虚拟端口；
* 应用预览；
* 项目快照；
* 页面刷新恢复。

### Coding Agent

* 读取文件；
* 搜索代码；
* 修改文件；
* 创建文件；
* 运行命令；
* 安装依赖；
* 运行测试；
* 启动开发服务器；
* 读取错误；
* 自动修复；
* 展示 Diff；
* 撤销修改。

### 支持范围

第一阶段优先支持：

```text
JavaScript
TypeScript
React
Vite
Node.js
npm
Vitest
```

### 第一阶段验收任务

用户打开一个全新的浏览器页面，不安装任何软件，输入：

```text
创建一个 React 项目，加入一个计数器，为计数器添加测试，并运行项目。
```

Agent 应自动完成：

1. 创建项目；
2. 创建文件；
3. 安装依赖；
4. 修改代码；
5. 运行测试；
6. 修复错误；
7. 启动开发服务器；
8. 展示预览；
9. 保存项目；
10. 刷新后恢复状态。

---

## 十四、后续发展方向

完成 MVP 后，可以逐步增加：

* 多标签页进程；
* 多 Agent；
* 多工作区并行；
* Python；
* Rust；
* C/C++；
* Git；
* SQLite；
* WASIX；
* Linux 虚拟机；
* 完整 POSIX 兼容层；
* TCP/UDP 网关；
* 远程 Runtime；
* 云端同步；
* 插件市场；
* Agent 应用生态；
* 浏览器内 CI；
* 浏览器内自动化平台；
* 面向第三方 Agent 的 Runtime SDK。

---

## 十五、项目最终形态

项目最终不只是一个 Coding Agent，而是一套完整的开放式浏览器 Agent 基础设施。

最终组成可以包括：

```text
Browser Agent OS
+
Browser Runtime Kernel
+
Reference Coding Agent
+
Runtime SDK
+
Compatibility Registry
+
Extension Ecosystem
```

最终愿景是：

> 任何用户打开浏览器，就能获得一个由 AI 操作的完整开发环境。

> 任何开发者都可以为浏览器 Agent OS 提供新的语言、工具、运行时、虚拟机和系统能力。

> AI Agent 可以在浏览器中创建进程、操作文件、运行命令、启动服务、执行测试、调试程序和交付软件，如同运行在真实操作系统中一样。

项目的一句话定位为：

> **An open-source browser operating environment where AI agents can build, run, test and ship software without local setup.**

中文定位为：

> **一个让 AI Agent 能够在浏览器中自由开发、运行、测试和交付软件的开源操作环境。**

