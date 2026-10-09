# Cuts a side-board take (recorder-sideboard.mjs) into the README's GIF: the
# waits sped up, a caption per step. Needs Python 3 with Pillow, and ffmpeg.
#
#   python3 media/board-demo/edit-sideboard.py <recording dir> <out dir>
import json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont
def font(size):
    for p in ['/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc']:
        try: return ImageFont.truetype(p, size)
        except Exception: pass
REC, OUT = sys.argv[1], sys.argv[2]
FF = '/usr/local/bin/ffmpeg'
os.makedirs(f'{OUT}/tmp', exist_ok=True)
rec = json.load(open(f'{REC}/frames.json'))
frames = rec['frames']
# Marks by their first words ("chose 5" is "chose", "picked postgres" is "picked").
KEYS = ['first answer', 'asked to whiteboard', 'side board', 'picked', 'decided', 'back on the main board', 'proposed']
marks = {}
for m in rec['marks']:
    for k in KEYS:
        if m['label'].startswith(k) and k not in marks: marks[k] = m['t']
t0 = frames[0]['t']
# The board's label is the session's folder name: a neutral one in the GIF (LABEL, or 'checkout').
LABEL = os.environ.get('LABEL', 'checkout')
os.makedirs(f'{OUT}/tmp/frames', exist_ok=True)
def relabel(src, dst):
    im = Image.open(src).convert('RGB'); d = ImageDraw.Draw(im)
    d.rectangle((101, 10, 420, 42), fill='#ffffff')
    f, small = font(18), ImageFont.truetype('/System/Library/Fonts/Helvetica.ttc', 12)
    x = 104
    d.text((x, 26), f'· {LABEL}', font=f, fill='#667085', anchor='lm')
    x += d.textlength(f'· {LABEL}', font=f) + 12
    d.ellipse((x, 22, x + 7, 29), fill='#22a35a')
    d.text((x + 13, 26), 'connected to the session', font=small, fill='#667085', anchor='lm')
    im.save(dst, quality=92)
at = lambda k: marks[k] - t0
W, H = Image.open(f"{REC}/frames/{frames[0]['n']:05d}.jpg").size
BAR = 84
end = max(at('back on the main board'), at('proposed')) + 6.0
with open(f'{OUT}/tmp/frames.txt', 'w') as f:
    for a, b in zip(frames, frames[1:] + [{'t': t0 + end + 0.1}]):
        if a['t'] - t0 > end: break
        relabel(f"{REC}/frames/{a['n']:05d}.jpg", f"{OUT}/tmp/frames/{a['n']:05d}.jpg")
        f.write(f"file '{OUT}/tmp/frames/{a['n']:05d}.jpg'\nduration {max(b['t'] - a['t'], 0.001):.4f}\n")
subprocess.run([FF, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{OUT}/tmp/frames.txt',
                '-vf', f'fps=30,scale={W}:{H},setsar=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '14', f'{OUT}/tmp/session.mp4'], check=True)
SEG = [
    (0.0, at('first answer') + 2.0, 1.0),
    (at('first answer') + 2.0, at('asked to whiteboard'), 1.15),
    (at('asked to whiteboard'), at('side board'), 4.0),
    (at('side board'), at('picked'), 1.0),
    (at('picked'), at('decided'), 1.0),
    (at('decided'), at('back on the main board'), 3.0),
    (at('back on the main board'), end, 1.0),
]
CAPS = [
    (0.0, at('first answer') + 2.0, 'Claude lays out what decides the design: constraints, with its lean'),
    (at('first answer') + 2.0, at('asked to whiteboard'), 'Click your choices: they go with your next message'),
    (at('asked to whiteboard'), at('side board'), '"Let\'s whiteboard" one question: Claude opens a side board'),
    (at('side board'), at('picked'), 'The options side by side, each criterion a row'),
    (at('picked'), at('back on the main board'), 'Decide there, and it is settled on the main board'),
    (at('back on the main board'), end, 'Nothing open: Claude writes the proposal'),
]
def out_time(t):
    acc = 0.0
    for a, b, s in SEG:
        if t <= a: return acc
        if t < b: return acc + (t - a) / s
        acc += (b - a) / s
    return acc
def font(size):
    for p in ['/System/Library/Fonts/SFNS.ttf', '/System/Library/Fonts/Helvetica.ttc']:
        try: return ImageFont.truetype(p, size)
        except Exception: pass
caps = []
for i, (a, b, text) in enumerate(CAPS):
    im = Image.new('RGB', (W, BAR), '#161b26'); d = ImageDraw.Draw(im); f = font(32)
    d.text(((W - d.textlength(text, font=f)) / 2, BAR / 2), text, font=f, fill='white', anchor='lm')
    im.save(f'{OUT}/tmp/cap{i}.png'); caps.append((f'{OUT}/tmp/cap{i}.png', out_time(a), out_time(b)))
chain = ';'.join(f'[0:v]trim={a:.3f}:{b:.3f},setpts=(PTS-STARTPTS)/{s}[s{i}]' for i, (a, b, s) in enumerate(SEG))
chain += ';' + ''.join(f'[s{i}]' for i in range(len(SEG))) + f'concat=n={len(SEG)}:v=1:a=0,fps=30,pad={W}:{H + BAR}:0:0:#161b26,setsar=1[v0]'
prev, inputs = 'v0', ['-i', f'{OUT}/tmp/session.mp4']
for i, (p, a, b) in enumerate(caps):
    inputs += ['-i', p]
    chain += f";[{prev}][{i + 1}:v]overlay=0:{H}:enable='between(t,{a:.3f},{b:.3f})'[c{i}]"; prev = f'c{i}'
open(f'{OUT}/tmp/filter.txt', 'w').write(chain)
subprocess.run([FF, '-y', '-loglevel', 'error', *inputs, '-filter_complex_script', f'{OUT}/tmp/filter.txt', '-map', f'[{prev}]',
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12', f'{OUT}/sideboard-demo.mp4'], check=True)
GW = 1000
subprocess.run([FF, '-y', '-loglevel', 'error', '-i', f'{OUT}/sideboard-demo.mp4', '-vf',
                f'fps=10,scale={GW}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
                f'{OUT}/whiteboard.gif'], check=True)
print('done', round(out_time(end), 1), 's')
