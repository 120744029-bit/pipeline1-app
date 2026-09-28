import https from 'https';
import { URL } from 'url';

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

export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);

    let body = {};
    const req = {
        method: request.method,
        query: Object.fromEntries(url.searchParams.entries()),
        body: body,
        headers: Object.fromEntries(request.headers.entries())
    };

    let _data = null, _status = 200;
    const res = {
        setHeader: () => {},
        status: (code) => { _status = code; return res; },
        json: (d) => { _data = d; return res; },
        end: () => res
    };

    await originalHandler(req, res);

    return new Response(_data !== null ? JSON.stringify(_data) : '', {
        status: _status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
    });
}

async function originalHandler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();

    try {
        const UPSTASH_URL = process.env.KV_REST_API_URL;
        const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

        if (!UPSTASH_URL || !UPSTASH_TOKEN) {
            return res.status(500).json({ success: false, message: '环境变量未设置' });
        }

        const authHeaders = { 'Authorization': `Bearer ${UPSTASH_TOKEN}` };

        const keysRes = await httpsGet(
            `${UPSTASH_URL}/keys/${encodeURIComponent('阀门_*')}`,
            authHeaders
        );
        const keysData = JSON.parse(keysRes.body);
        const allKeys = (keysData.result && Array.isArray(keysData.result)) ? keysData.result : [];

        if (allKeys.length === 0) {
            return res.status(200).json({ success: true, total: 0, data: [] });
        }

        const fetchPromises = allKeys.map(async (key) => {
            try {
                const valRes = await httpsGet(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, authHeaders);
                const valData = JSON.parse(valRes.body);

                if (valData && valData.result) {
                    let item = valData.result;
                    if (typeof item === 'string') item = JSON.parse(item);
                    if (typeof item === 'string') item = JSON.parse(item);

                    if (item && item.valveTag) {
                        return {
                            key: key,
                            valveTag: item.valveTag,
                            weldNo1: item.weldNo1 || '',
                            weldNo2: item.weldNo2 || '',
                            serialNo: item.serialNo || '',
                            user: item.user || '',
                            updateTime: item.updateTime || ''
                        };
                    }
                }
            } catch(e) {}
            return null;
        });

        const results = await Promise.all(fetchPromises);
        const validResults = results.filter(item => item !== null);

        return res.status(200).json({
            success: true,
            total: validResults.length,
            data: validResults
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            message: '服务器错误: ' + error.message
        });
    }
}
