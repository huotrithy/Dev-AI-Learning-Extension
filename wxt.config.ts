import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Dev AI Learning Extension',
    description: 'Learn technical pages with your own model and a local learning profile.',
    minimum_chrome_version: '116',
    action: { default_title: 'Learn this page' },
    permissions: ['activeTab', 'scripting', 'storage'],
    optional_host_permissions: ['https://*/*', 'http://*/*'],
  },
  vite: () => ({ plugins: [tailwindcss()] }),
});
