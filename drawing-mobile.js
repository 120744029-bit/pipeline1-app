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

    // v1 索引里存过「同一文件重复几百次」的脏数据，升级到 v2 让旧缓存自动失效。
    // 目录配置 v1 继续沿用，用户选过的限定目录不丢。
    var LS_INDEX = 'pd.mobileDrawings.index.v2';
    var LEGACY_INDEX = 'pd.mobileDrawings.index.v1';
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
    // 不折叠：同一图号下每份文件（含 _Copy 副本）都列出来，不隐藏任何一份。
    // 排序仍把当前版 / 非副本 / 短文件名的正式版放在前面，方便优先点开。
    var showDuplicates = true;
    var lastReadRounds = 0;       // 诊断用：本次扫描单个目录最多读了几批 readEntries
    var lastCacheOk = null;       // 诊断用：索引是否成功写入 localStorage
    var lastCacheBytes = 0;

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
    function fileKey(f) { return f.p || f.u || ((f.d || '') + '/' + f.n); }
    function dedupFiles(list) {
        var seen = {}, out = [];
        for (var i = 0; i < list.length; i++) {
            var k = fileKey(list[i]);
            if (seen[k]) continue;
            seen[k] = 1; out.push(list[i]);
        }
        return out;
    }
    // 索引压缩：每条只存「目录表下标 + 文件名」，不再把完整路径重复存 3 遍。
    // 真机实测 HBuilder 基座 localStorage 可用额度只有约 256~512KB（页面自身还占着
    // 工作量/支架等缓存），2353 份图纸按原格式要 691KB，必然 QuotaExceededError。
    // 压缩后约 160KB，能正常落盘，重启不用重扫。
    function encodeIndex() {
        var dirs = [], map = {};
        function idx(d) {
            d = d || '';
            if (!(d in map)) { map[d] = dirs.length; dirs.push(d); }
            return map[d];
        }
        var f = files.map(function (x) { return [idx(x.d), x.n]; });
        var z = zips.slice(0, 60).map(function (x) { return [idx(x.d), x.n]; });
        return { v: 2, t: builtAt, dirs: dirs, f: f, z: z };
    }
    function decodeRows(dirs, rows) {
        return (rows || []).map(function (r) {
            var d = (dirs && dirs[r[0]]) || '';
            var n = r[1] || '';
            var p = d ? (d.charAt(d.length - 1) === '/' ? d + n : d + '/' + n) : n;
            return { n: n, p: p, u: p, d: d };
        });
    }
    function loadIndex() {
        // 旧版索引含大量重复项，直接丢弃；下次扫描会重建干净索引
        try { localStorage.removeItem(LEGACY_INDEX); } catch (e) {}
        try {
            var o = JSON.parse(localStorage.getItem(LS_INDEX) || 'null');
            if (!o || !Array.isArray(o.f)) return;
            if (o.dirs && Array.isArray(o.f[0])) {          // v2 压缩格式
                files = dedupFiles(decodeRows(o.dirs, o.f));
                zips = decodeRows(o.dirs, o.z);
            } else {                                        // 兼容早期未压缩的 v2
                files = dedupFiles(o.f);
                zips = o.z || [];
            }
            builtAt = o.t || 0;
        } catch (e) { /* 缓存损坏就重新扫描 */ }
    }
    function saveIndex() {
        try {
            var s = JSON.stringify(encodeIndex());
            var LIMIT = 380 * 1024;   // 给页面其它缓存留出余量
            // 以前这里硬砍到 12000，导致界面显示「12000 份」这种假数字。
            // 现在按缓存体积逐次裁剪，显示的数量始终是真实（去重后的）文件数。
            if (s.length > LIMIT) {
                while (files.length > 1 && s.length > LIMIT) {
                    files = files.slice(0, Math.floor(files.length * 0.9));
                    s = JSON.stringify(encodeIndex());
                }
                toast('图纸过多，索引只保留前 ' + files.length + ' 份');
            }
            try {
                localStorage.setItem(LS_INDEX, s);
            } catch (e) {
                // 旧值占着额度时，先删再写通常就能成功
                localStorage.removeItem(LS_INDEX);
                localStorage.setItem(LS_INDEX, s);
            }
            lastCacheOk = true;
            lastCacheBytes = s.length;
        } catch (e) {
            lastCacheOk = false;
            lastCacheBytes = 0;
            toast('索引缓存写入失败，每次启动会重扫（不影响本次使用）');
        }
    }
    function status() {
        return {
            ready: ready, scanning: scanning, count: files.length, zips: zips.length,
            builtAt: builtAt, subDir: conf ? conf.subDir : '',
            roots: (conf && conf.subDir && conf.subDir.charAt(0) === '/') ? [conf.subDir] : rootPaths(),
            stale: Date.now() - builtAt > STALE_MS,
            readRounds: lastReadRounds, expanded: true,
            cacheOk: lastCacheOk, cacheBytes: lastCacheBytes
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
            var acc = [], seen = {}, rounds = 0;
            function done() {
                if (rounds > lastReadRounds) lastReadRounds = rounds;
                resolve(acc);
            }
            function step() {
                if (++rounds > 30) return done();   // 防御异常实现无限返回
                reader.readEntries(function (list) {
                    if (!list || !list.length) return done();
                    var added = 0;
                    for (var i = 0; i < list.length; i++) {
                        var e = list[i];
                        var key = e.fullPath || e.name;
                        if (seen[key]) continue;      // 同一条目只收一次
                        seen[key] = 1; acc.push(e); added++;
                    }
                    // 真机实测：DCloud 5+ 对同一个 reader 反复调用 readEntries 会重新
                    // 返回【全部】条目（不推进游标）。旧代码只看 list.length >= 100 就继续读，
                    // 于是 2000 多份图纸被累加十几遍，索引虚高、搜索结果全是重复项。
                    // 这一批没有任何新条目就说明读完了，必须立刻停。
                    if (!added || list.length < 100) return done();
                    step();
                }, function () { done(); });
            }
            step();
        });
    }
    function walk(dir, depth, out, zlist, seen) {
        if (depth > MAX_DEPTH || out.length >= MAX_FILES) return Promise.resolve();
        var reader;
        try { reader = dir.createReader(); } catch (e) { return Promise.resolve(); }
        return readAll(reader).then(function (list) {
            return Promise.all(list.map(function (e) {
                if (e.isDirectory) {
                    if (depth === 0 && SKIP_DIR.test(e.name)) return null;
                    return walk(e, depth + 1, out, zlist, seen);
                }
                if (!e.isFile) return null;
                var rec = {
                    n: e.name,
                    p: e.fullPath || '',
                    u: (typeof e.toURL === 'function') ? e.toURL() : '',
                    d: dir.fullPath || ''
                };
                // 同一路径只收一次：防止多个扫描根目录重叠、嵌套目录被重复遍历
                var key = fileKey(rec);
                if (seen[key]) return null;
                seen[key] = 1;
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
        if (!ready) return Promise.resolve(status());   // 未就绪时不碰 conf / plus.io
        if (scanning) return Promise.resolve(status());
        if (!force && files.length && Date.now() - builtAt < STALE_MS) return Promise.resolve(status());
        scanning = true;
        lastReadRounds = 0;
        setStatus('正在扫描图纸目录…');
        var out = [], zlist = [], seen = {};
        var chain = Promise.resolve();
        return ensurePermission().then(function () {
            // 绝对路径（默认就是 Download/图纸/）时只扫这一处，不枚举 Download 根目录，最快
            var roots = (conf.subDir && conf.subDir.charAt(0) === '/')
                ? [conf.subDir] : rootPaths();
            roots.forEach(function (root) {
                chain = chain.then(function () {
                    return resolveDir(root).then(function (dirEntry) {
                        if (!conf.subDir || conf.subDir.charAt(0) === '/') return walk(dirEntry, 0, out, zlist, seen);
                        // 子目录名形式：先列 Download 一级，找到同名目录再递归
                        return readAll(dirEntry.createReader()).then(function (list) {
                            var target = null;
                            for (var i = 0; i < list.length; i++) {
                                if (list[i].isDirectory && list[i].name === conf.subDir) { target = list[i]; break; }
                            }
                            return target ? walk(target, 0, out, zlist, seen) : null;
                        });
                    }).catch(function () { return null; });
                });
            });
            return chain;
        }).then(function () {
            files = dedupFiles(out);   // 双保险：即使底层返回重复路径也不会进索引
            zips = dedupFiles(zlist);
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
    // _Copy / 副本 / (1) 之类的拷贝件排在同版本后面，不作为默认展示项
    function dupRank(n) {
        return /(_?copy|副本|复制|\(\d+\))/i.test(n) ? 1 : 0;
    }
    function search(query, version) {
        var target = norm(version);
        var tokens = String(query || '').trim().split(/[\s,，]+/).map(norm).filter(Boolean);
        var hits = [], seen = {};
        if (tokens.length) {
            for (var i = 0; i < files.length; i++) {
                var f = files[i];
                var k = f.k || (f.k = norm(f.n));
                var ok = true;
                for (var j = 0; j < tokens.length; j++) {
                    if (k.indexOf(tokens[j]) === -1) { ok = false; break; }
                }
                if (!ok) continue;
                var key = fileKey(f);
                if (seen[key]) continue;     // 同一份文件只算一次，杜绝重复条目
                seen[key] = 1;
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
            var ra = dupRank(a.n), rb = dupRank(b.n);
            if (ra !== rb) return ra - rb;
            // 同版本里文件名更短的通常是正式版，_A / _bak / (1) 之类的副本靠后
            if (a.n.length !== b.n.length) return a.n.length - b.n.length;
            return a.n.localeCompare(b.n);
        });
        // 不再按版本折叠；hits 已按路径去重，全部交给界面显示。
        return { total: hits.length, items: hits.slice(0, 300), target: target,
                 folded: 0, expanded: true };
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
            ? ('已索引 ' + s.count + ' 份图纸（按路径去重）' + (s.subDir ? '（限 ' + s.subDir + '）' : '') + ' · 点击任一版本打开')
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
        if (!ready) tryReady();   // plus 迟到时，点按钮这一刻再补一次初始化
        var p = ensureUi();
        p.classList.add('active');
        if (!ready) {
            setStatus('图纸模块未就绪：请在 APP 内打开；刚升级过请完全退出后重开一次 APP');
            toast('图纸模块尚未就绪，请重启 APP 后再试');
            return;
        }
        render(query || '', version || '');
        if (!files.length || Date.now() - builtAt > STALE_MS) scan(false);
    }
    function close() { if (panel) panel.classList.remove('active'); }

    // 生成结果卡片里的「📐 图纸」按钮。模板里用
    // (window.MobileDrawings ? MobileDrawings.button(...) : '') 调用。
    // 只在「明确的桌面浏览器」隐藏：5+ APP / 手机 WebView / HBuilder 基座一律显示，
    // 避免 plus 注入晚于结果渲染时按钮静默消失（4.1.4 反馈的问题）。
    function isPlainBrowser() {
        if (typeof plus !== 'undefined') return false;
        var ua = navigator.userAgent || '';
        if (/Html5Plus|uni-app|DCloud|HBuilder|Android|iPhone|iPad|Mobile|wv/i.test(ua)) return false;
        return true;
    }
    function button(iso, ver) {
        if (isPlainBrowser()) return '';
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
            search: function (q, v) { return search(q, v); },
            // 兼容旧调用：现在恒为展开，不做任何隐藏
            setExpanded: function () { render(isoNo, isoVer); return status(); }
        };
    }

    // ---------------------------------------------------------------
    // 启动：等 plusready；网页版收不到事件，轮询若干次后安静放弃
    // ---------------------------------------------------------------
    // 面板与样式不依赖 plus：按钮渲染出来就能点开，哪怕 plus 还没注入
    function ensureUi() {
        if (!conf) conf = loadConf();
        if (!document.getElementById('dwMobileStyle')) {
            var st = document.createElement('style');
            st.id = 'dwMobileStyle';
            st.textContent = CSS;
            document.head.appendChild(st);
        }
        return buildPanel();
    }
    // plusready 可能在本脚本加载前就触发过了；点按钮 / APP 恢复时主动补一次
    function tryReady() {
        if (ready) return true;
        if (typeof plus === 'undefined' || !plus.io || !plus.runtime) return false;
        init();
        return ready;
    }
    function init() {
        if (ready) return;
        if (typeof plus === 'undefined' || !plus.io || !plus.runtime) return;
        ready = true;
        conf = loadConf();
        loadIndex();
        ensureUi();
        setStatus(files.length ? ('已载入 ' + files.length + ' 份图纸索引') : '等待扫描图纸目录');
        // 首次或索引过期，后台静默扫描，不阻塞界面
        if (!files.length || Date.now() - builtAt > STALE_MS) setTimeout(function () { scan(false); }, 600);
    }

    // 关键：全局入口【立即】挂载，不等 plusready。
    // 结果卡片只认 window.MobileDrawings 是否存在；以前挂在 init() 里，
    // 一旦 plusready 已错过或轮询超时，整排「📐 图纸」按钮就会静默消失。
    expose();

    var tries = 0;
    function boot() {
        if (typeof plus === 'undefined' || !plus.io || !plus.runtime) {
            if (++tries < 400) setTimeout(boot, 150);   // 冷启动 / wgt 重启最多等 60 秒
            return;
        }
        init();
    }
    document.addEventListener('plusready', init, false);
    // 从后台恢复、wgt 热更新重启后再补一次，避免 init 永远没跑
    document.addEventListener('resume', function () { tryReady(); }, false);
    window.addEventListener('pageshow', function () { tryReady(); }, false);
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, false);
    } else {
        boot();
    }
})();
