# -*- coding: utf-8 -*-
"""参赛作品介绍 PDF 原位补丁 v2：行锚定 + ASCII 用 helv + 整行 bbox redact + 左对齐选项。"""
import fitz, json, datetime, sys, re

SRC = r'C:\Users\ngh\Desktop\圈点-参赛材料-晓晓配音-20261012\圈点-参赛作品介绍-20261012.pdf'
DST = r'C:\Users\ngh\Desktop\圈点-参赛材料-晓晓配音-20261012\圈点-参赛作品介绍-20261013.pdf'
BATCH = 'docs/data/batches/2026-10-13.json'

d = json.load(open(BATCH, encoding='utf-8'))
def bj(iso):
    t = datetime.datetime.fromisoformat(iso.replace('Z', '+00:00')) + datetime.timedelta(hours=8)
    return t.strftime('%H:%M:%S')
runs = d['runs']
fp = runs['A-adult']['report']['provenance']['ruleFingerprint']
VSTAMP = '2026-10-13  |  Unified 0ad03a7'

def is_ascii(s):
    return all(ord(c) < 128 for c in s)

def font_for(s):
    return 'helv' if is_ascii(s) else 'china-s'

def draw(page, rect, text, size, color, align='center', pad=0.18):
    font = font_for(text)
    try:
        w = fitz.get_text_length(text, fontname=font, fontsize=size)
    except Exception:
        w = size * len(text) * 0.6
    x = (rect.x0 + rect.x1) / 2 - w / 2 if align == 'center' else rect.x0
    page.insert_text((x, rect.y1 - size * pad), text, fontname=font, fontsize=size,
                     color=((color >> 16 & 255) / 255, (color >> 8 & 255) / 255, (color & 255) / 255))

def spans(page):
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines', []):
            for sp in line['spans']:
                yield sp

def replace_span(page, sp, new, align='center'):
    r = fitz.Rect(sp['bbox'])
    page.add_redact_annot(r)
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE)
    draw(page, r, new, sp['size'], sp['color'], align)

def find_span(page, text, y=None, tol=6):
    for sp in spans(page):
        if sp['text'].strip() == text.strip() and (y is None or abs((sp['bbox'][1] + sp['bbox'][3]) / 2 - y) < tol):
            return sp
    return None

doc = fitz.open(SRC)
p7, p8 = doc[6], doc[7]
ok = True

# ── p7 表格：以旧时间列为行锚，行内替换 分数/等级 与 住宅覆盖 ──
ROWS = [
    ('05:59:01', bj(runs['B-adult']['report']['generatedAt']),   '76 / B', '69 / C', '无法评估', '40.7%'),
    ('05:59:03', bj(runs['B-elderly']['report']['generatedAt']), '76 / B', '64 / C', '无法评估', '13.9%'),
    ('06:03:31', bj(runs['C-adult']['report']['generatedAt']),   '70 / C', '59 / D', '无法评估', '14.4%'),
    ('06:03:32', bj(runs['C-elderly']['report']['generatedAt']), '70 / C', '56 / D', '无法评估', '0%'),
]
for old_t, new_t, old_s, new_s, old_c, new_c in ROWS:
    anchor = find_span(p7, old_t)
    if not anchor:
        print('未找到行锚', old_t); ok = False; continue
    y = (anchor['bbox'][1] + anchor['bbox'][3]) / 2
    for old, new in ((old_s, new_s), (old_c, new_c)):
        sp = find_span(p7, old, y=y)
        if sp:
            replace_span(p7, sp, new)
        else:
            print(f'行 {old_t}: 未找到 {old}'); ok = False
    replace_span(p7, anchor, new_t)

# ── p7 整行段落重写（redact 整行 bbox：该行全部 spans 的并集）──
def draw_mixed(page, rect, text, size, color, avail_right):
    groups = re.findall(r'[ -~]+|[^-]+', text)
    def total_w(sz):
        return sum(fitz.get_text_length(g, fontname=('helv' if is_ascii(g) else 'china-s'), fontsize=sz) for g in groups)
    while size > 7.0 and rect.x0 + total_w(size) > avail_right:
        size -= 0.4
    x = rect.x0
    for g in groups:
        fname = 'helv' if is_ascii(g) else 'china-s'
        page.insert_text((x, rect.y1 - size * 0.18), g, fontname=fname, fontsize=size, color=color)
        x += fitz.get_text_length(g, fontname=fname, fontsize=size)
    return rect.x0 + total_w(size) <= avail_right + 2


def rewrite_line(page, first_chars, new):
    for block in page.get_text('dict')['blocks']:
        for line in block.get('lines', []):
            text = ''.join(sp['text'] for sp in line['spans'])
            if text.strip().startswith(first_chars):
                r = fitz.Rect(line['bbox'])
                page.add_redact_annot(r)
                page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE, graphics=fitz.PDF_REDACT_LINE_ART_NONE)
                sp = line['spans'][0]
                color = ((sp['color'] >> 16 & 255) / 255, (sp['color'] >> 8 & 255) / 255, (sp['color'] & 255) / 255)
                draw_mixed(page, r, new, sp['size'], color, avail_right=838)
                return True
    return False

ok &= rewrite_line(p7, '老城成人超市已取',
    '本批超市与住宅检索均已取尽上游结果（老城超市 89/89），覆盖率按住宅口径如实计入评分；')
ok &= rewrite_line(p7, '无法评估，材料不从这些记录',
    '不完整时仍标「无法评估」，不推造百分比（见上页回放）。')
ok &= rewrite_line(p7, '文件：docs/data/batches/2026-10-11.json',
    '文件：docs/data/batches/2026-10-13.json（generatedAt 为 UTC 口径）')
ok &= rewrite_line(p7, '2026-10-12。报告规则指纹为',
    f'2026-10-13。报告规则指纹为 {fp}；每份记录的 reportId 和采集时间保留在随材料的来源清单。')

# ── p8 两个分数标注：左对齐（与卡片内上一行对齐）──
for old, new in (('综合评分 76 / B', '综合评分 69 / C'), ('综合评分仍为 76 / B', '综合评分 64 / C')):
    sp = find_span(p8, old)
    if sp:
        replace_span(p8, sp, new, align='left')
    else:
        print('p8 未找到', old); ok = False

# ── 16 页页脚 ──
foot = 0
for page in doc:
    sp = find_span(page, '2026-10-12  \xa0|\xa0  Web e6253a7 / Core f013918') \
         or next((s for s in spans(page) if 'e6253a7' in s['text'] and 'f013918' in s['text']), None)
    if sp:
        replace_span(page, sp, VSTAMP)
        foot += 1
print(f'页脚 {foot}/16')
ok &= foot == 16

doc.subset_fonts()
doc.save(DST, garbage=4, deflate=True)
print('OK' if ok else 'HAS-MISSES', '→', DST)
sys.exit(0 if ok else 2)
