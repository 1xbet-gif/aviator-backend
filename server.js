const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");
const { v4: uuidv4 } = require("uuid");

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "aviator_secret_key_change_this";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

// ── Database ──────────────────────────────────────────────
const db = new Database("game.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    balance REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS codes (
    id TEXT PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    amount REAL NOT NULL,
    used INTEGER DEFAULT 0,
    used_by TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS game_history (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    bet REAL NOT NULL,
    cashout_at REAL,
    multiplier REAL,
    win REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Middleware ────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Helpers ───────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}

function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token" });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== "admin") return res.status(403).json({ message: "Forbidden" });
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ message: "Invalid token" });
  }
}

// ── Game State ────────────────────────────────────────────
let gameState = {
  status: "waiting", // waiting | running | crashed
  multiplier: 1.0,
  crash_at: 1.0,
  round_id: uuidv4(),
  players: [],
  start_time: null,
};

function generateCrashPoint() {
  const r = Math.random();
  if (r < 0.05) return 1.0;
  return Math.max(1.0, parseFloat((1 / (1 - Math.random()) * 0.97).toFixed(2)));
}

function startGameLoop() {
  // Wait phase
  gameState = {
    status: "waiting",
    multiplier: 1.0,
    crash_at: generateCrashPoint(),
    round_id: uuidv4(),
    players: [],
    start_time: null,
  };

  setTimeout(() => {
    // Running phase
    gameState.status = "running";
    gameState.start_time = Date.now();

    const interval = setInterval(() => {
      const elapsed = (Date.now() - gameState.start_time) / 1000;
      gameState.multiplier = parseFloat(Math.pow(Math.E, 0.06 * elapsed).toFixed(2));

      if (gameState.multiplier >= gameState.crash_at) {
        clearInterval(interval);
        gameState.status = "crashed";
        gameState.multiplier = gameState.crash_at;

        // Auto cashout players who didn't cashout
        gameState.players.forEach((p) => {
          if (!p.cashedOut) {
            db.prepare(
              "INSERT INTO game_history (id, user_id, bet, cashout_at, multiplier, win) VALUES (?, ?, ?, NULL, ?, 0)"
            ).run(uuidv4(), p.userId, p.bet, gameState.crash_at);
          }
        });

        setTimeout(startGameLoop, 5000);
      }
    }, 100);
  }, 5000);
}

startGameLoop();

// ════════════════════════════════════════════════════════════
// AUTH ROUTES
// ════════════════════════════════════════════════════════════

// Register
app.post("/api/auth/register", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ message: "Username and password required" });

  if (username.length < 3)
    return res.status(400).json({ message: "Username must be at least 3 characters" });
  if (password.length < 6)
    return res.status(400).json({ message: "Password must be at least 6 characters" });

  try {
    const hashed = bcrypt.hashSync(password, 10);
    const id = uuidv4();
    db.prepare("INSERT INTO users (id, username, password, balance) VALUES (?, ?, ?, ?)").run(
      id, username, hashed, 100
    );
    const token = jwt.sign({ id, username, role: "user" }, JWT_SECRET, { expiresIn: "7d" });
    res.json({ token, user: { id, username, balance: 100 } });
  } catch (e) {
    if (e.message.includes("UNIQUE")) {
      return res.status(400).json({ message: "Username already exists" });
    }
    res.status(500).json({ message: "Server error" });
  }
});

// Login
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ message: "Invalid credentials" });

  const token = jwt.sign({ id: user.id, username: user.username, role: "user" }, JWT_SECRET, {
    expiresIn: "7d",
  });
  res.json({ token, user: { id: user.id, username: user.username, balance: user.balance } });
});

// Me
app.get("/api/auth/me", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT id, username, balance FROM users WHERE id = ?").get(req.user.id);
  if (!user) return res.status(404).json({ message: "User not found" });
  res.json(user);
});

// Logout (client-side only, just confirm)
app.post("/api/auth/logout", (req, res) => {
  res.json({ message: "Logged out" });
});

// ════════════════════════════════════════════════════════════
// GAME ROUTES
// ════════════════════════════════════════════════════════════

// Game state
app.get("/api/game/state", (req, res) => {
  res.json({
    status: gameState.status,
    multiplier: gameState.multiplier,
    round_id: gameState.round_id,
    crash_at: gameState.status === "crashed" ? gameState.crash_at : undefined,
    players_count: gameState.players.length,
  });
});

// Place bet
app.post("/api/game/bet", authMiddleware, (req, res) => {
  if (gameState.status !== "waiting")
    return res.status(400).json({ message: "Betting is closed, wait for next round" });

  const { amount } = req.body;
  if (!amount || amount <= 0)
    return res.status(400).json({ message: "Invalid bet amount" });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  if (!user || user.balance < amount)
    return res.status(400).json({ message: "Insufficient balance" });

  // Check if already bet this round
  const alreadyBet = gameState.players.find((p) => p.userId === req.user.id);
  if (alreadyBet) return res.status(400).json({ message: "Already placed a bet this round" });

  db.prepare("UPDATE users SET balance = balance - ? WHERE id = ?").run(amount, req.user.id);
  gameState.players.push({ userId: req.user.id, username: user.username, bet: amount, cashedOut: false });

  res.json({ message: "Bet placed", balance: user.balance - amount });
});

