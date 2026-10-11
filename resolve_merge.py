# -*- coding: utf-8 -*-
"""规则化解决整合分支的合并冲突：默认双保留；map.ts 弹窗做并集。"""
import io, re, sys

UNION_IMPORT = re.compile(
    r"<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", re.S)

def resolve_file(path):
    s = io.open(path, encoding='utf-8').read()
    if '<<<<<<<' not in s:
        return False
    blocks = list(re.finditer(r"<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> [^\n]*\n", s, re.S))
    # 从后往前替换
    for m in reversed(blocks):
        ours, theirs = m.group(1), m.group(2)
        if path == 'src/map.ts' and 'data-route-uid' in ours and 'data-hours-uid' in theirs:
            # 路线核验 + 营业时段 双按钮并集
            new = ours.replace('步行路线核验</button></div>`',
                               '步行路线核验</button> <button class="btn ghost" data-hours-uid="${escapeHtml(p.uid)}" style="margin-top:6px;font-size:12px;padding:2px 8px">营业时段</button></div>`')
            new = new.replace('{ width: 220 }', '{ width: 240 }')
        elif path == 'src/map.ts' and 'data-corr-save' in theirs and 'data-route-uid' in ours:
            # 三合一：路线 + 时段 + 纠错（ours 此时应已含时段按钮）
            new = ours.replace('步行路线核验</button></div>`',
                '步行路线核验</button>\n            <button class="btn ghost" data-hours-uid="${escapeHtml(p.uid)}" style="margin-top:6px;font-size:12px;padding:2px 8px">营业时段</button>\n            <button class="btn ghost" data-corr-undo-uid="${escapeHtml(p.uid)}" style="margin-top:6px;font-size:12px;padding:2px 6px">撤销最新标注</button>\n            <div style="margin-top:6px;display:flex;gap:4px;flex-wrap:wrap">\n              <select data-corr-status="${escapeHtml(p.uid)}" style="font-size:12px;height:24px">\n                <option>已核验</option><option>停业</option><option>迁移</option><option>分类错误</option>\n              </select>\n              <input data-corr-note="${escapeHtml(p.uid)}" placeholder="说明(可空)" style="font-size:12px;width:90px;height:24px">\n              <button class="btn ghost" data-corr-save="${escapeHtml(p.uid)}" data-corr-name="${escapeHtml(p.name)}" style="font-size:12px;padding:2px 6px">标注</button>\n            </div></div>`')
            new = new.replace('{ width: 220 }', '{ width: 260 }').replace('{ width: 240 }', '{ width: 260 }')
        elif path.endswith('.ts') and ('import ' in ours and 'import ' in theirs):
            # imports 冲突：双保留（按行去重）
            ours_lines = [l for l in ours.split('\n') if l.strip()]
            theirs_lines = [l for l in theirs.split('\n') if l.strip()]
            merged = []
            seen = set()
            for l in ours_lines + theirs_lines:
                if l not in seen:
                    seen.add(l)
                    merged.append(l)
            new = '\n'.join(merged) + '\n'
        else:
            # 默认：双保留（EOF 追加型）
            new = ours.rstrip('\n') + '\n' + theirs
        s = s[:m.start()] + new + s[m.end():]
    assert '<<<<<<<' not in s and '>>>>>>>' not in s, f'{path} 仍有标记'
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)
    return True

files = sys.argv[1:]
for f in files:
    if resolve_file(f):
        print('resolved', f)
    else:
        print('no-conflict', f)
