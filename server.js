// server.js — Backend TicketBot (admin + clientes + bots + JSON storage en Postgres KV)

import express from "express";
import cors from "cors";
import path from "path";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import { fileURLToPath } from "url";
import pkg from "pg";

const { Pool } = pkg;

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ===== .env =====
dotenv.config({ path: path.join(__dirname, ".env") });

// ===== App =====
const app = express();
app.use(express.json({ limit: "2mb" }));

// ---------- CORS (lista + wildcard *.dominio) ----------
const RAW_ORIGINS = (process.env.BASE_URL || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function matchOrigin(origin, pattern) {
  if (!origin) return true;
  if (pattern === "*") return true;
  if (pattern === origin) return true;
  try {
    const u = new URL(origin);
    const host = u.hostname;
    const m = pattern.match(/^https?:\/\/\*\.(.+)$/i);
    if (m) {
      const schemeOk = origin.startsWith(pattern.startsWith("https") ? "https://" : "http://");
      const domain = m[1];
      return schemeOk && (host === domain || host.endsWith(`.${domain}`));
    }
    return false;
  } catch {
    return false;
  }
}
const allowOrigin = (origin) => {
  if (!origin) return true;
  if (RAW_ORIGINS.includes("*")) return true;
  return RAW_ORIGINS.some(p => matchOrigin(origin, p));
};

app.use(cors({
  origin: (origin, cb) => cb(null, allowOrigin(origin)),
}));

// Log simple
app.use((req, _res, next) => { console.log("➡️", req.method, req.url); next(); });

// ===== Static (panel) opcional si sirves el front desde aquí =====
app.use(express.static(path.join(__dirname, "public")));
app.get("/panel", (_req, res) => res.sendFile(path.join(__dirname, "public", "app.html")));
app.get("/app",   (_req, res) => res.sendFile(path.join(__dirname, "public", "app.html")));
app.get("/", (_req, res) => res.redirect("/app"));

// ===== Postgres KV (files) =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// crea tabla KV
await pool.query(`
  CREATE TABLE IF NOT EXISTS files (
    name TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`);

// Helpers de KV (con stringify + ::jsonb)
async function readJSON(name, fallback) {
  const { rows } = await pool.query("SELECT data FROM files WHERE name=$1", [name]);
  if (rows[0]?.data !== undefined) return rows[0].data;

  await pool.query(
    "INSERT INTO files(name, data) VALUES ($1, $2::jsonb) ON CONFLICT (name) DO NOTHING",
    [name, JSON.stringify(fallback)]
  );
  return fallback;
}
async function writeJSON(name, val) {
  const payload = JSON.stringify(val);
  await pool.query(
    `INSERT INTO files(name, data)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (name) DO UPDATE SET data=$2::jsonb, updated_at=now()`,
    [name, payload]
  );
}

// ===== “Archivos” lógicos =====
const usersFile      = "users.json";           // [{id,username,passHash,isAdmin}]
const botsFile       = "bots.json";            // [{id,name,apiKey,ownerUserId,discordAppId?,token?}]
const guildsFile     = "guilds.json";          // [{guildId,botId,name,icon,lastSeen}]
const rolesFile      = "guild_roles.json";     // { [guildId]: Role[] }
const channelsFile   = "guild_channels.json";  // { [guildId]: Channel[] }
const cfgFile        = "guild_configs.json";   // { [guildId]: config }
const publishFile    = "publish_flags.json";   // { [guildId]: { requestedAt, byUser } }

// ===== Helpers =====
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function safeBotView(b) { const { token, ...rest } = b || {}; return rest; }

async function findUserByUsername(username) {
  const users = await readJSON(usersFile, []);
  return users.find(u => u.username === username) || null;
}

function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    theToken: {
      const token = h.startsWith("Bearer ") ? h.slice(7) : null;
      if (!token) return res.status(401).json({ error: "no token" });
      const payload = jwt.verify(token, process.env.JWT_SECRET || "secret");
      req.user = payload; // {uid, username, isAdmin}
      next();
    }
  } catch { return res.status(401).json({ error: "invalid token" }); }
}
function ensureAdmin(req, _res, next) {
  if (!req.user?.isAdmin) return next({ status: 403, message: "solo admin" });
  next();
}
const ensureOwner = wrap(async (req, res, next) => {
  const me = req.user;
  const guildId = req.params.guildId;
  const guilds = await readJSON(guildsFile, []);
  const bots   = await readJSON(botsFile, []);
  const g = guilds.find(x => x.guildId === guildId);
  if (!g) return res.status(404).json({ error: "guild no registrado" });
  const b = bots.find(x => x.id === g.botId);
  if (!b) return res.status(404).json({ error: "bot no encontrado" });
  if (!me.isAdmin && b.ownerUserId !== me.uid) return res.status(403).json({ error: "no eres dueño de este guild" });
  next();
});
const botAuth = wrap(async (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ error: "x-api-key required" });
  const bots = await readJSON(botsFile, []);
  const bot = bots.find(b => b.apiKey === apiKey);
  if (!bot) return res.status(401).json({ error: "invalid api key" });
  req.bot = bot; next();
});

