/*!
 * 管线查询 · 手机端图纸搜索（仅在 5+ App / HBuilderX 运行环境生效）
 *
 * 设计要点：
 *  1. 只扫描手机公共目录里的【文件名】建立轻量索引，不复制、不解压图纸本体，
 *     因此 200MB~1GB 的图纸也不会占用额外手机空间。
 *  2. 电脑上把解压好的 PDF 文件夹拷进手机 Download/ 下即可，零配置。
 *  3. 按图号聚合成版本列表，与「图纸版本」一致的标「当前版」并排最前，
 *     每个版本都能单独点开（plus.runtime.openFile 调系统应用）。
 *  4. 兼容压缩包：若目录里发现 .zip，提供手动解压导入（会占双倍空间，故不自动执行）。
 *  5. 网页版 / 桌面版不初始化；桌面版同步脚本会剥掉本文件的 script 标签。
 */
(function () {
    'use strict';

    var LS_INDEX = 'pd.mobileDrawings.index.v1';
    var LS_CONF = 'pd.mobileDrawings.conf.v1';
    var DRAW_EXT = /\.(pdf|dwg|dxf|dwf|plt|png|jpe?g|tiff?|bmp)$/i;
    var ZIP_EXT = /\.zip$/i;
    var MAX_FILES = 20000;
    // 默认只扫这一个图纸文件夹。真机实测：枚举整个 Download 一级目录就要 12 秒，
    // 直接指向固定目录能压到几秒。用户可在「限定目录」里改成别的路径。
    var DEFAULT_DRAWING_DIR = '/storage/emulated/0/Download/图纸/';
    var MAX_DEPTH = 5;
    // 5+ 的 readEntries 是跨进程调用，单次约 5~12 秒。跳过明显无关目录可大幅提速。
    var SKIP_DIR = /^(\.|QQBrowser|DLManager|BaiduNetdisk|WeiXin|QQ|downloaded_rom|downloaded_xms|Android|DCIM|Movies|Music|Pictures|Alarms|Ringtones)/i;
    var STALE_MS = 10 * 60 * 1000;   // 索引超过 10 分钟自动后台刷新

    var files = [];        // { n:文件名, p:fullPath, u:toURL, d:所在目录, k:归一化名 }
    var zips = [];
    var builtAt = 0;
    var scanning = false;
    var scanRetried = false;   // 首次授权弹框可能晚于扫描，0 份时自动重试一次
    var ready = false;
    var conf = null;
    var panel = null;
    var isoNo = '';
    var isoVer = '';

    // ---------------------------------------------------------------
    // 工具
    // ---------------------------------------------------------------
    function norm(s) {
        return String(s == null ? '' : s).toUpperCase().replace(/[^A-Z0-9\u4e00-\u9fa5]/g, '');
    }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c];
        });
    }
    function toast(msg) {
        try {
            if (typeof plus !== 'undefined' && plus.nativeUI) plus.nativeUI.toast(msg);
            else if (typeof showToast === 'function') showToast(msg);
            else console.log('[图纸] ' + msg);
        } catch (e) { console.log('[图纸] ' + msg); }
    }
    function loadConf() {
        try {
            var o = JSON.parse(localStorage.getItem(LS_CONF) || '{}');
            // 兼容旧版本存过的空值配置，一律回退到默认图纸目录
            var sub = (!o.subDir) ? DEFAULT_DRAWING_DIR : o.subDir;
            return { subDir: sub, roots: Array.isArray(o.roots) ? o.roots : [] };
        } catch (e) { return { subDir: DEFAULT_DRAWING_DIR, roots: [] }; }
    }
    function saveConf() {
        try { localStorage.setItem(LS_CONF, JSON.stringify(conf)); } catch (e) {}
    }
    function loadIndex() {
        try {
            var o = JSON.parse(localStorage.getItem(LS_INDEX) || 'null');
            if (o && Array.isArray(o.f)) {
                files = o.f; zips = o.z || []; builtAt = o.t || 0;
            }
        } catch (e) { /* 缓存损坏就重新扫描 */ }
    }
    function saveIndex() {
        try {
            var s = JSON.stringify({ t: builtAt, f: files, z: zips.slice(0, 60) });
            if (s.length > 3 * 1024 * 1024) {
                files = files.slice(0, 12000);
                s = JSON.stringify({ t: builtAt, f: files, z: zips.slice(0, 60) });
            }
            localStorage.setItem(LS_INDEX, s);
        } catch (e) {
            toast('索引缓存写入失败，本次可用，重启后需重扫');
        }
    }
    function status() {
        return {
            ready: ready, scanning: scanning, count: files.length, zips: zips.length,
            builtAt: builtAt, subDir: conf ? conf.subDir : '',
            roots: (conf && conf.subDir && conf.subDir.charAt(0) === '/') ? [conf.subDir] : rootPaths(),
            stale: Date.now() - builtAt > STALE_MS
        };
    }
    function setStatus(text) {
        var el = document.getElementById('dwStatus');
        if (el) el.textContent = text;
    }

    // ---------------------------------------------------------------
    // 5+ 文件系统扫描（只读目录项，不读取文件内容，因此很快）
    // ---------------------------------------------------------------
    // 真机实测（Android 16 / HBuilder 基座）：plus.io.PUBLIC_DOWNLOADS 指向的是
    // APP 私有目录 Android/data/<pkg>/downloads/，而不是系统公共 Download。
    // 必须用 resolveLocalFileSystemURL + 绝对路径，且需要存储运行时权限。
    // 注意 /sdcard/... 这种路径在 DCloud 新基座会被拒绝，只能用 /storage/emulated/0/...
    var PUBLIC_ROOTS = [
        '/storage/emulated/0/Download/',
        '/storage/emulated/0/Documents/'
    ];

    function resolveDir(p) {
        return new Promise(function (resolve, reject) {
            try {
                plus.io.resolveLocalFileSystemURL(p, function (entry) {
                    if (entry && entry.isDirectory) resolve(entry);
                    else reject(new Error('不是目录：' + p));
                }, function (e) { reject(e || new Error('路径不可用：' + p)); });
            } catch (e) { reject(e); }
        });
    }

    // 首次使用触发系统授权弹框。
    // 真机实测：某些基座/系统下 requestPermissions 的回调根本不会触发，
    // 因此这里【只负责触发、不等待回调】，绝不把扫描卡在 Promise 上。
    // 若用户当时没点允许，扫描会得到 0 份，界面会提示授权后点「刷新索引」。
    function ensurePermission() {
        try {
            if (plus.android && plus.android.requestPermissions) {
                plus.android.requestPermissions(
                    ['android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE'],
                    function () {}, function () {}
                );
            }
        } catch (e) {}
        return Promise.resolve();
    }
    function readAll(reader) {
        return new Promise(function (resolve) {
            var acc = [], rounds = 0;
            function step() {
                if (++rounds > 200) return resolve(acc);   // 防御某些实现的无限返回
                reader.readEntries(function (list) {
                    if (!list || !list.length) return resolve(acc);
                    for (var i = 0; i < list.length; i++) acc.push(list[i]);
                    // DCloud 的 readEntries 通常一次返回全部；只有接近分批上限才继续读。
                    // 每个目录少一次跨进程调用，真机上能省下约一半时间。
                    if (list.length < 100) return resolve(acc);
                    step();
                }, function () { resolve(acc); });
            }
            step();
        });
    }
    function walk(dir, depth, out, zlist) {
        if (depth > MAX_DEPTH || out.length >= MAX_FILES) return Promise.resolve();
        var reader;
        try { reader = dir.createReader(); } catch (e) { return Promise.resolve(); }
        return readAll(reader).then(function (list) {
            return Promise.all(list.map(function (e) {
                if (e.isDirectory) {
                    if (depth === 0 && SKIP_DIR.test(e.name)) return null;
                    return walk(e, depth + 1, out, zlist);
                }
                if (!e.isFile) return null;
                var rec = {
                    n: e.name,
                    p: e.fullPath || '',
                    u: (typeof e.toURL === 'function') ? e.toURL() : '',
                    d: dir.fullPath || ''
                };
                if (DRAW_EXT.test(e.name)) { if (out.length < MAX_FILES) out.push(rec); }
                else if (ZIP_EXT.test(e.name)) zlist.push(rec);
                return null;
            }));
        }).catch(function () { /* 某个目录无权限就跳过 */ });
    }
    function rootPaths() {
        if (conf.roots && conf.roots.length) {
            // 兼容早期可能存过的数字常量，只保留字符串绝对路径
            return conf.roots.filter(function (r) { return typeof r === 'string' && r.charAt(0) === '/'; });
        }
        return PUBLIC_ROOTS.slice();
    }
    function scan(force) {
        if (scanning) return Promise.resolve(status());
        if (!force && files.length && Date.now() - builtAt < STALE_MS) return Promise.resolve(status());
        scanning = true;
        setStatus('正在扫描图纸目录…');
        var out = [], zlist = [];
        var chain = Promise.resolve();
        return ensurePermission().then(function () {
            // 绝对路径（默认就是 Download/图纸/）时只扫这一处，不枚举 Download 根目录，最快
            var roots = (conf.subDir && conf.subDir.charAt(0) === '/')
                ? [conf.subDir] : rootPaths();
            roots.forEach(function (root) {
                chain = chain.then(function () {
                    return resolveDir(root).then(function (dirEntry) {
                        if (!conf.subDir || conf.subDir.charAt(0) === '/') return walk(dirEntry, 0, out, zlist);
                        // 子目录名形式：先列 Download 一级，找到同名目录再递归
                        return readAll(dirEntry.createReader()).then(function (list) {
                            var target = null;
                            for (var i = 0; i < list.length; i++) {
                                if (list[i].isDirectory && list[i].name === conf.subDir) { target = list[i]; break; }
                            }
                            return target ? walk(target, 0, out, zlist) : null;
                        });
                    }).catch(function () { return null; });
                });
            });
            return chain;
        }).then(function () {
            files = out;
            zips = zlist;
            builtAt = Date.now();
            scanning = false;
            saveIndex();
            setStatus('共 ' + files.length + ' 份图纸 · ' + new Date(builtAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
            if (panel && panel.classList.contains('active')) render(isoNo, isoVer);
            // 首次进来会弹系统授权框，扫描往往比用户点「允许」更早结束。
            // 结果为空时延迟重扫一次，用户点完允许就能直接看到图纸，不必手动刷新。
            if (!files.length && !scanRetried) {
                scanRetried = true;
                setTimeout(function () { scan(true); }, 2500);
            }
            return status();
        }).catch(function (e) {
            scanning = false;
            setStatus('扫描失败：' + (e && e.message ? e.message : '未知错误'));
            return status();
        });
    }

    // ---------------------------------------------------------------
    // 版本解析：以单线图号为锚点，只取图号【之后】的后缀作为版本，
    // 避免把图号里的 12600 / 3311 / 00183 误判成版本号。
    // 例：...ISO-00183_01_4_publish.pdf -> tail "014PUBLISH" -> 版本 "01"
    //     ...ISO-00183_00.pdf           -> tail "00"          -> 版本 "00"
    // ---------------------------------------------------------------
    function tailOf(name, iso) {
        var a = norm(name), b = norm(iso);
        var i = b ? a.indexOf(b) : -1;
        return i >= 0 ? a.slice(i + b.length) : '';
    }
    function versionOf(tail) {
        if (!tail) return '未标注';
        var m = tail.match(/^([0-9]{1,3}|[A-Z])/);
        if (!m) return '未标注';
        var v = m[1];
        if (/^[0-9]{3}$/.test(v)) v = v.slice(0, 2);
        return v;
    }
    function search(query, version) {
        var target = norm(version);
        var tokens = String(query || '').trim().split(/[\s,，]+/).map(norm).filter(Boolean);
        var hits = [];
        if (tokens.length) {
            for (var i = 0; i < files.length; i++) {
                var f = files[i];
                var k = f.k || (f.k = norm(f.n));
                var ok = true;
                for (var j = 0; j < tokens.length; j++) {
                    if (k.indexOf(tokens[j]) === -1) { ok = false; break; }
                }
                if (!ok) continue;
                var tail = tailOf(f.n, query);
                hits.push({
                    n: f.n, p: f.p, u: f.u, d: f.d,
                    ver: versionOf(tail),
                    current: !!(target && (tail.indexOf(target) === 0 || versionOf(tail) === target))
                });
            }
        }
        hits.sort(function (a, b) {
            if (a.current !== b.current) return a.current ? -1 : 1;
            if (a.ver !== b.ver) return b.ver.localeCompare(a.ver, 'en', { numeric: true });
            // 同版本里文件名更短的通常是正式版，_A / _bak / (1) 之类的副本靠后
            if (a.n.length !== b.n.length) return a.n.length - b.n.length;
            return a.n.localeCompare(b.n);
        });
        return { total: hits.length, items: hits.slice(0, 300), target: target };
    }

    // ---------------------------------------------------------------
    // 打开图纸（多条路径形态轮流尝试，失败给出可复制的完整路径）
    // ---------------------------------------------------------------
    function copyText(text) {
        try {
            if (typeof plus !== 'undefined' && plus.clipboard) plus.clipboard.setData(text);
            else if (navigator.clipboard) navigator.clipboard.writeText(text);
        } catch (e) {}
    }
    function openFail(item) {
        var path = item.p || item.u || item.n;
        copyText(path);
        try {
            plus.nativeUI.alert('无法直接打开这张图纸。\n\n文件：' + item.n + '\n路径：' + path +
                '\n\n路径已复制，可用文件管理器查找；PDF 建议安装 WPS 或系统 PDF 阅读器，DWG/DXF 需要 CAD 看图 App。',
                function () {}, '打开失败');
        } catch (e) { toast('打开失败，路径已复制：' + path); }
    }
    function openFile(idx) {
        var res = search(isoNo, isoVer);
        var item = res.items[idx];
        if (!item) return;
        var candidates = [];
        if (item.p) candidates.push(item.p);
        if (item.u) candidates.push(item.u);
        if (item.p && item.p.indexOf('file://') !== 0) candidates.push('file://' + item.p);
        var i = 0;
        function next() {
            if (i >= candidates.length) { openFail(item); return; }
            var path = candidates[i++];
            try {
                plus.runtime.openFile(path, function () { next(); });
            } catch (e) { next(); }
        }
        next();
    }

    // ---------------------------------------------------------------
    // 界面
    // ---------------------------------------------------------------
    var CSS = [
        '.mobile-only{display:inline-block !important}',
        '.dw-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,.45)}',
        '.dw-overlay.active{display:flex;align-items:stretch;justify-content:center}',
        '.dw-panel{width:100%;max-width:520px;background:var(--bg-page);display:flex;flex-direction:column;height:100%;box-shadow:0 0 24px rgba(0,0,0,.25)}',
        '.dw-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:var(--bg-card);border-bottom:1px solid var(--border-light)}',
        '.dw-title{font-size:calc(17px * var(--font-scale));font-weight:600;color:var(--text-primary)}',
        '.dw-x{border:0;background:transparent;color:var(--text-secondary);font-size:22px;line-height:1;padding:2px 8px;cursor:pointer}',
        '.dw-search{display:flex;gap:8px;padding:12px 16px;background:var(--bg-card)}',
        '.dw-search input{flex:1;min-width:0;padding:10px 12px;border:1px solid var(--border-light);border-radius:6px;background:var(--bg-input);color:var(--text-primary);font-size:calc(14px * var(--font-scale))}',
        '.dw-btn{border:0;border-radius:6px;background:var(--green-primary);color:#fff;padding:9px 14px;font-size:calc(14px * var(--font-scale));cursor:pointer;white-space:nowrap}',
        '.dw-btn.ghost{background:var(--bg-hover);color:var(--text-primary);border:1px solid var(--border-light)}',
        '.dw-meta{padding:8px 16px;color:var(--text-secondary);font-size:calc(12px * var(--font-scale));background:var(--bg-page)}',
        '.dw-list{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 12px 12px}',
        '.dw-empty{padding:36px 18px;text-align:center;color:var(--text-secondary);font-size:calc(14px * var(--font-scale));line-height:1.9}',
        '.dw-item{background:var(--bg-card);border:1px solid var(--border-light);border-radius:8px;padding:12px;margin-bottom:10px;cursor:pointer}',
        '.dw-item.cur{border-color:var(--green-primary);box-shadow:0 0 0 1px var(--green-primary) inset}',
        '.dw-row1{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}',
        '.dw-ver{font-size:calc(12px * var(--font-scale));font-weight:600;padding:2px 8px;border-radius:4px;background:var(--bg-hover);color:var(--text-secondary)}',
        '.dw-ver.cur{background:var(--green-primary);color:#fff}',
        '.dw-name{font-size:calc(13px * var(--font-scale));color:var(--text-primary);word-break:break-all;line-height:1.6}',
        '.dw-path{font-size:calc(11px * var(--font-scale));color:var(--text-tertiary);word-break:break-all;margin-top:4px}',
        '.dw-zip{margin:0 12px 10px;padding:10px 12px;border:1px dashed var(--highlight-border,#F59E0B);border-radius:8px;background:var(--highlight-bg,#FEF3C7);font-size:calc(12px * var(--font-scale));color:var(--text-primary)}',
        '.dw-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:10px 16px calc(12px + env(safe-area-inset-bottom));background:var(--bg-card);border-top:1px solid var(--border-light)}',
        '.dw-status{flex:1;min-width:110px;color:var(--text-secondary);font-size:calc(11px * var(--font-scale));text-align:right}'
    ].join('\n');

    function buildPanel() {
        if (panel) return panel;
        panel = document.createElement('div');
        panel.id = 'dwOverlay';
        panel.className = 'dw-overlay';
        panel.innerHTML =
            '<div class="dw-panel">' +
              '<div class="dw-head"><span class="dw-title">📐 图纸</span><button class="dw-x" id="dwClose" aria-label="关闭">✕</button></div>' +
              '<div class="dw-search"><input id="dwQuery" type="search" placeholder="图号 / 关键词，空格分隔"><button class="dw-btn" id="dwGo">搜索</button></div>' +
              '<div class="dw-meta" id="dwMeta"></div>' +
              '<div id="dwZip"></div>' +
              '<div class="dw-list" id="dwList"></div>' +
              '<div class="dw-foot">' +
                '<button class="dw-btn ghost" id="dwRefresh">刷新索引</button>' +
                '<button class="dw-btn ghost" id="dwFolder">限定目录</button>' +
                '<span class="dw-status" id="dwStatus"></span>' +
              '</div>' +
            '</div>';
        document.body.appendChild(panel);

        document.getElementById('dwClose').addEventListener('click', close);
        panel.addEventListener('click', function (e) { if (e.target === panel) close(); });
        document.getElementById('dwGo').addEventListener('click', function () {
            isoNo = document.getElementById('dwQuery').value.trim();
            isoVer = '';
            render(isoNo, isoVer);
        });
        document.getElementById('dwQuery').addEventListener('keydown', function (e) {
            if (e.keyCode === 13 || e.key === 'Enter') {
                isoNo = this.value.trim(); isoVer = ''; render(isoNo, isoVer);
            }
        });
        document.getElementById('dwList').addEventListener('click', function (e) {
            var el = e.target;
            while (el && el !== this && !(el.getAttribute && el.getAttribute('data-i'))) el = el.parentNode;
            if (el && el.getAttribute && el.getAttribute('data-i') != null) openFile(parseInt(el.getAttribute('data-i'), 10));
        });
        document.getElementById('dwRefresh').addEventListener('click', function () {
            scan(true).then(function (s) { toast('索引已刷新：' + s.count + ' 份图纸'); });
        });
        document.getElementById('dwFolder').addEventListener('click', setFolder);
        document.getElementById('dwZip').addEventListener('click', function (e) {
            if (!e.target || !e.target.getAttribute) return;
            var zi = e.target.getAttribute('data-zip');
            if (zi != null) unzip(parseInt(zi, 10));
        });
        return panel;
    }

    function setFolder() {
        var msg = '默认是 /storage/emulated/0/Download/图纸/，只扫这一个文件夹，最快。\n' +
                  '可改成别的完整路径；想扫全部 Download 就填 /storage/emulated/0/Download/（会慢很多）。\n\n' +
                  '首次使用会申请存储权限，请点「允许」。';
        var cb = function (e) {
            if (e.index === undefined) return;               // 取消
            conf.subDir = String(e.message || '').trim();
            saveConf();
            toast(conf.subDir ? ('已限定目录：' + conf.subDir) : '已恢复扫描全部目录');
            scan(true);
        };
        try {
            plus.nativeUI.prompt(msg, cb, '限定扫描目录', conf.subDir || '', ['确定', '取消']);
        } catch (err) {
            var v = window.prompt(msg, conf.subDir || '');
            if (v !== null) { conf.subDir = v.trim(); saveConf(); scan(true); }
        }
    }

    function unzip(idx) {
        var z = zips[idx];
        if (!z) return;
        if (!plus.zip || !plus.zip.decompress) { toast('当前环境不支持解压，请在电脑上解压后拷入'); return; }
        plus.nativeUI.confirm('解压会额外占用约一倍手机空间（压缩包 + 解压后的 PDF）。\n建议直接在电脑上解压好再拷进手机。\n\n确定要在这台手机上解压吗？', function (e) {
            if (e.index !== 0) return;
            var target = (z.p || '').replace(/\.zip$/i, '') + '/';
            plus.nativeUI.showWaiting('正在解压…', { modal: true });
            try {
                plus.zip.decompress(z.p, target, function () {
                    plus.nativeUI.closeWaiting();
                    toast('解压完成，正在重建索引');
                    scan(true);
                }, function (err) {
                    plus.nativeUI.closeWaiting();
                    plus.nativeUI.alert('解压失败：' + (err && err.message ? err.message : '未知错误') + '\n\n建议在电脑上解压好再拷入手机。');
                });
            } catch (err) {
                plus.nativeUI.closeWaiting();
                plus.nativeUI.alert('解压失败：' + err.message);
            }
        }, '解压图纸包', ['解压', '取消']);
    }

    function renderZipBar() {
        var box = document.getElementById('dwZip');
        if (!box) return;
        if (!zips.length) { box.innerHTML = ''; return; }
        var html = '<div class="dw-zip">发现 ' + zips.length + ' 个压缩包（未自动解压，免占双倍空间）：';
        for (var i = 0; i < Math.min(zips.length, 3); i++) {
            html += '<div style="margin:6px 0;word-break:break-all">' + esc(zips[i].n) +
                    ' <button class="dw-btn ghost" data-zip="' + i + '" style="padding:2px 8px;font-size:11px">解压</button></div>';
        }
        if (zips.length > 3) html += '<div>… 其余 ' + (zips.length - 3) + ' 个</div>';
        html += '</div>';
        box.innerHTML = html;
    }

    function render(query, version) {
        if (!panel) return;
        isoNo = query || '';
        isoVer = version || '';
        var input = document.getElementById('dwQuery');
        if (input && input.value !== isoNo) input.value = isoNo;
        renderZipBar();

        var s = status();
        var meta = document.getElementById('dwMeta');
        meta.textContent = s.count
            ? ('已索引 ' + s.count + ' 份图纸' + (s.subDir ? '（限 ' + s.subDir + '）' : '') + ' · 点击任一版本打开')
            : '';

        var res = search(isoNo, isoVer);
        var list = document.getElementById('dwList');
        var html = '';

        if (!s.count && !scanning) {
            html = '<div class="dw-empty">还没扫描到图纸文件。<br><br>' +
                   '① 电脑上把<b>解压好的 PDF 文件夹</b>拷进手机 <b>Download/图纸/</b>（推荐，扫描最快）；<br>' +
                   '② 首次使用会弹「允许访问存储」，请点允许；<br>' +
                   '③ 点下方「刷新索引」；换目录请用「限定目录」。<br><br>' +
                   '当前扫描路径：' + esc(s.roots.join('、')) + '<br>' +
                   '支持 PDF / DWG / DXF / 图片等；只索引文件名，不复制不解压，不占额外空间。</div>';
        } else if (!isoNo) {
            html = '<div class="dw-empty">输入图号搜索，或在查询结果里点「📐 图纸」按钮。</div>';
        } else if (!res.total) {
            html = '<div class="dw-empty">没找到「' + esc(isoNo) + '」对应的图纸。<br><br>' +
                   '可以只输一段图号（如 12600-20-3311），或点「刷新索引」重新扫描手机目录。</div>';
        } else {
            var cur = 0;
            res.items.forEach(function (it, i) {
                if (it.current) cur++;
                html += '<div class="dw-item' + (it.current ? ' cur' : '') + '" data-i="' + i + '">' +
                          '<div class="dw-row1">' +
                            '<span class="dw-ver' + (it.current ? ' cur' : '') + '">' +
                              (it.current ? '当前版 ' + esc(it.ver) : '版本 ' + esc(it.ver)) + '</span>' +
                            '<span style="font-size:calc(11px * var(--font-scale));color:var(--text-secondary)">点此打开 →</span>' +
                          '</div>' +
                          '<div class="dw-name">' + esc(it.n) + '</div>' +
                          (it.d ? '<div class="dw-path">' + esc(it.d) + '</div>' : '') +
                        '</div>';
            });
            if (res.total > res.items.length) {
                html += '<div class="dw-empty" style="padding:12px">仅显示前 ' + res.items.length + ' 条，共 ' + res.total + ' 条，请缩小图号范围。</div>';
            }
            if (cur === 0 && isoVer) {
                meta.textContent = '未找到与图纸版本 ' + isoVer + ' 一致的文件，以下全部版本均可打开';
            }
        }
        list.innerHTML = html;
        list.scrollTop = 0;
        if (!s.count) setStatus('未找到图纸文件');
        else if (!scanning) setStatus('共 ' + s.count + ' 份 · ' + new Date(s.builtAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }));
    }

    function open(query, version) {
        if (!ready) { toast('图纸模块尚未就绪，请稍后再试'); return; }
        buildPanel().classList.add('active');
        render(query || '', version || '');
        if (!files.length || Date.now() - builtAt > STALE_MS) scan(false);
    }
    function close() { if (panel) panel.classList.remove('active'); }

    // 生成结果卡片里的「📐 图纸」按钮。模板里用
    // (window.MobileDrawings ? MobileDrawings.button(...) : '') 调用，
    // 因此网页版 / 桌面版不会渲染出任何按钮。
    function button(iso, ver) {
        function q(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
        return '<button class="dw-mobile-btn mobile-only" onclick="MobileDrawings.open(\'' +
            q(iso) + '\',\'' + q(ver) + '\')" ' +
            'style="padding:3px 10px;background:var(--bg-hover);border:1px solid var(--border-light);' +
            'border-radius:4px;font-size:11px;color:var(--text-primary);cursor:pointer;' +
            'white-space:nowrap;flex-shrink:0;">📐 图纸</button>';
    }

    // 全局入口只在 plus 就绪后挂载：网页版 / 桌面版永远不会出现按钮
    function expose() {
        window.MobileDrawings = {
            open: open,
            close: close,
            button: button,
            refresh: function () { return ready ? scan(true) : Promise.resolve(status()); },
            status: status,
            search: function (q, v) { return search(q, v); }
        };
    }

    // ---------------------------------------------------------------
    // 启动：等 plusready；网页版收不到事件，轮询若干次后安静放弃
    // ---------------------------------------------------------------
    function init() {
        if (ready) return;
        if (typeof plus === 'undefined' || !plus.io || !plus.runtime) return;
        ready = true;
        conf = loadConf();
        loadIndex();
        expose();
        var st = document.createElement('style');
        st.id = 'dwMobileStyle';
        st.textContent = CSS;
        document.head.appendChild(st);
        buildPanel();
        setStatus(files.length ? ('已载入 ' + files.length + ' 份图纸索引') : '等待扫描图纸目录');
        // 首次或索引过期，后台静默扫描，不阻塞界面
        if (!files.length || Date.now() - builtAt > STALE_MS) setTimeout(function () { scan(false); }, 600);
    }

    var tries = 0;
    function boot() {
        if (typeof plus === 'undefined' || !plus.io || !plus.runtime) {
            if (++tries < 40) setTimeout(boot, 150);
            return;
        }
        init();
    }
    document.addEventListener('plusready', init, false);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, false);
    } else {
        boot();
    }
})();
