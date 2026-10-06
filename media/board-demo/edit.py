# Edits a recording of the board (recorder.mjs: frames, their timestamps and
# the recorder's marks) into the README's demo: a title card, the session with
# the waits sped up, and one caption per step under it. Writes an MP4 and a
# GIF. Needs Python 3 with Pillow, and ffmpeg.
#
#   python3 media/board-demo/edit.py <recording dir> <out dir> [terminal dir]
#
# With a terminal dir (window-recorder.swift's frames of the session's
# Terminal window, named <epoch ms>.jpg, and clips.json; see
# demo/RECORDING.md), the demo shows where the board comes from: Claude Code
# at work until it opens the whiteboard, then the board from its first
# diagram; and after the wrap-up, the summary arriving in Claude Code.
# WINDOW=1 shows the page in a plain browser window.
import json, os, subprocess, sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

REC, OUT = sys.argv[1], sys.argv[2]
TERM = sys.argv[3] if len(sys.argv) > 3 else None
FF = '/usr/local/bin/ffmpeg'
TMP = f'{OUT}/tmp'
os.makedirs(TMP, exist_ok=True)
BAR = 96
BAR_BG, CARD_BG, INK, MUTED = '#161b26', '#f5f6f8', '#1b2130', '#667085'
# The GIF's width: GIF_W, 1200 unless said (a take beside the Terminal is wider).
GIF_W = int(os.environ.get('GIF_W', 1200))
# How much faster than the pace below the whole demo plays: SPEED, 1 unless said.
SPEED = float(os.environ.get('SPEED', 1))

rec = json.load(open(f'{REC}/frames.json'))
frames, marks = rec['frames'], {m['label']: m['t'] for m in rec['marks']}
PAGE = Image.open(f"{REC}/frames/{frames[0]['n']:05d}.jpg").size
STAGE, TOOLBAR, MARGIN = '#e7eaf0', 40, 24
WINDOW = os.environ.get('WINDOW') == '1'
URL = open(f'{REC}/url.txt').read().strip().split('?')[0] if os.path.exists(f'{REC}/url.txt') else 'http://127.0.0.1/'

def window(page):
    """The page in a plain browser window, on the stage the Terminal slides use."""
    w, h = page.size
    im = Image.new('RGB', (w + 2 * MARGIN, h + TOOLBAR + 2 * MARGIN), STAGE)
    d = ImageDraw.Draw(im)
    x, y = MARGIN, MARGIN
    d.rounded_rectangle((x - 1, y - 1, x + w, y + TOOLBAR + h), radius=10, fill='#eceef2', outline='#cdd2da')
    for i, c in enumerate(('#ff5f57', '#febc2e', '#28c840')):
        d.ellipse((x + 16 + i * 20, y + 14, x + 28 + i * 20, y + 26), fill=c)
    pill = (x + 100, y + 8, x + w - 100, y + TOOLBAR - 8)
    d.rounded_rectangle(pill, radius=12, fill='white')
    d.text(((pill[0] + pill[2]) / 2, (pill[1] + pill[3]) / 2), URL.replace('http://', ''), font=font(15, 'Regular'), fill=MUTED, anchor='mm')
    im.paste(page, (x, y + TOOLBAR))
    return im

def font(size, weight='Semibold'):
    f = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', size)
    try: f.set_variation_by_name(weight)
    except Exception: pass
    return f

FRAMES = f'{REC}/frames'
if WINDOW:
    FRAMES = f'{TMP}/window'
    os.makedirs(FRAMES, exist_ok=True)
    for fr in frames:
        window(Image.open(f"{REC}/frames/{fr['n']:05d}.jpg").convert('RGB')).save(f"{FRAMES}/{fr['n']:05d}.jpg", quality=92)
# The frames' own size (an even one, for the encoder).
W, H = (v - v % 2 for v in Image.open(f"{FRAMES}/{frames[0]['n']:05d}.jpg").size)
t0 = frames[0]['t']
at = lambda label: marks[label] - t0
end = at('wrapped up') + 3.0

# The session as a constant-rate video, each frame held until the next.
with open(f'{TMP}/frames.txt', 'w') as f:
    for a, b in zip(frames, frames[1:] + [{'t': t0 + end + 0.1}]):
        if a['t'] - t0 > end: break
        f.write(f"file '{FRAMES}/{a['n']:05d}.jpg'\nduration {max(b['t'] - a['t'], 0.001):.4f}\n")
subprocess.run([FF, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{TMP}/frames.txt',
                '-vf', f'fps=30,scale={W}:{H},setsar=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '16',
                f'{TMP}/session.mp4'], check=True)

