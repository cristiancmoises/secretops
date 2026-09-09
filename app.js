const express = require('express')
const path = require('path')

// Setup Express server
const app = express()
const http = require('http').Server(app)

// Attach Socket.io to server
const io = require('socket.io')(http, { maxHttpBufferSize: 64 * 1024 })

// Serve web app directory
app.use(express.static(path.join(__dirname, 'public')))

/** Manage behavior of each client socket connection */
io.on('connection', (socket) => {
  console.log(`User Connected - Socket ID ${socket.id}`)

  // Store the room that the socket is connected to
  // If you need to scale the app horizontally, you'll need to store this variable in a persistent store such as Redis.
  // For more info, see here: https://github.com/socketio/socket.io-redis
  let currentRoom = null

  /** Process a room join request. */
  socket.on('JOIN', (roomName) => {
    if (typeof roomName !== 'string' && typeof roomName !== 'number') return
    const roomLabel = String(roomName).trim()
    if (!roomLabel || roomLabel.length > 128) return
    const nextRoom = `chat:${roomLabel}`
    if (nextRoom === currentRoom) {
      socket.emit('ROOM_JOINED', roomLabel)
      return
    }
    // Get chatroom info
    const room = io.sockets.adapter.rooms.get(nextRoom)

    // Reject join request if room already has more than 1 connection
    if (room && room.size >= 2) {
      // Notify user that their join request was rejected
      socket.emit('ROOM_FULL', null)

      // Notify room that someone tried to join
      socket.broadcast.to(nextRoom).emit('INTRUSION_ATTEMPT', null)
    } else {
      // Leave current room
      if (currentRoom) {
        socket.leave(currentRoom)
        socket.broadcast.to(currentRoom).emit('USER_DISCONNECTED', null)
      }

      // Join new room
      currentRoom = nextRoom
      socket.join(currentRoom)

      // Notify user of room join success
      socket.emit('ROOM_JOINED', roomLabel)

      // Notify room that user has joined
      socket.broadcast.to(currentRoom).emit('NEW_CONNECTION', null)
    }
  })

  /** Broadcast a received message to the room */
  socket.on('MESSAGE', (msg) => {
    if (!currentRoom || !msg || typeof msg !== 'object') return
    if (typeof msg.text !== 'string' || msg.text.length > 16384) return
    if (typeof msg.sender !== 'string' || msg.sender.length > 8192) return
    if (typeof msg.recipient !== 'string' || msg.recipient.length > 8192) return
    const { text, sender, recipient } = msg
    socket.broadcast.to(currentRoom).emit('MESSAGE', { text, sender, recipient })
  })

  /** Broadcast a new publickey to the room */
  socket.on('PUBLIC_KEY', (key) => {
    if (!currentRoom || typeof key !== 'string' || key.length > 8192) return
    socket.broadcast.to(currentRoom).emit('PUBLIC_KEY', key)
  })

  /** Broadcast a disconnection notification to the room */
  socket.on('disconnecting', () => {
    if (currentRoom) socket.broadcast.to(currentRoom).emit('USER_DISCONNECTED', null)
  })
})

// Start server
if (require.main === module) {
  const port = process.env.PORT || 3000
  http.listen(port, () => {
    console.log(`Chat server listening on port ${http.address().port}.`)
  })
}

module.exports = { http, io }
