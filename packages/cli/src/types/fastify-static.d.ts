/**
 * Restores `@fastify/static`'s `FastifyReply.sendFile` augmentation.
 *
 * `@fastify/static` lists `fastify` only as a devDependency, so under pnpm's
 * strict node_modules isolation its own package folder has no access to
 * `fastify` — the `import ... from 'fastify'` at the top of its
 * `types/index.d.ts` fails to resolve. That silently drops its
 * `declare module 'fastify'` augmentation once this repo's
 * `skipLibCheck: true` suppresses the resulting diagnostic, leaving
 * `FastifyReply` without `sendFile`.
 *
 * Redeclaring it here works because this file resolves `fastify` from
 * `packages/cli`'s own direct dependency instead.
 *
 * The `export {}` is required so this file is treated as a module: without
 * it, `declare module 'fastify'` below would replace the whole ambient
 * module instead of merging into the real one.
 */
export {};

declare module 'fastify' {
  interface FastifyReply {
    sendFile(filename: string, rootPath?: string): FastifyReply;
  }
}
