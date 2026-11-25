// ============================================================
//        cloud-functions/api/tails.js —— 尾项接口（Neon）
// ============================================================
import { neon } from '@neondatabase/serverless';


// ---------- 统一鉴权：应用凭据 + JWT 角色 ----------
import crypto from 'crypto';
const APP_TOKEN = 'pd-app-f174c8613578189b';
const JWT_SECRET = 'fd68a9a239318fb25324d8c076512413e3de66a4fccb9374bf192a5d206beb12';
function _tok(req) {
  let t = (req.headers && req.headers.authorization) || '';
  t = t.replace(/^Bearer\s+/i, '');
  return t || (req.query && req.query._token) || '';
}
function _role(req) {
  const tok = _tok(req);
  if (!tok) return '';
  const p = String(tok).split('.');
  if (p.length !== 3) return '';
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(p[0] + '.' + p[1]).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(p[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return '';
  try {
    const pl = JSON.parse(Buffer.from(p[1], 'base64url').toString());
    if (!pl.exp || pl.exp < Date.now()) return '';
    return pl.role || '';
  } catch (e) { return ''; }
}
function _checkApp(req, res) {
  const t = (req.headers && req.headers['x-app-token']) || req.query.token || '';
  if (t !== APP_TOKEN) { res.status(401).json({ success: false, message: '未授权的应用' }); return false; }
  return true;
}
function _needAdmin(req, res) {
  const r = _role(req);
  if (r !== 'owner' && r !== 'admin') { res.status(403).json({ success: false, message: '需要管理员权限' }); return false; }
  return true;
}

// 消除字段惰性建列（每个云函数实例只跑一次，幂等）
let _clearColsReady = null;
async function ensureClearCols(sql) {
  if (!_clearColsReady) {
    _clearColsReady = (async function () {
      await sql`ALTER TABLE tail_items ADD COLUMN IF NOT EXISTS cleared_by TEXT NOT NULL DEFAULT ''`;
      await sql`ALTER TABLE tail_items ADD COLUMN IF NOT EXISTS cleared_at TEXT NOT NULL DEFAULT ''`;
    })().catch(function (e) { _clearColsReady = null; throw e; });
  }
  return _clearColsReady;
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
                'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, X-App-Token, Authorization'
            }
        });
    }

    let body = {};
    if (request.method === 'POST' || request.method === 'DELETE') {
        try { body = await request.json(); } catch (e) { body = {}; }
    }

    const req = {
        method: request.method,
        query: Object.fromEntries(url.searchParams.entries()),
        body: body,
        headers: Object.fromEntries(request.headers.entries())
    };

    let _responseData = null;
    let _responseStatus = 200;
    const res = {
        setHeader: () => {},
        status: (code) => { _responseStatus = code; return res; },
        json: (data) => { _responseData = data; return res; },
        end: () => { return res; }
    };

    await originalHandler(req, res);

    return new Response(_responseData !== null ? JSON.stringify(_responseData) : '', {
        status: _responseStatus,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
        }
    });
}

