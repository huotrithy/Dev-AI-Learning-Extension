import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Dev AI Learning Extension",
    description: "Learn technical pages with your own model and a local learning profile.",
    minimum_chrome_version: "116",
    action: {
      default_title: "Learn this page",
      default_icon: { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png" },
    },
    permissions: ["activeTab", "scripting", "storage", "tabs"],
    optional_host_permissions: ["https://*/*", "http://*/*"],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'",
    },
  },
  hooks: {
    "build:publicAssets": ({ config }, files) => {
      files.push({ absoluteSrc: resolve(config.root, "LICENSE"), relativeDest: "LICENSE" });
    },
  },
  vite: () => ({ plugins: [tailwindcss()] }),
});
