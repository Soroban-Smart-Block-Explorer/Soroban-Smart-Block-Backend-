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
  let total = 0;
  for (const def of doc.definitions) {
    if (def.kind === 'OperationDefinition') {
      total += visitNode(def.selectionSet, 1);
    }
  }
  return total;
}

function visitNode(selectionSet: any, depth: number): number {
  if (!selectionSet?.selections) return 0;
  let cost = 0;
  for (const sel of selectionSet.selections) {
    if (sel.kind === 'Field') {
      cost += depth;
      if (sel.selectionSet) {
        cost += visitNode(sel.selectionSet, depth + 1);
      }
    }
    if (sel.kind === 'InlineFragment' || sel.kind === 'FragmentSpread') {
      if (sel.selectionSet) {
        cost += visitNode(sel.selectionSet, depth);
      }
    }
  }
  return cost;
}
