import { neon } from "@neondatabase/serverless";
import { Redis } from "@upstash/redis";

// -------------------------- KV 初始化 --------------------------
let kv;
function getKvInstance() {
  if (!kv) {
    kv = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
  return kv;
}

// ===================== tailsHandler 尾项业务 =====================
async function tailsHandler(req, res) {
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
          user: r.user_name || ''
        }))
      });
    }

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
          user: r.user_name || ''
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

// ===================== workHandler 工作量业务 =====================
async function workHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query;
  try {
    const sql = neon(process.env.DATABASE_URL);

    if (action === 'init') {
      await sql`
        CREATE TABLE IF NOT EXISTS work_teams (
          id SERIAL PRIMARY KEY,
          area TEXT NOT NULL,
          fitter TEXT DEFAULT '',
          welder TEXT DEFAULT '',
          helper TEXT DEFAULT '',
          sort_order INT DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS work_records (
          id SERIAL PRIMARY KEY,
          team_id INT NOT NULL REFERENCES work_teams(id) ON DELETE CASCADE,
          work_date DATE NOT NULL,
          unit TEXT NOT NULL,
          quantity NUMERIC DEFAULT 0,
          note TEXT DEFAULT '',
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(team_id, work_date, unit)
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS work_columns (
          id SERIAL PRIMARY KEY,
          col_key TEXT UNIQUE NOT NULL,
          col_name TEXT NOT NULL,
          sort_order INT DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `;
      const defaults = [
        ['管道安装寸数', '管道安装寸数', 1],
        ['管道预制寸数', '管道预制寸数', 2],
        ['支架安装个数', '支架安装个数', 3],
        ['支架安装重量', '支架安装重量', 4],
        ['阀门安装台数', '阀门安装台数', 5]
      ];
      for (const [k, n, o] of defaults) {
        await sql`
          INSERT INTO work_columns (col_key, col_name, sort_order)
          VALUES (${k}, ${n}, ${o})
          ON CONFLICT (col_key) DO NOTHING
        `;
      }
      await sql`CREATE INDEX IF NOT EXISTS idx_work_records_date ON work_records(work_date)`;
      await sql`CREATE INDEX IF NOT EXISTS idx_work_records_team ON work_records(team_id)`;
      const tables = await sql`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `;
      const cols = await sql`
        SELECT id, col_key, col_name, sort_order
        FROM work_columns ORDER BY sort_order
      `;
      return res.status(200).json({
        success: true,
        message: '工作量表初始化完成',
        tables: tables.map(t => t.table_name),
        columns: cols
      });
    }

    if (action === 'latest-date-get') {
      const rows = await sql`
        SELECT MAX(work_date)::text AS latest_date FROM work_records
      `;
      const latest = (rows[0] && rows[0].latest_date) || '';
      return res.status(200).json({ success: true, date: latest });
    }

    if (action === 'latest-records-get') {
      const dateRows = await sql`
        SELECT MAX(work_date)::text AS latest_date FROM work_records
      `;
      let latest = (dateRows[0] && dateRows[0].latest_date) || '';
      if (!latest) {
        latest = new Date().toISOString().slice(0, 10);
        return res.status(200).json({
          success: true,
          date: latest,
          records: []
        });
      }
      const rows = await sql`
        SELECT id, team_id, work_date, unit, quantity, note
        FROM work_records
        WHERE work_date = ${latest}
        ORDER BY team_id ASC, unit ASC
      `;
      return res.status(200).json({
        success: true,
        date: latest,
        records: rows
      });
    }

    if (action === 'teams-get') {
      const rows = await sql`
        SELECT id, area, fitter, welder, helper, sort_order
        FROM work_teams
        ORDER BY sort_order ASC, id ASC
      `;
      return res.status(200).json({ success: true, data: rows });
    }

    if (action === 'teams-add') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { area, fitter, welder, helper, sort_order } = req.body || {};
      if (!area) return res.status(400).json({ error: 'area required' });
      const r = await sql`
        INSERT INTO work_teams (area, fitter, welder, helper, sort_order)
        VALUES (${area}, ${fitter || ''}, ${welder || ''}, ${helper || ''}, ${sort_order || 0})
        RETURNING id, area, fitter, welder, helper, sort_order
      `;
      return res.status(200).json({ success: true, data: r[0] });
    }

    if (action === 'teams-update') {
      if (req.method !== 'POST' && req.method !== 'PUT')
        return res.status(405).json({ error: 'Method not allowed' });
      const { id, area, fitter, welder, helper } = req.body || {};
      if (!id) return res.status(400).json({ error: 'id required' });
      const r = await sql`
        UPDATE work_teams
        SET area = ${area},
            fitter = ${fitter || ''},
            welder = ${welder || ''},
            helper = ${helper || ''}
        WHERE id = ${id}
        RETURNING id, area, fitter, welder, helper, sort_order
      `;
      if (r.length === 0) return res.status(404).json({ error: 'Team not found' });
      return res.status(200).json({ success: true, data: r[0] });
    }

    if (action === 'teams-delete') {
      if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      await sql`DELETE FROM work_teams WHERE id = ${id}`;
      return res.status(200).json({ success: true, message: '已删除班组及其所有工作量记录' });
    }

    if (action === 'records-get') {
      const { date, from, to, teamId } = req.query;
      let rows;
      if (date && teamId) {
        rows = await sql`
          SELECT id, team_id, work_date, unit, quantity, note
          FROM work_records
          WHERE work_date = ${date} AND team_id = ${teamId}
          ORDER BY team_id ASC, unit ASC
        `;
      } else if (date) {
        rows = await sql`
          SELECT id, team_id, work_date, unit, quantity, note
          FROM work_records
          WHERE work_date = ${date}
          ORDER BY team_id ASC, unit ASC
        `;
      } else if (from && to && teamId) {
        rows = await sql`
          SELECT id, team_id, work_date, unit, quantity, note
          FROM work_records
          WHERE work_date >= ${from} AND work_date <= ${to} AND team_id = ${teamId}
          ORDER BY work_date ASC, team_id ASC, unit ASC
        `;
      } else if (from && to) {
        rows = await sql`
          SELECT id, team_id, work_date, unit, quantity, note
          FROM work_records
          WHERE work_date >= ${from} AND work_date <= ${to}
          ORDER BY work_date ASC, team_id ASC, unit ASC
        `;
      } else {
        rows = await sql`
          SELECT id, team_id, work_date, unit, quantity, note
          FROM work_records
          ORDER BY work_date ASC, team_id ASC, unit ASC
        `;
      }
      return res.status(200).json({ success: true, data: rows });
    }

    if (action === 'records-range-summary') {
      const { from, to } = req.query;
      if (!from || !to) return res.status(400).json({ error: 'from, to required' });
      const teams = await sql`
        SELECT id, area, fitter, welder, helper
        FROM work_teams
        ORDER BY sort_order ASC, id ASC
      `;
      const columns = await sql`
        SELECT id, col_key, col_name, sort_order
        FROM work_columns
        ORDER BY sort_order ASC, id ASC
      `;
      const records = await sql`
        SELECT team_id, unit, SUM(quantity) AS quantity
        FROM work_records
        WHERE work_date >= ${from} AND work_date <= ${to}
        GROUP BY team_id, unit
        ORDER BY team_id ASC, unit ASC
      `;
      return res.status(200).json({
        success: true,
        data: { teams, columns, records }
      });
    }

    if (action === 'records-save') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { team_id, work_date, unit, quantity, note } = req.body || {};
      if (!team_id || !work_date || !unit) {
        return res.status(400).json({ error: 'team_id, work_date, unit required' });
      }
      const r = await sql`
        INSERT INTO work_records (team_id, work_date, unit, quantity, note)
        VALUES (${team_id}, ${work_date}, ${unit}, ${quantity || 0}, ${note || ''})
        ON CONFLICT (team_id, work_date, unit)
        DO UPDATE SET quantity = EXCLUDED.quantity,
                      note = EXCLUDED.note,
                      updated_at = NOW()
        RETURNING id, team_id, work_date, unit, quantity, note
      `;
      return res.status(200).json({ success: true, data: r[0] });
    }

    if (action === 'records-batch') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { records } = req.body || {};
      if (!Array.isArray(records) || records.length === 0) {
        return res.status(400).json({ error: 'records array required' });
      }
      let saved = 0;
      for (const r of records) {
        if (!r.team_id || !r.work_date || !r.unit) continue;
        await sql`
          INSERT INTO work_records (team_id, work_date, unit, quantity, note)
          VALUES (${r.team_id}, ${r.work_date}, ${r.unit}, ${r.quantity || 0}, ${r.note || ''})
          ON CONFLICT (team_id, work_date, unit)
          DO UPDATE SET quantity = EXCLUDED.quantity,
                        note = EXCLUDED.note,
                        updated_at = NOW()
        `;
        saved++;
      }
      return res.status(200).json({ success: true, saved });
    }

    if (action === 'records-delete') {
      if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
      const { id, date } = req.query;
      if (id) {
        await sql`DELETE FROM work_records WHERE id = ${id}`;
        return res.status(200).json({ success: true, message: '已删除该记录' });
      }
      if (date) {
        const r = await sql`DELETE FROM work_records WHERE work_date = ${date} RETURNING id`;
        return res.status(200).json({
          success: true,
          deleted: r.length,
          message: '已删除 ' + r.length + ' 条 ' + date + ' 的记录'
        });
      }
      return res.status(400).json({ error: 'id or date required' });
    }

    if (action === 'columns-get') {
      const rows = await sql`
        SELECT id, col_key, col_name, sort_order
        FROM work_columns
        ORDER BY sort_order ASC, id ASC
      `;
      return res.status(200).json({ success: true, data: rows });
    }

    if (action === 'columns-update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { id, col_name } = req.body || {};
      if (!id || !col_name) return res.status(400).json({ error: 'id, col_name required' });
      const old = await sql`SELECT col_key FROM work_columns WHERE id = ${id}`;
      if (old.length === 0) return res.status(404).json({ error: 'Column not found' });
      const oldKey = old[0].col_key;
      await sql`UPDATE work_columns SET col_name = ${col_name} WHERE id = ${id}`;
      if (oldKey !== col_name) {
        await sql`UPDATE work_records SET unit = ${col_name} WHERE unit = ${oldKey}`;
        await sql`UPDATE work_columns SET col_key = ${col_name} WHERE id = ${id}`;
      }
      return res.status(200).json({ success: true });
    }

    if (action === 'columns-add') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
      const { col_name } = req.body || {};
      if (!col_name) return res.status(400).json({ error: 'col_name required' });
      const maxOrder = await sql`SELECT COALESCE(MAX(sort_order), 0) AS m FROM work_columns`;
      const nextOrder = (maxOrder[0].m || 0) + 1;
      const r = await sql`
        INSERT INTO work_columns (col_key, col_name, sort_order)
        VALUES (${col_name}, ${col_name}, ${nextOrder})
        ON CONFLICT (col_key) DO NOTHING
        RETURNING id, col_key, col_name, sort_order
      `;
      if (r.length === 0) return res.status(400).json({ error: '列名已存在' });
      return res.status(200).json({ success: true, data: r[0] });
    }

    if (action === 'columns-delete') {
      if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });
      const old = await sql`SELECT col_key FROM work_columns WHERE id = ${id}`;
      if (old.length === 0) return res.status(404).json({ error: 'Column not found' });
      const oldKey = old[0].col_key;
      await sql`DELETE FROM work_columns WHERE id = ${id}`;
      await sql`DELETE FROM work_records WHERE unit = ${oldKey}`;
      return res.status(200).json({ success: true, message: '列及其数据已删除' });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ===================== kvHandler 备注、阀门业务 =====================
