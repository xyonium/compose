import FirecrawlApp from 'firecrawl';
import { Hono } from 'hono';
import { IncomingHttpHeaders } from 'http';
import { z } from 'zod';

declare function normalizeHeader(value: string | string[] | undefined): string | undefined;
declare function withoutTrailingSlash(value: string): string;

/** The header a connection sets to name the integration it comes from. */
declare const DECLARED_ORIGIN_HEADER = "x-firecrawl-origin";
type ClientImplementation = {
    name?: string;
    version?: string;
};
/** Whether a User-Agent is absent or names an HTTP runtime rather than an MCP client. */
declare function isRuntimeUserAgent(userAgent: string | null | undefined): boolean;
/**
 * The token an initialize client name stamps when it reaches a call only
 * through `ClientSignals.initializeClient`; empty for the server's own names
 * and the defaults SDKs send when the integration sets none.
 */
declare function initializeClientSlug(name: string | null | undefined): string;
/** The header form of an origin, for the requests that reach the API without a body. */
declare function originHeaders(origin: string): Record<string, string>;
/**
 * The client as fastmcp hands it to a tool call (`context.client`); its
 * `version` is the `clientInfo` the client sent at initialize.
 */
type McpClient = {
    version?: ClientImplementation | undefined;
} | undefined;
/** The client signals the authenticated session carries (see SessionData). */
type OriginSession = {
    clientUserAgent?: string;
    clientOrigin?: string;
    clientReferrer?: string;
    initializeClient?: ClientImplementation;
    oauthClientId?: string;
    oauthClientName?: string;
};
/**
 * The origin of every request a tool call makes: the call's client, the
 * client signals of the request the session was authenticated with
 * (stateless HTTP calls carry no client name), and this server's version.
 */
declare function requestOrigin(client: McpClient, session?: OriginSession | undefined): string;

/** An API-issued keyless signup link, or undefined for anything else. */
declare function keylessSignupUrlFrom(value: unknown): string | undefined;
declare function invalidApiKeyRecoveryPayload(): Record<string, unknown> & {
    message: string;
};
declare function invalidOAuthRecoveryPayload(): Record<string, unknown> & {
    message: string;
};
declare function recoveryPayload(code: string, requestId?: string, options?: {
    retryAfterSeconds?: number;
    signupUrl?: string;
}): Record<string, unknown>;
declare function keylessQuotaReason(reason: unknown): reason is 'requests' | 'credits';

declare function hasAlexandria(sources: unknown): boolean;
declare function defaultDomainTools(sources: unknown): boolean;
/** Adds alexandria to the requested sources, keeping the caller's entries and their string or object form. */
declare function withAlexandriaSource(sources: unknown): unknown[];
/** Zero data retention and anonymous searches cannot run provider discovery. */
declare function enterpriseAllowsAlexandria(enterprise: unknown): boolean;
declare function normalizeSearchSources(sources: unknown): unknown;
declare function searchQueryIsValid(args: {
    query?: string;
}): boolean;
declare const ALEXANDRIA_CATALOGUE_VERTICALS = "companies, people, jobs, finance and filings, public records and government spending, real estate, places and restaurants, retail and prices, package registries and developer data, news, research, and more";
declare const ALEXANDRIA_SEARCH_INSTRUCTIONS: string;

/**
 * Declared tool output: schemas plus the helpers that attach structured
 * content to a result.
 *
 * Every registered tool declares an `outputSchema` so a client — and the model
 * behind it — knows the shape of a result before it calls the tool. MCP asks a
 * tool that declares one to return `structuredContent` next to the text block,
 * so the helpers here attach the structured payload without touching the text
 * a tool already returned: existing clients keep reading the exact same string.
 *
 * Two fastmcp behaviours shape the schemas below.
 *
 * 1. fastmcp advertises an output schema through `strictJsonSchema`, which
 *    sets `additionalProperties: false` on every object it emits. A schema
 *    therefore has to name each top-level key the tool can return.
 * 2. fastmcp validates `structuredContent` against the schema and keeps the
 *    parsed value, so a key the schema does not name is dropped from the
 *    structured payload. The text block still carries the whole response.
 *
 * So these schemas name the documented keys and leave the value of anything
 * that passes through from the Firecrawl API unconstrained (`z.unknown()`,
 * which advertises as `{}` and accepts any shape). Only fields whose scalar
 * type is part of the API contract are typed, and those are optional and
 * nullable through the `str`/`num`/`bool` helpers below: a value the schema
 * rejects would fail validation and turn a working call into an error.
 */

