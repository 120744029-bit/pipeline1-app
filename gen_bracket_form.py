# -*- coding: utf-8 -*-
"""
支架形式静态库 + 支架图单页拆分 生成脚本

输入:
  D:\\桌面\\支架形式.xlsx          两列: 支架号 / 形式(如 Z-RS17A)
  D:\\桌面\\GCC-DLM-...-04(1).pdf  自带书签的支架图 PDF

输出(本脚本所在目录 pipeline1-app/):
  bracketForm.json        {支架号: 形式}  6882 条
  bracketFormPages.json   {型号key: {name, pages, files}} + 统计
  支架图单页/*.pdf         按实际用到的型号拆出的单页(去字母、不区分a/b)

规则:
  形式去末尾字母 -> 基础型号 key (Z-RS13A/C/E -> ZRS13)
  基础型号 -> PDF书签页码(多页全收, 如 ZRS13 -> [229,230])
"""
import os
import re
import json
import collections

import fitz
import openpyxl

BASE = os.path.dirname(os.path.abspath(__file__))
XLSX = r'D:\桌面\支架形式.xlsx'
PDF = r'D:\桌面\GCC-DLM-DDD-00000-00-0000-TKM-DWG-00001-04(1).pdf'
OUT_DIR = os.path.join(BASE, '支架图单页')


def b_suffix(name):
    """从书签一级标题取 Z-XXX-N 后缀, 如 ..._Z-RS-13 -> (ZRS13, Z-RS13)"""
    m = re.search(r'_(Z-[A-Z]+-\d+[a-z]?)$', name, re.I)
    if not m:
        return None, None
    s = m.group(1).upper()
    key = re.sub(r'[^A-Z0-9]', '', s)          # ZRS13
    readable = re.sub(r'-(?=\d)', '', s)       # Z-RS13
    return key, readable


def f_key(form):
    """形式 -> 基础型号 key: Z-RS17A -> ZRS17"""
    s = re.sub(r'[^A-Z0-9]', '', form.upper())
    m = re.match(r'^(Z[A-Z]*\d+)[A-Z]*$', s)
    return m.group(1) if m else s


def main():
    # 1. 读形式表
    wb = openpyxl.load_workbook(XLSX, read_only=True, data_only=True)
    ws = wb['Sheet1']
    form_map = {}
    for r in ws.iter_rows(values_only=True):
        if r and r[0] and r[1]:
            form_map[str(r[0]).strip()] = str(r[1]).strip()
    wb.close()
    print('形式表: %d 条支架, %d 种形式' % (len(form_map), len(set(form_map.values()))))

    # 2. 读 PDF 书签 -> 基础型号到页码/可读名
    doc = fitz.open(PDF)
    bookmarks = [(t[1], t[2]) for t in doc.get_toc()
                 if t[0] == 1 and t[1] not in ('Cover', 'Drawing List')]
    pages_by_key = collections.defaultdict(set)
    name_by_key = {}
    for n, p in bookmarks:
        key, readable = b_suffix(n)
        if not key:
            continue
        pages_by_key[key].add(p)
        name_by_key.setdefault(key, readable)
    print('书签: %d 个一级型号' % len(bookmarks))

    # 3. 收集实际用到的型号
    used_keys = set(f_key(f) for f in form_map.values())
    missing = sorted(k for k in used_keys if k not in pages_by_key)
    if missing:
        print('!! 未匹配书签的型号:', missing)
    else:
        print('型号匹配: %d/%d 全部命中' % (len(used_keys), len(used_keys)))

    # 4. 拆单页
    os.makedirs(OUT_DIR, exist_ok=True)
    # 清理旧的拆页(只删本脚本生成的 .pdf, 不动其它文件)
    for fn in os.listdir(OUT_DIR):
        if fn.lower().endswith('.pdf'):
            os.remove(os.path.join(OUT_DIR, fn))

    manifest = {}
    total_pages = 0
    for key in sorted(used_keys):
        pages = sorted(pages_by_key.get(key, []))
        name = name_by_key.get(key, key)
        files = []
        for idx, p in enumerate(pages, 1):
            fn = '%s_%d.pdf' % (name, idx)
            one = fitz.open()
            one.insert_pdf(doc, from_page=p - 1, to_page=p - 1)
            one.save(os.path.join(OUT_DIR, fn), garbage=4, deflate=True)
            one.close()
            files.append({'file': fn, 'page': p})
            total_pages += 1
        manifest[key] = {'name': name, 'pages': pages, 'files': files}
    doc.close()
    print('拆单页: %d 个型号 -> %d 个 PDF -> %s' % (len(manifest), total_pages, OUT_DIR))

    # 5. 写 json
    with open(os.path.join(BASE, 'bracketForm.json'), 'w', encoding='utf-8') as fp:
        json.dump(form_map, fp, ensure_ascii=False, separators=(',', ':'))
    payload = {
        'version': 1,
        'source': str(XLSX),
        'pdf': str(PDF),
        'countBrackets': len(form_map),
        'countModels': len(used_keys),
        'countPages': total_pages,
        'models': manifest,
    }
    with open(os.path.join(BASE, 'bracketFormPages.json'), 'w', encoding='utf-8') as fp:
        json.dump(payload, fp, ensure_ascii=False, indent=1)

    # 内联数据到 js（APP 走 file://，fetch 本地 json 不稳，直接全局变量最可靠）
    inline = ('// 由 gen_bracket_form.py 自动生成，请勿手改\n'
              'window.BRACKET_FORM_DATA = {\n'
              '  form: ' + json.dumps(form_map, ensure_ascii=False, separators=(',', ':')) + ',\n'
              '  models: ' + json.dumps(manifest, ensure_ascii=False, separators=(',', ':')) + '\n'
              '};\n')
    with open(os.path.join(BASE, 'bracketFormData.js'), 'w', encoding='utf-8') as fp:
        fp.write(inline)
    print('内联数据: bracketFormData.js (%.0f KB)' %
          (os.path.getsize(os.path.join(BASE, 'bracketFormData.js')) / 1024.0))

    size = sum(os.path.getsize(os.path.join(OUT_DIR, f))
               for f in os.listdir(OUT_DIR) if f.lower().endswith('.pdf'))
    print('单页总大小: %.1f MB' % (size / 1048576.0))
    print('生成完成: bracketForm.json / bracketFormPages.json / bracketFormData.js')


if __name__ == '__main__':
    main()
