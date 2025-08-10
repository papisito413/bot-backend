// server.js — Backend TicketBot (admin + clientes + bots + JSON storage)

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv";
import bcrypt from "bcryptjs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ===== .env =====
dotenv.config({ path: path.join(__dirname, ".env") });

// ===== App =====
const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS: admite múltiples orígenes separados por coma (útil para Netlify/Render/local)
const ORIGINS = (process.env.BASE_URL || "*").split(",").map(s => s.trim());
app.use(cors({ origin: (origin, cb) => {
  if (!origin || ORIGINS.includes("*") || ORIGINS.includes(origin)) return cb(null, true);
  return cb(null, false);
}}));

// Log simple
app.use((req, _res, next) => { console.log("➡️", req.method, req.url); next(); });

// ===== Static (panel) =====
app.use(express.static(path.join(__dirname, "public")));
app.get("/panel", (_req, res) => res.sendFile(path.join(__dirname, "public", "app.html")));
app.get("/app",   (_req, res) => res.sendFile(path.join(__dirname, "public", "app.html")));
app.get("/", (_req, res) => res.redirect("/app"));

// ===== Storage JSON =====
const dataDir = path.join(__dirname, "data");
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

function readJSON(name, fallback) {
  const file = path.join(dataDir, name);
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(fallback, null, 2));
    const raw = fs.readFileSync(file, "utf8");
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function writeJSON(name, val) {
  const file = path.join(dataDir, name);
  fs.writeFileSync(file, JSON.stringify(val, null, 2));
}

// Archivos
const usersFile      = "users.json";           // [{id,username,passHash,isAdmin}]
const botsFile       = "bots.json";            // [{id,name,apiKey,ownerUserId,discordAppId?,token?}]
const guildsFile     = "guilds.json";          // [{guildId,botId,name,icon,lastSeen}]
const rolesFile      = "guild_roles.json";     // { [guildId]: Role[] }
const channelsFile   = "guild_channels.json";  // { [guildId]: Channel[] }
const cfgFile        = "guild_configs.json";   // { [guildId]: config }
const publishFile    = "publish_flags.json";   // { [guildId]: { requestedAt, byUser } }

// ===== Helpers =====
function safeBotView(b) { const { token, ...rest } = b || {}; return rest; }
function findUserByUsername(username) {
  const users = readJSON(usersFile, []); return users.find(u => u.username === username) || null;
}
function auth(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) return res.status(401).json({ error: "no token" });
    const payload = jwt.verify(token, process.env.JWT_SECRET || "secret");
    req.user = payload; // {uid, username, isAdmin}
    next();
  } catch { return res.status(401).json({ error: "invalid token" }); }
}
function ensureAdmin(req, res, next) {
  if (!req.user?.isAdmin) return res.status(403).json({ error: "solo admin" });
  next();
}
function ensureOwner(req, res, next) {
  try {
    const me = req.user;
    const guildId = req.params.guildId;
    const guilds = readJSON(guildsFile, []);
    const bots   = readJSON(botsFile, []);
    const g = guilds.find(x => x.guildId === guildId);
    if (!g) return res.status(404).json({ error: "guild no registrado" });
    const b = bots.find(x => x.id === g.botId);
    if (!b) return res.status(404).json({ error: "bot no encontrado" });
    if (!me.isAdmin && b.ownerUserId !== me.uid) return res.status(403).json({ error: "no eres dueño de este guild" });
    next();
  } catch { return res.status(401).json({ error: "invalid token" }); }
}
function botAuth(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  if (!apiKey) return res.status(401).json({ error: "x-api-key required" });
  const bots = readJSON(botsFile, []);
  const bot = bots.find(b => b.apiKey === apiKey);
  if (!bot) return res.status(401).json({ error: "invalid api key" });
  req.bot = bot; next();
}

// Publish flags helpers
function setPublishFlag(guildId, byUser) {
  const all = readJSON(publishFile, {});
  all[guildId] = { requestedAt: Date.now(), byUser: byUser || null };
  writeJSON(publishFile, all);
}
function consumePublishFlag(guildId) {
  const all = readJSON(publishFile, {});
  const val = all[guildId] || null;
  if (val) { delete all[guildId]; writeJSON(publishFile, all); return { pending: true, info: val }; }
  return { pending: false };
}
function peekPublishFlag(guildId) {
  const all = readJSON(publishFile, {});
  return { pending: !!all[guildId], info: all[guildId] || null };
}

