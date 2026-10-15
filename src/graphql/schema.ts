/**
 * GitHub's published GraphQL schema, executed against Gitea. Every query gh can
 * send validates; a field answers through the model object of its parent type
 * (`src/graphql/models.ts`), and a field no model implements answers null, or
 * an error naming it where the schema forbids null.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  buildASTSchema, GraphQLError, isNonNullType, parse, visit,
  type GraphQLFieldResolver, type GraphQLSchema, type GraphQLTypeResolver,
} from "graphql";

const require = createRequire(import.meta.url);

/** The schema's own definitions with what graphql-js refuses to execute removed. */
function cleaned(source: string) {
  const unique = (node: any) => {
    const seen = new Set<string>();
    return {
      ...node,
      fields: node.fields?.filter((entry: any) =>
        !seen.has(entry.name.value) && seen.add(entry.name.value)),
    };
  };
  return visit(parse(source), {
    ObjectTypeDefinition: unique,
    InterfaceTypeDefinition: unique,
    InputObjectTypeDefinition: unique,
    FieldDefinition: (node) => ({
      ...node,
      directives: node.directives?.filter((directive) => directive.name.value !== "deprecated"),
    }),
  });
}

let built: GraphQLSchema | undefined;

export function schema(): GraphQLSchema {
  built ??= buildASTSchema(cleaned(readFileSync(
    require.resolve("@octokit/graphql-schema/schema.graphql"), "utf8")), { assumeValidSDL: true });
  return built;
}

/**
 * A model's property of the field's name: called with the arguments when it is
 * a method, read when it is a value.
 */
export const fieldResolver: GraphQLFieldResolver<any, any> = (source, args, context, info) => {
  const value = source?.[info.fieldName];
  const resolved = typeof value === "function" ? value.call(source, args, context, info) : value;
  if (resolved !== undefined || !isNonNullType(info.returnType)) return resolved ?? null;
  throw new GraphQLError(
    `gh-gitea-proxy does not implement ${info.parentType.name}.${info.fieldName}`);
};

/** Models name their own type. */
export const typeResolver: GraphQLTypeResolver<any, any> = (value) => value?.__typename;