# (from, to, speed) in session seconds: waits fast, what matters at 1x.
# With the Terminal before it, the board starts at its first diagram; on its own, as it opens.
START = at('first diagram') + 0.2 if TERM else 0.0
# FIRST: seconds of the first diagram to keep before the trace arrives (all of it unless said).
FIRST = float(os.environ.get('FIRST', 0)) or None
SEGMENTS = [
    (START, at('sticky note'), 1.4),            # step 1, then the trace arrives
] if not FIRST else [
    (START, START + FIRST, 1.4),
    (at('sticky note') - 0.5, at('sticky note'), 1.4),
]
SEGMENTS += [
    (at('sticky note'), at('said yes'), 1.0),   # the note, the question, the answer typed
    (at('said yes'), at('proposal drawn'), 3.0),  # Claude works on it
    (at('proposal drawn'), at('settled'), 1.3),
    (at('settled'), at('wrap up'), 1.15),       # zoom, pan, back and forth
    (at('wrap up'), at('wrapped up'), 2.5),     # Claude writes the summary
    (at('wrapped up'), end, 1.0),
]
CAPTIONS = [
    (START, at('sticky note'), 'Claude walks you through it, one diagram per step'),
    (at('sticky note'), at('said yes'), 'The trace shows the problem. The fix waits on a sticky note'),
    (at('said yes'), at('settled'), 'You answer on the board, and Claude draws the proposal'),
    (at('settled'), at('wrap up'), 'Zoom, pan, and step through the diagrams'),
    (at('wrap up'), end, 'Wrap up: the summary lands in Claude Code, and the page closes'),
]
SEGMENTS = [(a, b, s * SPEED) for a, b, s in SEGMENTS]
CARD = 2.2 / SPEED

def out_time(t):
    acc = 0.0
    t = max(t, START)
    for a, b, s in SEGMENTS:
        if t <= a: return acc
        if t < b: return acc + (t - a) / s
        acc += (b - a) / s
    return acc

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

def caption(text):
    im = Image.new('RGB', (W, BAR), BAR_BG)
    dd = ImageDraw.Draw(im)
    f = font(round(36 * W / 1440))
    dd.text(((W - dd.textlength(text, font=f)) / 2, BAR / 2), text, font=f, fill='white', anchor='lm')
    return im

caps = []
for i, (a, b, text) in enumerate(CAPTIONS):
    caption(text).save(f'{TMP}/cap{i}.png')
    caps.append((f'{TMP}/cap{i}.png', out_time(a) + CARD, out_time(b) + CARD))

parts = [f'[0:v]trim={a:.3f}:{b:.3f},setpts=(PTS-STARTPTS)/{s}[s{i}]' for i, (a, b, s) in enumerate(SEGMENTS)]  # speeds already include SPEED
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
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '10', '-preset', 'slow', '-an', f'{OUT}/whiteboard-demo.mp4'], check=True)


def redact(im, k):
    """
    Blurs a Terminal frame's title bar (the user's name) and, while the
    banner's mascot shows, its account and path lines. k: pixels per point.
    """
    box = lambda *b: tuple(round(v * k) for v in b)
    boxes = [box(0, 0, im.width / k, 32)]
    r, g, b = im.getpixel(box(40, 70))[:3]
    if r > 180 and 90 < g < 150 and b < 120:
        boxes.append(box(84, 52, 600, 102))
    for b in boxes:
        im.paste(im.crop(b).filter(ImageFilter.GaussianBlur(6 * k)), b)
    return im

