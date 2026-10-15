import { execute, GraphQLError, parse, validate } from "graphql";
import type { Context } from "./context.ts";
import { Mutation } from "./models/mutation.ts";
import { Query } from "./models/root.ts";
import { fieldResolver, schema, typeResolver } from "./schema.ts";

export interface GraphQLRequest {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/** The root fields of both operation types, which never share a name. */
function root(context: Context): object {
  const query = new Query(context);
  const mutation = new Mutation(context);
  return new Proxy({}, {
    get: (_, name) => {
      const owner: any = name in query ? query : mutation;
      const value = owner[name];
      return typeof value === "function" ? value.bind(owner) : value;
    },
  });
}

/** A GitHub GraphQL response to `request`, errors included as GitHub returns them. */
export async function answer(context: Context, request: GraphQLRequest) {
  let document;
  try {
    document = parse(request.query);
  } catch (error) {
    return { errors: [{ message: (error as GraphQLError).message }] };
  }
  const invalid = validate(schema(), document);
  if (invalid.length) return { errors: invalid.map((error) => ({ message: error.message })) };
  const result = await execute({
    schema: schema(), document, rootValue: root(context), contextValue: context,
    variableValues: request.variables, operationName: request.operationName,
    fieldResolver, typeResolver,
  });
  return {
    data: result.data,
    ...(result.errors?.length ? {
      errors: result.errors.map((error) => ({
        message: error.message, path: error.path, type: typeOf(error),
      })),
    } : {}),
  };
}

/** GitHub's error `type`, which gh reads to tell a missing object from a failure. */
function typeOf(error: GraphQLError): string | undefined {
  const status = (error.originalError as { status?: number } | undefined)?.status;
  if (status === 404) return "NOT_FOUND";
  if (status === 403 || status === 401) return "FORBIDDEN";
  return undefined;
}
