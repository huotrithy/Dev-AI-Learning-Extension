# Dev AI Learning Extension

A Chrome side panel for learning technical pages with your own model. It streams an explanation, example, use cases, and a walkthrough. Read further by asking questions about the page or choosing a suggested follow-up.

## Load the extension

1. Open `chrome://extensions`, enable **Developer mode**, and select **Load unpacked**.
2. Choose `.output/chrome-mv3` from this project. To rebuild that directory, use Node.js 22.15 or newer and pnpm 10.18.0.

   ```sh
   pnpm install --frozen-lockfile
   pnpm run build
   ```

3. Open a technical article and click the extension’s toolbar icon. In **Models**, save a provider profile and allow access to its endpoint when Chrome prompts. For MLX, choose **OpenAI-compatible**, enter the server’s `/v1` base URL, and use the model ID from that server. For the project’s Qwen profile, use `mlx-community/Qwen3.5-4B-MLX-4bit` with **Disable thinking (MLX)** enabled.
4. Return to **Read** and select **Learn this page**. Click the toolbar icon on a new tab when it needs page access.

## Personalize it

Say “Always use TypeScript examples” in chat or save a preference under **Memory**. The sidebar uses signals across reading sessions to learn preferences and suggest follow-up questions relevant to the current page. In **Memory**, you can review the supporting requests, edit or delete memories, clear them, or pause learning and recall.

Memory is stored in Chrome’s IndexedDB. Model requests can contain page excerpts, questions, and relevant saved preferences. Those requests go to the model endpoints you configure.

## TODO

- [ ] Move model requests into the extension's background service worker. Use the saved model profile to resolve the endpoint and key in the worker. Preserve streaming, cancellation, and structured responses. Keep keys across browser restarts and show **Key saved** in Settings with options to replace or remove the key.

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
