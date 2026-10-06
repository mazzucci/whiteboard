# Edits the before/after demo: the same question to Claude Code without the
# whiteboard (snapshots of the real Terminal window, in order) and with it (a
# board recording by recorder-qa.mjs), with snapshots of that session's
# Terminal window too, so it is plain the board is Claude Code's, not an app
# of its own: 1-calling.jpg (Claude calls the tool), 2-drawn.jpg (the board
# opened), 3-followup.jpg (the follow-up typed on the board, arriving in the
# session). Writes an MP4 and a GIF. Needs Python 3 with Pillow, and ffmpeg.
#
#   python3 media/board-demo/compare.py <before frames dir> <board recording dir> <terminal dir> <out dir>
import json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

BEFORE, REC, TERM, OUT = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
FF = '/usr/local/bin/ffmpeg'
TMP = f'{OUT}/tmp-compare'
os.makedirs(TMP, exist_ok=True)
W, H, BAR = 1440, 1000, 96
BAR_BG, CARD_BG, INK, MUTED, TERM_BG = '#161b26', '#f5f6f8', '#1b2130', '#667085', '#e7eaf0'

def font(size, weight='Semibold'):
    f = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', size)
    try: f.set_variation_by_name(weight)
    except Exception: pass
    return f

def card(lines, path):
    im = Image.new('RGB', (W, H + BAR), CARD_BG)
    d = ImageDraw.Draw(im)
    for text, size, color, y, weight in lines:
        f = font(size, weight)
        d.text(((W - d.textlength(text, font=f)) / 2, (H + BAR) * y), text, font=f, fill=color, anchor='lm')
    im.save(path)

def bar(text, path):
    im = Image.new('RGB', (W, BAR), BAR_BG)
    d = ImageDraw.Draw(im)
    f = font(36)
    d.text(((W - d.textlength(text, font=f)) / 2, BAR / 2), text, font=f, fill='white', anchor='lm')
    return im

# 1. Title card.
card([('How does OAuth work?', 64, INK, 0.40, 'Semibold'),
      ('The same question to Claude Code, without and with the whiteboard.', 30, MUTED, 0.51, 'Regular'),
      ('Whiteboard · open source · not affiliated with Anthropic', 20, MUTED, 0.9, 'Regular')], f'{TMP}/title.png')

