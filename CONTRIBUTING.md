# Contributing to Regression Guard

Thanks for contributing.

## Development setup

1. Install dependencies:
   - `npm install`
2. Build packages:
   - `npm run build`
3. Run tests:
   - `npm test`

## Pull requests

- Keep changes focused and scoped to a single goal.
- Add or update tests for behavior changes.
- Keep documentation in sync with code changes.
- Ensure build and tests pass before requesting review.

## Contracts and verification changes

- Keep verification behavior deterministic.
- Prefer explicit evidence over inference.
- Surface uncertainty as `unknown`/`partial` rather than silently passing.
