const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "aviator_secret_key_2024";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

app.use(cors());
app.use(express.json());

const db = { users: {}, codes: {}, history: [] };

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token" });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ message: "Invalid token" }); }
}

function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== "admin") return res.status(403).json({ message: "Forbidden" });
    req.user = decoded; next();
  } catch { res.status(401).json({ message: "Invalid token" }); }
}

function findUserByUsername(username) {
  return Object.values(db.users).find(u => u.username === username);
}

let gameState = { status: "waiting", multiplier: 1.0, crash_at: 1.0, round_id: uuidv4(), players: [], start_time: null };

function generateCrashPoint() {
  if (Math.random() < 0.05) return 1.0;
  return Math.max(1.0, parseFloat((1 / (1 - Math.random()) * 0.97).toFixed(2)));
}

function startGameLoop() {
  gameState = { status: "waiting", multiplier: 1.0, crash_at: generateCrashPoint(), round_id: uuidv4(), players: [], start_time: null };
  setTimeout(() => {
    gameState.status = "running";
    gameState.start_time = Date.now();
    const interval = setInterval(() => {
      const elapsed = (Date.now() - gameState.start_time) / 1000;
      gameState.multiplier = parseFloat(Math.pow(Math.E, 0.06 * elapsed).toFixed(2));
      if (gameState.multiplier >= gameState.crash_at) {
        clearInterval(interval);
        gameState.status = "crashed";
        gameState.multiplier = gameState.crash_at;
        gameState.players.forEach(p => {
          if (!p.cashedOut) db.history.push({ id: uuidv4(), user_id: p.userId, bet: p.bet, cashout_at: null, multiplier: gameState.crash_at, win: 0, created_at: new Date().toISOString() });
        });
        setTimeout(startGameLoop, 5000);
      }
    }, 100);
  }, 5000);
}

startGameLoop();

app.post("/api/auth/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ message: "Username and password required" });
  if (username.length < 3) return res.status(400).json({ message: "Username must be at least 3 characters" });
  if (password.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
  if (findUserByUsername(username)) return res.status(400).json({ message: "Username already exists" });
  const id = uuidv4();
  db.users[id] = { id, username, password: bcrypt.hashSync(password, 10), balance: 100, created_at: new Date().toISOString() };
  const token = jwt.sign({ id, username, role: "user" }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id, username, balance: 100 } });
});

app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  const user = findUserByUsername(username);
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ message: "Invalid credentials" });
  const token = jwt.sign({ id: user.id, username: user.username, role: "user" }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, username: user.username, balance: user.balance } });
});

app.get("/api/auth/me", authMiddleware, (req, res) => {
  const user = db.users[req.user.id];
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json({ id: user.id, username: user.username, balance: user.balance });
});

app.post("/api/auth/logout", (req, res) => res.json({ message: "Logged out" }));

app.get("/api/game/state", (req, res) => {
  res.json({ status: gameState.status, multiplier: gameState.multiplier, round_id: gameState.round_id, crash_at: gameState.status === "crashed" ? gameState.crash_at : undefined, players_count: gameState.players.length });
});

app.post("/api/game/bet", authMiddleware, (req, res) => {
  if (gameState.status !== "waiting") return res.status(400).json({ message: "Betting is closed, wait for next round" });
  const { amount } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ message: "Invalid bet amount" });
  const user = db.users[req.user.id];
  if (!user || user.balance < amount) return res.status(400).json({ message: "Insufficient balance" });
  if (gameState.players.find(p => p.userId === req.user.id)) return res.status(400).json({ message: "Already placed a bet this round" });
  user.balance = parseFloat((user.balance - amount).toFixed(2));
  gameState.players.push({ userId: user.id, username: user.username, bet: amount, cashedOut: false });
  res.json({ message: "Bet placed", balance: user.balance });
});

