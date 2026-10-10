# -*- coding: utf-8 -*-
"""圈点——15分钟生活圈智能体检与规划助手 · 作品介绍文档（正文生成）"""
import sys, os, hashlib

PDF_SKILL_DIR = r"C:\Users\ngh\.zcode\cli\plugins\cache\zcode-plugins-official\pdf\0.1.7\skills\pdf"
sys.path.insert(0, os.path.join(PDF_SKILL_DIR, "scripts"))

from reportlab.lib.pagesizes import A4
from reportlab.lib.units import cm
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_LEFT, TA_CENTER
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, PageBreak, Table, TableStyle,
    Image, KeepTogether, HRFlowable, CondPageBreak
)
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.pdfmetrics import registerFontFamily
from PIL import Image as PILImage

# ---------------- 字体（Windows 宿主字体） ----------------
WIN_FONTS = r"C:\Windows\Fonts"

def _reg(name, path, index=0):
    pdfmetrics.registerFont(TTFont(name, path, subfontIndex=index))

_head_ok = True
try:
    _reg("Microsoft YaHei", WIN_FONTS + r"\msyh.ttc", 0)
except Exception:
    _head_ok = False
_reg("SimHei", WIN_FONTS + r"\simhei.ttf")
_reg("Times New Roman", WIN_FONTS + r"\times.ttf")
HEAD_FONT = "Microsoft YaHei" if _head_ok else "SimHei"
BODY_FONT = "SimHei"
NUM_FONT = "Times New Roman"

registerFontFamily(HEAD_FONT, normal=HEAD_FONT, bold=HEAD_FONT)
registerFontFamily("SimHei", normal="SimHei", bold="SimHei")
registerFontFamily("Times New Roman", normal="Times New Roman", bold="Times New Roman")

from pdf import install_font_fallback
install_font_fallback()

# ---------------- 调色板（palette.cascade 生成，禁止手改） ----------------
PAGE_BG       = colors.HexColor('#f1f0f0')
CARD_BG       = colors.HexColor('#efecea')
TABLE_STRIPE  = colors.HexColor('#ebeae9')
HEADER_FILL   = colors.HexColor('#765c4f')
BORDER        = colors.HexColor('#d2cac5')
ACCENT        = colors.HexColor('#c62540')
ACCENT_2      = colors.HexColor('#38a5ae')
TEXT_PRIMARY  = colors.HexColor('#201e1d')
TEXT_MUTED    = colors.HexColor('#8d8784')

TABLE_HEADER_COLOR = HEADER_FILL
TABLE_HEADER_TEXT  = colors.white
TABLE_ROW_EVEN     = colors.white
TABLE_ROW_ODD      = TABLE_STRIPE

# ---------------- 版式 ----------------
PAGE_W, PAGE_H = A4
LM = RM = 2.0 * cm
TM, BM = 2.2 * cm, 2.0 * cm
AVAIL_W = PAGE_W - LM - RM

h1_style = ParagraphStyle('H1', fontName=HEAD_FONT, fontSize=18, leading=26,
                          textColor=TEXT_PRIMARY, spaceBefore=18, spaceAfter=4, wordWrap='CJK')
h2_style = ParagraphStyle('H2', fontName=HEAD_FONT, fontSize=14, leading=20,
                          textColor=HEADER_FILL, spaceBefore=14, spaceAfter=6, wordWrap='CJK')
h3_style = ParagraphStyle('H3', fontName=HEAD_FONT, fontSize=11.5, leading=16,
                          textColor=TEXT_PRIMARY, spaceBefore=10, spaceAfter=4, wordWrap='CJK')
body_style = ParagraphStyle('Body', fontName=BODY_FONT, fontSize=10.5, leading=17,
                            textColor=TEXT_PRIMARY, alignment=TA_LEFT,
                            firstLineIndent=21, spaceAfter=8, wordWrap='CJK')
