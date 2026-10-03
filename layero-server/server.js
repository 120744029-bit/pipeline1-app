// ============================================================
//        Layero 备用后端主入口
//        业务代码在 ./api/ 下（复制自 cloud-functions）
// ============================================================
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

// 引入本地 api/ 里的业务逻辑
import { handler as kvHandler }         from './api/kv.js';
import { handler as workHandler }       from './api/work.js';
import { handler as tailsHandler }      from './api/tails.js';
import { handler as adminNotesHandler } from './api/admin-notes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: '10mb' }));

// ---------- 统一 CORS ----------
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Password');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

// ---------- 适配器 ----------
function adapt(handler) {
    return async (req, res) => {
        const reqObj = {
            method: req.method,
            query: { ...req.query },
            body: req.body || {},
            headers: req.headers
        };

        let responseData = null;
        let responseStatus = 200;
        const resObj = {
            setHeader: () => {},
            status: (code) => { responseStatus = code; return resObj; },
            json: (data) => { responseData = data; return resObj; },
            end: () => { return resObj; }
        };

        try {
            await handler(reqObj, resObj);
        } catch (err) {
            responseStatus = 500;
            responseData = { success: false, message: '服务器错误: ' + err.message };
        }

        res.status(responseStatus);
        if (responseData !== null) {
            res.json(responseData);
        } else {
            res.end();
        }
    };
}

// ---------- 挂载路由（保留 /api 前缀）----------
app.all('/api/kv', adapt(kvHandler));
app.all('/api/work', adapt(workHandler));
app.all('/api/tails', adapt(tailsHandler));
app.all('/api/admin-notes', adapt(adminNotesHandler));

// ---------- 健康检查 ----------
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ---------- 静态前端（可选：Layero 也托管前端）----------
// 前端文件在仓库根目录，容器里路径是 ../ （相对于 layero-server/）
app.use(express.static(path.join(__dirname, '..')));

// 未匹配的请求返回 index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// ---------- 启动 ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('🚀 Layero 备用后端已启动，端口 ' + PORT);
});