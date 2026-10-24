"""Screenshots a page (the public watch page) as a phone-and-desktop pair.
Usage: python3 render-page.py <url> <out.png>"""
import sys
from playwright.sync_api import sync_playwright

url, out = sys.argv[1], sys.argv[2]
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 860})
    page.goto(url)
    page.wait_for_selector("table, .empty", timeout=15000)
    page.wait_for_timeout(1500)
    page.screenshot(path=out, full_page=True)
    browser.close()
