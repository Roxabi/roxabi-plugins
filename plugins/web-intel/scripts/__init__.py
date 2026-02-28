"""
Scraper skill - Content extraction from various URL types.

Main interface:
    from scraper import scrape_content

    result = scrape_content("https://x.com/user/status/123")
"""

from .scraper import scrape_content

__all__ = ["scrape_content"]
