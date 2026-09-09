const assert = require('node:assert/strict')
const { before, after, test } = require('node:test')
const { createRequire } = require('node:module')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { io: connect } = require('socket.io-client')
const { http, io } = require('../app')

let origin

function event(socket, name) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(name, onEvent)
      reject(new Error(`Timed out waiting for ${name}`))
    }, 3000)
    function onEvent(value) {
      clearTimeout(timer)
      resolve(value)
    }
    socket.once(name, onEvent)
  })
}

async function client(t) {
  const socket = connect(origin, { transports: ['websocket'], reconnection: false, autoConnect: false })
  t.after(() => socket.disconnect())
  const ready = event(socket, 'connect')
  socket.connect()
  await ready
  return socket
}

async function join(socket, room) {
  const joined = event(socket, 'ROOM_JOINED')
  socket.emit('JOIN', room)
  return joined
}

before(async () => {
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${http.address().port}`
})

after(async () => {
  await new Promise(resolve => io.close(resolve))
})

test('serves the chat and matching local Socket.IO client without exposing source', async () => {
  const page = await fetch(origin)
  assert.equal(page.status, 200)
  const html = await page.text()
  assert.match(html, /src="\/socket\.io\/socket\.io\.js"/)
  assert.doesNotMatch(html, /socket\.io\/2\./)
  const script = await fetch(`${origin}/socket.io/socket.io.js`)
  assert.equal(script.status, 200)
  assert.match(await script.text(), /Socket\.IO v4\.8\.3/)
  for (const path of ['/package.json', '/app.js', '/.git/config']) {
    assert.equal((await fetch(origin + path)).status, 404)
  }
})

test('the Express query parser uses the qs fixes for both reported regressions', () => {
  const expressRequire = createRequire(require.resolve('express/package.json'))
  const qs = expressRequire('qs')
  assert.throws(() => qs.parse('a[]=1,2,3,4', {
    comma: true, arrayLimit: 3, throwOnLimitExceeded: true
  }), RangeError)
  assert.doesNotThrow(() => qs.stringify(qs.parse('x[constructor][isBuffer]=y', { plainObjects: true })))
})

test('the browser preserves the peer key when rejoining its numeric default room', () => {
  let options
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/page.js'), 'utf8'), {
    Vue: function (value) { options = value }
  })
  const sent = []
  const messages = [{ text: 'existing-message' }]
  const state = {
    pendingRoom: 927, currentRoom: '927', originPublicKey: 'local-key',
    destinationPublicKey: 'peer-key', messages,
    socket: { emit: (...args) => sent.push(args) },
    addNotification: () => {}
  }
  options.methods.joinRoom.call(state)
  assert.equal(state.destinationPublicKey, 'peer-key')
  assert.equal(state.messages, messages)
  assert.deepEqual(sent, [])
  for (const invalid of ['', ' '.repeat(3), 'x'.repeat(129), null]) {
    state.pendingRoom = invalid
    options.methods.joinRoom.call(state)
    assert.equal(state.destinationPublicKey, 'peer-key')
  }
  assert.deepEqual(sent, [])
  state.pendingRoom = ' 928 '
  options.methods.joinRoom.call(state)
  assert.deepEqual(sent, [['JOIN', '928']])
  assert.equal(state.destinationPublicKey, null)
  assert.equal(state.messages.length, 0)
})

test('two peers can exchange messages, a third is rejected, and departure frees the room', async t => {
  const first = await client(t)
  const second = await client(t)
  const third = await client(t)
  assert.equal(await join(first, 927), '927')
  assert.equal(await join(second, '927'), '927')
  assert.equal(await join(second, '927'), '927')
  const full = event(third, 'ROOM_FULL')
  const intrusion = event(first, 'INTRUSION_ATTEMPT')
  third.emit('JOIN', '927')
  await Promise.all([full, intrusion])

  const delivered = event(second, 'MESSAGE')
  const message = { text: 'encrypted-payload', sender: 'public-key-a', recipient: 'public-key-b' }
  first.emit('MESSAGE', message)
  assert.deepEqual(await delivered, message)

  const left = event(first, 'USER_DISCONNECTED')
  second.disconnect()
  await left
  assert.equal(await join(third, '927'), '927')
})

test('the browser rejoins its room after a transport disconnect', () => {
  let options
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/page.js'), 'utf8'), {
    Vue: function (value) { options = value }
  })
  const handlers = {}
  const sent = []
  const state = {
    pendingRoom: 'reconnect', currentRoom: 'reconnect', originPublicKey: 'local-key',
    destinationPublicKey: 'peer-key', messages: [],
    addNotification: () => {},
    socket: { on: (name, handler) => { handlers[name] = handler }, emit: (...args) => sent.push(args) }
  }
  state.joinRoom = options.methods.joinRoom.bind(state)
  options.methods.setupSocketListeners.call(state)
  handlers.disconnect()
  assert.equal(state.currentRoom, null)
  assert.equal(state.destinationPublicKey, null)
  handlers.connect()
  assert.deepEqual(sent, [['JOIN', 'reconnect']])
})

test('malformed and oversized messages are discarded without interrupting the connection', async t => {
  const first = await client(t)
  const second = await client(t)
  await join(first, 'validation')
  await join(second, 'validation')
  const received = []
  second.on('MESSAGE', message => received.push(message))
  first.emit('MESSAGE', null)
  first.emit('MESSAGE', { text: 'bad-shape' })
  first.emit('MESSAGE', { text: 'x'.repeat(16385), sender: 'a', recipient: 'b' })
  first.emit('PUBLIC_KEY', { malformed: true })
  const marker = event(second, 'PUBLIC_KEY')
  first.emit('PUBLIC_KEY', 'valid-key')
  assert.equal(await marker, 'valid-key')
  assert.deepEqual(received, [])
  const delivered = event(second, 'MESSAGE')
  first.emit('MESSAGE', { text: 'still-working', sender: 'a', recipient: 'b', ignored: true })
  assert.deepEqual(await delivered, { text: 'still-working', sender: 'a', recipient: 'b' })
})

test('room changes stop delivery from the previous room and socket IDs cannot alias chat rooms', async t => {
  const first = await client(t)
  const second = await client(t)
  const third = await client(t)
  const observer = await client(t)
  await join(first, 'isolation')
  await join(second, 'isolation')
  const left = event(first, 'USER_DISCONNECTED')
  await join(second, 'another-room')
  await left
  await join(third, 'isolation')
  await join(observer, first.id)
  const received = []
  second.on('MESSAGE', value => received.push(value))
  const relayed = event(third, 'MESSAGE')
  first.emit('MESSAGE', { text: 'previous-room-only', sender: 'a', recipient: 'b' })
  await relayed
  await join(second, 'another-room')
  assert.deepEqual(received, [])
  const notifications = []
  observer.on('ROOM_JOINED', value => notifications.push(value))
  await join(first, 'isolation')
  await join(observer, first.id)
  assert.deepEqual(notifications, [first.id])
  first.emit('JOIN', null)
  first.emit('JOIN', { room: 'bad' })
  first.emit('JOIN', 'x'.repeat(129))
  assert.equal(await join(first, 'isolation'), 'isolation')
})
