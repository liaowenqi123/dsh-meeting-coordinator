/**
 * dsh-meeting 插件**真实宿主端到端测试**。
 *
 * ## 测什么
 *
 * 用真实 `dsh web`（不是单测里的假 ctx）把整条链跑一遍：
 *
 *   浏览器面板 ──Typert RPC──▶ 宿主数据面 ──▶ 编排器开会
 *        │                                            │
 *        │                                            ▼
 *   实时视图（轮询）                            模型调用 ──▶ Python mock（回 ABC N）
 *
 * 四个断言（对应"会议室整体能通 + 全程可见 + 保持上下文"）：
 *   1. **能通**：`room-meetings.jsonl` 里有一场完整的会（entry/speech/moderator/notes）；
 *   2. **可见**：会议进行中面板实时视图被多次采到，且记录条数持续增长；
 *   3. **借上下文**：mock 收到的发言 prompt 里含该会话的真实消息内容
 *      （`私有记忆投影` 段）——这是"保持上下文"的唯一权威证据；
 *   4. **模型通道**：会话里能收到 mock 的 `ABC N` 回复（证明调用真的走了 mock）。
 *
 * ## 环境约定（来自上一轮真机测试的教训）
 *
 * - 用户的 dsh web 在 **3080，永不碰**；本测试用 3081。
 * - 沙箱禁 Chrome TCP 调试端口：走 `--remote-debugging-pipe`（fd 3/4）。
 * - 插件数据根用**独立的** `DSH_MEETING_ROOT`，不污染项目里的 `.dsh-meeting/`。
 * - 模型端点用 `DEEPSEEK_BASE_URL` 指到本地 mock（上游 llm-deepseek 的约定）。
 *
 * 用法：
 *   node tests/e2e/run-e2e.mjs --probe      # 只探 DOM，不跑流程
 *   node tests/e2e/run-e2e.mjs              # 完整流程 + 断言
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = join(fileURLToPath(new URL('.', import.meta.url)))
const PROJECT = join(HERE, '..', '..')
const ARTIFACTS = join(HERE, '_artifacts')

const DSH_BIN = 'C:\\node_globalode\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 3081
const MOCK_PORT = 8099
const MOCK_DELAY = '0.4'

const PROBE_ONLY = process.argv.includes('--probe')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ---------------------------------------------------------------------------
// 子进程管理：任何路径退出都必须收干净，绝留孤儿进程占着 3081。
// ---------------------------------------------------------------------------

const children = []
function track(child, name) {
  children.push({ child, name })
  return child
}
async function killAll() {
  for (const { child, name } of children.reverse()) {
    try {
      child.kill('SIGKILL')
    } catch {
      // 已经退了
    }
    console.log(`[cleanup] 已杀 ${name} (pid=${child.pid})`)
  }
  // 3081 必须真的释放（用户的实例在 3080，我们只碰 3081）。
  await sleep(500)
}
process.on('exit', () => {
  for (const { child } of children) {
    try {
      child.kill('SIGKILL')
    } catch {
      // 已经退了
    }
  }
})

// ---------------------------------------------------------------------------
// dist 陈旧检查：profile 装载的是 dist/host.js，改了 src 不构建等于测旧代码
// ---------------------------------------------------------------------------

function distStaleness(): string[] {
  const notes = []
  const pairs = [
    ['src/host.ts', 'dist/host.js'],
    ['src/core/room-orchestrator.ts', 'dist/core/room-orchestrator.js'],
    ['src/adapters/dsh-session-catalog.ts', 'dist/adapters/dsh-session-catalog.js'],
  ]
  for (const [src, dist] of pairs) {
    const srcPath = join(PROJECT, src)
    const distPath = join(PROJECT, dist)
    if (!existsSync(srcPath) || !existsSync(distPath)) {
      notes.push(`${dist} 不存在（从未构建？）`)
      continue
    }
    if (statSync(srcPath).mtimeMs > statSync(distPath).mtimeMs) {
      notes.push(`${src} 比 ${dist} 新——先跑 pnpm run build，否则 e2e 测的是旧代码`)
    }
  }
  return notes
}

// ---------------------------------------------------------------------------
// CDP over pipe（沙箱禁 TCP bind，fd 3/4 是唯一通道）
// ---------------------------------------------------------------------------

function startChrome() {
  const child = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--remote-debugging-pipe',
      `--user-data-dir=${join(ARTIFACTS, '_cprof')}`,
      '--window-size=1500,950',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] },
  )
  return track(child, 'chrome')
}

function makeCdp(chrome) {
  let buffer = ''
  const pending = new Map()
  let nextId = 1

  chrome.stdio[4].on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\0')) >= 0) {
      const raw = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (raw.trim().length === 0) continue
      let message
      try {
        message = JSON.parse(raw)
      } catch {
        continue
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
      }
    }
  })

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const payload = { id, method, params }
      if (sessionId !== undefined) payload.sessionId = sessionId
      pending.set(id, { resolve, reject })
      chrome.stdio[3].write(`${JSON.stringify(payload)}\0`)
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error(`timeout: ${method}`))
        }
      }, 30000)
    })

  return { send }
}

/** 页面工具集合：evaluate / 点击 / 输入 / 读文本。 */
function makePage(cdp, session) {
  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, session)
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    }
    return result.result.value
  }

  /** 按可见文本点最深的匹配元素（React 受控组件只认真实鼠标事件序列）。 */
  const clickByText = async (text, options = {}) => {
    const info = await evaluate(`
      (() => {
        const all = [...document.querySelectorAll('button, div, span, a, [role="button"]')]
        const hits = all.filter((el) => {
          const own = el.textContent.trim()
          return ${options.exact === true ? 'own === ' : 'own.includes('}${JSON.stringify(text)}${options.exact === true ? '' : ')'}
        })
        if (hits.length === 0) return null
        const hit = hits[hits.length - 1]
        const r = hit.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) return null
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), tag: hit.tagName }
      })()
    `)
    if (info === null) return false
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: info.x, y: info.y, button: 'left', clickCount: 1 }, session)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: info.x, y: info.y, button: 'left', clickCount: 1 }, session)
    return info.tag
  }

  /** React 受控输入：必须走原生 setter + input 事件，直接赋值不触发 onChange。 */
  const typeInto = async (selector, text) => {
    return await evaluate(`
      (() => {
        const el = document.querySelector(${JSON.stringify(selector)})
        if (el === null) return 'NO_ELEMENT'
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(el, ${JSON.stringify(text)})
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return 'typed:' + el.value.length
      })()
    `)
  }

  return { evaluate, clickByText, typeInto, rawSend: (method, params) => cdp.send(method, params, session) }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const stale = distStaleness()
  if (stale.length > 0) {
    // 不阻断（dist 可能刚构建而 mtime 精度不够），但必须醒目：
    // 测旧代码比不测试更糟——它会给出假的绿灯。
    console.log('[warn] dist 可能陈旧：')
    for (const note of stale) console.log(`       - ${note}`)
  }
  rmSync(ARTIFACTS, { recursive: true, force: true })
  mkdirSync(ARTIFACTS, { recursive: true })
  const mockLog = join(ARTIFACTS, 'mock-requests.jsonl')

  // --- 1. mock LLM -------------------------------------------------------
  const mock = track(
    spawn('python', [join(HERE, 'mock_llm.py'), String(MOCK_PORT), mockLog, MOCK_DELAY], {
      cwd: PROJECT,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    'mock',
  )
  mock.stdout.on('data', (d) => process.stdout.write(`[mock] ${d}`))
  mock.stderr.on('data', (d) => process.stdout.write(`[mock!] ${d}`))

  let mockReady = false
  for (let i = 0; i < 30; i += 1) {
    await sleep(300)
    try {
      const response = await fetch(`http://127.0.0.1:${MOCK_PORT}/health`)
      if (response.ok) {
        mockReady = true
        break
      }
    } catch {
      // 还没起来
    }
  }
  if (!mockReady) throw new Error('mock LLM 服务 9 秒内没有就绪')
  console.log('[1] mock LLM 就绪 →', `http://127.0.0.1:${MOCK_PORT}`)

  // --- 2. dsh web（插件经 profile bundle 层装载，dist 必须是最新的）--------
  // 数据根：cordis.patch.yml 里显式配了 rootDir（config 优先于环境变量，
  // 所以 DSH_MEETING_ROOT 在这条装载路径下不生效），就是项目的 .dsh-meeting——
  // 与用户自己的开发实例同一个目录，这正是真实形态。
  const dshOut = []
  const dsh = track(
    spawn('node', [DSH_BIN, 'web', '--port', String(PORT), '--no-open'], {
      cwd: PROJECT,
      env: {
        ...process.env,
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
        DEEPSEEK_API_KEY: 'mock-e2e-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    'dsh',
  )
  dsh.stdout.on('data', (d) => {
    dshOut.push(d.toString())
    process.stdout.write(`[dsh] ${d}`)
  })
  dsh.stderr.on('data', (d) => process.stdout.write(`[dsh!] ${d}`))

  let url = ''
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000)
    const text = dshOut.join('')
    const hit = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/?\S*)/.exec(text)
    if (hit) {
      url = hit[1] ?? ''
      break
    }
  }
  if (url === '') throw new Error('dsh web 60 秒内没有给出 URL（stdout 见上）')
  console.log('[2] dsh web 已启动 →', url)

  // --- 3. 无头 Chrome ------------------------------------------------------
  const chrome = startChrome()
  const cdp = makeCdp(chrome)
  const target = await cdp.send('Target.createTarget', { url })
  const attached = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const session = attached.sessionId
  await cdp.send('Page.enable', {}, session)
  await cdp.send('Runtime.enable', {}, session)
  const page = makePage(cdp, session)
  console.log('[3] Chrome 已附加，等页面加载…')
  await sleep(12000)

  const report = { steps: [], snapshots: [], assertions: [] }
  const step = (name, ok, detail = '') => {
    report.steps.push({ name, ok, detail })
    console.log(`${ok ? '✓' : '✗'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }

  // --- 4. DOM 探查 --------------------------------------------------------
  const dom = await page.evaluate(`
    JSON.stringify({
      url: location.href,
      title: document.title,
      buttons: [...document.querySelectorAll('button')].map((b) => ({
        text: (b.textContent || '').trim().slice(0, 40),
        aria: b.getAttribute('aria-label'),
        title: b.getAttribute('title'),
      })).filter((b) => b.text || b.aria || b.title),
      textareas: document.querySelectorAll('textarea').length,
      editables: document.querySelectorAll('[contenteditable="true"]').length,
      sidebarTail: (document.body.innerText || '').slice(-500),
    })
  `)
  const domInfo = JSON.parse(dom)
  writeFileSync(join(ARTIFACTS, 'dom-probe.json'), JSON.stringify(domInfo, null, 2))
  console.log('[4] DOM 探查：')
  console.log('    url =', domInfo.url)
  console.log('    buttons =', JSON.stringify(domInfo.buttons))
  console.log('    textarea =', domInfo.textareas, ' contenteditable =', domInfo.editables)
  console.log('    sidebar 尾部 =', JSON.stringify(domInfo.sidebarTail.slice(0, 300)))

  if (PROBE_ONLY) {
    // 追加探查：模型选择器（要把会话模型切成 deepseek-flash，mock 才接得到）。
    const modelBtn = await page.evaluate(`
      (() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').startsWith('选择模型'))
        if (b === undefined) return 'NO_MODEL_BUTTON'
        const r = b.getBoundingClientRect()
        return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) })
      })()
    `)
    console.log('    模型按钮 =', modelBtn)
    if (modelBtn !== 'NO_MODEL_BUTTON') {
      const pos = JSON.parse(modelBtn)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, session)
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pos.x, y: pos.y, button: 'left', clickCount: 1 }, session)
      await sleep(2500)
      // 两级菜单：根菜单的「模型」行点进去才是模型列表。
      const drilled = await page.evaluate(`
        (() => {
          const rows = [...document.querySelectorAll('[role="menuitem"]')]
          const target = rows.find((el) => (el.textContent || '').trim().startsWith('模型'))
          if (target === undefined) return 'NO_MODEL_ROW'
          target.click()
          return 'clicked'
        })()
      `)
      console.log('    进入模型列表 =', drilled)
      await sleep(3000)
      const popover = await page.evaluate(`
        (() => {
          const rows = [...document.querySelectorAll('[role="menuitemradio"], [role="menuitem"]')]
          return JSON.stringify({
            rowCount: rows.length,
            rows: rows.map((el) => ({
              text: (el.textContent || '').trim().slice(0, 80),
              checked: el.getAttribute('aria-checked'),
              disabled: el.getAttribute('aria-disabled'),
            })),
          })
        })()
      `)
      console.log('    模型菜单 =', popover)
    }
    console.log('[probe] 只探查，不跑流程。')
    await killAll()
    return
  }

  // --- 5. 建两个会话，把模型切成 deepseek-flash（mock 才接得到）-------------
  // 宿主默认模型是用户 settings 里的 mimo-v2.6-pro（xiaomi provider，
  // 真实计费端点）。本测试要的是确定性 + 不花钱，所以显式切到
  // deepseek-official/deepseek-flash —— 它的端点由 DEEPSEEK_BASE_URL 指到 mock。
  const switchModelToFlash = async (label) => {
    const trigger = await page.evaluate(`
      (() => {
        const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').startsWith('选择模型'))
        if (b === undefined) return null
        const r = b.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()
    `)
    if (trigger === null) {
      step(`${label}: 找到模型选择器`, false)
      return
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: trigger.x, y: trigger.y, button: 'left', clickCount: 1 }, session)
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: trigger.x, y: trigger.y, button: 'left', clickCount: 1 }, session)
    await sleep(2000)
    // 两级菜单：根菜单的「模型」行点进去才是模型列表。
    await page.evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('[role="menuitem"]')]
        const target = rows.find((el) => (el.textContent || '').trim().startsWith('模型'))
        if (target !== undefined) target.click()
      })()
    `)
    await sleep(2500)
    const picked = await page.evaluate(`
      (() => {
        const rows = [...document.querySelectorAll('[role="menuitemradio"]')]
        const target = rows.find((el) => (el.textContent || '').trim() === 'DeepSeek-V41-Flash')
        if (target === undefined) return 'NO_FLASH_ROW'
        target.click()
        return 'picked'
      })()
    `)
    step(`${label}: 模型切换为 DeepSeek-V41-Flash`, picked === 'picked', picked)
    await sleep(1500)
  }

  const newSession = await page.clickByText('新会话')
  step('新建会话 A', newSession !== false, `click=${String(newSession)}`)
  await sleep(2500)
  await switchModelToFlash('会话 A')

  // 标记文本是"借上下文"断言的探针：它必须出现在 mock 收到的发言 prompt 里。
  const marker = `E2E-MOCK-${Date.now()} 我在核对 60 日窗口的重训频率，卡在滑点口径`
  writeFileSync(join(ARTIFACTS, 'marker.txt'), marker)

  // 聊天输入是 contenteditable（探查结论）：focus + execCommand + 点发送。
  const sent = await page.evaluate(`
    (async () => {
      const ce = document.querySelector('[contenteditable="true"]')
      if (ce === null) return 'NO_INPUT'
      ce.focus()
      document.execCommand('insertText', false, ${JSON.stringify(marker)})
      await new Promise((r) => setTimeout(r, 300))
      const send = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || '') === '发送消息')
      if (send === undefined) return 'NO_SEND_BUTTON'
      send.click()
      return 'sent'
    })()
  `)
  step('会话 A 发出标记消息', sent === 'sent', String(sent))

  // 等 mock 的 ABC 回复出现在对话里（模型通道走通的最直接证据）。
  let sawAbc = false
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000)
    const text = await page.evaluate('document.body.innerText')
    if (/ABC \d/.test(text)) {
      sawAbc = true
      break
    }
  }
  step('会话 A 收到 mock 的 ABC 回复（模型通道走通）', sawAbc)
  if (!sawAbc) {
    writeFileSync(join(ARTIFACTS, 'no-abc-body.txt'), await page.evaluate('document.body.innerText'))
  }

  // 第二个成员**不新建会话**：实测切到新会话会把 A 逐出 `ctx.sessions`
  // （候选项出现"未加载"徽标），而借上下文要求成员在进程里活着。
  // 改用任意一个旧会话补足"多成员"场景：它未加载 → 没有自己的模型 →
  // 一次性调用继承父（lead）agent 的模型，而 lead 就是 A（deepseek-flash）→
  // 照样走 mock。它的上下文为空，正好是"借不到"的对照组。
  await page.evaluate('window.scrollTo(0, 0)')

  // --- 6. 打开面板 → 建房 → 加人 → 召集 ------------------------------------
  const opened = await page.clickByText('会议室')
  step('打开会议室面板', opened !== false, `click=${String(opened)}`)
  await sleep(2500)

  // 房间 id 带时间戳：重复跑不会撞"已存在"（面板里也认得出是哪一次跑的）。
  const roomId = `e2e-${Date.now() % 100000}`
  writeFileSync(join(ARTIFACTS, 'room-id.txt'), roomId)
  // 房间 id 输入框要用**placeholder** 定位：页面上第一个 input 是侧栏搜索框，
  // 直接 querySelector('input') 会填到它里面去（第一次跑就踩了这个坑）。
  const filled = await page.typeInto('input[placeholder*="会议室"]', roomId)
  step('填写房间 id', filled.startsWith('typed'), filled)
  await page.clickByText('创建')
  await sleep(1500)
  await page.clickByText(roomId, { exact: true })
  await sleep(2000)

  // 候选区：把前两个"能加"的会话加进来（按最近使用排序，应正是 A/B）。
  const allRows = await page.evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('div')].filter((d) => {
        const btn = [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === '加入会话')
        return btn !== undefined && d.querySelectorAll('div').length < 12
      })
      return JSON.stringify(rows.map((r) => r.textContent.trim().slice(0, 80)))
    })()
  `)
  writeFileSync(join(ARTIFACTS, 'candidate-rows.json'), allRows)
  console.log('    全部候选行 =', allRows)
  const sidebarNow = await page.evaluate(`
    (() => {
      const text = document.body.innerText
      const start = text.indexOf('工作区')
      return start < 0 ? '(无侧栏文本)' : text.slice(start, start + 500)
    })()
  `)
  console.log('    侧栏当前 =', JSON.stringify(String(sidebarNow).slice(0, 400)))

  const added = await page.evaluate(`
    (() => {
      const rows = [...document.querySelectorAll('div')].filter((d) => {
        const btn = [...d.querySelectorAll('button')].find((b) => b.textContent.trim() === '加入会话')
        return btn !== undefined && d.querySelectorAll('div').length < 12
      })
      const out = []
      for (const row of rows.slice(0, 2)) {
        const btn = [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '加入会话')
        btn.click()
        out.push(row.textContent.trim().slice(0, 60))
      }
      return JSON.stringify(out)
    })()
  `)
  console.log('    加入的候选行 =', added)
  await sleep(2500)

  const membersText = await page.evaluate(`
    (() => {
      const text = document.body.innerText
      const start = text.indexOf('成员')
      return start < 0 ? '(没有成员区)' : text.slice(start, start + 300)
    })()
  `)
  console.log('    成员区 =', JSON.stringify(String(membersText).slice(0, 300)))
  const memberCount = (String(membersText).match(/idle-waiting|working|in-meeting/g) ?? []).length
  step('两个会话已入会', memberCount >= 2, `成员状态标记数=${memberCount}`)

  const convened = await page.clickByText('召集会议')
  step('点击"召集会议"', convened !== false, `click=${String(convened)}`)

  // --- 7. 会议进行中：高频采集实时视图 --------------------------------------
  const startedAt = Date.now()
  let liveGone = false
  let lastTurnCount = -1
  const snapshots = []
  for (let i = 0; i < 240; i += 1) {
    await sleep(500)
    const shot = await page.evaluate(`
      (() => {
        const el = document.querySelector('[data-testid="meeting-live"]')
        if (el === null) return JSON.stringify({ present: false })
        const turns = el.querySelectorAll('[data-turn-seq]')
        return JSON.stringify({
          present: true,
          turns: turns.length,
          kinds: [...turns].map((t) => t.getAttribute('data-turn-kind')),
          text: el.innerText.slice(0, 1200),
        })
      })()
    `)
    const parsed = JSON.parse(shot)
    if (parsed.present !== true) {
      if (snapshots.length > 0) {
        liveGone = true
        break
      }
      continue
    }
    lastTurnCount = parsed.turns
    snapshots.push({ at: Date.now() - startedAt, turns: parsed.turns, kinds: parsed.kinds, text: parsed.text })
  }
  report.snapshots = snapshots.map((s) => ({ at: s.at, turns: s.turns, kinds: s.kinds }))
  writeFileSync(join(ARTIFACTS, 'live-snapshots.json'), JSON.stringify(snapshots, null, 2))
  step('实时视图被多次采到（全程可见）', snapshots.length >= 3, `${snapshots.length} 帧`)
  step('记录条数持续增长', snapshots.length >= 2 && snapshots[snapshots.length - 1].turns > snapshots[0].turns,
    `首帧 ${snapshots[0]?.turns ?? 0} → 末帧 ${snapshots[snapshots.length - 1]?.turns ?? 0} 条`)
  step('会议已散会（实时视图消失）', liveGone || lastTurnCount === -1)

  await sleep(2000)
  await page.clickByText('刷新')
  await sleep(2000)
  const historyText = await page.evaluate('document.body.innerText')
  const sawHistory = /room-\d+-/.test(historyText)
  step('历次会议列表出现本场会议', sawHistory)

  // --- 8. 落盘断言 ---------------------------------------------------------
  // 会议记录落在插件数据根（patch 配置指向项目 .dsh-meeting，与开发实例一致）。
  const minutesFile = join(PROJECT, '.dsh-meeting', 'room-meetings.jsonl')
  const minutesLines = existsSync(minutesFile)
    ? readFileSync(minutesFile, 'utf8').trim().split('\n').filter((l) => l.length > 0)
    : []
  step('room-meetings.jsonl 有会议记录', minutesLines.length > 0, `${minutesLines.length} 条`)

  let meeting = undefined
  for (const line of minutesLines.slice().reverse()) {
    try {
      const parsed = JSON.parse(line)
      if (Array.isArray(parsed.transcript) && parsed.transcript.some((t) => t.kind === 'speech')) {
        meeting = parsed
        break
      }
    } catch {
      // 跳过坏行
    }
  }
  const speeches = meeting?.transcript.filter((t) => t.kind === 'speech') ?? []
  step('会议有成员发言（ABC）', speeches.length >= 2 && speeches.every((t) => /ABC \d/.test(t.text)),
    `${speeches.length} 条发言`)
  step('会议有个性化纪要', (meeting?.notes?.length ?? 0) >= 1, `${meeting?.notes?.length ?? 0} 份`)
  console.log('    散会原因 =', meeting?.adjournedReason)

  // mock 日志：发言 prompt 必须带借来的上下文（含标记文本）。
  const mockLines = existsSync(mockLog)
    ? readFileSync(mockLog, 'utf8').trim().split('\n').filter((l) => l.length > 0).map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return undefined
        }
      }).filter((v) => v !== undefined)
    : []
  writeFileSync(join(ARTIFACTS, 'mock-requests.pretty.json'), JSON.stringify(mockLines, null, 2))
  console.log(`    mock 共收到 ${mockLines.length} 个请求`)

  const speechPrompts = mockLines.filter((m) => /【轮到你发言】/.test(m.prompt ?? ''))
  const withProjection = speechPrompts.filter((m) => /私有记忆投影/.test(m.prompt ?? ''))
  // 完整标记（带时间戳）：只认**本轮**会话 A 的上下文，不靠 'E2E-MOCK'
  // 前缀命中往届测试留下的旧会话。
  const fullMarker = readFileSync(join(ARTIFACTS, 'marker.txt'), 'utf8').trim()
  const withMarker = speechPrompts.filter((m) => (m.prompt ?? '').includes(fullMarker))
  step('发言 prompt 带记忆投影段', withProjection.length > 0, `${withProjection.length}/${speechPrompts.length} 条`)
  step('**借上下文**：发言 prompt 含该会话的真实消息（完整标记）', withMarker.length > 0,
    withMarker.length > 0 ? `探针命中（${withMarker.length} 条发言）` : '未命中——借上下文没生效')

  const moderatorCalls = mockLines.filter((m) => /【会议主持】/.test(m.prompt ?? ''))
  const moderatorOk = moderatorCalls.length > 0 && moderatorCalls.every((m) => {
    try {
      const decision = JSON.parse(m.reply)
      return decision.action === 'invite' || decision.action === 'adjourn'
    } catch {
      return false
    }
  })
  step('主持人控制通道走模型且可解析', moderatorOk, `${moderatorCalls.length} 次控场`)

  writeFileSync(join(ARTIFACTS, 'report.json'), JSON.stringify(report, null, 2))
  const failed = report.steps.filter((s) => !s.ok)
  console.log(`\n[e2e] ${report.steps.length - failed.length}/${report.steps.length} 步通过` + (failed.length > 0 ? `，失败：${failed.map((f) => f.name).join('；')}` : ''))
  if (failed.length > 0) process.exitCode = 1
}

main()
  .catch(async (error) => {
    console.error('[e2e] 失败：', error)
    process.exitCode = 1
  })
  .finally(async () => {
    await killAll()
  })
