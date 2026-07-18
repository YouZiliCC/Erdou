<p align="center">
  <img src="docs/assets/erdou-logo.png" alt="Erdou" width="180" />
</p>

<h1 align="center">Erdou（二豆）</h1>

<p align="center">
  <em>一个让 AI Agent 能够在浏览器中自由开发、运行、测试和交付软件的开源操作环境 —— 零本地安装。</em>
</p>

<p align="center">
  <a href="./README.md">English</a> | <b>简体中文</b>
</p>

<p align="center">
  <sub>以 <b>二豆</b> 命名 —— 一只非常乖的狗狗。🐕</sub>
</p>

---

Erdou 是一个浏览器原生的操作环境——虚拟文件系统、进程、类 POSIX shell、快照与虚拟端口——AI 编码 Agent 像驱动一台真实机器一样驱动它。一切都在你的浏览器标签页内运行:代码、shell、语言运行时,甚至一台完整的 Linux 虚拟机。只有模型 API 调用会离开浏览器。完整愿景见 [`proposal_v1.md`](./proposal_v1.md)。

**今天就能端到端跑通:** 打开 Web 应用,粘贴模型 key,描述任务——Agent 会读写文件、执行命令、验证自己的工作,并实时展示可审阅的 diff。

## 亮点

- **双内核,同一契约。** 快速的浏览器原生内核(VFS、进程表、shell、虚拟端口)与真实的 32 位 **Alpine Linux 虚拟机**(v86/WASM)实现同一份 runtime 契约。Agent 通过能力发现自适应,并可在任务中途 `switch_environment`(需审批)——文件跟随它跨内核迁移。
- **认真的编码 Agent。** 计划 → 行动 → 观察循环,实时系统调用式 trace,每次运行的 **diff 审阅与一键回滚**,多轮对话线程,Auto/Confirm 审批模式,以及一个真正能中途掐断请求的停止按钮。
- **真实的包管理。** 在*虚拟机内部* `pip install` / `npm install` 直接可用——guest 的 HTTP 借浏览器自身的 `fetch` 出站到 PyPI/npm,无需任何代理服务器,安装结果持久保存在工作区。浏览器内核则通过 micropip/Pyodide 安装纯 Python wheel。
- **标签页里的真实开发服务器。** 程序在沙箱内绑定端口,Service Worker 把预览 iframe 反向代理到端口上。静态站点、Python WSGI 应用、打包后的 React 应用都能在 Preview 面板渲染——Agent 可以自己启动服务器并为你打开预览。
- **语言即插件。** JavaScript/TypeScript 内置;**Python** 经 Pyodide(浏览器内真实 CPython);任何 `wasm32-wasi` 二进制(Rust/C/C++/Zig/TinyGo)经 WASI 宿主运行。一个语言包就是注册到某命令名下的一个 `Executor`。
- **浏览器里的 Git。** 基于 isomorphic-git 的 `git` 执行器——init/add/commit/log/status/branch 全部在客户端完成。
- **安全地使用你的磁盘。** 挂载本地文件夹(File System Access API):双向同步带外部编辑冲突检测、显式的镜像推送,以及拒绝破坏性写入的多重保险。
- **隐私是结构性的。** 项目保存在 IndexedDB 或你挂载的文件夹中。除模型 API 请求外,没有任何数据离开浏览器。

## 快速上手

```bash
pnpm install
pnpm --filter @erdou/web dev     # 打开输出的 URL,点击 "Settings",配置模型与 API key
```

一切都在浏览器中运行;只有模型 API 调用会离开(开发模式下经 dev server 代理以规避 CORS)。见 [`apps/web`](./apps/web)。

### 启用 Linux 虚拟机(可选)

浏览器原生内核开箱即用——无需任何烘焙。Alpine **Linux 虚拟机**环境则不然:它的机器镜像是烘焙产物(gitignore,永不入库),所以新克隆的仓库中环境选择器里所有 VM 选项都会显示 "— not baked",直到你自行烘焙:

```bash
pnpm --filter @erdou/runtime-vm bake --profile base   # 或: node | sci | --all
```

烘焙需要两个输入:

1. **访问 Alpine CDN 的网络**(`dl-cdn.alpinelinux.org`)——它会拉取固定版本的 Alpine 3.24.1 x86 minirootfs 以及各 profile 的 apk 包(`base` 几 MiB,`node`/`sci` 数十 MiB)。
2. **`packages/runtime-vm/assets/` 下的三个启动 blob** —— `kernel.bin`、`seabios.bin`、`vgabios.bin`(v86 buildroot bzImage + SeaBIOS/VGABIOS)。它们**目前没有固定的公开下载地址**:`pnpm --filter @erdou/runtime-vm download-assets` 只校验已就位的文件,所以现阶段需要从一份已有这些文件的 checkout 中复制过来(sha256 校验值在 `packages/runtime-vm/assets/manifest.json`)。

