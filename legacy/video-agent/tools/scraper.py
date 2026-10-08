"""
scraper.py — ET Article Scraper Tool
=====================================
Scrapes Economic Times articles and extracts content as structured text.

Usage (called by Agent.py automatically):
    python scraper.py '{"article_url": "https://economictimes.indiatimes.com/...", "save_to_file": true}'

Parameters (JSON via sys.argv[1]):
    article_url   (required)  — The ET article URL to scrape.
    save_to_file  (optional)  — Whether to save to JSON file (defaults to False).
"""

import json
import os
import re
import sys
import uuid
from datetime import datetime
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup


OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "articles")


def _build_print_url(article_url: str) -> str:
    """Extract article ID and build print URL."""
    match = re.search(r'/(\d{7,12})\.cms', article_url)
    if not match:
        raise ValueError(f"Could not find article ID in URL: {article_url}")

    article_id = match.group(1)
    parsed = urlparse(article_url)
    base_path = re.sub(r'/articleshow.*', '', parsed.path)
    base_path = re.sub(r'/amp$', '', base_path).rstrip('/')

    return f"https://economictimes.indiatimes.com{base_path}/printarticle/{article_id}.cms"


def _extract_paragraphs(art_text) -> list[str]:
    """Extract and clean paragraphs from article HTML."""
    # Remove style, script, and other unwanted tags
    for tag in art_text.find_all(['style', 'script', 'noscript', 'div']):
        if tag.name == 'div' and 'artText' not in tag.get('class', []):
            tag.decompose()
        elif tag.name != 'div':
            tag.decompose()

   
    html_content = str(art_text)
    html_content = re.sub(r'<br\s*/?>\s*<br\s*/?>', '\n\n', html_content)
    html_content = re.sub(r'<br\s*/?>', '\n', html_content)

    # Parse again to get clean text
    temp_soup = BeautifulSoup(html_content, 'html.parser')
    content = temp_soup.get_text()

    # Clean up and format as paragraphs
    lines = content.split('\n')
    paragraphs = []
    current_para = []

    for line in lines:
        line = line.strip()
        if line:
            current_para.append(line)
        elif current_para:
            paragraphs.append(' '.join(current_para))
            current_para = []

    if current_para:
        paragraphs.append(' '.join(current_para))

    # Filter out very short paragraphs (likely artifacts)
    return [p for p in paragraphs if len(p) > 30]


def _save_to_file(data: dict, article_url: str) -> str:
    """Save article data as JSON file."""
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    path = urlparse(article_url).path
    parts = [p for p in path.split("/") if p and not p.endswith(".cms") and not p.isdigit() and p not in ("articleshow", "amp")]
    slug = parts[-1] if parts else "article"
    slug = re.sub(r"[^a-zA-Z0-9\-]", "", slug)[:55]
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"{slug}_{ts}.json"

    output_path = os.path.join(OUTPUT_DIR, filename)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)

    return os.path.abspath(output_path)


def scrape_article(article_url: str, save_to_file: bool = False) -> dict:
    article_url = article_url.strip()

    # Validate URL
    if not article_url.startswith("http"):
        return {
            "success": False,
            "error": "Invalid URL. Must start with http or https."
        }

    if "economictimes.indiatimes.com" not in article_url:
        return {
            "success": False,
            "error": "URL must be from economictimes.indiatimes.com"
        }

    try:
        print_url = _build_print_url(article_url)
    except ValueError as e:
        return {
            "success": False,
            "error": str(e)
        }

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36"
    }

    try:
        response = requests.get(print_url, headers=headers, timeout=30)
        response.raise_for_status()
    except requests.RequestException as e:
        return {
            "success": False,
            "error": f"Failed to fetch article: {str(e)}"
        }

    soup = BeautifulSoup(response.text, 'html.parser')

    # Get title
    title = ""
    title_elem = soup.find('h1')
    if title_elem:
        title = title_elem.get_text(strip=True)

    # Get article content from artText div
    paragraphs = []
    art_text = soup.find('div', class_='artText')

    if art_text:
        paragraphs = _extract_paragraphs(art_text)

    result = {
        "success": True,
        "id": str(uuid.uuid4()),
        "title": title,
        "url": article_url,
        "print_url": print_url,
        "content": paragraphs,
        "scraped_at": datetime.now().isoformat()
    }

    if save_to_file:
        file_path = _save_to_file(result, article_url)
        result["file_path"] = file_path

    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({
            "success": False,
            "error": "No parameters provided. Pass a JSON string as the first argument."
        }))
        sys.exit(1)

    try:
        params = json.loads(sys.argv[1])
    except json.JSONDecodeError as e:
        print(json.dumps({
            "success": False,
            "error": f"Invalid JSON input: {e}"
        }))
        sys.exit(1)

    # Extract parameters
    article_url = params.get("article_url", "")
    save_to_file = params.get("save_to_file", False)

    if not article_url:
        print(json.dumps({
            "success": False,
            "error": "Missing required parameter: 'article_url'"
        }))
        sys.exit(1)

    result = scrape_article(
        article_url=article_url,
        save_to_file=save_to_file,
    )

    print(json.dumps(result, indent=2))