body_ni_style = ParagraphStyle('BodyNI', parent=body_style, firstLineIndent=0)
bullet_style = ParagraphStyle('Bullet', fontName=BODY_FONT, fontSize=10.5, leading=17,
                              textColor=TEXT_PRIMARY, leftIndent=14, spaceAfter=4, wordWrap='CJK')
caption_style = ParagraphStyle('Caption', fontName=BODY_FONT, fontSize=8.5, leading=12,
                               textColor=TEXT_MUTED, alignment=TA_CENTER, spaceBefore=3, spaceAfter=6)
toc_title_style = ParagraphStyle('TocTitle', fontName=HEAD_FONT, fontSize=18, leading=26,
                                 textColor=TEXT_PRIMARY, spaceAfter=12, wordWrap='CJK')

th_style = ParagraphStyle('TH', fontName=BODY_FONT, fontSize=9.5, leading=13,
                          textColor=colors.white, alignment=TA_CENTER, wordWrap='CJK')
td_style = ParagraphStyle('TD', fontName=BODY_FONT, fontSize=9.5, leading=13,
                          textColor=TEXT_PRIMARY, alignment=TA_LEFT, wordWrap='CJK')
td_c_style = ParagraphStyle('TDC', parent=td_style, alignment=TA_CENTER)

stat_style = ParagraphStyle('StatBig', fontName=HEAD_FONT, fontSize=20, leading=24,
                            textColor=ACCENT, alignment=TA_CENTER)
stat_label_style = ParagraphStyle('StatLabel', fontName=BODY_FONT, fontSize=9, leading=12,
                                  textColor=TEXT_MUTED, alignment=TA_CENTER, wordWrap='CJK')

# ---------------- TOC 文档模板 ----------------
class TocDocTemplate(SimpleDocTemplate):
    def afterFlowable(self, flowable):
        if hasattr(flowable, 'bookmark_name'):
            level = getattr(flowable, 'bookmark_level', 0)
            text = getattr(flowable, 'bookmark_text', '')
            key = getattr(flowable, 'bookmark_key', '')
            self.notify('TOCEntry', (level, text, self.page, key))

def heading(text, style, level=0):
    key = 'h_%s' % hashlib.md5(text.encode()).hexdigest()[:8]
    p = Paragraph('<a name="%s"/><b>%s</b>' % (key, text), style)
    p.bookmark_name = text
    p.bookmark_level = level
    p.bookmark_text = text
    p.bookmark_key = key
    return p

AVAIL_H = PAGE_H - TM - BM
H1_ORPHAN = AVAIL_H * 0.15

def h1(story, text):
    story.append(CondPageBreak(H1_ORPHAN))
    story.append(heading(text, h1_style, 0))
    story.append(HRFlowable(width='100%', thickness=1.2, color=HEADER_FILL, spaceBefore=0, spaceAfter=10))

def h2(story, text):
    story.append(CondPageBreak(AVAIL_H * 0.10))
    story.append(heading(text, h2_style, 1))

def para(story, text, style=None):
    story.append(Paragraph(text, style or body_style))

def bullets(story, items):
    for it in items:
        story.append(Paragraph('• ' + it, bullet_style))
    story.append(Spacer(1, 4))

def embed_image(path, max_width=None, max_height=None):
    if max_width is None:
        max_width = AVAIL_W
    if max_height is None:
        max_height = PAGE_H * 0.34
    img = PILImage.open(path)
    w, h = img.size
    rw = max_width / w if w > max_width else 1.0
    rh = max_height / h if h > max_height else 1.0
    ratio = min(rw, rh)
    return Image(path, width=w * ratio, height=h * ratio)

