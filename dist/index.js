/**
 * dsh-meeting-coordinator 公共 API。
 *
 * 分层刻意清晰，方便宿主按需只取自己需要的部分：
 *
 * - `core/`    领域模型、简报板、停滞检测、触发规则、协调器 —— **零 dsh-std 与零 DSH 依赖**，
 *              可在纯 node 环境里毫秒级测试；
 * - `protocol/` 私有协议 `meeting.dsh/v1alpha1` 的 core `ProtocolDefinition`；
 * - `ports/`   协调器与上游运行时之间的唯一边界；
 * - `adapters/` 唯一接触上游形状的地方（DSH 结构化鸭子类型 + 内存测试替身）；
 * - `facet`    dsh-std lifecycle/facet 入口。
 */
// --- 简报预算 ---------------------------------------------------------------
export { BriefingBudgetExceeded, BriefingInvalid, DEFAULT_MAX_BRIEFING_CHARS, assertDraftWellFormed, assertWithinBudget, briefingCharCount, briefingFingerprint, countChars, fnv1a64, normalizeField, } from './core/briefing-text.js';
// --- 简报板 -----------------------------------------------------------------
export { BoardCorrupted, BriefingBoard } from './core/briefing-board.js';
// --- 停滞检测 ---------------------------------------------------------------
export { DEFAULT_STALL_OPTIONS, detectStall, } from './core/stall-detector.js';
// --- 触发规则 ---------------------------------------------------------------
export { DEFAULT_TRIGGER_POLICY, demandTrigger, evaluateTriggers, } from './core/triggers.js';
// --- 协调器 -----------------------------------------------------------------
export { DEFAULT_COORDINATOR_POLICY, MeetingCoordinator, } from './core/coordinator.js';
// --- 协议 -------------------------------------------------------------------
export { BRIEFING_BOARD_KIND, DEFAULT_MAX_AGENDA_CHARS, MEETING_API_VERSION, briefingBoardProtocol, } from './protocol/meeting-protocol.js';
// --- 参与者与状态机 ---------------------------------------------------------
export { AgentParticipant, HUMAN_PARTICIPANT, ParticipantStateError, } from './core/participant.js';
// --- 会议室（持久实体 + 排他会籍）------------------------------------------
export { RoomRegistry, RoomRegistryError, } from './core/room-registry.js';
// --- 会议室（多轮群聊）------------------------------------------------------
export { DEFAULT_ENTRY_PROMPT, DEFAULT_ROOM_POLICY, MeetingRoom, MeetingRoomError, } from './core/meeting-room.js';
// --- 主持人（有控场权，没有上下文）------------------------------------------
export { buildModeratorPrompt, parseModeratorDecision, safeFallback, } from './core/moderator.js';
// --- 会后个性化压缩 ---------------------------------------------------------
export { DEFAULT_MINUTES_MAX_CHARS, MinutesError, RELEVANCE_RULES, buildReflectionPrompt, validateMinutes, } from './core/minutes.js';
// --- 会议编排器 -------------------------------------------------------------
export { MeetingOrchestrator, MeetingOrchestratorError, buildSpeechPrompt, } from './core/room-orchestrator.js';
// --- 声音端口与实现 ---------------------------------------------------------
export { VoiceUnavailable, } from './ports/meeting-voice.js';
export { ScriptedMeetingVoice, } from './adapters/scripted-voice.js';
export { RoundRobinModerator, ScriptedModerator, } from './adapters/moderators.js';
// --- 运行时端口 -------------------------------------------------------------
export { RuntimeUnavailable, } from './ports/agent-runtime.js';
// --- 适配器 -----------------------------------------------------------------
export { InMemoryAgentRuntime } from './adapters/in-memory-runtime.js';
export { createDshMeetingRuntime, isFace, readService, teammateName, } from './adapters/dsh-team-runtime.js';
export { createDshMeetingVoice, createDshModerator, createDshOneShotRunner, extractOutput, } from './adapters/dsh-meeting-voice.js';
export { BOUNDARY_EVENT, SESSION_EVENT_CHANNEL, attachDshBoundaryWatcher, readSessionId, } from './adapters/dsh-boundary-watcher.js';
export { ACTIVITY_EVENT, attachDshSessionState, } from './adapters/dsh-session-state.js';
// --- facet ------------------------------------------------------------------
export { MeetingRegistry, PROTOCOL_REFERENCE, createAgentFacet, createCoordinatorFacet, } from './facet.js';
// --- 宿主装配 ---------------------------------------------------------------
export { AGENT_FACET_PREFIX, COORDINATOR_FACET, MEETING_DRIVER_ID, activateMeetingHost, apply, readSlotsFromEnv, renderBriefingInstruction, selectRoomInvitees, } from './host.js';
export { apply as default } from './host.js';
//# sourceMappingURL=index.js.map