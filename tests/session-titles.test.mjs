// All session data is synthetic. These tests do not read a user profile or use the network.
// Run with: node --experimental-vm-modules --test tests/session-titles.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SOURCE = path.resolve(ROOT, '../desktop/plugin.js')
const LIVE = {
  scope: 'live',
  sessions: [{ id: 'example-live-session', title: 'Example live conversation' }]
}
const STORED = {
  scope: 'stored',
  sessions: [
    { id: 'example-saved-session', title: 'Example saved conversation' },
    { id: 'example-unnamed-session', title: '' }
  ]
}
const TITLE_REQUESTS = [
  { method: 'session.list', params: { limit: 200 } },
  { method: 'session.list', params: { limit: 200, scope: 'stored' } }
]

function atom(initial) {
  let value = initial
  return { get: () => value, set: next => { value = next }, subscribe: () => () => {} }
}

const jsx = (type, props = {}, key) => ({ type, props, key })
const translation = key => key === 'untitled' ? 'Untitled' : key
const passthrough = props => jsx('span', { children: props.children })

// Evaluate component functions to inspect their actual text/tooltip props. This is not
// an Electron or React-layout test; external SDK components and hooks are test doubles.
function render(node) {
  if (Array.isArray(node)) return node.map(render)
  if (node == null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return render(node.type(node.props))
  return { ...node, props: { ...node.props, children: render(node.props.children) } }
}

function find(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, predicate)
      if (found) return found
    }
    return null
  }
  if (!node || typeof node !== 'object') return null
  return predicate(node) ? node : find(node.props.children, predicate)
}

function text(node) {
  if (Array.isArray(node)) return node.map(text).join('')
  if (node == null || typeof node === 'boolean') return ''
  return typeof node === 'object' ? text(node.props.children) : String(node)
}

async function loadPlugin(requestOverride) {
  const calls = []
  const request = requestOverride || (async (method, params) => {
    if (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 200) {
      throw new Error('invalid_params')
    }
    return structuredClone(params.scope === 'stored' ? STORED : LIVE)
  })
  const host = {
    request: async (method, params) => {
      calls.push({ method, params: structuredClone(params) })
      return request(method, params)
    },
    state: {
      profile: atom('default'),
      focusedStoredSessionId: atom('example-live-session'),
      focusedSessionId: atom('example-live-session')
    },
    notify() {}, navigate() {},
    composer: { insertText() {}, setDraft() {}, focus() {} }
  }
  const sdk = {
    atom, host, useValue: store => store.get(), usePluginI18n: () => translation,
    COMPOSER_AREAS: { top: 'composer.top' },
    SESSION_ROW_AREAS: { leading: 'session.leading' },
    STATUSBAR_AREAS: { right: 'status.right' },
    PALETTE_AREA: 'palette', ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'sidebar',
    Button: props => jsx('button', props),
    Codicon: () => null, ConfirmDialog: () => null,
    DropdownMenu: passthrough, DropdownMenuContent: passthrough,
    DropdownMenuItem: passthrough, DropdownMenuTrigger: passthrough,
    Input: props => jsx('input', props),
    Popover: passthrough, PopoverContent: passthrough, PopoverTrigger: passthrough,
    SegmentedControl: () => null, Switch: () => null, Tip: passthrough
  }
  const context = vm.createContext({ console, setTimeout, clearTimeout, Date, window: {} })
  function synthetic(specifier, exports) {
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value)
    }, { context, identifier: specifier })
  }
  const imports = {
    '@hermes/plugin-sdk': synthetic('@hermes/plugin-sdk', sdk),
    react: synthetic('react', {
      useEffect() {}, useMemo: fn => fn(),
      useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}]
    }),
    'react/jsx-runtime': synthetic('react/jsx-runtime', { jsx, jsxs: jsx, Fragment: 'fragment' })
  }
  const source = await fs.readFile(SOURCE, 'utf8')
  // Expose private functions inside this test-only module; the shipped exports stay unchanged.
  const expose = '\nexport { refreshTitles, $titles, $recent, BoardItem, Board, StatusCard, $snap };\n'
  const module = new vm.SourceTextModule(source + expose, { context, identifier: 'waypoint-under-test' })
  await module.link(specifier => {
    assert.ok(imports[specifier], `Unexpected import: ${specifier}`)
    return imports[specifier]
  })
  await module.evaluate()
  return { ns: module.namespace, calls }
}

test('loads existing titles with a gateway-compatible listing limit', async () => {
  const { ns, calls } = await loadPlugin()
  await ns.refreshTitles()
  assert.deepEqual(calls, TITLE_REQUESTS)
  assert.equal(ns.$titles.get()['example-live-session'], 'Example live conversation')
  assert.ok(ns.$recent.get().includes('example-live-session'))
})