def make_table(headers, rows, ratios, style_extra=None):
    widths = [r * AVAIL_W for r in ratios]
    data = [[Paragraph('<b>%s</b>' % h, th_style) for h in headers]]
    for row in rows:
        data.append([Paragraph(str(c), td_style) for c in row])
    t = Table(data, colWidths=widths, hAlign='CENTER', repeatRows=1)
    style = [
        ('BACKGROUND', (0, 0), (-1, 0), TABLE_HEADER_COLOR),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('GRID', (0, 0), (-1, -1), 0.5, BORDER),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]
    for i in range(1, len(data)):
        style.append(('BACKGROUND', (0, i), (-1, i), TABLE_ROW_EVEN if i % 2 == 1 else TABLE_ROW_ODD))
    if style_extra:
        style.extend(style_extra)
    t.setStyle(TableStyle(style))
    return t

def callout_row(items):
    """items: [(big, label), ...] → 并排指标卡"""
    n = len(items)
    w = (AVAIL_W - (n - 1) * 12) / n
    cells = []
    for big, label in items:
        inner = Table(
            [[Paragraph('<b>%s</b>' % big, stat_style)],
             [Paragraph(label, stat_label_style)]],
            colWidths=[w])
        inner.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), CARD_BG),
            ('BOX', (0, 0), (-1, -1), 0.8, HEADER_FILL),
            ('TOPPADDING', (0, 0), (-1, 0), 8),
            ('BOTTOMPADDING', (0, -1), (-1, -1), 8),
            ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ]))
        cells.append(inner)
    row = Table([cells], colWidths=[w + (12 if i < n - 1 else 0) for i in range(n)], hAlign='CENTER')
    row.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 0),
        ('RIGHTPADDING', (0, 0), (-1, -1), 0),
    ]))
    return row

# ---------------- 页眉页脚 ----------------
def on_page(canvas, doc):
    canvas.saveState()
    canvas.setFont(BODY_FONT, 7.5)
    canvas.setFillColor(TEXT_MUTED)
    canvas.drawString(LM, PAGE_H - 1.2 * cm, '圈点——15分钟生活圈智能体检与规划助手 · 作品介绍文档')
    canvas.setStrokeColor(HEADER_FILL)
    canvas.setLineWidth(1.2)
    canvas.line(LM, PAGE_H - 1.35 * cm, PAGE_W - RM, PAGE_H - 1.35 * cm)
    canvas.drawString(LM, 1.1 * cm, '开源 AI 工具赛道参赛作品')
    canvas.drawRightString(PAGE_W - RM, 1.1 * cm, '第 %d 页' % doc.page)
    canvas.restoreState()

# ---------------- 正文 ----------------
doc = TocDocTemplate(
    'body.pdf', pagesize=A4,
    leftMargin=LM, rightMargin=RM, topMargin=TM, bottomMargin=BM,
    title='圈点——15分钟生活圈智能体检与规划助手 作品介绍文档',
    author='圈点项目团队', creator='圈点项目团队',
    subject='开源 AI 工具赛道参赛作品介绍',
)

story = []

# ---- 目录 ----
story.append(Paragraph('<b>目 录</b>', toc_title_style))
toc = TableOfContents()
toc.levelStyles = [
    ParagraphStyle('TOC1', fontName=HEAD_FONT, fontSize=11.5, leading=20, leftIndent=12, textColor=TEXT_PRIMARY),
    ParagraphStyle('TOC2', fontName=BODY_FONT, fontSize=10, leading=16, leftIndent=32, textColor=TEXT_PRIMARY),
]
story.append(toc)
story.append(PageBreak())

# ---- 一、项目背景与痛点 ----
h1(story, '一、项目背景与痛点')
para(story, '近年来国家大力推进「15 分钟便民生活圈」建设：商务部等 12 部门联合推动城市一刻钟便民'
            '生活圈三年行动，住建部发布《完整居住社区建设标准（试行）》，自然资源部发布《社区生活圈'
            '规划技术指南》（TD/T 1062-2021），要求居民在步行 15 分钟范围内能够获得基础医疗、教育、'
            '购物、养老等服务。生活圈建设质量已成为衡量城市人居环境与基层治理水平的核心指标。')