app.post("/api/game/cashout", authMiddleware, (req, res) => {
  if (gameState.status !== "running") return res.status(400).json({ message: "Game is not running" });
  const player = gameState.players.find(p => p.userId === req.user.id);
  if (!player) return res.status(400).json({ message: "No active bet" });
  if (player.cashedOut) return res.status(400).json({ message: "Already cashed out" });
  const win = parseFloat((player.bet * gameState.multiplier).toFixed(2));
  player.cashedOut = true;
  player.cashoutAt = gameState.multiplier;
  const user = db.users[req.user.id];
  user.balance = parseFloat((user.balance + win).toFixed(2));
  db.history.push({ id: uuidv4(), user_id: user.id, bet: player.bet, cashout_at: gameState.multiplier, multiplier: gameState.multiplier, win, created_at: new Date().toISOString() });
  res.json({ message: "Cashed out!", win, multiplier: gameState.multiplier, balance: user.balance });
});

app.get("/api/game/history", authMiddleware, (req, res) => {
  res.json(db.history.filter(h => h.user_id === req.user.id).sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 20));
});

app.get("/api/game/live-players", (req, res) => {
  res.json(gameState.players.map(p => ({ username: p.username, bet: p.bet, cashedOut: p.cashedOut, cashoutAt: p.cashoutAt || null })));
});

app.get("/api/wallet/balance", authMiddleware, (req, res) => {
  const user = db.users[req.user.id];
  res.json({ balance: user?.balance || 0 });
});

app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ message: "Invalid admin password" });
  const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "1d" });
  res.json({ token });
});

app.get("/api/admin/users", adminMiddleware, (req, res) => {
  res.json(Object.values(db.users).map(u => ({ id: u.id, username: u.username, balance: u.balance, created_at: u.created_at })));
});

app.patch("/api/admin/users/:id", adminMiddleware, (req, res) => {
  const { balance } = req.body;
  if (balance === undefined) return res.status(400).json({ message: "Balance required" });
  const user = db.users[req.params.id];
  if (!user) return res.status(404).json({ message: "User not found" });
  user.balance = parseFloat(balance);
  res.json({ id: user.id, username: user.username, balance: user.balance });
});

app.delete("/api/admin/users/:id", adminMiddleware, (req, res) => {
  delete db.users[req.params.id]; res.json({ message: "User deleted" });
});

app.get("/api/admin/stats", adminMiddleware, (req, res) => {
  const users = Object.values(db.users);
  res.json({ total_users: users.length, total_balance: users.reduce((s, u) => s + u.balance, 0), total_games: db.history.length, current_game_status: gameState.status, current_multiplier: gameState.multiplier });
});

app.post("/api/admin/codes", adminMiddleware, (req, res) => {
  const { amount, count = 1 } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ message: "Amount required" });
  const codes = [];
  for (let i = 0; i < Math.min(count, 50); i++) {
    const id = uuidv4();
    const code = "AV-" + Math.random().toString(36).substring(2, 10).toUpperCase();
    db.codes[id] = { id, code, amount, used: false, used_by: null, created_at: new Date().toISOString() };
    codes.push(db.codes[id]);
  }
  res.json(codes);
});

app.get("/api/admin/codes", adminMiddleware, (req, res) => res.json(Object.values(db.codes).slice(-100)));

app.delete("/api/admin/codes/:id", adminMiddleware, (req, res) => {
  delete db.codes[req.params.id]; res.json({ message: "Code deleted" });
});

app.post("/api/wallet/redeem", authMiddleware, (req, res) => {
  const { code } = req.body;
  const record = Object.values(db.codes).find(c => c.code === code && !c.used);
  if (!record) return res.status(400).json({ message: "Invalid or already used code" });
  record.used = true;
  record.used_by = req.user.id;
  const user = db.users[req.user.id];
  user.balance = parseFloat((user.balance + record.amount).toFixed(2));
  res.json({ message: `Redeemed! +${record.amount} coins`, balance: user.balance });
});

app.get("/", (req, res) => res.json({ status: "OK", game: gameState.status }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
module.exports = app;
