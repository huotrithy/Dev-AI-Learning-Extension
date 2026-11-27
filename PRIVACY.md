# Dev AI Learning Extension Privacy Policy

Last updated November 27, 2026

Dev AI Learning Extension helps you understand technical content in Microsoft Edge. This policy explains what the extension accesses, where it sends information, and how you can manage the data it saves.

## Information the extension uses

- **Reading sources.** While the reader is open, it uses the active tab's URL and title to identify the current source and can extract readable text from pages you have granted access to. When you use the corresponding feature, it can also read related documentation, excerpts from a public GitHub repository, or a transcript displayed on YouTube. It uses active-tab information and its own learning history. It has no access to Edge's browsing history database.
- **Learning activity.** The extension uses your questions, model replies, and feedback to answer follow-up questions and let you resume conversations. Memory is enabled by default and can save preferences, common question topics, and excerpts from your requests that support them. It uses those records to adapt explanations and suggest follow-ups.
- **Settings and credentials.** The extension stores appearance settings, model profiles, API keys, and custom request headers you provide in your browser profile. Saved credentials persist across restarts. The extension restricts access to saved credentials to trusted extension contexts. The extension does not encrypt those credentials at rest.

## Where information is sent

When you request an explanation or ask a follow-up, the extension sends the information needed for that request to the model endpoint you configure. This can include source URLs, titles and excerpts, questions, recent conversation turns, and relevant saved preferences. If you configure a separate decision model, it can receive excerpts or conversation context for tasks such as classifying the source or identifying learning preferences. The browser extension sends a profile's API key and custom headers to that profile's endpoint to authenticate or configure its requests. Endpoints that receive credentials must use HTTPS unless they run on the same device at a loopback address.

You choose whether the destination is a local model, a hosted provider, or a gateway. A gateway may forward your request to its upstream providers. Hosted services may log or retain requests under their own privacy policies and settings. Clearing data in the extension affects the browser's copy only. For requests you have already sent, contact the provider or use its data controls.

Related documentation requests go to the documentation site. Public repository file requests go to the GitHub API. These requests omit browser cookies. The extension has no publisher-operated backend, advertising, or telemetry, and the publisher does not sell user data.

## Retention and your controls

- **History.** You can view or resume saved conversations in **History**. Completed replies and source snapshots are subject to a 30-day retention window. The extension removes expired records during routine cleanup. Use **Clear history** to delete the browser's saved conversations and source snapshots.
- **Memory.** In **Memory**, you can review, edit, delete, or clear saved learning data. You can also pause learning and recall. Pausing leaves existing records available for you to manage.
- **Model settings.** You can remove or replace API keys and custom headers, remove a model profile, or select a local model instead of a hosted provider. To stop using an endpoint, remove its profile or revoke the extension's access to that site in Edge. Uninstalling the extension removes its local data from the browser profile.

## Contact

For privacy questions, contact the maintainer through the [project's GitHub issues](https://github.com/huotrithy/Dev-AI-Learning-Extension/issues). Issues are public. Keep API keys, credential values, and private source content out of public posts.
