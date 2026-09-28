export async function onRequest(context) {
    return new Response(JSON.stringify({
        ok: true,
        message: 'EdgeOne 函数连通成功！',
        path: new URL(context.request.url).pathname,
        time: new Date().toLocaleString()
    }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
        }
    });
}
