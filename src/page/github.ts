import { z } from "zod";
import type { PageSource } from "./extract.ts";

export interface GitHubRepository { owner: string; name: string }
export interface RepositoryFile { path: string; url: string; text: string }
export interface RepositorySource {
  branch: string;
  commit: string;
  truncated: boolean;
  paths: string[];
  candidatePaths?: string[];
  files: RepositoryFile[];
}

const github = "https://github.com";
const githubApi = "https://api.github.com";
export const githubApiPermission = `${githubApi}/*`;
const nonRepositoryOwners = new Set([
  "account",
  "apps",
  "collections",
  "contact",
  "copilot",
  "customer-stories",
  "enterprise",
  "events",
  "features",
  "issues",
  "marketplace",
  "notifications",
  "organizations",
  "orgs",
  "pricing",
  "pulls",
  "readme",
  "resources",
  "search",
  "security",
  "settings",
  "site",
  "solutions",
  "sponsors",
  "topics",
  "users",
]);
const sha = z.string().regex(/^[a-f0-9]{40}$/i);
const repoSchema = z.object({ default_branch: z.string().min(1), description: z.string().nullable().optional() });
const commitSchema = z.object({ sha, commit: z.object({ tree: z.object({ sha }) }) });
const treeSchema = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), type: z.string(), mode: z.string(), size: z.number().optional() })),
});
const readme = /(?:^|\/)readme(?:\.(?:md|mdx|rst|txt|adoc))?$/i;
const entryPoint = /(?:^|\/)(?:index|main|app|server|cli|lib|__main__|mod)\.[^.\/]+$/i;
const manifest = /^(?:package\.json|Cargo\.toml|go\.mod|pyproject\.toml|pom\.xml|Gemfile|composer\.json|deno\.jsonc?|build\.gradle(?:\.kts)?)$/i;
const code = /\.(?:[cm]?[jt]sx?|py|rs|go|rb|java|kts?|cs|fs|php|swift|scala|c|h|cpp|hpp|exs?|erl|clj|lua|zig|dart|vue|svelte|sh|tf|sql)$/i;
const excludedDirectory = /(?:^|\/)(?:dist|build|out|vendor|node_modules|coverage|test|tests|__tests__|fixtures|examples|\.github)(?:\/|$)/i;

export function githubRepository(url: string): GitHubRepository | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  }
  catch {
    return;
  }
  if (parsed.origin !== github || parsed.username || parsed.password)
    return;
  const match = /^\/([a-z0-9][a-z0-9-]*)\/([a-z0-9_.-]+)\/?$/i.exec(parsed.pathname);
  if (!match)
    return;
  const [, owner, name] = match;
  if (!owner || !name || nonRepositoryOwners.has(owner.toLowerCase()) || name.toLowerCase().endsWith(".git"))
    return;
  return { owner, name };
}

export function repositoryHome(repo: GitHubRepository): PageSource {
  const title = `${repo.owner}/${repo.name}`;
  return { title, url: `${github}/${title}`, text: "" };
}

export class RepositoryReadError extends Error {}

function filePriority(path: string): number {
  const parts = path.split("/");
  const depth = parts.length - 1;
  if (readme.test(path))
    return 100 - depth * 12;
  if (entryPoint.test(path))
    return 85 - depth * 4;
  if (manifest.test(parts.at(-1) ?? ""))
    return 90 - depth * 12;
  return 50 - depth * 5;
}

