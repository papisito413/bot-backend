// service.js — SDK del panel (se ejecuta en el navegador)

if (typeof fetch === "undefined") {
  const mod = await import("node-fetch");
  globalThis.fetch = mod.default;
}

let BASE_URL = "http://localhost:3001";
let ADMIN_TOKEN = null;

const hasLS = typeof window !== "undefined" && window.localStorage;
if (hasLS) {
  const savedBase = localStorage.getItem("API_BASE_URL");
  const savedTok  = localStorage.getItem("ADMIN_TOKEN");
  if (savedBase) BASE_URL = savedBase.replace(/\/+$/, "");
  if (savedTok)  ADMIN_TOKEN = savedTok;
}

export function setBaseUrl(url) {
  BASE_URL = String(url || "").replace(/\/+$/, "");
  if (hasLS) localStorage.setItem("API_BASE_URL", BASE_URL);
}
export function getBaseUrl() { return BASE_URL; }

export function setToken(token) {
  ADMIN_TOKEN = token || null;
  if (hasLS) {
    if (token) localStorage.setItem("ADMIN_TOKEN", token);
    else localStorage.removeItem("ADMIN_TOKEN");
  }
}
export function getToken() { return ADMIN_TOKEN; }

export function clearAll() {
  setToken(null);
  if (hasLS) localStorage.removeItem("API_BASE_URL");
}

async function request(path, { method = "GET", body, token = ADMIN_TOKEN, apiKey } = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (apiKey) headers["x-api-key"]    = apiKey;

  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    const msg = typeof data === "string" ? data : (data?.error || res.statusText);
    throw new Error(`HTTP ${res.status} ${method} ${path} → ${msg}`);
  }
  return data;
}

// Health
export function health() { return request("/health", { method: "GET", token: null }); }

// Login (admin/pass del .env del backend)
export async function login(username, password) {
  const data = await request("/api/auth/login", {
    method: "POST",
    body: { username, password },
    token: null
  });
  if (data?.token) setToken(data.token);
  return data; // { token }
}

// ==== Usuarios & login (para clientes) ====
export async function loginUser(username, password) {
  const data = await request("/api/auth/login_user", {
    method: "POST",
    body: { username, password },
    token: null
  });
  if (data?.token) setToken(data.token);
  return data; // { token }
}
export function adminCreateUser({ username, password, isAdmin = false }, token = ADMIN_TOKEN) {
  return request("/api/admin/users", {
    method: "POST", token, body: { username, password, isAdmin }
  });
}

// Bots visibles para el usuario logeado (admin ve todos, cliente ve los suyos)
export function meBots(token = ADMIN_TOKEN) { return request("/api/me/bots", { method: "GET", token }); }
export function meGuilds(token = ADMIN_TOKEN) { return request("/api/me/guilds", { method: "GET", token }); }

// Admin: bots
export function listBots(token = ADMIN_TOKEN) { return request("/api/admin/bots", { method: "GET", token }); }
export function createBot(name, token = ADMIN_TOKEN) {
  return request("/api/admin/bots", { method: "POST", body: { name }, token });
}
export function assignBotOwner(botId, ownerUserId, token = ADMIN_TOKEN) {
  return request(`/api/admin/bots/${botId}/owner`, { method: "PUT", body: { ownerUserId }, token });
}

// Bot-only (con x-api-key) — expuestas por conveniencia si tests locales
export function botRegister({ apiKey, guildId, guildName, icon }) {
  return request("/api/bot/register", { method: "POST", apiKey, token: null, body: { guildId, guildName, icon } });
}
export function botUpdateRoles({ apiKey, guildId, roles }) {
  return request(`/api/guilds/${guildId}/roles`, { method: "POST", apiKey, token: null, body: { roles } });
}

// Panel: roles, canales y config
export function getGuildRoles(guildId, token = ADMIN_TOKEN) {
  return request(`/api/guilds/${guildId}/roles`, { method: "GET", token });
}
export function getGuildChannels(guildId, token = ADMIN_TOKEN) {
  return request(`/api/guilds/${guildId}/channels`, { method: "GET", token });
}
export function getGuildConfig(guildId, token = ADMIN_TOKEN) {
  return request(`/api/guilds/${guildId}/config`, { method: "GET", token });
}
export function saveGuildConfig(guildId, config, token = ADMIN_TOKEN) {
  return request(`/api/guilds/${guildId}/config`, { method: "PUT", body: config, token });
}
export function publishGuildPanel(guildId, token = ADMIN_TOKEN) {
  return request(`/api/guilds/${guildId}/publish`, { method: "POST", token });
}

// Helper
export async function loginAndSetToken(username, password) {
  const { token } = await login(username, password);
  return token;
}