def terminal_frame(im, clip, k, is_marked=False):
    """One Terminal frame on the stage: its title bar and the lines in `crop` (points), enlarged, with the caption."""
    y0, y1 = (round(v * k) for v in clip['crop'])
    bar = round(32 * k)
    win = Image.new('RGB', (im.width, bar + y1 - y0))
    win.paste(im.crop((0, 0, im.width, bar)), (0, 0))
    win.paste(im.crop((0, y0, im.width, y1)), (0, bar))
    if is_marked and 'mark' in clip:
        m0, m1 = (round(v * k) for v in clip['mark'])
        ImageDraw.Draw(win).rounded_rectangle((6 * k, bar + m0 - y0 - 4 * k, im.width - 6 * k, bar + m1 - y0 + 4 * k),
                                              radius=6 * k, outline='#f5b544', width=round(3 * k))
    scale = min((W - 60) / win.width, (H - 60) / win.height)
    win = win.resize((round(win.width * scale), round(win.height * scale)), Image.LANCZOS)
    frame = Image.new('RGB', (W, H + BAR), STAGE)
    frame.paste(win, ((W - win.width) // 2, (H - win.height) // 2))
    frame.paste(caption(clip['caption']), (0, H))
    return frame

def terminal_clip(clip, name):
    """
    The Terminal from `from` to `to` (`start`, `end`, or a recorder mark, plus
    `plus` seconds), sped up `speed` times, its last frame held `hold`
    seconds with the line at `mark` outlined.
    """
    shots = sorted((int(n[:-4]) / 1000, n) for n in os.listdir(TERM) if n.endswith('.jpg'))
    when = lambda key, plus: (shots[0][0] if key == 'start' else shots[-1][0] if key == 'end' else marks[key]) + plus
    a, b = when(clip['from'], clip.get('from_plus', 0)), when(clip['to'], clip.get('plus', 0))
    picked = [(t, n) for t, n in shots if a <= t <= b]
    k = clip.get('scale', 2)
    os.makedirs(f'{TMP}/{name}', exist_ok=True)
    with open(f'{TMP}/{name}.txt', 'w') as f:
        for i, (t, n) in enumerate(picked):
            is_last = i == len(picked) - 1
            im = redact(Image.open(f'{TERM}/{n}').convert('RGB'), k)
            terminal_frame(im, clip, k, is_marked=is_last).save(f'{TMP}/{name}/{i:05d}.png')
            hold = clip.get('hold', 1.0) if is_last else (picked[i + 1][0] - t) / clip.get('speed', 1)
            f.write(f"file '{TMP}/{name}/{i:05d}.png'\nduration {hold / SPEED:.4f}\n")
        f.write(f"file '{TMP}/{name}/{len(picked) - 1:05d}.png'\n")
    subprocess.run([FF, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{TMP}/{name}.txt',
                    '-vf', 'fps=30,format=yuv420p,setsar=1', '-c:v', 'libx264', '-crf', '10', f'{TMP}/{name}.mp4'], check=True)
    return f'{TMP}/{name}.mp4'

def seconds_of(clip):
    return float(subprocess.run([FF.replace('ffmpeg', 'ffprobe'), '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', clip],
                                capture_output=True, text=True).stdout)

def join(clips, out, fade=0.3):
    """The clips one after another, each crossfading into the next."""
    inputs, chain, prev, total = [], [], '0:v', 0.0
    for i, clip in enumerate(clips):
        inputs += ['-i', clip]
        d = seconds_of(clip)
        if i:
            chain.append(f'[{prev}][{i}:v]xfade=transition=fade:duration={fade}:offset={total - fade:.3f}[x{i}]')
            prev, total = f'x{i}', total + d - fade
        else:
            total = d
    with open(f'{TMP}/join.txt', 'w') as f: f.write(';'.join(chain))
    subprocess.run([FF, '-y', '-loglevel', 'error', *inputs, '-filter_complex_script', f'{TMP}/join.txt', '-map', f'[{prev}]',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '10', out], check=True)

demo = f'{OUT}/whiteboard-demo.mp4'
if TERM:
    # clips.json beside the frames: the Terminal clip that goes after the
    # title card (`after: title`) and the one at the end (`after: end`).
    clips = json.load(open(f'{TERM}/clips.json'))
    made = {c['after']: terminal_clip(c, f"term-{c['after']}") for c in clips}
    title, board = f'{TMP}/title-cut.mp4', f'{TMP}/board-cut.mp4'
    subprocess.run([FF, '-y', '-loglevel', 'error', '-i', demo, '-t', f'{CARD:.3f}', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '10', title], check=True)
    subprocess.run([FF, '-y', '-loglevel', 'error', '-ss', f'{CARD:.3f}', '-i', demo, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '10', board], check=True)
    demo = f'{OUT}/whiteboard-demo-terminal.mp4'
    join([title] + ([made['title']] if 'title' in made else []) + [board] + ([made['end']] if 'end' in made else []), demo)

# The README's GIF: smaller, 12 fps, one palette for the whole clip.
gif = f'{OUT}/whiteboard.gif'
vf = f'fps=12,scale={GIF_W}:-1:flags=lanczos'
subprocess.run([FF, '-y', '-loglevel', 'error', '-i', demo, '-vf', f'{vf},palettegen=max_colors=128:stats_mode=diff', f'{TMP}/palette.png'], check=True)
subprocess.run([FF, '-y', '-loglevel', 'error', '-i', demo, '-i', f'{TMP}/palette.png',
                '-lavfi', f'{vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif], check=True)
dur = float(subprocess.run([FF.replace('ffmpeg', 'ffprobe'), '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', demo], capture_output=True, text=True).stdout)
print(json.dumps({'duration': round(dur, 1), 'gif_mb': round(os.path.getsize(gif) / 1e6, 1)}))
