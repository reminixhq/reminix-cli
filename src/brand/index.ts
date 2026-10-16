import manifest from "./brand.json" with { type: "json" };

/**
 * The product's identity, read from brand/brand.json — the ONE place a
 * product is named. Every app and package reads it from here (page
 * titles, the Better Auth appName / TOTP issuer, key prefixes, email
 * sender and footer, OpenAPI title, Astro site origins); nothing else in
 * the repository may spell the product's name or domain, so a fork's
 * copies of platform files stay identical to the platform's and
 * `pnpm product:init` edits brand.json instead of rewriting code
 * (docs/conventions.md "Identity"; scripts/checks/identity.test.ts).
 *
 * `name` is the machine slug (worker names, `sk_<name>_` key prefixes,
 * the `<name>_dev` database, HCP workspaces); `productName` is what
 * people see; `domain` is the apex the product deploys to.
 */
/** The manifest's optional `features` block: platform capabilities a product turns OFF. */
export type ManifestFeatures = {
  teams?: boolean;
  guests?: boolean;
  publicApi?: boolean;
  apiKeys?: boolean;
  personalTokens?: boolean;
  webhooks?: boolean;
  billing?: boolean;
  mcp?: boolean;
};

/**
 * One of the manifest's optional `environments`: a world a request acts
 * in (e.g. `test` and `live`), each with its own API-key prefix — a key
 * is created in one and acts only there.
 */
export type ManifestEnvironment = {
  name: string;
  keyPrefix: string;
  /** Keys acting in it may read workspace-wide things but not change them. */
  readOnlyWorkspace?: boolean;
  /** One sentence for people choosing it in the app: what it is for. */
  description?: string;
};

/**
 * The manifest's optional `signIn` block: how the sign-in and sign-up
 * pages present their ways in (docs/architecture.md "Authentication and tenancy").
 */
export type ManifestSignIn = {
  /** Social provider ids in display order; enabled providers not listed follow in catalog order. */
  providerOrder?: string[];
  /**
   * How sign-up offers email and password when social providers are
   * enabled: `form` (the full form, the default) or `button` (a
   * "Continue with email" button after the providers that opens it).
   */
  emailSignUp?: "form" | "button";
};

// Optional manifest fields (absent in the platform; a product may set them).
const optional = manifest as typeof manifest & {
  summary?: string;
  legalName?: string;
  securityContact?: string;
  supportContact?: string;
  features?: ManifestFeatures;
  signIn?: ManifestSignIn;
  environments?: ManifestEnvironment[];
  defaultEnvironment?: string;
  /** Path on the product's domain of the docs page explaining the environments. */
  environmentsDocs?: string;
};

export const brand = {
  name: manifest.name,
  /** `name` for identifier contexts (key prefixes, database names): dashes become underscores. */
  identifier: manifest.name.replaceAll("-", "_"),
  /**
   * The Python SDK's import name (`from limitry import Limitry`): the
   * identifier, unless it would shadow a standard-library module (the
   * platform's own, "platform"), then `<identifier>_sdk`.
   */
  pythonModule: ["platform", "types", "typing", "string", "json"].includes(
    manifest.name.replaceAll("-", "_"),
  )
    ? `${manifest.name.replaceAll("-", "_")}_sdk`
    : manifest.name.replaceAll("-", "_"),
  productName: manifest.productName,
  /**
   * The company that owns the product: the copyright holder in the
   * published SDK and CLI packages' NOTICE, and used nowhere else — never
   * in a page footer (owner, 2026-10-16). Defaults to productName.
   */
  legalName: optional.legalName ?? manifest.productName,
  domain: manifest.domain,
  /** One sentence: what the product is — llms.txt and the agent skill lead with it. */
  summary: optional.summary ?? `${manifest.productName} documentation and API.`,
  /** Where vulnerability reports go — /.well-known/security.txt and /security publish it. Defaults to security@<domain>. */
  securityContact: optional.securityContact ?? `security@${manifest.domain}`,
  /** The support address the /contact page shows. Defaults to support@<domain>. */
  supportContact: optional.supportContact ?? `support@${manifest.domain}`,
  colors: manifest.colors,
  /** True once the product has its own brand (brand.json `status: "ready"`), not the platform's placeholders. */
  ready: (manifest as { status?: string }).status === "ready",
} as const;

/**
 * Resolves the manifest's `features` into the flags the surfaces read:
 * every key defaults to on, and the developer surface derives top-down —
 * `publicApi` off forces `apiKeys`, `personalTokens` and `mcp` off, since
 * none has anything left to reach. Pure, so the
 * derivation is testable without a manifest (docs/architecture.md
 * "Product features").
 */
