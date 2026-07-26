const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');

for (const dir of [DATA_DIR, UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
}

function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

let users = readJSON(USERS_FILE, {});       // username -> { passwordHash }
let messages = readJSON(MESSAGES_FILE, []); // see shape below

function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
function saveMessages() {
  fs.writeFileSync(MESSAGES_FILE, JSON.stringify(messages, null, 2));
}

// login tokens, kept in memory - restarting the server signs everyone out
const tokens = new Map(); // token -> username

// a DM between two people gets a stable room id regardless of who
// started it, just the two usernames sorted and joined together
function dmRoom(a, b) {
  return [a, b].sort().join('::');
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const username = tokens.get(token);

  if (!username) return res.status(401).json({ error: 'Not logged in.' });

  req.username = username;
  next();
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/signup', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }
  if (username.length < 2 || username.length > 24) {
    return res.status(400).json({ error: 'Username should be 2-24 characters.' });
  }
  if (users[username]) {
    return res.status(400).json({ error: 'That username is taken.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password should be at least 6 characters.' });
  }

  users[username] = { passwordHash: bcrypt.hashSync(password, 10) };
  saveUsers();
  res.json({ ok: true });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, username);
  res.json({ token, username });
});

app.post('/logout', requireAuth, (req, res) => {
  const header = req.headers.authorization || '';
  tokens.delete(header.slice(7));
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ username: req.username });
});

// everyone except yourself, so the sidebar has someone to DM
app.get('/api/users', requireAuth, (req, res) => {
  const others = Object.keys(users).filter((u) => u !== req.username);
  res.json(others);
});

app.get('/api/messages/general', requireAuth, (req, res) => {
  res.json(messages.filter((m) => m.room === 'general'));
});

app.get('/api/messages/with/:username', requireAuth, (req, res) => {
  const room = dmRoom(req.username, req.params.username);
  res.json(messages.filter((m) => m.room === room));
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomBytes(8).toString('hex');
    cb(null, id + path.extname(file.originalname));
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } });

app.post('/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  res.json({
    fileLink: `/uploads/${req.file.filename}`,
    fileName: req.file.originalname,
    fileIsImage: req.file.mimetype.startsWith('image/')
  });
});

app.use('/uploads', express.static(UPLOAD_DIR));

// --- realtime ---

const socketsByUser = new Map(); // username -> Set of socket ids (multiple tabs/devices)

function broadcastPresence() {
  io.emit('presence', [...socketsByUser.keys()]);
}

// sends an event only to the people who should see a given message -
// everyone for the group room, or just the two participants for a DM
function broadcastToRoom(message, event, payload) {
  if (message.to) {
    io.to(message.from).to(message.to).emit(event, payload);
  } else {
    io.to('general').emit(event, payload);
  }
}

io.on('connection', (socket) => {
  let username = null;

  socket.on('authenticate', (token) => {
    const name = tokens.get(token);
    if (!name) {
      socket.emit('auth_error');
      return;
    }
    username = name;

    if (!socketsByUser.has(username)) socketsByUser.set(username, new Set());
    socketsByUser.get(username).add(socket.id);

    socket.join('general');
    socket.join(username); // personal room, used for DMs and typing pings

    broadcastPresence();
  });

  socket.on('chat message', (data) => {
    if (!username) return;

    const room = data.to ? dmRoom(username, data.to) : 'general';

    const message = {
      id: crypto.randomBytes(6).toString('hex'),
      from: username,
      to: data.to || null,
      room,
      text: (data.text || '').slice(0, 4000),
      fileLink: data.fileLink || null,
      fileName: data.fileName || null,
      fileIsImage: data.fileIsImage || false,
      timestamp: Date.now(),
      editedAt: null,
      reactions: {} // emoji -> array of usernames who reacted with it
    };

    if (!message.text && !message.fileLink) return;

    messages.push(message);
    saveMessages();

    broadcastToRoom(message, 'chat message', message);
  });

  socket.on('edit message', (data) => {
    if (!username) return;
    const message = messages.find((m) => m.id === data.id);
    if (!message || message.from !== username) return; // only the author can edit
    if (!data.text || !data.text.trim()) return;

    message.text = data.text.slice(0, 4000);
    message.editedAt = Date.now();
    saveMessages();

    broadcastToRoom(message, 'message edited', { id: message.id, text: message.text, editedAt: message.editedAt });
  });

  socket.on('delete message', (data) => {
    if (!username) return;
    const index = messages.findIndex((m) => m.id === data.id);
    if (index === -1 || messages[index].from !== username) return;

    const message = messages[index];
    messages.splice(index, 1);
    saveMessages();

    broadcastToRoom(message, 'message deleted', { id: message.id });
  });

  socket.on('react message', (data) => {
    if (!username || !data.emoji) return;
    const message = messages.find((m) => m.id === data.id);
    if (!message) return;

    const reactors = message.reactions[data.emoji] || [];
    const already = reactors.includes(username);
    message.reactions[data.emoji] = already
      ? reactors.filter((u) => u !== username)
      : [...reactors, username];
    if (message.reactions[data.emoji].length === 0) delete message.reactions[data.emoji];
    saveMessages();

    broadcastToRoom(message, 'message reacted', { id: message.id, reactions: message.reactions });
  });

  socket.on('typing', (data) => {
    if (!username) return;
    const target = data.to || 'general';
    socket.to(target).emit('typing', { from: username, to: data.to || null });
  });

  socket.on('disconnect', () => {
    if (!username) return;
    const sockets = socketsByUser.get(username);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) socketsByUser.delete(username);
    }
    broadcastPresence();
  });
});

// prune anything on disk older than a day, once an hour
setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(UPLOAD_DIR)) {
    const filePath = path.join(UPLOAD_DIR, name);
    if (fs.statSync(filePath).mtimeMs < cutoff) fs.unlinkSync(filePath);
  }
}, 60 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Correspond running at http://localhost:${PORT}`);
});
