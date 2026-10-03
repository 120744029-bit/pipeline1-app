// ============================================================
//        cloud-functions/api/tails.js —— 尾项接口（Neon）
//        改造：导出 originalHandler 供 Layero 复用
// ============================================================
import { neon } from '@neondatabase/serverless';

// ============================================================
//        ★ 导出业务逻辑（EdgeOne 和 Layero 共用）
// ============================================================
export async function originalHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    const sql = neon(process.env.DATABASE_URL);

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
      const rows = await sql`
        SELECT id, content, created_at, user_name FROM tail_items
        WHERE sub_item = ${subItem} AND line_no = ${lineNo}
        ORDER BY created_at ASC
      `;
      return res.status(200).json({
        items: rows.map(r => ({
          id: r.id, content: r.content,
          createdAt: r.created_at, user: r.user_name || ''
        }))
      });
    }

    if (action === 'get-all') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const rows = await sql`
        SELECT id, sub_item, line_no, content, created_at, user_name FROM tail_items
        ORDER BY sub_item, line_no, created_at ASC
      `;
      const grouped = {};
      rows.forEach(r => {
        const key = r.sub_item + '_' + r.line_no;
        if (!grouped[key]) grouped[key] = [];
        grouped[key].push({
          id: r.id, content: r.content,
          createdAt: r.created_at, user: r.user_name || ''
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

// ============================================================
//        EdgeOne 入口（保持不变）
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
                'Access-Control-Allow-Headers': 'Content-Type'
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