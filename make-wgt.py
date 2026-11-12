# -*- coding: utf-8 -*-
"""
生成手机 APP 的 wgt 热更新包（update.wgt）。

用法：
    python make-wgt.py                 # 版本号在当前 wgt 基础上 +1（4.0.7 -> 4.0.8）
    python make-wgt.py --version 4.1.0 # 指定版本号

做的事：
  1. 以仓库里的 index.html + drawing-mobile.js 打包
  2. manifest.json 沿用【现有 update.wgt 内】的那份（appid 才是新包的 H59116850），
     只把 version.name / version.code 提升
  3. 把旧的 update.wgt 备份到 dist/update-<旧版本号>.wgt
     （dist 已在 .gitignore 中，不会被 push.py 推上线；要回滚就从这里取回）

不做的事（发版由你自己确认）：
  - 不修改 version.json，不执行 git / push.py
  - 打包完成后，需要手动把 version.json 的 version 改成同一个版本号，再跑 push.py
"""
import argparse
import json
import os
import sys
import zipfile

try:
    sys.stdout.reconfigure(encoding='utf-8')
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(HERE, 'index.html')
ADDON = os.path.join(HERE, 'drawing-mobile.js')
GUARD = os.path.join(HERE, 'update-guard.js')
WGT = os.path.join(HERE, 'update.wgt')
DIST = os.path.join(HERE, 'dist')
VERSION_JSON = os.path.join(HERE, 'version.json')


def bump(version):
    parts = version.split('.')
    try:
        parts[-1] = str(int(parts[-1]) + 1)
        return '.'.join(parts)
    except (ValueError, IndexError):
        return version + '.1'


def code_of(version):
    nums = ''.join(c for c in version if c.isdigit())
    return int(nums) if nums else 1


def main():
    ap = argparse.ArgumentParser(description='生成 update.wgt 热更新包')
    ap.add_argument('--version', help='新版本号，如 4.0.8；默认在当前 wgt 基础上 +1')
    args = ap.parse_args()

    for f in (INDEX, ADDON, GUARD, WGT):
        if not os.path.isfile(f):
            print('缺少文件：' + f)
            return 1

    with open(INDEX, 'r', encoding='utf-8') as fp:
        index_html = fp.read()
    with open(ADDON, 'r', encoding='utf-8') as fp:
        addon_js = fp.read()
    with open(GUARD, 'r', encoding='utf-8') as fp:
        guard_js = fp.read()

    if '<script src="drawing-mobile.js"></script>' not in index_html:
        print('index.html 里没有引用 drawing-mobile.js，已中止（避免打出缺文件的包）')
        return 1
    if '<script src="update-guard.js"></script>' not in index_html:
        print('index.html 里没有引用 update-guard.js，已中止（避免打出缺文件的包）')
        return 1

    # 现有 wgt 内的 manifest 才是新包 appid（H59116850）与 4.0.7 的真实配置
    with zipfile.ZipFile(WGT, 'r') as z:
        old_manifest = json.loads(z.read('manifest.json').decode('utf-8-sig'))
        old_names = set(z.namelist())

    old_ver = old_manifest.get('version', {}).get('name', '4.0.7')
    new_ver = args.version or bump(old_ver)
    old_manifest['version'] = {'name': new_ver, 'code': code_of(new_ver)}
    manifest_bytes = json.dumps(old_manifest, ensure_ascii=False, separators=(',', ':')).encode('utf-8')

    # 保持原 wgt 的目录约定（css/ img/ js/ 空目录）
    dirs = [n for n in ('css/', 'img/', 'js/') if n in old_names]

    # 备份旧包到 dist/（.gitignore 已忽略该目录，不会被 push.py 推上线）
    if not os.path.isdir(DIST):
        os.makedirs(DIST)
    bak = os.path.join(DIST, 'update-%s.wgt' % old_ver)
    with open(WGT, 'rb') as src, open(bak, 'wb') as dst:
        dst.write(src.read())

    # wgt 内统一用 LF 行尾（与 HBuilderX 打的包一致）
    def lf(text):
        return text.replace('\r\n', '\n')

    with zipfile.ZipFile(WGT, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        z.writestr('index.html', lf(index_html).encode('utf-8'))
        z.writestr('manifest.json', manifest_bytes)
        z.writestr('drawing-mobile.js', lf(addon_js).encode('utf-8'))
        z.writestr('update-guard.js', lf(guard_js).encode('utf-8'))
        for d in dirs:
            z.writestr(d, b'')

    try:
        with open(VERSION_JSON, 'r', encoding='utf-8') as fp:
            vj = json.load(fp)
        live_ver = vj.get('version', '?')
    except Exception:
        live_ver = '?'

    size = os.path.getsize(WGT)
    print('=' * 62)
    print('  wgt 热更新包已生成：' + WGT)
    print('  大小：%.1f KB   appid：%s   版本：%s -> %s (code %d)' %
          (size / 1024.0, old_manifest.get('id', '?'), old_ver, new_ver, code_of(new_ver)))
    print('  包含：index.html / manifest.json / drawing-mobile.js / update-guard.js' +
          (''.join(' / ' + d for d in dirs)))
    print('  旧包已备份：' + bak + '（回滚就把它复制回 update.wgt）')
    print('=' * 62)
    print()
    print('  接下来【手动】两步，脚本没有替你做：')
    print('    1. 把 version.json 的 "version" 改成 "%s"' % new_ver +
          '（当前是 %s），顺手改 updateLog / updateTime' % live_ver)
    print('    2. 跑 push.py 部署；队员下次打开 APP 会自动热更新')
    print()
    print('  注意：改 version.json 那一刻就是全量生效，没有灰度。')
    print('        建议先在自己手机上验一遍再推。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