function githubReader(repo: GitHubRepository, signal: AbortSignal, fetcher: typeof fetch) {
  const api = `${githubApi}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(25_000)]);
  return async (path: string, accept = "application/vnd.github+json") => {
    const response = await fetcher(`${api}${path}`, {
      headers: { "Accept": accept, "X-GitHub-Api-Version": "2022-11-28" },
      credentials: "omit",
      redirect: "error",
      signal: requestSignal,
    }).catch(() => {
      signal.throwIfAborted();
      throw new RepositoryReadError("Could not connect to the GitHub API. Check your connection and try again.");
    });
    if (response.status === 403 || response.status === 429) {
      if (response.status === 429 || response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after"))
        throw new RepositoryReadError("GitHub API rate limit reached. Wait a while and try again.");
      throw new RepositoryReadError("GitHub denied access to this repository. Check that it is public.");
    }
    if (response.status === 404)
      throw new RepositoryReadError("GitHub could not find this repository or source file. Check that the repository is public and the address is current.");
    if (response.status === 409)
      throw new RepositoryReadError("GitHub could not find a commit to read. Check that the repository has files on its default branch.");
    if (!response.ok)
      throw new RepositoryReadError(`GitHub returned HTTP ${response.status}. Try again in a moment.`);
    return response;
  };
}

async function readRepositoryFile(home: string, commit: string, path: string, read: ReturnType<typeof githubReader>) {
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  const response = await read(`/contents/${encodedPath}?ref=${commit}`, "application/vnd.github.raw+json");
  const text = await response.text();
  if (!text.trim() || text.includes("\0"))
    return;
  return { path, url: `${home}/blob/${commit}/${encodedPath}`, text };
}

export async function loadRepository(repo: GitHubRepository, signal: AbortSignal, fetcher = fetch): Promise<PageSource> {
  const home = repositoryHome(repo);
  const read = githubReader(repo, signal, fetcher);

  const { default_branch: branch, description } = repoSchema.parse(await (await read("")).json());
  const revision = commitSchema.parse(await (await read(`/commits/${encodeURIComponent(branch)}`)).json());
  const { sha: commit } = revision;
  const { tree, truncated } = treeSchema.parse(await (await read(`/git/trees/${revision.commit.tree.sha}?recursive=1`)).json());
  const entries = tree.filter(({ path }) => path.length <= 240 && !excludedDirectory.test(path)
    && path.split("/").every(part => part && part !== "." && part !== ".." && !/[\u0000-\u001f\u007f\\]/.test(part)));
  const candidates = entries.filter(({ path, type, mode, size }) => type === "blob"
    && (mode === "100644" || mode === "100755") && size !== undefined && size > 0 && size <= 64_000
    && (readme.test(path) || manifest.test(path.split("/").at(-1) ?? "") || code.test(path))
    && (!readme.test(path) || /^(?:\.github\/|docs\/)?[^/]+$/.test(path)))
    .sort((a, b) => filePriority(b.path) - filePriority(a.path) || a.path.localeCompare(b.path));
  if (!candidates.length)
    throw new RepositoryReadError("No supported text files were found in the repository tree sample.");
  const files = await Promise.all(candidates.slice(0, 5).map(({ path }) => readRepositoryFile(home.url, commit, path, read)));
  signal.throwIfAborted();
  const excerpts = files.filter(file => file !== undefined).map(file => ({ ...file, text: file.text.trim().slice(0, 1_800) }));
  if (!excerpts.length)
    throw new RepositoryReadError("The selected files contained no readable text.");
  const paths = entries.filter(({ type }) => type === "blob" || type === "tree")
    .map(({ path, type }) => type === "tree" ? `${path}/` : path)
    .sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))
    .slice(0, 60);
  const candidatePaths = candidates.slice(0, 1_000).map(({ path }) => path);
  return { ...home, text: description?.slice(0, 400) ?? "", repository: { branch, commit, paths, candidatePaths, truncated, files: excerpts } };
}

const commonQuestionWords = new Set("about along another call calls code could does file files from happen happens implementation into look looks please project repo repository show should source step steps that their them then there these this those trace using want what when where which will with work works would".split(" "));

function compactName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function relativeImports(file: RepositoryFile, candidates: Set<string>): string[] {
  const matches = file.text.matchAll(/(?:\bfrom\s+|\bimport\s*\(?\s*|\brequire\(\s*)['"](\.\.?\/[^'"\r\n]+)['"]/g);
  const paths = [];
  for (const [, specifier] of matches) {
    const parts = file.path.split("/").slice(0, -1);
    for (const part of (specifier ?? "").split("/")) {
      if (part === "..")
        parts.pop();
      else if (part !== ".")
        parts.push(part);
    }
    const path = parts.join("/");
    const stem = path.replace(/\.[cm]?jsx?$/i, "");
    const resolved = [path, ...[".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs", "/index.ts", "/index.js"].map(suffix => `${stem}${suffix}`)]
      .find(candidate => candidates.has(candidate));
    if (resolved)
      paths.push(resolved);
  }
  return paths;
}

function questionExcerpt(file: RepositoryFile, terms: string[]): RepositoryFile {
  const lines = file.text.split(/\r?\n/);
  let focus = 0;
  let highestScore = 0;
  for (const [index, line] of lines.entries()) {
    const name = compactName(line);
    const score = terms.reduce((sum, term) => sum + (name.includes(term) ? term.length : 0), 0);
    if (score > highestScore) {
      highestScore = score;
      focus = index;
    }
  }
  let start = Math.max(0, focus - 6);
  while (start < focus && lines.slice(start, focus).join("\n").length > 600) start += 1;
  const text = lines.slice(start, focus + 24).join("\n").slice(0, 1_800).trimEnd();
  const end = start + text.split("\n").length;
  return { ...file, url: `${file.url}#L${start + 1}-L${end}`, text };
}