// Publish flags helpers
async function setPublishFlag(guildId, byUser) {
  const all = await readJSON(publishFile, {});
  all[guildId] = { requestedAt: Date.now(), byUser: byUser || null };
  await writeJSON(publishFile, all);
}
async function consumePublishFlag(guildId) {
  const all = await readJSON(publishFile, {});
  const val = all[guildId] || null;
  if (val) {
    delete all[guildId];
    await writeJSON(publishFile, all);
    return { pending: true, info: val };
  }
  return { pending: false };
}
async function peekPublishFlag(guildId) {
  const all = await readJSON(publishFile, {});
  const val = all[guildId] || null;
  return { pending: !!val, info: val };
}

// ===== Health & DB check =====
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get("/api/_dbcheck", wrap(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
}));

// ===== Seed admin (si no existe) =====
(async function seedAdmin() {
  const users = await readJSON(usersFile, []);
  const adminUser = process.env.ADMIN_USER || "admin";
  if (!users.some(u => u.username === adminUser)) {
    const pass = process.env.ADMIN_PASS || "admin123";
    users.push({ id: "admin", username: adminUser, passHash: bcrypt.hashSync(pass, 10), isAdmin: true });
    await writeJSON(usersFile, users);
    console.log("👑 Usuario admin creado (seed)");
  }
})().catch(e => console.error("seedAdmin error:", e));

// ===== Auth (admin y cliente) =====
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASS)
    return res.status(400).json({ error: "usuario o contraseña inválidos" });
  const token = jwt.sign(
    { uid: "admin", username, isAdmin: true },
    process.env.JWT_SECRET || "secret",
    { expiresIn: "7d" }
  );
  res.json({ token });
});

app.post("/api/auth/login_user", wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const u = await findUserByUsername(username);
  if (!u) return res.status(400).json({ error: "usuario o contraseña inválidos" });
  if (!bcrypt.compareSync(String(password || ""), u.passHash))
    return res.status(400).json({ error: "usuario o contraseña inválidos" });
  const token = jwt.sign(
    { uid: u.id, username: u.username, isAdmin: !!u.isAdmin },
    process.env.JWT_SECRET || "secret",
    { expiresIn: "7d" }
  );
  res.json({ token });
}));

// ===== Admin: usuarios =====
app.get("/api/admin/users", auth, ensureAdmin, wrap(async (_req, res) => {
  const users = await readJSON(usersFile, []);
  res.json({ users: users.map(u => ({ id: u.id, username: u.username, isAdmin: !!u.isAdmin })) });
}));
app.post("/api/admin/users", auth, ensureAdmin, wrap(async (req, res) => {
  const { username, password, isAdmin = false } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username y password requeridos" });
  const users = await readJSON(usersFile, []);
  if (users.some(u => u.username === username)) return res.status(400).json({ error: "usuario ya existe" });
  const user = { id: uuidv4(), username, passHash: bcrypt.hashSync(password, 10), isAdmin: !!isAdmin };
  users.push(user); await writeJSON(usersFile, users);
  res.json({ ok: true, user: { id: user.id, username: user.username, isAdmin: user.isAdmin } });
}));
app.put("/api/admin/users/:id", auth, ensureAdmin, wrap(async (req, res) => {
  const { id } = req.params;
  const { username, password, isAdmin } = req.body || {};
  const users = await readJSON(usersFile, []);
  const u = users.find(x => x.id === id);
  if (!u) return res.status(404).json({ error: "no existe usuario" });
  if (typeof username === "string" && username.trim()) u.username = username.trim();
  if (typeof isAdmin === "boolean") u.isAdmin = isAdmin;
  if (typeof password === "string" && password.length) u.passHash = bcrypt.hashSync(password, 10);
  await writeJSON(usersFile, users);
  res.json({ ok: true, user: { id: u.id, username: u.username, isAdmin: u.isAdmin } });
}));
app.delete("/api/admin/users/:id", auth, ensureAdmin, wrap(async (req, res) => {
  const { id } = req.params;
  const users = await readJSON(usersFile, []);
  const idx = users.findIndex(x => x.id === id);
  if (idx === -1) return res.status(404).json({ error: "no existe usuario" });
  users.splice(idx, 1); await writeJSON(usersFile, users);
  res.json({ ok: true });
}));