para(story, '然而当前社区配套评估普遍存在三重痛点：')
bullets(story, [
    '<b>靠人普查，成本高、更新慢</b>——传统评估依赖人工上门普查与静态台账，一个街道的设施摸底'
    '往往需要数周，数据落到 paper 上就开始过时；',
    '<b>直线距离不等于真实可达</b>——道路并非直线，红绿灯、过街天桥、河流与铁路的阻隔、施工围挡'
    '都会显著改变实际步行范围，「图上 800 米、走路 20 分钟」是常态；',
    '<b>只有诊断、没有处方</b>——即便发现「缺菜市场」，传统报告也回答不了「应该在哪补、补了能'
    '惠及多少人」这一规划者最关心的问题。',
])
story.append(Spacer(1, 6))
story.append(callout_row([
    ('15 分钟', '国家便民生活圈建设目标（步行可达）'),
    ('1200 米', '成人 15 分钟步行直线半径（80m/min）'),
    ('3 类', '评分细则核心设施：菜市场/药店/小学'),
]))
story.append(Spacer(1, 8))

# ---- 二、产品设计与核心功能 ----
h1(story, '二、产品设计与核心功能')
para(story, '「圈点」是一款基于百度地图开放能力的 15 分钟生活圈智能体检与规划助手（Web 应用）。'
            '用户输入任意中心点坐标或地址，系统即可自动完成「真实路网等时圈计算 → 民生设施覆盖体检 → '
            '灰色区域标注 → 补点选址规划」的完整闭环，输出可视化体检报告。')
h2(story, '2.1 核心功能一览')
story.append(make_table(
    ['功能', '说明'],
    [
        ['真实路网等时圈', '48 向扇形采样 + 批量距离矩阵，计算各方向真实步行可达半径，输出 5/10/15 分钟三层等时环'],
        ['步行时间热力面', '120m 网格连续「步行分钟」场，渲染为平滑热力面，直观呈现圈内任一位置的可达成本'],
        ['人群差异化体检', '一般成人 / 老年人 / 儿童三档步行速度（80/52/65 m/min），同一社区不同人群结论不同'],
        ['灰色区域识别', '菜市场/药店/小学 1km 口径盲区判定，住宅小区密度作人口代理加权，连通斑块上图'],
        ['国标对标清单', '对照《完整居住社区建设标准》等通行口径逐项判定，输出达标/缺失清单'],
        ['补点规划工作台', '贪心最大覆盖求解补点位置与类别，量化覆盖率提升；支持逐条采纳/跳过并实时重算'],
        ['街道级批量体检', '输入街道名，自动采样片区内住宅小区逐个体检，45 秒产出街道排名与薄弱点'],
        ['开放分析 API', 'POST /api/analyze 单点体检、POST /api/batch/street 街道批量，附 OpenAPI 文档'],
    ],
    [0.24, 0.76]
))
story.append(Spacer(1, 6))
story.append(Paragraph('表 1　核心功能清单', caption_style))

h2(story, '2.2 产品实拍')
story.append(embed_image('../data/screenshots/A-adult.png', max_height=250))
story.append(Paragraph('图 1　样例 A（新校区·成人视角）：热力面 + 三层等时环 + 灰色区域标注 + 体检报告', caption_style))
story.append(Spacer(1, 6))
story.append(embed_image('../data/screenshots/B-urban.png', max_height=250))
story.append(Paragraph('图 2　样例 B（老城核心对照）：设施齐备，C 级 68 分，验证系统区分度', caption_style))

# ---- 三、技术架构 ----
h1(story, '三、技术架构')
para(story, '系统采用「前后端同构引擎 + 轻量服务端」架构：核心算法以 TypeScript 实现于 shared/ 目录，'
            '前端渲染与单元测试共用同一套实现，避免行为漂移；服务端仅承担 AK 代理、缓存限流与批量任务调度，'
            '故障时前端可独立降级运行。')