export async function traceRepository(page: PageSource, question: string, signal: AbortSignal, fetcher = fetch): Promise<PageSource> {
  const repo = githubRepository(page.url);
  const repository = page.repository;
  if (!repo || !repository?.candidatePaths?.length)
    return page;
  signal.throwIfAborted();
  const candidates = new Set(repository.candidatePaths);
  const terms = [...new Set((question.toLowerCase().match(/[a-z0-9_$-]{3,}/g) ?? [])
    .map(compactName)
    .filter(term => term.length >= 3 && !commonQuestionWords.has(term)))];
  const questionLower = question.toLowerCase();
  const scores = repository.candidatePaths.map((path) => {
    const baseName = path.split("/").at(-1) ?? "";
    const stem = compactName(baseName.replace(/\.[^.]+$/, ""));
    const name = compactName(path);
    const exactPath = questionLower.includes(path.toLowerCase()) || questionLower.includes(baseName.toLowerCase());
    const score = exactPath ? 1_000 : terms.reduce((sum, term) => sum + (stem === term ? 4 * term.length : name.includes(term) ? term.length : 0), 0);
    return { path, score, exactPath };
  });
  const ranked = scores.filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).map(({ path }) => path);
  const related = repository.files.filter(file => ranked.includes(file.path) || terms.some(term => compactName(file.text).includes(term)))
    .flatMap(file => relativeImports(file, candidates));
  const queue = [...ranked, ...related];
  const explicit = new Set(scores.filter(({ exactPath }) => exactPath).map(({ path }) => path));
  const seen = new Set(repository.files.map(({ path }) => path).filter(path => !explicit.has(path)));
  const files: RepositoryFile[] = [];
  const read = githubReader(repo, signal, fetcher);
  let requests = 0;
  for (const path of queue) {
    if (seen.has(path))
      continue;
    if (requests >= 3)
      break;
    seen.add(path);
    requests += 1;
    const file = await readRepositoryFile(page.url, repository.commit, path, read);
    signal.throwIfAborted();
    if (!file)
      continue;
    files.push(questionExcerpt(file, terms));
    for (const imported of relativeImports(file, candidates)) {
      if (!seen.has(imported) && !queue.includes(imported))
        queue.push(imported);
    }
  }
  if (!files.length)
    return page;
  const inspected = new Set(files.map(({ path }) => path));
  return { ...page, repository: { ...repository, files: [...files, ...repository.files.filter(({ path }) => !inspected.has(path))] } };
}
