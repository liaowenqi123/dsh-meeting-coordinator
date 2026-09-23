/**
 * 把 {@link MeetingConsole} 接到 DSH 的 **Typert Gateway** 上，供浏览器侧面板调用。
 *
 * ## 为什么必须是这个通道
 *
 * 浏览器读不到文件、也进不了 Node 进程。面板要显示"有哪些房间、谁在里面、
 * 开过几次会"，只有一条路：宿主把数据通过 gateway 暴露成一个 Remote 端点。
 *
 * ## 为什么不用上游的类型（关键决定）
 *
 * 上游的写法是 `class X extends TypertRemoteService`，但 `TypertRemoteService`
 * 来自 `@deepseek-ai/dsh-typert-protocol`。本插件是 `link:` 安装的，
 * 依赖从**项目自己**的 node_modules 解析，import 上游包会引入第二份 cordis，
 * 那正是本仓库一直在避免的问题（README 里"两份 core"那一节）。
 *
 * 所以我们**按契约复刻，而不是 import**。契约只有三件事，都从上游源码读出来的：
 *
 * 1. **Cordis 服务**：`ctx.provide(key, value)` 会让 `ctx.reflect.props[key]`
 *    变成 `{ type: 'service' }` —— gateway 的发现循环正是按这个过滤的
 *    （`collectSrcClaims` 里 `definition.type !== 'service'` 就跳过）；
 * 2. **`typertRemote` 绑定**：服务实例上要有一个对象，且
 *    `binding.service === 服务实例本身`（严格相等）、`binding.serviceKey === cordis 键`、
 *    `typeof binding.namespace === 'string'`。上游 `readBinding` 逐条校验这三项；
 * 3. **方法标记**：原型上一个**普通字符串键**的描述符
 *    `{ version: 1, methods: [{ method, invocation: { kind: 'direct' } }] }`。
 *
 * 第 3 条是关键发现：这个键不是 `Symbol`，而是字面量字符串
 * `'@deepseek-ai/dsh-typert-protocol/remote-methods'`，用
 * `Object.getOwnPropertyDescriptor(prototype, key)` 直接读。**因为它是普通字符串**，
 * 我可以在不 import 上游包的前提下写出完全等价的描述符。
 *
 * ## 参数怎么走线
 *
 * gateway 的 SRC 模式**按形参名**映射成 JSON（`source: 'json'`、`codec: { mode: 'src-json' }`），
 * 并且 `assertExactArguments` 要求**实参键与形参名完全一致**。所以：
 *
 * - 每个方法都**恰好一个形参 `request`** —— 客户端固定发 `{ args: { request: {...} } }`；
 * - **不要**加 `signal` 形参（上游会把它当成取消通道并改变调用语义）；
 * - **不要**加第二个形参（同名 wire 会直接报错）。
 */
import type { MeetingConsole } from '../core/console.js';
/** Cordis 服务键，同时也是 wire 命名空间。客户端按 `meeting/<method>` 调用。 */
export declare const MEETING_REMOTE_SERVICE = "meetingConsole";
export declare const MEETING_REMOTE_NAMESPACE = "meeting";
/** 极窄的 ctx 视图：只要 provide。缺了它插件照常工作（只是没有面板数据）。 */
export interface DshRemoteContextFace {
    provide?(name: string, value: unknown, check?: unknown): unknown;
    get?(name: string): unknown;
}
export interface RegisterMeetingRemoteOptions {
    readonly ctx: unknown;
    readonly console: MeetingConsole;
}
export interface MeetingRemoteHandle {
    /** 是否真的登记成功。false 时面板会拿到 404，但宿主不该为此挂掉。 */
    readonly registered: boolean;
    readonly serviceKey: string;
    readonly namespace: string;
    readonly methods: readonly string[];
    /** 自解释的说明，进启动诊断。 */
    readonly notes: readonly string[];
    dispose(): void;
}
/**
 * 登记面板端点。
 *
 * **全链路尽力而为**：任何一步失败（宿主没有 `provide`、服务已被别人占用、
 * 上游改了描述符键……）都只记 `notes` 并返回 `registered: false`，
 * 绝不抛错。理由很直接——这是"给人看的面板"，它坏了不该让**整个 dsh 起不来**。
 */
export declare function registerMeetingRemote(options: RegisterMeetingRemoteOptions): MeetingRemoteHandle;
//# sourceMappingURL=dsh-meeting-remote.d.ts.map