async function kvHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const { action } = req.query;
  const kv = getKvInstance();
  try {
    if (action === 'save-note') {
      if (req.method !== 'POST') return res.status(405).json({ success: false, message: '仅支持 POST' });
      const { bracketId, pipeNo, note, timestamp, user } = req.body || {};
      if (!bracketId || !pipeNo) return res.status(400).json({ success: false, message: '支架号和管线号不能为空' });
      if (!note || note.trim() === '') {
        const prefix = `备注_${bracketId}_${pipeNo}`;
        const keys = await kv.keys(`${prefix}*`);
        let deleted = 0;
        for (const k of keys) {
          await kv.del(k);
          deleted++;
        }
        return res.status(200).json({ success: true, message: '已删除 ' + deleted + ' 条备注', deleted });
      }
      const now = Date.now();
      const key = `备注_${bracketId}_${pipeNo}_${now}`;
      const data = { bracketId, pipeNo, note, user: user || '', time: timestamp || new Date().toLocaleString() };
      await kv.set(key, JSON.stringify(data));
      return res.status(200).json({ success: true, message: '备注已保存', key });
    }

    if (action === 'get-notes') {
      const bracketId = req.query.bracketId;
      const pattern = bracketId ? `备注_${bracketId}_*` : '备注_*';
      const keys = await kv.keys(pattern);
      if (keys.length === 0) return res.status(200).json({});
      const result = {};
      const BATCH = 100;
      for (let i = 0; i < keys.length; i += BATCH) {
        const batchKeys = keys.slice(i, i + BATCH);
        const values = await kv.mget(...batchKeys);
        batchKeys.forEach((key, idx) => {
          let item = values[idx];
          if (item === null || item === undefined) return;
          try { item = JSON.parse(item); } catch (e) { return; }
          if (!item) return;
          const realKey = item.bracketId + '_' + item.pipeNo;
          if (!result[realKey]) result[realKey] = { bracketId: item.bracketId, pipeNo: item.pipeNo, notes: [] };
          if (item.note !== undefined) {
            result[realKey].notes.push({ note: item.note, time: item.time || '', user: item.user || '' });
          }
        });
      }
      return res.status(200).json(result);
    }

    if (action === 'delete-note') {
      let key = req.query.key;
      const bracketId = req.query.bracketId;
      const pipeNo = req.query.pipeNo;
      if (key) {
        if (!key.startsWith('备注_')) key = '备注_' + key;
        await kv.del(key);
        return res.status(200).json({ success: true, message: '已删除', key });
      }
      if (!bracketId || !pipeNo) return res.status(400).json({ success: false, message: 'key 或 bracketId+pipeNo 至少一个' });
      const prefix = `备注_${bracketId}_${pipeNo}`;
      const keys = await kv.keys(`${prefix}*`);
      let deleted = 0;
      for (const k of keys) {
        await kv.del(k);
        deleted++;
      }
      return res.status(200).json({ success: true, message: '已删除 ' + deleted + ' 条备注', deleted });
    }

    if (action === 'save-valve') {
      if (req.method !== 'POST') return res.status(405).json({ success: false, message: '仅支持 POST' });
      const { valveTag, weldNo1, weldNo2, serialNo, timestamp, user } = req.body || {};
      if (!valveTag) return res.status(400).json({ success: false, message: '阀门位号不能为空' });
      const key = `阀门_${valveTag}`;
      const data = { valveTag, weldNo1: weldNo1 || '', weldNo2: weldNo2 || '', serialNo: serialNo || '', user: user || '', updateTime: timestamp || new Date().toLocaleString() };
      await kv.set(key, JSON.stringify(data));
      return res.status(200).json({ success: true, message: '阀门数据已保存', key });
    }

    if (action === 'get-valves') {
      const keys = await kv.keys('阀门_*');
      if (keys.length === 0) return res.status(200).json({ success: true, total: 0, data: [] });
      const results = [];
      for (const key of keys) {
        const raw = await kv.get(key);
        if (!raw) continue;
        try {
          const item = JSON.parse(raw);
          if (item && item.valveTag) {
            results.push({
              key,
              valveTag: item.valveTag,
              weldNo1: item.weldNo1 || '',
              weldNo2: item.weldNo2 || '',
              serialNo: item.serialNo || '',
              user: item.user || '',
              updateTime: item.updateTime || ''
            });
          }
        } catch (e) { /* skip */ }
      }
      return res.status(200).json({ success: true, total: results.length, data: results });
    }

    if (action === 'delete-valve') {
      if (req.query.all === '1') {
        const keys = await kv.keys('阀门_*');
        let deleted = 0;
        for (const k of keys) { await kv.del(k); deleted++; }
        return res.status(200).json({ success: true, message: '已清空 ' + deleted + ' 条阀门录入', deleted });
      }
      let key = req.query.key;
      if (!key) return res.status(400).json({ success: false, message: 'key 不能为空' });
      if (!key.startsWith('阀门_')) key = `阀门_${key}`;
      await kv.del(key);
      return res.status(200).json({ success: true, message: '已删除', key });
    }

    if (action === 'flush-db') {
      if (req.method !== 'POST') return res.status(405).json({ success: false, message: '仅支持 POST' });
      const confirm = req.body.confirm;
      if (confirm !== 'FLUSH') return res.status(400).json({ success: false, message: '缺少确认参数 confirm=FLUSH' });
      await kv.flushdb();
      return res.status(200).json({ success: true, message: '已清空整个 Redis 库' });
    }

    return res.status(400).json({ success: false, message: '未知 action: ' + action });
  } catch (error) {
    return res.status(500).json({ success: false, message: '服务器错误: ' + error.message });
  }
}