declare const searchOutputSchema: z.ZodObject<{
    success: z.ZodOptional<z.ZodNullable<z.ZodBoolean>>;
    data: z.ZodOptional<z.ZodUnknown>;
    error: z.ZodOptional<z.ZodUnknown>;
    warning: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    id: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    creditsUsed: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    tools: z.ZodOptional<z.ZodUnknown>;
    nextTool: z.ZodOptional<z.ZodUnknown>;
    feedbackTool: z.ZodOptional<z.ZodUnknown>;
}, z.core.$strip>;

declare function removeEmptyTopLevel<T extends Record<string, any>>(obj: T): Partial<T>;
declare const searchToolBaseFields: {
    toolDetail: z.ZodOptional<z.ZodEnum<{
        summary: "summary";
        compact: "compact";
        full: "full";
    }>>;
    query: z.ZodString;
    domainTools: z.ZodOptional<z.ZodBoolean>;
    highlights: z.ZodOptional<z.ZodBoolean>;
    limit: z.ZodOptional<z.ZodNumber>;
    tbs: z.ZodOptional<z.ZodString>;
    filter: z.ZodOptional<z.ZodString>;
    location: z.ZodOptional<z.ZodString>;
    includeDomains: z.ZodOptional<z.ZodArray<z.ZodString>>;
    excludeDomains: z.ZodOptional<z.ZodArray<z.ZodString>>;
    sources: z.ZodOptional<z.ZodArray<z.ZodUnion<readonly [z.ZodEnum<{
        images: "images";
        alexandria: "alexandria";
        web: "web";
        news: "news";
        exchange: "exchange";
    }>, z.ZodObject<{
        type: z.ZodEnum<{
            images: "images";
            alexandria: "alexandria";
            web: "web";
            news: "news";
            exchange: "exchange";
        }>;
    }, z.core.$strict>]>>>;
    categories: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        pdf: "pdf";
        research: "research";
        developer: "developer";
        gov: "gov";
    }>>>;
    enterprise: z.ZodOptional<z.ZodArray<z.ZodEnum<{
        default: "default";
        anon: "anon";
        zdr: "zdr";
    }>>>;
};
declare function searchDomainsAreExclusive(args: {
    includeDomains?: string[];
    excludeDomains?: string[];
}): boolean;
declare const SEARCH_DOMAINS_CONFLICT_MESSAGE = "includeDomains and excludeDomains cannot both be specified";
declare function searchCategoriesAreCompatible(args: {
    categories?: string[];
}): boolean;
declare const SEARCH_CATEGORIES_CONFLICT_MESSAGE = "The developer and gov categories cannot be combined with other categories";
declare function assertExchangeCredential(credentialPresent: boolean): void;
type ExchangeErrorContext = {
    tool: string;
    requestId?: string;
    providers?: string[];
};
declare function relayTermsRequired<T>(run: () => Promise<T>, context: ExchangeErrorContext): Promise<T>;
declare function relayExchangeError(run: () => Promise<any>, context: ExchangeErrorContext): Promise<any>;
/** Retries without Alexandria, on fallbackSources, when tools the caller did not ask for are refused. */
declare function postSearchWithFallback(client: any, body: Record<string, unknown>, implicitTools: boolean, fallbackSources?: unknown[]): Promise<any>;

