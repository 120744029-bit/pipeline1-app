export async function onRequest(context) {
    const { request } = context;
    const url = new URL(request.url);

    return new Response(JSON.stringify({
        ok: true,
        message: 'EdgeOne 函数识别成功！',
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        time: new Date().toLocaleString()
    }), {
        status: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*'
        }
    });
}