// ===== Health =====
app.get("/health", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ===== Seed admin (si no existe) =====
(function seedAdmin() {
  const users = readJSON(usersFile, []);
  const adminUser = process.env.ADMIN_USER || "admin";
  if (!users.some(u => u.username === adminUser)) {
    const pass = process.env.ADMIN_PASS || "admin123";
    users.push({ id: "admin", username: adminUser, passHash: bcrypt.hashSync(pass, 10), isAdmin: true });
    writeJSON(usersFile, users);
    console.log("👑 Usuario admin creado (seed)");
  }
})();

// ===== Auth (admin y cliente) =====
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (username !== process.env.ADMIN_USER || password !== process.env.ADMIN_PASS)
    return res.status(400).json({ error: "usuario o contraseña inválidos" });
  const token = jwt.sign({ uid: "admin", username, isAdmin: true }, process.env.JWT_SECRET || "secret", { expiresIn: "7d" });
  res.json({ token });
});
app.post("/api/auth/login_user", (req, res) => {
  const { username, password } = req.body || {};
  const u = findUserByUsername(username);
  if (!u) return res.status(400).json({ error: "usuario o contraseña inválidos" });
  if (!bcrypt.compareSync(String(password || ""), u.passHash))
    return res.status(400).json({ error: "usuario o contraseña inválidos" });
  const token = jwt.sign({ uid: u.id, username: u.username, isAdmin: !!u.isAdmin }, process.env.JWT_SECRET || "secret", { expiresIn: "7d" });
  res.json({ token });
});

// ===== Admin: usuarios (CRUD para tabla) =====
app.get("/api/admin/users", auth, ensureAdmin, (_req, res) => {
  const users = readJSON(usersFile, []);
  res.json({ users: users.map(u => ({ id: u.id, username: u.username, isAdmin: !!u.isAdmin })) });
});
app.post("/api/admin/users", auth, ensureAdmin, (req, res) => {
  const { username, password, isAdmin = false } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username y password requeridos" });
  const users = readJSON(usersFile, []);
  if (users.some(u => u.username === username)) return res.status(400).json({ error: "usuario ya existe" });
  const user = { id: uuidv4(), username, passHash: bcrypt.hashSync(password, 10), isAdmin: !!isAdmin };
  users.push(user); writeJSON(usersFile, users);
  res.json({ ok: true, user: { id: user.id, username: user.username, isAdmin: user.isAdmin } });
});
app.put("/api/admin/users/:id", auth, ensureAdmin, (req, res) => {
  const { id } = req.params;
  const { username, password, isAdmin } = req.body || {};
  const users = readJSON(usersFile, []);
  const u = users.find(x => x.id === id);
  if (!u) return res.status(404).json({ error: "no existe usuario" });
  if (typeof username === "string" && username.trim()) u.username = username.trim();
  if (typeof isAdmin === "boolean") u.isAdmin = isAdmin;
  if (typeof password === "string" && password.length) u.passHash = bcrypt.hashSync(password, 10);
  writeJSON(usersFile, users);
  res.json({ ok: true, user: { id: u.id, username: u.username, isAdmin: u.isAdmin } });
});
app.delete("/api/admin/users/:id", auth, ensureAdmin, (req, res) => {
  const { id } = req.params;
  const users = readJSON(usersFile, []);
  const idx = users.findIndex(x => x.id === id);
  if (idx === -1) return res.status(404).json({ error: "no existe usuario" });
  users.splice(idx, 1); writeJSON(usersFile, users);
  res.json({ ok: true });
});

// ===== Admin: bots =====
app.get("/api/admin/bots", auth, ensureAdmin, (_req, res) => {
  const bots = readJSON(botsFile, []).map(safeBotView);
  res.json({ bots });
});
app.post("/api/admin/bots", auth, ensureAdmin, (req, res) => {
  const { name, discordAppId, token } = req.body || {};
  if (!name) return res.status(400).json({ error: "name requerido" });
  const bots = readJSON(botsFile, []);
  const bot = {
    id: uuidv4(),
    name,
    apiKey: uuidv4().replace(/-/g, ""),
    ownerUserId: null,
    discordAppId: discordAppId || null,
    ...(token ? { token } : {})
  };
  bots.push(bot); writeJSON(botsFile, bots);
  res.json({ ok: true, bot: safeBotView(bot) });
});
app.put("/api/admin/bots/:botId/owner", auth, ensureAdmin, (req, res) => {
  const { botId } = req.params; const { ownerUserId } = req.body || {};
  const bots = readJSON(botsFile, []); const b = bots.find(x => x.id === botId);
  if (!b) return res.status(404).json({ error: "no existe bot" });
  b.ownerUserId = ownerUserId || null; writeJSON(botsFile, bots);
  res.json({ ok: true, bot: safeBotView(b) });
});
app.put("/api/admin/bots/:botId/secret", auth, ensureAdmin, (req, res) => {
  const { botId } = req.params; const { token, discordAppId } = req.body || {};
  const bots = readJSON(botsFile, []); const b = bots.find(x => x.id === botId);
  if (!b) return res.status(404).json({ error: "no existe bot" });
  if (typeof token === "string") b.token = token;
  if (typeof discordAppId === "string") b.discordAppId = discordAppId;
  writeJSON(botsFile, bots); res.json({ ok: true });
});

