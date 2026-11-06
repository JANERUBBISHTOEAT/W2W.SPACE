"""Check real Jekyll output, not just Markdown source or reachable image URLs."""

from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
import re
import sys
from urllib.parse import unquote, urlsplit


class ScreenshotParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.sections = []
        self.section = None
        self.images = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "details":
            self.section = {"images": [], "text": [], "headings": 0}
            self.sections.append(self.section)
        elif tag == "img":
            source = attributes.get("src", "")
            self.images.append(source)
            if self.section is not None:
                self.section["images"].append(source)
        elif tag == "h4" and self.section is not None:
            self.section["headings"] += 1

    def handle_endtag(self, tag):
        if tag == "details":
            self.section = None

    def handle_data(self, data):
        if self.section is not None:
            self.section["text"].append(data)


def main():
    root = Path(__file__).resolve().parents[2]
    site = Path(sys.argv[1]).resolve()
    parser = ScreenshotParser()
    parser.feed((site / "index.html").read_text(encoding="utf-8"))
    expected = Counter(re.findall(r"!\[[^\]]*\]\((img/[^)]+)\)",
                                 (root / "readme.md").read_text(encoding="utf-8")))
    actual = Counter()
    for source in parser.images:
        url = urlsplit(source)
        if url.scheme or url.netloc:
            continue
        path = unquote(url.path)
        # Jekyll relative-links prefixes images with the project Pages base URL.
        match = re.search(r"(?:^|/)(img/[^/]+)$", path)
        if not match:
            continue
        relative = match.group(1)
        assert (site / relative).is_file(), f"Missing published image: {relative}"
        actual[relative] += 1

    assert expected and actual == expected, f"Image mismatch: expected {expected}, rendered {actual}"
    assert len(parser.sections) == 4, "Expected all four screenshot disclosures"
    assert [len(section["images"]) for section in parser.sections] == [1, 1, 4, 4]
    assert sum(section["headings"] for section in parser.sections) == 8
    for section in parser.sections:
        text = "".join(section["text"])
        assert not re.search(r"!\[[^\]]*\]\(|(?m:^\s*####\s)", text), "Unrendered screenshot Markdown"
    print(f"Pages screenshots verified: {sum(actual.values())} local images, 4 disclosures, 8 rendered headings")


if __name__ == "__main__":
    main()