// Cashout
app.post("/api/game/cashout", authMiddleware, (req, res) => {
  if (gameState.status !== "running")
    return res.status(400).json({ message: "Game is not running" });

  const player = gameState.players.find((p) => p.userId === req.user.id);
  if (!player) return res.status(400).json({ message: "No active bet" });
  if (player.cashedOut) return res.status(400).json({ message: "Already cashed out" });

  const win = parseFloat((player.bet * gameState.multiplier).toFixed(2));
  player.cashedOut = true;
  player.cashoutAt = gameState.multiplier;

  db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").run(win, req.user.id);
  db.prepare(
    "INSERT INTO game_history (id, user_id, bet, cashout_at, multiplier, win) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(uuidv4(), req.user.id, player.bet, gameState.multiplier, gameState.multiplier, win);

  const user = db.prepare("SELECT balance FROM users WHERE id = ?").get(req.user.id);
  res.json({ message: "Cashed out!", win, multiplier: gameState.multiplier, balance: user.balance });
});

// Game history
app.get("/api/game/history", authMiddleware, (req, res) => {
  const history = db
    .prepare("SELECT * FROM game_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 20")
    .all(req.user.id);
  res.json(history);
});

// Live players
app.get("/api/game/live-players", (req, res) => {
  res.json(
    gameState.players.map((p) => ({
      username: p.username,
      bet: p.bet,
      cashedOut: p.cashedOut,
      cashoutAt: p.cashoutAt || null,
    }))
  );
});

// Wallet balance
app.get("/api/wallet/balance", authMiddleware, (req, res) => {
  const user = db.prepare("SELECT balance FROM users WHERE id = ?").get(req.user.id);
  res.json({ balance: user?.balance || 0 });
});

// ════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ════════════════════════════════════════════════════════════

// Admin login
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD)
    return res.status(401).json({ message: "Invalid admin password" });

  const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "1d" });
  res.json({ token });
});

// Get all users
app.get("/api/admin/users", adminMiddleware, (req, res) => {
  const users = db.prepare("SELECT id, username, balance, created_at FROM users ORDER BY created_at DESC").all();
  res.json(users);
});

// Edit user balance
app.patch("/api/admin/users/:id", adminMiddleware, (req, res) => {
  const { balance } = req.body;
  if (balance === undefined) return res.status(400).json({ message: "Balance required" });

  db.prepare("UPDATE users SET balance = ? WHERE id = ?").run(balance, req.params.id);
  const user = db.prepare("SELECT id, username, balance FROM users WHERE id = ?").get(req.params.id);
  res.json(user);
});

// Delete user
app.delete("/api/admin/users/:id", adminMiddleware, (req, res) => {
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  res.json({ message: "User deleted" });
});

// Stats
app.get("/api/admin/stats", adminMiddleware, (req, res) => {
  const totalUsers = db.prepare("SELECT COUNT(*) as count FROM users").get();
  const totalBalance = db.prepare("SELECT SUM(balance) as total FROM users").get();
  const totalGames = db.prepare("SELECT COUNT(*) as count FROM game_history").get();
  res.json({
    total_users: totalUsers.count,
    total_balance: totalBalance.total || 0,
    total_games: totalGames.count,
    current_game_status: gameState.status,
    current_multiplier: gameState.multiplier,
  });
});

// Generate codes
app.post("/api/admin/codes", adminMiddleware, (req, res) => {
  const { amount, count = 1 } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ message: "Amount required" });

  const codes = [];
  for (let i = 0; i < Math.min(count, 50); i++) {
    const code = "AV-" + Math.random().toString(36).substring(2, 10).toUpperCase();
    const id = uuidv4();
    db.prepare("INSERT INTO codes (id, code, amount) VALUES (?, ?, ?)").run(id, code, amount);
    codes.push({ id, code, amount });
  }
  res.json(codes);
});

// Get all codes
app.get("/api/admin/codes", adminMiddleware, (req, res) => {
  const codes = db.prepare("SELECT * FROM codes ORDER BY created_at DESC LIMIT 100").all();
  res.json(codes);
});

// Delete code
app.delete("/api/admin/codes/:id", adminMiddleware, (req, res) => {
  db.prepare("DELETE FROM codes WHERE id = ?").run(req.params.id);
  res.json({ message: "Code deleted" });
});

// Redeem code (user)
app.post("/api/wallet/redeem", authMiddleware, (req, res) => {
  const { code } = req.body;
  const record = db.prepare("SELECT * FROM codes WHERE code = ? AND used = 0").get(code);
  if (!record) return res.status(400).json({ message: "Invalid or already used code" });

  db.prepare("UPDATE codes SET used = 1, used_by = ? WHERE id = ?").run(req.user.id, record.id);
  db.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").run(record.amount, req.user.id);

  const user = db.prepare("SELECT balance FROM users WHERE id = ?").get(req.user.id);
  res.json({ message: `Redeemed! +${record.amount} coins`, balance: user.balance });
});

// Health check
app.get("/", (req, res) => res.json({ status: "OK", game: gameState.status }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
