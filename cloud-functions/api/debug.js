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
    const UPSTASH_URL = process.env.KV_REST_API_URL;
    const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;
    const authHeaders = { 'Authorization': `Bearer ${UPSTASH_TOKEN}` };

    try {
        // 1. 列出所有 备注_ 开头的 key
        const keysRes = await httpsGet(
            `${UPSTASH_URL}/keys/${encodeURIComponent('备注_*')}`,
            authHeaders
        );
        const keysData = JSON.parse(keysRes.body);
        const allKeys = (keysData.result && Array.isArray(keysData.result)) ? keysData.result : [];

        // 2. 取前 5 个 key，分别查它们的 value
        const sampleKeys = allKeys.slice(0, 5);
        const details = [];
        for (const key of sampleKeys) {
            try {
                const valRes = await httpsGet(
                    `${UPSTASH_URL}/get/${encodeURIComponent(key)}`,
                    authHeaders
                );
                const valData = JSON.parse(valRes.body);
                details.push({
                    key: key,
                    rawValue: valData.result
                });
            } catch (e) {
                details.push({ key: key, error: e.message });
            }
        }

        return new Response(JSON.stringify({
            totalKeys: allKeys.length,
            allKeysPreview: allKeys.slice(0, 10),
            sampleDetails: details
        }, null, 2), {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }
}
