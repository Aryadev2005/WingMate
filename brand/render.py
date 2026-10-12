import pathlib
from playwright.sync_api import sync_playwright
H = pathlib.Path(__file__).parent
mark = (H / "mark.svg").read_text()
BG = "#0E0A16"
def page_html(body, w, h, bg):
    return f"""<html><body style="margin:0;width:{w}px;height:{h}px;background:{bg};display:flex;align-items:center;justify-content:center;font-family:'Inter Display','Inter',sans-serif">{body}</body></html>"""
jobs = {
  # Instagram profile picture: mark sized to sit inside the circular crop
  "wingmate-profile-1080.png": (page_html(f'<div style="width:620px;height:620px">{mark}</div>', 1080, 1080, BG), 1080, 1080),
  # App icon (stores apply their own rounded mask)
  "wingmate-app-icon-1024.png": (page_html(f'<div style="width:640px;height:640px">{mark}</div>', 1024, 1024, BG), 1024, 1024),
  # Horizontal wordmark, dark and light
  "wingmate-wordmark-dark.png": (page_html(f'<div style="display:flex;align-items:center;gap:56px"><div style="width:300px;height:300px">{mark}</div><span style="color:#F4EFFA;font-weight:900;font-size:230px;letter-spacing:-9px">Wingmate</span></div>', 1800, 600, BG), 1800, 600),
  "wingmate-wordmark-light.png": (page_html(f'<div style="display:flex;align-items:center;gap:56px"><div style="width:300px;height:300px">{mark}</div><span style="color:#140F22;font-weight:900;font-size:230px;letter-spacing:-9px">Wingmate</span></div>', 1800, 600, "#FFFFFF"), 1800, 600),
  # Transparent mark for overlays
  "wingmate-mark-transparent.png": (page_html(f'<div style="width:1000px;height:1000px">{mark}</div>', 1024, 1024, "transparent"), 1024, 1024),
}
with sync_playwright() as p:
    b = p.chromium.launch()
    for name, (html, w, h) in jobs.items():
        pg = b.new_page(viewport={"width": w, "height": h})
        pg.set_content(html)
        pg.screenshot(path=str(H / name), omit_background="transparent" in name)
        pg.close()
    b.close()
print("done")
