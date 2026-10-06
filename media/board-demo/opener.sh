#!/bin/sh
# BROWSER for a recording: hands the board's URL to recorder.mjs instead of
# opening it. Set REC to the recording's folder.
printf '%s' "$1" > "$REC/url.txt"
