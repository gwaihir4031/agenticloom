# Feature: tiny string utilities (`strutil.py`)

Build a small Python module `strutil.py` with three pure utility functions:

1. **`slugify(text: str) -> str`** — lowercase the input, replace any run of whitespace with a single `-`, strip out any character that isn't `[a-z0-9-]` after that. Return the result. Empty input returns `""`.

2. **`truncate(text: str, max_len: int) -> str`** — if `len(text) <= max_len`, return `text` unchanged. Otherwise return the first `max_len - 1` characters of `text` followed by a single Unicode ellipsis (`…`). Assume `max_len >= 1`.

3. **`word_count(text: str) -> int`** — return the number of whitespace-separated tokens. Empty / whitespace-only input returns 0.

## Constraints

- Standard library only (no external imports beyond stdlib).
- Pure functions: no side effects, no I/O, no `print`.
- Type hints on signatures, one-line docstring per function.
- Each function is independently implementable and testable.
