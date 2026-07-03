import { GitProviderId, ProviderAccount } from "./types";

export interface ProviderRepo {
  id: string;
  name: string;
  fullName: string;
  private: boolean;
  cloneUrl: string;
  sshUrl: string;
  defaultBranch: string;
}

export interface ProviderDefinition {
  id: GitProviderId;
  name: string;
  defaultApiBaseUrl: string;
  tokenHelpUrl: string;
}

export const PROVIDERS: ProviderDefinition[] = [
  {
    id: "github",
    name: "GitHub",
    defaultApiBaseUrl: "https://api.github.com",
    tokenHelpUrl: "https://github.com/settings/tokens",
  },
  {
    id: "gitlab",
    name: "GitLab",
    defaultApiBaseUrl: "https://gitlab.com/api/v4",
    tokenHelpUrl: "https://gitlab.com/-/user_settings/personal_access_tokens",
  },
  {
    id: "gitee",
    name: "Gitee",
    defaultApiBaseUrl: "https://gitee.com/api/v5",
    tokenHelpUrl: "https://gitee.com/profile/personal_access_tokens",
  },
  {
    id: "atomgit",
    name: "AtomGit",
    defaultApiBaseUrl: "https://api.atomgit.com/api/v4",
    tokenHelpUrl: "https://atomgit.com/user/settings/tokens",
  },
];

export function getProviderDefinition(provider: GitProviderId): ProviderDefinition {
  const definition = PROVIDERS.find((item) => item.id === provider);
  if (!definition) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return definition;
}

export class GitProviderClient {
  constructor(private readonly account: ProviderAccount) {}

  async listRepositories(): Promise<ProviderRepo[]> {
    if (this.account.provider === "github") {
      const repos = await this.request<GitHubRepo[]>("/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member");
      return repos.map((repo) => ({
        id: String(repo.id),
        name: repo.name,
        fullName: repo.full_name,
        private: repo.private,
        cloneUrl: repo.clone_url,
        sshUrl: repo.ssh_url,
        defaultBranch: repo.default_branch || "main",
      }));
    }

    if (this.account.provider === "gitee") {
      const repos = await this.request<GiteeRepo[]>("/user/repos?per_page=100&sort=updated");
      return repos.map((repo) => ({
        id: String(repo.id),
        name: repo.name,
        fullName: repo.full_name ?? repo.human_name ?? repo.name,
        private: Boolean(repo.private),
        cloneUrl: repo.html_url.endsWith(".git") ? repo.html_url : `${repo.html_url}.git`,
        sshUrl: repo.ssh_url,
        defaultBranch: repo.default_branch || "master",
      }));
    }

    const repos = await this.request<GitLabRepo[]>("/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at&sort=desc");
    return repos.map((repo) => ({
      id: String(repo.id),
      name: repo.name,
      fullName: repo.path_with_namespace,
      private: repo.visibility !== "public",
      cloneUrl: repo.http_url_to_repo,
      sshUrl: repo.ssh_url_to_repo,
      defaultBranch: repo.default_branch || "main",
    }));
  }

  async createRepository(name: string, isPrivate: boolean): Promise<ProviderRepo> {
    if (this.account.provider === "github") {
      const repo = await this.request<GitHubRepo>("/user/repos", {
        method: "POST",
        body: JSON.stringify({
          name,
          private: isPrivate,
          auto_init: false,
        }),
      });
      return {
        id: String(repo.id),
        name: repo.name,
        fullName: repo.full_name,
        private: repo.private,
        cloneUrl: repo.clone_url,
        sshUrl: repo.ssh_url,
        defaultBranch: repo.default_branch || "main",
      };
    }

    if (this.account.provider === "gitee") {
      const repo = await this.request<GiteeRepo>("/user/repos", {
        method: "POST",
        body: JSON.stringify({
          name,
          private: isPrivate,
        }),
      });
      return {
        id: String(repo.id),
        name: repo.name,
        fullName: repo.full_name ?? repo.human_name ?? repo.name,
        private: Boolean(repo.private),
        cloneUrl: repo.html_url.endsWith(".git") ? repo.html_url : `${repo.html_url}.git`,
        sshUrl: repo.ssh_url,
        defaultBranch: repo.default_branch || "master",
      };
    }

    const repo = await this.request<GitLabRepo>("/projects", {
      method: "POST",
      body: JSON.stringify({
        name,
        visibility: isPrivate ? "private" : "public",
        initialize_with_readme: false,
      }),
    });
    return {
      id: String(repo.id),
      name: repo.name,
      fullName: repo.path_with_namespace,
      private: repo.visibility !== "public",
      cloneUrl: repo.http_url_to_repo,
      sshUrl: repo.ssh_url_to_repo,
      defaultBranch: repo.default_branch || "main",
    };
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");

    if (this.account.provider === "github") {
      headers.set("Authorization", `Bearer ${this.account.token}`);
      headers.set("X-GitHub-Api-Version", "2022-11-28");
    } else if (this.account.provider === "gitee") {
      headers.set("Authorization", `token ${this.account.token}`);
    } else {
      headers.set("PRIVATE-TOKEN", this.account.token);
    }

    if (init.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const response = await fetch(`${trimTrailingSlash(this.account.apiBaseUrl)}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Provider API request failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return response.json() as Promise<T>;
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  clone_url: string;
  ssh_url: string;
  default_branch?: string;
}

interface GitLabRepo {
  id: number;
  name: string;
  path_with_namespace: string;
  visibility: string;
  http_url_to_repo: string;
  ssh_url_to_repo: string;
  default_branch?: string;
}

interface GiteeRepo {
  id: number;
  name: string;
  full_name?: string;
  human_name?: string;
  private?: boolean;
  html_url: string;
  ssh_url: string;
  default_branch?: string;
}
