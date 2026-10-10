# -*- coding: utf-8 -*-
"""渲染封面并合并为最终 PDF"""
import sys, os, json

PDF_SKILL_DIR = r"C:\Users\ngh\.zcode\cli\plugins\cache\zcode-plugins-official\pdf\0.1.7\skills\pdf"
sys.path.insert(0, os.path.join(PDF_SKILL_DIR, "scripts"))

from cover_render import render_cover
from pypdf import PdfReader, PdfWriter, Transformation

palette = {
    "primary": "#765c4f",
    "secondary": "#c62540",
    "text": "#201e1d",
    "muted": "#8d8784",
    "bg": "#ffffff",
}
content = json.load(open("cover_content.json", encoding="utf-8"))
render_cover("03", content, "cover.pdf", palette=palette)
print("cover.pdf rendered")

A4_W, A4_H = 595.28, 841.89

def normalize(page):
    box = page.mediabox
    w, h = float(box.width), float(box.height)
    if abs(w - A4_W) > 2 or abs(h - A4_H) > 2:
        page.add_transformation(Transformation().scale(sx=A4_W / w, sy=A4_H / h))
        page.mediabox.lower_left = (0, 0)
        page.mediabox.upper_right = (A4_W, A4_H)
    return page

writer = PdfWriter()
writer.add_page(normalize(PdfReader("cover.pdf").pages[0]))
for page in PdfReader("body.pdf").pages:
    writer.add_page(normalize(page))
writer.add_metadata({
    "/Title": "圈点——15分钟生活圈智能体检与规划助手 作品介绍文档",
    "/Author": "圈点项目团队",
    "/Creator": "圈点项目团队",
    "/Subject": "开源 AI 工具赛道参赛作品介绍",
})
with open("../作品介绍文档.pdf", "wb") as f:
    writer.write(f)
print("final merged: docs/作品介绍文档.pdf")
