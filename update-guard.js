/* =============================================================================
 * update-guard.js —— 独立热更新哨兵（加固版）
 * -----------------------------------------------------------------------------
 * 设计目标：无论 index.html 的业务代码是否崩溃，都能把新版本拉下来。
 *
 * 为什么需要它：
 *   旧版把 checkHotUpdate() 放在启动队列末尾的 onQueueDone() 里。
 *   一旦工作量/管线等任一页面初始化抛异常，startApp() 中断，队列不跑完，
 *   onQueueDone() 永远不执行 → 热更新检查永远不触发 → 手机卡死在坏版本，
 *   只能手动清数据/重装。4.1.0 就是这样卡死的。
 *
 * 本文件的原则：
 *   1. 完全自包含：不调用 index.html 里的任何函数/变量（除了全局 plus）。
 *   2. 用 plus.net.XMLHttpRequest 直接请求，不依赖 fetch / polyfill / 业务初始化。
 *   3. 在 plusready 后尽早启动，且用多道定时保险（启动即查 + 5 秒 + 30 秒 + 之后每分钟）。
 *   4. 自身所有逻辑都包 try-catch，绝不给业务代码添乱。
 *   5. 版本比较用数字逐段比，只有"线上 > 本地"才更新，避免同版本反复下载。
 * ============================================================================= */
