## 架构分层与依赖方向约束

项目必须遵循自下而上的分层架构。

核心依赖方向为：

```text
基础设施层
    ↓
Runtime 抽象层
    ↓
Runtime 实现层
    ↓
Agent 工具层
    ↓
Agent 核心层
    ↓
应用与用户界面层
```

更具体地表示为：

```text
Browser APIs / WebAssembly / Web Worker / OPFS
                        ↓
                Runtime Contract
                        ↓
              Runtime Implementations
                        ↓
                  Agent Tools
                        ↓
                   Agent Core
                        ↓
               Web App / Coding Agent
```

依赖方向必须保持单向。

上层模块可以依赖下层模块，但下层模块不得依赖上层模块。

正确依赖关系：

```text
agent-core
    ↓
agent-tools
    ↓
runtime-contract
    ↓
runtime-browser
    ↓
browser APIs
```

错误依赖关系：

```text
runtime-core
    ↓
agent-core
```

或者：

```text
filesystem
    ↓
coding-agent
```

Runtime 不得感知或依赖具体的 Coding Agent 实现。

Runtime 的职责是提供通用的执行环境能力，包括：

```text
文件系统
进程管理
命令执行
标准输入输出
网络访问
虚拟端口
快照
权限
资源管理
运行时能力查询
```

Runtime 不应知道：

* 当前使用的是 Coding Agent；
* Agent 使用了哪一种模型；
* Agent 的系统提示词；
* Agent 的任务计划；
* Agent 的上下文管理方式；
* Agent 的代码修改策略；
* Agent 的测试和修复逻辑；
* Agent UI 的具体形态。

Runtime 只提供通用能力，例如：

```ts
interface Runtime {
  boot(): Promise<void>;

  spawn(options: SpawnOptions): Promise<ProcessHandle>;
  kill(pid: number): Promise<void>;
  wait(pid: number): Promise<ExitStatus>;

  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  listDirectory(path: string): Promise<FileEntry[]>;

  createSnapshot(): Promise<Snapshot>;
  restoreSnapshot(snapshot: Snapshot): Promise<void>;

  listen(port: number): Promise<VirtualPort>;
  getCapabilities(): Promise<RuntimeCapabilities>;
}
```

上层 Agent 通过这些接口完成：

```text
读取项目
搜索代码
修改文件
运行命令
执行测试
启动服务
读取错误
修复问题
验证结果
```

Agent 可以依赖 Runtime，但 Runtime 不能依赖 Agent。

### 依赖倒置原则

Agent 不应直接依赖某一种具体 Runtime 实现。

错误方式：

```ts
class CodingAgent {
  constructor(private runtime: WebContainerRuntime) {}
}
```

正确方式：

```ts
class CodingAgent {
  constructor(private runtime: Runtime) {}
}
```

具体 Runtime 在应用启动时注入：

```ts
const runtime = new BrowserRuntime();

const agent = new CodingAgent(runtime);
```

未来可以替换为：

```ts
const runtime = new WasmRuntime();
const runtime = new LinuxVmRuntime();
const runtime = new RemoteRuntime();
```

而无需修改 Agent 核心逻辑。

### Runtime Contract

项目必须维护一个独立的 Runtime Contract。

Runtime Contract 用于定义所有运行环境必须实现的统一接口，包括：

* 文件操作；
* 进程操作；
* 标准输入输出；
* 网络能力；
* 端口能力；
* 快照能力；
* 权限能力；
* 资源限制；
* 运行时能力描述；
* 生命周期管理。

任何 Runtime Adapter 只要实现该 Contract，并通过兼容性测试，就可以接入上层 Agent。

示例：

```text
runtime-contract
├── BrowserRuntime
├── WebAssemblyRuntime
├── WasmRuntime
├── PyodideRuntime
├── LinuxVmRuntime
└── RemoteRuntime
```

Agent 不应通过类型判断硬编码不同 Runtime：

```ts
if (runtime instanceof BrowserRuntime) {
  // ...
}

if (runtime instanceof LinuxVmRuntime) {
  // ...
}
```

Agent 应通过能力协商决定行为：

