// ============================================================
//        Layero 备用后端 —— tails 接口（Neon Postgres）
// ============================================================
import { neon } from '@neondatabase/serverless';

export async function handler(req, res) {
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