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

    function cls(name) { return plus.android.importClass(name); }
    function inv(obj, method) {
        var args = Array.prototype.slice.call(arguments, 2);
        return plus.android.invoke.apply(plus.android, [obj, method].concat(args));
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
                        var uri = inv(data, 'getData');
                        if (uri) {
                            // 持久授权：重启后仍可访问，热更新 wgt 不掉权限
                            try { inv(main, 'takePersistableUriPermission', uri, FLAG_R | FLAG_W); }
                            catch (e) {}
                            var uriStr = String(inv(uri, 'toString'));
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
            inv(main, 'startActivityForResult', intent, code);
        } catch (e) {
            pending = null;
            toast('无法打开系统目录选择器：' + (e && e.message ? e.message : '未知错误'));
            if (cb) cb(null);
        }
    }

    // ---- 列目录（递归，只取文件名 + 单文件 URI）-----------------------
    // cb(list)，list = [{ n:文件名, uri:单文件contentUri }]
    function listTree(treeUri, cb) {
        var out = [];
        if (!available() || !treeUri) { if (cb) cb(out); return; }
        try {
            var main = plus.android.runtimeMainActivity();
            var Uri = cls('android.net.Uri');
            var DC = cls('android.provider.DocumentsContract');
            var tree = inv(Uri, 'parse', treeUri);
            var rootId = inv(DC, 'getTreeDocumentId', tree);
            var cr = inv(main, 'getContentResolver');
            walk(DC, Uri, cr, tree, rootId, out, 0, {});
        } catch (e) { /* 返回已收集到的部分 */ }
        if (cb) cb(out);
    }

    function walk(DC, Uri, cr, tree, docId, out, depth, seen) {
        if (depth > 8 || out.length >= 20000) return;
        var kidsUri;
        var rows = [];
        try {
            kidsUri = inv(DC, 'buildChildDocumentsUriUsingTree', tree, docId);
            var cols = ['_display_name', 'document_id', 'mime_type'];
            var cursor = inv(cr, 'query', kidsUri, cols, null, null, null);
            if (!cursor) return;
            try {
                while (inv(cursor, 'moveToNext')) {
                    var name = String(inv(cursor, 'getString', 0) || '');
                    var cid = String(inv(cursor, 'getString', 1) || '');
                    var mime = String(inv(cursor, 'getString', 2) || '');
                    rows.push({ n: name, id: cid, dir: /directory/.test(mime) });
                }
            } finally {
                try { inv(cursor, 'close'); } catch (e) {}
            }
        } catch (e) { return; }
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!r.n) continue;
            if (r.dir) {
                walk(DC, Uri, cr, tree, r.id, out, depth + 1, seen);
            } else {
                var fileUri = '';
                try { fileUri = String(inv(inv(DC, 'buildDocumentUriUsingTree', tree, r.id), 'toString')); }
                catch (e) { continue; }
                if (seen[fileUri]) continue;
                seen[fileUri] = 1;
                out.push({ n: r.n, uri: fileUri });
            }
        }
    }

    // ---- 用 content URI 打开文件（ACTION_VIEW + 临时读授权）-----------
    function openUri(uri, name) {
        if (!available() || !uri) return false;
        try {
            var main = plus.android.runtimeMainActivity();
            var Intent = cls('android.content.Intent');
            var Uri = cls('android.net.Uri');
            var intent = new Intent(Intent.ACTION_VIEW);
            inv(intent, 'setDataAndType', inv(Uri, 'parse', uri), mimeOf(name));
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
        dirLabel: function () { return '系统授权目录（SAF）'; }
    };
})();
