/**
 * 会议室面板 —— 浏览器半边（DSH Web client 插件）。
 *
 * ## 为什么这个文件是手写的 JS，而不是从 src/ 编译出来
 *
 * DSH 的客户端插件契约只有一个：文件自己调
 * `window.__ModuleLoader__.load({ id, factory: (require) => module.exports })`，
 * 并返回一个 Cordis 插件 `{ name, inject, apply }`。`react` 由宿主通过注入的
 * `require` 提供。
 *
 * 也就是说**它根本不需要打包器**。上游那些客户端文件之所以是几百 KB 的 bundle，
 * 是因为它们用 TSX + 多个源文件；我们这里只有这一个文件、只用
 * `React.createElement`，直接手写反而更简单、更可读，也少了一层构建。
 *
 * ## 数据从哪来
 *
 * 浏览器读不到文件。数据经由 Typert Gateway 的**通用 RPC 通道**取：
 *
 * ```js
 * ctx.get('connection').rpc.call('/api', 'meeting/overview', { args: { request: {...} } })
 * ```
 *
 * 端点由宿主侧的 `src/adapters/dsh-meeting-remote.ts` 提供。
 * 实参形状必须与那边的方法形参名一致（都是单个 `request`），这是上游
 * `assertExactArguments` 的硬要求。
 *
 * ## 可见性
 *
 * 面板是**给人看的**，所以固定以 `human` 观察者身份调用 —— 能看全部房间。
 * 会话侧（Agent 调工具）看到的仍然是按会籍过滤的收窄视图，两边共用同一份数据面。
 */