test('loads saved-only conversation titles as well as live titles', async () => {
  const { ns, calls } = await loadPlugin()
  await ns.refreshTitles()
  assert.deepEqual(calls, TITLE_REQUESTS)
  assert.equal(ns.$titles.get()['example-saved-session'], 'Example saved conversation')
})

test('overlapping untitled sessions appear once in recent sessions and Board triage', async () => {
  const id = 'example-overlap-session'
  // Also covers gateways that ignore scope and return the same listing twice.
  const { ns, calls } = await loadPlugin(async () => ({ sessions: [{ id, title: '' }] }))
  await ns.refreshTitles()
  assert.deepEqual(calls, TITLE_REQUESTS)
  const recent = [...ns.$recent.get()]
  const board = render(jsx(ns.Board))
  const triage = find(board, node => 'data-board-triage' in node.props)
  const rows = triage.props.children.flat(Infinity)
    .filter(node => node?.props && 'data-triage-item' in node.props)
  assert.deepEqual({
    recent: recent.length,
    uniqueRecent: new Set(recent).size,
    triageRows: rows.length,
    uniqueTriageKeys: new Set(rows.map(row => row.key)).size
  }, { recent: 1, uniqueRecent: 1, triageRows: 1, uniqueTriageKeys: 1 })
  assert.deepEqual(recent, [id])
  assert.equal(rows[0].props['data-triage-item'], id)
  assert.equal(rows[0].key, id)
  assert.equal(text(find(rows[0], node => node.type === 'button')), id)
  assert.equal(ns.$titles.get()[id], '')
})

test('missing titles show full session IDs on the board, triage and status card', async () => {
  const { ns } = await loadPlugin()
  const boardId = 'example-live-session'
  const triageId = 'example-unnamed-session'
  ns.$snap.set(ns.normalise({ statuses: { [boardId]: 'wip' } }))
  ns.$titles.set({})
  ns.$recent.set([triageId])
  const board = render(jsx(ns.Board))
  const card = render(jsx(ns.StatusCard, { id: boardId, onClose() {} }))
  const boardItem = find(board, node => node.props['data-board-item'] === boardId)
  const triageItem = find(board, node => node.props['data-triage-item'] === triageId)
  const boardButton = find(boardItem, node => node.type === 'button')
  const triageButton = find(triageItem, node => node.type === 'button')
  const cardHeading = find(card, node => node.type === 'div' && 'title' in node.props)
  assert.deepEqual([text(boardButton), text(triageButton), text(cardHeading)],
    [boardId, triageId, boardId])
  assert.deepEqual([boardButton?.props.title, triageButton?.props.title, cardHeading?.props.title],
    [boardId, triageId, boardId])
})

test('older gateways without stored scope still provide live titles', async () => {
  const { ns, calls } = await loadPlugin(async (method, params) => {
    if (params.scope === 'stored') throw new Error('invalid_params')
    return structuredClone(LIVE)
  })
  await ns.refreshTitles()
  assert.deepEqual(calls, TITLE_REQUESTS)
  assert.equal(ns.$titles.get()['example-live-session'], 'Example live conversation')
})

test('a temporary listing failure preserves cached titles and user settings', async () => {
  let offline = false
  const { ns, calls } = await loadPlugin(async (method, params) => {
    if (offline) throw new Error('gateway unavailable')
    return structuredClone(params.scope === 'stored' ? STORED : LIVE)
  })
  const originalSettings = JSON.stringify(ns.$snap.get())
  await ns.refreshTitles()
  assert.deepEqual(calls, TITLE_REQUESTS)
  const names = JSON.stringify(ns.$titles.get())
  assert.notEqual(names, '{}')
  offline = true
  await ns.refreshTitles()
  assert.deepEqual(calls, [...TITLE_REQUESTS, TITLE_REQUESTS[0]])
  assert.equal(JSON.stringify(ns.$titles.get()), names)
  assert.equal(JSON.stringify(ns.$snap.get()), originalSettings)
})

test('resolved names stay visible rather than being replaced by IDs', async () => {
  const { ns, calls } = await loadPlugin()
  await ns.refreshTitles()
  assert.deepEqual(calls, TITLE_REQUESTS)
  const id = 'example-live-session'
  const snap = ns.normalise({ statuses: { [id]: 'wip' } })
  const item = render(jsx(ns.BoardItem,
    { id, t: translation, snap, titles: ns.$titles.get(), now: Date.now() }))
  const button = find(item, node => node.type === 'button')
  assert.equal(text(button), 'Example live conversation')
  assert.equal(button.props.title, 'Example live conversation')
})
