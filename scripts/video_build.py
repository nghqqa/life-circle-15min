# -*- coding: utf-8 -*-
"""圈点产品介绍视频合成：分镜(narration) → TTS(晓晓) → 时间轴 → 素材切片/章节卡 → 字幕烧录 → 1080P 成片。
用法: python scripts/video_build.py   （需先跑 scripts/record_video.mjs 产出 .tmp-video/*.webm）
"""
import asyncio, subprocess, json, os, re, glob, datetime
import edge_tts
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, '.tmp-video')
RAW = os.path.join(OUT, 'raw')
os.makedirs(RAW, exist_ok=True)
VOICE = 'zh-CN-XiaoxiaoNeural'
FONT_B = 'C:/Windows/Fonts/msyhbd.ttc'
FONT = 'C:/Windows/Fonts/msyh.ttc'

SEGS = [
    dict(id='s1', kind='card', title='15 分钟生活圈，丈量得到吗？', sub='圈点 · 智能体检与规划助手',
         text='一杯豆浆的距离是五百米，一个生活圈的距离是十五分钟。国家推行的15分钟便民生活圈，考核的是步行可达，而不是直线距离。可现实里，隔着一条河、一排围挡，五百米可能走二十分钟。传统评估靠人工普查和静态圆圈，看不见真实路网的绕行，也说不清缺了该在哪补。'),
    dict(id='s2', kind='slice', slice=0, title='定位体检',
         text='这是「圈点」。输入一个地址，它向百度地图开放能力请求地理编码、周边设施检索和48个方向的批量步行算路，把15分钟能走到哪，算成一张连续的步行时间场。热力面、三层等时环、灰色盲区、补点建议，一次体检全部给出。注意右上角：数据通道是服务端，报告有唯一编号，来源和时间全程可追溯。'),
    dict(id='s3', kind='slice', slice=1, title='真实社区对照',
         text='看两个真实社区。江西师大数据产业学院，新建校区：八类设施检索为零，住宅覆盖口径如实标注无法评估，系统回退WorldPop人口栅格估算，等时圈里只有约368名常住居民，覆盖水平百分之二十八，评分26分E级。再看老城核心中心广场：医院、诊所、药店、商超齐备，累积机会43处8类，住宅检索完整取回112处，人口覆盖率按住宅口径如实计算为百分之四十点七，计入评分后69分C级。同一座城，26分和69分，系统的区分度立住了。'),
    dict(id='s4', kind='slice', slice=2, title='人群公平',
         text='换一双眼睛再看同一座城。切到老年人视角，步速从80降到52，五分钟环明显收缩，老城核心的累积机会从43处掉到15处，评分从69变成64。同一社区，不同人群，结论不同，公平性不是一句口号，是可计算的差异。每次体检还自带插值精度自证：抽样8个真实算路点对照模型估计，误差透明可查。'),
    dict(id='s5', kind='slice', slice=3, title='体检之后给处方',
         text='体检只是半边，赛题要的是规划助手。对每个灰色斑块，贪心最大覆盖模型给出补点位置和设施类别：补建菜市场，新覆盖501个居住网格，该类覆盖率从百分之四十点七提到百分之九十二点四。采纳或跳过，实时重算；两套方案记录为A和B，同一基线比较新增覆盖与剩余薄弱格。最后一键生成完整报告，矢量地图、指标、清单、来源，直接进汇报材料。'),
    dict(id='s6', kind='slice', slice=4, title='从社区到街道',
         text='视角再升一级。对东市街道发起批量体检：系统自动检索片区内住宅小区作采样点，逐个完整体检，约1分钟给出9个小区的排名。均分86.8，极差13，青阳路和三清山东大道辅路因菜市场可达性不足被自动点名。再放大到整个信州区：14个小区按街道分组，茅家岭街道7个小区4个薄弱，新区配套滞后从主观感受变成可量化的街道结论。薄弱清单一键导出CSV，直接进治理台账。'),
    dict(id='s7', kind='slice', slice=5, title='工程与开源',
         text='工程上半分靠细节。页面与API收敛为同一份分析编排器，UI经SSE流逐帧消费服务端编排进度，两个入口的数字口径完全一致。数据获取三级通道降级：服务端代理、浏览器直连、确定性合成，配额耗尽演示不断。检索有边界的诚实：每个关键词记录分页完整度，未知不冒充缺失，截断不冒充全量。182项单元测试、34项浏览器流程测试，CI每次提交全绿；密钥全程不出后端，Docker一键部署。'),
    dict(id='s8', kind='card', title='让 15 分钟，真实可达', sub='开源仓库 · 部署文档 · API 说明，随材料提交',
         text='圈点，15分钟生活圈智能体检与规划助手。开源仓库、部署文档、API说明随材料提交。让每一个15分钟生活圈，都丈量得到、看得见缺口、补得准位置。谢谢评审。'),
]

