/* ============================================================
 * 支架形式 -> 支架图单页 PDF（手机 APP / HBuilder 5+ 专用）
 * ------------------------------------------------------------
 * 数据来自 bracketFormData.js 内联的 window.BRACKET_FORM_DATA：
 *   form   : {支架号: 形式}  如 12600-20-SUP-00273 -> Z-RS17A
 *   models : {型号key: {name, pages, files:[{file,page}]}}
 * 单页 PDF 放手机 /storage/emulated/0/Download/支架图/单页/ 下。
 *
 * 对外：
 *   BracketForm.button(支架号)  返回仿「📐图纸」的小按钮 HTML
 *   BracketForm.open(支架号)    弹出列表面板（多页列多条，点一条打开）
 * 桌面浏览器下按钮恒不显示（和图纸一致）。
 * ============================================================ */
(function () {
    'use strict';

    var DATA = window.BRACKET_FORM_DATA || { form: {}, models: {} };
    var PDF_DIR = '/storage/emulated/0/Download/支架图/单页/';
    var panel = null;
    // SAF 系统授权目录：Mate80 等鸿蒙/高版本 Android 上硬编码公共路径被拦，
    // 由用户点选「支架图单页」文件夹，系统发 content URI，按文件名映射后打开。
    var safNameMap = null;   // { 文件名: contentUri }
    var safMapAt = 0;

    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function q(s) {
        return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }
    function isPlainBrowser() {
        if (typeof plus !== 'undefined') return false;
        var ua = navigator.userAgent || '';
        if (/Html5Plus|uni-app|DCloud|HBuilder|Android|iPhone|iPad|Mobile|wv/i.test(ua)) return false;
        return true;
    }
    function safRoot() {
        return (typeof SafDir !== 'undefined' && SafDir.getRoot) ? SafDir.getRoot('bracket') : null;
    }
    // 把授权目录里的文件名 -> content URI 建成映射（异步，结果缓存）
    function buildSafMap(cb) {
        var root = safRoot();
        if (!root || !root.uri || typeof SafDir === 'undefined') { cb(null); return; }
        if (safNameMap && Date.now() - safMapAt < 60000) { cb(safNameMap); return; }
        SafDir.listTree(root.uri, function (items) {
            safNameMap = {};
            (items || []).forEach(function (it) { safNameMap[it.n] = it.uri; });
            safMapAt = Date.now();
            cb(safNameMap);
        });
    }
    function formKey(form) {
        var s = String(form || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        var m = s.match(/^(Z[A-Z]*\d+)[A-Z]*$/);
        return m ? m[1] : s;
    }
    function getForm(bracketId) {
        return (DATA.form && DATA.form[bracketId]) || '';
    }
    function toast(msg) {
        try {
            if (typeof showToast === 'function') showToast(msg);
            else if (typeof plus !== 'undefined' && plus.nativeUI) plus.nativeUI.toast(msg);
        } catch (e) { console.log('[支架形式] ' + msg); }
    }

    // 按钮 HTML —— 与「📐图纸」同风格。onclick 里 stopPropagation 防止状态弹层跳走。
    function button(bracketId) {
        if (isPlainBrowser()) return '';
        var form = getForm(bracketId);
        if (!form) return '';
        return '<button class="bf-btn" data-bf="' + q(bracketId) + '" ' +
            'onclick="event.stopPropagation();BracketForm.open(\'' + q(bracketId) + '\')" ' +
            'style="padding:3px 9px;margin-left:6px;background:var(--bg-hover);' +
            'border:1px solid var(--border-light);border-radius:4px;font-size:11px;' +
            'color:var(--text-primary);cursor:pointer;white-space:nowrap;flex-shrink:0;">' +
            '📐 ' + esc(form) + ' →</button>';
    }

    function ensureCss() {
        if (document.getElementById('bfStyle')) return;
        var st = document.createElement('style');
        st.id = 'bfStyle';
        st.textContent = [
            '.bf-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:100000;background:rgba(0,0,0,.45)}',
            '.bf-overlay.active{display:flex;align-items:stretch;justify-content:center}',
            '.bf-panel{width:100%;max-width:520px;background:var(--bg-page);display:flex;flex-direction:column;height:100%;box-shadow:0 0 24px rgba(0,0,0,.25)}',
            '.bf-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;background:var(--bg-card);border-bottom:1px solid var(--border-light)}',
            '.bf-title{font-size:calc(17px * var(--font-scale));font-weight:600;color:var(--text-primary);word-break:break-all}',
            '.bf-x{border:0;background:transparent;color:var(--text-secondary);font-size:22px;line-height:1;padding:2px 8px;cursor:pointer}',
            '.bf-meta{padding:10px 16px;color:var(--text-secondary);font-size:calc(12px * var(--font-scale));background:var(--bg-page)}',
            '.bf-list{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:0 12px 12px}',
            '.bf-empty{padding:36px 18px;text-align:center;color:var(--text-secondary);font-size:calc(14px * var(--font-scale));line-height:1.9}',
            '.bf-item{background:var(--bg-card);border:1px solid var(--border-light);border-radius:8px;padding:12px;margin-bottom:10px;cursor:pointer}',
            '.bf-row1{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}',
            '.bf-page{font-size:calc(12px * var(--font-scale));font-weight:600;padding:2px 8px;border-radius:4px;background:var(--green-primary);color:#fff}',
            '.bf-name{font-size:calc(13px * var(--font-scale));color:var(--text-primary);word-break:break-all;line-height:1.6}',
            '.bf-path{font-size:calc(11px * var(--font-scale));color:var(--text-tertiary);word-break:break-all;margin-top:4px}'
        ].join('\n');
        document.head.appendChild(st);
    }

    function ensurePanel() {
        if (panel) return panel;
        ensureCss();
        panel = document.createElement('div');
        panel.className = 'bf-overlay';
        panel.innerHTML =
            '<div class="bf-panel">' +
              '<div class="bf-head"><div class="bf-title" id="bfTitle">📐 支架形式</div>' +
                '<button class="bf-x" id="bfClose" aria-label="关闭">✕</button></div>' +
              '<div class="bf-meta" id="bfMeta" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
                '<span id="bfMetaText" style="flex:1"></span>' +
                '<button class="bf-saf" id="bfSafDir" style="border:1px solid var(--border-light);' +
                'background:var(--bg-hover);color:var(--text-primary);border-radius:4px;' +
                'padding:4px 9px;font-size:11px;cursor:pointer;white-space:nowrap">📁 选目录</button>' +
              '</div>' +
              '<div class="bf-list" id="bfList"></div>' +
            '</div>';
        document.body.appendChild(panel);
        document.getElementById('bfClose').addEventListener('click', close);
        document.getElementById('bfSafDir').addEventListener('click', setSafDir);
        panel.addEventListener('click', function (e) { if (e.target === panel) close(); });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
        document.getElementById('bfList').addEventListener('click', function (e) {
            var el = e.target;
            while (el && el !== panel && !(el.getAttribute && el.getAttribute('data-i') != null)) el = el.parentNode;
            if (el && el.getAttribute && el.getAttribute('data-i') != null) {
                openFile(parseInt(el.getAttribute('data-i'), 10));
            }
        });
        return panel;
    }

    var currentFiles = [];

    function open(bracketId) {
        var form = getForm(bracketId);
        if (!form) { toast('该支架未登记形式'); return; }
        var key = formKey(form);
        var model = (DATA.models && DATA.models[key]) || null;
        var p = ensurePanel();
        p.classList.add('active');
        document.getElementById('bfTitle').textContent = '📐 ' + bracketId + ' · ' + form;

        var list = document.getElementById('bfList');
        var meta = document.getElementById('bfMeta');
        if (!model || !model.files || !model.files.length) {
            currentFiles = [];
            meta.textContent = '';
            list.innerHTML = '<div class="bf-empty">形式「' + esc(form) + '」没有对应的支架图页。<br>' +
                '（型号 ' + esc(key) + ' 在书签里未找到）</div>';
            return;
        }
        // 有 SAF 授权目录时先把文件名映射成 content URI，再渲染
        function paint(map) {
            if (!panel.classList.contains('active')) return;
            currentFiles = model.files;
            var metaText = document.getElementById('bfMetaText') || meta;
            var root = safRoot();
            metaText.textContent = '共 ' + model.files.length + ' 页 · 点击任一页打开' +
                (root && root.name ? '（' + root.name + '）' : '');
            var miss = 0;
            list.innerHTML = model.files.map(function (f, i) {
                var uri = map ? map[f.file] : null;
                if (map && !uri) miss++;
                var path = uri || (PDF_DIR + f.file);
                return '<div class="bf-item" data-i="' + i + '">' +
                         '<div class="bf-row1"><span class="bf-page">第 ' + (f.page || (i + 1)) + ' 页</span>' +
                           '<span style="font-size:calc(11px * var(--font-scale));color:var(--text-secondary)">点此打开 →</span></div>' +
                         '<div class="bf-name">' + esc(f.file) + '</div>' +
                         '<div class="bf-path">' + esc(path) + '</div>' +
                       '</div>';
            }).join('');
            if (map && miss) {
                metaText.textContent += ' · ' + miss + ' 页在授权目录里未找到，请确认选的是「支架图单页」文件夹';
            }
            list.scrollTop = 0;
        }
        if (safRoot()) {
            buildSafMap(paint);
        } else {
            paint(null);
        }
    }

    // 系统目录授权（SAF）：选「支架图单页」文件夹，绕开公共目录拦截
    function setSafDir() {
        if (typeof SafDir === 'undefined' || !SafDir.available()) {
            toast('当前环境不支持系统选目录'); return;
        }
        var cur = safRoot();
        var msg = '在系统文件管理器里选中【支架图单页】文件夹（里面是 Z-RS13_1.pdf 这种单页文件）。\n\n' +
                  '选完后系统永久授权，APP 从该目录读图，不再受公共目录限制。\n' +
                  (cur ? ('当前已授权：' + cur.name + '\n\n') : '');
        var buttons = cur ? ['重新选择', '取消授权', '取消'] : ['选择', '取消'];
        plus.nativeUI.confirm(msg, function (e) {
            if (e.index === 0) {
                SafDir.openTree('bracket', function (r) {
                    if (!r) { toast('未选择目录或授权失败'); return; }
                    safNameMap = null;
                    toast('已授权：' + r.name);
                    if (panel && panel.classList.contains('active')) {
                        var title = document.getElementById('bfTitle').textContent;
                        // 用当前标题里的支架号重渲染
                        var m = title.match(/^📐\s*(\S+?)\s*·/);
                        if (m) open(m[1]);
                    }
                });
            } else if (cur && e.index === 1) {
                SafDir.clearRoot('bracket');
                safNameMap = null;
                toast('已取消授权，恢复默认路径');
                if (panel && panel.classList.contains('active')) {
                    var title2 = document.getElementById('bfTitle').textContent;
                    var m2 = title2.match(/^📐\s*(\S+?)\s*·/);
                    if (m2) open(m2[1]);
                }
            }
        }, '系统选目录（支架图）', buttons);
    }

    function close() {
        if (panel) panel.classList.remove('active');
    }

    function copyText(text) {
        try {
            if (typeof plus !== 'undefined' && plus.clipboard) plus.clipboard.setData(text);
            else if (navigator.clipboard) navigator.clipboard.writeText(text);
        } catch (e) {}
    }
    function openFail(f) {
        var root = safRoot();
        var path = (root && root.name ? root.name + '/' : PDF_DIR) + f.file;
        copyText(f.file);
        try {
            plus.nativeUI.alert('无法打开这个支架图页。\n\n文件：' + f.file +
                '\n位置：' + path + '\n\n请点面板上的「📁 选目录」重新授权「支架图单页」文件夹，' +
                '或确认已装 WPS / 系统 PDF 阅读器。',
                function () {}, '打开失败');
        } catch (e) { toast('打开失败：' + path); }
    }
    function openFile(idx) {
        var f = currentFiles[idx];
        if (!f) return;
        if (typeof plus === 'undefined' || !plus.runtime) { toast('请在 APP 内打开'); return; }
        // SAF 授权：用映射到的 content URI 走 ACTION_VIEW
        var uri = safNameMap ? safNameMap[f.file] : null;
        if (uri && typeof SafDir !== 'undefined' && SafDir.openUri) {
            if (SafDir.openUri(uri, f.file)) return;
            openFail(f); return;
        }
        // SAF 已授权但这个文件没映射到，别再退回被拦截的硬编码路径（必然失败）
        if (safRoot()) { toast('授权目录里没找到 ' + f.file); return; }
        var raw = PDF_DIR + f.file;
        var candidates = [raw];
        if (raw.indexOf('file://') !== 0) candidates.push('file://' + raw);
        var i = 0;
        function next() {
            if (i >= candidates.length) { openFail(f); return; }
            var path = candidates[i++];
            try { plus.runtime.openFile(path, function () { next(); }); }
            catch (e) { next(); }
        }
        next();
    }

    window.BracketForm = {
        open: open,
        close: close,
        button: button,
        getForm: getForm,
        formKey: formKey,
        ready: function () { return !!(window.BRACKET_FORM_DATA); }
    };
})();
