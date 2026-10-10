# -*- coding: utf-8 -*-
"""参赛作品介绍 PDF 批次数字更新 + 三张截图替换（2026-10-10 晚间实测批次）。

图片：p3 xref6←A-adult.png  p7 xref12←A-elderly.png  p8 xref14←B-urban.png
文案：全文 10 处旧数字/措辞改为新批次实测值（26/E、无法评估、4 处、34% 等）。
"""
import fitz

SRC = "docs/submission/圈点-参赛作品介绍.pdf"
REG = "C:/Windows/Fonts/msyh.ttc"
BOLD = "C:/Windows/Fonts/msyhbd.ttc"


def rgb(color_int):
    return ((color_int >> 16 & 255) / 255, (color_int >> 8 & 255) / 255, (color_int & 255) / 255)


def find_line(page, needle):
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            full = "".join(s["text"] for s in line["spans"])
            if needle in full:
                return line, full
    raise SystemExit(f"line not found: {needle}")


def find_span(page, needle):
    spans = []
    for block in page.get_text("dict")["blocks"]:
        if block.get("type") != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                if span["text"].strip() == needle:
                    return span
                if needle in span["text"]:
                    spans.append(span)
    if spans:
        return spans[0]
    raise SystemExit(f"span not found: {needle}")


doc = fitz.open(SRC)

# ---------- 1) 图片替换 ----------
doc[2].replace_image(6, filename="docs/data/screenshots/A-adult.png")
doc[6].replace_image(12, filename="docs/data/screenshots/A-elderly.png")
doc[7].replace_image(14, filename="docs/data/screenshots/B-urban.png")

# ---------- 2) 文本修订 ----------
# (page_idx, kind, needle, new_text, fontfile)
jobs = [
    # p3 说明行
    (2, "line", "真实产品历史界面", "真实产品实测界面：地图、等时圈热力面、设施标记与右侧报告。百度地图原始署名随图保留。", REG),
    # p7 大数字标注 5→2 改 4→2
    (6, "span", "5 → 2", "4 → 2", BOLD),
    # p7 说明行
    (6, "line", "一般成人 5 处", "一般成人 4 处；老年人 2 处。", REG),
    (6, "line", "同批次历史截图对照", "同批次实测截图对照。", REG),
    (6, "line", "老年人历史实测截图", "新区 A · 老年人实测截图：26 分 / E，居住代理覆盖率无法评估，圈内可达 2 处、1 类。", REG),
    # p7 段落中的「33 分」（整行重写，避免 span 拆分错位）
    (6, "line", "综合评分都为 33 分", "人群参数改变可达范围，圈内机会随之变化。A 点成人与老年人的综合评分都为 26 分，因为综合评分与圈内机", REG),
    # p8 副标题
    (7, "line", "同批次历史结果", "新区 A 与成熟老城 B 的同批次实测结果", REG),
    # p8 表格单元格
    (7, "span", "33 / E", "26 / E", REG),
    (7, "span", "0%", "无法评估", REG),
    (7, "span", "33%", "34%", REG),
    (7, "span", "5 处", "4 处", REG),
    # p8 注释与页脚
    (7, "line", "历史服务端通道截图", "老城 B：上饶市信州区中心广场。服务端通道实测截图，统计与本页表格一致。", REG),
    (7, "line", "15:17:08", "来源：A-adult.png、A-elderly.png、B-urban.png，2026-10-10 晚间同批次服务端通道实测；正文数字与截图一致。", REG),
]

by_page = {}
for pno, kind, needle, new, font in jobs:
    by_page.setdefault(pno, []).append((kind, needle, new, font))

for pno, edits in by_page.items():
    page = doc[pno]
    inserts = []
    for kind, needle, new, font in edits:
        if kind == "line":
            line, _full = find_line(page, needle)
            rect = fitz.Rect(line["bbox"]) + (-1, -1, 1, 1)
            s0 = line["spans"][0]
            origin, size, color = s0["origin"], s0["size"], rgb(s0["color"])
        else:
            span = find_span(page, needle)
            rect = fitz.Rect(span["bbox"]) + (-0.5, -0.5, 0.5, 0.5)
            origin, size, color = span["origin"], span["size"], rgb(span["color"])
        page.add_redact_annot(rect)
        inserts.append((origin, new, size, color, font))
    page.apply_redactions(images=fitz.PDF_REDACT_IMAGE_NONE,
                          graphics=fitz.PDF_REDACT_LINE_ART_NONE)
    for origin, new, size, color, font in inserts:
        page.insert_text(fitz.Point(*origin), new, fontsize=size,
                         fontname="msyh", fontfile=font, color=color)

out = SRC + ".tmp"
doc.save(out, garbage=3, deflate=True)
doc.close()
import os
os.replace(out, SRC)
print("patched:", SRC)