def run(cmd):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, encoding='utf-8', errors='ignore')
    if r.returncode != 0:
        print('CMD FAIL:', cmd[:160], '\n', (r.stderr or '')[-600:])
    return r

def dur_of(path):
    r = run(f'ffprobe -v quiet -print_format json -show_format "{path}"')
    return float(json.loads(r.stdout)['format']['duration'])

async def tts_all():
    for s in SEGS:
        mp3 = os.path.join(OUT, f"{s['id']}.mp3")
        if not os.path.exists(mp3):
            await edge_tts.Communicate(s['text'], VOICE, rate='+4%').save(mp3)
        s['audio'] = dur_of(mp3)
        print(s['id'], 'audio', round(s['audio'], 1), 's')

def cards():
    for s in SEGS:
        if s['kind'] != 'card':
            continue
        img = Image.new('RGB', (1920, 1080), (16, 32, 56))
        dr = ImageDraw.Draw(img)
        dr.rectangle([0, 0, 1920, 10], fill=(41, 121, 255))
        dr.rectangle([0, 1070, 1920, 1080], fill=(41, 121, 255))
        f1 = ImageFont.truetype(FONT_B, 96)
        f2 = ImageFont.truetype(FONT, 44)
        w = dr.textlength(s['title'], font=f1)
        dr.text(((1920 - w) / 2, 430), s['title'], font=f1, fill=(240, 246, 255))
        w = dr.textlength(s['sub'], font=f2)
        dr.text(((1920 - w) / 2, 590), s['sub'], font=f2, fill=(140, 170, 210))
        dr.text((80, 990), '圈点 · 15分钟生活圈智能体检与规划助手', font=ImageFont.truetype(FONT, 28), fill=(90, 120, 160))
        img.save(os.path.join(OUT, f"{s['id']}.png"))

def slices():
    # 原始录屏 webm 按录制日志的镜头分界切分
    log = open(os.path.join(ROOT, '.tmp-video-rec.log'), encoding='utf-8', errors='ignore').read() \
        if os.path.exists(os.path.join(ROOT, '.tmp-video-rec.log')) else ''
    marks = re.findall(r'\[(\d\d:\d\d:\d\d)\] == (shot\d)', log)
    raws = sorted(glob.glob(os.path.join(OUT, '*.webm')) + glob.glob(os.path.join(RAW, '*.webm')),
                  key=os.path.getmtime)
    if not raws:
        raise SystemExit('未找到录屏 webm')
    docs_raw = raws[-1]            # 最新 = /api/docs 独立页
    main = raws[0] if len(raws) == 1 else raws[-2]  # 次新/唯一 = 主页面
    total = dur_of(main)
    print('raw', os.path.basename(main), round(total, 1), 's; marks:', marks)
    # 镜头边界（正向）：raw 起点≈首条 shot 日志前 ~4s（goto+选择器等待）
    if marks:
        def w2s(wall):
            h, m, sec = wall.split(':')
            return int(h) * 3600 + int(m) * 60 + int(sec)
        w0 = w2s(marks[0][0])
        intro = 4
        bounds = [0] + [w2s(w) - w0 + intro for _, w in [(None, mm[0]) for mm in marks[1:]]]
        bounds.append(total)
    else:
        n = sum(1 for s in SEGS if s['kind'] == 'slice')
        step = total / (n + 1)
        bounds = [step * (i + 1) for i in range(n)]
        bounds.append(total)
    idx = 0
    for s in SEGS:
        if s['kind'] != 'slice':
            continue
        if s['id'] == 's7' and len(raws) > 1:
            s['raw'], s['ss'], s['len'] = docs_raw, 0, dur_of(docs_raw)
            continue
        a, b = bounds[idx], bounds[idx + 1]
        s['raw'], s['ss'], s['len'] = main, a, b - a
        idx += 1

