/**
 * 会议数据根的解析——**只有这一处**。
 *
 * ## 为什么这件事值得单独一个文件
 *
 * 原来三个入口各自写了一遍"config > env > `join(process.cwd(), '.dsh-meeting')`"：
 * `host.ts` 的 `apply()`、`dsh-meeting-tool.ts` 的停会标志、`submit-briefing.ts` 的 CLI。
 * 三份默认值写在三个地方，就已经够糟了；更糟的是默认值本身选错了坐标。
 *
 * ## 默认值为什么不能是 `process.cwd()`
 *
 * 实测事故（2026-09-23）：默认值是 `join(process.cwd(), '.dsh-meeting')`，
 * 而 **DSH 进程的 cwd 是不可控的**——它由"用户从哪个目录敲下 `dsh web`"决定，
 * 跟当前会话、跟工作区都没有关系。结果那次重启后插件把数据根落到了
 * `D:\...\毕业项目\我先来试一波量化\quant-backtest-tool\.dsh-meeting`，
 * 一个**跟本插件毫无关系的项目**里，于是会议室全都不见了。
 *
 * 用 cwd 的失败模式是"**静默且看似成功**"：插件照常启动、面板照常出现、
 * `startup.jsonl` 照常写——只是写进了另一个目录。没有报错，没有警告，
 * 只有一个空房间列表。这种错最难查，所以默认值必须选一个**不依赖启动目录**的坐标。
 *
 * ## 选 `DSH_HOME`
 *
 * DSH 自己就用 `DSH_HOME`（默认 `~/.dsh`）放 sessions / storages / profiles——
 * 也就是说宿主已经把"跨工作区共享的状态该放哪"回答过了。会议数据是同一类东西：
 * 跨工作区的持久实体（成员可能跨 workspace），理应与会话数据同处一个可预期的位置。
 *
 * 另外这也让 README 里那条"跨工作区成员"的承诺在**存储层**成立：
 * 数据根不再随启动目录漂移，才不会出现"隔壁工作区开会，房间却不见了"。
 *
 * ## 优先级
 *
 * `config.rootDir` > `DSH_MEETING_ROOT` > `$DSH_HOME/meeting-coordinator` > `~/.dsh/meeting-coordinator`
 *
 * config 优先于 env 是刻意保留的：显式配置应当压过环境变量。
 * 但也正因为如此，装了插件的人**不该在 `cordis.patch.yml` 里写死 rootDir**——
 * 写死了就没法用环境变量改，而绝对路径写进清单对别人就是一个不存在的目录。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
/** 数据根下的目录名。放在 DSH_HOME 里，与会话数据同级。 */
export const MEETING_ROOT_DIRNAME = 'meeting-coordinator';
/** 覆盖数据根的环境变量。 */
export const MEETING_ROOT_ENV = 'DSH_MEETING_ROOT';
/** 覆盖板标识的环境变量。 */
export const MEETING_BOARD_ENV = 'DSH_MEETING_BOARD';
/**
 * 兜底的数据根：`$DSH_HOME/meeting-coordinator`。
 *
 * `DSH_HOME` 为空串时按"未设置"处理——空串是个常见的配置事故，
 * 拼出 `/meeting-coordinator` 这种根路径比回退到 `~/.dsh` 危险得多。
 */
export function defaultMeetingRootDir(env = process.env) {
    const home = env['DSH_HOME'];
    const base = typeof home === 'string' && home.trim().length > 0 ? home : join(homedir(), '.dsh');
    return join(base, MEETING_ROOT_DIRNAME);
}
/**
 * 按 `config > env > 默认值` 解析会议数据根。
 *
 * `configRootDir` 允许是空串：空串同样按"未设置"处理，免得 `join('', ...)`
 * 把数据写到进程 cwd 下——那正是本次要修掉的行为。
 */
export function resolveMeetingRootDir(configRootDir, env = process.env) {
    const fromConfig = nonEmpty(configRootDir);
    if (fromConfig !== undefined)
        return fromConfig;
    const fromEnv = nonEmpty(env[MEETING_ROOT_ENV]);
    if (fromEnv !== undefined)
        return fromEnv;
    return defaultMeetingRootDir(env);
}
/** 板标识：`config > env > 'default'`。板标识与数据根是两件事，别混在一个解析器里。 */
export function resolveMeetingBoardDomain(configBoardDomain, env = process.env) {
    return nonEmpty(configBoardDomain) ?? nonEmpty(env[MEETING_BOARD_ENV]) ?? 'default';
}
function nonEmpty(value) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
//# sourceMappingURL=meeting-root.js.map