def terminal_frame(src, caption, out):
    """A snapshot of the Terminal window, centred on the stage, with its caption."""
    im = Image.open(src).convert('RGB')
    scale = min((W - 80) / im.width, (H - 60) / im.height)
    im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    frame = Image.new('RGB', (W, H + BAR), TERM_BG)
    frame.paste(im, ((W - im.width) // 2, (H - im.height) // 2))
    frame.paste(caption, (0, H))
    frame.save(out)

# 2. Without: each snapshot of the Terminal window.
caption = bar('Without the whiteboard: the answer scrolls by as text', None)
snaps = sorted(os.listdir(BEFORE))
with open(f'{TMP}/before.txt', 'w') as f:
    for i, name in enumerate(snaps):
        terminal_frame(f'{BEFORE}/{name}', caption, f'{TMP}/before-{i:02d}.png')
        hold = 2.4 if i == 0 else 3.5 if i == len(snaps) - 1 else 0.75
        f.write(f"file '{TMP}/before-{i:02d}.png'\nduration {hold}\n")
    f.write(f"file '{TMP}/before-{len(snaps) - 1:02d}.png'\n")

# 3. A card between the two.
card([('With the whiteboard', 64, INK, 0.45, 'Semibold'),
      ('Same question, same Claude Code, plus the plugin.', 30, MUTED, 0.56, 'Regular')], f'{TMP}/with.png')

# 4. With: the board recording, waits sped up, one caption per step.
rec = json.load(open(f'{REC}/frames.json'))
frames, marks = rec['frames'], {m['label']: m['t'] for m in rec['marks']}
t0 = frames[0]['t']
at = lambda label: marks[label] - t0
end = at('second tab') + 2.5
with open(f'{TMP}/frames.txt', 'w') as f:
    for a, b in zip(frames, frames[1:] + [{'t': t0 + end + 0.1}]):
        if a['t'] - t0 > end: break
        f.write(f"file '{REC}/frames/{a['n']:05d}.jpg'\nduration {max(b['t'] - a['t'], 0.001):.4f}\n")
SEGMENTS = [
    (0.0, at('first answer') + 4.0, 1.0),
    (at('first answer') + 4.0, at('asked follow-up'), 1.0),
    (at('asked follow-up'), at('second diagram'), 2.5),
    (at('second diagram'), end, 1.0),
]
CAPTIONS = [
    (0.0, at('asked follow-up'), 'The flow, drawn, with the gotchas pinned beside it'),
    (at('asked follow-up'), at('second answer') + 1.0, 'A follow-up asked on the board gets its own diagram'),
    (at('second answer') + 1.0, end, 'Both stay a click apart'),
]
def out_time(t):
    acc = 0.0
    for a, b, s in SEGMENTS:
        if t <= a: return acc
        if t < b: return acc + (t - a) / s
        acc += (b - a) / s
    return acc
subprocess.run([FF, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{TMP}/frames.txt',
                '-vf', f'fps=30,scale={W}:{H},setsar=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16', f'{TMP}/with-raw.mp4'], check=True)
caps = []
for i, (a, b, text) in enumerate(CAPTIONS):
    bar(text, None).save(f'{TMP}/cap{i}.png')
    caps.append((f'{TMP}/cap{i}.png', out_time(a), out_time(b)))
parts = [f'[0:v]trim={a:.3f}:{b:.3f},setpts=(PTS-STARTPTS)/{s}[s{i}]' for i, (a, b, s) in enumerate(SEGMENTS)]
chain = ';'.join(parts) + ';' + ''.join(f'[s{i}]' for i in range(len(SEGMENTS))) + f'concat=n={len(SEGMENTS)}:v=1:a=0,fps=30,pad={W}:{H + BAR}:0:0:{BAR_BG},setsar=1[v0]'
prev, inputs = 'v0', ['-i', f'{TMP}/with-raw.mp4']
for i, (path, a, b) in enumerate(caps):
    inputs += ['-i', path]
    chain += f";[{prev}][{i + 1}:v]overlay=0:{H}:enable='between(t,{a:.3f},{b:.3f})'[c{i}]"
    prev = f'c{i}'
with open(f'{TMP}/with-filter.txt', 'w') as f: f.write(chain)
subprocess.run([FF, '-y', '-loglevel', 'error', *inputs, '-filter_complex_script', f'{TMP}/with-filter.txt', '-map', f'[{prev}]',
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', f'{TMP}/with.mp4'], check=True)

# 5. All together: title, without, the card, with.
def still(png, seconds, out):
    subprocess.run([FF, '-y', '-loglevel', 'error', '-loop', '1', '-t', str(seconds), '-i', png, '-vf', 'fps=30,format=yuv420p,setsar=1',
                    '-c:v', 'libx264', '-crf', '18', out], check=True)
still(f'{TMP}/title.png', 2.4, f'{TMP}/title.mp4')
still(f'{TMP}/with.png', 1.8, f'{TMP}/with-card.mp4')

# The session's Terminal: Claude calling the whiteboard, then the board open.
calling = bar('In Claude Code, Claude draws on the whiteboard: a page it opens in your browser', None)
terminal_frame(f'{TERM}/1-calling.jpg', calling, f'{TMP}/term-1.png')
terminal_frame(f'{TERM}/2-drawn.jpg', calling, f'{TMP}/term-2.png')
with open(f'{TMP}/term-intro.txt', 'w') as f:
    f.write(f"file '{TMP}/term-1.png'\nduration 1.6\nfile '{TMP}/term-2.png'\nduration 2.8\nfile '{TMP}/term-2.png'\n")
subprocess.run([FF, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{TMP}/term-intro.txt',
                '-vf', 'fps=30,format=yuv420p,setsar=1', '-c:v', 'libx264', '-crf', '18', f'{TMP}/term-intro.mp4'], check=True)
# The follow-up typed on the board, arriving in the same session.
terminal_frame(f'{TERM}/3-followup.jpg', bar('What you type on the board arrives in the same Claude Code session', None), f'{TMP}/term-3.png')
still(f'{TMP}/term-3.png', 3.2, f'{TMP}/term-followup.mp4')
# The board, cut where the follow-up has just been sent.
cut = out_time(at('asked follow-up') + 1.2)
subprocess.run([FF, '-y', '-loglevel', 'error', '-i', f'{TMP}/with.mp4', '-t', f'{cut:.3f}', '-c:v', 'libx264', '-crf', '18', f'{TMP}/with-1.mp4'], check=True)
subprocess.run([FF, '-y', '-loglevel', 'error', '-ss', f'{cut:.3f}', '-i', f'{TMP}/with.mp4', '-c:v', 'libx264', '-crf', '18', f'{TMP}/with-2.mp4'], check=True)
subprocess.run([FF, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{TMP}/before.txt',
                '-vf', 'fps=30,format=yuv420p,setsar=1', '-c:v', 'libx264', '-crf', '18', f'{TMP}/before.mp4'], check=True)
with open(f'{TMP}/all.txt', 'w') as f:
    for part in ('title', 'before', 'with-card', 'term-intro', 'with-1', 'term-followup', 'with-2'):
        f.write(f"file '{TMP}/{part}.mp4'\n")
mp4 = f'{OUT}/whiteboard-before-after.mp4'
subprocess.run([FF, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{TMP}/all.txt', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', mp4], check=True)
gif = f'{OUT}/whiteboard-before-after.gif'
vf = 'fps=12,scale=1200:-1:flags=lanczos'
subprocess.run([FF, '-y', '-loglevel', 'error', '-i', mp4, '-vf', f'{vf},palettegen=max_colors=128:stats_mode=diff', f'{TMP}/palette.png'], check=True)
subprocess.run([FF, '-y', '-loglevel', 'error', '-i', mp4, '-i', f'{TMP}/palette.png', '-lavfi', f'{vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif], check=True)
dur = float(subprocess.run(['/usr/local/bin/ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], capture_output=True, text=True).stdout)
print(json.dumps({'duration': round(dur, 1), 'gif_mb': round(os.path.getsize(gif) / 1e6, 1)}))
