#!/usr/bin/env python3
"""
LinkedIn Job Scraper Module.

Provides async scraping functionality for LinkedIn job pages using Playwright
with stealth mode to bypass anti-bot detection.

Usage:
    from scraper import scrape_job, LinkedInJob

    job = await scrape_job("https://www.linkedin.com/jobs/view/123456789/")
    print(job.title, job.company)

Requirements:
    - playwright install chromium
    - playwright-stealth
    - Valid LinkedIn session in browser profile
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Optional

logger = logging.getLogger(__name__)

# Type checking imports
if TYPE_CHECKING:
    from playwright.async_api import BrowserContext, Page, Playwright as AsyncPlaywright


# ============================================================================
# Configuration
# ============================================================================

LINKEDIN_PROFILE_DIR = os.path.expanduser("~/.config/linkedin_browser_profile")

# Human-like delays (seconds) - min, max
DELAYS = {
    "page_load": (3, 6),
    "before_action": (1, 3),
    "after_action": (2, 4),
    "between_checks": (0.5, 1.5),
}

# Job page selectors (multiple fallbacks for robustness)
SELECTORS = {
    "title": [
        "h1.job-details-jobs-unified-top-card__job-title",
        "h1.topcard__title",
        "h1.jobs-unified-top-card__job-title",
        "h1[class*='job-title']",
        ".job-details-jobs-unified-top-card__job-title a",
        "h1",
    ],
    "company": [
        ".job-details-jobs-unified-top-card__company-name a",
        ".topcard__org-name-link",
        ".jobs-unified-top-card__company-name a",
        "[class*='company-name'] a",
        ".job-details-jobs-unified-top-card__company-name",
    ],
    "location": [
        ".job-details-jobs-unified-top-card__bullet",
        ".topcard__flavor--bullet",
        ".jobs-unified-top-card__bullet",
        "[class*='location']",
    ],
    "work_type": [
        ".job-details-jobs-unified-top-card__workplace-type",
        "[class*='workplace-type']",
        "[class*='work-type']",
    ],
    "posted_date": [
        ".job-details-jobs-unified-top-card__posted-date",
        ".jobs-unified-top-card__posted-date",
        "[class*='posted-date']",
        "time",
    ],
    "applicants": [
        ".job-details-jobs-unified-top-card__applicant-count",
        ".jobs-unified-top-card__applicant-count",
        "[class*='applicant']",
    ],
    "description": [
        ".jobs-description__content",
        ".jobs-description-content__text",
        "#job-details",
        "[class*='description']",
    ],
    "skills": [
        ".job-details-how-you-match__skills-item-subtitle",
        ".jobs-unified-top-card__job-insight",
        "[class*='skill']",
    ],
    "easy_apply_button": [
        "button.jobs-apply-button",
        'button[aria-label*="Easy Apply"]',
        'button:has-text("Easy Apply")',
        ".jobs-apply-button--top-card",
    ],
    "external_apply_button": [
        'a.jobs-apply-button[href*="applyUrl"]',
        'a[aria-label*="Apply"]',
        'a:has-text("Apply")',
    ],
    "job_content": [
        ".jobs-unified-top-card",
        ".job-view-layout",
        ".scaffold-layout__main",
    ],
    "logged_in_indicators": [
        ".global-nav__me",
        ".global-nav__me-photo",
        ".global-nav__primary-items",
        '[data-test-global-nav-link="jobs"]',
        ".jobs-apply-button",
        'button[aria-label*="Save"]',
        'nav[aria-label="Primary"]',
    ],
}

# ATS detection patterns
ATS_PATTERNS = {
    "greenhouse": ["greenhouse.io", "boards.greenhouse.io"],
    "lever": ["lever.co", "jobs.lever.co"],
    "workday": ["myworkdayjobs.com", "wd1.myworkdayjobs.com", "wd3.myworkdayjobs.com"],
    "smartrecruiters": ["smartrecruiters.com"],
    "ashby": ["ashbyhq.com"],
    "bamboohr": ["bamboohr.com"],
    "icims": ["icims.com"],
    "taleo": ["taleo.net"],
    "successfactors": ["successfactors.com"],
}


# ============================================================================
# Exceptions
# ============================================================================


class LinkedInScraperError(Exception):
    """Base exception for LinkedIn scraper errors."""

    def __init__(self, message: str, url: Optional[str] = None):
        super().__init__(message)
        self.url = url


class JobNotFoundError(LinkedInScraperError):
    """Raised when the job page cannot be found (404, removed, etc.)."""

    pass


class SessionExpiredError(LinkedInScraperError):
    """Raised when the LinkedIn session has expired and login is required."""

    pass


class RateLimitError(LinkedInScraperError):
    """Raised when LinkedIn rate limits the scraper."""

    def __init__(self, message: str, url: Optional[str] = None, retry_after: int = 60):
        super().__init__(message, url)
        self.retry_after = retry_after


class ScraperTimeoutError(LinkedInScraperError):
    """Raised when scraping times out."""

    pass


# Import the SDK error so the local alias can be caught from both
# hierarchies (see #93 spec S3a). MRO is left-first, so __init__ resolves
# to LinkedInScraperError(message, url=None) — instances raised by the SDK
# launcher will carry self.url=None, which is harmless but non-obvious.
from roxabi_sdk.browser import (  # noqa: E402
    PlaywrightNotAvailableError as _SdkPlaywrightNotAvailableError,
    close_stealth_async as _sdk_close_stealth_async,
    launch_stealth_async as _sdk_launch_stealth_async,
)


class PlaywrightNotAvailableError(
    LinkedInScraperError, _SdkPlaywrightNotAvailableError
):
    """Alias error catchable from both LinkedIn and SDK exception hierarchies.

    Allows ``except PlaywrightNotAvailableError`` and
    ``except LinkedInScraperError`` clauses to both catch the same instance,
    so existing LinkedIn callers keep working while cross-cutting SDK
    callers (e.g. dashboards that aggregate browser-bootstrap failures)
    can also handle it uniformly with web-intel.

    ``self.url`` will be ``None`` for errors raised by the SDK launcher
    (the SDK does not know which URL the caller was about to fetch).
    """


# ============================================================================
# Data Models
# ============================================================================


@dataclass
class LinkedInJob:
    """Job data extracted from LinkedIn."""

    job_id: str
    url: str
    title: str
    company: str
    company_url: Optional[str] = None
    location: str = ""
    work_type: str = ""  # Remote, Hybrid, On-site
    contract_type: str = ""  # Full-time, Contract, etc.
    experience_level: str = ""
    posted_date: str = ""
    applicants_count: Optional[int] = None
    description: str = ""
    skills: list[str] = field(default_factory=list)
    salary_range: Optional[str] = None
    is_easy_apply: bool = False
    external_url: Optional[str] = None
    ats_type: Optional[str] = None  # greenhouse, lever, workday, etc.
    scraped_at: str = field(default_factory=lambda: datetime.now().isoformat())


# ============================================================================
# Utilities
# ============================================================================


async def human_delay(delay_type: str) -> None:
    """Add human-like random delay."""
    min_d, max_d = DELAYS.get(delay_type, (1, 2))
    delay = random.uniform(min_d, max_d)
    logger.debug(f"Human delay ({delay_type}): {delay:.2f}s")
    await asyncio.sleep(delay)


def extract_job_id(url: str) -> Optional[str]:
    """Extract job ID from LinkedIn URL."""
    patterns = [
        r"/jobs/view/(\d+)",
        r"/jobs/(\d+)",
        r"currentJobId=(\d+)",
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return None


def detect_ats(url: str) -> Optional[str]:
    """Detect ATS type from external URL."""
    url_lower = url.lower()
    for ats, patterns in ATS_PATTERNS.items():
        if any(p in url_lower for p in patterns):
            return ats
    return None


def validate_linkedin_url(url: str) -> bool:
    """Validate that URL is a LinkedIn job URL."""
    return "linkedin.com" in url and ("/jobs/view/" in url or "/jobs/" in url)


# ============================================================================
# Browser Management
# ============================================================================


async def get_browser_context(
    headless: bool = False,
) -> tuple[AsyncPlaywright, BrowserContext, Page]:
    """Create a stealth-patched persistent LinkedIn browser context.

    Delegates to :func:`roxabi_sdk.browser.launch_stealth_async` with the
    LinkedIn profile directory. Returns ``(playwright, context, page)`` — the
    caller owns the lifecycle and must call
    :func:`roxabi_sdk.browser.close_stealth_async` when done.

    Raises:
        PlaywrightNotAvailableError: If playwright or playwright-stealth is
            not installed (catchable as :class:`LinkedInScraperError` too).
    """
    try:
        playwright, context, page = await _sdk_launch_stealth_async(
            user_data_dir=LINKEDIN_PROFILE_DIR,
            headless=headless,
        )
    except _SdkPlaywrightNotAvailableError as exc:
        raise PlaywrightNotAvailableError(str(exc)) from exc

    logger.info("Browser context created with stealth mode")
    return playwright, context, page


async def check_login(page: "Page") -> bool:
    """Check if user is logged into LinkedIn."""
    for selector in SELECTORS["logged_in_indicators"]:
        try:
            el = await page.query_selector(selector)
            if el:
                logger.debug(f"Logged in indicator found: {selector}")
                return True
        except Exception:
            continue

    # Check URL - if on job page and not redirected to login
    try:
        current_url = page.url
        if "/jobs/view/" in current_url and "/login" not in current_url:
            # Check for job content
            for selector in SELECTORS["job_content"]:
                el = await page.query_selector(selector)
                if el:
                    return True
    except Exception:
        pass

    return False


async def try_selector(page: "Page", selectors: list[str], timeout: int = 5000) -> Optional[Any]:
    """Try multiple selectors and return first match."""
    for selector in selectors:
        try:
            el = await page.wait_for_selector(selector, timeout=timeout)
            if el:
                logger.debug(f"Found element with selector: {selector}")
                return el
        except Exception:
            continue
    return None


async def get_text_from_selectors(page: "Page", selectors: list[str]) -> str:
    """Get text content from first matching selector."""
    el = await try_selector(page, selectors, timeout=3000)
    if el:
        text = await el.inner_text()
        return text.strip()
    return ""


# ============================================================================
# Main Scraping Function
# ============================================================================


async def scrape_job(
    url: str,
    headless: bool = False,
    timeout: int = 30000,
) -> LinkedInJob:
    """
    Scrape job data from a LinkedIn job page.

    Uses Playwright with stealth mode and persistent browser profile
    to bypass anti-bot detection.

    Args:
        url: LinkedIn job URL (e.g., https://www.linkedin.com/jobs/view/123456789/)
        headless: Run browser in headless mode (default False for reliability)
        timeout: Page load timeout in milliseconds (default 30000)

    Returns:
        LinkedInJob dataclass with extracted job data

    Raises:
        JobNotFoundError: Job page not found or removed
        SessionExpiredError: LinkedIn session expired, login required
        RateLimitError: Rate limited by LinkedIn
        ScraperTimeoutError: Page load or scraping timeout
        PlaywrightNotAvailableError: Playwright not installed
    """
    # Validate URL
    if not validate_linkedin_url(url):
        raise LinkedInScraperError(f"Invalid LinkedIn job URL: {url}", url)

    job_id = extract_job_id(url) or "unknown"
    logger.info(f"Scraping job: {url} (ID: {job_id})")

    playwright = None
    context = None

    try:
        # Get browser context + stealth-patched page from SDK
        playwright, context, page = await get_browser_context(headless=headless)

        # Navigate to job page
        logger.debug("Navigating to job page...")
        try:
            await page.goto(url, timeout=timeout)
        except Exception as e:
            if "net::ERR_" in str(e):
                raise ScraperTimeoutError(f"Network error loading page: {e}", url)
            raise

        await human_delay("page_load")

        # Check for rate limiting (429 or captcha page)
        current_url = page.url
        if "checkpoint" in current_url or "challenge" in current_url:
            raise RateLimitError("LinkedIn rate limit or captcha detected", url, retry_after=120)

        # Check for login redirect
        if "/login" in current_url or "/authwall" in current_url:
            raise SessionExpiredError("LinkedIn session expired, please log in manually", url)

        # Check if logged in
        if not await check_login(page):
            raise SessionExpiredError("Not logged into LinkedIn, please log in manually", url)

        # Wait for job content to load
        logger.debug("Waiting for job content...")
        content_el = await try_selector(page, SELECTORS["job_content"], timeout=15000)
        if not content_el:
            # Check if job was removed or doesn't exist
            page_text = await page.inner_text("body")
            if "no longer available" in page_text.lower():
                raise JobNotFoundError("Job is no longer available", url)
            if "page not found" in page_text.lower():
                raise JobNotFoundError("Job page not found", url)
            logger.warning("Job content took long to load, continuing anyway...")

        await human_delay("after_action")

        # Extract basic info
        logger.debug("Extracting job data...")
        title = await get_text_from_selectors(page, SELECTORS["title"])
        company = await get_text_from_selectors(page, SELECTORS["company"])
        location = await get_text_from_selectors(page, SELECTORS["location"])
        work_type = await get_text_from_selectors(page, SELECTORS["work_type"])
        posted_date = await get_text_from_selectors(page, SELECTORS["posted_date"])
        applicants_text = await get_text_from_selectors(page, SELECTORS["applicants"])

        # Parse applicants count
        applicants_count = None
        if applicants_text:
            match = re.search(r"(\d+)", applicants_text.replace(",", ""))
            if match:
                applicants_count = int(match.group(1))

        # Get company URL
        company_url = None
        company_el = await try_selector(page, SELECTORS["company"], timeout=2000)
        if company_el:
            company_url = await company_el.get_attribute("href")

        # Get description
        description = await get_text_from_selectors(page, SELECTORS["description"])

        # Get skills
        skills = []
        skills_els = await page.query_selector_all(
            ".job-details-how-you-match__skills-item-subtitle"
        )
        for el in skills_els:
            skill = await el.inner_text()
            skill = skill.strip()
            if skill:
                skills.append(skill)

        # Detect application type
        is_easy_apply = False
        external_url = None
        ats_type = None

        # Check for Easy Apply button
        easy_apply_el = await try_selector(page, SELECTORS["easy_apply_button"], timeout=3000)
        if easy_apply_el:
            button_text = await easy_apply_el.inner_text()
            if "easy apply" in button_text.lower():
                is_easy_apply = True
                logger.info("Easy Apply detected")

        # Check for external apply
        if not is_easy_apply:
            external_el = await try_selector(page, SELECTORS["external_apply_button"], timeout=2000)
            if external_el:
                external_url = await external_el.get_attribute("href")
                if external_url:
                    ats_type = detect_ats(external_url)
                    logger.info(f"External apply: {external_url} (ATS: {ats_type})")

        job = LinkedInJob(
            job_id=job_id,
            url=url,
            title=title,
            company=company,
            company_url=company_url,
            location=location,
            work_type=work_type,
            posted_date=posted_date,
            applicants_count=applicants_count,
            description=description[:5000] if description else "",  # Limit size
            skills=skills,
            is_easy_apply=is_easy_apply,
            external_url=external_url,
            ats_type=ats_type,
        )

        logger.info(
            f"Scraped: {job.title} at {job.company} "
            f"({'Easy Apply' if job.is_easy_apply else 'External'})"
        )

        return job

    finally:
        if playwright and context:
            try:
                await _sdk_close_stealth_async(playwright, context)
            except Exception as e:
                logger.warning(f"Error during browser cleanup: {e}")


async def scrape_job_with_retry(
    url: str,
    max_retries: int = 3,
    headless: bool = False,
) -> LinkedInJob:
    """
    Scrape job with automatic retry on transient errors.

    Args:
        url: LinkedIn job URL
        max_retries: Maximum number of retry attempts
        headless: Run browser in headless mode

    Returns:
        LinkedInJob dataclass with extracted job data

    Raises:
        LinkedInScraperError: After all retries exhausted
    """
    last_error = None

    for attempt in range(max_retries):
        try:
            return await scrape_job(url, headless=headless)

        except RateLimitError as e:
            last_error = e
            if attempt < max_retries - 1:
                wait_time = e.retry_after * (attempt + 1)
                logger.warning(
                    f"Rate limited, waiting {wait_time}s before retry "
                    f"({attempt + 1}/{max_retries})"
                )
                await asyncio.sleep(wait_time)
            continue

        except ScraperTimeoutError as e:
            last_error = e
            if attempt < max_retries - 1:
                wait_time = 5 * (attempt + 1)
                logger.warning(
                    f"Timeout, waiting {wait_time}s before retry "
                    f"({attempt + 1}/{max_retries})"
                )
                await asyncio.sleep(wait_time)
            continue

        except (JobNotFoundError, SessionExpiredError, PlaywrightNotAvailableError):
            # Non-retryable errors
            raise

    raise last_error or LinkedInScraperError("Max retries exceeded", url)


# ============================================================================
# CLI Entry Point
# ============================================================================


async def main():
    """CLI interface for testing."""
    import json
    from dataclasses import asdict

    logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")

    if len(sys.argv) < 2:
        print("Usage: python scraper.py <linkedin_job_url>")
        print()
        print("Example:")
        print("  python scraper.py https://www.linkedin.com/jobs/view/123456789/")
        sys.exit(1)

    url = sys.argv[1]

    try:
        job = await scrape_job(url)
        print(json.dumps(asdict(job), indent=2, ensure_ascii=False, default=str))
    except LinkedInScraperError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