story.append(make_table(
    ['层次', '技术选型', '职责'],
    [
        ['前端', 'Vite + TypeScript + 百度地图 GL JS API + ECharts', '地图渲染、热力面贴地、报告面板、通道编排'],
        ['共享引擎 shared/', 'TypeScript（前后端同构）', '等时圈模型、时间场插值、盲区识别、评分、选址规划'],
        ['服务端', 'Node.js + Express', 'AK 代理（密钥不出后端）、TTL 缓存、令牌桶限流、批量任务调度'],
        ['数据通道', '三级降级：服务端代理 → 浏览器直连（GL SDK）→ 确定性合成', '通道独立熔断，配额耗尽演示不中断'],
        ['基础设施', 'Docker · GitHub Actions · vitest', '一键部署、CI 自动化（类型检查+测试+构建）'],
    ],
    [0.18, 0.40, 0.42]
))
story.append(Spacer(1, 6))
story.append(Paragraph('表 2　技术架构分层', caption_style))
para(story, '地图能力全部来自百度地图开放平台：地理编码 v3、逆地理编码 v3、POI 兴趣点检索（place v2）、'
            '批量算路（routematrix v2）、步行路径规划（direction v2）与 GL JS API 底图渲染。'
            '服务端对全部上游调用实施令牌桶限流（2 QPS，贴合个人证书并发上限）、TTL 缓存'
            '（算路 24h / POI 6h）与瞬态错误自动重试，重复分析近乎零配额消耗。')

# ---- 四、核心算法设计 ----
h1(story, '四、核心算法设计')
h2(story, '4.1 真实路网等时圈：扇形采样 + 方向插值')
para(story, '以中心点为原点，沿 48 个均匀方向发射探针至直线距离 t·v 处（v 为人群步行速度），'
            '通过百度批量算路接口一次获得各方向真实路网步行距离，据此定义方向绕行系数 '
            'f(θ) = 路网距离 / 直线距离；假设同一方向绕行系数近似恒定，则该方向 t 分钟可达'
            '直线半径 R(θ) = t·v / f(θ)。相邻方向线性插值并圆滑，失败方向由道路网格谐波模型'
            '合成兜底，保证结果永不中断。')
h2(story, '4.2 连续步行时间场与等时环')
para(story, '将解析模型插值到 120m 步长网格，得到任意格点的步行时间估计 t(x,y) = d(x,y)·f(θ)/v，'
            '再用 marching squares 算法提取 5/10/15 分钟等值线并链接为矢量等时环，'
            '同时把整场渲染为平滑热力面——对应评分细则中「等时圈热力图」与「创新空间插值」两项要求。')
h2(story, '4.3 人口加权盲区识别')
para(story, '以住宅小区 POI 密度作为人口代理在网格上累积居住权重（仅在 15 分钟步行圈内统计）；'
            '对菜市场、药店、小学三个核心类别分别以每处设施为圆心、1km 为半径（评分细则口径）'
            '栅格化服务覆盖盘；缺失 ≥2 项核心设施的连通区域聚合为灰色斑块，按居住权重排序上图。'
            '该机制从原理上抑制了「把公园绿地误报为盲区」的常见误报。')
