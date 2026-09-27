// ============================================================
//              Vercel Serverless Function - 备注管理接口
//              支持分页查询（稳健版）
// ============================================================

const https = require('https');
const { URL } = require('url');

const ADMIN_PASSWORD = 'huyadong';

function httpsGet(url, headers) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            port: 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: headers
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.end();
    });
}

function httpsPost(url, headers, body) {
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(url);
        const options = {
            hostname: parsedUrl.hostname,
            port: 443,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'POST',
            headers: headers
        };
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

// 安全解析 JSON
function safeJsonParse(str) {
    try {
        return JSON.parse(str);
    } catch(e) {
        return null;
    }
}

module.exports = async function handler(req, res) {
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

            // ✅ 关键修复：统一在分支最外层声明 result，防止作用域或未定义问题
            let result = [];

            // ============ 分页模式 ============
            if (page > 0) {
                console.log('📄 分页模式: page=' + page + ', pageSize=' + pageSize);

                // 用 SCAN 分批获取所有 Key
                let allKeys = [];
                let cursor = '0';
                let hasMore = true;
                let maxIterations = 30;

                for (let iter = 0; iter < maxIterations && hasMore; iter++) {
                    const scanUrl = `${UPSTASH_URL}/scan/${cursor}?match=${encodeURIComponent('备注_*')}&count=1000`;
                    const scanRes = await httpsGet(scanUrl, authHeaders);

                    console.log('SCAN 响应状态:', scanRes.status);
                    console.log('SCAN 响应内容:', scanRes.body.substring(0, 500));

                    const scanData = safeJsonParse(scanRes.body);
                    if (!scanData) {
                        console.error('SCAN 解析失败');
                        break;
                    }

                    // 尝试多种返回格式
                    let currentCursor = '0';
                    let currentKeys = [];

                    if (scanData.result) {
                        // 格式1: [cursor, [keys...]]
                        if (Array.isArray(scanData.result) && scanData.result.length >= 2) {
                            currentCursor = String(scanData.result[0]);
                            if (Array.isArray(scanData.result[1])) {
                                currentKeys = scanData.result[1];
                            }
                        }
                        // 格式2: {cursor, keys}
                        else if (typeof scanData.result === 'object' && !Array.isArray(scanData.result)) {
                            currentCursor = String(scanData.result.cursor || '0');
                            if (Array.isArray(scanData.result.keys)) {
                                currentKeys = scanData.result.keys;
                            }
                        }
                        // 格式3: 直接是数组（注意与格式1区分）
                        else if (Array.isArray(scanData.result)) {
                            currentKeys = scanData.result;
                        }
                    }

                    console.log('本次扫描到 ' + currentKeys.length + ' 个 Key，下一个 cursor: ' + currentCursor);

                    if (currentKeys.length > 0) {
                        allKeys = allKeys.concat(currentKeys);
                    }

                    cursor = currentCursor;
                    hasMore = cursor !== '0' && cursor !== 0;

                    // 如果已有足够的数据，可以提前结束
                    if (allKeys.length >= page * pageSize + pageSize) break;
                }

                console.log('📄 找到 Key 总数: ' + allKeys.length);

                // 分页
                const start = (page - 1) * pageSize;
                const end = start + pageSize;
                const pageKeys = allKeys.slice(start, end);

                // ✅ 使用 Promise.all 并发获取数据，提升性能并防止单个失败影响整体
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
                    } catch(e) {
                        console.error('读取 Key 失败:', key, e.message);
                    }
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
            console.log('📄 全量模式');
            const keysRes = await httpsGet(`${UPSTASH_URL}/keys/备注_*`, authHeaders);
            const keysData = safeJsonParse(keysRes.body);

            if (keysData && keysData.result && Array.isArray(keysData.result)) {
                // ✅ 并发获取，避免串行超时
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
                    } catch(e) {
                        console.error('读取 Key 失败:', key, e.message);
                    }
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
        console.error('错误堆栈:', error.stack);
        return res.status(500).json({
            success: false,
            message: '服务器错误: ' + error.message,
            stack: error.stack
        });
    }
};