```ts
const capabilities = await runtime.getCapabilities();

if (capabilities.nativeProcesses) {
  // 使用原生进程能力
}

if (capabilities.virtualPorts) {
  // 启动开发服务器
}

if (!capabilities.nativeAddons) {
  // 选择浏览器兼容依赖或其他执行后端
}
```

### 上层不得向下层泄漏业务概念

以下概念只能存在于 Agent 或应用层：

```text
任务计划
代码修改步骤
模型调用
Token 预算
上下文管理
Agent 记忆
多 Agent 协作
代码审查
修复策略
任务完成判断
```

以下概念属于 Runtime 层：

```text
文件
目录
进程
线程
命令
端口
网络
快照
存储
权限
资源
执行状态
```

Runtime 可以提供事件和数据，但不得替 Agent 做业务判断。

例如 Runtime 可以报告：

```text
进程退出码为 1
标准错误中存在编译错误
进程已连续运行 30 秒
内存占用超过限制
```

但 Runtime 不应判断：

```text
代码任务失败
Agent 应重新修改代码
当前方案不可行
应该切换模型
```

这些判断属于 Agent 层。

### 模块依赖规则

建议采用以下依赖方向：

```text
apps/web
├── agent-core
├── agent-tools
├── model-gateway
├── runtime-contract
└── runtime-browser

agent-core
├── agent-tools
├── model-gateway
└── runtime-contract

agent-tools
└── runtime-contract

runtime-browser
├── runtime-contract
├── filesystem
├── process
├── shell
├── networking
└── snapshots

runtime-contract
└── 不依赖任何具体 Runtime 或 Agent

filesystem
└── 不依赖 Agent

process
└── 不依赖 Agent

shell
└── 不依赖 Agent
```

### 禁止的依赖关系

项目应在构建和 CI 阶段禁止以下依赖：

```text
runtime-* → agent-*
filesystem → agent-*
process → agent-*
shell → agent-*
networking → agent-*
snapshots → agent-*
runtime-contract → runtime-browser
runtime-contract → app
```

同时禁止底层模块导入：

* Agent Prompt；
* 模型 SDK；
* Agent Session；
* UI 组件；
* Coding Task 类型；
* Agent 专用事件类型。

### 事件通信

Runtime 与 Agent 之间应通过通用事件通信，例如：

```ts
type RuntimeEvent =
  | { type: "process.started"; pid: number }
  | { type: "process.stdout"; pid: number; data: Uint8Array }
  | { type: "process.stderr"; pid: number; data: Uint8Array }
  | { type: "process.exited"; pid: number; code: number }
  | { type: "file.changed"; path: string }
  | { type: "port.opened"; port: number }
  | { type: "resource.warning"; resource: string };
```

Agent 接收这些事件后，自行决定是否：

* 继续执行；
* 读取文件；
* 重新运行测试；
* 修改代码；
* 停止任务；
* 请求用户确认。

Runtime 不应发送带有 Agent 业务含义的事件，例如：

```text
agent_should_retry
task_completed
code_fix_failed
model_should_change
```

### Monorepo 与逻辑分层

项目早期可以采用 Monorepo，但 Monorepo 只代表代码位于同一个 Git 仓库，不代表模块可以相互任意依赖。

即使 Runtime 和 Agent 位于同一个仓库中，也必须被视为两个独立产品层：

```text
Erdou Runtime
    ↓
Erdou Agent
```

Runtime 是基础设施。

Agent 是 Runtime 之上的官方应用。

未来如果拆分成独立仓库，公共接口、包名和依赖方向不应发生根本变化。

建议从项目早期分别发布：

```text
@erdou/runtime-contract
@erdou/runtime-browser
@erdou/runtime-wasm
@erdou/agent-core
@erdou/agent-tools
@erdou/sdk
```

这样可以在保持 Monorepo 开发效率的同时，确保 Runtime 可以被第三方独立使用。

### 架构原则总结

项目必须始终遵循：

> Agent 依赖 Runtime，Runtime 不依赖 Agent。

> 应用依赖 Agent，Agent 不依赖具体应用。

> Agent 依赖 Runtime Contract，不直接绑定具体 Runtime。

> 底层负责提供能力，上层负责理解任务和制定决策。

> 物理上可以使用一个仓库，逻辑上必须保持严格分层。

该规则属于项目的核心架构约束，不应因为开发便利而被破坏。

