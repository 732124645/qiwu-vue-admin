import { ApiResponse, type ApiResponseSchemaHost } from '@nestjs/swagger'
import { z } from 'zod'

type Json = Record<string, unknown>

/**
 * zod writes recursive schemas (trees) as `$ref: '#/definitions/…'` + `definitions`, which cannot
 * resolve inside a response schema: inline every definition once; a reference inside an inlined copy
 * (the recursion) becomes an object described as the same shape.
 */
function inlineDefinitions(schema: Json): Json {
  const { definitions, ...root } = schema as Json & { definitions?: Record<string, Json> }
  if (!definitions) return schema
  const walk = (node: unknown, inlined: boolean): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, inlined))
    if (!node || typeof node !== 'object') return node
    const ref = (node as Json).$ref
    if (typeof ref === 'string' && ref.startsWith('#/definitions/'))
      return inlined
        ? { type: 'object', description: 'same shape as the enclosing object (recursive)' }
        : walk(definitions[ref.slice('#/definitions/'.length)], true)
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v, inlined)]))
  }
  return walk(root, false) as Json
}

/**
 * Documents a success response as the envelope around `data` (Swagger describes only
 * `data`; this adds `code`/`msg`; see docs/design-notes.md#api-envelope). `data` omitted → `null` (e.g. logout). Pass 201 for POST creators.
 */
export const ApiEnvelope = (data?: z.ZodType, status = 200) =>
  ApiResponse({
    status,
    schema: {
      type: 'object',
      required: ['code', 'msg', 'data'],
      properties: {
        code: { type: 'integer', example: 0 },
        msg: { type: 'string', example: 'ok' },
        data: data
          ? (inlineDefinitions(
              z.toJSONSchema(data, {
                target: 'openapi-3.0',
                io: 'output',
                unrepresentable: 'any',
              }) as Json,
            ) as ApiResponseSchemaHost['schema'])
          : { nullable: true, example: null },
      },
    },
  })
