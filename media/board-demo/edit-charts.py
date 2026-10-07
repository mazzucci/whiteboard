# Cuts a charts take (recorder-charts.mjs) into the README's charts GIF: the
# waits sped up, a caption per step. Needs Python 3 with Pillow, and ffmpeg.
#
#   python3 media/board-demo/edit-charts.py <recording dir> <out dir>
import json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont
REC, OUT = sys.argv[1], sys.argv[2]
FF = '/usr/local/bin/ffmpeg'
os.makedirs(f'{OUT}/tmp', exist_ok=True)
rec = json.load(open(f'{REC}/frames.json'))
frames, marks = rec['frames'], {m['label'].split(' ')[0] if m['label'].startswith('clicked') else m['label']: m['t'] for m in rec['marks']}
t0 = frames[0]['t']
at = lambda k: marks[k] - t0
W, H = Image.open(f"{REC}/frames/{frames[0]['n']:05d}.jpg").size
BAR = 84
end = at('answered again') + 4.5
with open(f'{OUT}/tmp/frames.txt', 'w') as f:
    for a, b in zip(frames, frames[1:] + [{'t': t0 + end + 0.1}]):
        if a['t'] - t0 > end: break
        f.write(f"file '{REC}/frames/{a['n']:05d}.jpg'\nduration {max(b['t'] - a['t'], 0.001):.4f}\n")
subprocess.run([FF, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{OUT}/tmp/frames.txt',
                '-vf', f'fps=30,scale={W}:{H},setsar=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '14', f'{OUT}/tmp/session.mp4'], check=True)
SEG = [
    (0.0, at('first answer') + 1.2, 1.0),
    (at('first answer') + 1.2, at('asked'), 1.1),
    (at('asked'), at('answered'), 3.0),
    (at('answered'), at('answered') + 3.0, 1.0),
    (at('answered') + 3.0, at('asked again'), 1.1),
    (at('asked again'), at('answered again'), 3.0),
    (at('answered again'), end, 1.0),
]
CAPS = [
    (0.0, at('first answer') + 1.2, 'Claude charts where the time goes'),
    (at('first answer') + 1.2, at('asked'), 'Click a bar: it goes with your question'),
    (at('asked'), at('answered') + 3.0, 'Claude answers about that bar, on the board'),
    (at('answered') + 3.0, at('asked again'), 'Shift+click to compare two'),
    (at('asked again'), end, 'Claude weighs the two you picked'),
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
    im = Image.new('RGB', (W, BAR), '#161b26'); d = ImageDraw.Draw(im); f = font(34)
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
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12', f'{OUT}/charts-demo.mp4'], check=True)
GW = 1000
subprocess.run([FF, '-y', '-loglevel', 'error', '-i', f'{OUT}/charts-demo.mp4', '-vf',
                f'fps=12,scale={GW}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
                f'{OUT}/whiteboard-charts.gif'], check=True)
print('done', round(out_time(end), 1), 's')