/**
 * Library entry point: `import { createFirecrawlMcpServer } from 'firecrawl-mcp/server'`.
 *
 * Unstable: this API, its options and the types below may change in any
 * release, including minor and patch releases. FastMCP is bundled (with local
 * patches), so embedders use the types exported here rather than importing
 * `fastmcp` themselves.
 * @packageDocumentation
 */
/**
 * An error whose message is shown to the agent as the tool result. `extras`
 * becomes the result's structured content.
 */
declare const UserError: new (message: string, extras?: Record<string, unknown>) => Error & {
    extras?: Record<string, unknown>;
};
/** What a tool's `execute` or `beforeValidate` may return. */
type ToolResult = {
    content: Array<{
        type: 'text';
        text: string;
    } | {
        type: 'image' | 'audio';
        data: string;
        mimeType: string;
    } | {
        type: 'resource';
        resource: {
            uri: string;
            mimeType?: string;
            text?: string;
            blob?: string;
        };
    } | {
        type: 'resource_link';
        uri: string;
        name: string;
        title?: string;
        description?: string;
        mimeType?: string;
        size?: number;
    }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
};
/**
 * Per-connection state produced by `authenticate` and handed to every tool
 * call. Embedders may add their own fields.
 */
interface SessionData {
    /**
     * FC API key (`fc-...`) or OAuth access token (`fco_...`) sent as
     * `Authorization: Bearer ...` to the Firecrawl API.
     */
    firecrawlApiKey?: string;
    /**
     * The User-Agent of the HTTP request that opened the session, one of the
     * client signals a stateless HTTP tool call carries (see src/origin.ts).
     */
    clientUserAgent?: string;
    /** The `X-Firecrawl-Origin` header: the integration the connection names. */
    clientOrigin?: string;
    /** The `Origin` or `Referer` header of that request. */
    clientReferrer?: string;
    /**
     * The client an earlier initialize named, for stateless HTTP calls that do
     * not carry it. Set by an embedder that can recover it; read only when the
     * User-Agent names a runtime rather than a client.
     */
    initializeClient?: {
        name?: string;
        version?: string;
    };
    /**
     * The OAuth client id the access token was issued to. A metadata URL id
     * names the product; read only when the User-Agent names a runtime.
     */
    oauthClientId?: string;
    /** The registered name of that client; read when the id is not a URL. */
    oauthClientName?: string;
    authType?: 'api-key' | 'oauth' | 'env' | 'keyless' | 'none';
    /** Admitted, but the supplied credential cannot be used. */
    credentialError?: 'CREDENTIAL_INVALID';
    /** Set per tool call. */
    requestId?: string;
    [key: string]: unknown;
}
/** Per-connection session state; alias of {@link SessionData}. */
type Session = SessionData;
/** Logs to the connected client. */
type ToolLogger = {
    debug(message: string, data?: unknown): void;
    error(message: string, data?: unknown): void;
    info(message: string, data?: unknown): void;
    warn(message: string, data?: unknown): void;
};
/** What a tool's `execute` receives besides its arguments. */
type ToolContext = {
    session?: Session;
    log: ToolLogger;
    /** The connected client; `version` is the clientInfo sent at initialize. */
    client?: {
        version?: {
            name?: string;
            version?: string;
        };
    };
    [key: string]: unknown;
};
type ToolIcon = {
    src: string;
    mimeType?: string;
    sizes?: string[];
    theme?: 'light' | 'dark';
};
/** A tool as registered on the server. */
interface ToolDefinition {
    name: string;
    description?: string;
    icons?: ToolIcon[];
    /** A Standard Schema (for example a zod object) for the arguments. */
    parameters?: unknown;
    /** JSON Schema of the structured result. */
    outputSchema?: unknown;
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
        [key: string]: unknown;
    };
    _meta?: Record<string, unknown>;
    /** Hide the tool from a session's tools/list. */
    canList?(session: Session): boolean;
    /** Answer the call before argument validation by returning a result. */
    beforeValidate?(args: unknown, session: Session): ToolResult | undefined | Promise<ToolResult | undefined>;
    execute(args: any, context: ToolContext): Promise<ToolResult | string | void>;
}
/** Registers a tool onto an instance. */
type ToolRegistrar = {
    addTool(tool: ToolDefinition): void;
};
type ResourceContent = ({
    text: string;
} | {
    blob: string;
}) & {
    uri?: string;
    mimeType?: string;
    _meta?: Record<string, unknown>;
};
interface ResourceDefinition {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
    load(session?: Session): Promise<ResourceContent | ResourceContent[]>;
}
type ResourceRegistrar = {
    addResource(resource: ResourceDefinition): void;
};
/** The HTTP request `authenticate` receives; absent for stdio. */
type AuthenticationRequest = {
    headers: IncomingHttpHeaders;
    url?: string;
};
/** The HTTP application routes can be added to (Hono). */
type HttpApp = Hono;
/** Reported around each tool call; `started` precedes the outcome. */
type ToolCallEvent = {
    tool: string;
    session: SessionData;
    requestId: string;
} & ({
    status: 'started';
} | {
    status: 'success';
    result: unknown;
} | {
    status: 'error';
    error: unknown;
});
/** Per-request credential and extra headers for calls to the Firecrawl API. */
type OutboundRequest = {
    /** Replaces the session's API key as the bearer credential. */
    credential?: string;
    headers?: Record<string, string>;
};
/** OAuth 2.0 protected-resource metadata (RFC 9728) served by the instance. */
type ProtectedResourceMetadata = {
    authorizationServers: string[];
    bearerMethodsSupported?: string[];
    resource: string;
    resourceName?: string;
    scopesSupported?: string[];
};
type ExtraToolsContext = {
    /** Firecrawl client for a session, honouring `outboundRequest`. */
    getClient(session?: SessionData): FirecrawlApp;
    /** Whether a session will send a credential to the Firecrawl API. */
    hasCredential(session?: SessionData): boolean;
    /** A built-in tool definition, including one `toolFilter` excluded. */
    builtInTool(name: string): ToolDefinition | undefined;
};
type InstructionDefaults = {
    /** Instructions for sessions with a credential. */
    authenticated: string;
    /** Instructions for the keyless tool surface. */
    keyless: string;
};
/**
 * Extension points for embedding the server. Unstable: names and signatures
 * may change in any release.
 */
