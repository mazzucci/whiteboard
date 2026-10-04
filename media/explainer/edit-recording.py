# Edits the screen recording into the middle of the demo video: cuts, speeds,
# crops to the app window, places it on the stage background above the
# caption bar, and overlays one caption per step. The segment times are for
# the take recorded on 2026-10-04 (demo/RECORDING.md); a new take needs new
# times. Needs Python 3 with Pillow, and ffmpeg.
#
#   python3 media/explainer/edit-recording.py take.mov out/recording.mp4 build/ [square]
#
# `square` makes the 1080 × 1080 cut for social feeds: the window cropped to
# the whiteboard pane, captions sized to fit.
#
# Then join it between the cards of the 30 s cut (see README.md here).
import json, subprocess, sys
from PIL import Image, ImageDraw, ImageFont

SRC, OUT, TMP = sys.argv[1], sys.argv[2], sys.argv[3]
SQUARE = len(sys.argv) > 4 and sys.argv[4] == 'square'
FF = '/usr/local/bin/ffmpeg'
BG, BAR_BG = '#e7eaf0', '#161b26'
# The window, inside its rounded corners: 2652 × 1744 at (120, 84).
if SQUARE:
    # From the whiteboard pane's left edge: the pane fills the square.
    W, H, BAR, FONT = 1080, 1080, 112, 40
    CROP = '1848:1744:922:84'
else:
    W, H, BAR, FONT = 1920, 1080, 112, 44
    CROP = '2652:1744:120:84'

# (start, end, speed): the waits fast, the drawing and the controls near 1x.
SEGMENTS = [
    (2.0, 3.0, 1.0),     # the prompt is sent (0-2 s show the home screen: cut)
    (3.0, 18.0, 8.0),    # thinking, loading tools, drawing
    (18.0, 25.0, 2.5),   # step 1 appears, the pane widens
    (25.0, 39.0, 7.0),   # reading step 1
    (39.0, 41.5, 1.5),   # "next"
    (41.5, 49.5, 6.0),   # drawing step 2
    (49.5, 52.5, 1.0),   # step 2 appears
    (52.5, 58.0, 5.0),
    (58.0, 65.5, 1.4),   # zoom in, pan, zoom out
    (65.5, 69.5, 3.0),   # "next"
    (69.5, 76.5, 6.0),   # drawing step 3
    (76.5, 79.5, 1.0),   # step 3 appears
    (79.5, 85.0, 3.0),   # the fix stays on screen to the end
]
if SQUARE:
    # The pane opens narrow at 18 s and is widened by 23.5 s; cropped to the
    # pane's edge, those seconds would show the chat cut in half: skip them.
    SEGMENTS = [seg for seg in SEGMENTS if seg[0] != 18.0]
    SEGMENTS.insert(2, (23.5, 25.0, 1.5))

# Captions by source time, mapped onto the edited timeline below.
CAPTIONS = [
    (2.0, 49.5, 'Claude reads the notes and maps the request'),
    (49.5, 58.0, 'The trace: an N+1 inside pricing.quote'),
    (58.0, 65.5, 'Zoom and pan right in the pane'),
    (65.5, 85.0, 'The proposed fix, drawn as a change'),
]

def out_time(t):
    acc = 0.0
    for a, b, s in SEGMENTS:
        if t <= a: return acc
        if t < b: return acc + (t - a) / s
        acc += (b - a) / s
    return acc

total = out_time(SEGMENTS[-1][1])
font = ImageFont.truetype('/System/Library/Fonts/SFNS.ttf', FONT)
try: font.set_variation_by_name('Semibold')
except Exception: pass
caps = []
for i, (a, b, text) in enumerate(CAPTIONS):
    im = Image.new('RGBA', (W, BAR), BAR_BG)
    d = ImageDraw.Draw(im)
    tw = d.textlength(text, font=font)
    d.text(((W - tw) / 2, BAR / 2), text, font=font, fill='white', anchor='lm')
    path = f'{TMP}/cap{i}.png'; im.save(path)
    caps.append((path, out_time(a), out_time(b)))

parts, labels = [], []
for i, (a, b, s) in enumerate(SEGMENTS):
    parts.append(f'[0:v]trim={a}:{b},setpts=(PTS-STARTPTS)/{s}[s{i}]')
    labels.append(f'[s{i}]')
chain = ';'.join(parts) + ';' + ''.join(labels) + f'concat=n={len(SEGMENTS)}:v=1:a=0[cat]'
# Fit the crop into the frame above the caption bar, centred on the background.
chain += (f';[cat]crop={CROP},scale={W}:{H - BAR}:force_original_aspect_ratio=decrease:flags=lanczos,fps=30,'
          f'pad={W}:{H - BAR}:(ow-iw)/2:(oh-ih)/2:{BG},pad={W}:{H}:0:0:{BAR_BG},setsar=1[base]')
prev = 'base'
inputs = ['-i', SRC]
for i, (path, t0, t1) in enumerate(caps):
    inputs += ['-i', path]
    chain += f';[{prev}][{i + 1}:v]overlay=0:{H - BAR}:enable=\'between(t,{t0:.3f},{t1:.3f})\'[c{i}]'
    prev = f'c{i}'
cmd = [FF, '-y', '-loglevel', 'error', *inputs, '-filter_complex', chain, '-map', f'[{prev}]',
       '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'slow', '-an', OUT]
subprocess.run(cmd, check=True)
print(json.dumps({'duration': round(total, 2), 'captions': [(round(t0, 2), round(t1, 2)) for _, t0, t1 in caps]}))