// ===== Admin: bots =====
app.get("/api/admin/bots", auth, ensureAdmin, wrap(async (_req, res) => {
  const bots = (await readJSON(botsFile, [])).map(safeBotView);
  res.json({ bots });
}));
app.post("/api/admin/bots", auth, ensureAdmin, wrap(async (req, res) => {
  const { name, discordAppId, token } = req.body || {};
  if (!name) return res.status(400).json({ error: "name requerido" });
  const bots = await readJSON(botsFile, []);
  const bot = {
    id: uuidv4(),
    name,
    apiKey: uuidv4().replace(/-/g, ""),
    ownerUserId: null,
    discordAppId: discordAppId || null,
    ...(token ? { token } : {})
  };
  bots.push(bot); await writeJSON(botsFile, bots);
  res.json({ ok: true, bot: safeBotView(bot) });
}));
app.put("/api/admin/bots/:botId/owner", auth, ensureAdmin, wrap(async (req, res) => {
  const { botId } = req.params; const { ownerUserId } = req.body || {};
  const bots = await readJSON(botsFile, []); const b = bots.find(x => x.id === botId);
  if (!b) return res.status(404).json({ error: "no existe bot" });
  b.ownerUserId = ownerUserId || null; await writeJSON(botsFile, bots);
  res.json({ ok: true, bot: safeBotView(b) });
}));
app.put("/api/admin/bots/:botId/secret", auth, ensureAdmin, wrap(async (req, res) => {
  const { botId } = req.params; const { token, discordAppId } = req.body || {};
  const bots = await readJSON(botsFile, []); const b = bots.find(x => x.id === botId);
  if (!b) return res.status(404).json({ error: "no existe bot" });
  if (typeof token === "string") b.token = token;
  if (typeof discordAppId === "string") b.discordAppId = discordAppId;
  await writeJSON(botsFile, bots); res.json({ ok: true });
}));
app.delete("/api/admin/bots/:botId", auth, ensureAdmin, wrap(async (req, res) => {
  const { botId } = req.params;
  const bots = await readJSON(botsFile, []);
  const idx = bots.findIndex(x => x.id === botId);
  if (idx === -1) return res.status(404).json({ error: "no existe bot" });
  bots.splice(idx, 1); await writeJSON(botsFile, bots);
  res.json({ ok: true });
}));

// ===== Admin extra: tablas y import/export =====
app.get("/api/admin/tables", auth, ensureAdmin, wrap(async (_req, res) => {
  const users = await readJSON(usersFile, []);
  const bots  = (await readJSON(botsFile, [])).map(safeBotView);
  const guilds= await readJSON(guildsFile, []);
  res.json({ users, bots, guilds });
}));
app.get("/api/admin/export", auth, ensureAdmin, wrap(async (_req, res) => {
  const payload = {
    users: await readJSON(usersFile, []),
    bots: (await readJSON(botsFile, [])).map(safeBotView),
    guilds: await readJSON(guildsFile, []),
    roles: await readJSON(rolesFile, {}),
    channels: await readJSON(channelsFile, {}),
    configs: await readJSON(cfgFile, {}),
    publish_flags: await readJSON(publishFile, {})
  };
  res.json(payload);
}));
app.post("/api/admin/import", auth, ensureAdmin, wrap(async (req, res) => {
  const j = req.body || {};
  if (!j || typeof j !== "object") return res.status(400).json({ error: "JSON inválido" });
  if (j.users) await writeJSON(usersFile, j.users);
  if (j.bots) await writeJSON(botsFile, j.bots);
  if (j.guilds) await writeJSON(guildsFile, j.guilds);
  if (j.roles) await writeJSON(rolesFile, j.roles);
  if (j.channels) await writeJSON(channelsFile, j.channels);
  if (j.configs) await writeJSON(cfgFile, j.configs);
  if (j.publish_flags) await writeJSON(publishFile, j.publish_flags);
  res.json({ ok: true });
}));
app.delete("/api/admin/guilds/:guildId", auth, ensureAdmin, wrap(async (req, res) => {
  const { guildId } = req.params;
  const guilds = await readJSON(guildsFile, []);
  const idx = guilds.findIndex(g => g.guildId === guildId);
  if (idx === -1) return res.status(404).json({ error: "no existe guild" });
  guilds.splice(idx, 1); await writeJSON(guildsFile, guilds);
  res.json({ ok: true });
}));