// ===== Cliente: ver sus bots / guilds =====
app.get("/api/me/bots", auth, (req, res) => {
  const me = req.user;
  const bots = readJSON(botsFile, []).map(safeBotView);
  const mine = me.isAdmin ? bots : bots.filter(b => b.ownerUserId === me.uid);
  res.json({ bots: mine });
});
app.get("/api/me/guilds", auth, (req, res) => {
  const me = req.user;
  const bots = readJSON(botsFile, []);
  const guilds = readJSON(guildsFile, []);
  const myBotIds = me.isAdmin ? bots.map(b => b.id) : bots.filter(b => b.ownerUserId === me.uid).map(b => b.id);
  const mineGuilds = guilds.filter(g => myBotIds.includes(g.botId));
  res.json({ guilds: mineGuilds });
});
app.post("/api/me/guilds/claim", auth, (req, res) => {
  const { botId, guildId, name, icon } = req.body || {};
  if (!botId || !guildId) return res.status(400).json({ error: "botId y guildId requeridos" });

  const bots = readJSON(botsFile, []);
  const b = bots.find(x => x.id === botId);
  if (!b) return res.status(404).json({ error: "bot no existe" });
  if (!req.user.isAdmin && b.ownerUserId !== req.user.uid) return res.status(403).json({ error: "no eres dueño de ese bot" });

  const guilds = readJSON(guildsFile, []);
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
  writeJSON(guildsFile, guilds);
  res.json({ ok: true, guild: g });
});

// ===== BOT: register + subir roles/canales + leer config + publish poll =====
app.post("/api/bot/register", botAuth, (req, res) => {
  const { guildId, guildName, icon } = req.body || {};
  if (!guildId) return res.status(400).json({ error: "guildId requerido" });

  const guilds = readJSON(guildsFile, []);
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
  writeJSON(guildsFile, guilds);
  res.json({ ok: true });
});
app.post("/api/guilds/:guildId/roles", botAuth, (req, res) => {
  const { roles } = req.body || {};
  if (!Array.isArray(roles)) return res.status(400).json({ error: "roles[] requerido" });
  const all = readJSON(rolesFile, {}); all[req.params.guildId] = roles; writeJSON(rolesFile, all);
  res.json({ ok: true });
});
app.post("/api/guilds/:guildId/channels", botAuth, (req, res) => {
  const { channels } = req.body || {};
  if (!Array.isArray(channels)) return res.status(400).json({ error: "channels[] requerido" });
  const all = readJSON(channelsFile, {}); all[req.params.guildId] = channels; writeJSON(channelsFile, all);
  res.json({ ok: true });
});
app.get("/api/bot/guilds/:guildId/config", botAuth, (req, res) => {
  const cfgs = readJSON(cfgFile, {});
  res.json(cfgs[req.params.guildId] || defaultConfig());
});
app.get("/api/bot/guilds/:guildId/publish", botAuth, (req, res) => {
  const guildId = req.params.guildId;
  const consume = String(req.query.consume || "0") === "1";
  const out = consume ? consumePublishFlag(guildId) : peekPublishFlag(guildId);
  res.json(out);
});

// ===== Panel cliente: roles, canales y config (dueño o admin) =====
app.get("/api/guilds/:guildId/roles", auth, ensureOwner, (req, res) => {
  const all = readJSON(rolesFile, {}); res.json({ roles: all[req.params.guildId] || [] });
});
app.get("/api/guilds/:guildId/channels", auth, ensureOwner, (req, res) => {
  const all = readJSON(channelsFile, {}); res.json({ channels: all[req.params.guildId] || [] });
});
app.get("/api/guilds/:guildId/config", auth, ensureOwner, (req, res) => {
  const cfgs = readJSON(cfgFile, {}); res.json(cfgs[req.params.guildId] || defaultConfig());
});
app.put("/api/guilds/:guildId/config", auth, ensureOwner, (req, res) => {
  const cfgs = readJSON(cfgFile, {}); cfgs[req.params.guildId] = req.body || {}; writeJSON(cfgFile, cfgs);
  res.json({ ok: true });
});
app.post("/api/guilds/:guildId/publish", auth, ensureOwner, (req, res) => {
  const guildId = req.params.guildId; setPublishFlag(guildId, req.user?.username || null);
  res.json({ ok: true, requestedAt: Date.now() });
});

// ===== Admin: export rápido (backup JSON) =====
app.get("/api/admin/export", auth, ensureAdmin, (_req, res) => {
  const payload = {
    users: readJSON(usersFile, []),
    bots: readJSON(botsFile, []),
    guilds: readJSON(guildsFile, []),
    roles: readJSON(rolesFile, {}),
    channels: readJSON(channelsFile, {}),
    configs: readJSON(cfgFile, {}),
    publish_flags: readJSON(publishFile, {})
  };
  res.json(payload);
});

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