export function resolveProductFeatures(features: ManifestFeatures | undefined) {
  const on = (key: keyof ManifestFeatures) => features?.[key] ?? true;
  const publicApi = on("publicApi");
  const teams = on("teams");
  return {
    /**
     * Workspace teams: the plugin's team endpoints, the Teams section of
     * Members settings, the invitation's team picker, the admin Teams
     * tab. Off hides the surface; every workspace still has its default
     * team (docs/architecture.md "Teams").
     */
    teams,
    /** The guest role — a member outside the default team who sees only their own teams. Needs teams: off with them. */
    guests: teams && on("guests"),
    /** The public `/v1` API: its router, the OpenAPI spec and reference, SDK and CLI publishing. */
    publicApi,
    /** Workspace API keys: Settings → API Keys, `/internal/workspace/api-keys`, `sk_` authentication on `/v1`. */
    apiKeys: publicApi && on("apiKeys"),
    /** Personal access tokens: Account → API tokens, `/internal/account/pats`, `/v1/user/*`, `pat_` authentication, the CLI's sign-in. */
    personalTokens: publicApi && on("personalTokens"),
    /** Outgoing webhooks: Settings → Webhooks, `/internal/workspace/webhooks`, the admin tab, queued deliveries. */
    webhooks: on("webhooks"),
    /** Billing: Settings → Billing, the Stripe plugin, the admin Billing surfaces, the site's pricing page; a free product. */
    billing: on("billing"),
    /** The MCP server (`apps/mcp` at `mcp.<domain>`): deployed, and its tokens accepted on `/v1`. Needs the public API. */
    mcp: publicApi && on("mcp"),
  } as const;
}

/**
 * Platform capabilities a product may turn OFF in brand.json (`features`).
 * Read by the surfaces that expose a capability — never by the data
 * model, which stays on everywhere so a later flip needs no backfill.
 */
export const productFeatures = resolveProductFeatures(optional.features);

/**
 * The sign-in and sign-up pages' presentation (brand.json `signIn`),
 * with the platform's defaults: catalog order, the full email form.
 */
export const signInOptions = {
  providerOrder: optional.signIn?.providerOrder ?? [],
  emailSignUp: optional.signIn?.emailSignUp ?? "form",
} as const;

export type ProductEnvironments = {
  /** The declared environments; empty when the product declares none. */
  list: readonly Required<ManifestEnvironment>[];
  /** Where a request that names none acts; null when none are declared. */
  default: string | null;
  /** The docs page explaining them (a path on the product's domain), or null. */
  docs: string | null;
};

/**
 * Resolves the manifest's `environments` + `defaultEnvironment`
 * (docs/architecture.md "Environments"): the default is the one named,
 * else the first; nothing declared means no environments (`default:
 * null`) — keys are `sk_<identifier>_` and requests act in none. Throws
 * on a declaration the API could not serve unambiguously. Pure, so it is
 * testable without a manifest.
 */
export function resolveProductEnvironments(
  environments: ManifestEnvironment[] | undefined,
  defaultEnvironment?: string,
  docs?: string,
): ProductEnvironments {
  const list = (environments ?? []).map((env) => ({
    name: env.name,
    keyPrefix: env.keyPrefix,
    readOnlyWorkspace: env.readOnlyWorkspace ?? false,
    description: env.description ?? "",
  }));
  const names = new Set(list.map((env) => env.name));
  const prefixes = new Set(list.map((env) => env.keyPrefix));
  if (names.size !== list.length || prefixes.size !== list.length) {
    throw new Error(
      "brand.json environments: each needs its own name and keyPrefix",
    );
  }
  for (const env of list) {
    if (!/^[a-z][a-z0-9-]*$/.test(env.name)) {
      throw new Error(`brand.json environment name "${env.name}" is invalid`);
    }
    // /v1 tells a key from a personal access token (`pat_…`) by prefix,
    // before verifying either.
    if (
      !/^[a-z][a-z0-9_]*_$/.test(env.keyPrefix) ||
      env.keyPrefix.startsWith("pat_")
    ) {
      throw new Error(
        `brand.json environment "${env.name}": keyPrefix must be lowercase, end in "_" and not start with "pat_"`,
      );
    }
  }
  if (defaultEnvironment !== undefined && !names.has(defaultEnvironment)) {
    throw new Error(
      `brand.json defaultEnvironment "${defaultEnvironment}" is not a declared environment`,
    );
  }
  if (docs !== undefined && !docs.startsWith("/")) {
    throw new Error(
      `brand.json environmentsDocs "${docs}" must be a path starting with "/"`,
    );
  }
  return {
    list,
    default: defaultEnvironment ?? list[0]?.name ?? null,
    docs: list.length > 0 ? (docs ?? null) : null,
  };
}

/** The product's environments (brand.json `environments`), read by the API and the key plugin. */
export const productEnvironments = resolveProductEnvironments(
  optional.environments,
  optional.defaultEnvironment,
  optional.environmentsDocs,
);

/** The product name, optionally with a surface suffix: appName("Admin") → "<productName> Admin". */
export function appName(scope?: string): string {
  return scope ? `${brand.productName} ${scope}` : brand.productName;
}

/**
 * Document titles: `pageTitle("Sign in")` → "Sign in · <productName>",
 * `pageTitle("Users", "Admin")` → "Users · <productName> Admin",
 * `pageTitle()` → the bare app name.
 */
export function pageTitle(page?: string, scope?: string): string {
  const name = appName(scope);
  return page ? `${page} · ${name}` : name;
}