interface FirecrawlMcpServerHooks {
    /** Replaces credential resolution. Throw a `Response` to reject the request. */
    authenticate?: (request: AuthenticationRequest | undefined) => Promise<SessionData>;
    /** Decorates every registered tool, including tools from `registerExtraTools`. */
    wrapTool?: (tool: ToolDefinition) => ToolDefinition;
    /** Observes each tool call. Must not throw. */
    onToolResult?: (event: ToolCallEvent) => void;
    /** Server instructions, or a function choosing them from the defaults. */
    instructions?: string | ((defaults: InstructionDefaults) => string);
    /** Adds tools after the built-in ones. They bypass `toolFilter`. */
    registerExtraTools?: (registrar: ToolRegistrar, context: ExtraToolsContext) => void;
    registerResources?: (registrar: ResourceRegistrar) => void;
    /** Credential and headers for each Firecrawl API request of a session. */
    outboundRequest?: (session: SessionData | undefined) => OutboundRequest | undefined;
    /** Runs before a keyless request; throw to refuse it. */
    beforeKeylessRequest?: (session: SessionData | undefined, origin: string) => Promise<void>;
    /** Built-in tools whose name fails the filter are not registered. */
    toolFilter?: (name: string) => boolean;
    /** Adds HTTP routes. Runs before the built-in routes, so its routes win. */
    configureHttp?: (app: HttpApp) => void;
    /** Serve OAuth protected-resource metadata for this instance. */
    oauth?: {
        protectedResource: ProtectedResourceMetadata;
    };
}
interface FirecrawlMcpServerOptions {
    /** Firecrawl API base URL. Unset targets the Firecrawl cloud. */
    apiUrl?: string;
    /** Credential used when a request does not carry one. */
    apiKey?: string;
    /** Transport the instance is started with. Defaults to `stdio`. */
    transport?: 'stdio' | 'httpStream';
    /** Write server logs to the console. Defaults to true for HTTP. */
    logging?: boolean;
    /** Restrict browser actions and webhooks, and mark scrape read-only. */
    safeMode?: boolean;
    /** `local` (default) reads files from this machine; `upload` uses a two-phase upload flow. */
    fileAccess?: 'local' | 'upload';
    /** Refuse Firecrawl API calls from sessions without a credential. */
    requireCredential?: boolean;
    /** Register firecrawl_search_feedback. Defaults to true. */
    searchFeedback?: boolean;
    /** Register firecrawl_feedback. Defaults to true. */
    endpointFeedback?: boolean;
    /** Tag sent as the `integration` field of API requests that accept one, such as `_zed`. */
    integration?: string;
    /** Extension hooks. Unstable: may change in any release. */
    unstable_hooks?: FirecrawlMcpServerHooks;
}
type FirecrawlMcpServerStartArgs = {
    transportType: 'stdio';
} | {
    transportType: 'httpStream';
    httpStream: {
        port: number;
        /**
         * Address to listen on. Defaults to `FASTMCP_HOST`, then `localhost`,
         * which Node binds to a single address (often `::1` only), so pass
         * `127.0.0.1`, `::` or `0.0.0.0` to choose explicitly.
         */
        host?: string;
        /** Defaults to FastMCP's endpoint (`FASTMCP_ENDPOINT` or `/mcp`). */
        endpoint?: `/${string}`;
        stateless?: boolean;
    };
};
interface FirecrawlMcpServer {
    start(args: FirecrawlMcpServerStartArgs): Promise<void>;
    stop(): Promise<void>;
}

