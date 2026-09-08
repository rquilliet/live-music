"""The normalised event record every source produces."""
import datetime as dt
import re
from dataclasses import dataclass, field, asdict
from typing import List, Optional

from .util import event_id, clean_text

_HOST = re.compile(r"^[a-z0-9.-]+\.[a-z]{2,}(/|$)", re.I)


def clean_url(u: Optional[str]) -> Optional[str]:
    """Only http(s) links survive (scraped data feeds hrefs); a bare host gets https://."""
    if not u:
        return None
    u = clean_text(u).replace(" ", "%20")
    if u.startswith("//"):
        u = "https:" + u
    if re.match(r"^https?://", u, re.I):
        return u[:500]
    if _HOST.match(u):
        return "https://" + u[:500]
    return None


@dataclass
class Event:
    title: str
    date: str                      # YYYY-MM-DD
    venue: str                     # display name
    venue_slug: str
    source: str                    # which scraper produced it
    time: Optional[str] = None     # HH:MM
    url: Optional[str] = None      # event page
    ticket_url: Optional[str] = None
    price: Optional[str] = None
    free: bool = False
    sold_out: bool = False
    cancelled: bool = False
    raw_genre: Optional[str] = None   # genre text as published by the venue / source
    genres: List[str] = field(default_factory=list)   # canonical tags
    genre_source: Optional[str] = None                # site | rules | llm | venue
    subgenres: List[str] = field(default_factory=list)   # fine-grained labels (free text, lowercase)
    description: Optional[str] = None
    summary: Optional[str] = None     # Claude's 1-2 sentence summary of the event page when the venue gave no text
    image: Optional[str] = None
    address: Optional[str] = None
    area: Optional[str] = None        # neighbourhood / arrondissement / town shown next to the venue
    headliner: Optional[str] = None   # first act of the bill (from the title)
    support: List[str] = field(default_factory=list)  # the other acts
    lat: Optional[float] = None
    lon: Optional[float] = None
    is_music: bool = True
    id: str = ""

    def __post_init__(self):
        self.title = clean_text(self.title)[:200]
        if self.description:
            self.description = clean_text(self.description)[:400]
        if self.summary:
            self.summary = clean_text(self.summary)[:400]
        self.url, self.ticket_url, self.image = map(clean_url, (self.url, self.ticket_url, self.image))
        if not self.id:
            self.id = event_id(self.venue_slug, self.date, self.title)

    def to_dict(self):
        return asdict(self)

    def is_valid(self, today: dt.date, horizon_days: int) -> bool:
        if not self.title or not self.date:
            return False
        try:
            d = dt.date.fromisoformat(self.date)
        except ValueError:
            return False
        return today <= d <= today + dt.timedelta(days=horizon_days)
