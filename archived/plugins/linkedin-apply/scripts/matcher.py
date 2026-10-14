#!/usr/bin/env python3
"""
LinkedIn Job Matcher - LLM-based job matching analysis.

Analyzes the correspondence between a LinkedIn job offer and the candidate's profile
using Claude to evaluate fit across multiple dimensions.

Usage:
    from matcher import match_job, MatchResult

    result = await match_job(job, cv_data, criteria)
    print(f"Decision: {result.decision}, Score: {result.global_score}")
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

try:
    from jinja2 import Environment, FileSystemLoader
except ImportError:
    print("Error: jinja2 is not installed.")
    print("Please install it with: pip install jinja2")
    sys.exit(1)

if TYPE_CHECKING:
    from scraper import LinkedInJob

# Setup paths
SCRIPT_DIR = Path(__file__).resolve().parent
PLUGIN_DIR = SCRIPT_DIR.parent
TEMPLATES_DIR = PLUGIN_DIR / "templates"
CONFIG_DIR = PLUGIN_DIR / "config"

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


# ============================================================================
# Data Models
# ============================================================================


@dataclass
class MatchResult:
    """Result of job matching analysis."""

    job_id: str
    passes_dealbreakers: bool
    dealbreaker_issues: list[str] = field(default_factory=list)
    tech_score: int = 0  # /10
    seniority_score: int = 0  # /10
    culture_score: int = 0  # /10
    responsibilities_score: int = 0  # /10
    global_score: float = 0.0
    decision: Literal["APPLY", "REVIEW", "SKIP"] = "SKIP"
    highlights: list[str] = field(default_factory=list)
    expected_questions: list[str] = field(default_factory=list)
    analysis_summary: str = ""


# ============================================================================
# Default Criteria
# ============================================================================

DEFAULT_CRITERIA = {
    "dealbreakers": {
        "required_languages": ["French", "English"],
        "excluded_locations": [],
        "excluded_companies": [],
        "min_remote_days": 0,  # 0 = onsite ok
        "max_travel_percentage": 50,
        "requires_security_clearance": False,
    },
    "weights": {
        "tech_score": 0.25,
        "seniority_score": 0.25,
        "culture_score": 0.20,
        "responsibilities_score": 0.30,
    },
    "thresholds": {
        "apply": 7.0,  # >= 7.0 -> APPLY
        "review": 5.0,  # >= 5.0 -> REVIEW, < 5.0 -> SKIP
    },
    "preferences": {
        "preferred_industries": [
            "SaaS",
            "Tech",
            "Insurance",
            "Finance",
            "Real Estate",
        ],
        "preferred_company_sizes": ["startup", "scaleup", "mid-size"],
        "preferred_methodologies": ["Agile", "Scrum", "Lean"],
    },
}


# ============================================================================
# Template Rendering
# ============================================================================


def create_jinja_environment() -> Environment:
    """Create Jinja2 environment with custom filters."""
    env = Environment(
        loader=FileSystemLoader(TEMPLATES_DIR),
        trim_blocks=True,
        lstrip_blocks=True,
    )
    return env


def render_matching_prompt(
    job: "LinkedInJob",
    cv_data: dict[str, Any],
    criteria: dict[str, Any],
) -> str:
    """Render the matching prompt template with job, CV, and criteria data."""
    env = create_jinja_environment()
    template = env.get_template("matching.md.jinja2")

    # Convert job dataclass to dict if needed
    job_dict = asdict(job) if hasattr(job, "__dataclass_fields__") else job

    return template.render(
        job=job_dict,
        cv=cv_data,
        criteria=criteria,
    )


# ============================================================================
# LLM Interaction
# ============================================================================


def call_claude(prompt: str, timeout: int = 120) -> dict[str, Any]:
    """
    Call Claude CLI with the given prompt and parse JSON response.

    Args:
        prompt: The prompt to send to Claude
        timeout: Timeout in seconds

    Returns:
        Parsed JSON response or error dict
    """
    if not shutil.which("claude"):
        logger.error("Claude CLI not found in PATH")
        return {"error": "Claude CLI not found in PATH"}

    cmd = [
        "claude",
        "-p",
        prompt,
        "--model",
        "sonnet",  # Use Sonnet for cost efficiency
        "--max-turns",
        "1",
        "--output-format",
        "json",
        "--no-session-persistence",
        "--permission-mode",
        "default",
    ]

    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=str(PLUGIN_DIR),
            stdin=subprocess.DEVNULL,
        )

        if result.returncode != 0:
            error = result.stderr or result.stdout or "Unknown error"
            logger.error(f"Claude CLI error: {error[:200]}")
            return {"error": f"CLI error: {error[:200]}"}

        if not result.stdout:
            return {"error": "Empty response from Claude"}

        # Parse Claude response
        try:
            response = json.loads(result.stdout)
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON from Claude: {e}")
            return {"error": f"Invalid JSON: {e}"}

        # Check for errors
        if response.get("is_error"):
            errors = response.get("errors", [])
            return {"error": errors[0] if errors else "Unknown Claude error"}

        result_text = response.get("result", "")
        if not result_text:
            return {"error": "Empty result from Claude"}

        return {"result": result_text}

    except subprocess.TimeoutExpired:
        return {"error": f"Timeout after {timeout}s"}
    except Exception as e:
        return {"error": str(e)}


def parse_match_response(response_text: str, job_id: str) -> MatchResult:
    """
    Parse Claude's response into a MatchResult.

    Args:
        response_text: Raw text response from Claude
        job_id: Job ID for the result

    Returns:
        MatchResult with parsed data
    """
    # Try to extract JSON from the response
    json_match = re.search(r"\{[\s\S]*\}", response_text)
    if not json_match:
        logger.warning("No JSON found in Claude response")
        return MatchResult(
            job_id=job_id,
            passes_dealbreakers=False,
            dealbreaker_issues=["Failed to parse LLM response"],
            decision="SKIP",
            analysis_summary="Error: Could not parse response",
        )

    try:
        data = json.loads(json_match.group())
    except json.JSONDecodeError as e:
        logger.warning(f"Failed to parse JSON: {e}")
        return MatchResult(
            job_id=job_id,
            passes_dealbreakers=False,
            dealbreaker_issues=[f"JSON parse error: {e}"],
            decision="SKIP",
            analysis_summary="Error: Invalid JSON in response",
        )

    # Extract scores with defaults
    tech_score = int(data.get("tech_score", 0))
    seniority_score = int(data.get("seniority_score", 0))
    culture_score = int(data.get("culture_score", 0))
    responsibilities_score = int(data.get("responsibilities_score", 0))

    # Normalize decision
    decision_raw = data.get("decision", "SKIP").upper()
    if decision_raw not in ("APPLY", "REVIEW", "SKIP"):
        decision_raw = "SKIP"

    return MatchResult(
        job_id=job_id,
        passes_dealbreakers=data.get("passes_dealbreakers", False),
        dealbreaker_issues=data.get("dealbreaker_issues", []),
        tech_score=tech_score,
        seniority_score=seniority_score,
        culture_score=culture_score,
        responsibilities_score=responsibilities_score,
        global_score=data.get("global_score", 0.0),
        decision=decision_raw,  # type: ignore
        highlights=data.get("highlights", []),
        expected_questions=data.get("expected_questions", []),
        analysis_summary=data.get("analysis_summary", ""),
    )


# ============================================================================
# Score Calculation
# ============================================================================


def calculate_global_score(
    tech_score: int,
    seniority_score: int,
    culture_score: int,
    responsibilities_score: int,
    weights: dict[str, float],
) -> float:
    """Calculate weighted global score from individual scores."""
    total_weight = sum(weights.values())
    if total_weight == 0:
        return 0.0

    weighted_sum = (
        tech_score * weights.get("tech_score", 0.25)
        + seniority_score * weights.get("seniority_score", 0.25)
        + culture_score * weights.get("culture_score", 0.20)
        + responsibilities_score * weights.get("responsibilities_score", 0.30)
    )

    return round(weighted_sum / total_weight * 10, 1)


def determine_decision(
    global_score: float,
    passes_dealbreakers: bool,
    thresholds: dict[str, float],
) -> Literal["APPLY", "REVIEW", "SKIP"]:
    """Determine the decision based on score and dealbreakers."""
    if not passes_dealbreakers:
        return "SKIP"

    apply_threshold = thresholds.get("apply", 7.0)
    review_threshold = thresholds.get("review", 5.0)

    if global_score >= apply_threshold:
        return "APPLY"
    elif global_score >= review_threshold:
        return "REVIEW"
    else:
        return "SKIP"


# ============================================================================
# Main Matching Function
# ============================================================================


async def match_job(
    job: "LinkedInJob",
    cv_data: dict[str, Any],
    criteria: dict[str, Any] | None = None,
) -> MatchResult:
    """
    Analyze matching between a job offer and candidate profile via LLM.

    Args:
        job: LinkedInJob dataclass with job details
        cv_data: Dictionary with CV/resume data (from cv_data.json)
        criteria: Matching criteria (dealbreakers, weights, thresholds)

    Returns:
        MatchResult with scores, decision, and analysis
    """
    # Use default criteria if not provided
    if criteria is None:
        criteria = DEFAULT_CRITERIA

    # Merge with defaults for any missing keys
    merged_criteria = {**DEFAULT_CRITERIA, **criteria}
    for key in DEFAULT_CRITERIA:
        if key not in merged_criteria:
            merged_criteria[key] = DEFAULT_CRITERIA[key]
        elif isinstance(DEFAULT_CRITERIA[key], dict):
            merged_criteria[key] = {**DEFAULT_CRITERIA[key], **merged_criteria.get(key, {})}

    job_id = job.job_id if hasattr(job, "job_id") else str(job.get("job_id", "unknown"))

    logger.info(
        f"Matching job {job_id}: {job.title if hasattr(job, 'title') else job.get('title', 'Unknown')}"
    )

    # Render prompt
    try:
        prompt = render_matching_prompt(job, cv_data, merged_criteria)
    except Exception as e:
        logger.error(f"Failed to render prompt: {e}")
        return MatchResult(
            job_id=job_id,
            passes_dealbreakers=False,
            dealbreaker_issues=[f"Template error: {e}"],
            decision="SKIP",
        )

    # Call Claude
    response = call_claude(prompt)

    if "error" in response:
        logger.error(f"LLM call failed: {response['error']}")
        return MatchResult(
            job_id=job_id,
            passes_dealbreakers=False,
            dealbreaker_issues=[f"LLM error: {response['error']}"],
            decision="SKIP",
        )

    # Parse response
    result = parse_match_response(response["result"], job_id)

    # Recalculate global score with our weights
    weights = merged_criteria.get("weights", DEFAULT_CRITERIA["weights"])
    result.global_score = calculate_global_score(
        result.tech_score,
        result.seniority_score,
        result.culture_score,
        result.responsibilities_score,
        weights,
    )

    # Determine final decision
    thresholds = merged_criteria.get("thresholds", DEFAULT_CRITERIA["thresholds"])
    result.decision = determine_decision(
        result.global_score,
        result.passes_dealbreakers,
        thresholds,
    )

    logger.info(
        f"Match result: {result.decision} (score: {result.global_score}, "
        f"dealbreakers: {'PASS' if result.passes_dealbreakers else 'FAIL'})"
    )

    return result


def match_job_sync(
    job: "LinkedInJob",
    cv_data: dict[str, Any],
    criteria: dict[str, Any] | None = None,
) -> MatchResult:
    """Synchronous version of match_job for non-async contexts."""
    import asyncio

    return asyncio.run(match_job(job, cv_data, criteria))


# ============================================================================
# CLI Interface
# ============================================================================


def main():
    """CLI for testing the matcher."""
    import argparse

    parser = argparse.ArgumentParser(description="Test job matching")
    parser.add_argument(
        "--job-json",
        type=Path,
        help="Path to job JSON file (from scraper output)",
    )
    parser.add_argument(
        "--cv-json",
        type=Path,
        help="Path to CV data JSON file",
    )
    parser.add_argument(
        "--criteria-yaml",
        type=Path,
        help="Path to criteria YAML file",
    )
    parser.add_argument(
        "--output",
        choices=["json", "text"],
        default="text",
        help="Output format",
    )

    args = parser.parse_args()

    # Load CV data
    if not args.cv_json or not args.cv_json.exists():
        print("Error: --cv-json is required and must exist")
        sys.exit(1)

    with open(args.cv_json) as f:
        cv_data = json.load(f)

    # Load job data
    if args.job_json and args.job_json.exists():
        with open(args.job_json) as f:
            job_data = json.load(f)
    else:
        # Demo job for testing
        job_data = {
            "job_id": "demo-123",
            "url": "https://linkedin.com/jobs/view/demo-123",
            "title": "Senior Product Manager",
            "company": "TechCorp",
            "location": "Paris, France",
            "work_type": "Hybrid",
            "description": (
                "We are looking for a Senior Product Manager to lead our SaaS platform.\n\n"
                "Requirements:\n"
                "- 5+ years of Product Management experience\n"
                "- Experience with Agile/Scrum methodologies\n"
                "- Strong analytical skills\n"
                "- Fluent in French and English\n\n"
                "Nice to have:\n"
                "- Experience in Insurance or Finance\n"
                "- Technical background"
            ),
            "skills": ["Product Management", "Agile", "Scrum", "SaaS"],
            "is_easy_apply": True,
        }
        print("Using demo job data (no --job-json provided)")

    # Load criteria if provided
    criteria = None
    if args.criteria_yaml and args.criteria_yaml.exists():
        import yaml

        with open(args.criteria_yaml) as f:
            criteria = yaml.safe_load(f)

    # Run matching
    print("\nAnalyzing job match...")
    result = match_job_sync(job_data, cv_data, criteria)

    # Output
    if args.output == "json":
        print(json.dumps(asdict(result), indent=2, ensure_ascii=False))
    else:
        print("\n" + "=" * 60)
        print("MATCH RESULT")
        print("=" * 60)
        print(f"Job ID: {result.job_id}")
        print(f"Decision: {result.decision}")
        print(f"Global Score: {result.global_score}/10")
        print(f"\nDealbreakers: {'PASS' if result.passes_dealbreakers else 'FAIL'}")
        if result.dealbreaker_issues:
            print("  Issues:")
            for issue in result.dealbreaker_issues:
                print(f"    - {issue}")
        print("\nScores:")
        print(f"  Tech: {result.tech_score}/10")
        print(f"  Seniority: {result.seniority_score}/10")
        print(f"  Culture: {result.culture_score}/10")
        print(f"  Responsibilities: {result.responsibilities_score}/10")
        if result.highlights:
            print("\nHighlights:")
            for h in result.highlights:
                print(f"  + {h}")
        if result.expected_questions:
            print("\nExpected Questions:")
            for q in result.expected_questions:
                print(f"  ? {q}")
        if result.analysis_summary:
            print(f"\nSummary: {result.analysis_summary}")


if __name__ == "__main__":
    main()