/**
 * Tools a keyless session can call. A copy, so changing it cannot change
 * which tools the server itself treats as keyless.
 */
declare const keylessToolNames: ReadonlySet<string>;

/** Compact JSON text of `data`, with `data` as structured content when it is an object. */
declare const structuredCompactResult: (data: unknown) => ToolResult;

declare function createFirecrawlMcpServer(options?: FirecrawlMcpServerOptions): FirecrawlMcpServer;

export { ALEXANDRIA_CATALOGUE_VERTICALS, ALEXANDRIA_SEARCH_INSTRUCTIONS, type AuthenticationRequest, DECLARED_ORIGIN_HEADER, type ExtraToolsContext, type FirecrawlMcpServer, type FirecrawlMcpServerHooks, type FirecrawlMcpServerOptions, type FirecrawlMcpServerStartArgs, type HttpApp, type InstructionDefaults, keylessToolNames as KEYLESS_TOOL_NAMES, type OutboundRequest, type ProtectedResourceMetadata, type ResourceContent, type ResourceDefinition, type ResourceRegistrar, SEARCH_CATEGORIES_CONFLICT_MESSAGE, SEARCH_DOMAINS_CONFLICT_MESSAGE, type Session, type SessionData, type ToolCallEvent, type ToolContext, type ToolDefinition, type ToolIcon, type ToolLogger, type ToolRegistrar, type ToolResult, UserError, assertExchangeCredential, createFirecrawlMcpServer, defaultDomainTools, enterpriseAllowsAlexandria, hasAlexandria, initializeClientSlug, invalidApiKeyRecoveryPayload, invalidOAuthRecoveryPayload, isRuntimeUserAgent, keylessQuotaReason, keylessSignupUrlFrom, normalizeHeader, normalizeSearchSources, originHeaders, postSearchWithFallback, recoveryPayload, relayExchangeError, relayTermsRequired, removeEmptyTopLevel, requestOrigin, searchCategoriesAreCompatible, searchDomainsAreExclusive, searchOutputSchema, searchQueryIsValid, searchToolBaseFields, structuredCompactResult as structuredCompact, withAlexandriaSource, withoutTrailingSlash };
