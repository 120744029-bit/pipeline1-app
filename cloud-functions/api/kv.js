// ============================================================
//        cloud-functions/api/kv.js —— Upstash Redis 统一入口
//        整合：备注 + 阀门 + 清库
//        用法：/api/kv?action=save-note | get-notes | ...
// ============================================================
import https from 'https';
import { URL } from 'url';

// ---------- 通用请求封装 ----------
function httpsReq(method, url, headers, body) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            port: 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: method,
            headers: headers
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}
const httpsGet = (url, headers) => httpsReq('GET', url, headers);
const httpsPost = (url, headers, body) => httpsReq('POST', url, headers, body);

// ---------- 环境变量 ----------
function getKvEnv() {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) throw new Error('环境变量未设置');
    return { url, token };
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
                'Access-Control-Allow-Headers': 'Content-Type'
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

    const { action } = req.query;

    try {
        const { url: UPSTASH_URL, token: UPSTASH_TOKEN } = getKvEnv();
        const authHeaders = { 'Authorization': `Bearer ${UPSTASH_TOKEN}` };

        // ============================================================
        // 备注相关
        // ============================================================
        if (action === 'save-note') {
            if (req.method !== 'POST') return res.status(405).json({ success: false, message: '仅支持 POST' });
            const { bracketId, pipeNo, note, timestamp, user } = req.body || {};
            if (!bracketId || !pipeNo) return res.status(400).json({ success: false, message: '支架号和管线号不能为空' });

            // 空 note → 删除该支架+管线所有备注
            if (!note || note.trim() === '') {
                const prefix = `备注_${bracketId}_${pipeNo}`;
                const keysRes = await httpsGet(`${UPSTASH_URL}/keys/${encodeURIComponent(prefix + '*')}`, authHeaders);
                let matchKeys = [];
                try {
                    const keysData = JSON.parse(keysRes.body);
                    if (keysData && keysData.result && Array.isArray(keysData.result)) matchKeys = keysData.result;
                } catch (e) {}

                let deleted = 0;
                for (const k of matchKeys) {
                    try {
                        await httpsGet(`${UPSTASH_URL}/del/${encodeURIComponent(k)}`, authHeaders);
                        deleted++;
                    } catch (e) {}
                }
                return res.status(200).json({ success: true, message: '已删除 ' + deleted + ' 条备注', deleted });
            }

            // 正常保存
            const now = Date.now();
            const key = `备注_${bracketId}_${pipeNo}_${now}`;
            const data = { bracketId, pipeNo, note, user: user || '', time: timestamp || new Date().toLocaleString() };
            const saveRes = await httpsPost(
                `${UPSTASH_URL}/set/${encodeURIComponent(key)}`,
                { ...authHeaders, 'Content-Type': 'application/json' },
                JSON.stringify(JSON.stringify(data))
            );
            return res.status(200).json({ success: saveRes.status === 200, message: '备注已保存', key });
        }

        if (action === 'get-notes') {
            const { bracketId } = req.query;
            const pattern = bracketId ? `备注_${bracketId}_*` : '备注_*';
            const keysRes = await httpsGet(`${UPSTASH_URL}/keys/${encodeURIComponent(pattern)}`, authHeaders);
            const keysData = JSON.parse(keysRes.body);
            const allKeys = (keysData.result && Array.isArray(keysData.result)) ? keysData.result : [];
            if (allKeys.length === 0) return res.status(200).json({});

            const result = {};
            const BATCH = 100;
            for (let i = 0; i < allKeys.length; i += BATCH) {
                const batchKeys = allKeys.slice(i, i + BATCH);
                const mgetUrl = `${UPSTASH_URL}/mget/${batchKeys.map(k => encodeURIComponent(k)).join('/')}`;
                const mgetRes = await httpsGet(mgetUrl, authHeaders);
                const mgetData = JSON.parse(mgetRes.body);
                const values = (mgetData.result && Array.isArray(mgetData.result)) ? mgetData.result : [];

                batchKeys.forEach((key, idx) => {
                    let item = values[idx];
                    if (item === null || item === undefined) return;
                    try {
                        if (typeof item === 'string') item = JSON.parse(item);
                        if (typeof item === 'string') item = JSON.parse(item);
                    } catch (e) { return; }
                    if (!item) return;
                    const realKey = item.bracketId + '_' + item.pipeNo;
                    if (!result[realKey]) result[realKey] = { bracketId: item.bracketId, pipeNo: item.pipeNo, notes: [] };

                    if (item.note !== undefined) {
                        result[realKey].notes.push({ note: item.note, time: item.time || '', user: item.user || '' });
                    } else if (item.notes && Array.isArray(item.notes)) {
                        result[realKey].notes = result[realKey].notes.concat(
                            item.notes.map(n => ({ note: n.note, time: n.time || '', user: n.user || '' }))
                        );
                    }
                });
            }
            return res.status(200).json(result);
        }

        if (action === 'delete-note') {
            let { key, bracketId, pipeNo } = req.query;
            if (key) {
                if (!key.startsWith('备注_')) key = '备注_' + key;
                await httpsGet(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, authHeaders);
                return res.status(200).json({ success: true, message: '已删除', key });
            }
            if (!bracketId || !pipeNo) return res.status(400).json({ success: false, message: 'key 或 bracketId+pipeNo 至少一个' });

            const prefix = `备注_${bracketId}_${pipeNo}`;
            const keysRes = await httpsGet(`${UPSTASH_URL}/keys/${encodeURIComponent(prefix + '*')}`, authHeaders);
            const keysData = JSON.parse(keysRes.body);
            const allKeys = (keysData && Array.isArray(keysData.result)) ? keysData.result : [];
            if (allKeys.indexOf(prefix) === -1) allKeys.push(prefix);

            let deleted = 0;
            for (const k of allKeys) {
                try { await httpsGet(`${UPSTASH_URL}/del/${encodeURIComponent(k)}`, authHeaders); deleted++; } catch (e) {}
            }
            return res.status(200).json({ success: true, message: '已删除 ' + deleted + ' 条备注', deleted });
        }

        // ============================================================
        // 阀门相关
        // ============================================================
        if (action === 'save-valve') {
            if (req.method !== 'POST') return res.status(405).json({ success: false, message: '仅支持 POST' });
            const { valveTag, weldNo1, weldNo2, serialNo, timestamp, user } = req.body || {};
            if (!valveTag) return res.status(400).json({ success: false, message: '阀门位号不能为空' });

            const key = `阀门_${valveTag}`;
            const data = { valveTag, weldNo1: weldNo1 || '', weldNo2: weldNo2 || '', serialNo: serialNo || '', user: user || '', updateTime: timestamp || new Date().toLocaleString() };
            const saveRes = await httpsPost(
                `${UPSTASH_URL}/set/${encodeURIComponent(key)}`,
                { ...authHeaders, 'Content-Type': 'application/json' },
                JSON.stringify(JSON.stringify(data))
            );
            return res.status(200).json({ success: saveRes.status === 200, message: '阀门数据已保存', key });
        }

        if (action === 'get-valves') {
            const keysRes = await httpsGet(`${UPSTASH_URL}/keys/${encodeURIComponent('阀门_*')}`, authHeaders);
            const keysData = JSON.parse(keysRes.body);
            const allKeys = (keysData.result && Array.isArray(keysData.result)) ? keysData.result : [];
            if (allKeys.length === 0) return res.status(200).json({ success: true, total: 0, data: [] });

            const results = await Promise.all(allKeys.map(async (key) => {
                try {
                    const valRes = await httpsGet(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, authHeaders);
                    const valData = JSON.parse(valRes.body);
                    if (valData && valData.result) {
                        let item = valData.result;
                        if (typeof item === 'string') item = JSON.parse(item);
                        if (typeof item === 'string') item = JSON.parse(item);
                        if (item && item.valveTag) {
                            return { key, valveTag: item.valveTag, weldNo1: item.weldNo1 || '', weldNo2: item.weldNo2 || '', serialNo: item.serialNo || '', user: item.user || '', updateTime: item.updateTime || '' };
                        }
                    }
                } catch (e) {}
                return null;
            }));
            const valid = results.filter(x => x !== null);
            return res.status(200).json({ success: true, total: valid.length, data: valid });
        }

        if (action === 'delete-valve') {
            if (req.query.all === '1') {
                const keysRes = await httpsGet(`${UPSTASH_URL}/keys/${encodeURIComponent('阀门_*')}`, authHeaders);
                const keysData = JSON.parse(keysRes.body);
                const allKeys = (keysData.result && Array.isArray(keysData.result)) ? keysData.result : [];
                let deleted = 0;
                for (const k of allKeys) {
                    try { await httpsGet(`${UPSTASH_URL}/del/${encodeURIComponent(k)}`, authHeaders); deleted++; } catch (e) {}
                }
                return res.status(200).json({ success: true, message: '已清空 ' + deleted + ' 条阀门录入', deleted });
            }
            let { key } = req.query;
            if (!key) return res.status(400).json({ success: false, message: 'key 不能为空' });
            if (!key.startsWith('阀门_')) key = `阀门_${key}`;
            await httpsGet(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, authHeaders);
            return res.status(200).json({ success: true, message: '已删除', key });
        }

        // ============================================================
        // 清空整库
        // ============================================================
        if (action === 'flush-db') {
            if (req.method !== 'POST') return res.status(405).json({ success: false, message: '仅支持 POST' });
            const { confirm } = req.body || {};
            if (confirm !== 'FLUSH') return res.status(400).json({ success: false, message: '缺少确认参数 confirm=FLUSH' });

            const flushRes = await httpsPost(`${UPSTASH_URL}/flushdb`, { ...authHeaders, 'Content-Type': 'application/json' }, '');
            let ok = false;
            try {
                const data = JSON.parse(flushRes.body);
                ok = data && data.result === 'OK';
            } catch (e) { ok = flushRes.status === 200; }
            return res.status(200).json({ success: ok, message: ok ? '已清空整个 Redis 库' : '清空失败', status: flushRes.status });
        }

        return res.status(400).json({ success: false, message: '未知 action: ' + action });

    } catch (error) {
        console.error('KV 操作失败:', error);
        return res.status(500).json({ success: false, message: '服务器错误: ' + error.message });
    }
}
