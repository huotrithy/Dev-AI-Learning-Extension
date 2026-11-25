# Dev AI Learning Extension

A Chrome side panel for learning technical pages with your own model. It streams an explanation, example, use cases, and a walkthrough. Read further by asking questions about the page or choosing a suggested follow-up.

## Load the extension

1. Open `chrome://extensions`, enable **Developer mode**, and select **Load unpacked**.
2. Choose `.output/chrome-mv3` from this project. To rebuild that directory, use Node.js 22.15 or newer and pnpm 10.18.0.

   ```sh
   pnpm install --frozen-lockfile
   pnpm run build
   ```

3. Open a technical article and click the extension’s toolbar icon. In **Settings** under **Model settings**, click **Add profile**, choose a **Provider** and **Type**, and enter the profile name, model ID, and credentials. Use **Chat** for the explanation model. A **Decision** profile is for **System 1**. OpenAI and other chat providers can use their regular API to return a structured decision. For **OpenAI-compatible**, enter its base URL too. Save the profile and allow access to its endpoint when Chrome prompts.
4. Return to **Read** and select **Learn this page**. Click the toolbar icon on a new tab when it needs page access.

Expand **Activity** to see source reads, model calls, and fallbacks for an explanation or answer. Code snippets have line numbers and controls for wrapping and copying.

Use **Open floating window** in the reader header to move it into a resizable window. Use **Dock to sidebar** to bring it back. Both modes read the active tab in the browser window where you opened the reader and carry your explanation, chat, and draft when you switch. Older browser versions may require you to close the sidebar manually after opening the floating window.

The sidebar and floating reader stay open when you switch tabs or sites. An open chat or unsent draft stays with its original page. Choose **Refresh page** to start a new reading session on the active page. The `tabs` permission lets the reader identify the active page. If the reader asks for access to a page, click the extension icon on that tab to grant `activeTab` access.

## Use FreeLLMAPI

[FreeLLMAPI](https://github.com/tashfeenahmed/freellmapi) is an optional self-hosted gateway that routes requests through the model providers you configure. It works with the extension's existing OpenAI-compatible provider setting.

1. Run the [Windows desktop app](https://apps.microsoft.com/detail/9PBN6G8K2B7F), or use the [Docker or Node.js setup](https://github.com/tashfeenahmed/freellmapi/blob/main/docs/en/install/01-install.md) on your computer or a separate server.
2. Open the FreeLLMAPI dashboard, add at least one upstream provider key under **Keys**, and copy the **unified API key**. The desktop app also offers **Copy Key** in its tray menu.
3. In the extension, open **Settings** → **Model settings** and click **Add profile**. Enter these values in the modal.

   | Field                                     | Value                                                                                                                                                                                                    |
   | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | Profile name                              | `FreeLLMAPI`                                                                                                                                                                                             |
   | Provider                                  | **FreeLLM**                                                                                                                                                                                              |
   | Type                                      | **Chat**                                                                                                                                                                                                 |
   | Base URL                                  | `http://127.0.0.1:31415/v1` for the desktop app by default, or `http://localhost:3001/v1` for the default server install on the same computer. For a remote instance, use its HTTPS URL ending in `/v1`. |
   | Model ID                                  | `auto` to use the gateway's fallback chain                                                                                                                                                               |
   | API key                                   | The unified API key from FreeLLMAPI                                                                                                                                                                      |
   | Custom headers and advanced model options | Leave headers blank and both toggles off to start                                                                                                                                                        |

4. Save the profile, allow endpoint access if Chrome prompts, and select it as the **Explanation model**. Open a technical page and choose **Learn this page** to test it.
5. To use FreeLLM’s dedicated decision models for source classification, add a separate profile with **FreeLLM** as the **Provider** and **Decision** as the **Type**. Enter the full **Decision endpoint URL** ending in `/v1/decisions`, and use `auto` or a decision model ID. Select it as the **System 1 model**.

Keep the gateway running while you use the extension. When the gateway routes to a cloud provider, that provider receives the model request, which can include page excerpts, questions, and relevant saved preferences.

## Conversation history

Open **History** to review completed questions and answers by reading session. Each reply stays available in this browser for 30 days. Use **Clear history** to delete the archive at any time. The archive is for browsing, and follow-up questions use the active chat for context.

## Personalize it

In **Settings** under **Appearance**, choose the reader theme and font, and enter a text size from 12 to 32 px. These choices are saved in this browser.

Say “Always use TypeScript examples” in chat or save a preference under **Memory**. The sidebar uses signals across reading sessions to learn preferences and suggest follow-up questions relevant to the current page. In **Memory**, you can review the supporting requests, edit or delete memories, clear them, or pause learning and recall.

Memory is stored in Chrome’s IndexedDB. Model requests can contain page excerpts, questions, and relevant saved preferences. Those requests go to the model endpoints you configure.

The extension's background service worker sends model requests and loads the saved API key and custom header values for the selected profile. These credentials stay in the browser profile across restarts. Settings shows whether a key is saved and lists saved header names with blank value fields. Enter a replacement or use the remove control, then save the profile. Changing a profile's provider or base URL clears its credentials from the form.

Only trusted extension contexts can access the storage, and browser-profile storage is unencrypted. An endpoint with an API key or custom headers needs HTTPS unless it uses loopback on the same computer (`localhost`, `127.0.0.1`, or `[::1]`). Keyless local model endpoints can use HTTP.

## Learn a GitHub repository

Open a public repository's home page, click the extension icon, and choose **Learn this repo**. Allow access to `api.github.com` when prompted. The extension sends a file tree sample and excerpts from up to five files on the default branch to your configured model. Open **Files inspected** for links to the exact commit. Follow-up questions can read up to three more files from that commit using file names, symbols, and relative imports. Open **Files inspected for this answer** for links to the excerpts. Use **Refresh page** and learn the repo again to read its latest commit.

The **Repository architecture** map shows how the components identified in the excerpts relate. Use the source links under each component to open its files at the inspected commit.

## Learn a documentation site

Open a documentation page, check **Include related docs**, and choose **Learn this page**. Allow access to that site when prompted. The overview uses the current page and up to four directly linked pages on the same origin. For follow-up questions, the reader searches those pages and up to eight more from the same documentation section, fetched one link farther out. The search collection lives in the reader session. Expand **Documentation pages read** for overview sources or the answer's **Activity** for the pages selected for that question. Linked pages must serve readable HTML directly and are fetched without browser cookies. To return to a single page, uncheck **Include related docs** and choose **Explain again**.

## Learn a YouTube video

On a desktop YouTube watch page, expand the video description and select **Show transcript**. Click the extension icon and choose **Learn this video**. The reader sends caption excerpts to your configured model for an explanation, key moments, and follow-up answers. Click a timestamp citation to jump to that point in the original video tab. The video needs a transcript displayed by YouTube.

## Verify locally

```sh
pnpm test
pnpm run typecheck
pnpm run build
pnpm exec playwright-core install chromium
pnpm run test:browser
```

The browser test opens the native side panel on a local fixture page and uses a deterministic model endpoint.

## Sidebar components

Reuse the shadcn/ui components in `src/components/ui`. The root `components.json` configures the Base UI Nova registry and the sidebar theme.
