"""Renders the graphics overlay page (as OBS's Browser Source would) to a transparent PNG.
Usage: python3 render-graphics.py <overlay-url> <out.png>"""
import sys
from playwright.sync_api import sync_playwright

url, out = sys.argv[1], sys.argv[2]
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1920, "height": 1080})
    page.goto(url)
    page.wait_for_function("window.__graphicsState !== undefined", timeout=10000)
    page.wait_for_timeout(900)  # let the slide-in transitions finish
    page.screenshot(path=out, omit_background=True)
    browser.close()