def build_segment(s, start):
    adur = s['audio']
    vdur = max(adur + 1.2, 3.0)
    out = os.path.join(OUT, f"{s['id']}.mp4")
    apad = max(0, vdur - adur)
    if s['kind'] == 'card':
        vf = f"scale=1920:1080,format=yuv420p,tpad=stop_mode=clone:stop_duration={vdur:.2f}"
        run(f'ffmpeg -y -loop 1 -i "{os.path.join(OUT, s["id"] + ".png")}" -i "{os.path.join(OUT, s["id"] + ".mp3")}" '
            f'-filter_complex "[0:v]{vf}[v];[1:a]apad=pad_dur={apad:.2f}[a]" -map "[v]" -map "[a]" '
            f'-t {vdur:.2f} -r 30 -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 160k "{out}"')
    else:
        ss, ln = s.get('ss', 0), s.get('len', vdur)
        take = min(ln, vdur)
        # 画面跨度短于配音时慢放（上限 3x），慢放仍不足再冻结尾帧
        factor = max(1.0, min(3.0, vdur / take)) if take > 0.5 else 1.0
        covered = min(take * factor, vdur)
        vf = (f"scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,format=yuv420p,"
              f"setpts=PTS*{factor:.3f},tpad=stop_mode=clone:stop_duration={max(0, vdur - covered):.2f}")
        run(f'ffmpeg -y -ss {ss:.2f} -i "{s["raw"]}" -i "{os.path.join(OUT, s["id"] + ".mp3")}" '
            f'-filter_complex "[0:v]{vf}[v];[1:a]apad=pad_dur={apad:.2f}[a]" -map "[v]" -map "[a]" '
            f'-t {vdur:.2f} -r 30 -c:v libx264 -preset medium -crf 20 -c:a aac -b:a 160k "{out}"')
    s['dur'] = vdur
    s['start'] = start
    return vdur

def srt(segs):
    def fmt(t):
        h, m = int(t // 3600), int(t % 3600 // 60)
        s = t % 60
        return f'{h:02}:{m:02}:{int(s):02},{int((s - int(s)) * 1000):03}'
    out, n = [], 1
    for s in segs:
        text = s['text']
        # 按标点切短句，时长按字数比例铺满配音区间
        parts = [p for p in re.split(r'(?<=[。；：？！])', text) if p]
        parts2 = []
        for p in parts:
            while len(p) > 22:
                cut = p.rfind('，', 0, 22)
                cut = cut if cut > 8 else 22
                parts2.append(p[:cut + 1]); p = p[cut + 1:]
            if p:
                parts2.append(p)
        total_chars = sum(len(p) for p in parts2) or 1
        t = s['start'] + 0.15
        for p in parts2:
            d = (s['audio'] - 0.3) * len(p) / total_chars
            out.append(f"{n}\n{fmt(t)} --> {fmt(min(t + d, s['start'] + s['audio'] + 0.2))}\n{p}\n")
            t += d
            n += 1
    open(os.path.join(OUT, 'subs.srt'), 'w', encoding='utf-8').write('\n'.join(out))

def final():
    concat = os.path.join(OUT, 'concat.txt')
    open(concat, 'w', encoding='utf-8').write(
        ''.join(f"file '{os.path.join(OUT, s['id'] + '.mp4')}'\n" for s in SEGS))
    subs = os.path.join(OUT, 'subs.srt').replace('\\', '/').replace(':', '\\:')
    dst = os.path.join(ROOT, 'docs', 'video', '圈点-产品介绍-8分钟-统一编排版-20261013.mp4')
    run(f'ffmpeg -y -f concat -safe 0 -i "{concat}" -vf "subtitles={subs}:force_style='
        f"'FontName=Microsoft YaHei,FontSize=13,PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=1,Outline=1.2,Shadow=0.6,MarginV=28'\" "
        f'-c:v libx264 -preset medium -crf 21 -c:a aac -b:a 160k -movflags +faststart "{dst}"')
    print('DONE →', dst, round(dur_of(dst) / 60, 2), 'min')

async def main():
    await tts_all()
    cards()
    slices()
    t = 0.0
    for s in SEGS:
        build_segment(s, t)
        t += s['dur']
    srt(SEGS)
    final()

asyncio.run(main())
