// ============================================================
//        cloud-functions/api/auth.js —— 账号与登录（Neon）
//        角色：owner(超管) / admin(管理员) / user(普通)
// ============================================================
import crypto from 'crypto';
import { neon } from '@neondatabase/serverless';

// 应用级凭据：前端可见，只挡"随便拿地址调"的脚本
const APP_TOKEN = process.env.APP_API_TOKEN || 'pd-app-f174c8613578189b';
// JWT 签名密钥：公开仓库，务必在 EdgeOne/Layero 控制台配置 JWT_SECRET 覆盖兜底值
const JWT_SECRET = process.env.JWT_SECRET || 'fd68a9a239318fb25324d8c076512413e3de66a4fccb9374bf192a5d206beb12';
const TOKEN_TTL = 30 * 24 * 3600 * 1000; // 30 天
const SEED_HASH = 'scrypt$563081d870dfc16a95755e3401a93e9e$da9fd5f5672783788b2a4c7c0a25f063366b60c927b4c8d291bced639315c92f729e9af1c8f7b84732221626f4970c5f85a99ab194084e23f6a892ccf1503493';

function b64u(buf) { return Buffer.from(buf).toString('base64url'); }
function signToken(u) {
  const payload = { uid: u.id, username: u.username, name: u.name, role: u.role, exp: Date.now() + TOKEN_TTL };
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + p).digest('base64url');
  return h + '.' + p + '.' + sig;
}
export function verifyToken(tok) {
  if (!tok) return null;
  const parts = String(tok).split('.');
  if (parts.length !== 3) return null;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(parts[0] + '.' + parts[1]).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const pl = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    if (!pl.exp || pl.exp < Date.now()) return null;
    return pl;
  } catch (e) { return null; }
}
function tokenFrom(req) {
  let t = (req.headers && req.headers.authorization) || '';
  t = t.replace(/^Bearer\s+/i, '');
  if (!t) t = (req.query && req.query._token) || '';
  return t;
}
function hashPwd(pwd) {
  const salt = crypto.randomBytes(16).toString('hex');
  return 'scrypt$' + salt + '$' + crypto.scryptSync(pwd, salt, 64).toString('hex');
}
function checkPwd(pwd, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 3 || p[0] !== 'scrypt') return false;
  const h = crypto.scryptSync(pwd, p[1], 64);
  const b = Buffer.from(p[2], 'hex');
  return h.length === b.length && crypto.timingSafeEqual(h, b);
}

let _usersReady = null;
async function ensureUsers(sql) {
  if (!_usersReady) {
    _usersReady = (async function () {
      await sql`CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        enabled BOOLEAN NOT NULL DEFAULT true,
        last_login TEXT,
        created_at TEXT NOT NULL DEFAULT now()::text
      )`;
      const cnt = await sql`SELECT COUNT(*)::int AS n FROM users`;
      if (!cnt[0] || !cnt[0].n) {
        await sql`INSERT INTO users (username, name, password_hash, role, enabled)
          VALUES ('huxindong', '胡信东', ${SEED_HASH}, 'owner', true)`;
      }
    })().catch(function (e) { _usersReady = null; throw e; });
  }
  return _usersReady;
}

