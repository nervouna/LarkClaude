import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const SESSIONS_FILE = new URL('../sessions.json', import.meta.url).pathname;

// simple promise chain lock to serialize read-modify-write
let _lock = Promise.resolve();
function withLock(fn) {
  _lock = _lock.then(fn, fn);
  return _lock;
}

async function load() {
  const raw = await readFile(SESSIONS_FILE, 'utf-8');
  return JSON.parse(raw);
}

async function save(data) {
  await writeFile(SESSIONS_FILE, JSON.stringify(data, null, 2) + '\n');
}

export async function getActive() {
  return withLock(async () => {
    const data = await load();
    const id = data.active;
    const s = data.sessions[id];
    if (!s) return null;
    return { id, ...s };
  });
}

export async function setSessionId(id, sessionId) {
  return withLock(async () => {
    const data = await load();
    if (!data.sessions[id]) throw new Error(`session "${id}" not found`);
    const now = new Date().toISOString();
    data.sessions[id].session_id = sessionId;
    if (!data.sessions[id].created_at) data.sessions[id].created_at = now;
    data.sessions[id].updated_at = now;
    await save(data);
  });
}

export async function list() {
  return withLock(async () => {
    const data = await load();
    return Object.entries(data.sessions).map(([id, s]) => ({
      id,
      alias: s.alias,
      work_dir: s.work_dir,
      model: s.model,
      created_at: s.created_at,
      updated_at: s.updated_at,
      active: id === data.active,
    }));
  });
}

export async function create({ alias, workDir }) {
  return withLock(async () => {
    const data = await load();
    const id = randomUUID();
    const now = new Date().toISOString();
    data.sessions[id] = {
      alias: alias || id.slice(0, 8),
      work_dir: workDir,
      model: null,
      created_at: now,
      updated_at: now,
    };
    data.active = id;
    await save(data);
    return { id, ...data.sessions[id] };
  });
}

export async function setActive(id) {
  return withLock(async () => {
    const data = await load();
    if (!data.sessions[id]) throw new Error(`session "${id}" not found`);
    data.active = id;
    await save(data);
  });
}

export async function setModel(id, model) {
  return withLock(async () => {
    const data = await load();
    if (!data.sessions[id]) throw new Error(`session "${id}" not found`);
    data.sessions[id].model = model || null;
    await save(data);
  });
}

export async function touch(id) {
  return withLock(async () => {
    const data = await load();
    if (!data.sessions[id]) return;
    const now = new Date().toISOString();
    if (!data.sessions[id].created_at) data.sessions[id].created_at = now;
    data.sessions[id].updated_at = now;
    await save(data);
  });
}

export async function getAuthorizedUsers() {
  return withLock(async () => {
    const data = await load();
    return data.authorized_users || [];
  });
}

export async function setAuthorizedUser(openId) {
  return withLock(async () => {
    const data = await load();
    if (!data.authorized_users) data.authorized_users = [];
    if (!data.authorized_users.includes(openId)) {
      data.authorized_users.push(openId);
      await save(data);
    }
  });
}
