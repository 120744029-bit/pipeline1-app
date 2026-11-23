// ============================================================
//        Layero 备用后端 —— tails 接口（Neon Postgres）
// ============================================================
import { neon } from '@neondatabase/serverless';

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

export async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    const sql = neon(process.env.DATABASE_URL);

    if (action === 'init') {
      await ensureClearCols(sql);
      const cols = await sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'tail_items' AND column_name IN ('cleared_by','cleared_at')
      `;
      return res.status(200).json({ success: true, columns: cols.map(c => c.column_name) });
    }

    if (action === 'clear') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { id, user } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await ensureClearCols(sql);
      const now = new Date().toISOString();
      const r = await sql`
        UPDATE tail_items SET cleared_by = ${user || ''}, cleared_at = ${now}
        WHERE id = ${id} RETURNING id, cleared_by, cleared_at
      `;
      if (r.length === 0) return res.status(404).json({ error: 'Item not found' });
      return res.status(200).json({ success: true, clearedBy: r[0].cleared_by, clearedAt: r[0].cleared_at });
    }

    if (action === 'undo-clear') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      await ensureClearCols(sql);
      await sql`UPDATE tail_items SET cleared_by = '', cleared_at = '' WHERE id = ${id}`;
      return res.status(200).json({ success: true });
    }

    if (action === 'save') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { subItem, lineNo, content, user } = req.body || {};
      if (!subItem || !lineNo || !content) {
        return res.status(400).json({ error: 'subItem, lineNo, content required' });
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

    if (action === 'get') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const { subItem, lineNo } = req.query;
      if (!subItem || !lineNo) {
        return res.status(400).json({ error: 'subItem and lineNo required' });
      }
      await ensureClearCols(sql);
      const rows = await sql`
        SELECT id, content, created_at, user_name, cleared_by, cleared_at FROM tail_items
        WHERE sub_item = ${subItem} AND line_no = ${lineNo}
        ORDER BY created_at ASC
      `;
      return res.status(200).json({
        items: rows.map(r => ({
          id: r.id, content: r.content,
          createdAt: r.created_at, user: r.user_name || '',
          clearedBy: r.cleared_by || '', clearedAt: r.cleared_at || ''
        }))
      });
    }

    if (action === 'get-all') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      await ensureClearCols(sql);
      const rows = await sql`
        SELECT id, sub_item, line_no, content, created_at, user_name, cleared_by, cleared_at FROM tail_items
        ORDER BY sub_item, line_no, created_at ASC
      `;
      const grouped = {};
      rows.forEach(r => {
        const key = r.sub_item + '_' + r.line_no;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push({
          id: r.id, content: r.content,
          createdAt: r.created_at, user: r.user_name || '',
          clearedBy: r.cleared_by || '', clearedAt: r.cleared_at || ''
        });
      });
      return res.status(200).json(grouped);
    }

    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { id, content } = req.body || {};
      if (!id || !content) {
        return res.status(400).json({ error: 'id, content required' });
      }
      const result = await sql`
        UPDATE tail_items SET content = ${content} WHERE id = ${id}
        RETURNING id, content, created_at, user_name
      `;
      if (result.length === 0) {
        return res.status(404).json({ error: 'Item not found' });
      }
      return res.status(200).json({
        success: true,
        item: {
          id: result[0].id, content: result[0].content,
          createdAt: result[0].created_at, user: result[0].user_name || ''
        }
      });
    }

    if (action === 'delete') {
      const body = req.body || {};
      const q = req.query || {};
      const id = body.id || q.id;
      const subItem = body.subItem || q.subItem;
      const lineNo = body.lineNo || q.lineNo;
      const items = body.items;

      if (id) {
        const r = await sql`DELETE FROM tail_items WHERE id = ${id} RETURNING id`;
        return res.status(200).json({
          success: true, deleted: r.length,
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
          success: true, deleted: total,
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
          success: true, deleted: r.length,
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