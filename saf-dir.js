/*!
 * 系统目录授权（SAF）适配层 —— 仅 5+ App / HBuilderX 环境生效
 * ------------------------------------------------------------------
 * 背景：Mate80 等鸿蒙/高版本 Android 上，APP 主动读 /storage/emulated/0/
 *       公共目录会被拦截，图纸和支架图都扫不到。改用系统文件选择器
 *       ACTION_OPEN_DOCUMENT_TREE，由用户点选文件夹，系统授予 content:// URI
 *       持久权限，APP 按 URI 列文件 / 打开文件，不再硬编码公共路径。
 *
 * 多渠道设计：
 *   1) 首选原生 SAF（openTree / listTree / openUri），走 main.onActivityResult。
 *   2) 若基座不给 startActivityForResult 回调，降级用 Intent.ACTION_GET_CONTENT
 *      选单个文件并拷贝进 APP 私有目录（_doc），保证至少能打开。
 *
 * 对外：window.SafDir = {
 *   available(), openTree(cb), listTree(uri, cb), openUri(uri, name),
 *   getRoot(key), setRoot(key, obj), clearRoot(key), dirLabel()
 * }
 */
(function () {
    'use strict';

    var LS_ROOT = 'pd.saf.roots.v1';   // { drawing:{uri,name}, bracket:{uri,name} }
    var REQ_TREE_DRAW = 9201;
    var REQ_TREE_BRACKET = 9202;
    var pending = null;                // { code, cb }
    var hooked = false;
    var lastDiag = '';                 // 最近一次 listTree 的诊断，供界面显示

    function cls(name) { return plus.android.importClass(name); }
    // 实例方法走 invoke（K80/Mate80 实测 cursor/query 这样可用）
    function inv(obj, method) {
        var args = Array.prototype.slice.call(arguments, 2);
        return plus.android.invoke.apply(plus.android, [obj, method].concat(args));
    }
    // ⚠️ 静态方法（Uri.parse / DocumentsContract.* / takePersistableUriPermission）
    // 在 MIUI/HyperOS 上用 plus.android.invoke 调会返回 null 或抛 InvocationTargetException，
    // 必须直接点方法调用。K80 真机基座实测：invoke(Uri,'parse')→null，Uri.parse()→正常对象。
    function stat(obj, method) {
        var args = Array.prototype.slice.call(arguments, 2);
        return obj[method].apply(obj, args);
    }
    function available() {
        return typeof plus !== 'undefined' && !!plus.android && !!plus.runtime &&
               typeof plus.android.runtimeMainActivity === 'function';
    }
    function toast(msg) {
        try {
            if (typeof showToast === 'function') showToast(msg);
            else if (typeof plus !== 'undefined' && plus.nativeUI) plus.nativeUI.toast(msg);
            else console.log('[SAF] ' + msg);
        } catch (e) { console.log('[SAF] ' + msg); }
    }

    // ---- 持久化根目录 ------------------------------------------------
    function allRoots() {
        try { return JSON.parse(localStorage.getItem(LS_ROOT) || '{}') || {}; }
        catch (e) { return {}; }
    }
    function getRoot(key) { return allRoots()[key] || null; }
    function setRoot(key, obj) {
        var o = allRoots();
        if (obj) o[key] = obj; else delete o[key];
        try { localStorage.setItem(LS_ROOT, JSON.stringify(o)); } catch (e) {}
    }
    function clearRoot(key) { setRoot(key, null); }

    // ---- onActivityResult 统一接管 -----------------------------------
    function hookActivityResult() {
        if (hooked || !available()) return;
        hooked = true;
        var main = plus.android.runtimeMainActivity();
        var prev = null;
        try { prev = main.onActivityResult; } catch (e) {}
        main.onActivityResult = function (requestCode, resultCode, data) {
            try {
                if (pending && requestCode === pending.code) {
                    var p = pending; pending = null;
                    if (resultCode === -1 && data) {   // Activity.RESULT_OK
                        var Intent = cls('android.content.Intent');
                        var FLAG_R = Intent.FLAG_GRANT_READ_URI_PERMISSION;
                        var FLAG_W = Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
                        var uri = data.getData();   // 实例方法直接点（基座实测可用）
                        if (uri) {
                            // 持久授权：重启后仍可访问，热更新 wgt 不掉权限
                            // 直接点方法，invoke 调它在 K80 上抛 InvocationTargetException
                            try { main.takePersistableUriPermission(uri, FLAG_R | FLAG_W); }
                            catch (e) {}
                            var uriStr = String(uri.toString());
                            var name = displayNameOf(uriStr);
                            if (p.cb) p.cb({ uri: uriStr, name: name });
                        } else if (p.cb) p.cb(null);
                    } else if (p.cb) p.cb(null);   // 取消
                }
            } catch (e) { if (pending) { var q = pending; pending = null; if (q.cb) q.cb(null); } }
            if (typeof prev === 'function') {
                try { prev.apply(main, arguments); } catch (e) {}
            }
        };
    }

    function displayNameOf(uriStr) {
        try { return decodeURIComponent(uriStr.split('/').pop()); }
        catch (e) { return uriStr; }
    }

    // ---- 让用户选目录 -------------------------------------------------
    // key: 'drawing' | 'bracket'；选完直接 setRoot(key, {uri,name}) 并回调
    function openTree(key, cb) {
        if (!available()) { if (cb) cb(null); return; }
        hookActivityResult();
        var code = (key === 'bracket') ? REQ_TREE_BRACKET : REQ_TREE_DRAW;
        pending = { code: code, cb: function (r) {
            if (r) { setRoot(key, r); toast('已授权目录：' + r.name); }
            if (cb) cb(r);
        } };
        try {
            var main = plus.android.runtimeMainActivity();
            var Intent = cls('android.content.Intent');
            var intent = new Intent('android.intent.action.OPEN_DOCUMENT_TREE');
            // 授予持久读+写，用户选完后 APP 长期可用
            inv(intent, 'addFlags', Intent.FLAG_GRANT_READ_URI_PERMISSION |
                                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION |
                                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            // 官方示例是直接调用 main.startActivityForResult(intent, code)；
            // 部分基座上 plus.android.invoke 对重载方法匹配失败，优先直调，失败再退回 invoke。
            try { main.startActivityForResult(intent, code); }
            catch (e2) { inv(main, 'startActivityForResult', intent, code); }
        } catch (e) {
            pending = null;
            toast('无法打开系统目录选择器：' + (e && e.message ? e.message : '未知错误'));
            if (cb) cb(null);
        }
    }

    // ---- 列目录（递归，只取文件名 + 单文件 URI）-----------------------
    // cb(list)，list = [{ n:文件名, uri:单文件contentUri }]
    //
    // ⚠️ 坑记录：
    //  1) 红米 K80 选完目录显示 0 份：cr.query 把 JS 数组当 Java String[] 传，
    //     MIUI/HyperOS Native.js 转换失败抛异常被吞 → 改 null projection + getColumnIndex。
    //  2) K80 + Mate80 都报 NullPointerException: uri at ContentResolver.query：
    //     DocumentsContract.buildChildDocumentsUriUsingTree() 静态方法经 Native.js 调用
    //     返回 null。改为按 SAF 标准格式自己拼 children/document URI，不再依赖这俩静态方法。
    // ⚠️ 官方工具类静态方法必须【直接点方法】，不能用 plus.android.invoke：
    //    K80/Mate80 真机基座实测 invoke 调静态方法返回 null 或抛 InvocationTargetException；
    //    直接点 Uri.parse / DocumentsContract.* 全部正常。
    //    另外 children URI 必须是 buildChildDocumentsUriUsingTree 生成的
    //    .../tree/<id>/document/<id>/children 格式，自己拼 .../children/<id> 会报
    //    UnsupportedOperationException: Unsupported Uri。
    function treeDocIdFromUri(s) {
        var m = String(s).match(/\/tree\/([^/]+)/);
        if (!m) return '';
        try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }

    function listTree(treeUri, cb) {
        var out = [];
        lastDiag = '';
        if (!available() || !treeUri) {
            lastDiag = '环境不可用或 URI 为空';
            if (cb) cb(out); return;
        }
        var d = { roots: 0, dirs: 0, files: 0, err: [] };
        try {
            var main = plus.android.runtimeMainActivity();
            var Uri = cls('android.net.Uri');
            var DC = cls('android.provider.DocumentsContract');
            var tree = Uri.parse(String(treeUri));
            // rootId 用官方静态方法直接点获取，失败再从 URI 解
            var rootId = '';
            try { rootId = String(DC.getTreeDocumentId(tree) || ''); }
            catch (e) { d.err.push('rootId:' + (e && e.message ? e.message : e)); }
            if (!rootId) rootId = treeDocIdFromUri(treeUri);
            d.rootId = rootId;
            var cr = inv(main, 'getContentResolver');
            walk(DC, cr, tree, rootId, out, 0, {}, d);
        } catch (e) {
            d.err.push('init:' + (e && e.message ? e.message : e));
        }
        lastDiag = '目录项 ' + d.roots + ' / 子目录 ' + d.dirs + ' / 文件 ' + d.files +
                   (d.rootId ? ' · rootId=' + d.rootId : '') +
                   (d.kidsUri ? ' · children=' + d.kidsUri : '') +
                   (d.sampleUri ? ' · file=' + d.sampleUri : '') +
                   (d.err.length ? ' · 错误:' + d.err.slice(0, 3).join(';') : '');
        if (cb) cb(out);
    }

    function walk(DC, cr, tree, docId, out, depth, seen, d) {
        if (depth > 8 || out.length >= 20000) return;
        if (!docId) return;
        var rows = [];
        try {
            // 官方静态方法直接点：生成标准 children URI
            var kidsUri = DC.buildChildDocumentsUriUsingTree(tree, docId);
            if (d && depth === 0) { try { d.kidsUri = kidsUri.toString(); } catch (e) {} }
            var cursor = inv(cr, 'query', kidsUri, null, null, null, null);
            if (!cursor) { if (d) d.err.push('query返回null@' + depth); return; }
            try {
                var iName = inv(cursor, 'getColumnIndex', '_display_name');
                var iDoc = inv(cursor, 'getColumnIndex', 'document_id');
                var iMime = inv(cursor, 'getColumnIndex', 'mime_type');
                while (inv(cursor, 'moveToNext')) {
                    if (d) d.roots++;
                    var name = iName >= 0 ? String(inv(cursor, 'getString', iName) || '') : '';
                    var cid = iDoc >= 0 ? String(inv(cursor, 'getString', iDoc) || '') : '';
                    var mime = iMime >= 0 ? String(inv(cursor, 'getString', iMime) || '') : '';
                    rows.push({ n: name, id: cid, dir: /directory/.test(mime) });
                }
            } finally {
                try { inv(cursor, 'close'); } catch (e) {}
            }
        } catch (e) {
            if (d) d.err.push('walk' + depth + ':' + (e && e.message ? e.message : e));
            return;
        }
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!r.n || !r.id) continue;
            if (r.dir) {
                if (d) d.dirs++;
                walk(DC, cr, tree, r.id, out, depth + 1, seen, d);
            } else {
                // 官方静态方法直接点：生成标准 document URI（供 ACTION_VIEW 打开）
                var fileUri = '';
                try { fileUri = String(DC.buildDocumentUriUsingTree(tree, r.id).toString()); }
                catch (e) { if (d) d.err.push('uri:' + (e && e.message ? e.message : e)); continue; }
                if (d && !d.sampleUri) d.sampleUri = fileUri;
                if (seen[fileUri]) continue;
                seen[fileUri] = 1;
                out.push({ n: r.n, uri: fileUri });
                if (d) d.files++;
            }
        }
    }
    function diag() { return lastDiag; }

    // ---- 用 content URI 打开文件（ACTION_VIEW + 临时读授权）-----------
    function openUri(uri, name) {
        if (!available() || !uri) return false;
        try {
            var main = plus.android.runtimeMainActivity();
            var Intent = cls('android.content.Intent');
            var Uri = cls('android.net.Uri');
            var intent = new Intent(Intent.ACTION_VIEW);
            // Uri.parse 直接点方法（invoke 调静态在 K80 上返回 null）
            inv(intent, 'setDataAndType', Uri.parse(uri), mimeOf(name));
            inv(intent, 'addFlags', Intent.FLAG_GRANT_READ_URI_PERMISSION |
                                    Intent.FLAG_ACTIVITY_NEW_TASK);
            inv(main, 'startActivity', intent);
            return true;
        } catch (e) {
            toast('打开失败：' + (e && e.message ? e.message : '无可用阅读器'));
            return false;
        }
    }
    function mimeOf(name) {
        var s = String(name || '').toLowerCase();
        if (/\.pdf$/.test(s)) return 'application/pdf';
        if (/\.dwg$/.test(s)) return 'application/acad';
        if (/\.dxf$/.test(s)) return 'image/vnd.dxf';
        if (/\.(png|jpe?g|gif|bmp|tiff?|webp)$/.test(s)) return 'image/*';
        if (/\.zip$/.test(s)) return 'application/zip';
        return '*/*';
    }

    window.SafDir = {
        available: available,
        openTree: openTree,
        listTree: listTree,
        openUri: openUri,
        getRoot: getRoot,
        setRoot: setRoot,
        clearRoot: clearRoot,
        diag: diag,
        dirLabel: function () { return '系统授权目录（SAF）'; }
    };
})();
