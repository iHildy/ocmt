# Changelog Generation Guidelines

Generate a changelog from the provided commits.

## Format

Use the "Keep a Changelog" format (https://keepachangelog.com/).

## Structure

```markdown
## [Version] - YYYY-MM-DD

### Added
- New features

### Changed
- Changes in existing functionality

### Deprecated
- Soon-to-be removed features

### Removed
- Removed features

### Fixed
- Bug fixes

### Security
- Vulnerability fixes
```

## Rules

1. Group commits by type (feat -> Added, fix -> Fixed, etc.)
2. Write in past tense ("Added" not "Add")
3. Include the commit hash in parentheses at the end of each entry
4. Keep descriptions concise but informative
5. Omit the version number and date - just use "Unreleased" as the heading
6. Skip empty sections
7. Only return the changelog content, no explanations
