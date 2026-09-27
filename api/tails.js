// ============================================================
//              Vercel Serverless Function - 尾项接口（Neon 合并版）
//              根据 ?action= 区分操作
//              save / get / get-all / update / delete
//              ✅ 新增：记录录入人 user（存到 user_name 列）
// ============================================================
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    const sql = neon(process.env.DATABASE_URL);

    // ============================================================
    // 1. 保存尾项
    //    POST /api/tails?action=save
    //    body: { subItem, lineNo, content, user }
    // ============================================================
    if (action === 'save') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      // ✅ 接收 user
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
          user: result[0].user_name || ''          // ✅ 返回给前端
        }
      });
    }

    // ============================================================
    // 2. 查询某管线的尾项
    //    GET /api/tails?action=get&subItem=xxx&lineNo=yyy
    // ============================================================
    if (action === 'get') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const { subItem, lineNo } = req.query;
      if (!subItem || !lineNo) {
        return res.status(400).json({ error: 'subItem and lineNo required' });
      }
      const rows = await sql`
        SELECT id, content, created_at, user_name
        FROM tail_items
        WHERE sub_item = ${subItem} AND line_no = ${lineNo}
        ORDER BY created_at ASC
      `;
      return res.status(200).json({
        items: rows.map(r => ({
          id: r.id,
          content: r.content,
          createdAt: r.created_at,
          user: r.user_name || ''                  // ✅
        }))
      });
    }

    // ============================================================
    // 3. 查询所有尾项（按 subItem_lineNo 分组）
    //    GET /api/tails?action=get-all
    // ============================================================
    if (action === 'get-all') {
      if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
      const rows = await sql`
        SELECT id, sub_item, line_no, content, created_at, user_name
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
          user: r.user_name || ''                  // ✅
        });
      });
      return res.status(200).json(grouped);
    }

    // ============================================================
    // 4. 修改尾项
    //    POST /api/tails?action=update
    //    body: { id, content }
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
          user: result[0].user_name || ''          // ✅
        }
      });
    }

    // ============================================================
    // 5. 删除尾项（逻辑不变）
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