h2(story, '4.4 四维加权评分')
story.append(make_table(
    ['维度', '权重', '口径'],
    [
        ['完整度', '30%', '10 类民生设施实际数量 / 理想阈值（类别加权）'],
        ['临近度', '35%', '各类最近设施直线距离阶梯衰减（200m 起步，3000m 归零）'],
        ['人口覆盖率', '20%', '三件套齐全居住权重 ÷ 总居住权重（人口加权）'],
        ['多样性', '15%', '类别数量分布香农熵（归一化）'],
    ],
    [0.20, 0.12, 0.68]
))
story.append(Spacer(1, 6))
story.append(Paragraph('表 3　四维评分模型（总分 0-100，A ≥ 90 / B ≥ 75 / C ≥ 60 / D ≥ 40）', caption_style))
h2(story, '4.5 补点选址引擎（贪心最大覆盖）')
para(story, '在每个灰色斑块内生成候选补点，逐轮选取「新增覆盖居住权重」最大的落点并虚拟写入覆盖状态，'
            '迭代至收益枯竭或达到上限。贪心最大覆盖具有 (1-1/e) ≈ 63% 的近似比保证，且逐轮增益单调不增'
            '（单元测试覆盖该性质）。每条建议输出类别覆盖率前后对比与建议坐标，直接可执行。')

# ---- 五、创新点 ----
h1(story, '五、创新点')
bullets(story, [
    '<b>连续步行时间场，而非一圈多边形</b>——把「少量真实测距锚点」插值成「全方向连续可达面」，'
    '同时命中等时圈热力图渲染与空间插值方法两项评审要点；',
    '<b>从体检诊断到规划处方</b>——多数同类工具止步于「哪里缺」，本系统用贪心最大覆盖回答'
    '「在哪补、补了覆盖率从多少到多少」，赛题标题中「规划助手」的后半句由此成立；',
    '<b>人群差异化体检</b>——老年人 52m/min 的速度折减让同一社区呈现完全不同的可达范围与结论，'
    '实测显示新校区老年人视角下重度缺失占比达 100%；',
    '<b>人口加权的灰色区域</b>——以住宅小区密度为人口代理排序盲区，绿地与水体不会被误报为盲区，'
    '结论具备政策说服力；',
    '<b>三级通道降级 + 分析能力开放</b>——服务端代理、浏览器直连、合成兜底三级通道独立熔断，'
    '演示永不中断；分析能力同时开放为 REST API（附 OpenAPI 文档），支持多端接入与街道批量任务。',
])

# ---- 六、应用场景 ----
h1(story, '六、应用场景')
story.append(make_table(
    ['场景', '用户', '系统输出'],
    [
        ['社区生活圈体检', '街道办 / 社区工作者', '单社区体检报告 + 国标对标清单 + 灰色区域地图'],
        ['片区配套评估', '规划编制单位', '街道级批量排名 + 薄弱小区定位 + 补点选址建议'],
        ['为民办实事立项', '区政府 / 城市治理部门', '补点建议的量化收益（覆盖率提升百分点），辅助立项排序'],
        ['公众参与和置业参考', '居民 / 购房者', '任意地址的生活圈评分、人群视角差异与周边设施明细'],
    ],
    [0.24, 0.28, 0.48]
))
story.append(Spacer(1, 6))
story.append(Paragraph('表 4　典型应用场景', caption_style))

# ---- 七、实测验证 ----
h1(story, '七、实测验证')
para(story, '选取上饶市两个真实社区完成对照实测：样例 A 为江西师范大学数字产业学院（新建校区，'
            '预期配套薄弱），样例 B 为信州区中心广场（老城核心，预期配套齐备）。')
story.append(make_table(
    ['指标', 'A·成人（80m/min）', 'A·老年人（52m/min）', 'B·成人（80m/min）'],
    [
        ['总分 / 等级', '21 / E', '27 / E', '68 / C'],
        ['人口覆盖率', '0%', '0%', '33%'],
        ['药店数量', '0 家', '0 家', '20 家（返回上限）'],
        ['养老服务', '0 家', '0 家', '0 家（弱项）'],
        ['灰色斑块', '1（重度，100% 居住权重）', '1（重度缺失占比 100%）', '1（中度，缺菜市场）'],
    ],
    [0.22, 0.26, 0.26, 0.26]
))
story.append(Spacer(1, 6))
story.append(Paragraph('表 5　单点对照实测（浏览器通道，GL SDK）', caption_style))
para(story, '样例 A 被评为 E 级并非系统误判：该校区位于高铁经济试验区新建工业地块，实地核查确认周边'
            '2 公里内确实无药店与养老设施。样例 B 老城核心各项设施触及检索返回上限，两种极端案例'
            '验证了系统的区分度与准确性。')
