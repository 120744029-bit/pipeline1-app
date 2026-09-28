import { neon } from '@neondatabase/serverless';

function jsonResponse(data, status) {
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        }
    });
}

export async function onRequest(context) {
    const { request } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            status: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            }
        });
    }

    // ---- 构造一个假的 req/res，兼容原 Vercel 写法 ----
    const url = new URL(request.url);
    let body = {};
    if (request.method === 'POST' || request.method === 'PUT' || request.method === 'DELETE') {
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
    let _responseHeaders = {};

    const res = {
        setHeader: (k, v) => { _responseHeaders[k] = v; },
        status: (code) => { _responseStatus = code; return res; },
        json: (data) => { _responseData = data; return res; },
        end: () => { return res; }
    };

    // ---- 原样调用业务逻辑 ----
    await originalHandler(req, res);

    return new Response(_responseData !== null ? JSON.stringify(_responseData) : '', {
        status: _responseStatus,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            ..._responseHeaders
        }
    });
}
// ============================================================
//              Vercel Serverless Function - 工作量统计（Neon 合并版）
//              ?action= 区分：
//                teams-get / teams-add / teams-update / teams-delete
//                records-get / records-save / records-batch / records-delete
//                columns-get / columns-update / columns-add / columns-delete
//                latest-date-get        ← 查最新有数据的日期
//                latest-records-get     ← 一次返回「最新日期 + 那天所有 records」
//                records-range-summary  ← 日期范围汇总（按班组+列）
//                init                   ← 一次性建表 + 写入默认列
// ============================================================

async function originalHandler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    const sql = neon(process.env.DATABASE_URL);

    // ============================================================
    // 0. 一次性建表 + 写入默认列
    //    GET /api/work?action=init
    // ============================================================
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

    // ============================================================
    // 0.5 最新有数据的日期
    //     GET /api/work?action=latest-date-get
    //     返回：{ success: true, date: "2026-09-15" }
    //     无数据时 date 为空字符串 ""
    // ============================================================
    if (action === 'latest-date-get') {
      const rows = await sql`
        SELECT MAX(work_date)::text AS latest_date FROM work_records
      `;
      const latest = (rows[0] && rows[0].latest_date) || '';
      return res.status(200).json({ success: true, date: latest });
    }

    // ============================================================
    // 0.6 最新日期 + 那天的所有记录（一次返回）
    //     GET /api/work?action=latest-records-get
    //     返回：{ success: true, date: "2026-09-15", records: [...] }
    //     无数据时 date 为今天，records 为空数组
    // ============================================================
    if (action === 'latest-records-get') {
      const dateRows = await sql`
        SELECT MAX(work_date)::text AS latest_date FROM work_records
      `;
      let latest = (dateRows[0] && dateRows[0].latest_date) || '';

      // 无数据：用今天
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

    // ============================================================
    // 1. 班组 - 查询
    // ============================================================
    if (action === 'teams-get') {
      const rows = await sql`
        SELECT id, area, fitter, welder, helper, sort_order
        FROM work_teams
        ORDER BY sort_order ASC, id ASC
      `;
      return res.status(200).json({ success: true, data: rows });
    }

    // ============================================================
    // 2. 班组 - 新增
    // ============================================================
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

    // ============================================================
    // 3. 班组 - 修改
    // ============================================================
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

    // ============================================================
    // 4. 班组 - 删除
    // ============================================================
    if (action === 'teams-delete') {
      if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' });
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id required' });

      await sql`DELETE FROM work_teams WHERE id = ${id}`;
      return res.status(200).json({ success: true, message: '已删除班组及其所有工作量记录' });
    }

    // ============================================================
    // 5. 工作量记录 - 查询
    // ============================================================
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

    // ============================================================
    // 5.5 工作量记录 - 日期范围汇总（按班组+列）
    //     GET /api/work?action=records-range-summary&from=xxx&to=xxx
    // ============================================================
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

    // ============================================================
    // 6. 工作量记录 - 保存单条（upsert）
    // ============================================================
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

    // ============================================================
    // 7. 工作量记录 - 批量保存
    // ============================================================
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

    // ============================================================
    // 8. 工作量记录 - 删除
    // ============================================================
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

    // ============================================================
    // 9. 列配置 - 查询
    // ============================================================
    if (action === 'columns-get') {
      const rows = await sql`
        SELECT id, col_key, col_name, sort_order
        FROM work_columns
        ORDER BY sort_order ASC, id ASC
      `;
      return res.status(200).json({ success: true, data: rows });
    }

    // ============================================================
    // 10. 列配置 - 修改名称
    // ============================================================
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

    // ============================================================
    // 11. 列配置 - 新增列
    // ============================================================
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

    // ============================================================
    // 12. 列配置 - 删除列
    // ============================================================
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
