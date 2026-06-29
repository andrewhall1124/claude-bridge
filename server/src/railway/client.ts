// Minimal Railway public GraphQL client for the Deploy page.
// Endpoint + auth + queries per https://docs.railway.com/integrations/api.

const ENDPOINT = "https://backboard.railway.com/graphql/v2";

export interface RailwayProject {
  id: string;
  name: string;
}

export interface RailwayEnvironment {
  id: string;
  name: string;
}

export interface RailwayDeployment {
  id: string;
  status: string;
  createdAt: string | null;
  url: string | null;
  staticUrl: string | null;
  commitMessage: string | null;
  commitHash: string | null;
  commitAuthor: string | null;
}

export interface RailwayService {
  id: string;
  name: string;
  latest: RailwayDeployment | null;
}

export interface RailwayStatus {
  projectId: string;
  projectName: string;
  environment: RailwayEnvironment;
  environments: RailwayEnvironment[];
  services: RailwayService[];
}

export class RailwayError extends Error {}

async function gql<T>(
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new RailwayError(
      `Could not reach Railway API: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const body = (await res.json().catch(() => null)) as
    | { data?: T; errors?: { message: string }[] }
    | null;
  if (!res.ok) {
    const msg = body?.errors?.map((e) => e.message).join("; ");
    throw new RailwayError(msg || `Railway API returned HTTP ${res.status}`);
  }
  if (body?.errors?.length) {
    throw new RailwayError(body.errors.map((e) => e.message).join("; "));
  }
  if (!body?.data) throw new RailwayError("Railway API returned no data");
  return body.data;
}

type Edges<T> = { edges: { node: T }[] };
const nodes = <T>(e: Edges<T> | null | undefined): T[] =>
  (e?.edges ?? []).map((x) => x.node);

export async function listProjects(token: string): Promise<RailwayProject[]> {
  const data = await gql<{ projects: Edges<RailwayProject> }>(
    token,
    `query { projects { edges { node { id name } } } }`,
  );
  return nodes(data.projects);
}

// Railway deployment meta is a free-form JSON blob; git deploys carry commit
// info under a few possible keys. Read defensively.
function commitFromMeta(meta: unknown): {
  message: string | null;
  hash: string | null;
  author: string | null;
} {
  const m = (meta ?? {}) as Record<string, unknown>;
  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : null;
  return {
    message: str(m.commitMessage) ?? str(m.commitMsg),
    hash: str(m.commitHash) ?? str(m.commitSha),
    author: str(m.commitAuthor) ?? str(m.committer),
  };
}

async function latestDeployment(
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
): Promise<RailwayDeployment | null> {
  const data = await gql<{
    deployments: Edges<{
      id: string;
      status: string;
      createdAt: string | null;
      url: string | null;
      staticUrl: string | null;
      meta: unknown;
    }>;
  }>(
    token,
    `query deps($input: DeploymentListInput!) {
       deployments(input: $input, first: 1) {
         edges { node { id status createdAt url staticUrl meta } }
       }
     }`,
    { input: { projectId, environmentId, serviceId } },
  );
  const node = nodes(data.deployments)[0];
  if (!node) return null;
  const commit = commitFromMeta(node.meta);
  return {
    id: node.id,
    status: node.status,
    createdAt: node.createdAt,
    url: node.url,
    staticUrl: node.staticUrl,
    commitMessage: commit.message,
    commitHash: commit.hash,
    commitAuthor: commit.author,
  };
}

// Per-service latest deployment for a project in one environment.
export async function getProjectStatus(
  token: string,
  projectId: string,
  envSelector?: string | null,
): Promise<RailwayStatus> {
  const data = await gql<{
    project: {
      id: string;
      name: string;
      services: Edges<{ id: string; name: string }>;
      environments: Edges<RailwayEnvironment>;
    } | null;
  }>(
    token,
    `query project($id: String!) {
       project(id: $id) {
         id name
         services { edges { node { id name } } }
         environments { edges { node { id name } } }
       }
     }`,
    { id: projectId },
  );
  if (!data.project) throw new RailwayError(`Project not found: ${projectId}`);

  const environments = nodes(data.project.environments);
  if (environments.length === 0) {
    throw new RailwayError("Project has no environments");
  }
  // Resolve env by id, then by name, then "production", then first.
  const wanted = envSelector?.trim().toLowerCase();
  const env =
    (wanted &&
      environments.find(
        (e) => e.id === envSelector || e.name.toLowerCase() === wanted,
      )) ||
    environments.find((e) => e.name.toLowerCase() === "production") ||
    environments[0]!;

  const svcList = nodes(data.project.services);
  const services: RailwayService[] = await Promise.all(
    svcList.map(async (s) => ({
      id: s.id,
      name: s.name,
      latest: await latestDeployment(token, projectId, env.id, s.id).catch(
        () => null,
      ),
    })),
  );
  services.sort((a, b) => a.name.localeCompare(b.name));

  return {
    projectId: data.project.id,
    projectName: data.project.name,
    environment: env,
    environments,
    services,
  };
}

// ---- Service environment variables ---------------------------------------

// Variables for a service in an environment. `unrendered` keeps ${{...}}
// references intact so editing doesn't bake a resolved value into the var.
export async function listVariables(
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
): Promise<Record<string, string>> {
  const data = await gql<{ variables: Record<string, string> }>(
    token,
    `query vars($projectId: String!, $environmentId: String!, $serviceId: String) {
       variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId, unrendered: true)
     }`,
    { projectId, environmentId, serviceId },
  );
  return data.variables ?? {};
}

export async function upsertVariable(
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
  name: string,
  value: string,
): Promise<void> {
  await gql(
    token,
    `mutation upsert($input: VariableUpsertInput!) { variableUpsert(input: $input) }`,
    { input: { projectId, environmentId, serviceId, name, value } },
  );
}

export async function deleteVariable(
  token: string,
  projectId: string,
  environmentId: string,
  serviceId: string,
  name: string,
): Promise<void> {
  await gql(
    token,
    `mutation del($input: VariableDeleteInput!) { variableDelete(input: $input) }`,
    { input: { projectId, environmentId, serviceId, name } },
  );
}
