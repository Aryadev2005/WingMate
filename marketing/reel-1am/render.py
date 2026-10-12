"""Renders reel.html to a 1080x1920 MP4 at 30fps.

    python3 render.py                 # full video -> wingmate-reel-1am.mp4
    python3 render.py --stills 0,3,8  # preview frames at those seconds
"""
import pathlib, subprocess, sys
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).parent
FPS, DURATION = 30, 20.0
args = sys.argv[1:]

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1080, "height": 1920})
    page.goto((HERE / "reel.html").as_uri())
    page.wait_for_timeout(300)

    if args[:1] == ["--stills"]:
        for s in args[1].split(","):
            page.evaluate(f"render({float(s)})")
            page.screenshot(path=str(HERE / f"still-{s}.png"))
        browser.close()
        sys.exit(0)

    out = HERE / "wingmate-reel-1am.mp4"
    ff = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", str(FPS), "-i", "-",
         "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",  # silent track: Instagram handles audio-less files poorly
         "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "medium", "-crf", "18",
         "-c:a", "aac", "-movflags", "+faststart", str(out)],
        stdin=subprocess.PIPE,
    )
    for i in range(int(FPS * DURATION)):
        page.evaluate(f"render({i / FPS})")
        ff.stdin.write(page.screenshot(type="jpeg", quality=95))
    ff.stdin.close()
    ff.wait()
    browser.close()
    print(out)
