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
    function hasAllFilesAccess() {
        try {
            if (typeof plus === 'undefined' || !plus.android) return true;
            var Env = plus.android.importClass('android.os.Environment');
            var Build = plus.android.importClass('android.os.Build');
            if (Build.VERSION.SDK_INT < 30) return true;
            return !!Env.isExternalStorageManager();
        } catch (e) { return true; }
    }
    function formKey(form) {
        var s = String(form || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        var m = s.match(/^(Z[A-Z]*\d+)[A-Z]*$/);
        return m ? m[1] : s;
    }
    // 特殊支架（SPS）：form/models 按型号归并会把 12 区 SPS-00001 和 20 区
    // SPS-00001 串成一张图，所以单独用完整支架号建 sps 映射，优先走它。
    function getSps(bracketId) {
        return (DATA.sps && DATA.sps[bracketId]) || null;
    }
    function getForm(bracketId) {
        var sp = getSps(bracketId);
        if (sp) return sp.form || '';
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
                '<button class="bf-saf" id="bfAllFiles" style="border:1px solid var(--border-light);' +
                'background:var(--bg-hover);color:var(--text-primary);border-radius:4px;' +
                'padding:4px 9px;font-size:11px;cursor:pointer;white-space:nowrap">🔓 权限</button>' +
              '</div>' +
              '<div class="bf-list" id="bfList"></div>' +
            '</div>';
        document.body.appendChild(panel);
        document.getElementById('bfClose').addEventListener('click', close);
        document.getElementById('bfAllFiles').addEventListener('click', grantAllFiles);
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
        var sp = getSps(bracketId);
        var key = sp ? bracketId : formKey(form);
        var model = sp
            ? { name: form, files: [{ file: sp.file || (bracketId + '.pdf'), page: 1 }] }
            : ((DATA.models && DATA.models[key]) || null);
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
        currentFiles = model.files;
        var metaText = document.getElementById('bfMetaText') || meta;
        metaText.textContent = '共 ' + model.files.length + ' 页 · 点击任一页打开';
        list.innerHTML = model.files.map(function (f, i) {
            var path = PDF_DIR + f.file;
            return '<div class="bf-item" data-i="' + i + '">' +
                     '<div class="bf-row1"><span class="bf-page">第 ' + (f.page || (i + 1)) + ' 页</span>' +
                       '<span style="font-size:calc(11px * var(--font-scale));color:var(--text-secondary)">点此打开 →</span></div>' +
                     '<div class="bf-name">' + esc(f.file) + '</div>' +
                     '<div class="bf-path">' + esc(path) + '</div>' +
                   '</div>';
        }).join('');
        list.scrollTop = 0;
    }

    // 「所有文件访问」权限引导：安卓 11+ 读公共目录需要这个开关，开一次永久生效。
    function grantAllFiles() {
        if (typeof plus === 'undefined' || !plus.android) { toast('请在 APP 内使用'); return; }
        if (hasAllFilesAccess()) {
            plus.nativeUI.alert('「所有文件访问」已经开启。\n\n如果打不开支架图，请确认单页 PDF 已拷进 Download/支架图/单页/。', function () {}, '权限状态');
            return;
        }
        plus.nativeUI.confirm(
            '支架图打不开通常是因为没开「所有文件访问」权限。\n\n' +
            '点「去开启」打开系统设置，把「允许访问所有文件」开关打开，再返回 APP 重试。\n' +
            '只需开一次，之后永久生效。',
            function (e) {
                if (e.index !== 0) return;
                try {
                    var main = plus.android.runtimeMainActivity();
                    var Intent = plus.android.importClass('android.content.Intent');
                    var Uri = plus.android.importClass('android.net.Uri');
                    var intent = null;
                    try {
                        intent = new Intent('android.settings.MANAGE_APP_ALL_FILES_ACCESS_PERMISSION');
                        intent.setData(Uri.parse('package:' + main.getPackageName()));
                    } catch (e1) { intent = null; }
                    if (!intent) {
                        try { intent = new Intent('android.settings.MANAGE_ALL_FILES_ACCESS_PERMISSION'); }
                        catch (e2) { intent = null; }
                    }
                    if (!intent) { toast('无法打开设置页，请到 设置→应用→权限→文件 手动开启'); return; }
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    main.startActivity(intent);
                } catch (err) {
                    toast('无法打开设置页，请到 设置→应用→权限→文件 手动开启');
                }
            },
            '开启所有文件访问', ['去开启', '取消']
        );
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
        var path = PDF_DIR + f.file;
        copyText(path);
        try {
            plus.nativeUI.alert('无法打开这个支架图页。\n\n文件：' + f.file +
                '\n位置：' + path + '\n\n路径已复制。请确认：① 已开启「所有文件访问」权限（点面板「🔓 权限」）；' +
                '② 单页 PDF 已拷进 Download/支架图/单页/；③ 已装 WPS / 系统 PDF 阅读器。',
                function () {}, '打开失败');
        } catch (e) { toast('打开失败：' + path); }
    }
    function openFile(idx) {
        var f = currentFiles[idx];
        if (!f) return;
        if (typeof plus === 'undefined' || !plus.runtime) { toast('请在 APP 内打开'); return; }
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