window.__ModuleLoader__.load({
  id: 'dsh-meeting-coordinator',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-meeting'
    const HUMAN = 'human'
    const ENDPOINTS = {
      overview: 'meeting/overview',
      detail: 'meeting/detail',
      liveMeeting: 'meeting/liveMeeting',
      candidates: 'meeting/candidates',
      createRoom: 'meeting/createRoom',
      addSession: 'meeting/addSession',
      removeSession: 'meeting/removeSession',
      convene: 'meeting/convene',
    }

    const DICT_ZH = {
      entry: '会议室',
      title: '会议室',
      subtitle: '默认没有任何会议室，也没有任何成员。要开会就先建一个、再把空闲的会话加进去。',
      refresh: '刷新',
      close: '关闭',
      rooms: '会议室',
      noRooms: '还没有会议室。',
      newRoom: '新建会议室',
      newRoomPlaceholder: '会议室 id，例如 daily',
      create: '创建',
      members: '成员',
      noMembers: '这个会议室还没有成员。',
      addMember: '加入会话',
      noCandidates: '没有可以加入的会话（空闲的顶级会话才能加入）。',
      blocked: '加不了',
      remove: '移出',
      meetings: '历次会议',
      noMeetings: '还没有开过会。',
      convene: '召集会议',
      convened: '已散会',
      transcript: '发言',
      notes: '纪要',
      absent: '缺席',
      loading: '读取中…',
      failed: '读取失败',
      state: '状态',
      notLoaded: '未加载',
      notLoadedHint: '这个会话还没在当前进程里加载：可以加入，但借不到它的上下文（发言只有议题、没有背景）。点开它之后就有了。',
      live: '会议进行中',
      livePresent: '在场',
      liveAbsent: '未到场',
      kindEntry: '入场',
      kindSpeech: '发言',
      kindModerator: '主持人',
      kindHuman: '人类',
    }
    const DICT_EN = {
      entry: 'Meeting Rooms',
      title: 'Meeting Rooms',
      subtitle: 'No room and no member by default. Create a room, then add idle sessions to it.',
      refresh: 'Refresh',
      close: 'Close',
      rooms: 'Rooms',
      noRooms: 'No meeting room yet.',
      newRoom: 'New room',
      newRoomPlaceholder: 'room id, e.g. daily',
      create: 'Create',
      members: 'Members',
      noMembers: 'No member in this room yet.',
      addMember: 'Add session',
      noCandidates: 'No admittable session (only idle top-level sessions can join).',
      blocked: 'Blocked',
      remove: 'Remove',
      meetings: 'Past meetings',
      noMeetings: 'No meeting held yet.',
      convene: 'Call meeting',
      convened: 'Adjourned',
      transcript: 'Transcript',
      notes: 'Notes',
      absent: 'Absent',
      loading: 'Loading…',
      failed: 'Failed to load',
      state: 'State',
      notLoaded: 'not loaded',
      notLoadedHint: 'This session is not loaded in the current process: it can join, but its context cannot be borrowed (speech will have the agenda only). Open it to load it.',
      live: 'Meeting in progress',
      livePresent: 'Present',
      liveAbsent: 'Absent',
      kindEntry: 'entry',
      kindSpeech: 'speech',
      kindModerator: 'moderator',
      kindHuman: 'human',
    }

    // --- 主题自适应 -------------------------------------------------------
    // 不猜 CSS 变量名（上游换主题时会漂），直接量当前页面背景的亮度。
    // 面板是覆盖层，必须跟当前主题一致，否则浅色主题上糊一块深色。
    let paletteCache
    function palette() {
      if (paletteCache !== undefined) return paletteCache
      let dark = false
      try {
        const probe = document.body ?? document.documentElement
        const m = /rgba?\(([^)]+)\)/.exec(getComputedStyle(probe).backgroundColor ?? '')
        if (m !== null) {
          const parts = m[1].split(',').map((v) => Number.parseFloat(v))
          const [r = 255, g = 255, b = 255] = parts
          dark = (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
        }
      } catch {
        // 量不到就按浅色。宁可浅色，也不要因为探测失败把面板弄成隐形。
      }
      paletteCache = dark
        ? { ink: '#e8eaed', sub: '#9aa0a6', line: '#3c4043', surface: '#202124', soft: '#2a2b2e', accent: '#8ab4f8', danger: '#f28b82' }
        : { ink: '#1f2328', sub: '#656d76', line: '#d8dee4', surface: '#ffffff', soft: '#f6f8fa', accent: '#0969da', danger: '#cf222e' }
      return paletteCache
    }

    // --- 面板开合状态 -----------------------------------------------------
    // 用模块级 store + useSyncExternalStore：按钮和面板是**两个独立的槽位注册**，
    // 没有共享的 React 树，靠 props 传状态传不过去。
    let opened = false
    const watchers = new Set()
    const panelStore = {
      subscribe(listener) {
        watchers.add(listener)
        return () => watchers.delete(listener)
      },
      getSnapshot() {
        return opened
      },
      set(next) {
        if (opened === next) return
        opened = next
        for (const listener of [...watchers]) listener()
      },
    }
    function useOpenState() {
      return React.useSyncExternalStore(panelStore.subscribe, panelStore.getSnapshot)
    }

    // --- RPC --------------------------------------------------------------
    /** 通用 RPC 调用器；连接服务缺失时返回 undefined —— 每次读都做防御。 */
    function rpcOf(ctx) {
      try {
        const rpc = ctx.get('connection')?.rpc
        if (rpc !== null && typeof rpc === 'object' && typeof rpc.call === 'function') return rpc.call.bind(rpc)
      } catch {
        // 连接服务不存在/不友好：静默降级成"没有数据"，绝不抛到渲染里。
      }
      return undefined
    }

    /** 解开 `{ ok, value }` 信封；失败时抛出可显示的理由。 */
    function unwrap(response) {
      if (response !== null && typeof response === 'object' && 'ok' in response) {
        if (response.ok === true) return response.value
        const failure = response.error ?? response
        throw new Error(failure?.message ?? failure?.code ?? 'RPC 失败')
      }
      return response
    }

    function makeClient(ctx) {
      const call = rpcOf(ctx)
      return {
        available: call !== undefined,
        async invoke(endpoint, request) {
          if (call === undefined) throw new Error('连接服务不可用，无法读取会议室数据。')
          return unwrap(await call('/api', endpoint, { args: { request } }))
        },
        overview: () => undefined, // 占位，实际调用走 invoke
      }
    }

    // --- 样式 -------------------------------------------------------------
    function styles(p) {
      return {
        overlay: {
          position: 'fixed',
          inset: '0',
          zIndex: 2147483000,
          background: p.surface,
          color: p.ink,
          display: 'flex',
          flexDirection: 'column',
          fontSize: '13px',
          lineHeight: '1.55',
          fontFamily: 'inherit',
        },
        header: {
          display: 'flex',
          alignItems: 'center',
          gap: '10px',
          padding: '10px 14px',
          borderBottom: `1px solid ${p.line}`,
        },
        title: { fontSize: '15px', fontWeight: 600, margin: 0 },
        sub: { color: p.sub, fontSize: '12px', margin: '2px 0 0' },
        grow: { flex: '1 1 auto', minWidth: 0 },
        button: {
          font: 'inherit',
          fontSize: '12px',
          padding: '3px 10px',
          borderRadius: '6px',
          border: `1px solid ${p.line}`,
          background: p.soft,
          color: p.ink,
          cursor: 'pointer',
        },
        buttonPrimary: {
          font: 'inherit',
          fontSize: '12px',
          padding: '3px 10px',
          borderRadius: '6px',
          border: `1px solid ${p.accent}`,
          background: p.accent,
          color: p.surface,
          cursor: 'pointer',
        },
        buttonDanger: {
          font: 'inherit',
          fontSize: '12px',
          padding: '2px 8px',
          borderRadius: '6px',
          border: `1px solid ${p.line}`,
          background: 'transparent',
          color: p.danger,
          cursor: 'pointer',
        },
        body: { flex: '1 1 auto', display: 'flex', minHeight: 0 },
        aside: {
          width: '240px',
          borderRight: `1px solid ${p.line}`,
          overflowY: 'auto',
          padding: '10px',
          flex: '0 0 auto',
        },
        main: { flex: '1 1 auto', overflowY: 'auto', padding: '12px 16px', minWidth: 0 },
        roomItem: {
          padding: '6px 8px',
          borderRadius: '6px',
          cursor: 'pointer',
          display: 'flex',
          gap: '6px',
          alignItems: 'baseline',
        },
        section: { margin: '0 0 16px' },
        sectionTitle: {
          fontSize: '12px',
          fontWeight: 600,
          color: p.sub,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          margin: '0 0 6px',
        },
        row: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '5px 8px',
          border: `1px solid ${p.line}`,
          borderRadius: '6px',
          marginBottom: '5px',
        },
        mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: '12px' },
        meta: { color: p.sub, fontSize: '12px' },
        input: {
          font: 'inherit',
          fontSize: '12px',
          padding: '3px 8px',
          borderRadius: '6px',
          border: `1px solid ${p.line}`,
          background: 'transparent',
          color: p.ink,
        },
        meeting: {
          border: `1px solid ${p.line}`,
          borderRadius: '8px',
          marginBottom: '8px',
          overflow: 'hidden',
        },
        meetingHead: {
          padding: '6px 10px',
          background: p.soft,
          display: 'flex',
          gap: '8px',
          alignItems: 'baseline',
          flexWrap: 'wrap',
        },
        turn: { padding: '5px 10px', borderTop: `1px solid ${p.line}` },
        speaker: { fontWeight: 600 },
        err: { color: p.danger, padding: '8px 0', fontSize: '12px' },
      }
    }

    function formatTime(at) {
      try {
        return new Date(at).toLocaleString()
      } catch {
        return String(at)
      }
    }

    /** 会话 id 通常很长；面板里只显示可辨识的头尾。 */
    function shortId(id) {
      if (typeof id !== 'string') return String(id)
      return id.length <= 14 ? id : `${id.slice(0, 8)}…${id.slice(-4)}`
    }

    /** 会议记录的类型 → 人话。实时视图与历次会议共用一套词。 */
    const KIND_LABELS = { entry: 'kindEntry', speech: 'kindSpeech', moderator: 'kindModerator', human: 'kindHuman' }
    function kindLabel(kind, t) {
      const key = KIND_LABELS[kind]
      return key === undefined ? String(kind) : t(key)
    }

    /**
     * 会话的显示块：**标题在前，短 id 在后**。
     *
     * 只有 id 的时候面板里全是 `session-750e30ff-…`，人认不出是哪个会话——
     * 标题由宿主侧从 `sessionTitle` 服务读出来（见 `dsh-session-catalog.ts`）。
     * 标题缺席时（会话已关闭 / 还没有标题）退回只显示短 id，
     * 完整 id 挂在 `title` 属性上，悬停可见。
     */
    function sessionLabel(input, s) {
      const title = typeof input.title === 'string' && input.title.length > 0 ? input.title : undefined
      return h(
        'span',
        {
          key: 'label',
          title: input.sessionId,
          style: { ...s.grow, minWidth: 0, display: 'flex', flexDirection: 'column', gap: '1px' },
        },
        title === undefined
          ? [h('span', { key: 'i', style: { ...s.mono, ...s.meta } }, shortId(input.sessionId))]
          : [
              h(
                'span',
                { key: 't', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                title,
              ),
              h('span', { key: 'i', style: { ...s.mono, ...s.meta, fontSize: '11px' } }, shortId(input.sessionId)),
            ],
      )
    }

    // --- 面板 -------------------------------------------------------------
    //
    // ⚠️ 组件由**工厂**产出，`client` 在 `apply()` 期只构造一次。
    //
    // 踩过的坑（真机验证时面板点了没反应）：把 `makeClient(ctx)` 写在组件函数体里，
    // 每次渲染都会得到一个新对象，而 `useCallback(fn, [client])` /
    // `useEffect(fn, [open, reload])` 是**引用比较**——依赖永远在变 → 效果反复触发 →
    // `setState` → 再渲染 → 无限循环。表现为：按钮点得动，面板永远不出现。
    function makeMeetingPanel(ctx, client) {
      return function MeetingPanel(props) {
        const [state, setState] = React.useState({ loading: true, error: undefined, overview: undefined })
        const [selected, setSelected] = React.useState(undefined)
        const [detail, setDetail] = React.useState(undefined)
        const [candidates, setCandidates] = React.useState(undefined)
        // section 折叠态。**默认全部收起**：用户实测痛点是大量会话把「历次会议」挤到最下方，"
        // 收起后页面只剩几个紧凑标题，谁也挤不掉谁。
        // section 折叠态。**默认全部收起**：用户实测痛点是「大量会话把历次会议挤到最下方」，
        // 收起后页面只剩几个紧凑标题，谁也挤不掉谁。
        const [fold, setFold] = React.useState({ meetings: false, candidates: false, rejected: false })
        const [live, setLive] = React.useState(undefined)
        const [actionError, setActionError] = React.useState(undefined)
        const [busy, setBusy] = React.useState(false)
        const [draftRoom, setDraftRoom] = React.useState('')
        const open = useOpenState()
        const p = palette()

      const reloadOverview = React.useCallback(async () => {
        setState((prev) => ({ ...prev, loading: true, error: undefined }))
        try {
          const overview = await client.invoke(ENDPOINTS.overview, { viewerId: HUMAN })
          setState({ loading: false, error: undefined, overview })
        } catch (error) {
          setState({ loading: false, error: error?.message ?? String(error), overview: undefined })
        }
      }, [client])

      const reloadRoom = React.useCallback(
        async (roomId) => {
          if (roomId === undefined) {
            setDetail(undefined)
            setCandidates(undefined)
            return
          }
          try {
            const [roomDetail, roomCandidates] = await Promise.all([
              client.invoke(ENDPOINTS.detail, { roomId, viewerId: HUMAN }),
              client.invoke(ENDPOINTS.candidates, { roomId }),
            ])
            setDetail(roomDetail)
            setCandidates(roomCandidates)
          } catch (error) {
            setActionError(error?.message ?? String(error))
          }
        },
        [client],
      )

      /**
       * 实时会议视图。
       *
       * 为什么必须轮询：会议可能由**任何人**发起——面板按钮、Agent 调全局工具、
       * 停滞自动升级。只依赖"我点了召集"刷新的话，后两种全程看不到。
       * 轮询失败时保留上一帧（不打扰用户），下一轮再试。
       */
      const reloadLive = React.useCallback(async () => {
        try {
          const view = await client.invoke(ENDPOINTS.liveMeeting, { viewerId: HUMAN })
          setLive(view)
        } catch {
          // 连接抖动：保留上一帧，绝不让轮询把错误刷进 actionError。
        }
      }, [client])

      React.useEffect(() => {
        if (open) void reloadOverview()
      }, [open, reloadOverview])

      React.useEffect(() => {
        if (open) void reloadRoom(selected)
      }, [open, selected, reloadRoom])

      // 面板开着就每 2 秒问一次"有没有会在开"。散会后端点回 ok:false，
      // 视图自动消失，历次会议里随后就能看到这场会的完整记录。
      React.useEffect(() => {
        if (!open) return undefined
        void reloadLive()
        const timer = setInterval(() => void reloadLive(), 2000)
        return () => clearInterval(timer)
      }, [open, reloadLive])

      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') panelStore.set(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      // 实时记录自动跟随最新一条：会议进行中用户不该自己动手滚。
      const liveEndRef = React.useRef(null)
      const liveTurnCount = live?.ok === true ? (live.meeting.transcript ?? []).length : 0
      React.useEffect(() => {
        if (liveTurnCount === 0) return undefined
        const node = liveEndRef.current
        if (node !== null && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
        return undefined
      }, [liveTurnCount])

      if (!open) return null

      const s = styles(p)
      const rooms = state.overview?.rooms ?? []
      const t = (key) => (ctx.locale?.getLocale?.().active === 'en' ? DICT_EN[key] : DICT_ZH[key]) ?? key

      /** 每个动作都自己收错：一个按钮失败不该让整个面板白屏。 */
      const run = (fn) => {
        if (busy) return
        setBusy(true)
        setActionError(undefined)
        Promise.resolve()
          .then(fn)
          .catch((error) => setActionError(error?.message ?? String(error)))
          .finally(() => setBusy(false))
      }

      const onCreateRoom = () =>
        run(async () => {
          const id = draftRoom.trim()
          if (id === '') return
          const result = await client.invoke(ENDPOINTS.createRoom, { id })
          if (result?.ok === false) throw new Error(result.reason)
          setDraftRoom('')
          await reloadOverview()
          setSelected(id)
        })

      const onAdd = (sessionId) =>
        run(async () => {
          const result = await client.invoke(ENDPOINTS.addSession, { roomId: selected, sessionId })
          if (result?.ok === false) throw new Error(result.reason)
          await Promise.all([reloadOverview(), reloadRoom(selected)])
        })

      const onRemove = (sessionId) =>
        run(async () => {
          const result = await client.invoke(ENDPOINTS.removeSession, { roomId: selected, sessionId })
          if (result?.ok === false) throw new Error(result.reason)
          await Promise.all([reloadOverview(), reloadRoom(selected)])
        })

      const onConvene = () =>
        run(async () => {
          const result = await client.invoke(ENDPOINTS.convene, { roomId: selected })
          if (result?.ok === false) throw new Error(result.reason)
          // 立刻拉一次实时视图：会议是异步跑的，等 2 秒轮询会让第一帧晚一步。
          await Promise.all([reloadOverview(), reloadRoom(selected), reloadLive()])
        })

      const roomChildren = [
        h(
          'div',
          { key: 'head', style: s.sectionTitle },
          `${t('rooms')}${rooms.length === 0 ? '' : ` · ${rooms.length}`}`,
        ),
        ...(rooms.length === 0
          ? [h('div', { key: 'empty', style: s.meta }, t('noRooms'))]
          : rooms.map((room) =>
              h(
                'div',
                {
                  key: room.id,
                  style: {
                    ...s.roomItem,
                    background: room.id === selected ? p.soft : 'transparent',
                    border: room.id === selected ? `1px solid ${p.line}` : '1px solid transparent',
                  },
                  onClick: () => setSelected(room.id),
                },
                [
                  h('span', { key: 'id', style: s.mono }, room.id),
                  h(
                    'span',
                    { key: 'count', style: s.meta },
                    room.meetingCount === undefined ? '' : `${room.meetingCount} 次`,
                  ),
                ],
              ),
            )),
      ]

      const detailChildren = []
      if (selected === undefined) {
        detailChildren.push(h('div', { key: 'pick', style: s.meta }, '← 先选一个会议室'))
      } else {
        const room = detail?.ok === true ? detail.room : undefined
        const meetings = detail?.ok === true ? detail.meetings : []

        // 实时视图：**正在开**的这场会。只显示当前选中房间的那场
        // （人类观察者能看到全部房间的会，但一次只看一个房间，别互相打扰）。
        const liveMeeting = live?.ok === true ? live.meeting : undefined
        if (liveMeeting !== undefined && liveMeeting.roomId === selected) {
          const liveTurns = liveMeeting.transcript ?? []
          detailChildren.push(
            // data-testid 给端到端测试一个稳定锚点（UI 改版不该让 e2e 失效）。
            h('div', { key: 'live', 'data-testid': 'meeting-live', style: { ...s.section, border: `1px solid ${p.accent}`, borderRadius: '8px', padding: '10px 12px', background: p.soft } }, [
              h('div', { key: 'h', style: { display: 'flex', gap: '8px', alignItems: 'baseline', flexWrap: 'wrap' } }, [
                h('span', { key: 'dot', style: { color: p.accent, fontWeight: 700 } }, '●'),
                h('span', { key: 't', style: { fontWeight: 700 } }, t('live')),
                h('span', { key: 'id', style: s.mono }, liveMeeting.meetingId),
                h('span', { key: 'r', style: s.meta }, `第 ${liveMeeting.round}/${liveMeeting.maxRounds} 轮`),
                h('span', { key: 's', style: s.meta }, liveMeeting.scope === 'global' ? '大会' : '小会'),
                h('span', { key: 'c', style: s.meta }, `召集者 ${liveMeeting.calledBy}`),
              ]),
              h('div', { key: 'reason', style: { ...s.meta, marginTop: '2px' } }, liveMeeting.reason),
              h('div', { key: 'who', style: { ...s.meta, marginTop: '2px' } }, [
                `${t('livePresent')}: ${(liveMeeting.present ?? []).join('、') || '无'}`,
                (liveMeeting.absent ?? []).length > 0 ? `｜${t('liveAbsent')}: ${liveMeeting.absent.join('、')}` : '',
              ]),
              h(
                'div',
                { key: 'turns', style: { marginTop: '8px', maxHeight: '240px', overflowY: 'auto' } },
                liveTurns.map((turn) =>
                  h('div', { key: `lt-${turn.seq}`, 'data-turn-seq': String(turn.seq), 'data-turn-kind': String(turn.kind), style: s.turn }, [
                    h('span', { key: 's', style: { ...s.speaker, color: p.accent } }, `${turn.speaker} · r${turn.round} · `),
                    h('span', { key: 'k', style: s.meta }, `${kindLabel(turn.kind, t)} `),
                    h(
                      'span',
                      { key: 'x', style: turn.kind === 'moderator' || turn.kind === 'entry' ? { ...s.meta } : undefined },
                      turn.text,
                    ),
                  ]),
                ),
              ),
              // 自动跟随的锚点：不可见，只在记录增长时把容器滚到底。
              h('div', { key: 'end', ref: liveEndRef }),
            ]),
          )
        }

        detailChildren.push(
          h('div', { key: 'title', style: s.section }, [
            h('div', { style: s.title }, room?.name ?? selected),
            h('div', { style: s.sub }, `${t('state')}: ${detail?.ok === false ? detail.reason : 'ok'}`),
            h(
              'div',
              { style: { marginTop: '8px', display: 'flex', gap: '8px' } },
              [
                h(
                  'button',
                  { key: 'convene', type: 'button', style: s.buttonPrimary, disabled: busy, onClick: onConvene },
                  t('convene'),
                ),
                h(
                  'button',
                  { key: 'refresh', type: 'button', style: s.button, disabled: busy, onClick: () => reloadRoom(selected) },
                  t('refresh'),
                ),
              ],
            ),
          ]),
        )

        // 成员
        detailChildren.push(
          h('div', { key: 'members', style: s.section }, [
            h('div', { key: 'h', style: s.sectionTitle }, t('members')),
            ...((room?.members ?? []).length === 0
              ? [h('div', { key: 'empty', style: s.meta }, t('noMembers'))]
              : (room?.members ?? []).map((member) =>
                  h('div', { key: member.sessionId, style: s.row }, [
                    sessionLabel(member, s),
                    member.model === undefined ? null : h('span', { key: 'm', style: s.meta }, member.model),
                    member.state === undefined ? null : h('span', { key: 's', style: s.meta }, member.state),
                    h(
                      'button',
                      { key: 'x', type: 'button', style: s.buttonDanger, disabled: busy, onClick: () => onRemove(member.sessionId) },
                      t('remove'),
                    ),
                  ]),
                )),
          ]),
        )

        // 候选
        // 可折叠 section 标题：点标题开/合。
        const foldHead = (key, title, count) =>
          h('div',
            {
              key: 'h',
              style: { ...s.sectionTitle, cursor: 'pointer', userSelect: 'none' },
              'data-testid': `fold-${key}`,
              onClick: () => setFold((o) => ({ ...o, [key]: !o[key] })),
            },
            `${fold[key] ? '▾' : '▸'} ${title}${count === undefined ? '' : ` · ${count}`}`,
          )

        const admittable = candidates?.admittable ?? []
        const rejected = candidates?.rejected ?? []
        // **子代理/子会话直接不进候选**：它们本来就不是"可加入的会话"，
        // 混进来只会把真人会话淹没（用户实测痛点）。只在计数里体现，不占版面。
        const rejectedShown = rejected.filter((entry) => entry.candidate?.isSubagent !== true)
        const hiddenSubagents = rejected.length - rejectedShown.length
        detailChildren.push(
          h('div', { key: 'candidates', style: s.section }, [
            foldHead('candidates', t('addMember'), admittable.length + rejectedShown.length),
            hiddenSubagents > 0 && fold.candidates
              ? h('div', { key: 'hidden', style: s.meta }, `另有 ${hiddenSubagents} 个子代理/子会话未列出（它们不是可加入的会话）`)
              : null,
            ...(fold.candidates
              ? [
            ...(admittable.length === 0 && rejected.length === 0
              ? [h('div', { key: 'empty', style: s.meta }, t('noCandidates'))]
              : []),
            ...admittable.map((candidate) =>
              h('div', { key: candidate.sessionId, style: s.row }, [
                sessionLabel(candidate, s),
                candidate.loaded === false
                  ? h(
                      'span',
                      { key: 'nl', style: { ...s.meta, border: `1px solid ${p.line}`, borderRadius: '4px', padding: '0 4px' }, title: t('notLoadedHint') },
                      t('notLoaded'),
                    )
                  : null,
                candidate.model === undefined ? null : h('span', { key: 'm', style: s.meta }, candidate.model),
                h(
                  'button',
                  { key: 'a', type: 'button', style: s.button, disabled: busy, onClick: () => onAdd(candidate.sessionId) },
                  t('addMember'),
                ),
              ]),
            ),
            rejected.length === 0
              ? null
              : h('div', { key: 'rejfold', style: { ...s.meta, cursor: 'pointer', userSelect: 'none' }, 'data-testid': 'fold-rejected', onClick: () => setFold((o) => ({ ...o, rejected: !o.rejected })) },
                  `${fold.rejected ? '▾' : '▸'} ${t('blocked')} · ${rejectedShown.length}`),
            ...(fold.rejected ? rejectedShown.map((entry) =>
              h('div', { key: `rej-${entry.candidate.sessionId}`, style: { ...s.row, opacity: 0.7 } }, [
                // 加不了的会话：标题在前（认得出是谁），理由占满剩余宽度。
                h(
                  'span',
                  {
                    key: 't',
                    style: { flex: '0 0 auto', ...s.mono, ...s.meta },
                    title: entry.candidate.sessionId,
                  },
                  entry.candidate.title ?? shortId(entry.candidate.sessionId),
                ),
                h('span', { key: 'r', style: { ...s.meta, ...s.grow } }, entry.reason),
                h('span', { key: 'c', style: s.meta }, t('blocked')),
              ]),
            ) : []),
              ]
              : []),
          ]),
        )

        // 历次会议（默认收起：未来会有很多场，不能挤掉别的）
        detailChildren.push(
          h('div', { key: 'meetings', style: s.section }, [
            foldHead('meetings', t('meetings'), meetings.length),
            ...(meetings.length === 0
              ? [h('div', { key: 'empty', style: s.meta }, t('noMeetings'))]
              : meetings.map((meeting) =>
                  h('div', { key: meeting.meetingId, style: s.meeting }, [
                    h('div', { key: 'h', style: s.meetingHead }, [
                      h('span', { key: 'a', style: s.mono }, meeting.meetingId),
                      h('span', { key: 'b', style: s.meta }, formatTime(meeting.at)),
                      h('span', { key: 'c', style: s.meta }, `${meeting.rounds} 轮`),
                      h('span', { key: 'd', style: s.meta }, meeting.adjournedReason),
                    ]),
                    h('div', { key: 'g', style: { ...s.turn, color: p.sub, fontSize: '12px' } }, meeting.reason),
                    ...meeting.transcript.map((turn) =>
                      h('div', { key: `t-${turn.seq}`, style: s.turn }, [
                        h('span', { key: 's', style: { ...s.speaker, color: p.accent } }, `${turn.speaker} · r${turn.round} · `),
                        h('span', { key: 'k', style: s.meta }, `${kindLabel(turn.kind, t)} `),
                        h('span', { key: 'x' }, turn.text),
                      ]),
                    ),
                    ...meeting.notes.map((note) =>
                      h('div', { key: `n-${note.participant}`, style: s.turn }, [
                        h('span', { key: 's', style: s.speaker }, `${t('notes')} → ${note.participant}: `),
                        h('span', { key: 'x' }, note.text),
                      ]),
                    ),
                  ]),
                )),
          ]),
        )
      }

      return h('div', { style: s.overlay }, [
        h('div', { key: 'header', style: s.header }, [
          h('div', { key: 'grow', style: s.grow }, [
            h('h2', { key: 't', style: s.title }, t('title')),
            h('p', { key: 's', style: s.sub }, t('subtitle')),
          ]),
          h(
            'button',
            { key: 'refresh', type: 'button', style: s.button, disabled: busy, onClick: () => run(async () => { await reloadOverview(); await reloadRoom(selected) }) },
            t('refresh'),
          ),
          h('button', { key: 'close', type: 'button', style: s.button, onClick: () => panelStore.set(false) }, t('close')),
        ]),
        state.error === undefined ? null : h('div', { key: 'err', style: { ...s.err, padding: '8px 14px' } }, `${t('failed')}: ${state.error}`),
        actionError === undefined ? null : h('div', { key: 'aerr', style: { ...s.err, padding: '0 14px' } }, actionError),
        h('div', { key: 'body', style: s.body }, [
          h('div', { key: 'aside', style: s.aside }, [
            ...roomChildren,
            h('div', { key: 'new', style: { marginTop: '12px', borderTop: `1px solid ${p.line}`, paddingTop: '10px' } }, [
              h('div', { key: 'h', style: s.sectionTitle }, t('newRoom')),
              h('div', { key: 'r', style: { display: 'flex', gap: '6px' } }, [
                h('input', {
                  key: 'i',
                  style: { ...s.input, ...s.grow },
                  value: draftRoom,
                  placeholder: t('newRoomPlaceholder'),
                  onChange: (event) => setDraftRoom(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter') onCreateRoom()
                  },
                }),
                h('button', { key: 'b', type: 'button', style: s.button, disabled: busy, onClick: onCreateRoom }, t('create')),
              ]),
            ]),
          ]),
          h('div', { key: 'main', style: s.main }, detailChildren),
        ]),
      ])
      }
    }

    /** 入口按钮：挂在侧栏底部。 */
    function MeetingEntryButton(props) {
      const open = useOpenState()
      const p = palette()
      const s = styles(p)
      const wide = props?.wide === true
      return h(
        'button',
        {
          type: 'button',
          title: DICT_ZH.entry,
          'aria-label': DICT_ZH.entry,
          onClick: () => panelStore.set(!open),
          style: {
            ...s.button,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            width: '100%',
            padding: '4px 8px',
          },
        },
        [h('span', { key: 'i' }, '🗂'), wide ? h('span', { key: 'l' }, DICT_ZH.entry) : null],
      )
    }

    /** 渲染期异常兜底：面板坏了也必须只坏自己，不能把整个界面带白屏。 */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: undefined }
      }
      static getDerivedStateFromError(error) {
        return { failed: error?.message ?? String(error) }
      }
      render() {
        if (this.state.failed !== undefined) {
          return h('div', { style: { position: 'fixed', inset: 'auto 16px 16px auto', background: '#fff', color: '#cf222e', padding: '10px 14px', border: '1px solid #cf222e', borderRadius: '8px', zIndex: 2147483000, fontSize: '12px' } }, `会议室面板出错：${this.state.failed}`)
        }
        return this.props.children ?? null
      }
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN }), 'dsh-meeting: dictionaries')

      // 客户端与面板组件**只构造一次**：放进组件体会让依赖每次渲染都变，
      // 从而触发无限渲染循环（见 makeMeetingPanel 上方注释）。
      const client = makeClient(ctx)
      const MeetingPanel = makeMeetingPanel(ctx, client)

      // 侧栏入口 —— 面板的可见入口就是这个按钮。
      // 之前插件在 UI 上**什么都没有**，用户只能看到文件在动，这是最直接的体验缺口。
      ctx.slots.inject('sidebar.footer.action', () =>
        ctx.slots.register({ name: 'sidebar.footer.action', id: 'meeting-console', order: 30, locale: NS }, (props) =>
          h(MeetingEntryButton, props),
        ),
      )

      // 面板本体：覆盖层（`shell.overlay` 是 kind=list / scope=root，也就是全局可叠加层）。
      // 与按钮是两个独立注册，靠模块级 store 联通开合。
      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({ name: 'shell.overlay', id: 'meeting-console', order: 30, locale: NS }, () =>
          h(PanelBoundary, null, h(MeetingPanel, {})),
        ),
      )
    }

    /**
     * 注册进浏览器侧 Cordis 容器。
     *
     * `inject` 是**客户端服务名**（不是包名）：`slots` 提供槽位注册，
     * `locale` 提供字典。两个都由 dsh 的 web 基础层提供。
     */
    module.exports = {
      name: 'dsh-meeting-coordinator',
      inject: ['slots', 'locale'],
      apply,
    }
    return module.exports
  },
})
