# Edits a recording of the board (recorder.mjs: frames, their timestamps and
# the recorder's marks) into the README's demo: a title card, the session with
# the waits sped up, and one caption per step under it. Writes an MP4 and a
# GIF. Needs Python 3 with Pillow, and ffmpeg.
#
#   python3 media/board-demo/edit.py <recording dir> <out dir>
import json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

REC, OUT = sys.argv[1], sys.argv[2]
FF = '/usr/local/bin/ffmpeg'
TMP = f'{OUT}/tmp'
os.makedirs(TMP, exist_ok=True)
W, H, BAR = 1440, 1000, 96
BAR_BG, CARD_BG, INK, MUTED = '#161b26', '#f5f6f8', '#1b2130', '#667085'

rec = json.load(open(f'{REC}/frames.json'))
frames, marks = rec['frames'], {m['label']: m['t'] for m in rec['marks']}
t0 = frames[0]['t']
at = lambda label: marks[label] - t0
end = at('wrapped up') + 3.0

# The session as a constant-rate video, each frame held until the next.
with open(f'{TMP}/frames.txt', 'w') as f:
    for a, b in zip(frames, frames[1:] + [{'t': t0 + end + 0.1}]):
        if a['t'] - t0 > end: break
        f.write(f"file '{REC}/frames/{a['n']:05d}.jpg'\nduration {max(b['t'] - a['t'], 0.001):.4f}\n")
subprocess.run([FF, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{TMP}/frames.txt',
                '-vf', f'fps=30,scale={W}:{H},setsar=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16',
                f'{TMP}/session.mp4'], check=True)

# (from, to, speed) in session seconds: waits fast, what matters at 1x.
SEGMENTS = [
    (0.0, at('sticky note'), 1.0),              # step 1, then the trace arrives
    (at('sticky note'), at('said yes'), 1.0),   # the note, the question, the answer typed
    (at('said yes'), at('proposal drawn'), 3.0),  # Claude works on it
    (at('proposal drawn'), at('settled'), 1.3),
    (at('settled'), at('wrap up'), 1.15),       # zoom, pan, back and forth
    (at('wrap up'), at('wrapped up'), 2.5),     # Claude writes the summary
    (at('wrapped up'), end, 1.0),
]
CAPTIONS = [
    (0.0, at('sticky note'), 'Claude walks you through it on a whiteboard in your browser'),
    (at('sticky note'), at('said yes'), 'The trace shows the problem. The fix waits on a sticky note'),
    (at('said yes'), at('settled'), 'You answer on the board, and Claude draws the proposal'),
    (at('settled'), at('wrap up'), 'Zoom, pan, and step through the diagrams'),
    (at('wrap up'), end, 'Wrap up: the summary goes back to Claude Code'),
]
CARD = 2.2

def out_time(t):
    acc = 0.0
    for a, b, s in SEGMENTS:
        if t <= a: return acc
        if t < b: return acc + (t - a) / s
        acc += (b - a) / s
    return acc

def font(size, weight='Semibold'):
    f = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', size)
    try: f.set_variation_by_name(weight)
    except Exception: pass
    return f

# The title card.
card = Image.new('RGB', (W, H + BAR), CARD_BG)
d = ImageDraw.Draw(card)
for text, size, color, y, weight in [
    ('Think it through on a whiteboard.', 64, INK, 0.42, 'Semibold'),
    ('Claude draws as it explains, on a page beside your Claude Code session.', 30, MUTED, 0.53, 'Regular'),
    ('Whiteboard · open source · not affiliated with Anthropic', 20, MUTED, 0.9, 'Regular'),
]:
    f = font(size, weight)
    d.text(((W - d.textlength(text, font=f)) / 2, (H + BAR) * y), text, font=f, fill=color, anchor='lm')
card.save(f'{TMP}/card.png')

caps = []
for i, (a, b, text) in enumerate(CAPTIONS):
    im = Image.new('RGB', (W, BAR), BAR_BG)
    dd = ImageDraw.Draw(im)
    f = font(36)
    dd.text(((W - dd.textlength(text, font=f)) / 2, BAR / 2), text, font=f, fill='white', anchor='lm')
    im.save(f'{TMP}/cap{i}.png')
    caps.append((f'{TMP}/cap{i}.png', out_time(a) + CARD, out_time(b) + CARD))

parts = [f'[0:v]trim={a:.3f}:{b:.3f},setpts=(PTS-STARTPTS)/{s}[s{i}]' for i, (a, b, s) in enumerate(SEGMENTS)]
chain = ';'.join(parts) + ';' + ''.join(f'[s{i}]' for i in range(len(SEGMENTS))) + f'concat=n={len(SEGMENTS)}:v=1:a=0,fps=30[cat]'
chain += f';[cat]pad={W}:{H + BAR}:0:0:{BAR_BG},setsar=1[body]'
chain += f';[1:v]loop=loop={int(CARD * 30)}:size=1:start=0,fps=30,setpts=N/30/TB,format=yuv420p,setsar=1,fade=t=out:st={CARD - 0.4}:d=0.4:color={CARD_BG}[card]'
chain += ';[card][body]concat=n=2:v=1:a=0[v0]'
prev, inputs = 'v0', ['-i', f'{TMP}/session.mp4', '-i', f'{TMP}/card.png']
for i, (path, a, b) in enumerate(caps):
    inputs += ['-i', path]
    chain += f";[{prev}][{i + 2}:v]overlay=0:{H}:enable='between(t,{a:.3f},{b:.3f})'[c{i}]"
    prev = f'c{i}'
with open(f'{TMP}/filter.txt', 'w') as f: f.write(chain)
subprocess.run([FF, '-y', '-loglevel', 'error', *inputs, '-filter_complex_script', f'{TMP}/filter.txt', '-map', f'[{prev}]',
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow', '-an', f'{OUT}/whiteboard-demo.mp4'], check=True)

# The README's GIF: smaller, 12 fps, one palette for the whole clip.
gif = f'{OUT}/whiteboard.gif'
vf = 'fps=12,scale=1200:-1:flags=lanczos'
subprocess.run([FF, '-y', '-loglevel', 'error', '-i', f'{OUT}/whiteboard-demo.mp4', '-vf', f'{vf},palettegen=max_colors=128:stats_mode=diff', f'{TMP}/palette.png'], check=True)
subprocess.run([FF, '-y', '-loglevel', 'error', '-i', f'{OUT}/whiteboard-demo.mp4', '-i', f'{TMP}/palette.png',
                '-lavfi', f'{vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif], check=True)
print(json.dumps({'duration': round(out_time(end) + CARD, 1), 'gif_mb': round(os.path.getsize(gif) / 1e6, 1)}))
