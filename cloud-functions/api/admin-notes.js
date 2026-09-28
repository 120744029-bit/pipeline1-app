// ============================================================
//        cloud-functions/api/admin-notes.js —— 备注管理接口
//        支持分页查询
// ============================================================
import https from 'https';
import { URL } from 'url';

const ADMIN_PASSWORD = 'huyadong';

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

// 安全解析 JSON
function safeJsonParse(str) {
    try {
        return JSON.parse(str);
    } catch(e) {
        return null;
    }
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
                'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password'
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const password = req.headers['x-admin-password'] || req.query.password;
    if (password !== ADMIN_PASSWORD) {
        return res.status(401).json({ success: false, message: '密码错误' });
    }

    const UPSTASH_URL = process.env.KV_REST_API_URL;
    const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
        return res.status(500).json({ success: false, message: '环境变量未设置' });
    }

    const authHeaders = { 'Authorization': `Bearer ${UPSTASH_TOKEN}` };

    try {
        // ============================================================
        // GET：获取备注
        // ============================================================
        if (req.method === 'GET') {
            const page = parseInt(req.query.page) || 0;
            const pageSize = parseInt(req.query.pageSize) || 100;

            let result = [];

            // ============ 分页模式 ============
            if (page > 0) {
                let allKeys = [];
                let cursor = '0';
                let hasMore = true;
                let maxIterations = 30;

                for (let iter = 0; iter < maxIterations && hasMore; iter++) {
                    const scanUrl = `${UPSTASH_URL}/scan/${cursor}?match=${encodeURIComponent('备注_*')}&count=1000`;
                    const scanRes = await httpsGet(scanUrl, authHeaders);

                    const scanData = safeJsonParse(scanRes.body);
                    if (!scanData) {
                        break;
                    }

                    let currentCursor = '0';
                    let currentKeys = [];

                    if (scanData.result) {
                        if (Array.isArray(scanData.result) && scanData.result.length >= 2) {
                            currentCursor = String(scanData.result[0]);
                            if (Array.isArray(scanData.result[1])) {
                                currentKeys = scanData.result[1];
                            }
                        } else if (typeof scanData.result === 'object' && !Array.isArray(scanData.result)) {
                            currentCursor = String(scanData.result.cursor || '0');
                            if (Array.isArray(scanData.result.keys)) {
                                currentKeys = scanData.result.keys;
                            }
                        } else if (Array.isArray(scanData.result)) {
                            currentKeys = scanData.result;
                        }
                    }

                    if (currentKeys.length > 0) {
                        allKeys = allKeys.concat(currentKeys);
                    }

                    cursor = currentCursor;
                    hasMore = cursor !== '0' && cursor !== 0;

                    if (allKeys.length >= page * pageSize + pageSize) break;
                }

                const start = (page - 1) * pageSize;
                const end = start + pageSize;
                const pageKeys = allKeys.slice(start, end);

                const fetchPromises = pageKeys.map(async (key) => {
                    try {
                        const valRes = await httpsGet(`${UPSTASH_URL}/get/${key}`, authHeaders);
                        const valData = safeJsonParse(valRes.body);

                        if (valData && valData.result) {
                            let item = valData.result;
                            if (typeof item === 'string') item = safeJsonParse(item);
                            if (typeof item === 'string') item = safeJsonParse(item);

                            if (item && item.notes && Array.isArray(item.notes) && item.notes.length > 0) {
                                const latest = item.notes[item.notes.length - 1];
                                return {
                                    key: key,
                                    bracketId: item.bracketId || '',
                                    pipeNo: item.pipeNo || '',
                                    note: latest.note || '',
                                    time: latest.time || '',
                                    noteCount: item.notes.length
                                };
                            }
                        }
                    } catch(e) {}
                    return null;
                });

                const results = await Promise.all(fetchPromises);
                result = results.filter(item => item !== null);

                return res.status(200).json({
                    success: true,
                    page: page,
                    pageSize: pageSize,
                    total: allKeys.length,
                    totalPages: Math.ceil(allKeys.length / pageSize),
                    hasMore: end < allKeys.length,
                    data: result
                });
            }

            // ============ 全量模式 ============
            const keysRes = await httpsGet(`${UPSTASH_URL}/keys/备注_*`, authHeaders);
            const keysData = safeJsonParse(keysRes.body);

            if (keysData && keysData.result && Array.isArray(keysData.result)) {
                const fetchPromises = keysData.result.map(async (key) => {
                    try {
                        const valRes = await httpsGet(`${UPSTASH_URL}/get/${key}`, authHeaders);
                        const valData = safeJsonParse(valRes.body);

                        if (valData && valData.result) {
                            let item = valData.result;
                            if (typeof item === 'string') item = safeJsonParse(item);
                            if (typeof item === 'string') item = safeJsonParse(item);

                            if (item && item.notes && Array.isArray(item.notes) && item.notes.length > 0) {
                                const latest = item.notes[item.notes.length - 1];
                                return {
                                    key: key,
                                    bracketId: item.bracketId || '',
                                    pipeNo: item.pipeNo || '',
                                    note: latest.note || '',
                                    time: latest.time || '',
                                    noteCount: item.notes.length
                                };
                            }
                        }
                    } catch(e) {}
                    return null;
                });

                const results = await Promise.all(fetchPromises);
                result = results.filter(item => item !== null);
            }

            return res.status(200).json({
                success: true,
                total: result.length,
                data: result
            });
        }

        // ============================================================
        // POST：添加备注
        // ============================================================
        if (req.method === 'POST') {
            const { bracketId, pipeNo, note, time } = req.body;

            if (!bracketId || !pipeNo) {
                return res.status(400).json({ success: false, message: '支架号和管线号不能为空' });
            }

            const key = `备注_${bracketId}_${pipeNo}`;

            const readRes = await httpsGet(`${UPSTASH_URL}/get/${key}`, authHeaders);
            const readData = safeJsonParse(readRes.body);

            let existing = { bracketId: bracketId, pipeNo: pipeNo, notes: [] };
            if (readData && readData.result) {
                let parsed = readData.result;
                if (typeof parsed === 'string') parsed = safeJsonParse(parsed);
                if (typeof parsed === 'string') parsed = safeJsonParse(parsed);
                if (parsed && typeof parsed === 'object') {
                    existing = parsed;
                    if (!Array.isArray(existing.notes)) existing.notes = [];
                }
            }

            existing.notes.push({
                note: note || '',
                time: time || new Date().toLocaleString()
            });

            const saveRes = await httpsPost(
                `${UPSTASH_URL}/set/${key}`,
                {
                    'Authorization': `Bearer ${UPSTASH_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                JSON.stringify(JSON.stringify(existing))
            );

            return res.status(200).json({
                success: saveRes.status === 200,
                message: '备注已保存'
            });
        }

        // ============================================================
        // DELETE：删除备注
        // ============================================================
        if (req.method === 'DELETE') {
            let { key } = req.query;

            if (!key) {
                return res.status(400).json({ success: false, message: 'key 不能为空' });
            }

            if (!key.startsWith('备注_')) {
                key = `备注_${key}`;
            }

            await httpsGet(`${UPSTASH_URL}/del/${key}`, authHeaders);

            return res.status(200).json({
                success: true,
                message: '已删除'
            });
        }

        return res.status(405).json({ success: false, message: '不支持的方法' });

    } catch (error) {
        console.error('❌ 管理操作失败:', error);
        return res.status(500).json({
            success: false,
            message: '服务器错误: ' + error.message
        });
    }
}
