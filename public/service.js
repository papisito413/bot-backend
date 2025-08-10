let BASE_URL = null;
let ADMIN_TOKEN = null;

const hasLS = typeof window !== "undefined" && "localStorage" in window;

function getApiFromQuery() {
  try {
    const u = new URL(window.location.href);
    const api = u.searchParams.get("api");
    return api ? api.replace(/\/+$/, "") : null;
  } catch { return null; }
}
function getApiFromLocalStorage() {
  if (!hasLS) return null;
  const saved = localStorage.getItem("API_BASE_URL");
  return saved ? saved.replace(/\/+$/, "") : null;
}
function getApiFromEnvJs() {
  return (typeof window !== "undefined" && window.ENV_API_BASE_URL)
    ? String(window.ENV_API_BASE_URL).replace(/\/+$/, "")
    : null;
}
const DEFAULT_API_FALLBACK = "http://127.0.0.1:3001";

function resolveBaseUrl() {
  return getApiFromQuery() || getApiFromLocalStorage() || getApiFromEnvJs() || DEFAULT_API_FALLBACK;
}
BASE_URL = resolveBaseUrl();

if (hasLS) {
  const t = localStorage.getItem("ADMIN_TOKEN");
  if (t) ADMIN_TOKEN = t;
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

async function request(path, { method = "GET", body, token = ADMIN_TOKEN, apiKey } = {}) {
  const url = `${BASE_URL}${path}`;
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (apiKey) headers["x-api-key"] = apiKey;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === "string" ? data : (data?.error || res.statusText);
    throw new Error(`HTTP ${res.status} ${method} ${path} → ${msg}`);
  }
  return data;
}

export function health() { return request("/health", { token: null }); }

export async function login(username, password) {
  const data = await request("/api/session/login", { method: "POST", body: { username, password }, token: null });
  if (data?.token) setToken(data.token);
  return data;
}
export async function loginUser(username, password) {
  const data = await request("/api/session/login_user", { method: "POST", body: { username, password }, token: null });
  if (data?.token) setToken(data.token);
  return data;
}
export async function loginAndSetToken(username, password) {
  const { token } = await login(username, password);
  return token;
}

export function adminListUsers(token = ADMIN_TOKEN) {
  return request("/api/admin/users", { method: "GET", token });
}
export function adminCreateUser({ username, password, isAdmin = false }, token = ADMIN_TOKEN) {
  return request("/api/admin/users", { method: "POST", token, body: { username, password, isAdmin } });
}
export function adminUpdateUser(id, { username, password, isAdmin }, token = ADMIN_TOKEN) {
  return request(`/api/admin/users/${id}`, { method: "PUT", token, body: { username, password, isAdmin } });
}
export function adminDeleteUser(id, token = ADMIN_TOKEN) {
  return request(`/api/admin/users/${id}`, { method: "DELETE", token });
}

export function listBots(token = ADMIN_TOKEN) {
  return request("/api/admin/bots", { method: "GET", token });
}
export function createBot(name, token = ADMIN_TOKEN) {
  return request("/api/admin/bots", { method: "POST", token, body: { name } });
}
export function assignBotOwner(botId, ownerUserId, token = ADMIN_TOKEN) {
  return request(`/api/admin/bots/${botId}/owner`, { method: "PUT", token, body: { ownerUserId } });
}
export function setBotSecret(botId, { token, discordAppId }, admToken = ADMIN_TOKEN) {
  return request(`/api/admin/bots/${botId}/secret`, { method: "PUT", token: admToken, body: { token, discordAppId } });
}

export function meBots(token = ADMIN_TOKEN)  { return request("/api/me/bots",  { method: "GET", token }); }
export function meGuilds(token = ADMIN_TOKEN){ return request("/api/me/guilds",{ method: "GET", token }); }
export function claimGuild({ botId, guildId, name, icon }, token = ADMIN_TOKEN) {
  return request("/api/me/guilds/claim", { method: "POST", token, body: { botId, guildId, name, icon } });
}

export function getGuildRoles(guildId, token = ADMIN_TOKEN)   { return request(`/api/guilds/${guildId}/roles`,   { method: "GET", token }); }
export function getGuildChannels(guildId, token = ADMIN_TOKEN){ return request(`/api/guilds/${guildId}/channels`,{ method: "GET", token }); }
export function getGuildConfig(guildId, token = ADMIN_TOKEN)  { return request(`/api/guilds/${guildId}/config`,  { method: "GET", token }); }
export function saveGuildConfig(guildId, config, token = ADMIN_TOKEN) {
  return request(`/api/guilds/${guildId}/config`, { method: "PUT", token, body: config });
}
export function publishGuildPanel(guildId, token = ADMIN_TOKEN) {
  return request(`/api/guilds/${guildId}/publish`, { method: "POST", token });
}

export function botRegister({ apiKey, guildId, guildName, icon }) {
  return request("/api/bot/register", { method: "POST", token: null, apiKey, body: { guildId, guildName, icon } });
}
export function botUpdateRoles({ apiKey, guildId, roles }) {
  return request(`/api/guilds/${guildId}/roles`, { method: "POST", token: null, apiKey, body: { roles } });
}
export function botUpdateChannels({ apiKey, guildId, channels }) {
  return request(`/api/guilds/${guildId}/channels`, { method: "POST", token: null, apiKey, body: { channels } });
}
export function botGetConfig({ apiKey, guildId }) {
  return request(`/api/bot/guilds/${guildId}/config`, { method: "GET", token: null, apiKey });
}
export function botPollPublish({ apiKey, guildId, consume = false }) {
  const q = consume ? "?consume=1" : "";
  return request(`/api/bot/guilds/${guildId}/publish${q}`, { method: "GET", token: null, apiKey });
}

export function adminTables(token = ADMIN_TOKEN) {
  return request("/api/admin/tables", { method: "GET", token });
}
export function adminDeleteBot(botId, token = ADMIN_TOKEN) {
  return request(`/api/admin/bots/${botId}`, { method: "DELETE", token });
}
export function adminDeleteGuild(guildId, token = ADMIN_TOKEN) {
  return request(`/api/admin/guilds/${guildId}`, { method: "DELETE", token });
}
export function adminExport(token = ADMIN_TOKEN) {
  return request("/api/admin/export", { method: "GET", token });
}
export function adminImport(json, token = ADMIN_TOKEN) {
  return request("/api/admin/import", { method: "POST", token, body: json });
}
export function adminExportAll(token = ADMIN_TOKEN) {
  return request("/api/admin/export", { method: "GET", token });
}
