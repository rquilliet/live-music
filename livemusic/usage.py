"""Token usage of every Claude call in a run, and what it cost, logged at the end of the scrape (REM-55)."""
from collections import defaultdict

# $ per million tokens (input, output); batch calls are billed half, cache reads 0.1x, cache writes 1.25x
PRICES = {"claude-opus-5": (5.0, 25.0), "claude-opus-5-5": (4.0, 20.0), "claude-sonnet-5": (2.0, 10.0),
          "claude-haiku-4-5": (1.0, 5.0)}

_totals = defaultdict(lambda: defaultdict(int))


def reset():
    _totals.clear()


def add(what: str, model: str, usage, batch: bool = False):
    """Record one response's `usage` under a label ('venues', 'genres', 'summaries')."""
    if usage is None:
        return
    t = _totals[(what, model, batch)]
    t["calls"] += 1
    for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
        t[k] += getattr(usage, k, None) or 0


def cost(model: str, t, batch: bool) -> float:
    pin, pout = PRICES.get(model, PRICES["claude-opus-5"])
    dollars = (t["input_tokens"] * pin + t["output_tokens"] * pout + t["cache_read_input_tokens"] * pin * 0.1
               + t["cache_creation_input_tokens"] * pin * 1.25) / 1e6
    return dollars / 2 if batch else dollars


def summary() -> list:
    """One log line per (label, model, batch) plus a total, or [] when Claude was not called."""
    lines, total = [], 0.0
    for (what, model, batch), t in sorted(_totals.items()):
        c = cost(model, t, batch)
        total += c
        lines.append(f"  {what}: {t['calls']} {'batched ' if batch else ''}calls to {model}, "
                     f"{t['input_tokens'] + t['cache_read_input_tokens'] + t['cache_creation_input_tokens']:,} in "
                     f"/ {t['output_tokens']:,} out tokens ≈ ${c:.2f}")
    if lines:
        lines.append(f"  Claude total ≈ ${total:.2f}")
    return lines