// ============================================================
//              EdgeOne 入口（必须叫 onRequest）
// ============================================================
export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-App-Token, Authorization'
      }
    });
  }
  let body = {};
  if (request.method === 'POST') {
    try { body = await request.json(); } catch (e) { body = {}; }
  }
  const req = {
    method: request.method,
    query: Object.fromEntries(url.searchParams.entries()),
    body: body,
    headers: Object.fromEntries(request.headers.entries())
  };
  let _data = null, _status = 200;
  const res = {
    setHeader: () => {},
    status: (c) => { _status = c; return res; },
    json: (d) => { _data = d; return res; },
    end: () => res
  };
  await handler(req, res);
  return new Response(_data !== null ? JSON.stringify(_data) : '', {
    status: _status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}

// ============================================================
//              业务处理（EdgeOne + Layero 共用核心）
// ============================================================
export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 应用级凭据：所有动作都要带
  const appTok = (req.headers && req.headers['x-app-token']) || req.query.token || '';
  if (appTok !== APP_TOKEN) return res.status(401).json({ success: false, message: '未授权的应用' });

  const action = req.query.action || (req.body && req.body.action) || 'me';
  try {
    const sql = neon(process.env.DATABASE_URL);
    await ensureUsers(sql);

    // ---------- 登录（无需 JWT）----------
    if (action === 'login') {
      if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Method not allowed' });
      const { username, password } = req.body || {};
      if (!username || !password) return res.status(400).json({ success: false, message: '请输入账号和密码' });
      const rows = await sql`SELECT id, username, name, password_hash, role, enabled FROM users WHERE username = ${username}`;
      if (!rows.length || !rows[0].enabled || !checkPwd(password, rows[0].password_hash)) {
        return res.status(401).json({ success: false, message: '账号或密码错误' });
      }
      await sql`UPDATE users SET last_login = ${new Date().toISOString()} WHERE id = ${rows[0].id}`;
      const u = rows[0];
      return res.status(200).json({
        success: true,
        token: signToken(u),
        user: { username: u.username, name: u.name, role: u.role }
      });
    }

    // ---------- 以下动作需要登录 ----------
    const me = verifyToken(tokenFrom(req));
    if (!me) return res.status(401).json({ success: false, message: '登录已过期，请重新登录' });

    if (action === 'me') {
      return res.status(200).json({
        success: true,
        user: { uid: me.uid, username: me.username, name: me.name, role: me.role }
      });
    }

    // ---------- 修改自己的密码 ----------
    if (action === 'change-password') {
      const { oldPassword, newPassword } = req.body || {};
      if (!newPassword || newPassword.length < 6) return res.status(400).json({ success: false, message: '新密码至少 6 位' });
      const rows = await sql`SELECT id, password_hash FROM users WHERE id = ${me.uid}`;
      if (!rows.length || !checkPwd(oldPassword || '', rows[0].password_hash)) {
        return res.status(401).json({ success: false, message: '原密码错误' });
      }
      await sql`UPDATE users SET password_hash = ${hashPwd(newPassword)} WHERE id = ${me.uid}`;
      return res.status(200).json({ success: true });
    }

    // ---------- 账号管理：只有 owner ----------
    if (['list-users', 'add-user', 'disable-user', 'enable-user', 'reset-password', 'set-role', 'update-user', 'delete-user'].indexOf(action) !== -1) {
      if (me.role !== 'owner') return res.status(403).json({ success: false, message: '只有超级管理员能管理账号' });

      if (action === 'list-users') {
        const rows = await sql`SELECT id, username, name, role, enabled, last_login FROM users ORDER BY id ASC`;
        return res.status(200).json({
          success: true,
          users: rows.map(function (u) {
            return { id: u.id, username: u.username, name: u.name, role: u.role, enabled: !!u.enabled, lastLogin: u.last_login || '' };
          })
        });
      }

      if (action === 'add-user') {
        const { username, name, password, role } = req.body || {};
        if (!username || !password || !name) return res.status(400).json({ success: false, message: '账号、姓名、密码必填' });
        if (password.length < 6) return res.status(400).json({ success: false, message: '密码至少 6 位' });
        if (role === 'owner') return res.status(403).json({ success: false, message: '不能创建超级管理员' });
        const r = await sql`INSERT INTO users (username, name, password_hash, role, enabled)
          VALUES (${username}, ${name}, ${hashPwd(password)}, ${role === 'admin' ? 'admin' : 'user'}, true)
          RETURNING id, username, name, role`;
        return res.status(200).json({ success: true, user: r[0] });
      }

      if (action === 'disable-user' || action === 'enable-user') {
        const { id } = req.body || {};
        if (!id) return res.status(400).json({ success: false, message: 'id 必填' });
        if (Number(id) === Number(me.uid)) return res.status(403).json({ success: false, message: '不能禁用自己' });
        const rows = await sql`SELECT role FROM users WHERE id = ${id}`;
        if (!rows.length) return res.status(404).json({ success: false, message: '账号不存在' });
        if (rows[0].role === 'owner' && action === 'disable-user') {
          return res.status(403).json({ success: false, message: '超级管理员不能被禁用' });
        }
        await sql`UPDATE users SET enabled = ${action === 'enable-user'} WHERE id = ${id}`;
        return res.status(200).json({ success: true });
      }

      if (action === 'reset-password') {
        const { id, password } = req.body || {};
        if (!id || !password || password.length < 6) return res.status(400).json({ success: false, message: 'id 必填，密码至少 6 位' });
        await sql`UPDATE users SET password_hash = ${hashPwd(password)} WHERE id = ${id}`;
        return res.status(200).json({ success: true });
      }

      if (action === 'set-role') {
        const { id, role } = req.body || {};
        if (!id || ['owner', 'admin', 'user'].indexOf(role) === -1) return res.status(400).json({ success: false, message: '参数错误' });
        if (role === 'owner') return res.status(403).json({ success: false, message: '不能设置超级管理员' });
        const rows = await sql`SELECT role FROM users WHERE id = ${id}`;
        if (!rows.length) return res.status(404).json({ success: false, message: '账号不存在' });
        if (rows[0].role === 'owner') return res.status(403).json({ success: false, message: '超级管理员角色不可改' });
        await sql`UPDATE users SET role = ${role} WHERE id = ${id}`;
        return res.status(200).json({ success: true });
      }

      // 修改账号：账号名 / 姓名 / 角色（超管改自己时只放行账号名和姓名）
      if (action === 'update-user') {
        const { id, username, name, role } = req.body || {};
        if (!id) return res.status(400).json({ success: false, message: 'id 必填' });
        const rows = await sql`SELECT id, username, name, role FROM users WHERE id = ${id}`;
        if (!rows.length) return res.status(404).json({ success: false, message: '账号不存在' });
        const cur = rows[0];
        const newUsername = username === undefined ? cur.username : String(username).trim();
        const newName = name === undefined ? cur.name : String(name).trim();
        const newRole = role === undefined ? cur.role : role;
        if (!newUsername || !newName) return res.status(400).json({ success: false, message: '账号和姓名不能为空' });
        if (['owner', 'admin', 'user'].indexOf(newRole) === -1) return res.status(400).json({ success: false, message: '角色参数错误' });
        if (cur.role === 'owner' && newRole !== 'owner') return res.status(403).json({ success: false, message: '超级管理员角色不可改' });
        if (cur.role !== 'owner' && newRole === 'owner') return res.status(403).json({ success: false, message: '不能设置超级管理员' });
        if (newUsername !== cur.username) {
          const dup = await sql`SELECT id FROM users WHERE username = ${newUsername} AND id <> ${id}`;
          if (dup.length) return res.status(400).json({ success: false, message: '账号名已存在' });
        }
        await sql`UPDATE users SET username = ${newUsername}, name = ${newName}, role = ${newRole} WHERE id = ${id}`;
        const out = { id: cur.id, username: newUsername, name: newName, role: newRole };
        const self = Number(id) === Number(me.uid);
        return res.status(200).json({ success: true, user: out, token: self ? signToken({ id: cur.id, username: newUsername, name: newName, role: newRole }) : undefined });
      }

      // 删除账号：超管不可删、自己不可删
      if (action === 'delete-user') {
        const { id } = req.body || {};
        if (!id) return res.status(400).json({ success: false, message: 'id 必填' });
        if (Number(id) === Number(me.uid)) return res.status(403).json({ success: false, message: '不能删除当前账号' });
        const rows = await sql`SELECT role FROM users WHERE id = ${id}`;
        if (!rows.length) return res.status(404).json({ success: false, message: '账号不存在' });
        if (rows[0].role === 'owner') return res.status(403).json({ success: false, message: '超级管理员不能被删除' });
        await sql`DELETE FROM users WHERE id = ${id}`;
        return res.status(200).json({ success: true });
      }
    }

    return res.status(400).json({ success: false, message: 'Unknown action: ' + action });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}
