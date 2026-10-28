import pandas as pd
import json

# 读取 Excel
df = pd.read_excel('焊口数据.xlsx', sheet_name='Sheet1', dtype=str)
df = df.dropna(how='all')

def clean_num(s):
    """去掉字符串末尾的 .0"""
    if s is None:
        return ''
    s = str(s).strip()
    if s.endswith('.0'):
        return s[:-2]
    return s

def join_non_empty(parts, sep=' · '):
    """过滤空值后用分隔符拼接"""
    return sep.join([str(p).strip() for p in parts if p and str(p).strip()])

result = {}

for _, row in df.iterrows():
    图号 = str(row.get('图纸号', '') or '').strip()
    焊口编号 = str(row.get('焊缝编号', '') or '').strip()

    if not 图号 or not 焊口编号:
        continue

    管段号 = str(row.get('管段号', '') or '').strip()
    寸径 = clean_num(row.get('尺寸', ''))
    外径1 = clean_num(row.get('外径1', ''))
    厚度1 = clean_num(row.get('厚度1', ''))
    外径2 = clean_num(row.get('外径2', ''))
    厚度2 = clean_num(row.get('厚度2', ''))
    焊接日期 = str(row.get('焊接日期', '') or '').strip()
    部件1 = str(row.get('部件1', '') or '').strip()
    部件2 = str(row.get('部件2', '') or '').strip()
    焊工 = str(row.get('焊工号', '') or '').strip()
    接头形式 = str(row.get('焊接型式', '') or '').strip()
    状态 = str(row.get('状态', '') or '').strip()   # ✅ 新增：读取状态列

    # 第一行：焊口编号 · 管段号 · 寸径 · 接头形式
    line1 = join_non_empty([焊口编号, 管段号, 寸径, 接头形式])

    # 第二行：部件1 规格1 → 部件2 规格2
    part1 = join_non_empty([部件1, f"{外径1}*{厚度1}" if 外径1 and 厚度1 else ''])
    part2 = join_non_empty([部件2, f"{外径2}*{厚度2}" if 外径2 and 厚度2 else ''])
    if part1 and part2:
        line2 = f"{part1} → {part2}"
    else:
        line2 = part1 or part2

    焊口信息 = line1
    if line2:
        焊口信息 += '\n' + line2

    # 焊工信息：焊工 · 焊接日期 · 状态
    if 焊接日期 and 焊接日期.lower() not in ('nan', 'nat', 'none'):
        try:
            dt = pd.to_datetime(焊接日期)
            焊接日期 = dt.strftime('%Y-%m-%d')
        except Exception:
            焊接日期 = ''
    else:
        焊接日期 = ''

    焊工信息 = join_non_empty([焊工, 焊接日期, 状态])   # ✅ 新增：状态拼接到焊工信息

    key = f"{图号}_{焊口编号}"

    result[key] = {
        "焊口信息": 焊口信息,
        "焊工信息": 焊工信息
    }

with open('data3.json', 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False, indent=2)

print(f"✅ 生成完成，共 {len(result)} 条焊口")