每次烘焙不到一分钟,产出 `assets/state-<profile>.zst`(每个 profile 约 48–84 MB,浏览器只下载一次并缓存)。

## 架构

Erdou 遵循严格的自底向上分层(见 [`notice.md`](./notice.md))。**Agent 依赖 Runtime;Runtime 永不依赖 Agent。** Agent 绑定到 Runtime *契约*,而非任何具体 Runtime 实现。

```
browser APIs → runtime-contract → runtime implementations → agent-tools → agent-core → app
```

这一点由 **CI 强制执行**,而不只是写在文档里——任何向上或跨层依赖都会让 `pnpm lint:deps` 使构建失败。

## 包一览

| 包 | 职责 |
| --- | --- |
| [`@erdou/runtime-contract`](./packages/runtime-contract) | 冻结的边界:每个 Runtime 都要实现的纯类型/接口。零依赖。 |
| [`@erdou/runtime-browser`](./packages/runtime-browser) | 浏览器原生内核:VFS、进程表 + 进程内执行器、类 POSIX shell 与内建命令、快照、虚拟端口。 |
| [`@erdou/runtime-vm`](./packages/runtime-vm) | 第二内核:v86 WASM 模拟器中的真实 32 位 Alpine Linux guest,同一契约。多 profile 镜像、包管理出站、PTY。 |
| [`@erdou/runtime-wasi`](./packages/runtime-wasi) | 执行器契约之上的 `wasi_snapshot_preview1` 宿主——运行 Rust/C/C++/Zig/TinyGo 的 `wasm32-wasi` 二进制。 |
| [`@erdou/conformance`](./packages/conformance) | 与具体 Runtime 无关的契约测试套件。任何通过它的适配器即满足契约。 |
| [`@erdou/bundler`](./packages/bundler) | esbuild-wasm 项目打包,npm 裸导入在构建期从 esm.sh 内联——TS/React 预览路径。 |
| [`@erdou/lang-python`](./packages/lang-python) | 经 Pyodide(CPython/WASM)的 `python`/`python3`/`pip`——执行器契约之上的语言包。 |
| [`@erdou/tool-git`](./packages/tool-git) | 基于 isomorphic-git 的 `git` 执行器——完全在浏览器内的本地版本控制。 |
| [`@erdou/model-gateway`](./packages/model-gateway) | 轻量 BYO-key 连接器,支持 OpenAI 兼容与 Anthropic 聊天 API(含工具调用)。与 runtime 无关。 |
| [`@erdou/agent-tools`](./packages/agent-tools) | 编码 Agent 的工具集(读/写/列目录/shell…),定义在 Runtime **契约**之上。 |
| [`@erdou/agent-core`](./packages/agent-core) | 参考实现的**编码 Agent**——以计划→行动→观察循环驱动 Runtime,携带能力感知的系统提示词。 |
| [`apps/web`](./apps/web) | Erdou Studio:任务线程、实时 Agent trace、diff 审阅、文件浏览器、终端、预览、主题、持久化。 |

## 语言

语言是一等扩展点。契约定义了 `Executor`(`ExecContext → 退出码`);语言运行时就是注册到某命令名下的一个 `Executor`:

```ts
runtime.registerProgram("python", createPythonRunner({ load: loadPyodide }));
// 此后 shell、exec、Agent 都能运行: python app.py
```

**JavaScript/TypeScript** 与 **Python** 现已可用;WASI 宿主可运行真实的 Rust/C 二进制。同样的模式可接入 Ruby(ruby.wasm)、Lua、SQLite,或任何面向 `wasm32-wasi` 的工具链。语言包只依赖契约、永不依赖具体 Runtime——由 CI 强制。

## 开发

```bash
pnpm install
pnpm test         # 单元测试 + 契约套件(Vitest)
pnpm typecheck    # 全包严格 TypeScript
pnpm lint:deps    # 强制分层不变量(dependency-cruiser)
pnpm build        # 为每个包产出 dist/ 与 .d.ts(tsup)
pnpm conformance  # 对 BrowserRuntime 运行契约套件
```

需要 Node ≥ 22 与 pnpm ≥ 11。一切皆可在 Node 中运行——内核的测试不需要浏览器。

## 设计原则

- **快速失败,不做静默兜底。** 每个失败都抛出带类型的 errno 错误(`ENOENT: no such file or directory, open '/foo'`),携带出错路径——绝不吞掉后返回默认值。
- **不过度工程化。** 只构建当前阶段需要的;延后的能力由分层预留位置,而不是投机性地先建出来。

## 许可证

[Apache-2.0](./LICENSE)。
