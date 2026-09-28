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

const MGET_BATCH_SIZE = 100;

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
        const { bracketId } = req.query;

        const UPSTASH_URL = process.env.KV_REST_API_URL;
        const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

        if (!UPSTASH_URL || !UPSTASH_TOKEN) {
            return res.status(500).json({ error: '环境变量未设置' });
        }

        const authHeaders = { 'Authorization': `Bearer ${UPSTASH_TOKEN}` };

        let pattern;
        if (bracketId) {
            pattern = `备注_${bracketId}_*`;
        } else {
            pattern = '备注_*';
        }

        const keysRes = await httpsGet(
            `${UPSTASH_URL}/keys/${encodeURIComponent(pattern)}`,
            authHeaders
        );
        const keysData = JSON.parse(keysRes.body);

        const allKeys = (keysData.result && Array.isArray(keysData.result)) ? keysData.result : [];

        if (allKeys.length === 0) {
            return res.status(200).json({});
        }

        const result = {};

        for (let i = 0; i < allKeys.length; i += MGET_BATCH_SIZE) {
            const batchKeys = allKeys.slice(i, i + MGET_BATCH_SIZE);

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
                } catch(e) {
                    return;
                }

                if (!item) return;

                const realKey = item.bracketId + '_' + item.pipeNo;

                if (!result[realKey]) {
                    result[realKey] = {
                        bracketId: item.bracketId,
                        pipeNo: item.pipeNo,
                        notes: []
                    };
                }

                if (item.note !== undefined) {
                    result[realKey].notes.push({
                        note: item.note,
                        time: item.time || '',
                        user: item.user || ''
                    });
                }
                else if (item.notes && Array.isArray(item.notes)) {
                    const oldNotes = item.notes.map(n => ({
                        note: n.note,
                        time: n.time || '',
                        user: n.user || ''
                    }));
                    result[realKey].notes = result[realKey].notes.concat(oldNotes);
                }
            });
        }

        return res.status(200).json(result);

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}