// ============================================================
//              以下是你原来的业务逻辑，一行都不改
// ============================================================
async function originalHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Token, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;
  if (!_checkApp(req, res)) return;
  if (['update', 'delete', 'undo-clear'].indexOf(action) !== -1 && !_needAdmin(req, res)) return;

  try {
    const sql = neon(process.env.DATABASE_URL);

    // 幂等建列：消除状态存在同一张表里，不需要额外存储
    if (action === 'init') {
      await ensureClearCols(sql);
      const cols = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tail_items' AND column_name IN ('cleared_by','cleared_at')
      `;
      return res.status(200).json({ success: true, columns: cols.map(c => c.column_name) });
    }

    // 消除尾项（记录消除人+时间）
    if (action === 'clear') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { id, user } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const now = new Date().toISOString();
      const r = await sql`
        UPDATE tail_items SET cleared_by = ${user || ''}, cleared_at = ${now}
        WHERE id = ${id}
        RETURNING id, cleared_by, cleared_at
      `;
      if (r.length === 0) return res.status(404).json({ error: 'Item not found' });
      return res.status(200).json({ success: true, clearedBy: r[0].cleared_by, clearedAt: r[0].cleared_at });
    }

    // 撤销消除
    if (action === 'undo-clear') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await sql`UPDATE tail_items SET cleared_by = '', cleared_at = '' WHERE id = ${id}`;
      return res.status(200).json({ success: true });
    }

    // ============================================================
    // 1. 保存尾项
    // ============================================================
    if (action === 'save') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { subItem, lineNo, content, user } = req.body || {};
      if (!subItem || !lineNo || !content) {
        return res.status(400).json({ error: 'subItem, lineNo, content required' });
      }
      // 幂等：同一管线 + 同一内容只保留一条，防止网络重试/重复点产生重复尾项
      const dup = await sql`
        SELECT id, content, created_at, user_name FROM tail_items
        WHERE sub_item = ${subItem} AND line_no = ${lineNo} AND content = ${content}
        ORDER BY created_at ASC LIMIT 1
      `;
      if (dup.length) {
        return res.status(200).json({
          success: true, duplicated: true,
          item: {
            id: dup[0].id, content: dup[0].content,
            createdAt: dup[0].created_at, user: dup[0].user_name || ''
          }
        });
      }
      const result = await sql`
        INSERT INTO tail_items (sub_item, line_no, content, user_name)
        VALUES (${subItem}, ${lineNo}, ${content}, ${user || ''})
        RETURNING id, content, created_at, user_name
      `;
      return res.status(200).json({
        success: true,
        item: {
          id: result[0].id,
          content: result[0].content,
          createdAt: result[0].created_at,
          user: result[0].user_name || ''
        }
      });
    }

    // ============================================================
    // 2. 查询某管线的尾项
    // ============================================================
    if (action === 'get') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const { subItem, lineNo } = req.query;
      if (!subItem || !lineNo) {
        return res.status(400).json({ error: 'subItem and lineNo required' });
      }
      await ensureClearCols(sql);
      const rows = await sql`
        SELECT id, content, created_at, user_name, cleared_by, cleared_at
        FROM tail_items
        WHERE sub_item = ${subItem} AND line_no = ${lineNo}
        ORDER BY created_at ASC
      `;
      return res.status(200).json({
        items: rows.map(r => ({
          id: r.id,
          content: r.content,
          createdAt: r.created_at,
          user: r.user_name || '',
          clearedBy: r.cleared_by || '',
          clearedAt: r.cleared_at || ''
        }))
      });
    }

    // ============================================================
    // 3. 查询所有尾项（按 subItem_lineNo 分组）
    // ============================================================
    if (action === 'get-all') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      await ensureClearCols(sql);
      const rows = await sql`
        SELECT id, sub_item, line_no, content, created_at, user_name, cleared_by, cleared_at
        FROM tail_items
        ORDER BY sub_item, line_no, created_at ASC
      `;
      const grouped = {};
      rows.forEach(r => {
        const key = r.sub_item + '_' + r.line_no;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push({
          id: r.id,
          content: r.content,
          createdAt: r.created_at,
          user: r.user_name || '',
          clearedBy: r.cleared_by || '',
          clearedAt: r.cleared_at || ''
        });
      });
      return res.status(200).json(grouped);
    }

    // ============================================================
    // 4. 修改尾项
    // ============================================================
    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { id, content } = req.body || {};
      if (!id || !content) {
        return res.status(400).json({ error: 'id, content required' });
      }
      const result = await sql`
        UPDATE tail_items
        SET content = ${content}
        WHERE id = ${id}
        RETURNING id, content, created_at, user_name
      `;
      if (result.length === 0) {
        return res.status(404).json({ error: 'Item not found' });
      }
      return res.status(200).json({
        success: true,
        item: {
          id: result[0].id,
          content: result[0].content,
          createdAt: result[0].created_at,
          user: result[0].user_name || ''
        }
      });
    }

    // ============================================================
    // 5. 删除尾项
    // ============================================================
    if (action === 'delete') {
      const body = req.body || {};
      const q = req.query || {};
      const id = body.id || q.id;
      const subItem = body.subItem || q.subItem;
      const lineNo = body.lineNo || q.lineNo;
      const all = body.all || q.all;
      const items = body.items;

      if (id) {
        const r = await sql`DELETE FROM tail_items WHERE id = ${id} RETURNING id`;
        return res.status(200).json({
          success: true,
          deleted: r.length,
          message: r.length > 0 ? '已删除' : '未找到'
        });
      }

      if (Array.isArray(items) && items.length > 0) {
        let total = 0;
        for (const it of items) {
          if (!it.subItem || !it.lineNo) continue;
          const r = await sql`
            DELETE FROM tail_items
            WHERE sub_item = ${it.subItem} AND line_no = ${it.lineNo}
            RETURNING id
          `;
          total += r.length;
        }
        return res.status(200).json({
          success: true,
          deleted: total,
          message: '批量删除完成，共删除 ' + total + ' 条'
        });
      }

      if (subItem && lineNo) {
        const r = await sql`
          DELETE FROM tail_items
          WHERE sub_item = ${subItem} AND line_no = ${lineNo}
          RETURNING id
        `;
        return res.status(200).json({
          success: true,
          deleted: r.length,
          message: '已删除 ' + r.length + ' 条'
        });
      }

      return res.status(400).json({ error: 'id or items or (subItem, lineNo) required' });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
