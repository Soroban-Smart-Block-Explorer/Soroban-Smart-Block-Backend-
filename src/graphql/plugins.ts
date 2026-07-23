import { Plugin } from 'graphql-yoga';
import depthLimit from 'graphql-depth-limit';
import { GraphQLError } from 'graphql';

const MAX_COMPLEXITY = parseInt(process.env.GQL_MAX_COMPLEXITY ?? '1000');
const MAX_DEPTH = parseInt(process.env.GQL_MAX_DEPTH ?? '5');

export const complexityPlugin: Plugin = {
  onExecute({ args }) {
    const complexity = calculateComplexity(args.document);
    if (complexity > MAX_COMPLEXITY) {
      throw new GraphQLError(`Query too complex: ${complexity} exceeds limit of ${MAX_COMPLEXITY}`);
    }
  },
};

export const depthLimitPlugin: Plugin = {
  onExecute({ args }) {
    const rule = depthLimit(MAX_DEPTH) as any;
    const errors = rule(null, args.document);
    if (errors && errors.length > 0) {
      throw new GraphQLError(`Query exceeds maximum depth of ${MAX_DEPTH}`);
    }
  },
};

function calculateComplexity(doc: any): number {
  if (!doc?.definitions) return 0;
  const fragments: Record<string, any> = {};
  for (const def of doc.definitions) {
    if (def.kind === 'FragmentDefinition') {
      fragments[def.name.value] = def;
    }
  }
  let total = 0;
  for (const def of doc.definitions) {
    if (def.kind === 'OperationDefinition') {
      total += visitNode(def.selectionSet, 1, fragments, new Set());
    }
  }
  return total;
}

function getListMultiplier(sel: any): number {
  if (!sel.arguments?.length) return 1;
  const limitArg = sel.arguments.find(
    (a: any) => a.name.value === 'limit' || a.name.value === 'first',
  );
  if (!limitArg) return 1;
  if (limitArg.value.kind === 'IntValue') return Math.max(1, parseInt(limitArg.value.value, 10));
  return 1;
}

function visitNode(
  selectionSet: any,
  depth: number,
  fragments: Record<string, any>,
  inPath: Set<string>,
): number {
  if (!selectionSet?.selections) return 0;
  let cost = 0;
  for (const sel of selectionSet.selections) {
    if (sel.kind === 'Field') {
      const multiplier = getListMultiplier(sel);
      cost += depth * multiplier;
      if (sel.selectionSet) {
        cost += visitNode(sel.selectionSet, depth + 1, fragments, inPath);
      }
    } else if (sel.kind === 'InlineFragment') {
      if (sel.selectionSet) {
        cost += visitNode(sel.selectionSet, depth, fragments, inPath);
      }
    } else if (sel.kind === 'FragmentSpread') {
      const fragName = sel.name.value;
      if (!inPath.has(fragName)) {
        const fragment = fragments[fragName];
        if (fragment?.selectionSet) {
          inPath.add(fragName);
          cost += visitNode(fragment.selectionSet, depth, fragments, inPath);
          inPath.delete(fragName);
        }
      }
    }
  }
  return cost;
}