(function () {
    'use strict';

    // 后端地址：主站优先，本地存储里若存了备用站则用备用站。
    // 完全独立读取，不依赖 index.html 的 BACKENDS/lsGet。
    var PRIMARY = 'https://pipeline1-app-sjb7zjvz.edgeone.dev';
    var BACKUP = 'https://pipeline1-app.layero.app';

    // 防止两处同时更新、或一分钟内重复弹窗
    var updating = false;
    var lastCheck = 0;
    var CHECK_INTERVAL = 60 * 1000; // 每 60 秒复查一次（兜底）

    function log() {
        try { console.log.apply(console, ['[更新哨兵]'].concat([].slice.call(arguments))); } catch (e) {}
    }

    // 读取当前站点。注意：index.html 的 lsSet() 用 JSON.stringify 写入，
    // 所以 localStorage 里存的是 "\"backup\""（带引号），而不是裸的 backup。
    // 这里必须兼容两种格式，否则切到备站后哨兵仍永远走主站。
    function getBase() {
        try {
            var raw = localStorage.getItem('active_backend');
            if (!raw) return PRIMARY;
            var b = raw;
            try { b = JSON.parse(raw); } catch (e) {}   // "\"backup\"" -> backup
            if (b === 'backup' || raw === 'backup') return BACKUP;
        } catch (e) {}
        return PRIMARY;
    }

    // 当前实际生效的站点名（用于日志）
    function getBackendName() { return getBase() === BACKUP ? 'backup(备用站)' : 'primary(主站)'; }

    // 数字逐段比较：remote > current 返回 true
    function isNewer(current, remote) {
        try {
            if (!current || !remote) return false;
            var c = String(current).split('.'), r = String(remote).split('.');
            for (var i = 0; i < Math.max(c.length, r.length); i++) {
                var cn = parseInt(c[i] || '0', 10) || 0;
                var rn = parseInt(r[i] || '0', 10) || 0;
                if (rn > cn) return true;
                if (rn < cn) return false;
            }
            return false;
        } catch (e) { return false; }
    }

    // 本地已安装版本（wgt 的 manifest.version.name）——不依赖业务变量
    function currentVersion(cb) {
        try {
            if (typeof plus === 'undefined' || !plus.runtime || !plus.runtime.getProperty) {
                cb(''); return;
            }
            plus.runtime.getProperty(plus.runtime.appid, function (info) {
                try { cb((info && info.version) || ''); } catch (e) { cb(''); }
            });
        } catch (e) { cb(''); }
    }

    function short(base) { return base === BACKUP ? '备站' : '主站'; }
    function otherOf(base) { return base === PRIMARY ? BACKUP : PRIMARY; }

    // 把 version.json 里给的 wgtUrl 归一到指定站：
    // json 里写死哪个域名都不影响，一律改成从【实际拿到 version.json 的那个站】下载。
    // 主站整个挂掉时 json 从备站拿到，包也自动从备站取。
    function normalizeWgtUrl(wgtUrl, base) {
        if (!wgtUrl) return '';
        if (wgtUrl.charAt(0) === '/') return base + wgtUrl;
        if (wgtUrl.indexOf(PRIMARY) === 0) return base + wgtUrl.slice(PRIMARY.length);
        if (wgtUrl.indexOf(BACKUP) === 0) return base + wgtUrl.slice(BACKUP.length);
        return wgtUrl;   // 第三方完整 URL，原样保留
    }

    var downloadFallbackTried = false;   // 本次更新是否已换站重试过

    function downloadAndInstall(wgtUrl, base) {
        if (updating) return;
        updating = true;
        downloadFallbackTried = false;
        try {
            log('开始下载更新包（' + short(base) + '）：' + wgtUrl);
            plus.nativeUI.showWaiting('正在下载新版本...', { modal: true });
            // 先删旧包再下
            try {
                plus.io.resolveLocalFileSystemURL('_doc/update.wgt', function (entry) {
                    try { entry.remove(function () { doDownload(wgtUrl, base); }, function () { doDownload(wgtUrl, base); }); }
                    catch (e) { doDownload(wgtUrl, base); }
                }, function () { doDownload(wgtUrl, base); });
            } catch (e) { doDownload(wgtUrl, base); }
        } catch (e) {
            finishDownloadFail();
        }
    }

    function doDownload(wgtUrl, base) {
        try {
            var dtask = plus.downloader.createDownload(
                wgtUrl + (wgtUrl.indexOf('?') >= 0 ? '&' : '?') + 't=' + new Date().getTime(),
                { filename: '_doc/update.wgt', method: 'GET' },
                function (task, status) {
                    try {
                        if (status === 200 && (task.state === 4 || task.downloadedSize > 0)) {
                            plus.io.resolveLocalFileSystemURL('_doc/update.wgt', function (entry) {
                                try { plus.nativeUI.closeWaiting(); } catch (e) {}
                                install(entry.fullPath);
                            }, function () {
                                try { plus.nativeUI.closeWaiting(); plus.nativeUI.toast('更新包保存失败'); } catch (e) {}
                                log('更新包保存失败');
                                onDownloadFail(wgtUrl, base);
                            });
                        } else {
                            log('下载失败（' + short(base) + '）status=' + status + ' state=' + (task && task.state));
                            onDownloadFail(wgtUrl, base);
                        }
                    } catch (e) { onDownloadFail(wgtUrl, base); }
                }
            );
            dtask.start();
        } catch (e) { onDownloadFail(wgtUrl, base); }
    }

    // 下载失败：换另一站重试一次（把 URL 从失败站的域名剥掉换成另一站），
    // 两站都失败才真正放弃。
    function onDownloadFail(failedUrl, base) {
        if (!downloadFallbackTried) {
            downloadFallbackTried = true;
            var other = otherOf(base);
            var altUrl = (base && failedUrl.indexOf(base) === 0)
                ? other + failedUrl.slice(base.length)
                : failedUrl;
            log('下载失败，换' + short(other) + '重试：' + altUrl);
            try { doDownload(altUrl, other); } catch (e) { finishDownloadFail(); }
        } else {
            log('主备站下载均失败，放弃本次更新');
            finishDownloadFail();
        }
    }

    function finishDownloadFail() {
        updating = false;
        downloadFallbackTried = false;
        try { plus.nativeUI.closeWaiting(); } catch (e) {}
        try { plus.nativeUI.toast('暂时无法获取更新，稍后自动重试'); } catch (e) {}
    }

    function install(filePath) {
        try {
            var p = filePath.indexOf('file://') === 0 ? filePath : 'file://' + filePath;
            plus.nativeUI.showWaiting('正在安装新版本...', { modal: true });
            plus.runtime.install(p, { force: false }, function () {
                try { plus.nativeUI.closeWaiting(); } catch (e) {}
                try {
                    plus.nativeUI.alert('✅ 已更新到新版本，即将重启', function () {
                        try { plus.runtime.restart(); } catch (e) {}
                    });
                } catch (e) { try { plus.runtime.restart(); } catch (e2) {} }
            }, function (e) {
                try { plus.nativeUI.closeWaiting(); plus.nativeUI.toast('安装失败：' + (e && e.message)); } catch (e2) {}
                updating = false;
            });
        } catch (e) {
            try { plus.nativeUI.closeWaiting(); } catch (e2) {}
            updating = false;
        }
    }

    // 请求单个站的 version.json，成功 cb({data,base})，失败 cb(null)。
    // 三种失败都要兜住：status≠200、网络错误 onerror、迟迟不回调（超时 abort）。
    function fetchVersion(base, cb) {
        var done = false;
        var timer = null;
        function finish(r) {
            if (done) return;
            done = true;
            if (timer) { try { clearTimeout(timer); } catch (e) {} }
            cb(r);
        }
        try {
            var url = base + '/version.json?t=' + Date.now();
            var xhr = new plus.net.XMLHttpRequest();
            xhr.onreadystatechange = function () {
                try {
                    if (done || xhr.readyState !== 4) return;
                    if (xhr.status !== 200) { finish(null); return; }
                    var data = JSON.parse(xhr.responseText);
                    if (!data || !data.version || !data.wgtUrl) { finish(null); return; }
                    finish({ data: data, base: base });
                } catch (e) { finish(null); }
            };
            xhr.onerror = function () { finish(null); };
            xhr.ontimeout = function () { finish(null); };
            xhr.open('GET', url);
            xhr.send();
            timer = setTimeout(function () { try { xhr.abort(); } catch (e) {} finish(null); }, 8000);
        } catch (e) { finish(null); }
    }

    // 拿到 version.json 后统一处理：wgtUrl 归一到实际成功的站，再比版本、下载。
    function onVersionGot(r) {
        try {
            var data = r.data;
            var base = r.base;
            var remoteVer = data.version;
            // json 里 wgtUrl 写死哪个域名都不管，一律归一到【真正拿到 json 的那个站】。
            // 主站整个挂掉 → json 来自备站 → 包也从备站取，不再碰挂掉的主站。
            var wgtUrl = normalizeWgtUrl(data.wgtUrl, base);
            log('线上版本=' + remoteVer + '（来源 ' + short(base) + '）');
            currentVersion(function (localVer) {
                try {
                    log('本地版本=' + (localVer || '(空)') + ' 线上=' + remoteVer);
                    if (isNewer(localVer, remoteVer)) downloadAndInstall(wgtUrl, base);
                } catch (e) {}
            });
        } catch (e) { log('处理版本信息失败：' + (e && e.message)); }
    }

    function check() {
        try {
            if (updating) return;
            var now = Date.now();
            if (now - lastCheck < 15000) return; // 15 秒内不重复查
            lastCheck = now;

            if (typeof plus === 'undefined' || !plus.net || !plus.net.XMLHttpRequest) {
                log('plus.net 未就绪，跳过本次');
                return;
            }

            var base = getBase();
            var other = otherOf(base);
            log('检查版本：先试' + short(base));

            // 先试当前站；失败（含主站整个挂掉）自动换另一站。任一站拿到就用哪站。
            fetchVersion(base, function (r) {
                if (r) { onVersionGot(r); return; }
                log(short(base) + '不可用，改试' + short(other));
                fetchVersion(other, function (r2) {
                    if (r2) { onVersionGot(r2); return; }
                    log('主备站都无法获取 version.json，本次跳过');
                });
            });
        } catch (e) { log('检查异常：' + (e && e.message)); }
    }

    function arm() {
        log('哨兵已启动');
        // 立即查一次
        setTimeout(check, 800);
        // 多道保险：即使某次因网络/时序失败，后面还有机会
        setTimeout(check, 5000);
        setTimeout(check, 15000);
        setTimeout(check, 30000);
        // 之后每分钟复查（覆盖"用户一直不关 APP"的场景）
        setInterval(check, CHECK_INTERVAL);
    }

    function boot() {
        try {
            if (typeof plus !== 'undefined' && plus && plus.runtime) {
                arm();
            } else {
                document.addEventListener('plusready', arm, false);
                // 兜底：3 秒后无论如何武装一次（浏览器环境 plus 不会来）
                setTimeout(function () {
                    if (typeof plus === 'undefined') {
                        log('非 APP 环境（无 plus），哨兵待机');
                    } else {
                        arm();
                    }
                }, 3000);
            }
        } catch (e) {}
    }

    // 脚本可能在 body 任意位置被加载，DOM 未就绪也能监听 plusready（事件挂在 document 上）
    boot();
})();
