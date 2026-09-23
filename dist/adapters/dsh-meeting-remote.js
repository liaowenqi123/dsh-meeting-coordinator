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
import { HUMAN_PARTICIPANT } from '../core/participant.js';
/** Cordis 服务键，同时也是 wire 命名空间。客户端按 `meeting/<method>` 调用。 */
export const MEETING_REMOTE_SERVICE = 'meetingConsole';
export const MEETING_REMOTE_NAMESPACE = 'meeting';
/**
 * Remote 方法描述符的键。
 *
 * ⚠️ 这是**上游私有契约的字面量复刻**。上游 `dsh-typert-protocol` 用的是同一个字符串常量。
 * 上游改了这个键，这里就会静默失效（表现为端点 404 而不是崩溃）——
 * 所以 {@link registerMeetingRemote} 会把自己登记的名字回报给调用方，
 * 便于启动诊断里核对。
 */
const REMOTE_METHOD_DESCRIPTOR = '@deepseek-ai/dsh-typert-protocol/remote-methods';
/** 暴露出去的端点（`meeting/<名字>`）。顺序即面板的调用顺序，无语义。 */
const REMOTE_METHODS = [
    'overview',
    'detail',
    'liveMeeting',
    'candidates',
    'createRoom',
    'addSession',
    'removeSession',
    'convene',
];
/** 从任意 payload 里取一个非空字符串；取不到就回退。 */
function textOf(value, fallback) {
    return typeof value === 'string' && value.length > 0 ? value : fallback;
}
function recordOf(value) {
    return typeof value === 'object' && value !== null ? value : {};
}
/**
 * 构造服务对象。
 *
 * 方法定义在一个**独立原型对象**上（不是类实例的属性），因为
 * `remoteMethods()` 读的是 `Object.getPrototypeOf(service)` 上的自有描述符。
 * 用 `Object.create(prototype)` 让实例本身保持"空"，协议面全在原型上。
 */
function buildService(console) {
    const prototype = {
        /** 全部房间 + 我自己在哪。面板首屏。 */
        async overview(request) {
            const input = recordOf(request);
            return console.overview(textOf(input['viewerId'], HUMAN_PARTICIPANT));
        },
        /** 单个房间：成员名单 + 历次会议正文（最新在前）。 */
        async detail(request) {
            const input = recordOf(request);
            return console.detail(String(input['roomId'] ?? ''), textOf(input['viewerId'], HUMAN_PARTICIPANT));
        },
        /** 正在开的会议（实时视图）。没有会正在开时 `ok:false` + 理由，属正常分支。 */
        async liveMeeting(request) {
            const input = recordOf(request);
            return console.liveMeeting(textOf(input['viewerId'], HUMAN_PARTICIPANT));
        },
        /** 某房间的候选会话：能加的 / 加不了的（附理由）。面板直接渲染这个。 */
        async candidates(request) {
            const input = recordOf(request);
            const operation = input['operation'] === 'leave' ? 'leave' : 'join';
            return console.candidatesFor(String(input['roomId'] ?? ''), operation);
        },
        async createRoom(request) {
            const input = recordOf(request);
            const id = String(input['id'] ?? '').trim();
            if (id.length === 0) {
                return { ok: false, code: 'invalid-room-id', reason: '会议室 id 不能为空。' };
            }
            const name = typeof input['name'] === 'string' ? input['name'] : undefined;
            return console.createRoom(name === undefined ? { id } : { id, name });
        },
        async addSession(request) {
            const input = recordOf(request);
            return console.addSession(String(input['roomId'] ?? ''), String(input['sessionId'] ?? ''));
        },
        async removeSession(request) {
            const input = recordOf(request);
            return console.removeSession(String(input['roomId'] ?? ''), String(input['sessionId'] ?? ''));
        },
        /** 面板上的"开会"按钮。只回召集者（这里是 human）自己那份纪要。 */
        async convene(request) {
            const input = recordOf(request);
            const invitees = Array.isArray(input['invitees'])
                ? input['invitees'].filter((value) => typeof value === 'string')
                : undefined;
            return console.convene({
                roomId: String(input['roomId'] ?? ''),
                calledBy: textOf(input['calledBy'], HUMAN_PARTICIPANT),
                reason: textOf(input['reason'], '人类从会议室面板召集。'),
                scope: input['scope'] === 'local' ? 'local' : 'global',
                ...(invitees === undefined ? {} : { invitees }),
            });
        },
    };
    // 描述符必须是原型的**自有属性**：上游用 getOwnPropertyDescriptor 读。
    Object.defineProperty(prototype, REMOTE_METHOD_DESCRIPTOR, {
        value: Object.freeze({
            version: 1,
            methods: Object.freeze(REMOTE_METHODS.map((method) => Object.freeze({ method, invocation: Object.freeze({ kind: 'direct' }) }))),
        }),
        writable: false,
        enumerable: false,
        configurable: false,
    });
    const service = Object.create(prototype);
    // binding.service 必须与 gateway 手里的服务实例**严格相等**，所以在这里回指自己。
    service['typertRemote'] = Object.freeze({
        service,
        serviceKey: MEETING_REMOTE_SERVICE,
        namespace: MEETING_REMOTE_NAMESPACE,
    });
    return service;
}
/**
 * 登记面板端点。
 *
 * **全链路尽力而为**：任何一步失败（宿主没有 `provide`、服务已被别人占用、
 * 上游改了描述符键……）都只记 `notes` 并返回 `registered: false`，
 * 绝不抛错。理由很直接——这是"给人看的面板"，它坏了不该让**整个 dsh 起不来**。
 */
export function registerMeetingRemote(options) {
    const notes = [];
    const ctx = options.ctx;
    const base = {
        serviceKey: MEETING_REMOTE_SERVICE,
        namespace: MEETING_REMOTE_NAMESPACE,
        methods: [...REMOTE_METHODS],
    };
    if (typeof ctx?.provide !== 'function') {
        return {
            ...base,
            registered: false,
            notes: ['宿主 ctx 没有 provide()，会议室面板拿不到数据（其余功能不受影响）。'],
            dispose: () => { },
        };
    }
    let dispose;
    try {
        const service = buildService(options.console);
        const returned = ctx.provide(MEETING_REMOTE_SERVICE, service);
        // ctx.provide 返回的是 Cordis effect 的清理器（或一个 Promise）。两种都接住。
        if (typeof returned === 'function') {
            const fn = returned;
            dispose = () => {
                try {
                    void fn();
                }
                catch {
                    // 清理失败不该影响卸载流程。
                }
            };
        }
        else if (returned !== undefined && returned !== null && typeof returned.then === 'function') {
            void returned.catch(() => { });
        }
        notes.push(`已注册会议室面板端点 ${MEETING_REMOTE_NAMESPACE}/<${REMOTE_METHODS.join(', ')}>（Cordis 服务 ${MEETING_REMOTE_SERVICE}）。`);
    }
    catch (error) {
        return {
            ...base,
            registered: false,
            notes: [`注册会议室面板端点失败：${error instanceof Error ? error.message : String(error)}`],
            dispose: () => { },
        };
    }
    return {
        ...base,
        registered: true,
        notes,
        dispose: () => {
            dispose?.();
        },
    };
}
//# sourceMappingURL=dsh-meeting-remote.js.map