// ===== Cliente: ver sus bots / guilds =====
app.get("/api/me/bots", auth, wrap(async (req, res) => {
  const me = req.user;
  const bots = (await readJSON(botsFile, [])).map(safeBotView);
  const mine = me.isAdmin ? bots : bots.filter(b => b.ownerUserId === me.uid);
  res.json({ bots: mine });
}));
app.get("/api/me/guilds", auth, wrap(async (req, res) => {
  const me = req.user;
  const bots = await readJSON(botsFile, []);
  const guilds = await readJSON(guildsFile, []);
  const myBotIds = me.isAdmin ? bots.map(b => b.id) : bots.filter(b => b.ownerUserId === me.uid).map(b => b.id);
  const mineGuilds = guilds.filter(g => myBotIds.includes(g.botId));
  res.json({ guilds: mineGuilds });
}));
app.post("/api/me/guilds/claim", auth, wrap(async (req, res) => {
  const { botId, guildId, name, icon } = req.body || {};
  if (!botId || !guildId) return res.status(400).json({ error: "botId y guildId requeridos" });

  const bots = await readJSON(botsFile, []);
  const b = bots.find(x => x.id === botId);
  if (!b) return res.status(404).json({ error: "bot no existe" });
  if (!req.user.isAdmin && b.ownerUserId !== req.user.uid) return res.status(403).json({ error: "no eres dueño de ese bot" });

  const guilds = await readJSON(guildsFile, []);
  let g = guilds.find(x => x.guildId === guildId);
  if (!g) {
    g = { guildId, botId: b.id, name: name || "Guild", icon: icon || null, lastSeen: Date.now() };
    guilds.push(g);
  } else {
    g.botId = b.id;
    if (name) g.name = name;
    if (icon) g.icon = icon;
    g.lastSeen = Date.now();
  }
  await writeJSON(guildsFile, guilds);
  res.json({ ok: true, guild: g });
}));

// ===== BOT: register + subir roles/canales + leer config + publish poll =====
app.post("/api/bot/register", botAuth, wrap(async (req, res) => {
  const { guildId, guildName, icon } = req.body || {};
  if (!guildId) return res.status(400).json({ error: "guildId requerido" });

  const guilds = await readJSON(guildsFile, []);
  let g = guilds.find(x => x.guildId === guildId);
  if (!g) {
    g = { guildId, botId: req.bot.id, name: guildName || "Guild", icon: icon || null, lastSeen: Date.now() };
    guilds.push(g);
  } else {
    g.botId = req.bot.id;
    g.name = guildName || g.name;
    g.icon = icon || g.icon;
    g.lastSeen = Date.now();
  }
  await writeJSON(guildsFile, guilds);
  res.json({ ok: true });
}));
app.post("/api/guilds/:guildId/roles", botAuth, wrap(async (req, res) => {
  const { roles } = req.body || {};
  if (!Array.isArray(roles)) return res.status(400).json({ error: "roles[] requerido" });
  const all = await readJSON(rolesFile, {}); all[req.params.guildId] = roles; await writeJSON(rolesFile, all);
  res.json({ ok: true });
}));
app.post("/api/guilds/:guildId/channels", botAuth, wrap(async (req, res) => {
  const { channels } = req.body || {};
  if (!Array.isArray(channels)) return res.status(400).json({ error: "channels[] requerido" });
  const all = await readJSON(channelsFile, {}); all[req.params.guildId] = channels; await writeJSON(channelsFile, all);
  res.json({ ok: true });
}));
app.get("/api/bot/guilds/:guildId/config", botAuth, wrap(async (req, res) => {
  const cfgs = await readJSON(cfgFile, {});
  res.json(cfgs[req.params.guildId] || defaultConfig());
}));
app.get("/api/bot/guilds/:guildId/publish", botAuth, wrap(async (req, res) => {
  const guildId = req.params.guildId;
  const consume = String(req.query.consume || "0") === "1";
  const out = consume ? await consumePublishFlag(guildId) : await peekPublishFlag(guildId);
  res.json(out);
}));

