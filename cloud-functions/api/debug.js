import https from 'https';
import { URL } from 'url';

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

export async function onRequest(context) {
    const UPSTASH_URL = process.env.KV_REST_API_URL;
    const UPSTASH_TOKEN = process.env.KV_REST_API_TOKEN;

    const result = {
        envUrl: UPSTASH_URL || '(未设置)',
        envTokenPrefix: UPSTASH_TOKEN ? UPSTASH_TOKEN.substring(0, 20) + '...' : '(未设置)',
        tests: {}
    };

    try {
        const authHeaders = { 'Authorization': `Bearer ${UPSTASH_TOKEN}` };

        // 测试 1：PING
        const pingRes = await httpsReq('GET', `${UPSTASH_URL}/ping`, authHeaders);
        result.tests.ping = {
            status: pingRes.status,
            body: pingRes.body
        };

        // 测试 2：SET 一个测试 key
        const testKey = '调试测试_' + Date.now();
        const testData = { hello: 'world', time: new Date().toISOString() };
        const setRes = await httpsReq(
            'POST',
            `${UPSTASH_URL}/set/${encodeURIComponent(testKey)}`,
            { ...authHeaders, 'Content-Type': 'application/json' },
            JSON.stringify(JSON.stringify(testData))
        );
        result.tests.set = {
            key: testKey,
            status: setRes.status,
            body: setRes.body
        };

        // 测试 3：GET 刚才的 key
        const getRes = await httpsReq('GET', `${UPSTASH_URL}/get/${encodeURIComponent(testKey)}`, authHeaders);
        result.tests.get = {
            status: getRes.status,
            body: getRes.body
        };

        // 测试 4：清理
        await httpsReq('GET', `${UPSTASH_URL}/del/${encodeURIComponent(testKey)}`, authHeaders);

        return new Response(JSON.stringify(result, null, 2), {
            status: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    } catch (error) {
        result.error = error.message;
        return new Response(JSON.stringify(result, null, 2), {
            status: 500,
            headers: { 'Content-Type': 'application/json; charset=utf-8' }
        });
    }
}
