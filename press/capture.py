"""Capture marketing screenshots of Book Reader at exactly 600x600.

Drives the live preview through key screens via D-pad keys, saving a PNG per
state. Skips animations and ensures consistent first-launch state by clearing
localStorage between runs.
"""
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

URL = "http://localhost:5180/"
OUT = Path(__file__).parent
SHOTS = []


def shot(page, name, wait=0.4):
    time.sleep(wait)
    p = OUT / f"{name}.png"
    page.screenshot(path=str(p), clip={"x": 0, "y": 0, "width": 600, "height": 600})
    SHOTS.append(p.name)
    print(f"saved {p.name}")


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 600, "height": 600})
        page = ctx.new_page()

        # Fresh state: clear localStorage so Continue Reading card doesn't show in the home shot.
        # Then re-seed with one recent book so we have a meaningful Home for a second variant.
        page.goto(URL)
        page.evaluate("localStorage.clear()")
        page.reload()
        page.wait_for_selector("#home:not(.hidden)")

        # 1) Home — first launch, no Continue Reading card (clean intro)
        shot(page, "01-home-first-launch", wait=0.8)

        # 2) Browse → Popular
        page.click('[data-action="go-browse"]')
        page.wait_for_selector(".book-item", timeout=15000)
        shot(page, "02-browse-popular", wait=0.6)

        # 3) Browse → Mystery (showcases topic filter + bundled catalog)
        page.click('[data-tab="mystery"]')
        shot(page, "03-browse-mystery", wait=0.4)

        # 4) Book detail (Dracula)
        page.click('[data-tab="popular"]')
        page.wait_for_selector('[data-book-id="345"]', timeout=10000)
        page.click('[data-book-id="345"]')
        page.wait_for_selector("#book-detail:not(.hidden)")
        page.wait_for_timeout(2500)  # allow metadata to populate
        shot(page, "04-book-detail", wait=0.4)

        # 5) Reader — open the book and let it paginate
        page.click('[data-action="open-book"]')
        page.wait_for_function(
            "document.getElementById('reader-page-num').textContent !== '—'",
            timeout=25000
        )
        # Skip past front-matter to a real prose page for a nicer screenshot
        for _ in range(8):
            page.keyboard.press("ArrowRight")
        shot(page, "05-reader", wait=0.6)

        # 6) Reader menu (text size controls)
        page.keyboard.press("ArrowDown")
        page.wait_for_selector("#reader-menu:not(.hidden)")
        shot(page, "06-reader-menu", wait=0.4)
        page.keyboard.press("Escape")  # close menu

        # 7) Home with Continue Reading (after reading a bit)
        page.keyboard.press("Escape")  # exit reader
        page.keyboard.press("Escape")  # leave detail
        page.keyboard.press("Escape")  # leave browse → home
        page.wait_for_selector("#home:not(.hidden)")
        shot(page, "07-home-with-recent", wait=0.6)

        browser.close()

    print("\nAll screenshots saved to", OUT)


if __name__ == "__main__":
    main()
