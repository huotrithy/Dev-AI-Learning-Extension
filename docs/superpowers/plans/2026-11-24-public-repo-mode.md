# Public GitHub Repo Mode

This is the first part of [Repo Mode](../specs/2026-11-22-dev-learning-extension-design.md#9-delivery-order). Reuse the reader, configured model, and personalization flow for a repository overview and questions grounded in the files loaded for that overview.

- [x] Test detection of GitHub repository URLs and rejection of other GitHub pages. Implement URL detection and a bounded GitHub API reader for the default branch. Pin file excerpts and links to a commit. Cover missing repos, rate limits, and incomplete trees.
- [x] Test the repository prompt context for file links and question relevance. Connect the loader to **Learn this repo**, using the existing optional host permission for GitHub API access. Reuse the existing chat and diagram flow, and show the inspected files in the reader.
- [x] Run the pnpm test suite, type check, build, and verify the repository flow with an Edge fixture.

## Follow-up code tracing

- [x] Use file and symbol names to rank paths from the repository tree, then follow relative imports where possible. Make up to three file requests per question at the same commit and select excerpts near matching lines.
- [x] Use the extra excerpts in the answer and show the files for that turn. Keep chat usable if a GitHub request fails. Cover the retrieval path with automated tests and leave hands-on Edge testing to the owner.
