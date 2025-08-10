// service.js — SDK del panel (browser-safe + Netlify friendly)

// ========= BASE URL RESOLVER =========
let BASE_URL = null;
let ADMIN_TOKEN = null;

const hasLS = typeof window !== "undefined" && window.localStorage;

// 1) query param ?api=https://api.tu-dominio.com
function getApiFromQuery() {
  try {
    const u = new URL(window.location.href);
    const api = u.searchParams.get("api");
    return api ? api.replace(/\/+$/, "") : null;
  } catch { return null; }
}

// 2) localStorage
function getApiFromLocalStorage() {
  if (!hasLS) return null;
  const saved = localStorage.getItem("API_BASE_URL");
  return saved ? saved.replace(/\/+$/, "") : null;
}

// 3) env.js (inyectado en Netlify como archivo estático)
function getApiFromEnvJs() {
  // en tu Netlify subirás /env.js con: window.ENV_API_BASE_URL="https://api.tu-dominio.com";
  const env = (typeof window !== "undefined" && window.ENV_API_BASE_URL) || null;
  return env ? String(env).replace(/\/+$/, "") : null;
}

// 4) fallback
const DEFAULT_API_FALLBACK = "https://tu-backend.example.com"; // <-- cámbialo cuando tengas tu backend público

function resolveBaseUrl() {
  return (
    getApiFromQuery() ||
    getApiFromLocalStorage() ||
    getApiFromEnvJs() ||
    DEFAULT_API_FALLBACK
  );
}

BASE_URL = resolveBaseUrl();

// ========= AUTH STORAGE =========
if (hasLS) {
  const savedTok = localStorage.getItem("ADMIN_TOKEN");
  if (savedTok) ADMIN_TOKEN = savedTok;
}

export function setBaseUrl(url) {
  BASE_URL = String(url || "").replace(/\/+$/, "");
  if (hasLS) localStorage.setItem("API_BASE_URL", BASE_URL);
}
export function getBaseUrl() { return BASE_URL; }

export function setToken(token) {
  ADMIN_TOKEN = token || null;
  if (!hasLS) return;
  if (token) localStorage.setItem("ADMIN_TOKEN", token);
  else localStorage.removeItem("ADMIN_TOKEN");
}
export function getToken() { return ADMIN_TOKEN; }

export function clearAll() {
  setToken(null);
  if (hasLS) localStorage.removeItem("API_BASE_URL");
}

// ========= HTTP =========
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

// ========= API =========
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

// Usuarios cliente
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

// Bots visibles para el usuario logeado
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

// Bot-only (x-api-key)
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
