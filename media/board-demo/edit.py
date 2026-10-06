# Edits a recording of the board (recorder.mjs: frames, their timestamps and
# the recorder's marks) into the README's demo: a title card, the session with
# the waits sped up, and one caption per step under it. Writes an MP4 and a
# GIF. Needs Python 3 with Pillow, and ffmpeg.
#
#   python3 media/board-demo/edit.py <recording dir> <out dir> [terminal dir]
#
# With a terminal dir (snapshots of the session's Terminal window during the
# take, named <epoch ms>.jpg), the demo shows where the board comes from: the
# prompt in Claude Code, the board opening; the answer typed on the board
# arriving in the session; and the summary landing there at the end.
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
# The frames' own size (an even one, for the encoder): the board alone, or split.py's composite.
W, H = (v - v % 2 for v in Image.open(f"{REC}/frames/{frames[0]['n']:05d}.jpg").size)
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
    (0.0, at('sticky note'), 1.4),              # step 1, then the trace arrives
    (at('sticky note'), at('said yes'), 1.0),   # the note, the question, the answer typed
    (at('said yes'), at('proposal drawn'), 3.0),  # Claude works on it
    (at('proposal drawn'), at('settled'), 1.3),
    (at('settled'), at('wrap up'), 1.15),       # zoom, pan, back and forth
    (at('wrap up'), at('wrapped up'), 2.5),     # Claude writes the summary
    (at('wrapped up'), end, 1.0),
]
CAPTIONS = [
    (0.0, at('sticky note'), 'Claude walks you through it, one diagram per step'),
    (at('sticky note'), at('said yes'), 'The trace shows the problem. The fix waits on a sticky note'),
    (at('said yes'), at('settled'), 'You answer on the board, and Claude draws the proposal'),
    (at('settled'), at('wrap up'), 'Zoom, pan, and step through the diagrams'),
    (at('wrap up'), end, 'Wrap up: the summary lands in Claude Code, and the page closes'),
]
SEGMENTS = [(a, b, s * SPEED) for a, b, s in SEGMENTS]
CARD = 2.2 / SPEED

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
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow', '-an', f'{OUT}/whiteboard-demo.mp4'], check=True)


def redact(im):
    """Blurs a Terminal snapshot's title bar (the user's name) and, while the banner's mascot shows, its account and path lines."""
    boxes = [(0, 0, im.width, 32)]
    r, g, b = im.getpixel((40, 70))[:3]
    if r > 180 and 90 < g < 150 and b < 120:
        boxes.append((84, 52, min(im.width, 600), 102))
    for box in boxes:
        im.paste(im.crop(box).filter(ImageFilter.GaussianBlur(6)), box)
    return im

def terminal_still(im, slide, name):
    """
    A Terminal snapshot as a clip of its own: its title bar and the lines
    from `crop` (y from, y to), enlarged to fit, the line at `mark` (y from,
    y to) outlined, with its caption under it.
    """
    y0, y1 = slide.get('crop', (32, im.height))
    win = Image.new('RGB', (im.width, 32 + y1 - y0))
    win.paste(im.crop((0, 0, im.width, 32)), (0, 0))
    win.paste(im.crop((0, y0, im.width, y1)), (0, 32))
    if 'mark' in slide:
        m0, m1 = slide['mark']
        ImageDraw.Draw(win).rounded_rectangle((6, 32 + m0 - y0 - 4, im.width - 6, 32 + m1 - y0 + 4), radius=6, outline='#f5b544', width=3)
    scale = min((W - 60) / win.width, (H - 60) / win.height)
    win = win.resize((round(win.width * scale), round(win.height * scale)), Image.LANCZOS)
    frame = Image.new('RGB', (W, H + BAR), '#e7eaf0')
    frame.paste(win, ((W - win.width) // 2, (H - win.height) // 2))
    frame.paste(caption(slide['caption']), (0, H))
    frame.save(f'{TMP}/{name}.png')
    subprocess.run([FF, '-y', '-loglevel', 'error', '-loop', '1', '-t', f"{slide['seconds'] / SPEED:.2f}", '-i', f'{TMP}/{name}.png',
                    '-vf', 'fps=30,format=yuv420p,setsar=1', '-c:v', 'libx264', '-crf', '18', f'{TMP}/{name}.mp4'], check=True)
    return f'{TMP}/{name}.mp4'

demo = f'{OUT}/whiteboard-demo.mp4'
if TERM:
    # slides.json beside the snapshots: which snapshot each slide shows and
    # where it goes: `after` the title card, after a recorder mark plus a
    # second (the answer sent), or at the `end`.
    slides = json.load(open(f'{TERM}/slides.json'))
    cuts, clips = {}, []
    for i, slide in enumerate(slides):
        im = redact(Image.open(f"{TERM}/{slide['file']}").convert('RGB'))
        if 'clear' in slide:
            # The snapshot as it was earlier: the lines after `clear` (y) not written yet.
            ImageDraw.Draw(im).rectangle((0, slide['clear'], im.width, im.height - 70), fill=im.getpixel((im.width // 2, im.height - 120)))
        cut = CARD if slide['after'] == 'title' else None if slide['after'] == 'end' else out_time(at(slide['after']) + 1.0) + CARD
        cuts.setdefault(cut, []).append(terminal_still(im, slide, f'term-{i}'))
    times = sorted(t for t in cuts if t is not None)
    pieces = []
    for i, (a, b) in enumerate(zip([0.0] + times, times + [None])):
        piece = f'{TMP}/board-{i}.mp4'
        span = ['-ss', f'{a:.3f}'] + (['-t', f'{b - a:.3f}'] if b else [])
        subprocess.run([FF, '-y', '-loglevel', 'error', '-i', demo, *span, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', piece], check=True)
        pieces.append(piece)
    order = []
    for i, piece in enumerate(pieces):
        order.append(piece)
        order += cuts[times[i]] if i < len(times) else cuts.get(None, [])
    with open(f'{TMP}/all.txt', 'w') as f:
        f.writelines(f"file '{p}'\n" for p in order)
    demo = f'{OUT}/whiteboard-demo-terminal.mp4'
    subprocess.run([FF, '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', f'{TMP}/all.txt', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', demo], check=True)

# The README's GIF: smaller, 12 fps, one palette for the whole clip.
gif = f'{OUT}/whiteboard.gif'
vf = f'fps=12,scale={GIF_W}:-1:flags=lanczos'
subprocess.run([FF, '-y', '-loglevel', 'error', '-i', demo, '-vf', f'{vf},palettegen=max_colors=128:stats_mode=diff', f'{TMP}/palette.png'], check=True)
subprocess.run([FF, '-y', '-loglevel', 'error', '-i', demo, '-i', f'{TMP}/palette.png',
                '-lavfi', f'{vf}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', gif], check=True)
dur = float(subprocess.run([FF.replace('ffmpeg', 'ffprobe'), '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', demo], capture_output=True, text=True).stdout)
print(json.dumps({'duration': round(dur, 1), 'gif_mb': round(os.path.getsize(gif) / 1e6, 1)}))
