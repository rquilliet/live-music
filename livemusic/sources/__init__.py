"""Source registry: strategy name -> scraper function(venue_config, ctx) -> list[Event]."""
from . import opendata, tribe, venues_html, llm

STRATEGIES = {
    "opendata": opendata.scrape,
    "tribe": tribe.scrape,
    "cigale": venues_html.cigale,
    "bataclan": venues_html.bataclan,
    "trianon": venues_html.trianon,
    "maroquinerie": venues_html.maroquinerie,
    "petitbain": venues_html.petitbain,
    "pointephemere": venues_html.pointephemere,
    "cafedeladanse": venues_html.cafedeladanse,
    "hasardludique": venues_html.hasardludique,
    "newmorning": venues_html.newmorning,
    "instantschavires": venues_html.instantschavires,
    "llm": llm.scrape,
}
