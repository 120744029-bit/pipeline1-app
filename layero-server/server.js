// ============================================================
//        Layero 备用后端主入口
//        复用 cloud-functions 里的业务逻辑
// ============================================================
import express from 'express';

// 引入 EdgeOne 的业务逻辑（已导出 originalHandler）
import { originalHandler as kvHandler } from '../cloud-functions/api/kv.js';
import { originalHandler as workHandler } from '../cloud-functions/api/work.js';
import { originalHandler as tailsHandler } from '../cloud-functions/api/tails.js';
import { originalHandler as adminNotesHandler } from '../cloud-functions/api/admin-notes.js';

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

// ---------- 适配器：把 Express 的 req/res 包装成 EdgeOne 格式 ----------
function adapt(handler) {
    return async (req, res) => {
        // Express 的 req.query 是 getter，转成普通对象
        const reqObj = {
            method: req.method,
            query: { ...req.query },
            body: req.body || {},
            headers: req.headers
        };

        // 收集响应
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

// ---------- 挂载路由 ----------
app.all('/api/kv', adapt(kvHandler));
app.all('/api/work', adapt(workHandler));
app.all('/api/tails', adapt(tailsHandler));
app.all('/api/admin-notes', adapt(adminNotesHandler));

// ---------- 健康检查 ----------
app.get('/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ---------- 启动 ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log('🚀 Layero 备用后端已启动，端口 ' + PORT);
});