// ===================== EdgeOne 入口 handler =====================
export async function handler(event) {
  const { request } = event;
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: {
        "Access‑Control‑Allow‑Origin": "*",
        "Access‑Control‑Allow‑Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access‑Control‑Allow‑Headers": "Content‑Type"
      }
    });
  }

  let body = {};
  if(["POST","PUT","DELETE"].includes(request.method)){
    try{ body = await request.json(); }catch(e){ body = {}; }
  }

  const req = {
    method: request.method,
    query: Object.fromEntries(url.searchParams.entries()),
    body: body,
    headers: Object.fromEntries(request.headers.entries())
  };

  let _responseData = null;
  let _responseStatus = 200;
  let _responseHeaders = {};
  const res = {
    setHeader(k,v){ _responseHeaders[k]=v; },
    status(code){ _responseStatus = code; return res; },
    json(data){ _responseData = data; return res; },
    end(){ return res; }
  };

  if(path === "/api/tails"){
    await tailsHandler(req, res);
  }else if(path === "/api/work"){
    await workHandler(req, res);
  }else if(path === "/api/kv"){
    await kvHandler(req, res);
  }else{
    return new Response(JSON.stringify({error:"API Not Found"}),{
      status:404,
      headers:{"Content‑Type":"application/json","Access‑Control‑Allow‑Origin":"*"}
    })
  }

  return new Response(_responseData!==null ? JSON.stringify(_responseData) : "", {
    status: _responseStatus,
    headers:{
      "Content‑Type":"application/json; charset=utf‑8",
      "Access‑Control‑Allow‑Origin":"*",
      ..._responseHeaders
    }
  })
}