story.append(Spacer(1, 6))
story.append(callout_row([
    ('85.8 分', '东市街道 9 个住宅小区批量体检均分'),
    ('45 秒', '9 个小区全流程批量体检耗时'),
    ('74~92', '街道内小区评分区间（C 级 1 个 / B 级 5 个 / A 级 3 个）'),
]))
story.append(Spacer(1, 8))
para(story, '街道级批量体检（服务端通道 · 48 向批量算路）对东市街道的实测进一步给出了小区排名：'
            '最优为凤凰中大道辅路沿线小区（92 分，A 级），最差为三清山东大道辅路小区（74 分，C 级，'
            '菜市场步行可达性不足），并精准识别青阳路（覆盖率 71%）为需要补建菜市场的薄弱点位。'
            '算法交叉验证方面，同一对起终点在 GL SDK 单路径算路与服务端批量算路下的结果分别为 '
            '3084 米与 3083 米，误差 0.03%，相互印证了算路链路的准确性。')
para(story, '完整的实测步骤、人工核对过程与误差来源分析见随仓库提交的《真实对比测试报告》'
            '（docs/COMPARISON_TEST.md）。')

# ---- 八、开源工程质量 ----
h1(story, '八、开源工程质量')
bullets(story, [
    '<b>测试</b>：vitest 单元测试与场景级回归共 30 项（坐标转换 / 时间场 / 盲区 / 评分 / 选址引擎 / '
    '三个确定性 fixture 社区端到端断言），全部通过；',
    '<b>类型安全</b>：前后端双 tsconfig 严格模式类型检查，零错误；',
    '<b>CI/CD</b>：GitHub Actions 每次推送自动执行类型检查、测试与构建，全部通过；',
    '<b>部署</b>：Docker 多阶段构建单容器运行；npm install && npm run dev 开箱即跑，'
    '内置无 AK 演示模式（确定性合成数据全链路），评审零配置即可复现；',
    '<b>安全</b>：AK 仅存于环境变量（.env 已 gitignore），服务端 AK 永不下发前端，'
    '仓库与构建产物经敏感文件核查；',
    '<b>文档</b>：技术设计文档（API 策略 / 等时圈算法 / POI 清洗 / 盲区算法 / 规划引擎）、'
    '真实对比测试报告、答辩演示脚本与本文档齐备。',
])

# ---- 九、总结与展望 ----
h1(story, '九、总结与展望')
para(story, '「圈点」以百度地图开放能力为数据底座，把 15 分钟生活圈评估从「人工普查 + 直线距离」'
            '升级为「真实路网 + 连续时间场 + 人口加权 + 自动规划」的量化闭环，并在真实城市环境中'
            '完成了从单个社区到整条街道的实测验证。')
para(story, '后续规划：①配合百度开放平台配额提升，开放城区级批量体检与历史对比；②接入设施营业时间'
            '等动态数据，实现分时段可达性（如夜间药店地图）；③扩展骑行 15 分钟圈对比视角，服务'
            '多模式出行规划；④沉淀为面向街道办的轻量 SaaS 工具，让「15 分钟生活圈」的体检与治理'
            '成为社区工作的日常动作。')
story.append(Spacer(1, 20))
story.append(Paragraph('—— 圈点项目团队　邱全安 / 童梓荣 / 彭明 · 2026 年 10 月', ParagraphStyle(
    'Sign', fontName=BODY_FONT, fontSize=10, leading=14, textColor=TEXT_MUTED, alignment=TA_CENTER)))

doc.multiBuild(story, onFirstPage=on_page, onLaterPages=on_page)
print('body.pdf generated')
