"""The normalised event record every source produces."""
import datetime as dt
from dataclasses import dataclass, field, asdict
from typing import List, Optional

from .util import event_id, clean_text


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
    description: Optional[str] = None
    image: Optional[str] = None
    address: Optional[str] = None
    lat: Optional[float] = None
    lon: Optional[float] = None
    is_music: bool = True
    id: str = ""

    def __post_init__(self):
        self.title = clean_text(self.title)[:200]
        if self.description:
            self.description = clean_text(self.description)[:400]
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
