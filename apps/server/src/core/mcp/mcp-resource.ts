import type { Request } from 'express'

/** The path of the MCP endpoint (behind the global `/api` prefix). */
export const MCP_PATH = '/api/mcp'

/** The site's origin as the caller reached it (`req.protocol` and `req.host` honour `trust proxy`). */
export const siteOrigin = (req: Request): string => `${req.protocol}://${req.host}`

/**
 * The MCP resource identifier (RFC 8707 / RFC 9728): this site's MCP endpoint URL, the audience an OAuth2
 * token for it names. Derived from the request, so a tenant's own domain is its own resource.
 */
export const mcpResource = (req: Request): string => `${siteOrigin(req)}${MCP_PATH}`

/** Where the protected resource metadata of `mcpResource` lives (RFC 9728 §3.1: path inserted). */
export const resourceMetadataUrl = (req: Request): string =>
  `${siteOrigin(req)}/.well-known/oauth-protected-resource${MCP_PATH}`