// ===== Panel cliente: roles, canales y config (dueño o admin) =====
app.get("/api/guilds/:guildId/roles", auth, ensureOwner, wrap(async (req, res) => {
  const all = await readJSON(rolesFile, {});
  res.json({ roles: all[req.params.guildId] || [] });
}));

app.get("/api/guilds/:guildId/channels", auth, ensureOwner, wrap(async (req, res) => {
  const all = await readJSON(channelsFile, {});
  res.json({ channels: all[req.params.guildId] || [] });
}));

app.get("/api/guilds/:guildId/config", auth, ensureOwner, wrap(async (req, res) => {
  const cfgs = await readJSON(cfgFile, {});
  res.json(cfgs[req.params.guildId] || defaultConfig());
}));

app.put("/api/guilds/:guildId/config", auth, ensureOwner, wrap(async (req, res) => {
  const cfgs = await readJSON(cfgFile, {});
  cfgs[req.params.guildId] = req.body || {};
  await writeJSON(cfgFile, cfgs);
  res.json({ ok: true });
}));

app.post("/api/guilds/:guildId/publish", auth, ensureOwner, wrap(async (req, res) => {
  const guildId = req.params.guildId;
  await setPublishFlag(guildId, req.user?.username || null);
  res.json({ ok: true, requestedAt: Date.now() });
}));

// ===== Default config =====
function defaultConfig() {
  return {
    brand: { name: "Service Bot", icon: "https://i.imgur.com/S2hhXYT.png" },
    panel: {
      bannerUrl: "https://i.imgur.com/hc282wH.png",
      theme: { bg: "#0f0f10", accent: "#6e57ff", text: "#ffffff" },
      title: "Panel de Tickets",
      layout: "list"
    },
    channels: {
      panelChannelId: null,
      logChannelId: null,
      ratingsChannelId: null
    },
    buttons: [
      { id: "ticket_general", title: "Soporte General", subtitle: "Ayuda en general.", label: "💬 Soporte", emoji: "💬", order: 1, visible: true }
    ],
    forms: {
      ticket_general: {
        title: "Formulario",
        fields: [
          { type: "short", id: "usuario",  label: "¿Nombre de usuario?", placeholder: "Tu nick", required: true,  maxLen: 100 },
          { type: "paragraph", id: "problema", label: "Problema", placeholder: "Describe tu situación", required: true, maxLen: 1000 }
        ]
      }
    },
    permissions: {
      staffRoleId: null,
      highStaffRoleId: null,
      buycraftRoleId: null,
      commands: { reiniciarreclamos: "highStaff", reclamos: "staff" }
    },
    misc: { tiendaUrl: "tienda.com", serverIp: "Server.net" }
  };
}

// ✅ Error handler en JSON (antes del 404)
app.use((err, req, res, _next) => {
  console.error("❌", err);
  res.status(err.status || 500).json({ error: err.message || "Internal error" });
});

// ===== 404 =====
app.use((req, res) => {
  console.log("⛔ 404:", req.method, req.url);
  res.status(404).send("Not found: " + req.method + " " + req.url);
});

// ===== Hardening =====
process.on("unhandledRejection", e => console.error("unhandledRejection:", e));
process.on("uncaughtException",  e => console.error("uncaughtException:", e));

// ===== Start =====
const PORT = Number(process.env.PORT ?? 3001) || 3001;
app.listen(PORT, () => console.log(`🚀 Backend escuchando en http://localhost:${PORT}`));
